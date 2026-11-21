// C2 model-free validation of the fixture entry mechanics on the real host:
// the visibility-probe driver (context-hook capture + stop before model),
// the mode-off negative check, the /fusion-mode command toggle, and the
// mode-on positive check. No scenario prompt is ever paid for.
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..", "..");
const root = await mkdtemp(join(tmpdir(), "fusion-prereq-check-"));
let child;
try {
  const project = join(root, "project");
  await mkdir(join(project, ".opencode/plugins"), { recursive: true });
  await cp(join(repo, "src"), join(project, ".opencode/fusion"), { recursive: true });
  await cp(join(repo, "examples/opencode/agents"), join(project, ".opencode/agents"), { recursive: true });
  await writeFile(join(project, ".opencode/plugins/fusion.ts"), 'export { default } from "../fusion/opencode/index.ts";\n');
  await writeFile(join(project, ".opencode/plugins/observer.ts"), `
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
export default { id: "prereq-observer", async setup(ctx) {
  const capturePath = join(ctx.location.directory, "capture.json");
  const probeSessions = new Set<string>();
  await ctx.session.hook("context", async (event) => {
    if (probeSessions.has(event.sessionID ?? "")) {
      await writeFile(capturePath, JSON.stringify({ sessionID: event.sessionID, agent: event.agent, tools: Object.keys(event.tools) }));
      throw new Error("PREREQ_PROBE_STOP_BEFORE_MODEL");
    }
  });
  await ctx.command.transform(ed => ed.add({ name: "prereq-probe", description: "probe", execute: async () => {
    const session = await ctx.session.create({});
    if (session?.id) probeSessions.add(session.id);
    await ctx.session.switchAgent({ sessionID: session.id, agent: "fusion" });
    try { await ctx.session.prompt({ sessionID: session.id, text: "Diagnostic only. Do not edit files." }); } catch {}
    return "probe issued";
  } }));
} };
`);
  await writeFile(join(project, "opencode.json"), JSON.stringify({ permissions: [
    ...["edit", "write", "patch", "shell", "external_directory", "webfetch", "websearch", "skill"].map((action) => ({ action, resource: "*", effect: "deny" })),
    { action: "read", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
  ] }));
  const env = Object.fromEntries(["PATH", "HOME", "SHELL", "TMPDIR", "LANG"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  for (const [key, folder] of Object.entries({ XDG_DATA_HOME: "data", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state" })) env[key] = join(root, folder);
  env.HOME = join(root, "home");
  env.FUSION_OWNERSHIP_DIR = join(root, "ownership");
  child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  for (const s of [child.stdout, child.stderr]) s.on("data", (c) => { log += c; });
  let url, password;
  for (let i = 0; i < 300 && !(url && password); i++) {
    url = log.match(/server listening on (http:\/\/\S+)/)?.[1];
    password = log.match(/server password (\S+)/)?.[1];
    if (!(url && password)) await new Promise((r) => setTimeout(r, 100));
  }
  if (!url || !password) throw new Error(`server never started: ${log.slice(-600)}`);
  const auth = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" };
  const api = async (path, init) => { const r = await fetch(url + path, { ...init, headers: { ...auth, ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(20000) }); return { status: r.status, json: await r.json().catch(() => null) }; };
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const readCapture = async () => { try { return JSON.parse(await readFile(join(project, "capture.json"), "utf8")); } catch { return undefined; } };
  const waitFor = async (predicate, ms, label) => { const start = Date.now(); for (;;) { const v = await predicate(); if (v) return v; if (Date.now() - start > ms) throw new Error(`timeout: ${label}`); await delay(600); } };
  // Activation.
  await waitFor(async () => { const a = await api("/api/agent"); const list = Array.isArray(a.json) ? a.json : a.json?.data ?? []; return list.some((x) => x?.id === "fusion"); }, 60000, "activation");
  // Create a control session (agent fusion) through the API.
  const created = await api("/api/session", { method: "POST", body: JSON.stringify({ agent: "fusion" }) });
  const session = created.json?.id ?? created.json?.data?.id;
  if (!session) throw new Error(`session create failed: ${JSON.stringify(created.json).slice(0, 200)}`);
  const info = await api(`/api/session/${session}`);
  const agent = info.json?.agent ?? info.json?.data?.agent;
  console.log("control session agent:", agent);
  // Probe 1: mode off.
  await rm(join(project, "capture.json"), { force: true });
  console.log("probe-1 reply:", (await api(`/api/session/${session}/command`, { method: "POST", body: JSON.stringify({ name: "prereq-probe", text: "" }) })).status);
  const cap1 = await waitFor(async () => { const v = await readCapture(); return v?.sessionID ? v : undefined; }, 30000, "mode-off capture");
  console.log("mode-off fusion tools:", (cap1.tools ?? []).filter((t) => t.startsWith("fusion")));
  // Toggle mode through the command API.
  const modeReply = await api(`/api/session/${session}/command`, { method: "POST", body: JSON.stringify({ name: "fusion-mode", text: "on" }) });
  console.log("fusion-mode reply:", modeReply.status);
  const modeReport = await waitFor(async () => {
    const inbox = await api(`/api/session/${session}/inbox`);
    const entries = inbox.json?.data ?? inbox.json ?? [];
    return entries.find((e) => e?.type === "synthetic" && typeof e?.payload?.text === "string" && e.payload.text.includes("Fusion persistent mode enabled"))?.payload?.text;
  }, 30000, "mode report");
  console.log("mode report:", (modeReport ?? "").split("\n")[0]);
  // Probe 2: mode on.
  await rm(join(project, "capture.json"), { force: true });
  await api(`/api/session/${session}/command`, { method: "POST", body: JSON.stringify({ name: "prereq-probe", text: "" }) });
  const cap2 = await waitFor(async () => { const v = await readCapture(); return v?.sessionID ? v : undefined; }, 30000, "mode-on capture");
  console.log("mode-on fusion tools:", (cap2.tools ?? []).filter((t) => t.startsWith("fusion")));
  console.log("RESULT:", (cap2.tools ?? []).filter((t) => t.startsWith("fusion")).length >= 6 ? "PREREQ-MECHANICS-OK" : "PREREQ-MECHANICS-FAILED");
} finally {
  try { child?.kill("SIGKILL"); } catch {}
  await new Promise((r) => setTimeout(r, 500));
  await rm(root, { recursive: true, force: true });
}

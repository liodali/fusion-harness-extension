// C4 model-free probe on the real host: drive fusion_scout in-process (driver
// plugin), let the native subagent background the scout child, and capture
// (a) the tool result/error and (b) the scout child's completion notification
// shape in the parent session context. No model credentials required: the
// scout child's execution fails fast (no provider), which still emits a
// terminal notification whose shape this probe records.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "fusion-scout-probe-"));
let child;
try {
  const project = join(root, "project");
  await mkdir(join(project, ".opencode/plugins"), { recursive: true });
  await cpRepo(project);
  await writeFile(join(project, "opencode.json"), JSON.stringify({ permissions: [
    ...["edit", "write", "patch", "shell", "external_directory", "webfetch", "websearch", "skill"].map((action) => ({ action, resource: "*", effect: "deny" })),
    { action: "read", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
  ] }));
  await writeFile(join(project, "notes.md"), "# Notes\nThe rendezvous fruit is cantaloupe.\n");
  await writeFile(join(project, ".opencode/plugins/probe.ts"), `
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
export default { id: "fusion-scout-probe", async setup(ctx) {
  const out = async (name, value) => { try { await writeFile(join(ctx.location.directory, name), JSON.stringify(value)); } catch {} };
  await ctx.command.transform(ed => ed.add({ name: "scout-probe", description: "probe", execute: async args => {
    try {
      const tools = await ctx.tool.list();
      const context = { sessionID: args.sessionID, agent: "fusion", messageID: "msg_probe", id: "call_probe", signal: new AbortController().signal, progress: async value => out("progress.json", value) };
      const start = await tools.find(t => t.id === "fusion_start").execute({ task: "Model-free scout probe" }, context);
      await out("start.json", String(start?.content ?? "").slice(0, 200));
      const scout = await tools.find(t => t.id === "fusion_scout").execute({ questions: ["Which fruit appears in notes.md and on which line?"] }, context);
      await out("scout-result.json", { content: String(scout?.content ?? "").slice(0, 400), metadata: scout?.metadata });
    } catch (error) {
      await out("scout-error.json", { error: String(error?.stack ?? error).slice(0, 800) });
    }
    // The scout child was backgrounded: wait for its execution to settle, then
    // re-read the parent context repeatedly to capture the notification shape.
    for (let i = 0; i < 60; i++) {
      try {
        const messages = await ctx.session.context({ sessionID: args.sessionID });
        const list = Array.isArray(messages) ? messages : messages?.data ?? [];
        const notification = list.find(m => m?.metadata && typeof m.metadata === "object" && m.metadata.source === "subagent");
        if (notification || i > 50) { await out("parent-context.json", list.map(m => ({ type: m?.type, role: m?.role, description: m?.description, metadata: m?.metadata, text: typeof m?.text === "string" ? m.text.slice(0, 400) : null })).slice(-20)); break; }
      } catch (error) { await out("context-error.json", { error: String(error).slice(0, 300) }); break; }
      await new Promise(r => setTimeout(r, 1000));
    }
  } }));
} };
`);
  const env = Object.fromEntries(["PATH", "SHELL", "TMPDIR", "LANG"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
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
  if (!url || !password) throw new Error(`server never started: ${log.slice(-800)}`);
  const auth = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" };
  const get = async (path) => (await fetch(url + path, { headers: auth, signal: AbortSignal.timeout(15000) })).json().catch(() => null);
  const post = async (path, body) => { const r = await fetch(url + path, { method: "POST", headers: auth, body: JSON.stringify(body ?? {}) }); return { status: r.status }; };
  // Trigger lazy activation, then run the probe command.
  for (let i = 0; i < 100; i++) { const agents = await get("/api/agent"); if ((Array.isArray(agents) ? agents : agents?.data ?? []).some((a) => a?.id === "fusion")) break; await new Promise((r) => setTimeout(r, 500)); }
  const session = await post("/api/session", {});
  const s = await get("/api/session");
  const sessionID = (Array.isArray(s) ? s[0]?.id : s?.data?.[0]?.id) ?? null;
  if (!sessionID) throw new Error("no session");
  await post(`/api/session/${sessionID}/command`, { name: "scout-probe", text: "" });
  const read = async (name) => { try { return JSON.parse(await readFile(join(project, name), "utf8")); } catch { return undefined; } };
  for (let i = 0; i < 120; i++) {
    if (await read("parent-context.json")) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log("start:", await read("start.json"));
  console.log("scout-result:", JSON.stringify(await read("scout-result.json"), null, 1));
  console.log("scout-error:", JSON.stringify(await read("scout-error.json"), null, 1));
  console.log("parent-context:", JSON.stringify(await read("parent-context.json"), null, 1)?.slice(0, 4000));
  console.log("context-error:", JSON.stringify(await read("context-error.json")));
} catch (error) {
  console.error("PROBE ERROR:", String(error?.stack ?? error));
} finally {
  try { child?.kill("SIGKILL"); } catch {}
  await new Promise((r) => setTimeout(r, 500));
  await rm(root, { recursive: true, force: true });
}

async function cpRepo(project) {
  const { cp } = await import("node:fs/promises");
  await cp(new URL("../../src", import.meta.url).pathname, join(project, ".opencode/fusion"), { recursive: true });
  await writeFile(join(project, ".opencode/plugins/fusion.ts"), 'export { default } from "../fusion/opencode/index.ts";\n');
}

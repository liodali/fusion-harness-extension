// Compare ctx.agent.list() (the plugin's own registry view) with /api/agent on
// both hosts, with shipped Markdown agents present.
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..", "..");
const bin = process.env.FUSION_OPENCODE_BIN || "opencode";
const root = await mkdtemp(join(tmpdir(), "fusion-agentlist-"));
const children = [];
try {
  const project = join(root, "project");
  await mkdir(join(project, ".opencode/plugins"), { recursive: true });
  await mkdir(join(project, ".opencode/agent"), { recursive: true });
  await cp(join(repo, "src"), join(project, ".opencode/fusion"), { recursive: true });
  await cp(join(repo, "examples/opencode/agents"), join(project, ".opencode/agent"), { recursive: true });
  await writeFile(join(project, ".opencode/plugins/fusion.ts"), 'export { default } from "../fusion/opencode/index.ts";\n');
  await writeFile(join(project, ".opencode/plugins/driver.ts"), `
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
export default { id: "agent-list-probe", async setup(ctx) {
  await ctx.command.transform(ed => ed.add({ name: "agent-list-probe", description: "probe", execute: async args => {
    const listed = await ctx.agent.list();
    const agents = Array.isArray(listed) ? listed : listed?.data ?? [];
    const picked = agents.filter(a => ["fusion", "fusion-executor", "fusion-scout"].includes(a?.id)).map(a => ({ id: a.id, mode: a.mode, permissions: a.permissions }));
    await writeFile(join(ctx.location.directory, "agent-list.json"), JSON.stringify(picked, null, 1));
  } }));
} };
`);
  const env = Object.fromEntries(["PATH", "SHELL", "TMPDIR", "LANG"].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  env.HOME = join(root, "home");
  for (const [key, folder] of Object.entries({ XDG_DATA_HOME: "data", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state" })) env[key] = join(root, folder);
  env.FUSION_OWNERSHIP_DIR = join(root, "ownership");
  const child = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let log = "";
  for (const s of [child.stdout, child.stderr]) s.on("data", (c) => { log += c; });
  let url, password;
  for (let i = 0; i < 300 && !(url && password); i++) {
    url = log.match(/server listening on (http:\/\/\S+)/)?.[1];
    password = log.match(/server password (\S+)/)?.[1];
    if (!(url && password)) await new Promise((r) => setTimeout(r, 100));
  }
  if (!url || !password) throw new Error(`server did not start: ${log.slice(-500)}`);
  const auth = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" };
  const get = async (path) => (await fetch(url + path, { headers: auth, signal: AbortSignal.timeout(15000) })).json().catch(() => null);
  const post = async (path, body) => { const r = await fetch(url + path, { method: "POST", headers: auth, body: JSON.stringify(body ?? {}) }); return r.status; };
  for (let i = 0; i < 120; i++) { const agents = await get("/api/agent"); const list = Array.isArray(agents) ? agents : agents?.data ?? []; if (list.some((a) => a?.id === "fusion")) break; await new Promise((r) => setTimeout(r, 500)); }
  await post("/api/session", {});
  const s = await get("/api/session");
  const sessionID = (Array.isArray(s) ? s[0]?.id : s?.data?.[0]?.id);
  await post(`/api/session/${sessionID}/command`, { name: "agent-list-probe", text: "" });
  let dump;
  for (let i = 0; i < 60 && !dump; i++) { try { dump = JSON.parse(await readFile(join(project, "agent-list.json"), "utf8")); } catch { await new Promise((r) => setTimeout(r, 500)); } }
  console.log(`host: ${bin === "opencode" ? "2.3.0" : "2.2.5"} — ctx.agent.list() fusion agents:`);
  for (const a of dump ?? []) {
    const counts = new Map();
    for (const r of a.permissions ?? []) counts.set(`${r.action}|${r.resource}|${r.effect}`, (counts.get(`${r.action}|${r.resource}|${r.effect}`) ?? 0) + 1);
    console.log(` ${a.id} mode=${a.mode} rules=${a.permissions?.length} dups=${[...counts.values()].filter((n) => n > 1).length}`);
  }
} finally {
  for (const c of children) { try { c.kill("SIGKILL"); } catch {} }
  await new Promise((r) => setTimeout(r, 400));
  await rm(root, { recursive: true, force: true });
}

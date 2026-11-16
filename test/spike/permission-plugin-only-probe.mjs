// Does 2.3.0 append host-default permission rules to plugin-contributed agents
// when no Markdown agent files exist? Boot with plugin only, dump permissions.
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..", "..");
const root = await mkdtemp(join(tmpdir(), "fusion-perm2-"));
const children = [];
try {
  const project = join(root, "project");
  await mkdir(join(project, ".opencode/plugins"), { recursive: true });
  await cp(join(repo, "src"), join(project, ".opencode/fusion"), { recursive: true });
  await writeFile(join(project, ".opencode/plugins/fusion.ts"), 'export { default } from "../fusion/opencode/index.ts";\n');
  const env = Object.fromEntries(["PATH", "SHELL", "TMPDIR", "LANG"].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  env.HOME = join(root, "home");
  for (const [key, folder] of Object.entries({ XDG_DATA_HOME: "data", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state" })) env[key] = join(root, folder);
  env.FUSION_OWNERSHIP_DIR = join(root, "ownership");
  const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
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
  const auth = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
  const get = async (path) => (await fetch(url + path, { headers: auth, signal: AbortSignal.timeout(15000) })).json().catch(() => null);
  let agents = [];
  for (let i = 0; i < 120; i++) {
    agents = (await get("/api/agent")) ?? [];
    const list = Array.isArray(agents) ? agents : agents.data ?? [];
    if (list.some((a) => a?.id === "fusion")) { await new Promise((r) => setTimeout(r, 1500)); agents = (await get("/api/agent")) ?? []; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  const list = Array.isArray(agents) ? agents : agents.data ?? [];
  for (const id of ["fusion", "fusion-executor", "fusion-scout"]) {
    const observed = list.find((a) => a?.id === id);
    console.log(`--- ${id} (plugin-only) ---`);
    console.log(JSON.stringify(observed?.permissions));
    const ruleCounts = new Map();
    for (const r of observed?.permissions ?? []) ruleCounts.set(`${r.action}|${r.resource}|${r.effect}`, (ruleCounts.get(`${r.action}|${r.resource}|${r.effect}`) ?? 0) + 1);
    console.log("duplicates:", [...ruleCounts.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${k} x${n}`));
  }
} finally {
  for (const c of children) { try { c.kill("SIGKILL"); } catch {} }
  await new Promise((r) => setTimeout(r, 400));
  await rm(root, { recursive: true, force: true });
}

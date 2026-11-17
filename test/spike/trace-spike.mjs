// Spike 13: serve with --log-level all --print-logs during a hanging call.
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const model = process.env.FUSION_OPENCODE_MODEL;
const root = await mkdtemp(join(tmpdir(), "fusion-trace-"));
let child;
try {
  const project = join(root, "project");
  await mkdir(join(project, ".opencode/plugins"), { recursive: true });
  await mkdir(join(project, ".opencode/agents"), { recursive: true });
  await cp(join(repo0(), "src"), join(project, ".opencode/fusion"), { recursive: true });
  await cp(join(repo0(), "examples/opencode/agents"), join(project, ".opencode/agents"), { recursive: true });
  await writeFile(join(project, ".opencode/plugins/fusion.ts"), 'export { default } from "../fusion/opencode/index.ts";\n');
  await writeFile(join(project, "notes.md"), "# Notes\nThe rendezvous fruit is cantaloupe.\n");
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) if (key.startsWith("XDG_")) delete childEnv[key];
  childEnv.FUSION_OWNERSHIP_DIR = join(root, "ownership");
  child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0", "--log-level", "all", "--print-logs"], { cwd: project, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  for (const s of [child.stdout, child.stderr]) s.on("data", (c) => { log += c; });
  let url, password;
  for (let i = 0; i < 300 && !(url && password); i++) {
    url = log.match(/server listening on (http:\/\/\S+)/)?.[1];
    password = log.match(/server password (\S+)/)?.[1];
    if (!(url && password)) await new Promise((r) => setTimeout(r, 100));
  }
  const auth = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" };
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const get = async (path) => { try { const r = await fetch(url + path, { headers: auth, signal: AbortSignal.timeout(20000) }); return { status: r.status, json: await r.json().catch(() => null) }; } catch { return { status: 0, json: null }; } };
  const post = async (path, body) => { const r = await fetch(url + path, { method: "POST", headers: auth, body: JSON.stringify(body ?? {}) }); return r.json().catch(() => null); };
  await get("/api/agent");
  await delay(5000);
  const session = await post("/api/session", { model: { providerID: model.split("/")[0], id: model.split("/")[1] } });
  const sid = session?.id ?? session?.data?.id;
  await post(`/api/session/${sid}/prompt`, { text: "Reply with exactly: pong" });
  await delay(30000);
  const cut = log.slice(-12000);
  const interesting = cut.split("\n").slice(-80);
  console.log(interesting.join("\n").slice(0, 6000));
} finally { try { child?.kill("SIGKILL"); } catch {} await new Promise((r) => setTimeout(r, 500)); await rm(root, { recursive: true, force: true }); }
function repo0() { return new URL("../..", import.meta.url).pathname; }

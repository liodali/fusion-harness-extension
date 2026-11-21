// Spike 12: does the serve process even attempt an outbound provider call?
import { spawn, execSync } from "node:child_process";
import { cp, mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const model = process.env.FUSION_OPENCODE_MODEL;
const root = await mkdtemp(join(tmpdir(), "fusion-net-"));
let child;
try {
  const project = join(root, "project");
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "notes.md"), "# Notes\nThe rendezvous fruit is cantaloupe.\n");
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) if (key.startsWith("XDG_")) delete childEnv[key];
  childEnv.FUSION_OWNERSHIP_DIR = join(root, "ownership");
  child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
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
  const post = async (path, body) => { const r = await fetch(url + path, { method: "POST", headers: auth, body: JSON.stringify(body ?? {}) }); return r.json().catch(() => null); };
  await fetch(url + "/api/agent", { headers: auth }).then((r) => r.json()).catch(() => null);
  await delay(1000);
  const session = await post("/api/session", {});
  const sid = session?.id ?? session?.data?.id;
  await post(`/api/session/${sid}/prompt`, { text: "Reply with exactly: pong" });
  const snap = () => { try { return execSync(`lsof -p ${child.pid} -a -i 2>/dev/null | grep -v LISTEN | tail -5`).toString(); } catch { return "(none)"; } };
  for (let i = 0; i < 4; i++) { console.log(`t+${i * 5}s outbound:`, snap().split("\n").slice(-4).join(" | ")); await delay(5000); }
} finally { try { child?.kill("SIGKILL"); } catch {} await rm(root, { recursive: true, force: true }); }

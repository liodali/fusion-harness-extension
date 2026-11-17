// Spike 11: serve-mode model call WITHOUT the Fusion plugin.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const model = process.env.FUSION_OPENCODE_MODEL;
const root = await mkdtemp(join(tmpdir(), "fusion-noplug-"));
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
  const get = async (path) => { try { const r = await fetch(url + path, { headers: auth, signal: AbortSignal.timeout(20000) }); return { status: r.status, json: await r.json().catch(() => null) }; } catch { return { status: 0, json: null }; } };
  const post = async (path, body) => { const r = await fetch(url + path, { method: "POST", headers: auth, body: JSON.stringify(body ?? {}) }); return { status: r.status, json: await r.json().catch(() => null) }; };
  await get("/api/agent");
  await delay(1500);
  const started = Date.now();
  const session = await post("/api/session", {});
  const sid = session?.id ?? session?.data?.id;
  await post(`/api/session/${sid}/prompt`, { text: "Reply with exactly: pong" });
  let answered = null;
  for (let i = 0; i < 60; i++) {
    const messages = await get(`/api/session/${sid}/message`);
    const list = Array.isArray(messages.json) ? messages.json : messages.json?.data ?? [];
    const textPart = (list ?? []).flatMap((m) => m?.parts ?? []).find((p) => p?.type === "text" && typeof p?.text === "string" && p.text.trim().length > 0);
    if (textPart) { answered = `+${((Date.now() - started) / 1000).toFixed(0)}s: ${String(textPart.text).slice(0, 40)}`; break; }
    await delay(1000);
  }
  console.log(`no-model-field serve call: ${answered ?? "NO ANSWER in 60s"}`);
} finally { try { child?.kill("SIGKILL"); } catch {} await new Promise((r) => setTimeout(r, 500)); await rm(root, { recursive: true, force: true }); }

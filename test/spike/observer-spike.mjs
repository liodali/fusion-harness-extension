// Spike 15: does the observer plugin (event subscription + context hook + command) unhang serve-mode model calls?
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const model = process.env.FUSION_OPENCODE_MODEL;
const root = await mkdtemp(join(tmpdir(), "fusion-obs-"));
let child;
try {
  const project = join(root, "project");
  await mkdir(join(project, ".opencode/plugins"), { recursive: true });
  await cp(new URL("../../src", import.meta.url).pathname, join(project, ".opencode/fusion"), { recursive: true });
  await writeFile(join(project, ".opencode/plugins/fusion.ts"), 'export { default } from "../fusion/opencode/index.ts";\n');
  await writeFile(join(project, "notes.md"), "# Notes\nThe rendezvous fruit is cantaloupe.\n");
  await writeFile(join(project, ".opencode/plugins/observer.ts"), `
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
export default { id: "obs-probe", async setup(ctx) {
  const ac = new AbortController();
  const iter = ctx.event.subscribe({ signal: ac.signal })[Symbol.asyncIterator]();
  void (async () => { for (;;) { const next = await iter.next(); if (next.done) break; } })().catch(() => {});
  await ctx.session.hook("context", async (event) => { void event; });
  await ctx.tool.hook("execute.after", async (event) => { void event; });
  await ctx.command.transform(ed => ed.add({ name: "obs-probe", description: "probe", execute: async () => "ok" }));
  return () => ac.abort();
} };
`);
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
  await delay(3000);
  const started = Date.now();
  const session = await post("/api/session", { model: { providerID: model.split("/")[0], id: model.split("/")[1] } });
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
  console.log(`observer-plugin serve call: ${answered ?? "NO ANSWER in 60s"}`);
} finally { try { child?.kill("SIGKILL"); } catch {} await new Promise((r) => setTimeout(r, 500)); await rm(root, { recursive: true, force: true }); }

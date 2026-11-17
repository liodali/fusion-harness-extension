// Spike 7: does the model work with and without variant "default"?
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const model = process.env.FUSION_OPENCODE_MODEL;
const repo = resolve(import.meta.dirname, "..", "..");
const root = await mkdtemp(join(tmpdir(), "fusion-variant-"));
let child;
try {
  const project = join(root, "project");
  await mkdir(join(project, ".opencode/plugins"), { recursive: true });
  await writeFile(join(project, ".opencode/plugins/fusion.ts"), 'export { default } from "../fusion/opencode/index.ts";\n');
  await cp(join(repo, "src"), join(project, ".opencode/fusion"), { recursive: true });
  await writeFile(join(project, "notes.md"), "# Notes\n\nThe rendezvous fruit is cantaloupe.\n");
  const env = Object.fromEntries(["PATH", "HOME", "SHELL", "TMPDIR", "LANG"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  for (const [key, folder] of Object.entries({ XDG_DATA_HOME: "data", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state" })) env[key] = join(root, folder);
  env.FUSION_OWNERSHIP_DIR = join(root, "ownership");
  const [provider, modelID] = model.split("/");
  const { Database } = await import("bun:sqlite");
  const { homedir } = await import("node:os");
  await mkdir(join(env.XDG_DATA_HOME, "opencode"), { recursive: true });
  try { const auth = JSON.parse(await readFile(join(homedir(), ".local/share/opencode/auth.json"), "utf8")); if (auth[provider]) await writeFile(join(env.XDG_DATA_HOME, "opencode/auth.json"), JSON.stringify({ [provider]: auth[provider] }), { mode: 0o600 }); } catch {}
  try { const account = JSON.parse(await readFile(join(homedir(), ".local/share/opencode/account.json"), "utf8")); const accountID = account?.active?.[provider]; const sel = accountID && account?.accounts?.[accountID]; if (sel) await writeFile(join(env.XDG_DATA_HOME, "opencode/account.json"), JSON.stringify({ version: account.version, accounts: { [accountID]: sel }, active: { [provider]: accountID } }), { mode: 0o600 }); } catch {}
  try { const db = new Database(join(homedir(), ".local/share/opencode/opencode.db"), { readonly: true }); const rows = db.query("SELECT value FROM credential WHERE integration_id = ? AND active = 1").all(provider); if (rows.length === 1) { const cred = JSON.parse(rows[0].value); if (provider === "opencode-go" && cred?.key) env.OPENCODE_API_KEY = cred.key; } db?.close(); } catch {}
  child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
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
  const started = Date.now();
  // The catalog: what variants exist for this model?
  const models = await get("/api/model");
  const mlist = Array.isArray(models.json) ? models.json : models.json?.data ?? [];
  const entry = mlist.find((m) => m?.providerID === provider && (m?.id === modelID || m?.modelID === modelID));
  console.log("catalog entry variants:", JSON.stringify(entry?.variants ?? entry?.model?.variants ?? null).slice(0, 300));
  for (const label of ["no-variant", "default-variant"]) {
    const body = { model: label === "no-variant" ? { providerID: provider, id: modelID } : { providerID: provider, id: modelID, variant: "default" } };
    const session = (await post("/api/session", body)).json;
    const sid = session?.id ?? session?.data?.id;
    await post(`/api/session/${sid}/prompt`, { text: "Reply with exactly: pong" });
    let answered = null;
    for (let i = 0; i < 45; i++) {
      const messages = await get(`/api/session/${sid}/message`);
      const list = Array.isArray(messages.json) ? messages.json : messages.json?.data ?? [];
      const textPart = (list ?? []).flatMap((m) => m?.parts ?? []).find((p) => p?.type === "text" && typeof p?.text === "string" && p.text.trim().length > 0);
      if (textPart) { answered = `+${((Date.now() - started) / 1000).toFixed(0)}s: ${String(textPart.text).slice(0, 40)}`; break; }
      await delay(1000);
    }
    console.log(`${label}: ${answered ?? "NO ANSWER in 45s"}`);
  }
} finally { try { child?.kill("SIGKILL"); } catch {} await rm(root, { recursive: true, force: true }); }

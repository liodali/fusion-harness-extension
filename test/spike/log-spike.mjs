// Spike 9: capture ALL server output during a hanging model call.
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, rm, writeFile, appendFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const model = process.env.FUSION_OPENCODE_MODEL;
const root = await mkdtemp(join(tmpdir(), "fusion-log-"));
let child;
try {
  const project = join(root, "project");
  await mkdir(join(project, ".opencode/plugins"), { recursive: true });
  await writeFile(join(project, ".opencode/plugins/fusion.ts"), 'export { default } from "../fusion/opencode/index.ts";\n');
  await cp(new URL("../../src", import.meta.url).pathname, join(project, ".opencode/fusion"), { recursive: true });
  const env = Object.fromEntries(["PATH", "HOME", "SHELL", "TMPDIR", "LANG"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  for (const [key, folder] of Object.entries({ XDG_DATA_HOME: "data", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state" })) env[key] = join(root, folder);
  env.HOME = join(root, "home");
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
  for (const s of [child.stdout, child.stderr]) s.on("data", async (c) => { log += c; await appendFile(join(root, "server.log"), c).catch(() => {}); });
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
  await delay(2000);
  const session = await post("/api/session", { model: { providerID: provider, id: modelID } });
  const sid = session?.id ?? session?.data?.id;
  await post(`/api/session/${sid}/prompt`, { text: "Reply with exactly: pong" });
  await delay(45000);
  console.log("server log tail:", log.slice(-3000));
} finally { try { child?.kill("SIGKILL"); } catch {} await new Promise((r) => setTimeout(r, 500)); await rm(root, { recursive: true, force: true }); }

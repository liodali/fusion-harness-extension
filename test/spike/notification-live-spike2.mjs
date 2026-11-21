// Live diagnostic v2: child outcome timing vs notification visibility in the
// parent's message list (during and after the supervisor's turn).
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const model = process.env.FUSION_OPENCODE_MODEL;
if (!model) throw new Error("Set FUSION_OPENCODE_MODEL");
const repo = resolve(import.meta.dirname, "..", "..");
const root = await mkdtemp(join(tmpdir(), "fusion-notif2-"));
let child;
try {
	const project = join(root, "project");
	await mkdir(join(project, ".opencode/plugins"), { recursive: true });
	await mkdir(join(project, ".opencode/agents"), { recursive: true });
	await cp(join(repo, "src"), join(project, ".opencode/fusion"), { recursive: true });
	await cp(join(repo, "examples/opencode/agents"), join(project, ".opencode/agents"), { recursive: true });
	await writeFile(join(project, ".opencode/plugins/fusion.ts"), 'export { default } from "../fusion/opencode/index.ts";\n');
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
	if (!url || !password) throw new Error(`server never started: ${log.slice(-400)}`);
	const auth = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" };
	const delay = (ms) => new Promise((r) => setTimeout(r, ms));
	const get = async (path) => { try { const r = await fetch(url + path, { headers: auth, signal: AbortSignal.timeout(20000) }); return { status: r.status, json: await r.json().catch(() => null) }; } catch (e) { return { status: 0, json: null }; } };
	const post = async (path, body) => { const r = await fetch(url + path, { method: "POST", headers: auth, body: JSON.stringify(body ?? {}) }); return { status: r.status, json: await r.json().catch(() => null) }; };
	for (let i = 0; i < 120; i++) { const a = await get("/api/agent"); const list = Array.isArray(a.json) ? a.json : a.json?.data ?? []; if (list.some((x) => x?.id === "fusion")) break; await delay(600); }
	const session = (await post("/api/session", { agent: "fusion", model: { providerID: provider, id: modelID } })).json;
	const parent = session?.id ?? session?.data?.id;
	await post(`/api/session/${parent}/command`, { name: "fusion-mode", text: "on" });
	await delay(800);
	const started = Date.now();
	await post(`/api/session/${parent}/prompt`, { text: 'Use fusion_scout once with this single question: "Which fruit appears in notes.md and on which line?" Then report the answer and stop. Do not call fusion_delegate.' });
	// Find the scout child.
	let childID;
	for (let i = 0; i < 120 && !childID; i++) {
		const sessions = await get("/api/session");
		const slist = Array.isArray(sessions.json) ? sessions.json : sessions.json?.data ?? [];
		childID = slist.find((s) => s?.agent === "fusion-scout")?.id;
		if (!childID) await delay(1000);
	}
	console.log(`child created at +${((Date.now() - started) / 1000).toFixed(1)}s:`, childID ?? "never");
	// Watch the child's outcome.
	let outcome;
	for (let i = 0; i < 420 && !outcome; i++) {
		const info = await get(`/api/session/${childID}`);
		const body = info.json ?? {};
		const o = body.outcome ?? body.data?.outcome;
		if (o) { outcome = o; console.log(`child outcome "${o}" at +${((Date.now() - started) / 1000).toFixed(1)}s`); break; }
		if (i % 15 === 14) console.log(`+${((Date.now() - started) / 1000).toFixed(0)}s child still running`);
		await delay(1000);
	}
	// Watch the parent's messages for the notification.
	for (let i = 0; i < 120; i++) {
		const messages = await get(`/api/session/${parent}/message`);
		const list = Array.isArray(messages.json) ? messages.json : messages.json?.data ?? [];
		const notif = (list ?? []).find((m) => m?.metadata?.source === "subagent");
		if (notif) { console.log(`notification visible in parent /message at +${((Date.now() - started) / 1000).toFixed(1)}s:`, JSON.stringify(notif).slice(0, 400)); break; }
		if (i % 10 === 9) console.log(`+${((Date.now() - started) / 1000).toFixed(0)}s parent messages: ${(list ?? []).map((m) => m?.role ?? m?.type ?? "?").join(",")}`);
		await delay(1000);
	}
} finally {
	try { child?.kill("SIGKILL"); } catch {}
	await new Promise((r) => setTimeout(r, 500));
	await rm(root, { recursive: true, force: true });
}

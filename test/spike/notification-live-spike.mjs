// Live diagnostic: where does the completed scout child's notification land,
// and when? Watches the bus and the parent's message list during the
// supervisor's turn. ONE live scout call, bounded at 6 minutes.
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const model = process.env.FUSION_OPENCODE_MODEL;
if (!model) throw new Error("Set FUSION_OPENCODE_MODEL");
const repo = resolve(import.meta.dirname, "..", "..");
const root = await mkdtemp(join(tmpdir(), "fusion-notif-live-"));
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
	const created = await (async () => { /* credentials copied by the fixture family; rely on env passthrough */ })(); void created;
	// Reuse the scout fixture's credential seeding by importing it? Simpler: copy the same logic minimally.
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
	const get = async (path) => { try { const r = await fetch(url + path, { headers: auth, signal: AbortSignal.timeout(20000) }); return { status: r.status, json: await r.json().catch(() => null) }; } catch (e) { return { status: 0, json: null, error: String(e).slice(0, 60) }; } };
	const post = async (path, body) => { const r = await fetch(url + path, { method: "POST", headers: auth, body: JSON.stringify(body ?? {}) }); return { status: r.status, json: await r.json().catch(() => null) }; };
	// Activation.
	for (let i = 0; i < 120; i++) { const a = await get("/api/agent"); const list = Array.isArray(a.json) ? a.json : a.json?.data ?? []; if (list.some((x) => x?.id === "fusion")) break; await delay(600); }
	// Create the fusion session with the model, toggle mode on.
	const session = (await post("/api/session", { agent: "fusion", model: { providerID: provider, id: modelID } })).json;
	const parent = session?.id ?? session?.data?.id;
	console.log("parent:", parent);
	await post(`/api/session/${parent}/command`, { name: "fusion-mode", text: "on" });
	await delay(1000);
	// Prompt the supervisor to scout.
	const prompt = await post(`/api/session/${parent}/prompt`, { text: 'Use fusion_scout once with this single question: "Which fruit appears in notes.md and on which line?" Then report the answer and stop. Do not call fusion_delegate.' });
	console.log("prompt status:", prompt.status);
	// Watch: bus events (via /api/event? the HTTP event stream) + the parent's message list.
	const started = Date.now();
	let notified = false;
	for (let i = 0; i < 360 && !notified; i++) {
		const messages = await get(`/api/session/${parent}/message`);
		const list = Array.isArray(messages.json) ? messages.json : messages.json?.data ?? messages.json?.messages ?? [];
		const notif = (list ?? []).find((m) => m?.metadata?.source === "subagent" || (typeof m?.text === "string" && m.text.includes("<subagent")));
		if (notif) {
			notified = true;
			console.log(`notification visible in /message at +${((Date.now() - started) / 1000).toFixed(1)}s:`, JSON.stringify(notif).slice(0, 300));
			break;
		}
		if (i % 10 === 9) {
			const roles = (list ?? []).map((m) => `${m?.role ?? m?.type ?? "?"}`).join(",");
			console.log(`+${((Date.now() - started) / 1000).toFixed(0)}s parent messages: ${roles}`);
		}
		await delay(1000);
	}
	if (!notified) console.log("no notification in /message after 6 minutes");
	// Also check the session list + child sessions.
	const sessions = await get("/api/session");
	const slist = Array.isArray(sessions.json) ? sessions.json : sessions.json?.data ?? [];
	console.log("sessions:", slist.map((s) => `${s?.id?.slice(-6)}:${s?.agent ?? "default"}`).join(" "));
} finally {
	try { child?.kill("SIGKILL"); } catch {}
	await new Promise((r) => setTimeout(r, 500));
	await rm(root, { recursive: true, force: true });
}

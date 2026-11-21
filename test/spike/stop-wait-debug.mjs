// Debug: stop-during-scout-wait — does the tool call adopt the cancelled
// notification and release scoutInFlight so a reset can proceed?
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..", "..");
const root = await mkdtemp(join(tmpdir(), "fusion-stop-wait-"));
let child;
try {
	const project = join(root, "project");
	await mkdir(join(project, ".opencode/plugins"), { recursive: true });
	await cp(join(repo, "src"), join(project, ".opencode/fusion"), { recursive: true });
	await writeFile(join(project, ".opencode/plugins/fusion.ts"), 'export { default } from "../fusion/opencode/index.ts";\n');
	await writeFile(join(project, ".opencode/plugins/driver.ts"), `
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
export default { id: "stop-wait-probe", async setup(ctx) {
	const out = async (name, value) => { try { await writeFile(join(ctx.location.directory, name), JSON.stringify(value)); } catch {} };
	await ctx.session.hook("context", async (event) => {
		if (event.agent === "fusion-scout") { await out("scout-context.json", { sessionID: event.sessionID }); await new Promise((r) => setTimeout(r, 15000)); throw new Error("STOP_WAIT_PROBE_STOP_BEFORE_MODEL"); }
	});
	await ctx.command.transform(ed => ed.add({ name: "stop-wait-probe", description: "probe", execute: async (args) => {
		try {
			const tools = await ctx.tool.list();
			const context = { sessionID: args.sessionID, agent: "fusion", messageID: "msg_probe", id: "call_probe", signal: new AbortController().signal, progress: async () => {} };
			await tools.find(t => t.id === "fusion_start").execute({ task: "Stop-wait probe" }, context);
			void tools.find(t => t.id === "fusion_scout").execute({ questions: ["Where is the stop marker?"] }, context).then(
				(value) => out("scout-result.json", { content: String(value?.content ?? "").slice(0, 300), metadata: value?.metadata }),
				(error) => out("scout-result.json", { error: String(error?.stack ?? error).slice(0, 300) }));
			await new Promise((r) => setTimeout(r, 2000));
			const stop = await tools.find(t => t.id === "fusion_stop").execute({ reason: "Stop-wait probe" }, context);
			await out("stop.json", String(stop?.content ?? "").slice(0, 400));
			await new Promise((r) => setTimeout(r, 4000));
			const afterStop = await tools.find(t => t.id === "fusion_status").execute({}, context);
			await out("status-after-stop.json", String(afterStop?.content ?? "").slice(0, 500));
			const reset = await tools.find(t => t.id === "fusion_reset").execute({}, context);
			await out("reset.json", String(reset?.content ?? "").slice(0, 300));
		} catch (error) {
			await out("probe-error.json", { error: String(error?.stack ?? error).slice(0, 500) });
		}
	} }));
} };
`);
	const env = Object.fromEntries(["PATH", "SHELL", "TMPDIR", "LANG"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
	for (const [key, folder] of Object.entries({ XDG_DATA_HOME: "data", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state" })) env[key] = join(root, folder);
	env.HOME = join(root, "home");
	env.FUSION_OWNERSHIP_DIR = join(root, "ownership");
	child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
	let log = "";
	for (const s of [child.stdout, child.stderr]) s.on("data", (c) => { log += c; });
	let url, password;
	for (let i = 0; i < 300 && !(url && password); i++) {
		url = log.match(/server listening on (http:\/\/\S+)/)?.[1];
		password = log.match(/server password (\S+)/)?.[1];
		if (!(url && password)) await new Promise((r) => setTimeout(r, 100));
	}
	if (!url || !password) throw new Error(`server never started: ${log.slice(-500)}`);
	const auth = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" };
	const get = async (path) => (await fetch(url + path, { headers: auth, signal: AbortSignal.timeout(15000) })).json().catch(() => null);
	const post = async (path, body) => { const r = await fetch(url + path, { method: "POST", headers: auth, body: JSON.stringify(body ?? {}) }); return r.status; };
	const delay = (ms) => new Promise((r) => setTimeout(r, ms));
	const read = async (name) => { try { return JSON.parse(await readFile(join(project, name), "utf8")); } catch { return undefined; } };
	for (let i = 0; i < 120; i++) { const agents = await get("/api/agent"); const list = Array.isArray(agents) ? agents : agents?.data ?? []; if (list.some((a) => a?.id === "fusion")) break; await delay(600); }
	const create = await (async () => { const r = await fetch(url + "/api/session", { method: "POST", headers: auth, body: "{}" }); return r.json().catch(() => null); })();
	const sessionID = create?.id ?? create?.data?.id;
	await post(`/api/session/${sessionID}/command`, { name: "stop-wait-probe", text: "" });
	for (let i = 0; i < 60; i++) { if (await read("reset.json") ?? await read("probe-error.json")) break; await delay(500); }
	console.log("scout-result:", JSON.stringify(await read("scout-result.json")));
	console.log("stop:", JSON.stringify(await read("stop.json")));
	console.log("status-after-stop:", JSON.stringify(await read("status-after-stop.json"))?.slice(0, 400));
	console.log("reset:", JSON.stringify(await read("reset.json")));
	console.log("probe-error:", JSON.stringify(await read("probe-error.json")));
} finally {
	try { child?.kill("SIGKILL"); } catch {}
	await new Promise((r) => setTimeout(r, 500));
	await rm(root, { recursive: true, force: true });
}

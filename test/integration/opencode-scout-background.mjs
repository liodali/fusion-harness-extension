// Model-free C4 regression on the real host (both pinned versions): a real
// fusion_scout call whose native subagent job the host backgrounds. The scout
// child's context hook stops before any model request (no credentials, no
// model call), the child reaches a terminal state, and the tool must adopt
// the child's outcome through the native completion notification — honestly,
// never the executor-settlement error and never a duplicate submission.
//
// Assertions: exactly one native scout submission and one scout child; the
// tool result carries the child's honest outcome (status completed/error/
// cancelled — never "Background executor requires a settlement handler");
// the invocation slot is consumed exactly once; a refused duplicate (the
// still-unproven or budget rule) creates no second child.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeArtifact } from "./artifact.mjs";

const repo = resolve(import.meta.dirname, "../..");
const root = await mkdtemp(join(tmpdir(), "fusion-scout-background-"));
const children = [];
const result = { ok: false, modelFree: true };
try {
	const project = join(root, "project");
	await mkdir(join(project, ".opencode/plugins"), { recursive: true });
	await cp(join(repo, "src"), join(project, ".opencode/fusion"), { recursive: true });
	await writeFile(join(project, ".opencode/plugins/fusion.ts"), 'export { default } from "../fusion/opencode/index.ts";\n');
	await writeFile(join(project, "notes.md"), "# Notes\nThe rendezvous fruit is cantaloupe.\n");
	await writeFile(join(project, ".opencode/plugins/driver.ts"), `
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
export default { id: "scout-background-probe", async setup(ctx) {
	const out = async (name, value) => { try { await writeFile(join(ctx.location.directory, name), JSON.stringify(value)); } catch {} };
	const appendLine = async (line) => { try { await appendFile(join(ctx.location.directory, "bus.jsonl"), String(line) + "\\n"); } catch {} };
	const iter = ctx.event?.subscribe?.()[Symbol.asyncIterator]?.();
	if (iter) void (async () => { for (;;) { const next = await iter.next(); if (next.done) break; await appendLine(JSON.stringify(next.value)); } })().catch(() => {});
	await ctx.session.hook("context", async (event) => {
		// The scout child stops before any model request: its terminal
		// notification still arrives, so the adoption path is exercised
		// model-free. The delay makes the notification arrive during the
		// tool's bounded wait (after the native result returned "running").
		if (event.agent === "fusion-scout") { await out("scout-context.json", { sessionID: event.sessionID }); await new Promise((r) => setTimeout(r, 6000)); throw new Error("SCOUT_BACKGROUND_PROBE_STOP_BEFORE_MODEL"); }
	});
	await ctx.command.transform(ed => ed.add({ name: "scout-background-probe", description: "probe", execute: async (args) => {
		try {
			const tools = await ctx.tool.list();
			const context = { sessionID: args.sessionID, agent: "fusion", messageID: "msg_probe", id: "call_probe", signal: new AbortController().signal, progress: async () => {} };
			await tools.find(t => t.id === "fusion_start").execute({ task: "Model-free scout background probe" }, context);
			const started = Date.now();
			const scout = await tools.find(t => t.id === "fusion_scout").execute({ questions: ["Which fruit appears in notes.md and on which line?"] }, context);
			await out("scout-result.json", { content: String(scout?.content ?? "").slice(0, 500), metadata: scout?.metadata, waitedMs: Date.now() - started });
			const statsRaw = await tools.find(t => t.id === "fusion_stats").execute({}, context);
			const stats = JSON.parse(String(statsRaw?.content ?? "{}"));
			await out("stats.json", stats);
		} catch (error) {
			await out("probe-error.json", { error: String(error?.stack ?? error).slice(0, 600) });
		}
	} }));
} };
`);
	await writeFile(join(project, "opencode.json"), JSON.stringify({ permissions: [
		...["edit", "write", "patch", "shell", "external_directory", "webfetch", "websearch", "skill"].map((action) => ({ action, resource: "*", effect: "deny" })),
		{ action: "read", resource: "*", effect: "allow" },
		{ action: "grep", resource: "*", effect: "allow" },
		{ action: "glob", resource: "*", effect: "allow" },
	] }));
	const env = Object.fromEntries(["PATH", "SHELL", "TMPDIR", "LANG"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
	for (const [key, folder] of Object.entries({ XDG_DATA_HOME: "data", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state" })) env[key] = join(root, folder);
	env.HOME = join(root, "home");
	env.FUSION_OWNERSHIP_DIR = join(root, "ownership");
	const child = spawn(process.env.FUSION_OPENCODE_BIN || "opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
	children.push(child);
	let log = "";
	for (const s of [child.stdout, child.stderr]) s.on("data", (c) => { log += c; });
	let url, password;
	for (let i = 0; i < 300 && !(url && password); i++) {
		url = log.match(/server listening on (http:\/\/\S+)/)?.[1];
		password = log.match(/server password (\S+)/)?.[1];
		if (!(url && password)) await new Promise((r) => setTimeout(r, 100));
	}
	assert.ok(url && password, "OpenCode server did not start");
	const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" };
	const get = async (path) => (await fetch(url + path, { headers, signal: AbortSignal.timeout(15000) })).json().catch(() => null);
	const post = async (path, body) => { const r = await fetch(url + path, { method: "POST", headers, body: JSON.stringify(body ?? {}) }); return r.status; };
	const delay = (ms) => new Promise((r) => setTimeout(r, ms));
	const read = async (name) => { try { return JSON.parse(await readFile(join(project, name), "utf8")); } catch { return undefined; } };
	// Activation: wait for the Fusion agents and commands.
	for (let i = 0; i < 120; i++) {
		const agents = await get("/api/agent");
		const list = Array.isArray(agents) ? agents : agents?.data ?? [];
		if (list.some((agent) => agent?.id === "fusion")) break;
		await delay(600);
	}
	const create = await (async () => { const r = await fetch(url + "/api/session", { method: "POST", headers, body: JSON.stringify({}) }); return r.json().catch(() => null); })();
	const sessionID = create?.id ?? create?.data?.id;
	assert.ok(sessionID, "a session could not be created");
	assert.equal(await post(`/api/session/${sessionID}/command`, { name: "scout-background-probe", text: "" }), 204);
	// The scout child blocks ~6s in its context hook, then fails; the tool's
	// wait adopts the notification after that.
	const probe = await (async () => { for (let i = 0; i < 90; i++) { const value = await read("scout-result.json") ?? await read("probe-error.json"); if (value) return value; await delay(500); } throw new Error("the probe never finished"); })();
	result.probe = probe;
	if (probe.error) throw new Error(`probe error: ${probe.error}`);
	const scoutContext = await (async () => { for (let i = 0; i < 60; i++) { const value = await read("scout-context.json"); if (value) return value; await delay(500); } return undefined; })();
	result.scoutChildSessionID = scoutContext?.sessionID ?? null;
	// 1. Honest disposition: never the executor-settlement error.
	assert.ok(!String(probe.content).includes("Background executor requires"), `the scout tool leaked the executor settlement error: ${String(probe.content).slice(0, 200)}`);
	const status = probe.metadata?.status;
	result.observedStatus = status ?? null;
	// Two honest shapes: a host that backgrounds the call adopts the child's
	// terminal notification (2.3.0); a foreground host reports the child's own
	// failure through the tool's error path (2.2.5). Neither claims an answer.
	if (!["completed", "error", "cancelled"].includes(status)) {
		assert.match(String(probe.content), /Fusion scout failed: Subagent failed/, `the tool result must carry the child's honest outcome, saw ${String(probe.content).slice(0, 200)}`);
		result.disposition = "foreground-child-failure";
	} else {
		result.disposition = "adopted-notification";
	}
	// 2. Exactly one native submission: one scout child on the bus.
	const bus = (await readFile(join(project, "bus.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
	const scoutChildren = bus.filter((e) => e.type === "session.created" && e.data?.agent === "fusion-scout");
	result.scoutChildrenOnBus = scoutChildren.length;
	assert.equal(scoutChildren.length, 1, `expected exactly one scout child, saw ${scoutChildren.length}`);
	assert.equal(scoutChildren[0].data.sessionID, result.scoutChildSessionID, "the adopted child does not match the bus");
	// 3. The invocation slot is consumed exactly once, and the turn's
	// accounting is banked (a model-free child reports unknown usage).
	const stats = await read("stats.json");
	result.stats = stats;
	assert.equal(stats?.scoutCalls?.used, 1, `expected one consumed scout invocation, saw ${JSON.stringify(stats?.scoutCalls)}`);
	// The tool call itself did not hang forever: the wait adopted the
	// notification within a bounded window.
	result.waitedMs = probe.waitedMs;
	assert.ok(probe.waitedMs < 60000, `the scout wait was unbounded (${probe.waitedMs}ms)`);
	result.ok = true;
} catch (error) {
	result.ok = false;
	result.error = String(error?.message ?? error);
	process.exitCode = 1;
} finally {
	await writeArtifact("opencode-scout-background", result, { secrets: [] });
	for (const child of children) { try { child.kill("SIGKILL"); } catch {} }
	await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify(result, null, 1));

// Isolated process: probes the reviewer's repro. (1) A successfully saved
// stop must reach the shared manifest's adapterData.legacyPi, not only the
// native run file. (2) When the native file is stale (stop marker absent),
// recovery must restore the marker authoritatively from the shared manifest
// so the stopped-work guard survives.
import { expect, mock, setDefaultTimeout, test } from "bun:test";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const root = process.env.FUSION_PI_TEST_DIR;
setDefaultTimeout(20000);
if (!root) throw new Error("Missing isolated Pi test directory");
let promptGate, promptEntered;
let durableEnabled = false;
let durableResumes = [];
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const capabilities = { transcriptReopen: true, activeTurnReattach: false, durableExecution: false, idempotentSubmission: false, readOnlyScout: true, exactScoutToolLimit: false, workerAbort: true, workerEvents: true };
const handle = {
	resumeRef: () => join(root, "session.jsonl"),
	setThinking: async () => {},
	prompt: async () => { promptEntered?.(); if (promptGate) await promptGate; return { text: '```json\n{"status":"done","summary":"ok"}\n```', usage }; },
	resume: async () => { throw new Error("not supported"); }, abort: async () => {}, dispose: () => {},
};
mock.module("../../src/pi/executor-backend.ts", () => ({
	createSessionExecutorBackend: () => ({ kind: "session", capabilities,
		createExecutor: async () => handle, dispose: async () => {} }),
}));
mock.module("../../src/pi/durable/backend.ts", () => ({ createDurableExecutorBackend: async () => {
	if (!durableEnabled) throw new Error("unavailable");
	return { kind: "durable", capabilities: { ...capabilities, activeTurnReattach: true, durableExecution: true, exactScoutToolLimit: true },
		openExecutor: async () => ({ ...handle, resumeRef: () => "42", resume: async (options) => { durableResumes.push(options.requestId); return { text: "recovered", usage }; } }),
		dispose: async () => {} };
} }));

const { default: registerFusion } = await import("../../src/index.ts");
const { writeRun, readRun, runsDir } = await import("../../src/runs.ts");
const { translatePiRun } = await import("../../src/pi/manifest-translation.ts");
const { canonicalWorkspace, openWorkspaceRegistry } = await import("../../src/workspace/ownership.ts");

function makePi(cwd, supervisorId = "supervisor") {
	process.env.FUSION_OWNERSHIP_DIR = join(cwd, ".test-state");
	const tools = new Map(), commands = new Map(), hooks = new Map(), notifications = [];
	let active = [], confirmed = false;
	const pi = { registerTool: (tool) => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command),
		on: (name, callback) => hooks.set(name, callback), getActiveTools: () => active, setActiveTools: (value) => { active = value; },
		setModel: async () => true, setThinkingLevel: () => {}, sendUserMessage: () => {}, exec: async () => ({ code: 1, stdout: "" }) };
	const model = { provider: "fake", id: "glm-5", name: "GLM 5", reasoning: false, cost: { output: 1 } };
	const supervisor = { provider: "fake", id: "gpt-6", name: "GPT 6", reasoning: false, cost: { output: 20 } };
	const ctx = { cwd, sessionManager: { getSessionId: () => supervisorId }, hasUI: true, mode: "rpc", scopedModels: [], modelRegistry: { find: () => model, getAvailable: () => [supervisor, model] },
		waitForIdle: async () => {}, ui: { notify: (message) => notifications.push(message), input: async () => "",
			select: async (_title, options) => options[0], confirm: async () => confirmed, setWidget: () => {} } };
	registerFusion(pi);
	return { tools, commands, hooks, notifications, ctx, confirm: (value) => { confirmed = value; } };
}

test("a successfully saved stop reaches the shared manifest's legacy Pi record", async () => {
	const cwd = join(root, "stop-persist-shared");
	await mkdir(cwd, { recursive: true });
	const f = makePi(cwd);
	await f.commands.get("fusion").handler("original task", f.ctx);
	let release;
	promptGate = new Promise((resolve) => { release = resolve; });
	const entered = new Promise((resolve) => { promptEntered = resolve; });
	try {
		const running = f.tools.get("fusion_delegate").execute("call", { action: "execute", brief: "build" }, undefined, undefined, f.ctx);
		await entered;
		const stopped = await f.tools.get("fusion_stop").execute("call", {}, undefined, undefined, f.ctx);
		expect(stopped.details.stopped).toBe(true);
		// The shared manifest — not only the native run file — carries the marker.
		const store = await openWorkspaceRegistry();
		const owned = await store.inspect(await canonicalWorkspace(cwd));
		expect(owned?.manifest.adapterData?.legacyPi?.stopped?.at).toBeString();
		let native;
		for (const file of await readdir(runsDir(root))) {
			const value = JSON.parse(await readFile(join(runsDir(root), file), "utf8"));
			if (value.cwd === cwd) { native = value; break; }
		}
		expect(native?.stopped?.at).toBeString();
		release();
		expect((await running).details.error).toBeUndefined();
	} finally { release(); promptGate = undefined; promptEntered = undefined; }
});

test("recovery restores the stop marker from the shared manifest when the native file is stale", async () => {
	durableEnabled = true; durableResumes = [];
	const cwd = join(root, "stop-shared-recovery");
	await mkdir(cwd, { recursive: true });
	const at = new Date().toISOString();
	const base = { runId: "stopped-shared-run", task: "original", originalTask: "original", brief: "brief",
		executor: { provider: "fake", modelId: "glm-5", label: "fake/glm-5", thinking: "off" },
		backend: "durable", conversationId: 42, status: "interrupted", revisions: 0, results: {},
		updatedAt: at, pending: { action: "execute", requestId: "original-request" } };
	// Stale native record: the stop never reached it.
	await writeRun(runsDir(root), { ...base, cwd });
	// The shared manifest holds the stop that was successfully saved.
	process.env.FUSION_OWNERSHIP_DIR = join(cwd, ".test-state");
	const workspace = await canonicalWorkspace(cwd);
	const owner = { harness: "pi", supervisorId: "supervisor", workspace };
	const manifest = translatePiRun({ ...base, cwd: workspace, stopped: { at, reason: "probe stop", abort: "delivered" } }, owner,
		{ transcriptReopen: true, activeTurnReattach: true, durableExecution: true, idempotentSubmission: false, readOnlyScout: true, exactScoutToolLimit: true, workerAbort: true, workerEvents: true });
	const store = await openWorkspaceRegistry();
	const fixtureLease = await store.claim(manifest);
	fixtureLease.close();
	const f = makePi(cwd);
	await f.commands.get("fusion-resume").handler("", f.ctx);
	expect(f.notifications.at(-1)).toContain("Resumed interrupted Fusion run stopped-shared-run");
	// The restored run kept its stopped-work guard: everything but resume is refused.
	const refused = await f.tools.get("fusion_delegate").execute("call", { action: "revise", brief: "more work" }, undefined, undefined, f.ctx);
	expect(refused.content[0].text).toContain("was stopped");
	// Recovering the original durable turn stays available.
	const resumed = await f.tools.get("fusion_delegate").execute("call", { action: "resume", brief: "resume" }, undefined, undefined, f.ctx);
	expect(resumed.details.error).toBeUndefined();
	expect(durableResumes).toEqual(["original-request"]);
	// The native record caught up with the authoritative marker.
	expect((await readRun(runsDir(root), base.runId))?.stopped?.at).toBe(at);
});

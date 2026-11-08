// Isolated process: mocks only the Durable harness and storage, not Fusion.
// Reproduces the reviewer's probe: cancellation during discardStale() or
// during event subscription setup must never record a submission.
import { expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sdk = (name, factory) => mock.module(Bun.resolveSync(name, repo), factory);
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage });
let entries = [], submissions = 0, aborts = 0, waits = 0;
let records = new Map();
let inspectGate, inspectEntered, watchGate, watchEntered;
const conversation = { id: 42, entries: async () => ({ items: entries }),
	commit: async (callback) => callback({ submissionByRequest: async (_id, requestId) => records.get(requestId) }),
	submit: async (input) => { submissions++; return { wait: async () => ({ id: 9, conversationId: 42, requestId: input.requestId, type: "input", status: "done", entry: 3, answer: 4 }) }; },
	abort: async () => { aborts++; } };
const harness = { inspect: async () => { inspectEntered?.(); if (inspectGate) await inspectGate; return { submissions: [], tasks: [] }; },
	createConversation: async () => conversation, conversation: async () => conversation,
	submission: async (id) => { const record = [...records.values()].find((item) => item.id === id); return record && { wait: async () => { waits++; return record; } }; },
	close: async () => {} };
sdk("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => process.env.FUSION_PI_TEST_DIR, ModelRuntime: { create: async () => ({}) }, createAgentSession: async () => {}, DefaultResourceLoader: class {}, SessionManager: {} }));
sdk("@earendil-works/pi-durable", () => ({ AssistantEntry: { is: (entry) => entry.kind === "assistant" }, UserEntry: { is: (entry) => entry.kind === "user" },
	Harness: { open: async () => harness }, createRegistry: () => ({ install: () => {} }),
	watchEvents: async () => { watchEntered?.(); if (watchGate) await watchGate; return { start: () => {}, stop: async () => {} }; } }));
sdk("@earendil-works/pi-durable/env/node", () => ({ NodeExecutionEnv: class {} }));
sdk("@earendil-works/pi-durable/storage/sqlite/node", () => ({ openNodeSqliteStorage: async () => ({}) }));
sdk("@earendil-works/pi-durable/tools", () => ({ CodingTools: {} }));
mock.module(repo + "/src/pi/durable/context.ts", () => ({ createFusionContext: () => ({ extension: {}, instructions: async () => "" }) }));
mock.module(repo + "/src/pi/durable/scout-tools.ts", () => ({ scoutCallsDoc: {}, scoutTools: {} }));
const { createDurableExecutorBackend } = await import("../../src/pi/durable/backend.ts");

const config = { cwd: process.env.FUSION_PI_TEST_DIR, model: { provider: "fake", id: "model" }, thinking: "off" };

test("cancellation during discardStale aborts an idle conversation and never submits", async () => {
	submissions = 0; aborts = 0; entries = [{ id: 4, kind: "assistant", model: [assistant("NEVER SUBMITTED")] }, { id: 3, kind: "user" }];
	const backend = await createDurableExecutorBackend();
	const handle = await backend.createExecutor(config);
	let release;
	inspectGate = new Promise((resolve) => { release = resolve; });
	const insideGap = new Promise((resolve) => { inspectEntered = resolve; });
	const controller = new AbortController();
	const turn = handle.prompt("work", { requestId: "cancel-during-stale", signal: controller.signal, onEvent: () => {} });
	await insideGap; // the abort below now lands strictly inside discardStale's await
	controller.abort();
	release();
	const result = await turn;
	expect(aborts).toBe(1); // the listener fired on the idle conversation
	expect(submissions).toBe(0); // ...but execution did not continue into submit
	expect(result.stopReason).toBe("aborted");
	expect(result.text).toBe("");
	await backend.dispose();
});

test("cancellation during event subscription setup never submits", async () => {
	submissions = 0; aborts = 0; entries = [{ id: 4, kind: "assistant", model: [assistant("NEVER SUBMITTED")] }, { id: 3, kind: "user" }];
	const backend = await createDurableExecutorBackend();
	const handle = await backend.createExecutor(config);
	let release;
	watchGate = new Promise((resolve) => { release = resolve; });
	const insideGap = new Promise((resolve) => { watchEntered = resolve; });
	const controller = new AbortController();
	const turn = handle.prompt("work", { requestId: "cancel-during-watch", signal: controller.signal, onEvent: () => {} });
	await insideGap; // the abort below now lands strictly inside watchEvents' await
	controller.abort();
	release();
	const result = await turn;
	expect(aborts).toBe(1);
	expect(submissions).toBe(0);
	expect(result.stopReason).toBe("aborted");
	await backend.dispose();
});

test("without cancellation the submission still runs and reports its transcript", async () => {
	submissions = 0; aborts = 0; entries = [{ id: 4, kind: "assistant", model: [assistant("REAL REPORT")] }, { id: 3, kind: "user" }];
	const backend = await createDurableExecutorBackend();
	const handle = await backend.createExecutor(config);
	const result = await handle.prompt("work", { requestId: "normal-turn", onEvent: () => {} });
	expect(submissions).toBe(1);
	expect(result.text).toBe("REAL REPORT");
	expect(result.stopReason).toBe("stop");
	await backend.dispose();
});

test("cancelling a resume during event setup still waits on the original submission", async () => {
	submissions = 0; aborts = 0; waits = 0; entries = [];
	// The reviewer's repro: the original submission already exists and is
	// settled by the abort; the resume must confirm it by waiting, not
	// fabricate a terminal aborted result with zero waits.
	records = new Map([["original-request", { id: 8, conversationId: 42, requestId: "original-request", type: "input", status: "unanswered", reason: "aborted by supervisor" }]]);
	const backend = await createDurableExecutorBackend();
	const handle = await backend.openExecutor(config, "42");
	let release;
	watchGate = new Promise((resolve) => { release = resolve; });
	const insideGap = new Promise((resolve) => { watchEntered = resolve; });
	const controller = new AbortController();
	const turn = handle.resume({ requestId: "original-request", signal: controller.signal, onEvent: () => {} });
	await insideGap; // the abort below now lands strictly inside watchEvents' await
	controller.abort();
	release();
	const result = await turn;
	expect(aborts).toBe(1); // the abort request reached the conversation
	expect(waits).toBe(1); // ...and the original submission was actually waited on
	expect(submissions).toBe(0); // no new submission was created
	expect(result.stopReason).toBe("aborted");
	expect(result.errorMessage).toBe("aborted by supervisor");
	await backend.dispose();
});

test("a resume whose original submission finished reports that outcome, not a synthetic one", async () => {
	submissions = 0; aborts = 0; waits = 0;
	entries = [{ id: 4, kind: "assistant", model: [assistant("ORIGINAL REPORT")] }, { id: 3, kind: "user" }];
	records = new Map([["original-request", { id: 8, conversationId: 42, requestId: "original-request", type: "input", status: "done", entry: 3, answer: 4 }]]);
	const backend = await createDurableExecutorBackend();
	const handle = await backend.openExecutor(config, "42");
	const controller = new AbortController();
	controller.abort(); // cancelled before settle even attaches
	const result = await handle.resume({ requestId: "original-request", signal: controller.signal, onEvent: () => {} });
	expect(waits).toBe(1);
	expect(result.text).toBe("ORIGINAL REPORT");
	expect(result.stopReason).toBe("stop");
	await backend.dispose();
});

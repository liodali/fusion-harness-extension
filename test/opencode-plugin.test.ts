import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import plugin, { notificationResult } from "../src/opencode/index.ts";
import { nodeGitExec } from "../src/workspace/node-git.ts";
import { openWorkspaceRegistry } from "../src/workspace/ownership.ts";
import { readRunManifest } from "../src/core/manifest.ts";
import { OPENCODE_CAPABILITIES } from "../src/opencode/native-executor.ts";
import { resolveCommandEntry } from "../src/core/guidance.ts";

/** The recovery presentation quotes the executable's actual installed path,
 * derived from the plugin module's own location (R4 review fix): the test
 * computes the same entry from the same module file. */
const RESOLVE_ENTRY = resolveCommandEntry(pathToFileURL(join(import.meta.dir, "..", "src", "opencode", "index.ts")).href);

type Context = { sessionID: string; agent: string; signal: AbortSignal; progress: (update: Record<string, unknown>) => Promise<void> };
type Tool = { name: string; execute: (input: unknown, context: Context) => Promise<{ content: string; metadata?: Record<string, unknown> }> };
type CommandDefinition = { name: string; description: string; execute: (args: { sessionID: string; prompt?: { text?: string } }) => unknown };
const context = (sessionID: string, agent = "fusion"): Context => ({ sessionID, agent, signal: new AbortController().signal, progress: async () => {} });

function memoryStorage() {
	const values = new Map<string, unknown>();
	return { get: async (key: string) => values.get(key), set: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); }, remove: async (key: string) => { values.delete(key); } };
}
type TestContext = Omit<Parameters<typeof plugin.setup>[0], "storage" | "session"> & { session: Omit<Parameters<typeof plugin.setup>[0]["session"], "get"> & Partial<Pick<Parameters<typeof plugin.setup>[0]["session"], "get">> };
const ownershipFixtures = new WeakMap<object, { root: string; close?: () => void }>();
const fixtureCleanup: { root: string; close?: () => void }[] = [];
afterEach(async () => { for (const fixture of fixtureCleanup.splice(0)) { fixture.close?.(); await rm(fixture.root, { recursive: true, force: true }); } });
async function setupTest(context: TestContext, storage = memoryStorage(), options: { waitStaleAfterMs?: number; scoutSettleTimeoutMs?: number } = {}) {
	let fixture = ownershipFixtures.get(storage);
	if (!fixture) { fixture = { root: await mkdtemp(join(tmpdir(), "fusion-plugin-owner-")) }; ownershipFixtures.set(storage, fixture); fixtureCleanup.push(fixture); }
	fixture.close?.();
	const get = context.session.get ?? (async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, parentID: sessionID.startsWith("child") ? "one" : undefined, location: { directory: context.location.directory } }));
	const result = await plugin.setup({ ...context, session: { switchAgent: async () => {}, synthetic: async () => {}, ...context.session, get }, storage }, { ownershipRoot: fixture.root, canonicalize: async (path) => path, ...(options.waitStaleAfterMs !== undefined ? { waitStaleAfterMs: options.waitStaleAfterMs } : {}), ...(options.scoutSettleTimeoutMs !== undefined ? { scoutSettleTimeoutMs: options.scoutSettleTimeoutMs } : {}) });
	fixture.close = result.close;
	return result;
}

describe("OpenCode Fusion plugin", () => {
	test("completion nudges are bounded and sent only for unfinished protocols", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		const nudges: (string | undefined)[] = [];
		const injections: (string | undefined)[] = [];
		const published: { description?: string }[] = [];
		const busQueue: { type: string; data?: Record<string, unknown> }[] = [];
		let busWake: (() => void) | undefined;
		let contextHook!: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void;
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { busWake = resolve; }); } } } } }) };
		const commands: CommandDefinition[] = [];
		await setupTest({
			location: { directory: "/workspace" },
			event: eventHost,
			session: { context: async () => [], hook: async (_name: string, callback: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void) => { contextHook = callback; }, switchAgent: async () => {}, synthetic: async (input) => { published.push(input); }, prompt: async (input) => { const value = input as { id?: string; text?: string }; if (value.id?.startsWith("msg_fusion_nudge")) nudges.push(value.text); else injections.push(value.text); } },
			command: { list: async () => ({ data: [] }), transform: async (callback) => { await callback({ add: (command) => commands.push(command) }); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }) }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		}, storage);
		const settle = async (text?: string) => {
			// The host builds the turn context for the fusion agent before the turn runs.
			contextHook({ agent: "fusion", tools: {}, sessionID: "one" });
			busQueue.push({ type: "session.execution.started", data: { sessionID: "one" } });
			busWake?.();
			if (text !== undefined) { busQueue.push({ type: "session.text.ended", data: { sessionID: "one", text } }); busWake?.(); }
			busQueue.push({ type: "session.execution.succeeded", data: { sessionID: "one" } });
			busWake?.();
			await new Promise((resolve) => setTimeout(resolve, 25));
		};
		await commands[1].execute({ sessionID: "one", prompt: { text: "on" } });
		await commands[0].execute({ sessionID: "one", prompt: { text: "Build the thing" } });
		expect(injections).toHaveLength(1);
		// Turn 1 ends without delegating: one bounded nudge tells the model to continue.
		await settle("I looked around a little.");
		expect(nudges).toHaveLength(1);
		expect(nudges[0]).toContain('fusion_delegate with action "execute"');
		// Turn 2: second and final nudge.
		await settle("Still thinking.");
		expect(nudges).toHaveLength(2);
		// Turn 3: the nudge budget is exhausted; nothing loops, and the unfinished
		// run reports incomplete instead of being marked complete.
		await settle("Still thinking more.");
		expect(nudges).toHaveLength(2);
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.settleNudges).toBe(2);
		expect(status.incomplete).toBe(true);
		expect(status.phase).not.toBe("complete");
		expect(status.nextAction).toContain("incomplete");
		// A turn that writes the Fusion summary after execution is complete: no nudge, run settles as complete.
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		await settle("All requirements audited.\n## Fusion summary\nDone.");
		expect(nudges).toHaveLength(2);
		const completed = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(completed.phase).toBe("complete");
		expect(completed.incomplete).toBe(false);
		// Interrupted turns never nudge.
		busQueue.push({ type: "session.execution.interrupted", data: { sessionID: "one" } });
		busWake?.();
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(nudges).toHaveLength(2);
	});

	test("a backgrounded executor turn suppresses completion nudges and settles uncertain runs", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		const nudges: (string | undefined)[] = [];
		const busQueue: { type: string; data?: Record<string, unknown> }[] = [];
		let busWake: (() => void) | undefined;
		let contextHook!: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void;
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { busWake = resolve; }); } } } } }) };
		const fusionTurn = () => { contextHook({ agent: "fusion", tools: {}, sessionID: "one" }); busQueue.push({ type: "session.execution.succeeded", data: { sessionID: "one" } }); busWake?.(); };
		const commands: CommandDefinition[] = [];
		await setupTest({
			location: { directory: "/workspace" },
			event: eventHost,
			session: { context: async () => [], hook: async (_name: string, callback: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void) => { contextHook = callback; }, switchAgent: async () => {}, prompt: async (input) => { const value = input as { id?: string; text?: string }; if (value.id?.startsWith("msg_fusion_nudge")) nudges.push(value.text); else injectionsGuard(value.text); } },
			command: { list: async () => ({ data: [] }), transform: async (callback) => { await callback({ add: (command) => commands.push(command) }); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx) => {
				await ctx.progress({ sessionID: "child-bg" });
				// The host backgrounds the delegation; the turn ends awaiting its notification.
				return { output: { sessionID: "child-bg", status: "running", output: "backgrounded" } };
			} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		}, storage);
		const injectionsGuard = (text?: string) => { void text; };
		await commands[0].execute({ sessionID: "one", prompt: { text: "Build it" } });
		// The host backgrounded the delegation: the tool resolves with the notice and the run is uncertain.
		const backgrounded = await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		expect(backgrounded.content).toContain("running in the background");
		// The turn ends while the executor is backgrounded and the run is uncertain: no nudge.
		fusionTurn();
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(nudges).toHaveLength(0);
		// P1: unresolved worker work keeps the run active so reconciliation stays available.
		expect(JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content).runActive).toBe(true);
	});

	test("settled turns deactivate non-persistent runs and keep persistent ones", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		const busQueue: { type: string; data?: Record<string, unknown> }[] = [];
		let busWake: (() => void) | undefined;
		let contextHook!: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void;
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { busWake = resolve; }); } } } } }) };
		const fusionTurn = () => { contextHook({ agent: "fusion", tools: {}, sessionID: "one" }); busQueue.push({ type: "session.execution.succeeded", data: { sessionID: "one" } }); busWake?.(); };
		const commands: CommandDefinition[] = [];
		const runActive = async () => JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content).runActive;
		await setupTest({
			location: { directory: "/workspace" },
			event: eventHost,
			session: { context: async () => [], hook: async (_name: string, callback: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void) => { contextHook = callback; }, switchAgent: async () => {}, prompt: async () => {} },
			command: { list: async () => ({ data: [] }), transform: async (callback) => { await callback({ add: (command) => commands.push(command) }); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }) }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		}, storage);
		await commands[0].execute({ sessionID: "one", prompt: { text: "Task" } });
		expect(await runActive()).toBe(true);
		// Interrupted turn with mode off: the run deactivates.
		contextHook({ agent: "fusion", tools: {}, sessionID: "one" });
		busQueue.push({ type: "session.execution.interrupted", data: { sessionID: "one" } });
		busWake?.();
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(await runActive()).toBe(false);
		// Persistent mode keeps the run active across turn ends.
		await commands[1].execute({ sessionID: "one", prompt: { text: "on" } });
		await commands[0].execute({ sessionID: "one", prompt: { text: "Task again" } });
		fusionTurn();
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(await runActive()).toBe(true);
	});

	test("completion binds to fusion turns, deduplicates redeliveries, and retries failed nudge delivery", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		const nudges: (string | undefined)[] = [];
		const injections: (string | undefined)[] = [];
		const published: { description?: string; text?: string }[] = [];
		const busQueue: { id?: string; type: string; data?: Record<string, unknown> }[] = [];
		let busWake: (() => void) | undefined;
		let contextHook!: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void;
		let nudgeDeliveryFails = false;
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { busWake = resolve; }); } } } } }) };
		const commands: CommandDefinition[] = [];
		const fusionTurn = (id?: string, text?: string) => {
			contextHook({ agent: "fusion", tools: {}, sessionID: "one" });
			busQueue.push({ type: "session.execution.started", data: { sessionID: "one" } });
			busWake?.();
			if (text !== undefined) { busQueue.push({ type: "session.text.ended", data: { sessionID: "one", text } }); busWake?.(); }
			busQueue.push({ id, type: "session.execution.succeeded", data: { sessionID: "one" } });
			busWake?.();
		};
		const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 25)); };
		await setupTest({
			location: { directory: "/workspace" },
			event: eventHost,
			session: { context: async () => [], hook: async (_name: string, callback: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void) => { contextHook = callback; }, switchAgent: async () => {}, synthetic: async (input) => { published.push(input); }, prompt: async (input) => { const value = input as { id?: string; text?: string }; if (value.id?.startsWith("msg_fusion_nudge")) { if (nudgeDeliveryFails) throw new Error("prompt transport down"); nudges.push(value.text); } else injections.push(value.text); } },
			command: { list: async () => ({ data: [] }), transform: async (callback) => { await callback({ add: (command) => commands.push(command) }); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }) }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		}, storage);
		await commands[1].execute({ sessionID: "one", prompt: { text: "on" } });
		await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
		// An ordinary agent driving the same session never nudges or settles the run.
		contextHook({ agent: "build", tools: {}, sessionID: "one" });
		busQueue.push({ id: "evt-build", type: "session.execution.succeeded", data: { sessionID: "one" } });
		busWake?.();
		await settle();
		expect(nudges).toHaveLength(0);
		// A fusion turn nudges; a redelivered terminal event with the same id does not.
		nudgeDeliveryFails = false;
		fusionTurn("evt-turn-1", "I looked around a little.");
		await settle();
		expect(nudges).toHaveLength(1);
		fusionTurn("evt-turn-1", "I looked around a little.");
		await settle();
		expect(nudges).toHaveLength(1);
		// A failed nudge delivery publishes an actionable failure and retries on the next turn end.
		nudgeDeliveryFails = true;
		fusionTurn("evt-turn-2", "Still investigating.");
		await settle();
		expect(nudges).toHaveLength(1);
		expect(published.some((entry) => entry.description?.startsWith("Fusion settlement issue\n"))).toBe(true);
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.nudgeDelivery).toBe("pending");
		nudgeDeliveryFails = false;
		fusionTurn("evt-turn-3", "Still investigating.");
		await settle();
		expect(nudges).toHaveLength(2);
		const delivered = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(delivered.nudgeDelivery).toBe("delivered");
	});

	test("summary detection evaluates the final assistant response, not interim text", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		const nudges: (string | undefined)[] = [];
		const busQueue: { id?: string; type: string; data?: Record<string, unknown> }[] = [];
		let busWake: (() => void) | undefined;
		let contextHook!: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void;
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { busWake = resolve; }); } } } } }) };
		const commands: CommandDefinition[] = [];
		const settle = async (parts: string[]) => {
			contextHook({ agent: "fusion", tools: {}, sessionID: "one" });
			busQueue.push({ type: "session.execution.started", data: { sessionID: "one" } });
			busWake?.();
			for (const part of parts) { busQueue.push({ type: "session.text.ended", data: { sessionID: "one", text: part } }); busWake?.(); }
			busQueue.push({ type: "session.execution.succeeded", data: { sessionID: "one" } });
			busWake?.();
			await new Promise((resolve) => setTimeout(resolve, 25));
		};
		await setupTest({
			location: { directory: "/workspace" },
			event: eventHost,
			session: { context: async () => [], hook: async (_name: string, callback: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void) => { contextHook = callback; }, switchAgent: async () => {}, prompt: async (input) => { const value = input as { id?: string; text?: string }; if (value.id?.startsWith("msg_fusion_nudge")) nudges.push(value.text); } },
			command: { list: async () => ({ data: [] }), transform: async (callback) => { await callback({ add: (command) => commands.push(command) }); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }) }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		}, storage);
		await commands[1].execute({ sessionID: "one", prompt: { text: "on" } });
		await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		// An interim part quoting the heading does not suppress the audit nudge.
		await settle(["The plan said \"## Fusion summary\" would come last.", "Still reviewing the diff."]);
		expect(nudges).toHaveLength(1);
		// The final response carrying the heading settles the run without a nudge.
		await settle(["Audit complete.\n## Fusion summary\nEverything checks out."]);
		expect(nudges).toHaveLength(1);
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.phase).toBe("complete");
	});

	test("interrupted and failed turns keep unresolved runs active and reconcile available", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		const busQueue: { id?: string; type: string; data?: Record<string, unknown> }[] = [];
		let busWake: (() => void) | undefined;
		let contextHook!: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void;
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { busWake = resolve; }); } } } } }) };
		const commands: CommandDefinition[] = [];
		await setupTest({
			location: { directory: "/workspace" },
			event: eventHost,
			session: { context: async () => [], hook: async (_name: string, callback: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void) => { contextHook = callback; }, switchAgent: async () => {}, prompt: async () => {} },
			command: { list: async () => ({ data: [] }), transform: async (callback) => { await callback({ add: (command) => commands.push(command) }); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx) => {
				await ctx.progress({ sessionID: "child-bg" });
				return { output: { sessionID: "child-bg", status: "running", output: "backgrounded" } };
			} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		}, storage);
		await commands[1].execute({ sessionID: "one", prompt: { text: "on" } });
		await commands[0].execute({ sessionID: "one", prompt: { text: "Build it" } });
		const backgrounded = await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		expect(backgrounded.content).toContain("running in the background");
		const runState = async () => JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		// Interrupted and failed terminals hold the run active while the executor
		// work is unresolved, so fusion_reconcile stays available.
		contextHook({ agent: "fusion", tools: {}, sessionID: "one" });
		busQueue.push({ id: "evt-int", type: "session.execution.interrupted", data: { sessionID: "one" } });
		busWake?.();
		await new Promise((resolve) => setTimeout(resolve, 25));
		let state = await runState();
		expect(state.runActive).toBe(true);
		expect(state.uncertain).toBe(true);
		const fusionRecord: Record<string, unknown> = { fusion_reconcile: {}, read: {} };
		contextHook({ agent: "fusion", tools: fusionRecord, sessionID: "one" });
		expect(fusionRecord).toHaveProperty("fusion_reconcile");
		busQueue.push({ id: "evt-fail", type: "session.execution.failed", data: { sessionID: "one" } });
		busWake?.();
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect((await runState()).runActive).toBe(true);
	});

	test("without session.prompt the nudge budget is not consumed and unfinished runs report incomplete", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		const busQueue: { id?: string; type: string; data?: Record<string, unknown> }[] = [];
		let busWake: (() => void) | undefined;
		let contextHook!: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void;
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { busWake = resolve; }); } } } } }) };
		const commands: CommandDefinition[] = [];
		await setupTest({
			location: { directory: "/workspace" },
			event: eventHost,
			session: { context: async () => [], hook: async (_name: string, callback: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void) => { contextHook = callback; }, switchAgent: async () => {} },
			command: { list: async () => ({ data: [] }), transform: async (callback) => { await callback({ add: (command) => commands.push(command) }); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }) }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		}, storage);
		// Without session.prompt, runs start through the model-facing fusion_start tool.
		await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
		contextHook({ agent: "fusion", tools: {}, sessionID: "one" });
		busQueue.push({ id: "evt-1", type: "session.execution.succeeded", data: { sessionID: "one" } });
		busWake?.();
		await new Promise((resolve) => setTimeout(resolve, 25));
		const state = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		// No budget consumed, no delivery faked; the unfinished protocol reports incomplete and stays active.
		expect(state.settleNudges).toBe(0);
		expect(state.nudgeDelivery).toBeUndefined();
		expect(state.incomplete).toBe(true);
		expect(state.runActive).toBe(true);
	});

	test("nudge retries re-persist intent, respect unresolved work, and survive persistence failure", async () => {
		const tools = new Map<string, Tool>();
		const backing = memoryStorage();
		let failPersist = false;
		const storage = { ...backing, set: async (key: string, value: unknown) => { if (failPersist) throw new Error("storage offline"); await backing.set(key, value); } };
		const nudges: string[] = [];
		const published: { description?: string }[] = [];
		const busQueue: { id?: string; type: string; data?: Record<string, unknown> }[] = [];
		let busWake: (() => void) | undefined;
		let contextHook!: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void;
		let failPrompt = false;
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { busWake = resolve; }); } } } } }) };
		const commands: CommandDefinition[] = [];
		await setupTest({
			location: { directory: "/workspace" },
			event: eventHost,
			session: { context: async () => [], hook: async (_name: string, callback: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void) => { contextHook = callback; }, switchAgent: async () => {}, synthetic: async (input) => { published.push(input); }, prompt: async (input) => { const value = input as { id?: string; text?: string }; if (value.id?.startsWith("msg_fusion_nudge")) { if (failPrompt) throw new Error("prompt transport down"); if (value.text !== undefined) nudges.push(value.text); } } },
			command: { list: async () => ({ data: [] }), transform: async (callback) => { await callback({ add: (command) => commands.push(command) }); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }) }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		}, storage);
		await commands[1].execute({ sessionID: "one", prompt: { text: "on" } });
		await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
		const settle = async (id: string, text?: string) => {
			contextHook({ agent: "fusion", tools: {}, sessionID: "one" });
			busQueue.push({ type: "session.execution.started", data: { sessionID: "one" } });
			busWake?.();
			if (text !== undefined) { busQueue.push({ type: "session.text.ended", data: { sessionID: "one", text } }); busWake?.(); }
			busQueue.push({ id, type: "session.execution.succeeded", data: { sessionID: "one" } });
			busWake?.();
			await new Promise((resolve) => setTimeout(resolve, 25));
		};
		await settle("evt-1", "Working.");
		expect(nudges).toHaveLength(1);
		expect(JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content).nudgeDelivery).toBe("delivered");
		// The next nudge delivery fails: the failure is published and delivery stays pending.
		failPrompt = true;
		await settle("evt-2", "Still working.");
		expect(nudges).toHaveLength(1);
		expect(published.some((entry) => entry.description?.startsWith("Fusion settlement issue\n"))).toBe(true);
		expect(JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content).nudgeDelivery).toBe("pending");
		// A retry while persistence is failing does not deliver an unrecorded nudge.
		failPersist = true;
		await settle("evt-3");
		expect(nudges).toHaveLength(1);
		expect(published.filter((entry) => entry.description?.startsWith("Fusion settlement issue\n")).length).toBeGreaterThanOrEqual(2);
		// Persistence and transport recover: the retry delivers without consuming the budget twice.
		failPersist = false;
		failPrompt = false;
		await settle("evt-4");
		expect(nudges).toHaveLength(2);
		expect(JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content).nudgeDelivery).toBe("delivered");
	});

	test("final settlement and incomplete state survive a reload", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		const busQueue: { id?: string; type: string; data?: Record<string, unknown> }[] = [];
		let busWake: (() => void) | undefined;
		let contextHook!: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void;
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { busWake = resolve; }); } } } } }) };
		const commands: CommandDefinition[] = [];
		const settle = async (id: string, parts: string[]) => {
			contextHook({ agent: "fusion", tools: {}, sessionID: "one" });
			busQueue.push({ type: "session.execution.started", data: { sessionID: "one" } });
			busWake?.();
			for (const part of parts) { busQueue.push({ type: "session.text.ended", data: { sessionID: "one", text: part } }); busWake?.(); }
			busQueue.push({ id, type: "session.execution.succeeded", data: { sessionID: "one" } });
			busWake?.();
			await new Promise((resolve) => setTimeout(resolve, 25));
		};
		const run = async () => setupTest({
			location: { directory: "/workspace" },
			event: eventHost,
			session: { context: async () => [], hook: async (_name: string, callback: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void) => { contextHook = callback; }, switchAgent: async () => {} },
			command: { list: async () => ({ data: [] }), transform: async (callback) => { await callback({ add: (command) => commands.push(command) }); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }) }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		}, storage);
		await run();
		await commands[1].execute({ sessionID: "one", prompt: { text: "on" } });
		await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
		// Exhaust the budget: incomplete, persisted across reload.
		await settle("evt-1", ["Working."]);
		await settle("evt-2", ["Working."]);
		await settle("evt-3", ["Working."]);
		expect(JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content).incomplete).toBe(true);
		await run();
		expect(JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content).incomplete).toBe(true);
		await tools.get("fusion_reset")!.execute({}, context("one"));
		// A completed run settles across reload too.
		await run();
		await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		await settle("evt-done", ["## Fusion summary\nAll done."]);
		let status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.phase).toBe("complete");
		// Persistent mode is on, so the run stays armed; the completed phase is what persists.
		await run();
		status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.phase).toBe("complete");
		expect(status.executed).toBe(true);
		expect(status.incomplete).toBe(false);
	});

	test("settlement serializes per run and stale settlements abort after resets", async () => {
		const tools = new Map<string, Tool>();
		const backing = memoryStorage();
		let gate!: () => void;
		let gated = false;
		let finishScout!: () => void;
		let scoutEntered!: () => void;
		const scoutStarted = new Promise<void>((resolve) => { scoutEntered = resolve; });
		const scoutGate = new Promise<void>((resolve) => { finishScout = resolve; });
		const storage = { ...backing, set: async (key: string, value: unknown) => { if (gated) { gated = false; await new Promise<void>((resolve) => { gate = resolve; }); } await backing.set(key, value); } };
		const nudges: string[] = [];
		const busQueue: { id?: string; type: string; data?: Record<string, unknown> }[] = [];
		let busWake: (() => void) | undefined;
		let contextHook!: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void;
		let failPrompt = true;
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { busWake = resolve; }); } } } } }) };
		const commands: CommandDefinition[] = [];
		const settle = async (id: string, text?: string) => {
			contextHook({ agent: "fusion", tools: {}, sessionID: "one" });
			busQueue.push({ type: "session.execution.started", data: { sessionID: "one" } });
			busWake?.();
			if (text !== undefined) { busQueue.push({ type: "session.text.ended", data: { sessionID: "one", text } }); busWake?.(); }
			busQueue.push({ id, type: "session.execution.succeeded", data: { sessionID: "one" } });
			busWake?.();
			await new Promise((resolve) => setTimeout(resolve, 25));
		};
		await setupTest({
			location: { directory: "/workspace" },
			event: eventHost,
			session: { context: async () => [], hook: async (_name: string, callback: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void) => { contextHook = callback; }, switchAgent: async () => {}, prompt: async (input) => { const value = input as { id?: string; text?: string }; if (value.id?.startsWith("msg_fusion_nudge")) { if (failPrompt) throw new Error("prompt transport down"); if (value.text !== undefined) nudges.push(value.text); } } },
			command: { list: async () => ({ data: [] }), transform: async (callback) => { await callback({ add: (command) => commands.push(command) }); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async (input) => { if (input.agent === "fusion-scout") { scoutEntered(); await scoutGate; return { output: { sessionID: "scout", status: "completed", output: "answer" } }; } return { output: { sessionID: "child", status: "completed", output: "done" } }; } }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		}, storage);
		await commands[0].execute({ sessionID: "one", prompt: { text: "Task" } });
		// Turn 1 leaves an undelivered nudge behind (transport down).
		await settle("evt-1", "Working.");
		expect(nudges).toHaveLength(0);
		// Turn 2 retries the nudge; its settlement write is gated mid-flight.
		gated = true;
		const turning = settle("evt-2", "Still working.");
		await new Promise((resolve) => setTimeout(resolve, 50));
		const scouting = tools.get("fusion_scout")!.execute({ questions: ["Where is the code?"] }, context("one"));
		await scoutStarted;
		// The interrupt queues behind the in-flight settlement: nothing settles
		// or delivers while the earlier settlement is still running.
		busQueue.push({ id: "evt-int", type: "session.execution.interrupted", data: { sessionID: "one" } });
		busWake?.();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content).runActive).toBe(true);
		finishScout();
		await scouting;
		// Work has resolved before the paused nudge write resumes.
		gated = false;
		failPrompt = false;
		gate();
		await turning;
		await new Promise((resolve) => setTimeout(resolve, 50));
		// The interrupt cancelled the pending nudge the moment it arrived; the
		// settlement that resumes from persistence must not deliver into the
		// cancelled turn.
		expect(nudges).toHaveLength(0);
		// The interrupt observed outstanding work, so recovery stays active even
		// though its pending continuation has been cancelled.
		expect(JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content).runActive).toBe(true);
		// The recorded cancellation is durable under the hold: storage carries
		// it, so a reload cannot revive the abandoned continuation.
		const persistedNudge = ((await storage.get(`run/${createHash("sha256").update("/workspace").digest("hex")}`)) as { adapterData?: { fusionNudge?: { state?: string } } } | undefined)?.adapterData?.fusionNudge?.state;
		expect(persistedNudge).toBe("cancelled");
		await tools.get("fusion_reset")!.execute({}, context("one"));
		// A reset during settlement: the resumed settlement aborts instead of
		// delivering a stale nudge or writing over the reset. The new run's fresh
		// budget nudges evt-3 normally.
		await commands[1].execute({ sessionID: "one", prompt: { text: "on" } });
		await commands[0].execute({ sessionID: "one", prompt: { text: "Next" } });
		await settle("evt-3", "Working.");
		expect(nudges).toHaveLength(1);
		failPrompt = true;
		gated = true;
		const staleTurn = settle("evt-4", "More.");
		await new Promise((resolve) => setTimeout(resolve, 50));
		await tools.get("fusion_reset")!.execute({}, context("one"));
		gated = false;
		gate();
		await staleTurn;
		await new Promise((resolve) => setTimeout(resolve, 50));
		// The stale settlement aborted: no stale nudge delivered, and the reset holds.
		expect(nudges).toHaveLength(1);
		expect((await tools.get("fusion_status")!.execute({}, context("one"))).content).toBe("No Fusion run in this session.");
	});

	test("settlement write failures are visible, retryable, and recover", async () => {
		const tools = new Map<string, Tool>();
		const backing = memoryStorage();
		let failPersist = false;
		const storage = { ...backing, set: async (key: string, value: unknown) => { if (failPersist) throw new Error("storage offline"); await backing.set(key, value); } };
		const busQueue: { id?: string; type: string; data?: Record<string, unknown> }[] = [];
		let busWake: (() => void) | undefined;
		let contextHook!: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void;
		const published: { description?: string }[] = [];
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { busWake = resolve; }); } } } } }) };
		const commands: CommandDefinition[] = [];
		const settle = async (id: string) => {
			contextHook({ agent: "fusion", tools: {}, sessionID: "one" });
			busQueue.push({ type: "session.execution.started", data: { sessionID: "one" } });
			busWake?.();
			busQueue.push({ id, type: "session.execution.succeeded", data: { sessionID: "one" } });
			busWake?.();
			await new Promise((resolve) => setTimeout(resolve, 25));
		};
		await setupTest({
			location: { directory: "/workspace" },
			event: eventHost,
			session: { context: async () => [], hook: async (_name: string, callback: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void) => { contextHook = callback; }, switchAgent: async () => {}, synthetic: async (input) => { published.push(input); } },
			command: { list: async () => ({ data: [] }), transform: async (callback) => { await callback({ add: (command) => commands.push(command) }); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }) }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		}, storage);
		// Runs start through the model-facing tool: this host has no prompt surface.
		await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
		// An interrupted turn whose settlement write fails: visible and retryable.
		failPersist = true;
		contextHook({ agent: "fusion", tools: {}, sessionID: "one" });
		busQueue.push({ id: "evt-int", type: "session.execution.interrupted", data: { sessionID: "one" } });
		busWake?.();
		await new Promise((resolve) => setTimeout(resolve, 25));
		let status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.settlementWrite).toBe("pending");
		expect(status.runActive).toBe(false);
		expect(published.some((entry) => entry.description?.startsWith("Fusion settlement issue\n"))).toBe(true);
		// The next settlement retries the write and recovers.
		failPersist = false;
		await settle("evt-next");
		status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.settlementWrite).toBe("saved");
		expect(published.filter((entry) => entry.description?.startsWith("Fusion settlement issue\n"))).toHaveLength(1);
	});

	test("the nudge budget survives a reload", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		const nudges: (string | undefined)[] = [];
		const busQueue: { id?: string; type: string; data?: Record<string, unknown> }[] = [];
		let busWake: (() => void) | undefined;
		let contextHook!: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void;
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { busWake = resolve; }); } } } } }) };
		const commands: CommandDefinition[] = [];
		const settle = async (text?: string) => {
			contextHook({ agent: "fusion", tools: {}, sessionID: "one" });
			busQueue.push({ type: "session.execution.started", data: { sessionID: "one" } });
			busWake?.();
			if (text !== undefined) { busQueue.push({ type: "session.text.ended", data: { sessionID: "one", text } }); busWake?.(); }
			busQueue.push({ type: "session.execution.succeeded", data: { sessionID: "one" } });
			busWake?.();
			await new Promise((resolve) => setTimeout(resolve, 25));
		};
		await setupTest({
			location: { directory: "/workspace" },
			event: eventHost,
			session: { context: async () => [], hook: async (_name: string, callback: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void) => { contextHook = callback; }, switchAgent: async () => {}, prompt: async (input) => { const value = input as { id?: string; text?: string }; if (value.id?.startsWith("msg_fusion_nudge")) nudges.push(value.text); } },
			command: { list: async () => ({ data: [] }), transform: async (callback) => { await callback({ add: (command) => commands.push(command) }); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }) }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		}, storage);
		await commands[1].execute({ sessionID: "one", prompt: { text: "on" } });
		await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
		await settle("Working.");
		await settle("Still working.");
		expect(nudges).toHaveLength(2);
		// Reload: the persisted budget holds, and the exhausted run reports incomplete.
		const reloaded: CommandDefinition[] = [];
		let reloadedContextHook!: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void;
		await setupTest({
			location: { directory: "/workspace" },
			event: eventHost,
			session: { context: async () => [], hook: async (_name: string, callback: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void) => { reloadedContextHook = callback; }, switchAgent: async () => {}, prompt: async (input) => { const value = input as { id?: string; text?: string }; if (value.id?.startsWith("msg_fusion_nudge")) nudges.push(value.text); } },
			command: { list: async () => ({ data: [] }), transform: async (callback) => { await callback({ add: (command) => reloaded.push(command) }); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }) }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		}, storage);
		reloadedContextHook({ agent: "fusion", tools: {}, sessionID: "one" });
		busQueue.push({ id: "evt-after-reload", type: "session.execution.succeeded", data: { sessionID: "one" } });
		busWake?.();
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(nudges).toHaveLength(2);
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.settleNudges).toBe(2);
		expect(status.incomplete).toBe(true);
	});

	test("registers native commands and /fusion-run delivers the supervisor prompt with a reusable message id", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		const commands: CommandDefinition[] = [];
		const prompts: { sessionID: string; text?: string }[] = [];
		const pushPrompt = (input: unknown) => { const value = input as { sessionID: string; text?: string }; prompts.push(value); };
		await setupTest({
			location: { directory: "/workspace" },
			session: { context: async () => [], hook: async () => {}, prompt: async (input: unknown) => { pushPrompt(input); } },
			command: { list: async () => ({ data: [] }), transform: async (callback) => { const editor = { add: (command: CommandDefinition) => { commands.push(command); } }; await callback(editor); } },
			tool: {
				hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }) }],
				transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
			},
		}, storage);
		expect(commands.map((command) => command.name)).toEqual(["fusion-run", "fusion-mode", "fusion-config", "fusion-budget", "fusion-status", "fusion-stats", "fusion-resume", "fusion-clean", "fusion-stop", "fusion-doctor"]);
		await expect(commands[0].execute({ sessionID: "one", prompt: { text: "  " } })).rejects.toThrow("Provide a task");
		await commands[0].execute({ sessionID: "one", prompt: { text: "Build the thing" } });
		expect(prompts).toHaveLength(1);
		expect(prompts[0].sessionID).toBe("one");
		expect(prompts[0].text).toContain("Build the thing");
		expect(prompts[0].text).toContain("Fusion supervisor");
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.originalTask).toBe("Build the thing");
		expect(status.runActive).toBe(true);
		expect(status.workspaceClaimed).toBe(true);
		await expect(commands[7].execute({ sessionID: "one" })).rejects.toThrow("run is still active");
		await expect(commands[0].execute({ sessionID: "one", prompt: { text: "Another" } })).rejects.toThrow("Finish and reset");
		// /fusion-status command reports the same payload as the tool.
		const commandStatus = JSON.parse(String(await commands[4].execute({ sessionID: "one" })));
		expect(commandStatus.originalTask).toBe("Build the thing");
		await tools.get("fusion_reset")!.execute({}, context("one"));
		// After reset the run is gone: /fusion can start the next one.
		await commands[0].execute({ sessionID: "one", prompt: { text: "Next run" } });
		expect(prompts).toHaveLength(2);
	});

	test("/fusion refuses honestly when the host cannot inject prompts", async () => {
		const commands: CommandDefinition[] = [];
		await setupTest({
			location: { directory: tmpdir() },
			session: { context: async () => [], hook: async () => {} },
			command: { list: async () => ({ data: [] }), transform: async (callback) => { const editor = { add: (command: CommandDefinition) => { commands.push(command); } }; await callback(editor); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({}) }], transform: async () => {} },
		});
		await expect(commands[0].execute({ sessionID: "one", prompt: { text: "task" } })).rejects.toThrow("cannot inject the run prompt");
	});

	test("run command selects the Fusion agent and retries uncertain delivery with the same message ID after reload", async () => {
		const storage = memoryStorage();
		const tools = new Map<string, Tool>();
		const messages: { id?: string; text?: string }[] = [];
		const selections: string[] = [];
		let fail = true;
		const makeContext = (commands: CommandDefinition[]): TestContext => ({
			location: { directory: "/workspace" },
			session: { context: async () => [], hook: async () => {}, switchAgent: async ({ agent }) => { selections.push(agent); }, prompt: async (input) => {
				messages.push(input);
				if (fail) { fail = false; throw new Error("response lost after admission"); }
			} },
			command: { list: async () => ({ data: [] }), transform: async (callback) => { callback({ add: (command) => { commands.push(command); } }); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({}) }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		});
		const first: CommandDefinition[] = [];
		await setupTest(makeContext(first), storage);
		await expect(first[0].execute({ sessionID: "one", prompt: { text: "Build it" } })).rejects.toThrow("Retry /fusion-run with the same task");
		await expect(tools.get("fusion_reset")!.execute({}, context("one"))).rejects.toThrow("delivery is unconfirmed");
		expect(JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content).promptDelivery).toBe("pending");
		const second: CommandDefinition[] = [];
		await setupTest(makeContext(second), storage);
		await expect(second[0].execute({ sessionID: "one", prompt: { text: "Different task" } })).rejects.toThrow("Finish and reset");
		await second[0].execute({ sessionID: "one", prompt: { text: "Build it" } });
		expect(selections).toEqual(["fusion", "fusion"]);
		expect(messages).toHaveLength(2);
		expect(messages[0].id).toBeString();
		expect(messages[1]).toEqual(messages[0]);
	});

	test("status and stats commands publish their results without resuming the model", async () => {
		const commands: CommandDefinition[] = [];
		const published: { sessionID: string; text: string; description?: string; resume?: boolean }[] = [];
		await setupTest({ location: { directory: "/workspace" }, session: { context: async () => [], hook: async () => {}, synthetic: async (input) => { published.push(input); } },
			command: { list: async () => ({ data: [] }), transform: async (callback) => { callback({ add: (command) => { commands.push(command); } }); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({}) }], transform: async () => {} },
		});
		const byName = (name: string) => commands.find((command) => command.name === name)!;
		await byName("fusion-status").execute({ sessionID: "one" });
		await byName("fusion-stats").execute({ sessionID: "one" });
		expect(published).toEqual([{ sessionID: "one", description: "Fusion status\nNo Fusion run in this session.", text: "No Fusion run in this session.", resume: false }, { sessionID: "one", description: "Fusion stats\nNo Fusion run in this session.", text: "No Fusion run in this session.", resume: false }]);
	});

	test("/fusion-mode shows the current mode without arguments and status carries it", async () => {
		const commands: CommandDefinition[] = [];
		const tools = new Map<string, Tool>();
		const published: { sessionID: string; text: string; description?: string; resume?: boolean }[] = [];
		const storage = memoryStorage();
		await setupTest({ location: { directory: "/workspace" }, session: { context: async () => [], hook: async () => {}, synthetic: async (input) => { published.push(input); } },
			command: { list: async () => ({ data: [] }), transform: async (callback) => { callback({ add: (command) => { commands.push(command); } }); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }) }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		}, storage);
		const mode = commands.find((command) => command.name === "fusion-mode")!;
		expect(mode).toBeTruthy();
		// No argument is read-only: reports the default without touching storage.
		await mode.execute({ sessionID: "one", prompt: { text: "" } });
		expect(String(published.at(-1)!.description)).toContain("Fusion mode");
		expect(published.at(-1)!.text).toContain("Fusion persistent mode is off.");
		expect(published.at(-1)!.text).toContain("Fusion tools require an active run; /fusion-run starts one.");
		expect(published.at(-1)!.text).toContain("Usage: /fusion-mode <on|off>.");
		expect(await storage.get("fusion-mode")).toBeUndefined();
		await expect(mode.execute({ sessionID: "one", prompt: { text: "maybe" } })).rejects.toThrow("Use /fusion-mode, /fusion-mode on, or /fusion-mode off.");
		await mode.execute({ sessionID: "one", prompt: { text: "on" } });
		expect(published.at(-1)!.text).toContain("Fusion persistent mode enabled");
		await mode.execute({ sessionID: "one", prompt: { text: "" } });
		expect(published.at(-1)!.text).toContain("Fusion persistent mode is on.");
		expect(await storage.get("fusion-mode")).toBe(true);
		// The run status report carries the mode alongside the run state.
		await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.fusionMode).toBe("on");
	});

	test("persistent mode gates fusion tools per session until a run is active", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		let commandTransform!: (editor: { add: (command: CommandDefinition) => void }) => Promise<void>;
		let contextHook!: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void;
		let commands: CommandDefinition[] = [];
		const reportBlock = '```json\n{"status":"done","summary":"ok","checks":[],"files_changed":[],"blockers":[]}\n```';
		const base = () => ({
			location: { directory: "/workspace" },
			session: { context: async () => [], hook: async (_name: string, callback: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void) => { contextHook = callback; }, prompt: async () => {} },
			command: { list: async () => ({ data: [] }), transform: async (callback: (editor: { add: (command: CommandDefinition) => void }) => Promise<void>) => { commandTransform = callback; } },
			tool: {
				hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: reportBlock } }) }],
				transform: async (callback: (editor: { add: (tool: Tool) => void }) => void) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
			},
		});
		await setupTest(base() as TestContext, storage);
		await commandTransform({ add: (command) => { commands.push(command); } });
		const fusionTools = () => { const record: Record<string, unknown> = { fusion_start: {}, fusion_delegate: {}, fusion_scout: {}, fusion_reconcile: {}, fusion_reset: {}, fusion_configure: {}, fusion_status: {}, fusion_stats: {}, read: {} }; contextHook({ agent: "fusion", tools: record, sessionID: "one" }); return record; };
		// Mode off by default: a session without an active run loses mutation tools.
		let record = fusionTools();
		expect(record).not.toHaveProperty("fusion_start");
		expect(record).not.toHaveProperty("fusion_delegate");
		expect(record).toHaveProperty("fusion_status");
		expect(record).toHaveProperty("fusion_stats");
		expect(record).toHaveProperty("read");
		// Other agents must not discover tools that requireSupervisor rejects.
		const buildRecord: Record<string, unknown> = { fusion_delegate: {}, read: {} };
		contextHook({ agent: "build", tools: buildRecord, sessionID: "one" });
		expect(buildRecord).not.toHaveProperty("fusion_delegate");
		expect(buildRecord).toHaveProperty("read");
		// /fusion starts the run: tools become visible for that session.
		await commands[0].execute({ sessionID: "one", prompt: { text: "Build it" } });
		record = fusionTools();
		expect(record).toHaveProperty("fusion_delegate");
		// Mode on: visible even without an active run; the toggle persists.
		await commands[1].execute({ sessionID: "one", prompt: { text: "on" } });
		await tools.get("fusion_reset")!.execute({}, context("one"));
		record = fusionTools();
		expect(record).toHaveProperty("fusion_start");
		const configCommand = commands.find((command) => command.name === "fusion-config")!;
		const diagnostic = await configCommand.execute({ sessionID: "one" });
		expect(diagnostic).toContain("Fusion mode: on.");
		expect(diagnostic).toContain("Last Fusion context hook: agent=fusion;");
		expect(diagnostic).toContain("fusion_start");
		// Reload: the persisted mode survives, and the new instance's toggle owns it now.
		await setupTest(base() as TestContext, storage);
		const commandsAfterReload: CommandDefinition[] = [];
		await commandTransform({ add: (command) => { commandsAfterReload.push(command); } });
		record = fusionTools();
		expect(record).toHaveProperty("fusion_start");
		// Mode off again hides them.
		await commandsAfterReload[1].execute({ sessionID: "one", prompt: { text: "off" } });
		record = fusionTools();
		expect(record).not.toHaveProperty("fusion_start");
	});

	test("fusion-clean refuses an unsettled foreign record", async () => {
		const root = await mkdtemp(join(tmpdir(), "fusion-plugin-clean-"));
		const storage = memoryStorage();
		const tools = new Map<string, Tool>();
		let failNative = false;
		const makeContext = (capture: CommandDefinition[]) => ({
			location: { directory: root },
			session: { context: async () => [], hook: async () => {}, prompt: async () => {}, get: async ({ sessionID: id }: { sessionID: string }) => ({ id, location: { directory: root } }) },
			command: { list: async () => ({ data: [] }), transform: async (callback: (editor: { add: (command: CommandDefinition) => void }) => unknown) => { await callback({ add: (command) => capture.push(command) }); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => { if (failNative) throw new Error("connection lost"); return { output: { sessionID: "child", status: "completed", output: "done" } }; } }], transform: async (callback: (editor: { add: (tool: Tool) => void }) => void) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		});
		let host: { close(): void } | undefined;
		try {
			// Instance A owns the run as session "A"; a failed delegation leaves the record pending.
			const commandsA: CommandDefinition[] = [];
			host = await setupTest(makeContext(commandsA) as TestContext, storage);
			await commandsA[0].execute({ sessionID: "A", prompt: { text: "Task" } });
			failNative = true;
			await expect(tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("A"))).rejects.toThrow("connection lost");
			// Instance B adopts the pending record; clean from B's own session refuses it.
			host.close(); host = undefined;
			failNative = false;
			const commandsB: CommandDefinition[] = [];
			let cleanB: ((args: { sessionID: string }) => unknown) | undefined;
			host = await setupTest({ ...makeContext(commandsB), command: { list: async () => ({ data: [] }), transform: async (callback: (editor: { add: (command: CommandDefinition) => void }) => unknown) => { await callback({ add: (command) => { commandsB.push(command); if (command.name === "fusion-clean") cleanB = command.execute; } }); } } } as TestContext, storage);
			await expect(cleanB!({ sessionID: "B" })).rejects.toThrow("is pending; reconcile it or run the explicit operator resolution");
			host.close(); host = undefined;
		} finally { host?.close(); await rm(root, { recursive: true, force: true }); }
	});

	test("fusion-clean refuses a foreign run that is active between worker turns", async () => {
		const root = await mkdtemp(join(tmpdir(), "fusion-plugin-clean-settled-"));
		const storage = memoryStorage();
		const tools = new Map<string, Tool>();
		const makeContext = (capture: CommandDefinition[]) => ({
			location: { directory: root },
			session: { context: async () => [], hook: async () => {}, prompt: async () => {}, get: async ({ sessionID: id }: { sessionID: string }) => ({ id, location: { directory: root } }) },
			command: { list: async () => ({ data: [] }), transform: async (callback: (editor: { add: (command: CommandDefinition) => void }) => unknown) => { await callback({ add: (command) => capture.push(command) }); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }) }], transform: async (callback: (editor: { add: (tool: Tool) => void }) => void) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		});
		let host: { close(): void } | undefined;
		let runId: string | undefined;
		try {
			const commandsA: CommandDefinition[] = [];
			host = await setupTest(makeContext(commandsA) as TestContext, storage);
			// fusion_start persists a settled record (no executor work yet).
			await commandsA[0].execute({ sessionID: "A", prompt: { text: "Task" } });
			const ownedStatus = JSON.parse((await tools.get("fusion_status")!.execute({}, context("B"))).content);
			expect(ownedStatus.recovery).toBe("settled");
			runId = ownedStatus.runId;
			await expect(commandsA.find((command) => command.name === "fusion-clean")!.execute({ sessionID: "B" })).rejects.toThrow("still active");
			expect(JSON.parse((await tools.get("fusion_status")!.execute({}, context("A"))).content).workspaceClaimed).toBe(true);
			// Instance B adopts the record, but the supervisor run is still active.
			host.close(); host = undefined;
			const commandsB: CommandDefinition[] = [];
			let cleanB: ((args: { sessionID: string }) => unknown) | undefined;
			host = await setupTest({ ...makeContext(commandsB), command: { list: async () => ({ data: [] }), transform: async (callback: (editor: { add: (command: CommandDefinition) => void }) => unknown) => { await callback({ add: (command) => { commandsB.push(command); if (command.name === "fusion-clean") cleanB = command.execute; } }); } } } as TestContext, storage);
			await expect(cleanB!({ sessionID: "B" })).rejects.toThrow("still active");
			const retained = JSON.parse((await tools.get("fusion_status")!.execute({}, context("A"))).content);
			expect(retained.workspaceClaimed).toBe(true);
			expect(runId).toBeString();
		} finally { host?.close(); await rm(root, { recursive: true, force: true }); }
	});

	test("configures a catalog-validated executor model that reaches scout and executor submissions", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		const nativeInputs: { agent?: string; model?: string }[] = [];
		const executorReport = '```json\n{"status":"done","summary":"ok","checks":[],"files_changed":[],"blockers":[]}\n```';
		const catalog = { list: async () => ({ data: [
			{ providerID: "prov", id: "executor-model", name: "Executor Model", status: "active", enabled: true, variants: [{ id: "low" }, { id: "high" }], cost: [{ input: 1, output: 3 }], time: { released: 1750000000000 } },
			{ providerID: "prov", id: "no-variants", name: "No Variants", status: "active", enabled: true, cost: [{ output: 20 }] },
			{ providerID: "other", id: "disabled-model", name: "Disabled", status: "active", enabled: false, cost: [] },
		] }) };
		const makeContext = (): TestContext => ({ location: { directory: "/workspace" }, model: catalog, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async () => {}, list: async () => [{ id: "subagent", execute: async (input) => {
				nativeInputs.push({ agent: input.agent, model: input.model });
				return { output: { sessionID: input.agent === "fusion-scout" ? "scout" : "child", status: "completed", output: input.agent === "fusion-scout" ? "answer" : executorReport } };
			} }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		await setupTest(makeContext(), storage);
		const configure = tools.get("fusion_configure")!;
		await expect(configure.execute({ provider: "prov", model: "missing-model" }, context("one"))).rejects.toThrow("not in the OpenCode model catalog");
		await expect(configure.execute({ provider: "prov", model: "executor-model", variant: "turbo" }, context("one"))).rejects.toThrow('has no variant "turbo"');
		await expect(configure.execute({ provider: "prov", model: "no-variants", variant: "low" }, context("one"))).rejects.toThrow("no variants");
		await expect(configure.execute({ provider: "other", model: "disabled-model" }, context("one"))).rejects.toThrow("disabled");
		await expect(configure.execute({ provider: "prov", model: "executor-model" }, context("one", "fusion-executor"))).rejects.toThrow("only to the fusion primary agent");
		// Valid configuration: applies to this run, shared tier/cohort metadata is reported.
		const configured = await configure.execute({ provider: "prov", model: "executor-model", variant: "low" }, context("one"));
		expect(configured.metadata).toMatchObject({ applied: "now", model: { provider: "prov", modelId: "executor-model", variant: "low" }, tier: "executor", outputPricePerM: 3 });
		// The scout picks up the configured model with its variant immediately.
		const scout = await tools.get("fusion_scout")!.execute({ questions: ["q"] }, context("one"));
		expect(scout.content).toContain("answer");
		expect(nativeInputs[0]).toEqual({ agent: "fusion-scout", model: "prov/executor-model#low" });
		// The executor delegation uses the same configured model.
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		expect(nativeInputs[1]).toEqual({ agent: "fusion-executor", model: "prov/executor-model#low" });
		// The configuration persists in the shared manifest.
		const persisted = await storage.get(`run/${createHash("sha256").update("/workspace").digest("hex")}`) as { model?: { provider?: string; modelId?: string; variant?: string } };
		expect(persisted.model).toEqual({ provider: "prov", modelId: "executor-model", variant: "low" });
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.model).toEqual({ provider: "prov", modelId: "executor-model", variant: "low" });
		// Reconfiguration after executor work applies to the next run only.
		const later = await configure.execute({ provider: "prov", model: "no-variants" }, context("one"));
		expect(later.metadata).toMatchObject({ applied: "next-run" });
		expect(JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content).model.modelId).toBe("executor-model");
		await setupTest(makeContext(), storage);
		await tools.get("fusion_delegate")!.execute({ action: "revise", brief: "fix" }, context("one"));
		expect(nativeInputs[2]).toEqual({ agent: "fusion-executor", model: "prov/executor-model#low" });
		await tools.get("fusion_reset")!.execute({}, context("one"));
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "next run" }, context("one"));
		expect(nativeInputs[3]).toEqual({ agent: "fusion-executor", model: "prov/no-variants" });
	});

	test("configure without a host catalog refuses honestly and fusion tools stay on host defaults", async () => {
		const tools = new Map<string, Tool>();
		let modelSeen = false;
		const reportBlock = '```json\n{"status":"done","summary":"ok","checks":[],"files_changed":[],"blockers":[]}\n```';
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async () => {}, list: async () => [{ id: "subagent", execute: async (input) => {
				modelSeen = input.model !== undefined && input.model !== null;
				return { output: { sessionID: "child", status: "completed", output: reportBlock } };
			} }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		await expect(tools.get("fusion_configure")!.execute({ provider: "prov", model: "m" }, context("one"))).rejects.toThrow("model catalog is unavailable");
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		// Without configuration no model override reaches the native call.
		expect(modelSeen).toBe(false);
	});

	test("configuration blocks new work until its model choice is saved", async () => {
		const tools = new Map<string, Tool>();
		const backing = memoryStorage();
		let release!: () => void, entered!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const waiting = new Promise<void>((resolve) => { entered = resolve; });
		const storage = { ...backing, set: async (key: string, value: unknown) => { if (key.startsWith("model/")) { entered(); await gate; } await backing.set(key, value); } };
		await setupTest({ location: { directory: "/workspace" }, model: { list: async () => ({ data: [{ providerID: "prov", id: "model", enabled: true }] }) },
			session: { context: async () => [], hook: async () => {} }, tool: {
				hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => { throw new Error("unexpected submission"); } }],
				transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
			},
		}, storage);
		const configure = tools.get("fusion_configure")!.execute({ provider: "prov", model: "model" }, context("one"));
		await waiting;
		await expect(tools.get("fusion_delegate")!.execute({ action: "execute", brief: "work" }, context("one"))).rejects.toThrow("configuration is in progress");
		await expect(tools.get("fusion_reset")!.execute({}, context("one"))).rejects.toThrow("configuration is in progress");
		release();
		await configure;
	});

	test("persists the original request before delegation and retains it through the final fix after reload", async () => {
		const storage = memoryStorage();
		const prompts: string[] = [];
		const makeContext = (tools: Map<string, Tool>): TestContext => ({
			location: { directory: "/workspace" }, session: { context: async () => [], hook: async () => {} }, tool: {
				hook: async () => {}, list: async () => [{ id: "subagent", execute: async (input) => {
					prompts.push(input.prompt);
					return { output: { sessionID: "child-1", status: "completed", output: "done" } };
				} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
			},
		});
		const first = new Map<string, Tool>();
		await setupTest(makeContext(first), storage);
		await expect(first.get("fusion_start")!.execute({ task: "Original acceptance requirements" }, context("other-agent", "ordinary"))).rejects.toThrow("only to the fusion primary agent");
		await first.get("fusion_start")!.execute({ task: "Original acceptance requirements" }, context("one"));
		const restored = new Map<string, Tool>();
		await setupTest(makeContext(restored), storage);
		const status = JSON.parse((await restored.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.originalTask).toBe("Original acceptance requirements");
		expect(status.nextAction).toContain("action execute");
		expect(status.capabilities.activeTurnReattach).toBe(false);
		await expect(restored.get("fusion_delegate")!.execute({ action: "execute", brief: "Implement", originalTask: "replacement" }, context("one"))).rejects.toThrow("cannot be replaced");
		await restored.get("fusion_delegate")!.execute({ action: "execute", brief: "Implement" }, context("one"));
		await restored.get("fusion_delegate")!.execute({ action: "final_fix", brief: "Fix remaining gaps" }, context("one"));
		expect(prompts[1]).toContain("Original acceptance requirements");
		const stats = JSON.parse((await restored.get("fusion_stats")!.execute({}, context("one"))).content);
		expect(stats).toMatchObject({ executed: true, revisions: { used: 0, limit: 3 }, scoutCalls: { used: 0, limit: 4 }, finalFixUsed: true, lastResult: { status: "completed" }, usage: { available: false } });
		await expect(restored.get("fusion_stats")!.execute({}, context("one", "ordinary"))).rejects.toThrow("only to the fusion primary agent");
		await expect(restored.get("fusion_start")!.execute({ task: "Another task" }, context("one"))).rejects.toThrow("reset the existing Fusion run");
		await restored.get("fusion_reset")!.execute({}, context("one"));
		await restored.get("fusion_start")!.execute({ task: "Another task" }, context("one"));
	});

	test("blocks new work and reset while a run start is being persisted", async () => {
		const tools = new Map<string, Tool>();
		const backing = memoryStorage();
		let release!: () => void;
		let entered!: () => void;
		const enteredWrite = new Promise<void>((resolve) => { entered = resolve; });
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const storage = { ...backing, set: async (key: string, value: unknown) => { entered(); await gate; await backing.set(key, value); } };
		await setupTest({ location: { directory: "/workspace" }, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => { throw new Error("unexpected submission"); } }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} }, storage);
		const start = tools.get("fusion_start")!.execute({ task: "Original task" }, context("one"));
		await enteredWrite;
		await expect(tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"))).rejects.toThrow("run is starting");
		await expect(tools.get("fusion_scout")!.execute({ questions: ["where?"] }, context("one"))).rejects.toThrow("run is starting");
		await expect(tools.get("fusion_reset")!.execute({}, context("one"))).rejects.toThrow("run is starting");
		release();
		await start;
	});

	test("rejects a run start for a session outside the workspace without claiming ownership", async () => {
		const tools = new Map<string, Tool>();
		await setupTest({ location: { directory: "/workspace" }, session: {
			context: async () => [], hook: async () => {}, get: async ({ sessionID }) => ({ id: sessionID, location: { directory: "/other" } }),
		}, tool: {
			hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => { throw new Error("unexpected submission"); } }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		await expect(tools.get("fusion_start")!.execute({ task: "task" }, context("one"))).rejects.toThrow("session or workspace does not match");
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.runActive).toBe(false);
		expect(status.originalTask).toBeUndefined();
	});

	test("reset holds workspace ownership until storage removal finishes", async () => {
		const tools = new Map<string, Tool>();
		const backing = memoryStorage();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let hold = true;
		const storage = { ...backing, remove: async (key: string) => { if (hold) await gate; await backing.remove(key); } };
		let calls = 0;
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => {
				calls++;
				return { output: { sessionID: `child-${calls}`, status: "completed", output: "done" } };
			} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} }, storage);
		const delegate = tools.get("fusion_delegate")!;
		const reset = tools.get("fusion_reset")!;
		await delegate.execute({ action: "execute", brief: "build" }, context("one"));
		const deleting = reset.execute({}, context("one"));
		await expect(delegate.execute({ action: "revise", brief: "fix" }, context("one"))).rejects.toThrow("reset is in progress");
		await expect(delegate.execute({ action: "execute", brief: "other" }, context("two"))).rejects.toThrow("reset is in progress");
		await expect(reset.execute({}, context("one"))).rejects.toThrow("reset is in progress");
		expect(calls).toBe(1);
		hold = false; release();
		await deleting;
		await delegate.execute({ action: "execute", brief: "other" }, context("two"));
		expect(calls).toBe(2);
	});

	test("a failed reset keeps the owner and permits a later retry", async () => {
		const tools = new Map<string, Tool>();
		const backing = memoryStorage();
		let fail = true;
		const storage = { ...backing, remove: async (key: string) => {
			if (fail) { fail = false; throw new Error("remove failed"); }
			await backing.remove(key);
		} };
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }) }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} }, storage);
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		await expect(tools.get("fusion_reset")!.execute({}, context("one"))).rejects.toThrow("remove failed");
		await expect(tools.get("fusion_delegate")!.execute({ action: "execute", brief: "other" }, context("two"))).rejects.toThrow("owns this workspace");
		await expect(tools.get("fusion_reset")!.execute({}, context("one"))).resolves.toHaveProperty("content", "Fusion run reset.");
	});

	test("preserves pending work when saving a completed turn fails", async () => {
		const backing = memoryStorage();
		let failSettlement = false;
		let messages: unknown[] = [];
		let description = "";
		let calls = 0;
		const storage = { ...backing, set: async (key: string, value: unknown) => {
			if (failSettlement && !(value as { pending?: unknown }).pending) {
				failSettlement = false;
				throw new Error("settlement write failed");
			}
			await backing.set(key, value);
		} };
		const makeContext = (tools: Map<string, Tool>): TestContext => ({
			location: { directory: tmpdir() }, session: { context: async () => messages, hook: async () => {} }, tool: {
				hook: async () => {}, list: async () => [{ id: "subagent", execute: async (input, ctx) => {
					calls++;
					await ctx.progress({ sessionID: "child" });
					if (calls === 1) { description = input.description; failSettlement = true; }
					return { output: { sessionID: "child", status: "completed", output: "done" } };
				} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
			},
		});
		const first = new Map<string, Tool>();
		await setupTest(makeContext(first), storage);
		await expect(first.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"))).rejects.toThrow("settlement write failed");
		await expect(first.get("fusion_reset")!.execute({}, context("one"))).rejects.toThrow("uncertain");
		const restored = new Map<string, Tool>();
		await setupTest(makeContext(restored), storage);
		await expect(restored.get("fusion_delegate")!.execute({ action: "revise", brief: "fix" }, context("one"))).rejects.toThrow("unknown outcome");
		messages = [{ type: "synthetic", description, metadata: { source: "subagent", childID: "child", agent: "fusion-executor", state: "completed" }, text: `<subagent sessionID="child" state="completed" description="${description}">\ndone\n</subagent>` }];
		await restored.get("fusion_reconcile")!.execute({}, context("one"));
		await restored.get("fusion_delegate")!.execute({ action: "revise", brief: "fix" }, context("one"));
		expect(calls).toBe(2);
	});

	test("retries a revision after confirmed pre-submission storage failure", async () => {
		const tools = new Map<string, Tool>();
		const backing = memoryStorage();
		let failNext = false;
		const storage = { ...backing, set: async (key: string, value: unknown) => {
			if (failNext) { failNext = false; throw new Error("temporary storage failure"); }
			await backing.set(key, value);
		} };
		let calls = 0;
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => {
				calls++;
				return { output: { sessionID: "child", status: "completed", output: "done" } };
			} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} }, storage);
		const delegate = tools.get("fusion_delegate")!;
		await delegate.execute({ action: "execute", brief: "build" }, context("one"));
		failNext = true;
		await expect(delegate.execute({ action: "revise", brief: "fix" }, context("one"))).rejects.toThrow("temporary storage failure");
		expect(calls).toBe(1);
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.revisions).toBe(0);
		expect(status.phase).toBe("failed");
		expect(status.uncertain).toBe(false);
		await delegate.execute({ action: "revise", brief: "fix" }, context("one"));
		expect(calls).toBe(2);
	});

	test("does not submit work when the pending record cannot be saved", async () => {
		const tools = new Map<string, Tool>();
		let calls = 0;
		const storage = { get: async () => undefined, set: async () => { throw new Error("storage unavailable"); }, remove: async () => {} };
		await setupTest({ location: { directory: "/workspace" }, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => { calls++; return { output: {} }; } }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} }, storage);
		await expect(tools.get("fusion_delegate")!.execute({ action: "execute", brief: "work" }, context("one"))).rejects.toThrow("storage unavailable");
		expect(calls).toBe(0);
		await expect(tools.get("fusion_reset")!.execute({}, context("one"))).rejects.toThrow("uncertain");
	});

	test("restores a pending turn after reload and requires its own completion before continuing", async () => {
		const storage = memoryStorage();
		let description = "";
		let messages: unknown[] = [];
		const calls: Record<string, unknown>[] = [];
		const makeContext = (tools: Map<string, Tool>): TestContext => ({
			location: { directory: "/workspace" }, session: { context: async () => messages, hook: async () => {} }, tool: {
				hook: async () => {}, list: async () => [{ id: "subagent", execute: async (input, ctx) => {
					calls.push({ ...input });
					await ctx.progress({ sessionID: "child-1" });
					if (calls.length === 1) { description = input.description; throw new Error("connection lost"); }
					return { output: { sessionID: "child-1", status: "completed", output: "fixed" } };
				} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
			},
		});
		const first = new Map<string, Tool>();
		await setupTest(makeContext(first), storage);
		await expect(first.get("fusion_delegate")!.execute({ action: "execute", brief: "build", originalTask: "original" }, context("one"))).rejects.toThrow("connection lost");
		const failedStatus = JSON.parse((await first.get("fusion_status")!.execute({}, context("one"))).content);
		expect(failedStatus.phase).toBe("failed");
		expect(failedStatus.uncertain).toBe(true);
		expect(failedStatus.pending.requestId).toBe(description);
		expect(failedStatus.owner.supervisorId).toBe("one");
		expect(failedStatus.runId).toBeString();
		const restored = new Map<string, Tool>();
		await setupTest(makeContext(restored), storage);
		await expect(restored.get("fusion_delegate")!.execute({ action: "execute", brief: "retry" }, context("one"))).rejects.toThrow("unknown outcome");
		await expect(restored.get("fusion_delegate")!.execute({ action: "execute", brief: "other" }, context("two"))).rejects.toThrow("owns this workspace");
		await expect(restored.get("fusion_reconcile")!.execute({}, context("one"))).rejects.toThrow("No matching completion");
		messages = [{ type: "synthetic", description, metadata: { source: "subagent", childID: "child-1", agent: "fusion-executor", state: "completed" }, text: `<subagent sessionID="child-1" state="completed" description="${description}">\nfinished\n</subagent>` }];
		expect((await restored.get("fusion_reconcile")!.execute({}, context("one"))).content).toContain("finished");
		await restored.get("fusion_delegate")!.execute({ action: "revise", brief: "fix" }, context("one"));
		expect(calls[1].sessionID).toBe("child-1");
		expect((await restored.get("fusion_status")!.execute({}, context("one"))).content).toContain("original");
		await restored.get("fusion_reset")!.execute({}, context("one"));
		const afterReset = new Map<string, Tool>();
		await setupTest(makeContext(afterReset), storage);
		expect((await afterReset.get("fusion_status")!.execute({}, context("one"))).content).toContain("No Fusion run");
	});
	test("fusion_resume routes recovery honestly for every run condition", async () => {
		// Uncertain run with a retained write-ahead intent but no live turn and
		// no recorded result: reconciliation is unavailable; operator resolution
		// is documented textually.
		{
			const tools = new Map<string, Tool>();
			await setupTest({ location: { directory: "/workspace" }, session: { context: async () => [], hook: async () => {} }, tool: {
				hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => { throw new Error("must not be called"); } }],
				transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
			} }, { get: async () => undefined, set: async () => { throw new Error("storage unavailable"); }, remove: async () => {} });
			await expect(tools.get("fusion_delegate")!.execute({ action: "execute", brief: "work" }, context("one"))).rejects.toThrow("storage unavailable");
			const resume = JSON.parse((await tools.get("fusion_resume")!.execute({}, context("one"))).content);
			expect(resume.reconcile).toBe("unavailable");
			expect(resume.reconcileDetail).toContain("no live turn and no recorded result");
			expect(resume.pendingRequest?.requestId).toBeString();
			expect(resume.owner.supervisorId).toBe("one");
			expect(resume.guidedRecovery).toMatchObject({ action: "resolve", category: "operator-resolution", confirmationRequired: true });
			expect(resume.nextAction).toContain(RESOLVE_ENTRY);
			expect(resume.nextAction).toContain(resume.pendingRequest?.requestId as string);
			expect(resume.nextAction).toContain("--confirm-stopped");
			// Every suggested shell argument is single-quoted: request ids carry
			// spaces ("Fusion execute <uuid>"), so the raw form would split and
			// fail resolve.ts argument validation.
			expect(resume.nextAction).toContain(`'${resume.pendingRequest?.requestId as string}'`);
			expect(resume.nextAction).toContain(`'${"/workspace"}'`);
			expect(resume.activeTurnReattach).toBe("refused");
		}
		// A failed executor submission leaves the turn pending on its completion
		// notification: exact proof can exist and fusion_reconcile is the route,
		// across a reload too, with operator resolution documented as fallback.
		{
			const tools = new Map<string, Tool>();
			const storage = memoryStorage();
			let messages: unknown[] = [];
			let description = "";
			const makeContext = (fresh: Map<string, Tool>): TestContext => ({
				location: { directory: "/workspace" }, session: { context: async () => messages, hook: async () => {} }, tool: {
					hook: async () => {}, list: async () => [{ id: "subagent", execute: async (input, ctx) => {
						await ctx.progress({ sessionID: "child-r" });
						description = input.description;
						throw new Error("connection lost");
					} }], transform: async (callback) => { callback({ add: (tool) => fresh.set(tool.name, tool) }); },
				},
			});
			await setupTest(makeContext(tools), storage);
			await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
			let resume = JSON.parse((await tools.get("fusion_resume")!.execute({}, context("one"))).content);
			expect(resume.reconcile).toBe("unavailable");
			expect(resume.guidedRecovery).toMatchObject({ action: "continue", category: "none", confirmationRequired: false });
			expect(resume.nextAction).toContain("No recovery is owed");
			await expect(tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"))).rejects.toThrow("connection lost");
			resume = JSON.parse((await tools.get("fusion_resume")!.execute({}, context("one"))).content);
			expect(resume.reconcile).toBe("available");
			expect(resume.guidedRecovery).toMatchObject({ action: "reconcile", category: "adopt-result", confirmationRequired: true });
			expect(resume.pendingRequest?.requestId).toBe(description);
			expect(resume.outstanding.backgroundPending).toBe(true);
			expect(resume.childSessionID).toBe("child-r");
			expect(resume.nextAction).toContain("Call fusion_reconcile");
			const restored = new Map<string, Tool>();
			await setupTest(makeContext(restored), storage);
			resume = JSON.parse((await restored.get("fusion_resume")!.execute({}, context("one"))).content);
			expect(resume.reconcile).toBe("available");
			expect(resume.pendingRequest?.requestId).toBe(description);
			expect(resume.nextAction).toContain("If it reports no matching notification");
			expect(resume.nextAction).toContain("--confirm-stopped");
			expect(resume.activeTurnReattach).toBe("refused");
			expect(resume.reattachReason).toContain("cannot reattach");
			// Once the recorded notification exists, reconcile adopts it and the
			// run owes no recovery again.
			messages = [{ type: "synthetic", description, metadata: { source: "subagent", childID: "child-r", agent: "fusion-executor", state: "completed" }, text: `<subagent sessionID="child-r" state="completed" description="${description}">\nfixed\n</subagent>` }];
			expect((await restored.get("fusion_reconcile")!.execute({}, context("one"))).content).toContain("fixed");
			resume = JSON.parse((await restored.get("fusion_resume")!.execute({}, context("one"))).content);
			expect(resume.reconcile).toBe("unavailable");
			expect(resume.guidedRecovery).toMatchObject({ action: "continue", category: "none" });
			expect(resume.nextAction).toContain("No recovery is owed");
		}
		// Healthy ephemeral experiment: a scout-only run (no workspace claim) still
		// presents recovery state and never implies reattachment.
		{
			const tools = new Map<string, Tool>();
			await setupTest({ location: { directory: "/workspace" }, session: { context: async () => [], hook: async () => {} }, tool: {
				hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "answer" } }) }],
				transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
			} });
			await tools.get("fusion_scout")!.execute({ questions: ["Where?"] }, context("one"));
			const resume = JSON.parse((await tools.get("fusion_resume")!.execute({}, context("one"))).content);
			expect(resume.uncertain).toBe(false);
			expect(resume.reconcile).toBe("unavailable");
			expect(resume.reconcileDetail).toContain("nothing is unsettled");
			expect(resume.activeTurnReattach).toBe("refused");
			expect(resume.guidedRecovery).toMatchObject({ action: "continue", category: "none" });
			expect(resume.nextAction).toContain("No recovery is owed");
		}
	});
	test("guided recovery derives one action across status, resume, and the host UIs", async () => {
		// (1) An incomplete protocol routes to the operator decision, the same
		// on both surfaces.
		{
			const tools = new Map<string, Tool>();
			const nudges: (string | undefined)[] = [];
			const busQueue: { type: string; data?: Record<string, unknown> }[] = [];
			let busWake: (() => void) | undefined;
			let contextHook!: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void;
			const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { busWake = resolve; }); } } } } }) };
			await setupTest({
				location: { directory: "/workspace" },
				event: eventHost,
				session: { context: async () => [], hook: async (_name: string, callback: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void) => { contextHook = callback; }, prompt: async (input) => { nudges.push((input as { text?: string }).text); } },
				tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }) }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
			});
			const settle = async (text: string) => {
				contextHook({ agent: "fusion", tools: {}, sessionID: "one" });
				busQueue.push({ type: "session.execution.started", data: { sessionID: "one" } });
				busWake?.();
				busQueue.push({ type: "session.text.ended", data: { sessionID: "one", text } });
				busWake?.();
				busQueue.push({ type: "session.execution.succeeded", data: { sessionID: "one" } });
				busWake?.();
				await new Promise((resolve) => setTimeout(resolve, 25));
			};
			await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
			for (let turn = 0; turn < 3; turn++) await settle(`Turn ${turn} without delegating.`);
			const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
			expect(status.incomplete).toBe(true);
			expect(status.guidedRecovery).toMatchObject({ action: "take-over", category: "operator-resolution", confirmationRequired: false });
			expect(status.nextAction).toContain("take over the task yourself, or call fusion_reset to finish the run");
			const resume = JSON.parse((await tools.get("fusion_resume")!.execute({}, context("one"))).content);
			expect(resume.guidedRecovery).toMatchObject({ action: "take-over", category: "operator-resolution" });
			expect(resume.nextAction).toBe(status.nextAction);
		}
		// (2) A failed settlement write stays visible as a self-retrying write,
		// never as recovery work; healing the write clears it.
		{
			const tools = new Map<string, Tool>();
			const backing = memoryStorage();
			let failSaves = 0;
			const storage = { get: backing.get, set: async (key: string, value: unknown) => { if (failSaves > 0) { failSaves -= 1; throw new Error("disk full"); } return backing.set(key, value); }, remove: backing.remove };
			const busQueue: { type: string; data?: Record<string, unknown> }[] = [];
			let busWake: (() => void) | undefined;
			let contextHook!: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void;
			const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { busWake = resolve; }); } } } } }) };
			const issues: string[] = [];
			await setupTest({
				location: { directory: "/workspace" },
				event: eventHost,
				session: { context: async () => [], hook: async (_name: string, callback: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void) => { contextHook = callback; }, synthetic: async (input) => { issues.push((input as { text?: string }).text ?? ""); } },
				tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }) }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
			}, storage);
			const settle = async (text: string) => {
				contextHook({ agent: "fusion", tools: {}, sessionID: "one" });
				busQueue.push({ type: "session.execution.started", data: { sessionID: "one" } });
				busWake?.();
				busQueue.push({ type: "session.text.ended", data: { sessionID: "one", text } });
				busWake?.();
				busQueue.push({ type: "session.execution.succeeded", data: { sessionID: "one" } });
				busWake?.();
				await new Promise((resolve) => setTimeout(resolve, 25));
			};
			await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
			await tools.get("fusion_delegate")!.execute({ action: "execute", title: "Build", details: { brief: "build" } }, context("one"));
			failSaves = 1;
			await settle("All requirements audited.\n## Fusion summary\nDone.");
			let status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
			expect(status.settlementWrite).toBe("pending");
			expect(status.guidedRecovery).toMatchObject({ action: "continue", category: "none", confirmationRequired: false });
			expect(status.nextAction).toContain("The last Fusion settlement could not be written; it retries when this session next settles");
			failSaves = 0;
			await settle("All requirements audited.\n## Fusion summary\nDone.");
			status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
			expect(status.settlementWrite).not.toBe("pending");
			expect(status.guidedRecovery).toMatchObject({ action: "continue", category: "none" });
		}
		// (3) A foreign coordinator: both surfaces name the owning session and
		// quote the exact resolution fallback; nothing is submitted for it.
		{
			const tools = new Map<string, Tool>();
			await setupTest({ location: { directory: "/workspace" }, session: { context: async () => [], hook: async () => {} }, tool: {
				// The foreign record must never be acted on from this session:
				// the subagent tool refuses every call.
				hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => { throw new Error("must not be called"); } }],
				transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
			} });
			await tools.get("fusion_start")!.execute({ task: "Owned task" }, context("one"));
			const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("two"))).content);
			expect(status.guidedRecovery).toMatchObject({ action: "elsewhere", category: "elsewhere", confirmationRequired: true });
			expect(status.nextAction).toContain("Call fusion_resume in the owning session (opencode:one)");
			expect(status.nextAction).toContain(`${RESOLVE_ENTRY} '/workspace'`);
			expect(status.nextAction).toContain("--confirm-stopped");
			const resume = JSON.parse((await tools.get("fusion_resume")!.execute({}, context("two"))).content);
			expect(resume.guidedRecovery).toMatchObject({ action: "elsewhere", category: "elsewhere" });
			expect(resume.nextAction).toBe(status.nextAction);
			// Idempotent: repeated readings derive the same action and submit
			// nothing (the subagent mock above still refuses every call).
			const again = JSON.parse((await tools.get("fusion_resume")!.execute({}, context("two"))).content);
			expect(again.nextAction).toBe(resume.nextAction);
			expect(again.guidedRecovery).toEqual(resume.guidedRecovery);
		}
	});
	test("a stopped run keeps its per-worker recap and gains the shared recovery line", async () => {
		const tools = new Map<string, Tool>();
		const interrupts: { sessionID: string }[] = [];
		const queue: { type: string; created: number; data: { sessionID: string } }[] = [];
		let wake: (() => void) | undefined, entered!: () => void;
		const ready = new Promise<void>((resolve) => { entered = resolve; });
		await setupTest({ location: { directory: "/workspace" },
			event: { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = queue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { wake = resolve; }); } } }; } }) },
			session: { context: async () => [], hook: async () => {}, interrupt: async (input) => { interrupts.push(input); return { interrupted: true }; } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx) => {
				await ctx.progress({ sessionID: "child-stop" }); entered();
				return await new Promise<never>((_resolve, reject) => { ctx.signal.addEventListener("abort", () => reject(new Error("cancelled by stop")), { once: true }); });
			} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		});
		const pending = tools.get("fusion_delegate")!.execute({ action: "execute", brief: "work" }, context("one")).catch((error) => String(error));
		await ready;
		await tools.get("fusion_stop")!.execute({ reason: "User asked to stop" }, context("one"));
		await pending;
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		// The stop recap stays the primary presentation; the recovery line
		// rides beneath it. The child was interrupted but its completion
		// notification is still awaited, so the derived action adopts the
		// exact terminal outcome — with explicit operator resolution quoted
		// as the fallback when no notification can exist.
		expect(status.nextAction).toContain("Termination is not confirmed yet.");
		expect(status.nextAction).toContain("Recovery: adopt the completed result");
		expect(status.nextAction).toContain("If it reports no matching notification");
		expect(status.nextAction).toContain(`after confirming the worker stopped run: ${RESOLVE_ENTRY} '/workspace'`);
		expect(status.guidedRecovery).toMatchObject({ action: "reconcile", category: "adopt-result", confirmationRequired: true });
		// Reading the guidance again submits nothing: no further interrupt.
		expect(interrupts).toHaveLength(1);
		const before = JSON.stringify(status.guidedRecovery);
		const repeat = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(JSON.stringify(repeat.guidedRecovery)).toBe(before);
		expect(interrupts).toHaveLength(1);
		// The ring-confirmed cancellation proves the worker ended, but the
		// retained request still owes its settlement: the stop never overrides
		// an owed recovery, and the fallback keeps its confirmation.
		queue.push({ type: "session.execution.interrupted", created: Date.now(), data: { sessionID: "child-stop" } }); wake?.();
		await new Promise((resolve) => setTimeout(resolve, 30));
		const confirmed = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(confirmed.stop).toMatchObject({ state: "confirmed", terminal: "cancelled" });
		expect(confirmed.guidedRecovery).toMatchObject({ action: "reconcile", category: "adopt-result" });
		expect(confirmed.nextAction).toContain("--confirm-stopped");
		await pending;
	});
	test("the uncertain activity card publishes the derived recovery line (review fix)", async () => {
		const tools = new Map<string, Tool>();
		const cards: Record<string, unknown>[] = [];
		await setupTest({ location: { directory: "/workspace" }, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx) => {
				await ctx.progress({ sessionID: "child-f" });
				throw new Error("connection lost");
			} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		const failing = { ...context("one"), progress: async (update: Record<string, unknown>) => { cards.push(update); } };
		await expect(tools.get("fusion_delegate")!.execute({ action: "execute", brief: "work" }, failing)).rejects.toThrow("connection lost");
		// The card was published after the controller finalized the failure:
		// the phase is uncertain and its recovery line is the derived action.
		const lastCard = cards.map((card) => card.fusion as Record<string, unknown> | undefined).at(-1);
		expect(lastCard?.phase).toBe("uncertain");
		expect(lastCard?.recovery).toContain("Recovery: adopt the completed result");
		// The card and status derive the same action for the same facts — the
		// submission began, so the completion notification is still awaited.
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.guidedRecovery.action).toBe("reconcile");
		expect(lastCard?.recovery).toBe(status.nextAction);
	});
	test("per-run usage totals aggregate observed readings and survive reload", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		const busQueue: { type: string; data?: Record<string, unknown> }[] = [];
		let busWake: (() => void) | undefined;
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { busWake = resolve; }); } } } } }) };
		let executorCalls = 0;
		// The host reports cumulative per-session readings; only the delta of a
		// monotonic reading belongs to the turn.
		const reading = (sessionID: string, tokens: { input: number; output: number }, cost: number) => { busQueue.push({ type: "session.usage.updated", data: { sessionID, tokens, cost } }); busWake?.(); };
		await setupTest({
			location: { directory: "/workspace" },
			event: eventHost,
			session: { context: async () => [], hook: async () => {} },
			tool: {
				hook: async () => {},
				list: async () => [{ id: "subagent", execute: async (input: { agent?: string }, ctx: { progress: (update: Record<string, unknown>) => Promise<void> }) => {
					if (input.agent === "fusion-scout") {
						await ctx.progress({ sessionID: "scout-1" });
						reading("scout-1", { input: 20, output: 10 }, 2);
						await new Promise((resolve) => setTimeout(resolve, 10));
						return { output: { sessionID: "scout-1", status: "completed", output: "answer" } };
					}
					executorCalls++;
					await ctx.progress({ sessionID: "child-1" });
					reading("child-1", executorCalls === 1 ? { input: 100, output: 50 } : { input: 300, output: 120 }, executorCalls === 1 ? 10 : 30);
					await new Promise((resolve) => setTimeout(resolve, 10));
					return { output: { sessionID: "child-1", status: "completed", output: "done" } };
				} }],
				transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
			},
		}, storage);
		await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
		await tools.get("fusion_scout")!.execute({ questions: ["Where?"] }, context("one"));
		let stats = JSON.parse((await tools.get("fusion_stats")!.execute({}, context("one"))).content);
		expect(stats.usage).toMatchObject({ available: true, complete: true, turns: { reported: 1, missing: 0 }, inputTokens: 20, outputTokens: 10, cost: 2 });
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		await tools.get("fusion_delegate")!.execute({ action: "revise", brief: "fix" }, context("one"));
		stats = JSON.parse((await tools.get("fusion_stats")!.execute({}, context("one"))).content);
		expect(stats.usage).toMatchObject({ available: true, complete: true, turns: { reported: 3, missing: 0 }, inputTokens: 320, outputTokens: 130, cost: 32 });
		// Reload: the persisted adapterData keeps the accumulated totals.
		const reloaded = new Map<string, Tool>();
		await setupTest({ location: { directory: "/workspace" }, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child-1", status: "completed", output: "done" } }) }],
			transform: async (callback) => { callback({ add: (tool) => reloaded.set(tool.name, tool) }); },
		} }, storage);
		stats = JSON.parse((await reloaded.get("fusion_stats")!.execute({}, context("one"))).content);
		expect(stats.usage).toMatchObject({ turns: { reported: 3, missing: 0 }, inputTokens: 320, outputTokens: 130, cost: 32 });
	});

	test("a reconciled turn without a usage reading counts as missing, not zero", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		let description = "";
		let messages: unknown[] = [];
		const makeContext = (fresh: Map<string, Tool>): TestContext => ({
			location: { directory: "/workspace" }, session: { context: async () => messages, hook: async () => {} }, tool: {
				hook: async () => {}, list: async () => [{ id: "subagent", execute: async (input: { description?: string }, ctx: { progress: (update: Record<string, unknown>) => Promise<void> }) => {
					await ctx.progress({ sessionID: "child-u" });
					description = input.description ?? "";
					throw new Error("connection lost");
				} }], transform: async (callback) => { callback({ add: (tool) => fresh.set(tool.name, tool) }); },
			},
		});
		await setupTest(makeContext(tools), storage);
		await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
		// The failed submission observed no result and no usage: nothing is counted.
		await expect(tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"))).rejects.toThrow("connection lost");
		let stats = JSON.parse((await tools.get("fusion_stats")!.execute({}, context("one"))).content);
		expect(stats.usage).toMatchObject({ available: false, complete: true, turns: { reported: 0, missing: 0 } });
		const restored = new Map<string, Tool>();
		await setupTest(makeContext(restored), storage);
		messages = [{ type: "synthetic", description, metadata: { source: "subagent", childID: "child-u", agent: "fusion-executor", state: "completed" }, text: `<subagent sessionID="child-u" state="completed" description="${description}">\nfixed\n</subagent>` }];
		await restored.get("fusion_reconcile")!.execute({}, context("one"));
		// The reconciled turn ran, but its usage reading was never observed: the
		// totals stay absent and the turn is reported missing rather than zero.
		stats = JSON.parse((await restored.get("fusion_stats")!.execute({}, context("one"))).content);
		expect(stats.usage).toMatchObject({ available: false, complete: false, turns: { reported: 0, missing: 1 } });
		expect(stats.usage.inputTokens).toBeUndefined();
	});

	test("reconciled usage is recorded inside the settlement and never double-counted on retry", async () => {
		const tools = new Map<string, Tool>();
		const backing = memoryStorage();
		let failSettlement = false;
		const storage = { ...backing, set: async (key: string, value: unknown) => {
			if (failSettlement && !(value as { pending?: unknown }).pending) { failSettlement = false; throw new Error("settlement storage offline"); }
			await backing.set(key, value);
		} };
		let description = "";
		let messages: unknown[] = [];
		const makeContext = (fresh: Map<string, Tool>): TestContext => ({
			location: { directory: "/workspace" }, session: { context: async () => messages, hook: async () => {} }, tool: {
				hook: async () => {}, list: async () => [{ id: "subagent", execute: async (input: { description?: string }, ctx: { progress: (update: Record<string, unknown>) => Promise<void> }) => {
					await ctx.progress({ sessionID: "child-f" });
					description = input.description ?? "";
					throw new Error("connection lost");
				} }], transform: async (callback) => { callback({ add: (tool) => fresh.set(tool.name, tool) }); },
			},
		});
		await setupTest(makeContext(tools), storage);
		await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
		await expect(tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"))).rejects.toThrow("connection lost");
		const restored = new Map<string, Tool>();
		await setupTest(makeContext(restored), storage);
		messages = [{ type: "synthetic", description, metadata: { source: "subagent", childID: "child-f", agent: "fusion-executor", state: "completed" }, text: `<subagent sessionID="child-f" state="completed" description="${description}">\nfixed\n</subagent>` }];
		// The first reconciliation records its usage inside the settlement, whose
		// write fails: the count exists in memory only, guarded by a dedupe key.
		failSettlement = true;
		await expect(restored.get("fusion_reconcile")!.execute({}, context("one"))).rejects.toThrow("settlement storage offline");
		// The retried reconciliation must not count the turn again.
		await restored.get("fusion_reconcile")!.execute({}, context("one"));
		const stats = JSON.parse((await restored.get("fusion_stats")!.execute({}, context("one"))).content);
		expect(stats.usage).toMatchObject({ turns: { reported: 0, missing: 1 } });
		// And the persisted state carries the dedupe key: a reload cannot re-count.
		const manifest = (await storage.get(`run/${createHash("sha256").update("/workspace").digest("hex")}`)) as { adapterData?: { fusionUsage?: { counted?: string[] } } };
		expect(manifest?.adapterData?.fusionUsage?.counted).toEqual([`reconcile:${description}`]);
	});

	test("partial usage readings keep the totals honest", async () => {
		const tools = new Map<string, Tool>();
		const busQueue: { type: string; data?: Record<string, unknown> }[] = [];
		let busWake: (() => void) | undefined;
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { busWake = resolve; }); } } } } }) };
		let executorCalls = 0;
		const reading = (sessionID: string, tokens: Record<string, unknown>, cost: number) => { busQueue.push({ type: "session.usage.updated", data: { sessionID, tokens, cost } }); busWake?.(); };
		await setupTest({
			location: { directory: "/workspace" },
			event: eventHost,
			session: { context: async () => [], hook: async () => {} },
			tool: {
				hook: async () => {},
				list: async () => [{ id: "subagent", execute: async (input: { agent?: string }, ctx: { progress: (update: Record<string, unknown>) => Promise<void> }) => {
					executorCalls++;
					await ctx.progress({ sessionID: "child-p" });
					if (executorCalls === 1) reading("child-p", { input: 10, output: 5 }, 3);
					else reading("child-p", {}, 7);
					await new Promise((resolve) => setTimeout(resolve, 10));
					return { output: { sessionID: "child-p", status: "completed", output: "done" } };
				} }],
				transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
			},
		}, memoryStorage());
		await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		await tools.get("fusion_delegate")!.execute({ action: "revise", brief: "fix" }, context("one"));
		const stats = JSON.parse((await tools.get("fusion_stats")!.execute({}, context("one"))).content);
		// The second reading carried only cost: the token totals come from one
		// turn of two, so the usage must not claim completeness.
		expect(stats.usage).toMatchObject(
			{ available: true, complete: false, turns: { reported: 2, missing: 0 } },
		);
		expect(stats.usage.inputTokens).toBe(10);
		expect(stats.usage.cost).toBe(7);
		expect(stats.usage.fieldTurns).toMatchObject({ inputTokens: 1, outputTokens: 1, cost: 2 });
	});
	test("blocks direct subagent calls only for the Fusion supervisor", async () => {
		const tools = new Map<string, Tool>();
		let before!: (event: { tool: string; agent: string }) => void;
		let contextHook!: (event: { agent: string; tools: Record<string, unknown> }) => void;
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async (_name, callback) => { contextHook = callback; } }, tool: {
			hook: async (_name, callback) => { before = callback; },
			list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }) }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		expect(() => before({ agent: "fusion", tool: "subagent" })).toThrow("fusion_delegate");
		expect(() => before({ agent: "build", tool: "subagent" })).not.toThrow();
		expect(() => before({ agent: "fusion", tool: "read" })).not.toThrow();
		const fusionTools = { subagent: {}, read: {} } as Record<string, unknown>;
		contextHook({ agent: "fusion", tools: fusionTools });
		expect(fusionTools).not.toHaveProperty("subagent");
		const buildTools = { subagent: {} };
		contextHook({ agent: "build", tools: buildTools });
		expect(buildTools).toHaveProperty("subagent");
		await expect(tools.get("fusion_delegate")!.execute({ action: "execute", brief: "work" }, context("one"))).resolves.toHaveProperty("content");
	});
	test("fusion tools refuse every non-supervisor agent, including the executor", async () => {
		const tools = new Map<string, Tool>();
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async () => {},
			list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }) }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		for (const name of ["fusion_delegate", "fusion_status", "fusion_resume", "fusion_reconcile", "fusion_reset"]) {
			await expect(tools.get(name)!.execute(name === "fusion_delegate" ? { action: "execute", brief: "recursion" } : {}, context("one", "fusion-executor"))).rejects.toThrow("only to the fusion primary agent");
			await expect(tools.get(name)!.execute(name === "fusion_delegate" ? { action: "execute", brief: "recursion" } : {}, context("one", "general"))).rejects.toThrow("only to the fusion primary agent");
		}
	});

	test("fusion_scout runs a disposable read-only scout through the shared invocation budget", async () => {
		const tools = new Map<string, Tool>();
		let scoutCalls = 0;
		let executorCalls = 0;
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async () => {},
			list: async () => [{ id: "subagent", execute: async (input) => {
				if (input.agent !== "fusion-scout") { executorCalls++; return { output: { sessionID: "child", status: "completed", output: '```json\n{"status":"done","summary":"ok","checks":[],"files_changed":[],"blockers":[]}\n```' } }; }
				scoutCalls++;
				return { output: { sessionID: `scout-${scoutCalls}`, status: "completed", output: `1. fixture.txt:1 has the answer ${scoutCalls}` } };
			} }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		const scout = tools.get("fusion_scout")!;
		const delegate = tools.get("fusion_delegate")!;
		await expect(scout.execute({}, context("one"))).rejects.toThrow("Invalid Fusion scout input");
		await expect(scout.execute({ questions: [] }, context("one"))).rejects.toThrow("Invalid Fusion scout input");
		await expect(scout.execute({ questions: ["a", "b", "c", "d", "e", "f"] }, context("one"))).rejects.toThrow("Invalid Fusion scout input");
		await expect(scout.execute({ questions: ["q"] }, context("one", "fusion-executor"))).rejects.toThrow("only to the fusion primary agent");
		expect(scoutCalls).toBe(0);
		// Scouting before any delegation lazily creates the session's run.
		const first = await scout.execute({ questions: ["where is the answer?"] }, context("one"));
		expect(first.content).toContain("1. fixture.txt:1 has the answer 1");
		expect(first.content).toContain("Scout usage:");
		expect(first.metadata).toMatchObject({ childSessionID: "scout-1", status: "completed", capped: false });
		expect(executorCalls).toBe(0);
		for (let i = 2; i <= 4; i++) await scout.execute({ questions: ["more"] }, context("one"));
		expect(scoutCalls).toBe(4);
		// The fifth call is refused by the shared budget before any native work.
		const fifth = await scout.execute({ questions: ["again?"] }, context("one"));
		expect(fifth.content).toContain("Scout limit reached");
		expect(scoutCalls).toBe(4);
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.scoutCalls).toBe(4);
		// The same session's run still accepts a delegation after scouting.
		await delegate.execute({ action: "execute", brief: "build" }, context("one"));
		expect(executorCalls).toBe(1);
		// ... and the budget stays shared across the whole run.
		expect((await scout.execute({ questions: ["more"] }, context("one"))).content).toContain("Scout limit reached");
		expect(scoutCalls).toBe(4);
	});

	test("scout tool calls are capped synchronously before execution and allowlisted", async () => {
		const tools = new Map<string, Tool>();
		let before!: (event: { tool: string; agent: string; sessionID?: string }) => void;
		const interrupted: string[] = [];
		let release!: () => void, seen!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const entered = new Promise<void>((resolve) => { seen = resolve; });
		let scoutRuns = 0;
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {}, interrupt: async ({ sessionID }) => { interrupted.push(sessionID); } }, tool: {
			hook: async (_name, callback) => { before = callback; },
			list: async () => [{ id: "subagent", execute: async (input, ctx) => {
				if (input.agent !== "fusion-scout") return { output: { sessionID: "child", status: "completed", output: '```json\n{"status":"done","summary":"ok","checks":[],"files_changed":[],"blockers":[]}\n```' } };
				scoutRuns++;
				if (scoutRuns === 1) { await ctx.progress({ sessionID: "scout-1" }); seen(); await gate; }
				return { output: { sessionID: `scout-${scoutRuns}`, status: "completed", output: "answer" } };
			} }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		const scout = tools.get("fusion_scout")!;
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		const pending = scout.execute({ questions: ["q"] }, context("one"));
		await entered;
		// While the scout is in flight, its child's tool calls pass through this hook.
		expect(() => before({ agent: "build", tool: "edit", sessionID: "scout-1" })).not.toThrow();
		expect(() => before({ agent: "fusion-executor", tool: "edit", sessionID: "scout-1" })).not.toThrow();
		// Non-allowlisted tools are denied before their effects, without consuming the cap.
		expect(() => before({ agent: "fusion-scout", tool: "edit", sessionID: "scout-1" })).toThrow("denied before execution");
		expect(() => before({ agent: "fusion-scout", tool: "shell", sessionID: "scout-1" })).toThrow("denied before execution");
		expect(() => before({ agent: "fusion-scout", tool: "subagent", sessionID: "scout-1" })).toThrow("denied before execution");
		expect(() => before({ agent: "fusion-scout", tool: "webfetch", sessionID: "scout-1" })).toThrow("denied before execution");
		// Calls from other sessions never touch this scout's cap.
		expect(() => before({ agent: "fusion-scout", tool: "read", sessionID: "someone-else" })).not.toThrow();
		// Exactly 20 read/search/list calls run; the 21st is refused before execution.
		for (let i = 0; i < 20; i++) expect(() => before({ agent: "fusion-scout", tool: i % 2 ? "grep" : "read", sessionID: "scout-1" })).not.toThrow();
		expect(() => before({ agent: "fusion-scout", tool: "read", sessionID: "scout-1" })).toThrow("Tool call limit reached");
		// Refused attempts count too: the terminate window interrupts the child.
		expect(() => before({ agent: "fusion-scout", tool: "glob", sessionID: "scout-1" })).toThrow("Tool call limit reached");
		expect(() => before({ agent: "fusion-scout", tool: "read", sessionID: "scout-1" })).toThrow("Tool call limit reached");
		expect(() => before({ agent: "fusion-scout", tool: "read", sessionID: "scout-1" })).toThrow("Tool call limit reached");
		expect(interrupted).toEqual(["scout-1"]);
		release();
		const result = await pending;
		expect(result.content).toContain("Scout stopped after 20 tool calls; partial answer:");
		expect(result.metadata).toMatchObject({ capped: true, childSessionID: "scout-1" });
		// After the turn the child is no longer the active scout, but scout-agent
		// calls are never unguarded: edits stay denied and reads get a fresh cap.
		expect(() => before({ agent: "fusion-scout", tool: "edit", sessionID: "scout-1" })).toThrow("denied before execution");
		expect(() => before({ agent: "fusion-scout", tool: "read", sessionID: "scout-1" })).not.toThrow();
	});

	test("a cancelled scout is reported and leaves executor work unaffected", async () => {
		const tools = new Map<string, Tool>();
		let release!: () => void, seen!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const entered = new Promise<void>((resolve) => { seen = resolve; });
		const calls: string[] = [];
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async () => {},
			list: async () => [{ id: "subagent", execute: async (input) => {
				calls.push(input.agent);
				if (input.agent !== "fusion-scout") return { output: { sessionID: "child", status: "completed", output: '```json\n{"status":"done","summary":"ok","checks":[],"files_changed":[],"blockers":[]}\n```' } };
				seen();
				await gate;
				throw new Error("cancelled native call");
			} }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		const scout = tools.get("fusion_scout")!;
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		const controller = new AbortController();
		const pending = scout.execute({ questions: ["q"] }, { ...context("one"), signal: controller.signal });
		await entered;
		controller.abort();
		release();
		const result = await pending;
		expect(result.content).toContain(`stopped with status "cancelled"`);
		expect(result.metadata).toMatchObject({ status: "cancelled" });
		// The cancelled scout neither locked the run nor touched the executor child.
		await expect(tools.get("fusion_delegate")!.execute({ action: "revise", brief: "fix" }, context("one"))).resolves.toHaveProperty("content");
		expect(calls).toEqual(["fusion-executor", "fusion-scout", "fusion-executor"]);
		await tools.get("fusion_reset")!.execute({}, context("one"));
	});

	test("clean releases a settled persistent-mode run and refuses an unfinished one", async () => {
		const tools = new Map<string, Tool>();
		const commands: CommandDefinition[] = [];
		const nudges: string[] = [];
		const busQueue: { id?: string; type: string; data?: Record<string, unknown> }[] = [];
		let busWake: (() => void) | undefined;
		let contextHook!: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void;
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { busWake = resolve; }); } } } } }) };
		const settle = async (id: string, text: string) => {
			contextHook({ agent: "fusion", tools: {}, sessionID: "one" });
			busQueue.push({ type: "session.execution.started", data: { sessionID: "one" } });
			busWake?.();
			busQueue.push({ type: "session.text.ended", data: { sessionID: "one", text } });
			busWake?.();
			busQueue.push({ id, type: "session.execution.succeeded", data: { sessionID: "one" } });
			busWake?.();
			await new Promise((resolve) => setTimeout(resolve, 25));
		};
		const reportBlock = '```json\n{"status":"done","summary":"ok","checks":[],"files_changed":[],"blockers":[]}\n```';
		await setupTest({
			location: { directory: "/workspace" },
			event: eventHost,
			session: { context: async () => [], hook: async (_name: string, callback: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void) => { contextHook = callback; }, switchAgent: async () => {}, prompt: async (input: { id?: string }) => { if (input.id?.startsWith("msg_fusion_nudge")) nudges.push(input.id); } },
			command: { list: async () => ({ data: [] }), transform: async (callback: (editor: { add: (command: CommandDefinition) => void }) => Promise<void>) => { await callback({ add: (command) => commands.push(command) }); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: reportBlock } }) }], transform: async (callback: (editor: { add: (tool: Tool) => void }) => void) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		});
		// Persistent mode, then a run: armed and unfinished, clean refuses.
		await commands[1].execute({ sessionID: "one", prompt: { text: "on" } });
		await commands[0].execute({ sessionID: "one", prompt: { text: "Build the fixture" } });
		await expect(commands[7].execute({ sessionID: "one" })).rejects.toThrow("The Fusion run is still active");
		// The protocol runs and the summary turn settles the run: persistent
		// mode keeps it armed, and clean must still release the settled resources.
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build", originalTask: "Build the fixture" }, context("one"));
		await settle("evt-1", "## Fusion summary");
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.phase).toBe("complete");
		expect(status.runActive).toBe(true);
		expect(await commands[7].execute({ sessionID: "one" })).toContain("Released Fusion resources for this session.");
	});

	test("a backgrounded scout keeps its guard until its execution is observed to end", async () => {
		const tools = new Map<string, Tool>();
		let before!: (event: { tool: string; agent: string; sessionID?: string }) => void;
		const busQueue: { type: string; data?: Record<string, unknown> }[] = [];
		let busWake: (() => void) | undefined;
		const eventHost = { subscribe: () => ({
			[Symbol.asyncIterator]() {
				return { next: async () => {
					for (;;) {
						const next = busQueue.shift();
						if (next) return { value: next, done: false as const };
						await new Promise<void>((resolve) => { busWake = resolve; });
						busWake = undefined;
					}
				} };
			},
		}) };
		await setupTest({ location: { directory: tmpdir() }, event: eventHost, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async (_name, callback) => { before = callback; },
			list: async () => [{ id: "subagent", execute: async (input, ctx) => {
				if (input.agent !== "fusion-scout") return { output: { sessionID: "child", status: "completed", output: '```json\n{"status":"done","summary":"ok","checks":[],"files_changed":[],"blockers":[]}\n```' } };
				await ctx.progress({ sessionID: "scout-bg" });
				// The host backgrounds the scout; the child keeps running.
				return { output: { sessionID: "scout-bg", status: "running", output: "backgrounded" } };
			} }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} }, memoryStorage(), { scoutSettleTimeoutMs: 50 });
		const scout = tools.get("fusion_scout")!;
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		const result = await scout.execute({ questions: ["q"] }, context("one"));
		// The bounded wait finds no proof: the explicit pending disposition, not
		// an error and not a claimed answer.
		expect(result.content).toContain("still running in the background");
		expect(result.metadata?.status).toBe("pending");
		// The call returned, but the child is still running: enforcement persists.
		for (let i = 0; i < 20; i++) expect(() => before({ agent: "fusion-scout", tool: "read", sessionID: "scout-bg" })).not.toThrow();
		expect(() => before({ agent: "fusion-scout", tool: "read", sessionID: "scout-bg" })).toThrow("Tool call limit reached");
		expect(() => before({ agent: "fusion-scout", tool: "shell", sessionID: "scout-bg" })).toThrow("denied before execution");
		await expect(tools.get("fusion_reset")!.execute({}, context("one"))).rejects.toThrow("still running");
		expect(JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content).executed).toBe(true);
		// The child's execution ends: the guard is released, and a later scout-agent
		// session starts with a fresh cap.
		busQueue.push({ type: "session.execution.succeeded", data: { sessionID: "scout-bg" } });
		busWake?.();
		await new Promise((resolve) => setTimeout(resolve, 25));
		await expect(tools.get("fusion_reset")!.execute({}, context("one"))).resolves.toHaveProperty("content", "Fusion run reset.");
		expect(() => before({ agent: "fusion-scout", tool: "read", sessionID: "scout-bg" })).not.toThrow();
		// Prohibited tools stay denied regardless of guard state.
		expect(() => before({ agent: "fusion-scout", tool: "edit", sessionID: "scout-bg" })).toThrow("denied before execution");
	});

	test("reset during an active scout is refused before touching the run", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		let release!: () => void, seen!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const entered = new Promise<void>((resolve) => { seen = resolve; });
		await setupTest({ location: { directory: "/workspace" }, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async () => {},
			list: async () => [{ id: "subagent", execute: async (input) => {
				if (input.agent !== "fusion-scout") return { output: { sessionID: "child", status: "completed", output: '```json\n{"status":"done","summary":"ok","checks":[],"files_changed":[],"blockers":[]}\n```' } };
				if (process.env.FUSION_DEBUG_RESET) console.error(`[dbg] seen called by agent=${input.agent}`);
				seen();
				await gate;
				return { output: { sessionID: "scout", status: "completed", output: "answer" } };
			} }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} }, storage);
		const scout = tools.get("fusion_scout")!;
		const reset = tools.get("fusion_reset")!;
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		const key = `run/${createHash("sha256").update("/workspace").digest("hex")}`;
		expect(await storage.get(key)).toBeDefined();
		const pending = scout.execute({ questions: ["q"] }, context("one"));
		await entered;
		await expect(reset.execute({}, context("one"))).rejects.toThrow("still running");
		// Nothing was dismantled: the record, the lease state, and the run survive.
		expect(await storage.get(key)).toBeDefined();
		release();
		expect((await pending).content).toContain("answer");
		await expect(reset.execute({}, context("one"))).resolves.toHaveProperty("content", "Fusion run reset.");
	});

	test("scouts are serialized and their release never blocks reset", async () => {
		const tools = new Map<string, Tool>();
		let release!: () => void, seen!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const entered = new Promise<void>((resolve) => { seen = resolve; });
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async () => {},
			list: async () => [{ id: "subagent", execute: async (input) => {
				if (input.agent !== "fusion-scout") return { output: { sessionID: "child", status: "completed", output: '```json\n{"status":"done","summary":"ok","checks":[],"files_changed":[],"blockers":[]}\n```' } };
				seen();
				await gate;
				return { output: { sessionID: "scout", status: "completed", output: "answer" } };
			} }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		const scout = tools.get("fusion_scout")!;
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		const pending = scout.execute({ questions: ["q"] }, context("one"));
		await entered;
		await expect(scout.execute({ questions: ["q"] }, context("one"))).rejects.toThrow("already running");
		release();
		const result = await pending;
		expect(result.content).toContain("answer");
		// The disposable scout released its handle, so reset is not blocked.
		await expect(tools.get("fusion_reset")!.execute({}, context("one"))).resolves.toHaveProperty("content", "Fusion run reset.");
	});


	test("reconciles only a matching native background completion and retains the child", async () => {
		const tools = new Map<string, Tool>();
		const calls: Record<string, unknown>[] = [];
		let messages: unknown[] = [];
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => messages, hook: async () => {} }, tool: {
			hook: async () => {},
			list: async () => [{ id: "subagent", execute: async (input) => {
				calls.push({ ...input });
				return { output: { sessionID: "child-1", status: calls.length === 1 ? "running" : "completed", output: "done" } };
			} }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		const delegate = tools.get("fusion_delegate")!;
		const reconcile = tools.get("fusion_reconcile")!;
		expect((await delegate.execute({ action: "execute", brief: "work" }, context("one"))).content).toContain("fusion_reconcile");
		const description = calls[0].description as string;
		const notification = (childID: string, label: string) => ({ type: "synthetic", description: label, metadata: { source: "subagent", childID, agent: "fusion-executor", state: "completed" }, text: `<subagent sessionID="${childID}" state="completed" description="${label}">\nfinal report\n</subagent>` });
		messages = [notification("child-1", "old turn"), notification("other-child", description)];
		await expect(reconcile.execute({}, context("one"))).rejects.toThrow("No matching completion");
		await expect(tools.get("fusion_reset")!.execute({}, context("one"))).rejects.toThrow("uncertain");
		messages.push(notification("child-1", description));
		const result = await reconcile.execute({}, context("one"));
		expect(result.content).toContain("final report");
		expect(result.content).toContain("Review: full");
		await delegate.execute({ action: "revise", brief: "fix" }, context("one"));
		expect(calls[1].sessionID).toBe("child-1");
		await expect(reconcile.execute({}, context("one"))).rejects.toThrow("No backgrounded");
	});

	test("reports failed background work as failed even if its output contains a success report", async () => {
		const tools = new Map<string, Tool>();
		let description = "";
		let messages: unknown[] = [];
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => messages, hook: async () => {} }, tool: {
			hook: async () => {},
			list: async () => [{ id: "subagent", execute: async (input) => { description = input.description; return { output: { sessionID: "child", status: "running", output: "working" } }; } }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "work" }, context("one"));
		const output = '```json\n{"status":"done"}\n```';
		messages = [{ type: "synthetic", description, metadata: { source: "subagent", childID: "child", agent: "fusion-executor", state: "error" }, text: `<subagent sessionID="child" state="error" description="${description}">\n${output}\n</subagent>` }];
		const result = await tools.get("fusion_reconcile")!.execute({}, context("one"));
		expect(result.content).toContain("Fusion executor error");
		expect(result.content).not.toContain("Status: done");
		await expect(tools.get("fusion_reset")!.execute({}, context("one"))).resolves.toHaveProperty("content", "Fusion run reset.");
	});

	test("reports real workspace changes while requiring a full review", async () => {
		const root = await mkdtemp(join(tmpdir(), "fusion-plugin-workspace-"));
		const storage = memoryStorage();
		try {
			const init = await nodeGitExec(["init", "-q"], { cwd: root, timeout: 5000 });
			expect(init.code).toBe(0);
			const tools = new Map<string, Tool>();
			await setupTest({ location: { directory: root }, session: { context: async () => [], hook: async () => {} }, tool: { hook: async () => {},
				list: async () => [{ id: "subagent", execute: async () => {
					await writeFile(join(root, "fixture.txt"), "changed\n");
					return { output: { sessionID: "child-1", status: "completed", output: '```json\n{"status":"done","summary":"ok","checks":[{"command":"check","result":"pass"}],"files_changed":[],"blockers":[]}\n```' } };
				} }],
				transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
			} }, storage);
			const result = await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "create fixture" }, context("one"));
			expect(result.content).toContain("new: fixture.txt");
			expect(result.content).toContain("Review: full");
			expect(result.content).toContain("executor tool activity unavailable");
			const persisted = await storage.get(`run/${createHash("sha256").update(root).digest("hex")}`) as unknown;
			expect(persisted).toBeDefined();
			const manifest = readRunManifest(persisted, { harness: "opencode", workspace: root });
			expect(manifest.lastResult?.status).toBe("completed");
			expect(manifest.lastResult?.evidence).toContain("new:fixture.txt");
		} finally { await rm(root, { recursive: true, force: true }); }
	});
	test("registers tools and continues the same child through guarded turns", async () => {
		const tools = new Map<string, Tool>();
		const calls: Record<string, unknown>[] = [];
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: { hook: async () => {},
			list: async () => [{ id: "subagent", execute: async (input, ctx) => {
				calls.push({ ...input });
				await ctx.progress({ sessionID: "child-1" });
				return { output: { sessionID: "child-1", status: "completed", output: '```json\n{"status":"done","summary":"ok","checks":[],"files_changed":[],"blockers":[]}\n```' } };
			} }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		const delegate = tools.get("fusion_delegate")!;
		const reset = tools.get("fusion_reset")!;
		await expect(delegate.execute({ action: "revise", brief: "fix" }, context("one"))).rejects.toThrow("Cannot revise");
		await expect(delegate.execute({ action: "execute", brief: "build" }, context("one", "build"))).rejects.toThrow("fusion primary");
		const result = await delegate.execute({ action: "execute", brief: "build", originalTask: "original request" }, context("one"));
		expect(result.content).toContain("Status: done");
		await expect(delegate.execute({ action: "execute", brief: "other" }, context("two"))).rejects.toThrow("owns this workspace");
		await delegate.execute({ action: "revise", brief: "fix" }, context("one"));
		await delegate.execute({ action: "final_fix", brief: "audit" }, context("one"));
		expect(calls[0]?.sessionID).toBeUndefined();
		expect(calls[1]?.sessionID).toBe("child-1");
		expect(calls[2]?.prompt).toContain("original request");
		await expect(delegate.execute({ action: "final_fix", brief: "again" }, context("one"))).rejects.toThrow("Final fix already used");
		await reset.execute({}, context("one"));
		await delegate.execute({ action: "execute", brief: "next" }, context("two"));
	});

	test("does not permit a retry or release when a child outcome is unknown", async () => {
		const tools = new Map<string, Tool>();
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: { hook: async () => {},
			list: async () => [{ id: "subagent", execute: async (_input, ctx) => { await ctx.progress({ sessionID: "child-1" }); throw new Error("lost connection"); } }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		const delegate = tools.get("fusion_delegate")!;
		await expect(delegate.execute({ action: "execute", brief: "build" }, context("one"))).rejects.toThrow("lost connection");
		await expect(delegate.execute({ action: "execute", brief: "retry" }, context("one"))).rejects.toThrow("unknown outcome");
		await expect(tools.get("fusion_reset")!.execute({}, context("one"))).rejects.toThrow("uncertain");
		await expect(delegate.execute({ action: "execute", brief: "other" }, context("two"))).rejects.toThrow("owns this workspace");
	});

	test("also blocks retries when the native call fails before reporting a child ID", async () => {
		const tools = new Map<string, Tool>();
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: { hook: async () => {},
			list: async () => [{ id: "subagent", execute: async () => { throw new Error("connection lost"); } }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		const delegate = tools.get("fusion_delegate")!;
		await expect(delegate.execute({ action: "execute", brief: "build" }, context("one"))).rejects.toThrow("connection lost");
		await expect(delegate.execute({ action: "execute", brief: "retry" }, context("one"))).rejects.toThrow("unknown outcome");
		await expect(tools.get("fusion_reset")!.execute({}, context("one"))).rejects.toThrow("uncertain");
	});

	test("blocks other delegations and reset while the executor is active", async () => {
		const tools = new Map<string, Tool>();
		let finish!: () => void;
		const pending = new Promise<void>((resolve) => { finish = resolve; });
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: { hook: async () => {},
			list: async () => [{ id: "subagent", execute: async () => { await pending; return { output: { sessionID: "child-1", status: "completed", output: "done" } }; } }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		const delegate = tools.get("fusion_delegate")!;
		const first = delegate.execute({ action: "execute", brief: "build" }, context("one"));
		await expect(delegate.execute({ action: "execute", brief: "again" }, context("one"))).rejects.toThrow("already in progress");
		await expect(delegate.execute({ action: "execute", brief: "other" }, context("two"))).rejects.toThrow("owns this workspace");
		await expect(tools.get("fusion_reset")!.execute({}, context("one"))).rejects.toThrow("active");
		finish();
		await first;
	});
});

test("restoration rejects a child owned by a different supervisor", async () => {
	const storage = memoryStorage();
	const first = new Map<string, Tool>();
	const base: TestContext = { location: { directory: "/workspace" }, session: { context: async () => [], hook: async () => {} }, tool: {
		hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }) }],
		transform: async (callback) => { callback({ add: (tool) => first.set(tool.name, tool) }); },
	} };
	await setupTest(base, storage);
	await first.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
	const wrong = { ...base, session: { ...base.session, get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, parentID: "other", location: { directory: "/workspace" } }) } };
	await expect(setupTest(wrong, storage)).rejects.toThrow("ownership or workspace");
});

test("a rejected concurrent delegation cannot replace the active native tool context", async () => {
	const tools = new Map<string, Tool>();
	const backing = memoryStorage();
	let release!: () => void, seen!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const ready = new Promise<void>((resolve) => { seen = resolve; });
	let held = true, nativeContext: Context | undefined;
	const storage = { ...backing, set: async (key: string, value: unknown) => { if (held) { held = false; seen(); await gate; } await backing.set(key, value); } };
	await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: {
		hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx) => { nativeContext = ctx; return { output: { sessionID: "child", status: "completed", output: "done" } }; } }],
		transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
	} }, storage);
	const firstContext = { ...context("one"), marker: "first" }; const secondContext = { ...context("one"), marker: "second" };
	const first = tools.get("fusion_delegate")!.execute({ action: "execute", brief: "work" }, firstContext);
	await ready;
	await expect(tools.get("fusion_delegate")!.execute({ action: "revise", brief: "other" }, secondContext)).rejects.toThrow("already in progress");
	release(); await first;
	expect((nativeContext as (Context & { marker: string }) | undefined)?.marker).toBe("first");
});

test("a foreground result can be settled after a failed write without another native call", async () => {
	const tools = new Map<string, Tool>();
	const backing = memoryStorage();
	let fail = true, calls = 0;
	const storage = { ...backing, set: async (key: string, value: unknown) => {
		if (fail && !(value as { pending?: unknown }).pending) { fail = false; throw new Error("settlement write failed"); }
		await backing.set(key, value);
	} };
	await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: {
		hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => { calls++; return { output: { sessionID: "child", status: "completed", output: "report" } }; } }],
		transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
	} }, storage);
	await expect(tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"))).rejects.toThrow("settlement write failed");
	await expect(tools.get("fusion_reset")!.execute({}, context("one"))).rejects.toThrow("uncertain");
	expect((await tools.get("fusion_reconcile")!.execute({}, context("one"))).content).toContain("report");
	expect(calls).toBe(1);
	await tools.get("fusion_reset")!.execute({}, context("one"));
});

test("an archived settled request does not resurrect stale native intent on reload", async () => {
	const backing = memoryStorage();
	let key = "", stale: unknown;
	const storage = { ...backing, set: async (k: string, value: unknown) => {
		key = k;
		const record = value as { pending?: unknown; worker?: unknown };
		if (record.pending && record.worker) stale = structuredClone(value);
		await backing.set(k, value);
	} };
	const createContext = (tools: Map<string, Tool>): TestContext => ({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: {
		hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx) => { await ctx.progress({ sessionID: "child" }); return { output: { sessionID: "child", status: "completed", output: "done" } }; } }],
		transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
	} });
	const first = new Map<string, Tool>(); await setupTest(createContext(first), storage);
	await first.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
	await first.get("fusion_reset")!.execute({}, context("one"));
	expect(stale).toBeDefined(); await backing.set(key, stale);
	const restarted = new Map<string, Tool>(); await setupTest(createContext(restarted), storage);
	expect((await restarted.get("fusion_status")!.execute({}, context("one"))).content).toContain("No Fusion run");
});

test("shared terminal proof recovers after native storage fails across restart", async () => {
	const backing = memoryStorage(); let fail = false, calls = 0;
	const storage = { ...backing, set: async (key: string, value: unknown) => { if (fail) throw new Error("storage offline"); await backing.set(key, value); } };
	const makeContext = (tools: Map<string, Tool>): TestContext => ({ location: { directory: tmpdir() }, session: { context: async () => { throw new Error("notifications unavailable"); }, hook: async () => {} }, tool: {
		hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx) => { calls++; await ctx.progress({ sessionID: "child" }); fail = true; return { output: { sessionID: "child", status: "completed", output: "persisted report" } }; } }],
		transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
	} });
	const first = new Map<string, Tool>(); await setupTest(makeContext(first), storage);
	await expect(first.get("fusion_delegate")!.execute({ action: "execute", brief: "work" }, context("one"))).rejects.toThrow("storage offline");
	fail = false;
	const restored = new Map<string, Tool>(); await setupTest(makeContext(restored), storage);
	expect((await restored.get("fusion_reconcile")!.execute({}, context("one"))).content).toContain("persisted report");
	expect(calls).toBe(1);
	await restored.get("fusion_reset")!.execute({}, context("one"));
});

test("OpenCode v1 recovery is read-only until a write and preserves legacy metadata", async () => {
	const tools = new Map<string, Tool>(); const backing = memoryStorage();
	const workspace = tmpdir(); const key = `run/${createHash("sha256").update(workspace).digest("hex")}`;
	const legacy = { version: 1, harness: "opencode", workspace, parentSessionID: "one", childSessionID: "child", extra: "preserve me", state: { runActive: true, phase: "reviewing", task: "task", originalTask: "original", executorBrief: "brief", delegating: false, executed: true, revisions: 0, finalFixUsed: false, resumePending: false, scoutCalls: 0, settleNudges: 0 } };
	await backing.set(key, legacy); let writes = 0;
	const storage = { ...backing, set: async (k: string, value: unknown) => { writes++; await backing.set(k, value); } };
	await setupTest({ location: { directory: workspace }, session: { context: async () => [], hook: async () => {} }, tool: {
		hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }) }],
		transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
	} }, storage);
	expect(writes).toBe(0); expect(await backing.get(key)).toEqual(legacy);
	await tools.get("fusion_delegate")!.execute({ action: "revise", brief: "feedback" }, context("one"));
	const migrated = await backing.get(key) as { version: number; adapterData: { legacyOpenCode: unknown } };
	expect(migrated.version).toBe(2); expect(migrated.adapterData.legacyOpenCode).toEqual(legacy);
	await tools.get("fusion_reset")!.execute({}, context("one"));
});

test("reconciliation preserves retained evidence across reload", async () => {
	const root = await mkdtemp(join(tmpdir(), "fusion-evidence-reload-"));
	let host: { close(): void } | undefined;
	try {
		const init = await nodeGitExec(["init", "-q"], { cwd: root, timeout: 5000 });
		expect(init.code).toBe(0);
		await nodeGitExec(["-c", "user.name=Fusion Test", "-c", "user.email=fusion@example.invalid", "-c", "commit.gpgsign=false", `commit`, "--allow-empty", "-qm", "fixture"], { cwd: root, timeout: 5000 });
		const storage = memoryStorage();
		let fail = true, calls = 0;
		const faulty = { ...storage, set: async (key: string, value: unknown) => {
			if (fail && (value as { recovery?: string }).recovery === "settled") { fail = false; throw new Error("settlement write failed"); }
			await storage.set(key, value);
		} };
		const tools = new Map<string, Tool>();
		const build = async () => {
			await setupTest({ location: { directory: root }, session: { context: async () => [], hook: async () => {} }, tool: { hook: async () => {},
				list: async () => [{ id: "subagent", execute: async (_input, ctx) => {
					calls++;
					await ctx.progress({ sessionID: "child-1" });
					await writeFile(join(root, "worker-new.txt"), "evidence\n");
					return { output: { sessionID: "child-1", status: "completed", output: "report" } };
				} }],
				transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
			} }, faulty);
			return tools;
		};
		const first = await build();
		await expect(first.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"))).rejects.toThrow("settlement write failed");
		const hash = createHash("sha256").update(root).digest("hex");
		const firstManifest = readRunManifest(await faulty.get(`run/${hash}`), { harness: "opencode", workspace: root });
		expect(firstManifest.recovery).toBe("pending");
		expect(firstManifest.lastResult?.evidence).toEqual(["new:worker-new.txt"]);
		// Reload from the retained record, then reconcile without a native call.
		host?.close();
		host = await setupTest({ location: { directory: root }, session: { context: async () => [], hook: async () => {} }, tool: { hook: async () => {},
			list: async () => [{ id: "subagent", execute: async () => { calls++; throw new Error("native must not be called after reload"); } }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} }, storage);
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.uncertain).toBe(true);
		expect(status.childSessionID).toBe("child-1");
		const reconciled = await tools.get("fusion_reconcile")!.execute({}, context("one"));
		expect(reconciled.content).toContain("reconciled background turn");
		const manifest = readRunManifest(await storage.get(`run/${hash}`), { harness: "opencode", workspace: root });
		expect(manifest.recovery).toBe("settled");
		expect(manifest.lastResult?.evidence).toEqual(["new:worker-new.txt"]);
		expect(calls).toBe(1);
		await tools.get("fusion_reset")!.execute({}, context("one"));
	} finally { host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("shared settlement failure preserves the exact result and blocks another submission", async () => {
	const root = await mkdtemp(join(tmpdir(), "fusion-shared-fault-"));
	let host: { close(): void } | undefined;
	try {
		const workspace = tmpdir(); const tools = new Map<string, Tool>(); const storage = memoryStorage();
		const registry = await openWorkspaceRegistry(root); let fail = true, calls = 0;
		const openRegistry: typeof openWorkspaceRegistry = async () => ({ ...registry, claim: async (...args) => {
			const lease = await registry.claim(...args);
			return { get token() { return lease.token; }, get manifest() { return lease.manifest; }, close: () => lease.close(), release: () => lease.release(),
				save: async (value) => { if (fail && value.recovery === "settled") throw new Error("shared settlement unavailable"); await lease.save(value); } };
		} });
		host = await plugin.setup({ location: { directory: workspace }, storage, session: { context: async () => [], get: async ({ sessionID }) => ({ id: sessionID, parentID: "one", location: { directory: workspace } }), hook: async () => {} }, tool: {
				hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => { calls++; return { output: { sessionID: "child", status: "completed", output: "report" } }; } }],
				transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
			} }, { ownershipRoot: root, canonicalize: async (path) => path, openRegistry });
		await expect(tools.get("fusion_delegate")!.execute({ action: "execute", brief: "work" }, context("one"))).rejects.toThrow("shared settlement unavailable");
		const saved = (await registry.inspect(workspace))!.manifest;
		expect(saved.recovery).toBe("pending"); expect(saved.pending?.requestId).toBe(saved.lastResult?.requestId);
		await expect(tools.get("fusion_delegate")!.execute({ action: "execute", brief: "retry" }, context("one"))).rejects.toThrow("unknown outcome");
		fail = false;
		expect((await tools.get("fusion_reconcile")!.execute({}, context("one"))).content).toContain("report");
		expect(calls).toBe(1);
		await tools.get("fusion_reset")!.execute({}, context("one"));
	} finally { host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("scout guard capacity refuses new children without resetting live caps", async () => {
	const tools = new Map<string, Tool>();
	let before!: (event: { agent: string; tool: string; sessionID: string }) => void;
	await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: {
		hook: async (_name, callback) => { before = callback; },
		list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "scout-bg", status: "running", output: "" } }) }],
		transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
	} }, memoryStorage(), { scoutSettleTimeoutMs: 30 });
	await tools.get("fusion_scout")!.execute({ questions: ["q"] }, context("one"));
	const read = (sessionID: string) => before({ agent: "fusion-scout", tool: "read", sessionID });
	for (let i = 0; i < 20; i++) read("scout-bg");
	expect(() => read("scout-bg")).toThrow("Tool call limit reached");
	for (let i = 0; i < 7; i++) read(`other-${i}`);
	for (let i = 7; i < 10; i++) expect(() => read(`other-${i}`)).toThrow("tracking is full");
	expect(() => read("scout-bg")).toThrow("Tool call limit reached");
	// A scout call from another session is separate logical work: it is not
	// blocked by this session's unproven child, but the tracking capacity it
	// would need is full, so the guard-capacity refusal fires before any
	// submission.
	await expect(tools.get("fusion_scout")!.execute({ questions: ["q"] }, context("two"))).rejects.toThrow("tracking is full");
});

test("concurrent scouting preserves the pending executor's native call context", async () => {
	const tools = new Map<string, Tool>();
	let resume!: () => void, entered!: () => void;
	const gate = new Promise<void>((resolve) => { resume = resolve; });
	const ready = new Promise<void>((resolve) => { entered = resolve; });
	const storage = memoryStorage();
	let block = true;
	const faulty = { ...storage, set: async (key: string, value: unknown) => {
		if (block && (value as { pending?: unknown }).pending) { block = false; entered(); await gate; }
		await storage.set(key, value);
	} };
	const nativeCalls: { agent: string; callID: string }[] = [];
	await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: {
		hook: async () => {}, list: async () => [{ id: "subagent", execute: async (input, ctx) => {
			nativeCalls.push({ agent: input.agent, callID: (ctx as Context & { id: string }).id });
			return { output: { sessionID: input.agent === "fusion-scout" ? "scout-child" : "child", status: "completed", output: "done" } };
		} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
	} }, faulty);
	const executorContext = { ...context("one"), id: "executor-call" };
	const scoutContext = { ...context("one"), id: "scout-call" };
	const pending = tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, executorContext);
	try {
		await ready;
		await tools.get("fusion_scout")!.execute({ questions: ["q"] }, scoutContext);
	} finally { resume(); }
	await pending;
	expect(nativeCalls).toEqual([
		{ agent: "fusion-scout", callID: "scout-call" },
		{ agent: "fusion-executor", callID: "executor-call" },
	]);
	await tools.get("fusion_reset")!.execute({}, context("one"));
});

describe("native agent contribution", () => {
	type AgentRecord = { id: string; name: string; mode: "subagent" | "primary" | "all"; hidden: boolean; description?: string; system?: string; permissions?: { action: string; resource: string; effect: string }[] };
	/** Fake v2.2.5 agent editor: get reads current records; update-on-missing creates from a default draft. */
	const fakeEditor = (records: Map<string, AgentRecord>) => ({
		list: () => [...records.values()],
		get: (id: string) => records.get(id),
		default: () => {},
		remove: (id: string) => { records.delete(id); },
		update: (id: string, update: (agent: AgentRecord) => void) => {
			const draft: AgentRecord = records.get(id) ?? { id, name: id, mode: "primary", hidden: false, permissions: [] };
			update(draft);
			records.set(id, draft);
		},
	});
	const contributionHarness = async (records: Map<string, AgentRecord>) => {
		const tools = new Map<string, Tool>();
		let agentCallback!: (editor: ReturnType<typeof fakeEditor>) => void;
		let disposed = 0;
		const handle = await setupTest({
			location: { directory: "/workspace" },
			session: { context: async () => [], hook: async () => {} },
			command: { list: async () => ({ data: [] }), transform: async () => {} },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }) }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
			agent: {
				transform: async (callback: (editor: ReturnType<typeof fakeEditor>) => void) => { agentCallback = callback; return { dispose: async () => { disposed += 1; } }; },
				list: async () => [...records.values()],
			},
		});
		return { tools, replay: () => agentCallback(fakeEditor(records)), disposed: () => disposed, close: handle };
	};

	test("contributes fusion, fusion-executor, and fusion-scout through update-on-missing", async () => {
		const records = new Map<string, AgentRecord>();
		const { tools, replay } = await contributionHarness(records);
		replay();
		expect([...records.keys()].sort()).toEqual(["fusion", "fusion-executor", "fusion-scout"]);
		expect(records.get("fusion")!.mode).toBe("primary");
		expect(records.get("fusion-executor")!.mode).toBe("subagent");
		expect(records.get("fusion-scout")!.mode).toBe("subagent");
		expect(records.get("fusion")!.system).toContain("You are the Fusion supervisor.");
		expect(records.get("fusion")!.permissions).toContainEqual({ action: "subagent", resource: "*", effect: "deny" });
		expect(records.get("fusion")!.permissions).toContainEqual({ action: "subagent", resource: "fusion-executor", effect: "allow" });
		expect(records.get("fusion-scout")!.permissions!.every((rule) => rule.effect === "deny")).toBe(true);
		// Registry rebuilds replay the transform: contribution state stays deduplicated.
		replay();
		replay();
		const status = (await tools.get("fusion_status")!.execute({}, context("one"))).content;
		// No run exists yet: status falls to the no-run branch unless conflicts exist.
		expect(status).toBe("No Fusion run in this session.");
		expect(records.size).toBe(3);
	});

	test("an identical legacy markdown definition is accepted without conflict", async () => {
		const records = new Map<string, AgentRecord>();
		const { replay, tools } = await contributionHarness(records);
		replay();
		const contributed = records.get("fusion")!;
		records.clear();
		records.set("fusion", { ...contributed, permissions: [...contributed.permissions!.slice().reverse()] });
		replay();
		const status = (await tools.get("fusion_status")!.execute({}, context("one"))).content;
		expect(status).toBe("No Fusion run in this session.");
	});

	test("a conflicting legacy definition is reported and never overridden", async () => {
		const records = new Map<string, AgentRecord>();
		const { replay, tools } = await contributionHarness(records);
		replay();
		const original = records.get("fusion")!;
		records.set("fusion", { ...original, system: "an outdated supervisor prompt" });
		records.set("fusion-scout", { ...records.get("fusion-scout")!, description: "stale description" });
		replay();
		// The legacy values win (host precedence) and the conflict is surfaced.
		expect(records.get("fusion")!.system).toBe("an outdated supervisor prompt");
		const status = (await tools.get("fusion_status")!.execute({}, context("one"))).content;
		expect(status).toContain("Installed agent definitions override");
		expect(status).toContain("fusion (system)");
		expect(status).toContain("fusion-scout (description)");
	});

	test("hosts without the agent surface keep the legacy markdown installation path", async () => {
		const tools = new Map<string, Tool>();
		const close = await setupTest({
			location: { directory: "/workspace" },
			session: { context: async () => [], hook: async () => {} },
			command: { list: async () => ({ data: [] }), transform: async () => {} },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }) }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		});
		expect(tools.has("fusion_start")).toBe(true);
		const status = (await tools.get("fusion_status")!.execute({}, context("one"))).content;
		expect(status).toBe("No Fusion run in this session.");
		close.close();
	});

	test("close() disposes owned registrations", async () => {
		const records = new Map<string, AgentRecord>();
		const harness = await contributionHarness(records);
		harness.replay();
		harness.close.close();
		expect(harness.disposed()).toBeGreaterThanOrEqual(1);
	});
});

describe("/fusion-config command", () => {
	const catalogData = () => [
		{ providerID: "prov", id: "small", name: "Small", status: "active", enabled: true, cost: [{ output: 1 }] },
		{ providerID: "prov", id: "org/slash-model", name: "Slashed", status: "active", enabled: true, variants: [{ id: "low" }, { id: "high" }], cost: [{ output: 2 }] },
		{ providerID: "prov", id: "gone", name: "Disabled", status: "active", enabled: false, cost: [] },
		{ providerID: "other", id: "big", name: "Big", status: "active", enabled: true, cost: [{ output: 20 }] },
	];
	const harness = async (data = catalogData()) => {
		const tools = new Map<string, Tool>();
		const commands: CommandDefinition[] = [];
		const published: { sessionID: string; description?: string; text: string; resume?: boolean }[] = [];
		const storage = memoryStorage();
		const close = await setupTest({
			location: { directory: "/workspace" },
			model: { list: async () => ({ data }) },
			session: { context: async () => [], hook: async () => {}, synthetic: async (input) => { published.push(input); } },
			command: { list: async () => ({ data: [] }), transform: async (callback) => { await callback({ add: (command) => commands.push(command) }); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: '```json\n{"status":"done","summary":"ok","checks":[],"files_changed":[],"blockers":[]}\n```' } }) }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		}, storage);
		const config = commands.find((command) => command.name === "fusion-config")!;
		expect(config).toBeTruthy();
		return { tools, config, published, storage, close };
	};

	test("no arguments show the saved preference and syntax without creating a run", async () => {
		const { tools, config, published } = await harness();
		await config.execute({ sessionID: "one", prompt: { text: "" } });
		await config.execute({ sessionID: "one" });
		expect(published).toHaveLength(2);
		for (const entry of published) {
			expect(entry.description).toBe(`Fusion config\n${entry.text}`);
			expect(entry.text).toContain("Saved preference: none.");
			expect(entry.text).toContain("no run in this session");
			expect(entry.text).toContain("/fusion-config <provider>/<model> [variant]");
			expect(entry.text).toContain("executor and the scout share the chosen model");
		}
		// Read-only: no run materialized for the session.
		expect((await tools.get("fusion_status")!.execute({}, context("one"))).content).toBe("No Fusion run in this session.");
	});

	test("list shows validated choices with variants, filters, hides disabled entries, and bounds output", async () => {
		const many = [...catalogData(), ...Array.from({ length: 45 }, (_, index) => ({ providerID: "bulk", id: `m${index}`, name: `Bulk ${index}`, status: "active", enabled: true, cost: [] }))];
		const { config, published } = await harness(many);
		await config.execute({ sessionID: "one", prompt: { text: "list" } });
		const listing = published.at(-1)!;
		expect(listing.description).toBe(`Fusion config models\n${listing.text}`);
		expect(listing.text).toContain("showing the first 40");
		expect(listing.text).toContain("Narrow the output with /fusion-config list <filter>");
		await config.execute({ sessionID: "one", prompt: { text: "list slash" } });
		const filtered = published.at(-1)!.text;
		expect(filtered).toContain("prov/org/slash-model");
		expect(filtered).toContain("[variants: low, high]");
		expect(filtered).not.toContain("prov/gone");
		expect(filtered).not.toContain("bulk/m");
	});

	test("an explicit selection shares the tool's operation: applies now before work, persists, and reports shared use", async () => {
		const { config, published, tools } = await harness();
		await config.execute({ sessionID: "one", prompt: { text: "prov/org/slash-model low" } });
		expect(published.at(-1)!.text).toContain("configured for this run: prov/org/slash-model (variant low)");
		expect(published.at(-1)!.text).toContain("The scout uses its run's executor model");
		// The preference persisted: a fresh look shows it saved.
		await config.execute({ sessionID: "one", prompt: { text: "" } });
		expect(published.at(-1)!.text).toContain("Saved preference: prov/org/slash-model#low.");
		// Model IDs containing slashes parse on the first slash and reach the catalog.
		await config.execute({ sessionID: "one", prompt: { text: "prov/org/slash-model" } });
		expect(published.at(-1)!.text).toContain("prov/org/slash-model");
		// After executor work starts, the selection is saved for the next run.
		await tools.get("fusion_start")!.execute({ task: "Original task" }, context("one"));
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		await config.execute({ sessionID: "one", prompt: { text: "other/big" } });
		expect(published.at(-1)!.text).toContain("the next run (executor work has already started): other/big");
	});

	test("invalid selections change nothing and report the reason", async () => {
		const { config, published, tools } = await harness();
		await expect(config.execute({ sessionID: "one", prompt: { text: "prov/missing" } })).rejects.toThrow("not in the OpenCode model catalog");
		await expect(config.execute({ sessionID: "one", prompt: { text: "prov/small turbo" } })).rejects.toThrow("no variant");
		await expect(config.execute({ sessionID: "one", prompt: { text: "provsmall" } })).rejects.toThrow("Usage: /fusion-config");
		await expect(config.execute({ sessionID: "one", prompt: { text: "prov/small extra extra2" } })).rejects.toThrow("Too many arguments");
		await expect(config.execute({ sessionID: "one", prompt: { text: "prov/other/one two three" } })).rejects.toThrow("Too many arguments");
		await expect(config.execute({ sessionID: "one", prompt: { text: "/leading-slash" } })).rejects.toThrow("A model selection must be <provider>/<model>");
		// Nothing was persisted by the failed attempts.
		await config.execute({ sessionID: "one", prompt: { text: "" } });
		expect(published.at(-1)!.text).toContain("Saved preference: none.");
		expect((await tools.get("fusion_status")!.execute({}, context("one"))).content).toBe("No Fusion run in this session.");
	});

	test("a failed preference write stays retryable and changes nothing", async () => {
		// The storage failure path: a failing set must throw without changing
		// the preference, and a retry after the failure is repaired succeeds.
		const tools = new Map<string, Tool>();
		const commands: CommandDefinition[] = [];
		const published: { text: string }[] = [];
		const memory = memoryStorage();
		let failSet = true;
		const brokenStorage = { ...memory, set: async (key: string, value: unknown) => { if (failSet) throw new Error("disk full"); await memory.set(key, value); } };
		await setupTest({
			location: { directory: "/workspace" },
			model: { list: async () => ({ data: catalogData() }) },
			session: { context: async () => [], hook: async () => {}, synthetic: async (input) => { published.push(input); } },
			command: { list: async () => ({ data: [] }), transform: async (callback) => { await callback({ add: (command) => commands.push(command) }); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }) }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		}, brokenStorage);
		const configCommand = commands.find((command) => command.name === "fusion-config")!;
		await expect(configCommand.execute({ sessionID: "one", prompt: { text: "prov/small" } })).rejects.toThrow("disk full");
		// Retry after the failure is repaired: the same selection then succeeds.
		failSet = false;
		await configCommand.execute({ sessionID: "one", prompt: { text: "prov/small" } });
		expect(published.at(-1)!.text).toContain("prov/small");
	});

	test("an unavailable catalog refuses honestly for list and set", async () => {
		const { config } = await harness([]);
		await expect(config.execute({ sessionID: "one", prompt: { text: "list" } })).resolves.toBeTruthy();
		await expect(config.execute({ sessionID: "one", prompt: { text: "prov/small" } })).rejects.toThrow("not in the OpenCode model catalog");
	});

	test("a completed scout defers the model change to the next run", async () => {
		const { tools, config, published } = await harness();
		// The reviewer's repro: configure old, run a scout, configure new —
		// "this run" would misreport what the scout already used.
		const first = await tools.get("fusion_configure")!.execute({ provider: "other", model: "big" }, context("one"));
		expect(first.metadata?.applied).toBe("now");
		await tools.get("fusion_scout")!.execute({ questions: ["q"] }, context("one"));
		await config.execute({ sessionID: "one", prompt: { text: "prov/small" } });
		expect(published.at(-1)!.text).toContain("the next run (a scout has already run in this run): prov/small");
		// The run keeps its own model; only the saved preference moved.
		await config.execute({ sessionID: "one", prompt: { text: "" } });
		const view = published.at(-1)!.text;
		expect(view).toContain("Saved preference: prov/small.");
		expect(view).toContain("Current run: other/big.");
	});

	test("an in-flight scout defers the model change to the next run", async () => {
		const tools = new Map<string, Tool>();
		const commands: CommandDefinition[] = [];
		const published: { text: string }[] = [];
		let releaseScout!: () => void;
		const gate = new Promise<void>((resolve) => { releaseScout = resolve; });
		let scoutEntered = false;
		await setupTest({
			location: { directory: "/workspace" },
			model: { list: async () => ({ data: catalogData() }) },
			session: { context: async () => [], hook: async () => {}, synthetic: async (input) => { published.push(input); } },
			command: { list: async () => ({ data: [] }), transform: async (callback) => { await callback({ add: (command) => commands.push(command) }); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async (input) => {
				if (input.agent === "fusion-scout") { scoutEntered = true; await gate; }
				return { output: { sessionID: input.agent === "fusion-scout" ? "scout-child" : "child", status: "completed", output: input.agent === "fusion-scout" ? "answer" : "done" } };
			} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		});
		const configCommand = commands.find((command) => command.name === "fusion-config")!;
		const scout = tools.get("fusion_scout")!;
		const inFlight = scout.execute({ questions: ["q"] }, context("one"));
		for (let i = 0; i < 500 && !scoutEntered; i++) await new Promise((resolve) => setTimeout(resolve, 10));
		expect(scoutEntered).toBe(true);
		await configCommand.execute({ sessionID: "one", prompt: { text: "prov/small" } });
		expect(published.at(-1)!.text).toContain("the next run (a Fusion scout is still running): prov/small");
		releaseScout();
		await inFlight;
		// After the scout finishes, the deferral reason reflects its history.
		await configCommand.execute({ sessionID: "one", prompt: { text: "other/big" } });
		expect(published.at(-1)!.text).toContain("the next run (a scout has already run in this run): other/big");
	});
});

test("compact delegation forwards the full brief and scoped live activity while keeping native ownership", async () => {
	const tools = new Map<string, Tool>();
	const updates: Record<string, unknown>[] = [];
	const queue: { type: string; data: Record<string, unknown> }[] = [];
	let wake: (() => void) | undefined;
	let received = "";
	const resultText = '```json\n{"status":"done","summary":"ok","checks":[],"files_changed":[],"blockers":[]}\n```';
	await setupTest({
		location: { directory: "/workspace" },
		session: { context: async () => [], hook: async () => {} },
		event: { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = queue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { wake = resolve; }); } } }; } }) },
		tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async (input, nativeContext) => {
			expect(nativeContext.sessionID).toBe("one");
			expect((nativeContext as Context & { id: string }).id).toBe("parent-call");
			received = input.prompt;
			await nativeContext.progress({ sessionID: "child" });
			for (const sessionID of ["unrelated-child", "child"]) queue.push(
				{ type: "session.tool.input.started", data: { sessionID, id: "edit-call", name: "edit" } },
				{ type: "session.tool.called", data: { sessionID, id: "edit-call", input: { secret: "not-for-progress" } } },
				{ type: "session.tool.success", data: { sessionID, id: "edit-call", content: "not-for-progress" } },
			);
			wake?.();
			await new Promise((resolve) => setTimeout(resolve, 25));
			return { output: { sessionID: "child", status: "completed", output: resultText } };
		} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
	});
	const ctx = { ...context("one"), id: "parent-call", progress: async (update: Record<string, unknown>) => { updates.push(update); } };
	const brief = "Implement this complete multi-line brief.\nDo not drop any of its details.";
	const result = await tools.get("fusion_delegate")!.execute({ action: "execute", title: "Implement objects", details: { brief, originalTask: "Object operations" } }, ctx);
	expect(received).toContain(brief);
	expect(result.metadata?.fusion).toMatchObject({ action: "execute", title: "Implement objects", phase: "completed", tools: 1, childSessionID: "child" });
	expect(updates.some((update) => (update.fusion as { activity?: string })?.activity === "Running edit")).toBe(true);
	expect(JSON.stringify(updates)).not.toContain("not-for-progress");
});

describe("/fusion-doctor command", () => {
	type DoctorAgentRecord = { id: string; name: string; mode: "subagent" | "primary" | "all"; hidden: boolean; description?: string; system?: string; permissions?: { action: string; resource: string; effect: string }[] };
	type DoctorEditor = { list(): DoctorAgentRecord[]; get(id: string): DoctorAgentRecord | undefined; default(id: string | undefined): void; update(id: string, update: (agent: DoctorAgentRecord) => void): void; remove(id: string): void };
	const ALL_FUSION_COMMANDS = ["fusion-run", "fusion-mode", "fusion-config", "fusion-budget", "fusion-status", "fusion-stats", "fusion-resume", "fusion-clean", "fusion-stop", "fusion-doctor"];
	const doctorHarness = async (options: {
		appVersion?: string;
		commandNames?: string[];
		/** contribute: transform replayed with an update-on-missing editor;
		 * silent: transform captured but never replayed, no registry list;
		 * listed: registry list available but empty (nothing visible);
		 * absent: no agent surface at all. */
		agentMode?: "contribute" | "silent" | "listed" | "absent";
		modelPreference?: { provider: string; modelId: string; variant?: string };
		interrupt?: boolean;
	} = {}) => {
		const tools = new Map<string, Tool>();
		const commands: CommandDefinition[] = [];
		const published: { sessionID: string; description?: string; text: string; resume?: boolean }[] = [];
		const storage = memoryStorage();
		const records = new Map<string, DoctorAgentRecord>();
		const nativeCalls: string[] = [];
		const catalog = [
			{ providerID: "prov", id: "glm-5", name: "GLM 5", status: "active", enabled: true, cost: [{ output: 1 }] },
			{ providerID: "other", id: "big", name: "Big", status: "active", enabled: true, cost: [{ output: 20 }] },
		];
		if (options.modelPreference) {
			const modelKey = `model/${createHash("sha256").update("/workspace").digest("hex")}`;
			await storage.set(modelKey, options.modelPreference);
		}
		let agentCallback: ((editor: DoctorEditor) => void) | undefined;
		const agentSurface = options.agentMode === "absent" ? {} : {
			agent: {
				transform: async (callback: (editor: DoctorEditor) => void) => { agentCallback = callback; return { dispose: async () => {} }; },
				...(options.agentMode === "listed" || options.agentMode === "contribute" ? { list: async () => [...records.values()] } : {}),
			},
		};
		const close = await setupTest({
			location: { directory: "/workspace" },
			model: { list: async () => ({ data: catalog }) },
			...(options.appVersion !== undefined ? { app: { version: options.appVersion } } : {}),
			session: { context: async () => [], hook: async () => {}, synthetic: async (input) => { published.push(input); }, ...(options.interrupt ? { interrupt: async () => {} } : {}) },
			command: {
				list: async () => ({ data: (options.commandNames ?? ALL_FUSION_COMMANDS).map((name) => ({ name, description: name })) }),
				transform: async (callback) => { await callback({ add: (command) => commands.push(command) }); },
			},
			tool: {
				hook: async () => {},
				// The executor refuses every call: the doctor must never run it.
				list: async () => [{ id: "subagent", execute: async () => { nativeCalls.push("call"); throw new Error("the doctor must not execute the executor"); } }],
				transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
			},
			...agentSurface,
		}, storage);
		if (options.agentMode === "contribute" && agentCallback) {
			// Replay the transform like a registry rebuild with an editor whose
			// update-on-missing creates the agents (the pinned v2.2.5 shape).
			const editor: DoctorEditor = {
				list: () => [...records.values()],
				get: (id: string) => records.get(id),
				default: () => {},
				remove: (id: string) => { records.delete(id); },
				update: (id: string, update: (agent: DoctorAgentRecord) => void) => {
					const draft: DoctorAgentRecord = records.get(id) ?? { id, name: id, mode: "primary", hidden: false, permissions: [] };
					update(draft);
					records.set(id, draft);
				},
			};
			agentCallback(editor);
		}
		const doctor = commands.find((command) => command.name === "fusion-doctor")!;
		expect(doctor).toBeTruthy();
		return { tools, commands, published, doctor, records, nativeCalls, storage, close };
	};
	const doctorText = (published: { description?: string; text: string }[]) => published.at(-1)!.text;

	test("the default report is local, read-only, and covers versions, mode, tools, agents, models, backend, ownership, and recovery", async () => {
		const { doctor, published, nativeCalls, tools } = await doctorHarness({ appVersion: "v2.2.5", agentMode: "contribute", modelPreference: { provider: "prov", modelId: "glm-5" }, interrupt: true });
		await doctor.execute({ sessionID: "one" });
		const text = doctorText(published);
		expect(published.at(-1)!.description).toBe(`Fusion doctor\n${text}`);
		expect(text).toContain("Fusion doctor (opencode, fusion-harness-extension@0.1.4): 8 ok");
		expect(text).toContain("Fusion fusion-harness-extension@0.1.4 | host v2.2.5 (supported v2.2.3 – v2.2.5)");
		expect(text).toContain("ok — Mode: persistent mode off");
		expect(text).toContain("ok — Tools:");
		expect(text).toContain("ok — Agents: fusion, fusion-executor, fusion-scout available (plugin-contributed)");
		expect(text).toContain("ok — Models: prov/glm-5 in the catalog");
		expect(text).toContain("the supervisor's model stays OpenCode's own selector");
		expect(text).toContain("ok — Backend: OpenCode native subagent available");
		expect(text).toContain("worker abort available");
		expect(text).toContain("ok — Ownership storage:");
		expect(text).toContain("ready, 0 owned records");
		expect(text).toContain("ok — Recovery: no interrupted runs");
		// Zero model calls: the executor never ran and no run materialized.
		expect(nativeCalls).toEqual([]);
		expect((await tools.get("fusion_status")!.execute({}, context("one"))).content).toBe("No Fusion run in this session.");
	});

	test("a host outside the supported range warns with the re-pin fix", async () => {
		const { doctor, published } = await doctorHarness({ appVersion: "2.3.0", agentMode: "absent" });
		await doctor.execute({ sessionID: "one" });
		const text = doctorText(published);
		expect(text).toContain("warn — Versions: Fusion fusion-harness-extension@0.1.4 | host 2.3.0 (supported v2.2.3 – v2.2.5)");
		expect(text).toContain("re-pinned and its surfaces reverified");
		expect(text).toContain("docs/install.md");
	});

	test("a configured model missing from the live catalog fails with the reused resolver's message", async () => {
		const { doctor, published, nativeCalls } = await doctorHarness({ modelPreference: { provider: "prov", modelId: "missing" } });		await doctor.execute({ sessionID: "one" });
		const text = doctorText(published);
		expect(text).toContain("FAIL — Models: executor prov/missing");
		expect(text).toContain('"prov/missing" is not in the OpenCode model catalog');
		expect(text).toContain("fix: Re-select a catalog model: /fusion-config list [filter]");
		expect(nativeCalls).toEqual([]);
	});

	test("missing agent contributions and absent commands warn with restart and version fixes", async () => {
		// The transform is captured but never replayed and no registry list
		// exists: the contribution produced nothing observable.
		const { doctor, published, nativeCalls } = await doctorHarness({ agentMode: "silent", commandNames: ["other-command"] });
		await doctor.execute({ sessionID: "one" });
		const text = doctorText(published);
		expect(text).toContain("warn — Agents:");
		expect(text).toContain("Fusion's contribution registered no agents");
		expect(text).toContain("Restart the host and reinstall");
		expect(text).toContain("warn — Tools:");
		expect(text).toContain("the host command registry does not list: fusion-run");
		expect(text).toContain("fusion-doctor");
		expect(nativeCalls).toEqual([]);

		// With a registry list that shows nothing, the agents are "not visible"
		// and the fix points at a restart or reinstall.
		const listed = await doctorHarness({ agentMode: "listed" });
		await listed.doctor.execute({ sessionID: "one" });
		const listedText = doctorText(listed.published);
		expect(listedText).toContain("warn — Agents:");
		expect(listedText).toContain("not visible to the host");
		expect(listedText).toContain("Restart the host or reinstall Fusion's agents");
	});

	test("a foreign workspace owner is a recovery conflict routed to the owning session", async () => {
		const { doctor, published, nativeCalls, storage } = await doctorHarness({});
		// Another supervisor's record, claimed directly in the shared registry.
		const root = ownershipFixtures.get(storage)!.root;
		const registry = await openWorkspaceRegistry(root);
		const manifest = readRunManifest({
			version: 2, runId: "opencode:foreign", owner: { harness: "opencode", supervisorId: "other-session", workspace: "/workspace" },
			state: { runActive: true, phase: "failed", task: "t", originalTask: "t", executorBrief: "b", executed: true, revisions: 0, finalFixUsed: false, delegating: false, resumePending: false, scoutCalls: 0, settleNudges: 0 },
			capabilities: { transcriptReopen: true, activeTurnReattach: false, durableExecution: false, idempotentSubmission: false, readOnlyScout: true, exactScoutToolLimit: true, workerAbort: true, workerEvents: true },
			recovery: "pending", pending: { action: "execute", requestId: "foreign-request" },
		}, { harness: "opencode", workspace: "/workspace" });
		await registry.claim(manifest);
		published.length = 0;
		await doctor.execute({ sessionID: "one" });
		const text = doctorText(published);
		expect(text).toContain("warn — Recovery:");
		expect(text).toContain("another session owns this workspace (run opencode:foreign, owner opencode:other-session)");
		expect(text).toContain("Recovery: recover in the owning session");
		expect(text).toContain("--confirm-stopped");
		expect(nativeCalls).toEqual([]);
	});

	test("a same-session record retained without a live run is a recovery conflict, not a healthy workspace", async () => {
		const { doctor, published, nativeCalls, storage } = await doctorHarness({});
		// A record this session owns, seeded after setup so no live run exists
		// here: the retained request must be reported instead of a healthy
		// workspace.
		const root = ownershipFixtures.get(storage)!.root;
		const registry = await openWorkspaceRegistry(root);
		const ownManifest = (recovery: "pending" | "manual", withPending: boolean) => readRunManifest({
			version: 2, runId: `opencode:own-${recovery}`, owner: { harness: "opencode", supervisorId: "one", workspace: "/workspace" },
			state: { runActive: true, phase: "failed", task: "t", originalTask: "t", executorBrief: "b", executed: true, revisions: 0, finalFixUsed: false, delegating: false, resumePending: false, scoutCalls: 0, settleNudges: 0 },
			capabilities: { transcriptReopen: true, activeTurnReattach: false, durableExecution: false, idempotentSubmission: false, readOnlyScout: true, exactScoutToolLimit: true, workerAbort: true, workerEvents: true },
			recovery, ...(withPending ? { pending: { action: "execute" as const, requestId: "retained-request" } } : {}),
		}, { harness: "opencode", workspace: "/workspace" });
		await registry.claim(ownManifest("pending", true));
		published.length = 0;
		await doctor.execute({ sessionID: "one" });
		let text = doctorText(published);
		expect(text).toContain("warn — Recovery:");
		expect(text).toContain("the persisted run record retains a pending execute request (retained-request)");
		expect(text).not.toContain("no interrupted runs, pending requests, or foreign owners");
		expect(text).toContain("Recovery: no exact completion proof can be adopted");
		expect(nativeCalls).toEqual([]);

		// The manual-recovery shape (uncertain without a retained request)
		// is a conflict of its own, never a healthy reading.
		const second = await doctorHarness({});
		const manualRegistry = await openWorkspaceRegistry(ownershipFixtures.get(second.storage)!.root);
		await manualRegistry.claim(ownManifest("manual", false));
		await second.doctor.execute({ sessionID: "one" });
		const manualText = doctorText(second.published);
		expect(manualText).toContain("warn — Recovery:");
		expect(manualText).toContain("the persisted run record owes manual recovery without exact request proof");
		expect(manualText).not.toContain("no interrupted runs, pending requests, or foreign owners");
	});

	test("the explicit auth probe explains that this host validates credentials only through a model request", async () => {
		const { doctor, published, nativeCalls } = await doctorHarness({});
		await doctor.execute({ sessionID: "one", prompt: { text: "auth" } });
		const text = doctorText(published);
		expect(text).toContain("No Fusion model carries a locally readable credential posture on this host.");
		expect(text).toContain("This host exposes no local credential validation to the plugin");
		expect(text).toContain("never issues a model request");
		expect(nativeCalls).toEqual([]);
		// Unknown arguments are refused with the usage.
		await expect(doctor.execute({ sessionID: "one", prompt: { text: "deep-scan" } })).rejects.toThrow("Usage: /fusion-doctor [auth]");
	});
});

describe("owned executor stop", () => {
	const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
	const result = { output: { sessionID: "child-stop", status: "completed", output: "partial result" } };

	test("interrupts only the owned child, keeps pending work, and confirms only a fresh terminal", async () => {
		const tools = new Map<string, Tool>();
		const notices: { resume?: boolean; metadata?: Record<string, unknown> }[] = [];
		const interrupts: { sessionID: string; resume?: boolean }[] = [];
		const queue: { type: string; created: number; data: { sessionID: string } }[] = [];
		let wake: (() => void) | undefined, entered!: () => void;
		const ready = new Promise<void>((resolve) => { entered = resolve; });
		await setupTest({ location: { directory: "/workspace" },
			event: { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = queue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { wake = resolve; }); } } }; } }) },
			session: { context: async () => [], hook: async () => {}, synthetic: async (input) => { notices.push(input); }, interrupt: async (input) => { interrupts.push(input); return { interrupted: true }; } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx) => {
				await ctx.progress({ sessionID: "child-stop" }); entered();
				return await new Promise<never>((_resolve, reject) => { ctx.signal.addEventListener("abort", () => reject(new Error("cancelled by stop")), { once: true }); });
			} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		});
		const pending = tools.get("fusion_delegate")!.execute({ action: "execute", brief: "work" }, context("one")).catch((error) => String(error));
		await ready;
		await expect(tools.get("fusion_stop")!.execute({}, context("two"))).rejects.toThrow("another session");
		await expect(tools.get("fusion_stop")!.execute({}, context("one", "build"))).rejects.toThrow("primary agent");
		expect(interrupts).toHaveLength(0);
		const response = await tools.get("fusion_stop")!.execute({ reason: "User asked to stop" }, context("one"));
		expect(response.content).toContain("not confirmed");
		expect(interrupts).toEqual([{ sessionID: "child-stop", resume: false }]);
		await pending;
		const status = async () => JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect((await status()).pending).toBeTruthy();
		const requestedAt = (response.metadata!.stop as { requestedAt: number }).requestedAt;
		queue.push({ type: "session.execution.interrupted", created: requestedAt - 1, data: { sessionID: "child-stop" } }, { type: "session.execution.interrupted", created: Date.now(), data: { sessionID: "unrelated-child" } }); wake?.(); await tick();
		expect((await status()).stop.state).toBe("acknowledged");
		queue.push({ type: "session.execution.interrupted", created: Date.now(), data: { sessionID: "child-stop" } }); wake?.(); await tick();
		expect((await status()).stop).toMatchObject({ state: "confirmed", terminal: "cancelled" });
		expect((await status()).pending).toBeTruthy();
		await expect(tools.get("fusion_delegate")!.execute({ action: "revise", brief: "retry" }, context("one"))).rejects.toThrow("was stopped");
		await expect(tools.get("fusion_reset")!.execute({}, context("one"))).rejects.toThrow("uncertain");
		expect(notices.length).toBeGreaterThan(0);
		expect(notices.every((notice) => notice.resume === false)).toBe(true);
	});

	test.each(["unsupported", "foreign"])("reports %s interruption honestly without releasing uncertainty", async (scenario) => {
		const tools = new Map<string, Tool>();
		let interruptions = 0;
		await setupTest({ location: { directory: "/workspace" }, session: { context: async () => [], hook: async () => {},
			...(scenario === "foreign" ? { get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, parentID: "another-supervisor", location: { directory: "/workspace" } }), interrupt: async () => { interruptions++; } } : {}),
		}, tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { ...result.output, status: "running" } }) }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } } });
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "work" }, context("one"));
		const response = await tools.get("fusion_stop")!.execute({}, context("one"));
		expect(response.metadata?.stop).toMatchObject({ state: "failed" });
		expect(response.content).toContain("not confirmed");
		expect(interruptions).toBe(0);
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.uncertain).toBe(true);
		expect(status.pending).toBeTruthy();
	});

	test("queues a stop before the native child is published", async () => {
		const tools = new Map<string, Tool>();
		let entered!: () => void, publish!: () => void;
		const ready = new Promise<void>((resolve) => { entered = resolve; });
		const gate = new Promise<void>((resolve) => { publish = resolve; });
		const interrupted: string[] = [];
		await setupTest({ location: { directory: "/workspace" }, session: { context: async () => [], hook: async () => {}, interrupt: async ({ sessionID }) => { interrupted.push(sessionID); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx) => { entered(); await gate; await ctx.progress({ sessionID: "child-stop" }); return { output: { ...result.output, status: "running" } }; } }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		});
		const pending = tools.get("fusion_delegate")!.execute({ action: "execute", brief: "work" }, context("one"));
		await ready;
		const response = await tools.get("fusion_stop")!.execute({}, context("one"));
		expect(response.metadata?.stop).toMatchObject({ state: "requested" });
		expect(interrupted).toHaveLength(0);
		publish(); await pending; await tick();
		expect(interrupted).toEqual(["child-stop"]);
	});

	test("fusion_stop interrupts a live scout child within the run scope", async () => {
		const tools = new Map<string, Tool>();
		const queue: { type: string; created: number; data: { sessionID: string } }[] = [];
		const interrupted: string[] = [];
		let wake: (() => void) | undefined, entered!: () => void;
		const ready = new Promise<void>((resolve) => { entered = resolve; });
		const event = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = queue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { wake = resolve; }); } } }; } }) };
		await setupTest({ location: { directory: "/workspace" },
			event,
			session: { context: async () => [], hook: async () => {}, synthetic: async () => {}, interrupt: async ({ sessionID }) => { interrupted.push(sessionID); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx) => {
				await ctx.progress({ sessionID: "scout-child" }); entered();
				return await new Promise((resolve) => { void event; });
			} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		});
		const scouting = tools.get("fusion_scout")!.execute({ questions: ["Where is the run marker?"] }, context("one")).catch((error) => String(error));
		await ready;
		await tick(); // let the child's reference publication settle before stopping
		const response = await tools.get("fusion_stop")!.execute({ reason: "Stop the run" }, context("one"));
		// The executor had nothing unsettled; the scout child was interrupted.
		expect(response.content).toContain("not confirmed");
		expect(response.content).toContain("Scout interruption delivered; termination is not confirmed.");
		expect(interrupted).toEqual(["scout-child"]);
		const stop = response.metadata?.stop as { state?: string; scouts?: { state: string; childSessionID?: string }[] };
		expect(stop.state).toBe("not-submitted");
		expect(stop.scouts?.[0]).toMatchObject({ state: "acknowledged", childSessionID: "scout-child" });
		// Each worker reports separately; the terminal child event confirms the scout record.
		// Event times anchor off the recorded stop request so same-millisecond
		// ties can never read as stale delivery.
		const requestedAt = (response.metadata?.stop as { requestedAt: number }).requestedAt;
		queue.push({ type: "session.execution.interrupted", created: requestedAt + 1, data: { sessionID: "scout-child" } }); wake?.();
		// The bus delivery is async on the host; wait bounded for the record to confirm.
		let confirmed: string | undefined;
		for (let i = 0; i < 12 && !confirmed; i++) {
			const parsed = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
			const record = parsed.stop?.scouts?.[0];
			if (record?.state === "confirmed") confirmed = record.terminal;
			if (!confirmed) { wake?.(); await tick(); }
		}
		expect(confirmed).toBe("cancelled");
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.stop.scouts[0]).toMatchObject({ state: "confirmed", terminal: "cancelled", childSessionID: "scout-child" });
		expect((await tools.get("fusion_status")!.execute({}, context("one"))).content).toContain("Scout turn stopped (cancelled)");
		// No further scout work runs on the stopped run.
		await expect(tools.get("fusion_scout")!.execute({ questions: ["more?"] }, context("one"))).rejects.toThrow("This Fusion run was stopped");
	});

	test("a queued scout delivery completes when its child publishes and starts", async () => {
		const tools = new Map<string, Tool>();
		const queue: { type: string; created: number; data: { sessionID: string } }[] = [];
		const interrupted: string[] = [];
		let wake: (() => void) | undefined, entered!: () => void, publish!: () => void;
		const ready = new Promise<void>((resolve) => { entered = resolve; });
		const gate = new Promise<void>((resolve) => { publish = resolve; });
		const event = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = queue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { wake = resolve; }); } } }; } }) };
		await setupTest({ location: { directory: "/workspace" },
			event,
			session: { context: async () => [], hook: async () => {}, synthetic: async () => {}, interrupt: async ({ sessionID }) => { interrupted.push(sessionID); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx) => { entered(); await gate; await ctx.progress({ sessionID: "queued-scout" }); return await new Promise((resolve) => { void resolve; }); } }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		});
		const scouting = tools.get("fusion_scout")!.execute({ questions: ["Where?"] }, context("one")).catch((error) => String(error));
		await ready;
		const response = await tools.get("fusion_stop")!.execute({ reason: "Stop early" }, context("one"));
		// The child reference was not published yet, so the delivery can only queue.
		expect(response.content).toContain("Scout stop queued; waiting for its child reference. Termination is not confirmed yet.");
		expect(interrupted).toHaveLength(0);
		const stop = response.metadata?.stop as { scouts?: { state: string; childSessionID?: string; requestId?: string }[] };
		expect(stop.scouts?.[0]).toMatchObject({ state: "requested" });
		expect(stop.scouts?.[0].childSessionID).toBeUndefined();
		publish(); await tick().then(tick);
		// The record adopts the published child through the queued-request id
		// and dispatches its queued interruption immediately — no later
		// execution-start event is needed for the delivery to go out.
		let adopted: { state?: string; childSessionID?: string } | undefined;
		for (let i = 0; i < 12; i++) {
			const parsed = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
			const record = parsed.stop?.scouts?.[0];
			if (record?.childSessionID === "queued-scout" && record.state === "acknowledged") { adopted = record; break; }
			wake?.(); await tick();
		}
		expect(adopted).toMatchObject({ state: "acknowledged", childSessionID: "queued-scout" });
		expect(interrupted).toEqual(["queued-scout"]);
	});

	test("a rejected scout interruption is reported as failed, never acknowledged", async () => {
		const tools = new Map<string, Tool>();
		const queue: { type: string; created: number; data: { sessionID: string } }[] = [];
		let wake: (() => void) | undefined, entered!: () => void;
		const ready = new Promise<void>((resolve) => { entered = resolve; });
		const event = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = queue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { wake = resolve; }); } } }; } }) };
		await setupTest({ location: { directory: "/workspace" },
			event,
			session: { context: async () => [], hook: async () => {}, synthetic: async () => {}, interrupt: async ({ sessionID }) => { throw new Error("host interrupt rejected"); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx) => { await ctx.progress({ sessionID: "rejected-scout" }); entered(); return await new Promise((resolve) => { void resolve; }); } }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		});
		const scouting = tools.get("fusion_scout")!.execute({ questions: ["Where?"] }, context("one")).catch((error) => String(error));
		await ready;
		await tick();
		const response = await tools.get("fusion_stop")!.execute({ reason: "Stop the scout" }, context("one"));
		// The host's interrupt rejected: delivery is a failure with its error,
		// not an acknowledgement.
		expect(response.content).toContain("Scout stop failed: host interrupt rejected. Termination is not confirmed.");
		const stop = response.metadata?.stop as { scouts?: { state: string; error?: string }[] };
		expect(stop.scouts?.[0]).toMatchObject({ state: "failed", error: "host interrupt rejected" });
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.stop.scouts[0]).toMatchObject({ state: "failed", error: "host interrupt rejected" });
	});

	test("a scout interruption that times out stays requested, never acknowledged", async () => {
		const tools = new Map<string, Tool>();
		let entered!: () => void;
		const ready = new Promise<void>((resolve) => { entered = resolve; });
		await setupTest({ location: { directory: "/workspace" },
			session: { context: async () => [], hook: async () => {}, synthetic: async () => {}, interrupt: async () => new Promise(() => {}) },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx) => { await ctx.progress({ sessionID: "slow-scout" }); entered(); return await new Promise((resolve) => { void resolve; }); } }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		});
		const scouting = tools.get("fusion_scout")!.execute({ questions: ["Where?"] }, context("one")).catch((error) => String(error));
		await ready;
		const response = await tools.get("fusion_stop")!.execute({ reason: "Stop the slow scout" }, context("one"));
		// The bounded wait elapsed without the interruption settling: the
		// delivery stays an unconfirmed "requested", never an acknowledgement.
		const stop = response.metadata?.stop as { scouts?: { state: string }[] };
		expect(stop.scouts?.[0]).toMatchObject({ state: "requested" });
		expect(response.content).toContain("Scout interruption requested; termination is not confirmed.");
		// The parked interruption operation stays in flight beyond this test;
		// the scout tool call never completes and must not be awaited here.
	});

	test("a timed-out scout interruption is shared by a repeated stop and catches its record up when the delivery settles", async () => {
		const tools = new Map<string, Tool>();
		const interrupts: string[] = [];
		let entered!: () => void, releaseInterrupt: (() => void) | undefined;
		const ready = new Promise<void>((resolve) => { entered = resolve; });
		await setupTest({ location: { directory: "/workspace" },
			session: { context: async () => [], hook: async () => {}, synthetic: async () => {}, interrupt: async ({ sessionID }) => { interrupts.push(sessionID); await new Promise<void>((resolve) => { releaseInterrupt = resolve; }); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx) => { await ctx.progress({ sessionID: "parked-scout" }); entered(); return await new Promise((resolve) => { void resolve; }); } }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		});
		const scouting = tools.get("fusion_scout")!.execute({ questions: ["Where?"] }, context("one")).catch((error) => String(error));
		await ready;
		const first = await tools.get("fusion_stop")!.execute({ reason: "Stop the scout" }, context("one"));
		// The bounded wait elapsed: the delivery stays requested.
		expect((first.metadata?.stop as { scouts?: { state: string }[] }).scouts?.[0]).toMatchObject({ state: "requested" });
		// A repeated stop awaits the in-flight attempt instead of starting
		// another one.
		const second = await tools.get("fusion_stop")!.execute({ reason: "Stop again" }, context("one"));
		expect((second.metadata?.stop as { scouts?: { state: string }[] }).scouts?.[0]).toMatchObject({ state: "requested" });
		expect(interrupts).toEqual(["parked-scout"]);
		// When the parked delivery finally settles, the flight's follower
		// classifies the record — the late delivery is not lost.
		releaseInterrupt?.();
		let late: { state?: string } | undefined;
		for (let i = 0; i < 40 && !late; i++) {
			const parsed = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
			if (parsed.stop?.scouts?.[0]?.state === "acknowledged") late = parsed.stop.scouts[0];
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(late).toMatchObject({ state: "acknowledged" });
		expect(interrupts).toEqual(["parked-scout"]);
	}, 20000);

	test("cancelling the supervisor requests child interruption and suppresses continuation nudges", async () => {
		const tools = new Map<string, Tool>();
		const queue: { type: string; data: { sessionID: string } }[] = [];
		const nudges: unknown[] = [], interrupted: string[] = [];
		let wake: (() => void) | undefined, entered!: () => void;
		let hook!: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void;
		const ready = new Promise<void>((resolve) => { entered = resolve; });
		await setupTest({ location: { directory: "/workspace" },
			event: { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = queue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { wake = resolve; }); } } }; } }) },
			session: { context: async () => [], hook: async (_name, callback) => { hook = callback; }, prompt: async (input) => { if (input.id?.startsWith("msg_fusion_nudge")) nudges.push(input); }, interrupt: async ({ sessionID }) => { interrupted.push(sessionID); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx) => { await ctx.progress({ sessionID: "child-stop" }); entered(); return await new Promise<never>((_resolve, reject) => { ctx.signal.addEventListener("abort", () => reject(new Error("parent cancelled")), { once: true }); }); } }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		});
		const cancellation = new AbortController();
		const pending = tools.get("fusion_delegate")!.execute({ action: "execute", brief: "work" }, { ...context("one"), signal: cancellation.signal }).catch(() => undefined);
		await ready;
		cancellation.abort();
		await pending;
		await tick();
		hook({ agent: "fusion", tools: {}, sessionID: "one" });
		queue.push({ type: "session.execution.succeeded", data: { sessionID: "one" } }); wake?.();
		await tick();
		expect(interrupted).toEqual(["child-stop"]);
		expect(nudges).toHaveLength(0);
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.pending).toBeTruthy();
		expect(status.stop.state).toBe("acknowledged");
	});

	test("a slow persistence write cannot prevent a pre-submission stop", async () => {
		const tools = new Map<string, Tool>();
		const memory = memoryStorage();
		let release!: () => void, entered!: () => void, block = true, calls = 0;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const ready = new Promise<void>((resolve) => { entered = resolve; });
		const storage = { ...memory, set: async (key: string, value: unknown) => { if (key.startsWith("run/") && block) { block = false; entered(); await gate; } await memory.set(key, value); } };
		await setupTest({ location: { directory: "/workspace" }, session: { context: async () => [], hook: async () => {} }, tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => { calls++; return result; } }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } } }, storage);
		const pending = tools.get("fusion_delegate")!.execute({ action: "execute", brief: "work" }, context("one")).catch((error) => String(error));
		await ready;
		const stopped = await tools.get("fusion_stop")!.execute({}, context("one"));
		expect(stopped.metadata?.stop).toMatchObject({ persistenceWarning: true });
		expect(calls).toBe(0);
		release(); await pending;
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(calls).toBe(0);
		expect(status.stop.state).toBe("not-submitted");
		expect(status.pending).toBeUndefined();
		expect(status.uncertain).toBe(false);
	});

	test("restored background work can be stopped without resubmitting it", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		let submissions = 0, interruptions = 0;
		const base = () => ({ location: { directory: "/workspace" }, session: { context: async () => [], hook: async () => {}, interrupt: async () => { interruptions++; } }, tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => { submissions++; return { output: { ...result.output, status: "running" } }; } }], transform: async (callback: (editor: { add(tool: Tool): void }) => void) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } } });
		await setupTest(base(), storage);
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "work" }, context("one"));
		await setupTest(base(), storage);
		const stopped = await tools.get("fusion_stop")!.execute({}, context("one"));
		expect(stopped.metadata?.stop).toMatchObject({ state: "acknowledged" });
		expect(submissions).toBe(1);
		expect(interruptions).toBe(1);
	});

	test("a stalled reference persistence cannot delay interrupting the published child", async () => {
		const tools = new Map<string, Tool>();
		const memory = memoryStorage();
		let entered!: () => void, publish!: () => void, release!: () => void;
		const ready = new Promise<void>((resolve) => { entered = resolve; });
		const publication = new Promise<void>((resolve) => { publish = resolve; });
		const stalled = new Promise<void>((resolve) => { release = resolve; });
		const interrupted: string[] = [];
		let runWrites = 0;
		// The second run-state write is the reference persistence inside
		// recordReference (the first is the delegation intent), and it hangs.
		const storage = { ...memory, set: async (key: string, value: unknown) => { if (key.startsWith("run/") && ++runWrites === 2) await stalled; await memory.set(key, value); } };
		await setupTest({ location: { directory: "/workspace" }, session: { context: async () => [], hook: async () => {}, interrupt: async ({ sessionID }) => { interrupted.push(sessionID); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx) => { entered(); await publication; await ctx.progress({ sessionID: "child-stop" }); return await new Promise<never>((_resolve, reject) => { const cancel = () => reject(new Error("cancelled by stop")); if (ctx.signal.aborted) cancel(); else ctx.signal.addEventListener("abort", cancel, { once: true }); }); } }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		}, storage);
		const pending = tools.get("fusion_delegate")!.execute({ action: "execute", brief: "work" }, context("one")).catch((error) => String(error));
		await ready;
		// The stop is queued while the child reference is still unpublished.
		await tools.get("fusion_stop")!.execute({}, context("one"));
		publish();
		// Publication interrupts the owned child before the stalled write
		// returns: only a later qualifying bus event would retry otherwise.
		for (let i = 0; i < 500 && interrupted.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
		expect(interrupted).toEqual(["child-stop"]);
		// Releasing the write lets the delegation unwind; no duplicate interrupt.
		release();
		await pending;
		await tick();
		expect(interrupted).toEqual(["child-stop"]);
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.stop.state).toBe("acknowledged");
	});

	test("reconciliation of cancelled work confirms the matching stop record", async () => {
		const tools = new Map<string, Tool>();
		const notices: { description?: string; text: string; resume?: boolean }[] = [];
		const messages: unknown[] = [];
		let interruptedChild = false;
		await setupTest({ location: { directory: "/workspace" }, session: { context: async () => messages, hook: async () => {}, synthetic: async (input) => { notices.push(input); }, interrupt: async () => { interruptedChild = true; } }, tool: {
			hook: async () => {}, list: async () => [{ id: "subagent", execute: async (input, ctx) => {
				await ctx.progress({ sessionID: "child-stop" });
				// The host collects the completion proof while the turn is still running.
				messages.push({ type: "synthetic", description: input.description, metadata: { source: "subagent", childID: "child-stop", agent: "fusion-executor", state: "cancelled" }, text: `<subagent sessionID="child-stop" state="cancelled" description="${input.description}">\nExecutor turn ended without producing output.\n</subagent>` });
				return { output: { sessionID: "child-stop", status: "running", output: "" } };
			} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} }, memoryStorage());
		// The executor turn goes background (managed natively), so it is
		// uncertain with a retained pending request.
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "work" }, context("one"));
		const stopped = await tools.get("fusion_stop")!.execute({}, context("one"));
		expect(interruptedChild).toBe(true);
		expect(stopped.metadata?.stop).toMatchObject({ state: "acknowledged" });
		// Before reconciliation the stop feedback still says unconfirmed.
		expect(stopped.content).toContain("Termination is not confirmed");
		const before = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(before.stop.state).toBe("acknowledged");
		// The completion notification proves the turn ended cancelled.
		const reconciled = await tools.get("fusion_reconcile")!.execute({}, context("one"));
		expect(reconciled.content).toContain("cancelled");
		const after = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(after.stop).toMatchObject({ state: "confirmed", terminal: "cancelled" });
		expect(after.stop.childSessionID).toBe("child-stop");
		expect(after.uncertain).toBe(false);
		expect(after.pending).toBeUndefined();
		// The fresh feedback reports the proven termination, not the stale one.
		const confirmation = notices.at(-1)!;
		expect(confirmation.description).toContain("Fusion executor stop");
		expect(confirmation.text).toContain("Executor turn stopped (cancelled).");
		// The settled stop keeps refusing further delegation until reset.
		await expect(tools.get("fusion_delegate")!.execute({ action: "revise", brief: "fix" }, context("one"))).rejects.toThrow("was stopped");
		await expect(tools.get("fusion_reset")!.execute({}, context("one"))).resolves.toHaveProperty("content", "Fusion run reset.");
	});
});

const budgetTick = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("run time and cost policies", () => {
	test("the observed-spend limit stops a mid-turn run and refuses further work", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		const busQueue: { type: string; data?: Record<string, unknown> }[] = [];
		let busWake: (() => void) | undefined;
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { busWake = resolve; }); } } } } }) };
		const interrupts: string[] = [];
		const reading = (sessionID: string, tokens: { input: number; output: number }, cost: number) => { busQueue.push({ type: "session.usage.updated", data: { sessionID, tokens, cost } }); busWake?.(); };
		const commands: CommandDefinition[] = [];
		await setupTest({
			location: { directory: "/workspace" },
			event: eventHost,
			session: { context: async () => [], hook: async () => {}, synthetic: async () => {}, interrupt: async ({ sessionID }) => { interrupts.push(sessionID); } },
			command: { list: async () => ({ data: [] }), transform: async (callback) => { callback({ add: (command) => commands.push(command) }); } },
			tool: {
				hook: async () => {},
				list: async () => [{ id: "subagent", execute: async (input: { agent?: string }, ctx: { progress: (update: Record<string, unknown>) => Promise<void> }) => {
					if (input.agent === "fusion-scout") {
						await ctx.progress({ sessionID: "scout-1" });
						reading("scout-1", { input: 20, output: 10 }, 2);
						await new Promise((resolve) => setTimeout(resolve, 10));
						return { output: { sessionID: "scout-1", status: "completed", output: "answer" } };
					}
					await ctx.progress({ sessionID: "child-1" });
					// One usage event crosses the limit mid-turn: the policy stop
					// fires while the child is still running.
					reading("child-1", { input: 100, output: 50 }, 10);
					await new Promise((resolve) => setTimeout(resolve, 10));
					return { output: { sessionID: "child-1", status: "completed", output: "done" } };
				} }],
				transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
			},
		}, storage);
		// The limit is configured before the run, through the user command.
		const budgetCommand = commands.find((command) => command.name === "fusion-budget")!;
		expect(await budgetCommand.execute({ sessionID: "one", prompt: { text: "cost 10" } })).toContain("observed accounting, not a strict ceiling");
		await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
		await tools.get("fusion_scout")!.execute({ questions: ["Where?"] }, context("one"));
		const response = await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		// The mid-turn crossing requested cancellation through the stop path;
		// the wording never claims a strict dollar ceiling.
		const stop = (response.metadata as { fusion?: { stopRecap?: string } } | undefined)?.fusion as { stopRecap?: string } | undefined;
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.stop?.kind).toBe("policy");
		expect(status.stop?.reason).toContain("observed spending of $12.00");
		expect(status.stop?.reason).toContain("observed accounting");
		// The settled turn confirms the policy stop; further work is refused.
		for (let i = 0; i < 12; i++) {
			const parsed = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
			if (parsed.stop?.state === "confirmed") break;
			busWake?.(); await budgetTick();
		}
		const confirmed = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(confirmed.stop?.state).toBe("confirmed");
		expect(confirmed.budget?.status).toBe("exhausted");
		expect(confirmed.budget?.budget?.roles?.executor).toMatchObject({ turnsReported: 1, turnsMissing: 0, cost: 10 });
		expect(confirmed.budget?.budget?.roles?.scout).toMatchObject({ turnsReported: 1, turnsMissing: 0, cost: 2 });
		expect(confirmed.budget?.budget?.activeMs).toBeGreaterThanOrEqual(0);
		await expect(tools.get("fusion_delegate")!.execute({ action: "revise", brief: "fix" }, context("one"))).rejects.toThrow("was stopped");
		await expect(tools.get("fusion_scout")!.execute({ questions: ["more?"] }, context("one"))).rejects.toThrow("was stopped");
		expect(interrupts).toEqual(["child-1"]);
		// Restart cannot reset consumed budgets: a fresh plugin instance
		// restoring the saved record keeps the policy, the ledger, and the
		// policy stop fail-closed (a malformed record throws, never lifts).
		const restored = new Map<string, Tool>();
		await setupTest({ location: { directory: "/workspace" },
			session: { context: async () => [], hook: async () => {}, synthetic: async () => {} },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({}) }], transform: async (callback) => { callback({ add: (tool) => restored.set(tool.name, tool) }); } },
		}, storage);
		const restoredStatus = JSON.parse((await restored.get("fusion_status")!.execute({}, context("one"))).content);
		expect(restoredStatus.runId).toBe(status.runId);
		expect(restoredStatus.budget?.status).toBe("exhausted");
		expect(restoredStatus.budget?.budget?.roles?.executor).toMatchObject({ cost: 10 });
		expect(restoredStatus.budget?.policy).toMatchObject({ observedCostLimit: 10 });
		expect(restoredStatus.stop?.kind).toBe("policy");
	}, 20000);

	test("missing cost readings block a spend-limited run until an explicit continue", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		const commands: CommandDefinition[] = [];
		await setupTest({
			location: { directory: "/workspace" },
			session: { context: async () => [], hook: async () => {}, synthetic: async () => {} },
			command: { list: async () => ({ data: [] }), transform: async (callback) => { callback({ add: (command) => commands.push(command) }); } },
			tool: {
				hook: async () => {},
				list: async () => [{ id: "subagent", execute: async (input: { agent?: string }, ctx: { progress: (update: Record<string, unknown>) => Promise<void> }) => {
					// No usage event: the turn's spend stays unknown, never zero.
					await ctx.progress({ sessionID: input.agent === "fusion-scout" ? "scout-2" : "child-2" });
					await new Promise((resolve) => setTimeout(resolve, 5));
					return { output: { sessionID: input.agent === "fusion-scout" ? "scout-2" : "child-2", status: "completed", output: "done" } };
				} }],
				transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
			},
		}, storage);
		const budgetCommand = commands.find((command) => command.name === "fusion-budget")!;
		await budgetCommand.execute({ sessionID: "one", prompt: { text: "cost 100" } });
		await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
		// The scout ran without a usage reading: the spend-limited run blocks.
		await tools.get("fusion_scout")!.execute({ questions: ["Where?"] }, context("one"));
		await expect(tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"))).rejects.toThrow("Fusion run budget is unknown");
		let status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.budget?.status).toBe("unknown");
		// The explicit continue grants exactly one admission, then blocks again.
		await budgetCommand.execute({ sessionID: "one", prompt: { text: "continue" } });
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		await expect(tools.get("fusion_delegate")!.execute({ action: "revise", brief: "fix" }, context("one"))).rejects.toThrow("Fusion run budget is unknown");
		// Clearing the limit (a policy change) unblocks without a waiver.
		await budgetCommand.execute({ sessionID: "one", prompt: { text: "clear cost" } });
		await tools.get("fusion_delegate")!.execute({ action: "revise", brief: "fix" }, context("one"));
		status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.budget?.policy).toBeNull();
	}, 20000);

	test("the active-time limit cancels a mid-turn run through the stop path", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		const interrupts: string[] = [];
		let release!: () => void, entered!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const ready = new Promise<void>((resolve) => { entered = resolve; });
		const commands: CommandDefinition[] = [];
		await setupTest({
			location: { directory: "/workspace" },
			session: { context: async () => [], hook: async () => {}, synthetic: async () => {}, interrupt: async ({ sessionID }) => { interrupts.push(sessionID); } },
			command: { list: async () => ({ data: [] }), transform: async (callback) => { callback({ add: (command) => commands.push(command) }); } },
			tool: {
				hook: async () => {},
				list: async () => [{ id: "subagent", execute: async (input: { agent?: string }, ctx: { progress: (update: Record<string, unknown>) => Promise<void> }) => {
					await ctx.progress({ sessionID: "child-3" });
					entered();
					await gate;
					return { output: { sessionID: "child-3", status: "completed", output: "done" } };
				} }],
				transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
			},
		}, storage);
		const budgetCommand = commands.find((command) => command.name === "fusion-budget")!;
		// A 60ms limit gives the submission a margin to win its post-gate
		// race: a 1ms limit can fire the timer inside the window between the
		// gate and the native submit, where the runtime's pre-submission
		// check correctly cancels the turn instead of submitting — a valid
		// outcome, but not the one this fixture pins. The point here is the
		// mid-turn stop on a LIVE executor, which the margin makes
		// deterministic.
		await budgetCommand.execute({ sessionID: "one", prompt: { text: "time 60ms" } });
		await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
		const delegation = tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		await ready;
		// The bounded timer fires mid-turn with a live executor and requests
		// cancellation through the R1 stop path with a policy reason.
		await new Promise((resolve) => setTimeout(resolve, 140));
		release();
		await delegation;
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.stop?.kind).toBe("policy");
		expect(status.stop?.reason).toContain("active time limit");
		expect(interrupts).toEqual(["child-3"]);
		await expect(tools.get("fusion_delegate")!.execute({ action: "revise", brief: "fix" }, context("one"))).rejects.toThrow("was stopped");
	}, 20000);
});

describe("run time accounting", () => {
	test("a turn's active time is recorded once, not twice", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		await setupTest({
			location: { directory: "/workspace" },
			session: { context: async () => [], hook: async () => {} },
			tool: {
				hook: async () => {},
				list: async () => [{ id: "subagent", execute: async (input: { agent?: string }, ctx: { progress: (update: Record<string, unknown>) => Promise<void> }) => {
					await ctx.progress({ sessionID: "child-9" });
					// The turn's active span is ~200ms; double-counting would
					// persist ~400ms or more.
					await new Promise((resolve) => setTimeout(resolve, 200));
					return { output: { sessionID: "child-9", status: "completed", output: "done" } };
				} }],
				transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
			},
		}, storage);
		const commands: CommandDefinition[] = [];
		await setupTest({ location: { directory: "/workspace" }, session: { context: async () => [], hook: async () => {}, synthetic: async () => {} },
			command: { list: async () => ({ data: [] }), transform: async (callback) => { callback({ add: (command) => commands.push(command) }); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({}) }], transform: async () => {} },
		}, storage);
		const budgetCommand = commands.find((command) => command.name === "fusion-budget")!;
		await budgetCommand.execute({ sessionID: "one", prompt: { text: "time 30m" } });
		await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		const stats = JSON.parse((await tools.get("fusion_stats")!.execute({}, context("one"))).content);
		// The turn's active span is ~200ms; double-counting would persist
		// ~400ms or more. Bounds stay clear of scheduler jitter under load.
		expect(stats.budget.activeMs).toBeGreaterThan(100);
		expect(stats.budget.activeMs).toBeLessThan(380);
	}, 20000);
});

describe("waiting and blocked states (R3)", () => {
	const budgetTick = () => new Promise((resolve) => setTimeout(resolve, 30));
	/** The wait signal helpers the host bus uses (pinned live on v2.3.0). */
	const permissionAsked = (sessionID: string, id: string, action: string, resources: string[] = []) => ({ type: "permission.asked", data: { sessionID, id, action, resources } });
	const permissionReplied = (sessionID: string, id: string, reply: string) => ({ type: "permission.replied", data: { sessionID, requestID: id, reply } });
	const formCreated = (sessionID: string, id: string, title: string, fieldTitle?: string) => ({ type: "form.created", data: { form: { id, sessionID, title, fields: fieldTitle ? [{ key: "q0", title: fieldTitle, type: "string" }] : [] } } });
	const formReplied = (sessionID: string, id: string) => ({ type: "form.replied", data: { id, sessionID, answer: { q0: "yes" } } });
	const formCancelled = (sessionID: string, id: string) => ({ type: "form.cancelled", data: { id, sessionID } });

	test("permission waits pause the active clock; allowed and denied replies close them", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		const busQueue: { type: string; data?: Record<string, unknown> }[] = [];
		let busWake: (() => void) | undefined;
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { busWake = resolve; }); } } } } }) };
		let release!: () => void, entered!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const ready = new Promise<void>((resolve) => { entered = resolve; });
		let calls = 0;
		await setupTest({
			location: { directory: "/workspace" },
			event: eventHost,
			session: { context: async () => [], hook: async () => {}, synthetic: async () => {} },
			command: { list: async () => ({ data: [] }), transform: async () => {} },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx: { progress: (update: Record<string, unknown>) => Promise<void> }) => {
				calls += 1;
				await ctx.progress({ sessionID: "child-w" });
				entered();
				await gate;
				return { output: { sessionID: "child-w", status: "completed", output: "done" } };
			} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		}, storage);
		await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
		const delegation = tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		await ready;
		const statusDuring = async () => JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		// No wait yet: the live turn reports durations but no open wait.
		expect((await statusDuring()).waiting?.wait).toBeUndefined();
		// The child asks for a permission; the run reports the wait and the
		// required action in the shared wording.
		busQueue.push(permissionAsked("child-w", "perm_1", "bash", ["/tmp/x"]));
		busWake?.();
		await budgetTick();
		const waiting = (await statusDuring()).waiting;
		expect(waiting?.worker).toBe("Executor");
		expect(waiting?.observation).toBe("waiting-permission");
		expect(waiting?.wait).toMatchObject({ kind: "permission", label: "bash /tmp/x" });
		expect((await statusDuring()).nextAction).toContain("allow or deny it (bash /tmp/x) to continue");
		// While the permission is open the active clock is paused: the live
		// turn's active time stops growing even though the turn is running.
		const pausedA = waiting.activeMs as number;
		await budgetTick();
		await budgetTick();
		const pausedB = ((await statusDuring()).waiting?.activeMs ?? 0) as number;
		expect(pausedB - pausedA).toBeLessThan(40);
		// The host reports the user allowed it: the wait closes and the clock
		// resumes; waiting time stays accounted for display, never as active.
		busQueue.push(permissionReplied("child-w", "perm_1", "once"));
		busWake?.();
		await budgetTick();
		expect((await statusDuring()).waiting?.wait).toBeUndefined();
		expect((await statusDuring()).nextAction).not.toContain("allow or deny it");
		expect((await statusDuring()).waiting?.waitingMs).toBeGreaterThan(0);
		release();
		await delegation;
		expect(calls).toBe(1);
		// The settled turn cleared the pending request; the committed active
		// time excludes the wait span: the wall time this test spent is far
		// longer than the active time recorded for the turn.
		const settled = await statusDuring();
		expect(settled.pending).toBeUndefined();
		expect(settled.budget.budget.activeMs).toBeLessThan(300);
	}, 20000);

	test("a denied permission closes the wait with its outcome", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		const busQueue: { type: string; data?: Record<string, unknown> }[] = [];
		let busWake: (() => void) | undefined;
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { busWake = resolve; }); } } } } }) };
		let release!: () => void, entered!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const ready = new Promise<void>((resolve) => { entered = resolve; });
		await setupTest({
			location: { directory: "/workspace" },
			event: eventHost,
			session: { context: async () => [], hook: async () => {}, synthetic: async () => {} },
			command: { list: async () => ({ data: [] }), transform: async () => {} },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx: { progress: (update: Record<string, unknown>) => Promise<void> }) => {
				await ctx.progress({ sessionID: "child-w2" });
				entered();
				await gate;
				return { output: { sessionID: "child-w2", status: "completed", output: "done" } };
			} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		}, storage);
		await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
		const delegation = tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		await ready;
		busQueue.push(permissionAsked("child-w2", "perm_2", "edit"));
		busWake?.();
		await budgetTick();
		// The card's activity metadata carries the open wait for the TUI row.
		const cardWithWait = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(cardWithWait.waiting?.wait?.kind).toBe("permission");
		busQueue.push(permissionReplied("child-w2", "perm_2", "reject"));
		busWake?.();
		await budgetTick();
		expect(JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content).waiting?.wait).toBeUndefined();
		// The turn continues after the denial; the pending request is intact.
		expect(JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content).pending?.requestId).toBe(cardWithWait.pending?.requestId);
		release();
		await delegation;
	}, 20000);

	test("clarification forms open user waits; answers and cancellations close them without a replacement submission", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		const busQueue: { type: string; data?: Record<string, unknown> }[] = [];
		let busWake: (() => void) | undefined;
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { busWake = resolve; }); } } } } }) };
		let release!: () => void, entered!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const ready = new Promise<void>((resolve) => { entered = resolve; });
		let calls = 0;
		await setupTest({
			location: { directory: "/workspace" },
			event: eventHost,
			session: { context: async () => [], hook: async () => {}, synthetic: async () => {} },
			command: { list: async () => ({ data: [] }), transform: async () => {} },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx: { progress: (update: Record<string, unknown>) => Promise<void> }) => {
				calls += 1;
				await ctx.progress({ sessionID: "child-w3" });
				entered();
				await gate;
				return { output: { sessionID: "child-w3", status: "completed", output: "done" } };
			} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		}, storage);
		await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
		const delegation = tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		await ready;
		const statusDuring = async () => JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		// The executor asks the user a question through the host's native form.
		busQueue.push(formCreated("child-w3", "frm_1", "Questions", "Which approach should I take?"));
		busWake?.();
		await budgetTick();
		const waiting = (await statusDuring()).waiting;
		expect(waiting?.observation).toBe("waiting-user");
		expect(waiting?.wait).toMatchObject({ kind: "user", label: "Questions — Which approach should I take?" });
		expect((await statusDuring()).nextAction).toContain("answer or cancel it (Questions — Which approach should I take?) to continue");
		const pendingBefore = (await statusDuring()).pending?.requestId;
		// The user answers: the same pending task continues (no new submission).
		busQueue.push(formReplied("child-w3", "frm_1"));
		busWake?.();
		await budgetTick();
		expect((await statusDuring()).waiting?.wait).toBeUndefined();
		expect((await statusDuring()).pending?.requestId).toBe(pendingBefore);
		// A cancelled question closes the wait with the cancelled outcome.
		busQueue.push(formCreated("child-w3", "frm_2", "Questions", "Second question"));
		busWake?.();
		await budgetTick();
		busQueue.push(formCancelled("child-w3", "frm_2"));
		busWake?.();
		await budgetTick();
		expect((await statusDuring()).waiting?.wait).toBeUndefined();
		release();
		await delegation;
		expect(calls).toBe(1);
		expect((await statusDuring()).pending).toBeUndefined();
	}, 20000);

	test("unrecognized wait events change nothing and unsupported events stay unknown", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		const busQueue: { type: string; data?: Record<string, unknown> }[] = [];
		let busWake: (() => void) | undefined;
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { busWake = resolve; }); } } } } }) };
		let release!: () => void, entered!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const ready = new Promise<void>((resolve) => { entered = resolve; });
		await setupTest({
			location: { directory: "/workspace" },
			event: eventHost,
			session: { context: async () => [], hook: async () => {}, synthetic: async () => {} },
			command: { list: async () => ({ data: [] }), transform: async () => {} },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx: { progress: (update: Record<string, unknown>) => Promise<void> }) => {
				await ctx.progress({ sessionID: "child-w4" });
				entered();
				await gate;
				return { output: { sessionID: "child-w4", status: "completed", output: "done" } };
			} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		}, storage);
		await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
		const delegation = tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		await ready;
		const statusDuring = async () => JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		// An event type Fusion does not know, and a permission event without an
		// identity, must not invent a wait, a blocked claim, or a terminal one.
		busQueue.push({ type: "session.does.not.exist", data: { sessionID: "child-w4", status: { type: "blocked" } } });
		busQueue.push({ type: "permission.asked", data: { sessionID: "child-w4", action: "bash" } });
		busQueue.push({ type: "permission.replied", data: { sessionID: "child-w4" } });
		busQueue.push({ type: "session.execution.failed", data: { sessionID: "unowned" } });
		busWake?.();
		await budgetTick();
		const status = await statusDuring();
		expect(status.waiting?.wait).toBeUndefined();
		// The run's own next action stands; no wait or outcome was invented.
		expect(status.nextAction).not.toMatch(/allow or deny|answer or cancel|blocked|terminal/i);
		// The delegation still completes; nothing was blocked or terminal.
		release();
		await delegation;
		expect(JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content).stop).toBeUndefined();
	}, 20000);

	test("stale activity flags inspection without inventing a blocked outcome", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		let release!: () => void, entered!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const ready = new Promise<void>((resolve) => { entered = resolve; });
		await setupTest({
			location: { directory: "/workspace" },
			session: { context: async () => [], hook: async () => {}, synthetic: async () => {} },
			command: { list: async () => ({ data: [] }), transform: async () => {} },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx: { progress: (update: Record<string, unknown>) => Promise<void> }) => {
				await ctx.progress({ sessionID: "child-w5" });
				entered();
				await gate;
				return { output: { sessionID: "child-w5", status: "completed", output: "done" } };
			} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		}, storage, { waitStaleAfterMs: 20 });
		await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
		const delegation = tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		await ready;
		await new Promise((resolve) => setTimeout(resolve, 80));
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.waiting?.stale).toBe(true);
		// The observation is what the adapter can establish: the turn started
		// but produced no tool activity yet.
		expect(status.waiting?.observation).toBe("starting");
		expect(status.nextAction).toContain("inspect the worker if this is unexpected");
		// The advisory line never claims a blocked or terminal outcome.
		expect(status.nextAction).not.toMatch(/blocked|terminal|ended|completed|failed/i);
		release();
		await delegation;
	}, 20000);

	test("a confirmed wait suspends the active-time limit timer for its duration", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		const busQueue: { type: string; data?: Record<string, unknown> }[] = [];
		let busWake: (() => void) | undefined;
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { busWake = resolve; }); } } } } }) };
		const interrupts: string[] = [];
		let release!: () => void, entered!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const ready = new Promise<void>((resolve) => { entered = resolve; });
		const commands: CommandDefinition[] = [];
		await setupTest({
			location: { directory: "/workspace" },
			event: eventHost,
			session: { context: async () => [], hook: async () => {}, synthetic: async () => {}, interrupt: async ({ sessionID }) => { interrupts.push(sessionID); } },
			command: { list: async () => ({ data: [] }), transform: async (callback) => { callback({ add: (command) => commands.push(command) }); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx: { progress: (update: Record<string, unknown>) => Promise<void> }) => {
				await ctx.progress({ sessionID: "child-w6" });
				entered();
				await gate;
				return { output: { sessionID: "child-w6", status: "completed", output: "done" } };
			} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		}, storage);
		const budgetCommand = commands.find((command) => command.name === "fusion-budget")!;
		await budgetCommand.execute({ sessionID: "one", prompt: { text: "time 200ms" } });
		await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
		const delegation = tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		await ready;
		// ~110ms of active execution first, then a permission wait that holds
		// far longer than the whole limit. Waiting time never consumes active
		// time: the timer disarms for the wait and rearms with the still-open
		// active budget (~90ms), so the policy stop fires while the turn is
		// still parked — and the committed active time proves the wait span
		// never consumed active execution time.
		await new Promise((resolve) => setTimeout(resolve, 110));
		busQueue.push(permissionAsked("child-w6", "perm_3", "bash"));
		busWake?.();
		await new Promise((resolve) => setTimeout(resolve, 400));
		busQueue.push(permissionReplied("child-w6", "perm_3", "once"));
		busWake?.();
		// A rearm that re-granted the full remaining (200ms) would fire only
		// after this 130ms park ended and commit its clock: no policy stop.
		// A clock that never paused would have fired during the wait and
		// committed the whole wait span as active time.
		await new Promise((resolve) => setTimeout(resolve, 130));
		release();
		await delegation;
		// The stop was a policy stop for the active-time limit, delivered to
		// the live child, and the recorded active time excludes the wait span.
		for (let i = 0; i < 12; i++) {
			const parsed = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
			if (parsed.stop?.state === "confirmed") break;
			busWake?.(); await budgetTick();
		}
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.stop?.kind).toBe("policy");
		expect(status.stop?.reason).toContain("active time limit");
		expect(interrupts).toEqual(["child-w6"]);
		// Active time ≈ the pre-wait span plus the short post-close park; the
		// 400ms wait contributed none of it.
		expect(status.budget.budget.activeMs).toBeGreaterThan(180);
		expect(status.budget.budget.activeMs).toBeLessThan(400);
	}, 20000);

	test("a stop during an open wait lands, closes the wait, and admits no replacement submission", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		const busQueue: { type: string; data?: Record<string, unknown> }[] = [];
		let busWake: (() => void) | undefined;
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { busWake = resolve; }); } } } } }) };
		const interrupts: string[] = [];
		let release!: () => void, entered!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const ready = new Promise<void>((resolve) => { entered = resolve; });
		let calls = 0;
		await setupTest({
			location: { directory: "/workspace" },
			event: eventHost,
			session: { context: async () => [], hook: async () => {}, synthetic: async () => {}, interrupt: async ({ sessionID }) => { interrupts.push(sessionID); } },
			command: { list: async () => ({ data: [] }), transform: async () => {} },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx: { progress: (update: Record<string, unknown>) => Promise<void> }) => {
				calls += 1;
				await ctx.progress({ sessionID: "child-w7" });
				entered();
				await gate;
				return { output: { sessionID: "child-w7", status: "completed", output: "done" } };
			} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		}, storage);
		await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
		const delegation = tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		await ready;
		busQueue.push(permissionAsked("child-w7", "perm_4", "bash"));
		busWake?.();
		await budgetTick();
		// The user stops the run while the executor waits on permission.
		const stop = await tools.get("fusion_stop")!.execute({}, context("one"));
		expect(stop.content).toContain("Executor interruption requested");
		release();
		await delegation;
		expect(calls).toBe(1);
		// The stopped run refuses more work; the answer can never become a
		// replacement submission.
		await expect(tools.get("fusion_delegate")!.execute({ action: "revise", brief: "fix" }, context("one"))).rejects.toThrow("was stopped");
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.stop?.state).toBe("confirmed");
		expect(status.waiting?.wait).toBeUndefined();
	}, 20000);

	test("backgrounded children keep reporting their waits without pausing any live clock", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		const busQueue: { type: string; data?: Record<string, unknown> }[] = [];
		let busWake: (() => void) | undefined;
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { busWake = resolve; }); } } } } }) };
		await setupTest({
			location: { directory: "/workspace" },
			event: eventHost,
			session: { context: async () => [], hook: async () => {}, synthetic: async () => {} },
			command: { list: async () => ({ data: [] }), transform: async () => {} },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx: { progress: (update: Record<string, unknown>) => Promise<void> }) => {
				await ctx.progress({ sessionID: "child-w8" });
				// The host backgrounds the delegation.
				return { output: { sessionID: "child-w8", status: "running", output: "backgrounded" } };
			} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		}, storage);
		await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
		const backgrounded = await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		expect(backgrounded.content).toContain("running in the background");
		// The backgrounded child asks a question: the run reports the wait
		// without claiming anything about the turn's outcome.
		busQueue.push(formCreated("child-w8", "frm_9", "Questions", "Still need the approach?"));
		busWake?.();
		await budgetTick();
		let status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.waiting?.worker).toBe("Executor");
		expect(status.waiting?.background).toBe(true);
		expect(status.waiting?.wait).toMatchObject({ kind: "user", label: "Questions — Still need the approach?" });
		// The child's terminal event disposes the background wait observation.
		busQueue.push({ type: "session.execution.succeeded", created: Date.now(), data: { sessionID: "child-w8" } } as { type: string; created?: number; data?: Record<string, unknown> });
		busWake?.();
		await budgetTick();
		status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.waiting).toBeUndefined();
	}, 20000);

	test("wait observation is process-local: a restored instance reports none until events recur", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		const busQueue: { type: string; data?: Record<string, unknown> }[] = [];
		let busWake: (() => void) | undefined;
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { busWake = resolve; }); } } } } }) };
		let release!: () => void, entered!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const ready = new Promise<void>((resolve) => { entered = resolve; });
		await setupTest({
			location: { directory: "/workspace" },
			event: eventHost,
			session: { context: async () => [], hook: async () => {}, synthetic: async () => {} },
			command: { list: async () => ({ data: [] }), transform: async () => {} },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx: { progress: (update: Record<string, unknown>) => Promise<void> }) => {
				await ctx.progress({ sessionID: "child-w9" });
				entered();
				await gate;
				return { output: { sessionID: "child-w9", status: "completed", output: "done" } };
			} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		}, storage);
		await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
		const delegation = tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		await ready;
		busQueue.push(permissionAsked("child-w9", "perm_5", "bash"));
		busWake?.();
		await budgetTick();
		expect(JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content).waiting?.wait?.kind).toBe("permission");
		release();
		await delegation;
		// A fresh plugin instance restoring the run reports no wait state:
		// process-local observation is never resurrected as persisted truth.
		const restored = new Map<string, Tool>();
		await setupTest({ location: { directory: "/workspace" },
			session: { context: async () => [], hook: async () => {}, synthetic: async () => {} },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({}) }], transform: async (callback) => { callback({ add: (tool) => restored.set(tool.name, tool) }); } },
		}, storage);
		const restoredStatus = JSON.parse((await restored.get("fusion_status")!.execute({}, context("one"))).content);
		expect(restoredStatus.waiting).toBeUndefined();
	}, 20000);
});

describe("waiting review fixes (R3)", () => {
	const budgetTick = () => new Promise((resolve) => setTimeout(resolve, 30));

	test("overlapping permission requests are tracked by identity; answering one leaves the other waiting", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		const busQueue: { type: string; data?: Record<string, unknown> }[] = [];
		let busWake: (() => void) | undefined;
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { busWake = resolve; }); } } } } }) };
		let release!: () => void, entered!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const ready = new Promise<void>((resolve) => { entered = resolve; });
		await setupTest({
			location: { directory: "/workspace" },
			event: eventHost,
			session: { context: async () => [], hook: async () => {}, synthetic: async () => {} },
			command: { list: async () => ({ data: [] }), transform: async () => {} },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx: { progress: (update: Record<string, unknown>) => Promise<void> }) => {
				await ctx.progress({ sessionID: "child-ov" });
				entered();
				await gate;
				return { output: { sessionID: "child-ov", status: "completed", output: "done" } };
			} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		}, storage);
		await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
		const delegation = tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		await ready;
		const statusDuring = async () => JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		// Two parallel tool calls each await a permission decision.
		busQueue.push({ type: "permission.asked", data: { sessionID: "child-ov", id: "perm_a", action: "bash", resources: ["/a"] } });
		busQueue.push({ type: "permission.asked", data: { sessionID: "child-ov", id: "perm_b", action: "edit", resources: ["/b"] } });
		busWake?.();
		await budgetTick();
		let waiting = (await statusDuring()).waiting;
		// The older request is reported and both are outstanding.
		expect(waiting?.wait).toMatchObject({ id: "perm_a", label: "bash /a" });
		expect(waiting?.openWaits).toBe(2);
		// Answering B closes only B: A remains the required action.
		busQueue.push({ type: "permission.replied", data: { sessionID: "child-ov", requestID: "perm_b", reply: "once" } });
		busWake?.();
		await budgetTick();
		waiting = (await statusDuring()).waiting;
		expect(waiting?.wait).toMatchObject({ id: "perm_a" });
		expect(waiting?.openWaits).toBe(1);
		expect((await statusDuring()).nextAction).toContain("allow or deny it (bash /a) to continue");
		// Answering A closes the last wait; the clock resumes and the run's
		// status stops requiring attention.
		busQueue.push({ type: "permission.replied", data: { sessionID: "child-ov", requestID: "perm_a", reply: "reject" } });
		busWake?.();
		await budgetTick();
		waiting = (await statusDuring()).waiting;
		expect(waiting?.wait).toBeUndefined();
		expect(waiting?.openWaits).toBe(0);
		release();
		await delegation;
	}, 20000);

	test("an outstanding wait survives the turn becoming background work", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		const busQueue: { type: string; data?: Record<string, unknown> }[] = [];
		let busWake: (() => void) | undefined;
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { busWake = resolve; }); } } } } }) };
		let background = false;
		await setupTest({
			location: { directory: "/workspace" },
			event: eventHost,
			session: { context: async () => [], hook: async () => {}, synthetic: async () => {} },
			command: { list: async () => ({ data: [] }), transform: async () => {} },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx: { progress: (update: Record<string, unknown>) => Promise<void> }) => {
				await ctx.progress({ sessionID: "child-tx" });
				// The executor asks a question mid-turn...
				busQueue.push({ type: "form.created", data: { form: { id: "frm_tx", sessionID: "child-tx", title: "Questions", fields: [{ key: "q0", title: "Which approach?", type: "string" }] } } });
				busWake?.();
				await new Promise((resolve) => setTimeout(resolve, 60));
				// ...and the host backgrounds the delegation before an answer.
				background = true;
				return { output: { sessionID: "child-tx", status: "running", output: "backgrounded" } };
			} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		}, storage);
		await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
		const backgrounded = await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		expect(backgrounded.content).toContain("running in the background");
		// The question outlives the foreground turn: the run still reports it,
		// as background work, with the required action.
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.waiting?.background).toBe(true);
		expect(status.waiting?.wait).toMatchObject({ kind: "user", label: "Questions — Which approach?" });
		expect(status.waiting?.childSessionID).toBe("child-tx");
		// The child's terminal event disposes the transferred wait.
		busQueue.push({ type: "session.execution.succeeded", created: Date.now(), data: { sessionID: "child-tx" } } as { type: string; created?: number; data?: Record<string, unknown> });
		busWake?.();
		await budgetTick();
		expect(JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content).waiting).toBeUndefined();
	}, 20000);
});

describe("reconciliation clears stale waits (R3 review)", () => {
	const budgetTick = () => new Promise((resolve) => setTimeout(resolve, 30));

	test("reconciliation proves termination and disposes the child's outstanding wait", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		const busQueue: { type: string; data?: Record<string, unknown> }[] = [];
		let busWake: (() => void) | undefined;
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { busWake = resolve; }); } } } } }) };
		// The completion notification arrives without the child's terminal bus
		// event, so nothing else ever proves the child's turn ended.
		let contextMessages: readonly unknown[] = [];
		await setupTest({
			location: { directory: "/workspace" },
			event: eventHost,
			session: { context: async () => contextMessages, hook: async () => {}, synthetic: async () => {} },
			command: { list: async () => ({ data: [] }), transform: async () => {} },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx: { progress: (update: Record<string, unknown>) => Promise<void> }) => {
				await ctx.progress({ sessionID: "child-rc" });
				// The executor asks a question mid-turn...
				busQueue.push({ type: "form.created", data: { form: { id: "frm_rc", sessionID: "child-rc", title: "Questions", fields: [{ key: "q0", title: "Which approach?", type: "string" }] } } });
				busWake?.();
				await new Promise((resolve) => setTimeout(resolve, 60));
				// ...and the host backgrounds the delegation before an answer.
				return { output: { sessionID: "child-rc", status: "running", output: "backgrounded" } };
			} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		}, storage);
		await tools.get("fusion_start")!.execute({ task: "Task" }, context("one"));
		const backgrounded = await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		expect(backgrounded.content).toContain("running in the background");
		// The transferred question is visible while the child runs.
		const before = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(before.waiting?.wait).toMatchObject({ kind: "user", label: "Questions — Which approach?" });
		// The host delivers the completion notification (no terminal event):
		// reconciliation adopts it as the exact proof of termination.
		const requestId = before.pending.requestId as string;
		contextMessages = [{ type: "synthetic", description: requestId, metadata: { source: "subagent", childID: "child-rc", agent: "fusion-executor", state: "completed" }, text: `<subagent sessionID="child-rc" state="completed" description="${requestId}">\nExecutor report.\n</subagent>` }];
		const reconciled = await tools.get("fusion_reconcile")!.execute({}, context("one"));
		expect(reconciled.metadata?.status).toBe("completed");
		// The settled child cannot still be waiting: status stops asking the
		// user to answer the old question.
		const after = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(after.waiting).toBeUndefined();
		expect(after.uncertain).toBe(false);
	}, 20000);
});

describe("backgrounded scouts adopt their exact completion (C4)", () => {
	const notification = (requestId: string, childID: string, state: "completed" | "error" | "cancelled", body: string) => ({
		type: "synthetic",
		description: requestId,
		metadata: { source: "subagent", childID, agent: "fusion-scout", state },
		text: `<subagent sessionID="${childID}" state="${state}" description="${requestId}">\n${body}\n</subagent>`,
	});

	test("the notification matcher never adopts foreign evidence", () => {
		const exact = { type: "synthetic", description: "Fusion scout q", metadata: { source: "subagent", childID: "child", agent: "fusion-scout", state: "completed" }, text: '<subagent sessionID="child" state="completed" description="Fusion scout q">\nanswer\n</subagent>' };
		expect(notificationResult([exact], "child", "Fusion scout q", "fusion-scout")).toEqual({ state: "completed", output: "answer" });
		// A wrong child, agent, description, source, state, or wrapper is foreign.
		expect(() => notificationResult([{ ...exact, metadata: { ...exact.metadata, childID: "other" } }], "child", "Fusion scout q", "fusion-scout")).toThrow();
		expect(() => notificationResult([{ ...exact, metadata: { ...exact.metadata, agent: "fusion-executor" } }], "child", "Fusion scout q", "fusion-scout")).toThrow();
		expect(() => notificationResult([{ ...exact, description: "other" }], "child", "Fusion scout q", "fusion-scout")).toThrow();
		expect(() => notificationResult([{ ...exact, metadata: { ...exact.metadata, source: "manual" } }], "child", "Fusion scout q", "fusion-scout")).toThrow();
		expect(() => notificationResult([{ ...exact, metadata: { ...exact.metadata, state: "running" } }], "child", "Fusion scout q", "fusion-scout")).toThrow();
		expect(() => notificationResult([{ ...exact, text: "unwrapped" }], "child", "Fusion scout q", "fusion-scout")).toThrow();
		expect(() => notificationResult([], "child", "Fusion scout q", "fusion-scout")).toThrow();
	});

	test("a backgrounded scout adopts the answer that arrives before the wait settles", async () => {
		const tools = new Map<string, Tool>();
		let submissions = 0;
		const messages: unknown[] = [];
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => messages, hook: async () => {} }, tool: {
			hook: async () => {},
			list: async () => [{ id: "subagent", execute: async (input) => {
				submissions++;
				// The child's answer is already in the transcript when the wait polls.
				messages.push(notification(input.description, "scout-child", "completed", "1. cantaloupe at notes.md:2"));
				return { output: { sessionID: "scout-child", status: "running", output: "backgrounded" } };
			} }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} }, memoryStorage(), { scoutSettleTimeoutMs: 2000 });
		const result = await tools.get("fusion_scout")!.execute({ questions: ["Where is the fruit?"] }, context("one"));
		expect(submissions).toBe(1);
		expect(result.content).toContain("cantaloupe at notes.md:2");
		expect(result.content).toContain("Scout usage:");
		expect(result.metadata).toMatchObject({ childSessionID: "scout-child", status: "completed" });
	});

	test("a backgrounded scout adopts the answer that arrives after the native result", async () => {
		const tools = new Map<string, Tool>();
		const messages: unknown[] = [];
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => messages, hook: async () => {} }, tool: {
			hook: async () => {},
			list: async () => [{ id: "subagent", execute: async (input) => {
				// The child keeps running; the notification lands during the wait.
				setTimeout(() => { messages.push(notification(input.description, "scout-child", "completed", "the falcon is defined in src/app.ts:1")); }, 100);
				return { output: { sessionID: "scout-child", status: "running", output: "backgrounded" } };
			} }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} }, memoryStorage(), { scoutSettleTimeoutMs: 5000 });
		const result = await tools.get("fusion_scout")!.execute({ questions: ["Which function?"] }, context("one"));
		expect(result.content).toContain("the falcon is defined in src/app.ts:1");
		expect(result.metadata?.status).toBe("completed");
	});

	test("an unproven wait returns the explicit pending disposition and refuses duplicates until the child resolves", async () => {
		const tools = new Map<string, Tool>();
		let submissions = 0;
		const messages: unknown[] = [];
		const busQueue: { type: string; data?: Record<string, unknown> }[] = [];
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => setTimeout(resolve, 20)); } } } } }) };
		await setupTest({ location: { directory: tmpdir() }, event: eventHost, session: { context: async () => messages, hook: async () => {} }, tool: {
			hook: async () => {},
			list: async () => [{ id: "subagent", execute: async () => {
				submissions++;
				return { output: { sessionID: "scout-child", status: "running", output: "backgrounded" } };
			} }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} }, memoryStorage(), { scoutSettleTimeoutMs: 30 });
		const result = await tools.get("fusion_scout")!.execute({ questions: ["q"] }, context("one"));
		expect(result.content).toContain("still running in the background");
		expect(result.content).toContain("Do not call fusion_scout again");
		expect(result.content).toContain("fusion_reset stays blocked");
		expect(result.metadata?.status).toBe("pending");
		expect(typeof result.metadata?.requestId).toBe("string");
		// Exactly one native submission for the logical scout.
		expect(submissions).toBe(1);
		// The outstanding scout is visible in status and refuses a duplicate.
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.pendingScout?.requestId).toBe(result.metadata?.requestId);
		await expect(tools.get("fusion_scout")!.execute({ questions: ["again"] }, context("one"))).rejects.toThrow("still unproven");
		expect(submissions).toBe(1);
		// P1 (review round): the reset guard retains the unproven scout —
		// resetting cannot discard work whose outcome was never proven. The
		// live guard's refusal fires first while the guard is still armed;
		// either refusal protects the unproven child.
		await expect(tools.get("fusion_reset")!.execute({}, context("one"))).rejects.toThrow(/unproven|still running/);
		expect(submissions).toBe(1);
		// The child's terminal event resolves the record: the no-resubmission
		// rule lifts and a new scout may run.
		busQueue.push({ type: "session.execution.succeeded", data: { sessionID: "scout-child" } });
		await new Promise((resolve) => setTimeout(resolve, 120));
		const second = await tools.get("fusion_scout")!.execute({ questions: ["q2"] }, context("one"));
		expect(second.metadata?.status).toBe("pending");
		expect(submissions).toBe(2);
	});

	test("the submission intent is persisted before the native call, so a reload during the wait refuses a duplicate submission", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		const intentSeen: Record<string, { requestId?: string; sessionID?: string }>[] = [];
		const spyStorage = { ...storage, set: async (key: string, value: unknown) => { if (String(key).startsWith("scout-pending/")) intentSeen.push(value as Record<string, { requestId?: string }>); await storage.set(key, value); } };
		const messages: unknown[] = [];
		let submissions = 0;
		let submitGate!: () => void;
		const submitted = new Promise<void>((resolve) => { submitGate = resolve; });
		const scoutSettle = new Promise<void>(() => {});
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => messages, hook: async () => {} }, tool: {
			hook: async () => {},
			list: async () => [{ id: "subagent", execute: async (input) => {
				submissions++;
				// The intent must already be persisted before the native result:
				// the stored record carries this request's identity and session.
				expect(intentSeen[0]?.["one"]?.requestId).toBe(input.description);
				expect(intentSeen[0]?.["one"]?.sessionID).toBe("one");
				submitGate();
				await scoutSettle; // the wait never resolves within this test
				return { output: { sessionID: "scout-child", status: "running", output: "backgrounded" } };
			} }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} }, spyStorage, { scoutSettleTimeoutMs: 60000 });
		const inFlight = tools.get("fusion_scout")!.execute({ questions: ["q"] }, context("one"));
		await submitted;
		// A reload while the first scout waits: the new instance reads the same
		// retained record and refuses a second submission for this session.
		const reloadedTools = new Map<string, Tool>();
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => messages, hook: async () => {} }, tool: {
			hook: async () => {},
			list: async () => [{ id: "subagent", execute: async () => { submissions++; return { output: { sessionID: "other", status: "running", output: "" } }; } }],
			transform: async (callback) => { callback({ add: (tool) => reloadedTools.set(tool.name, tool) }); },
		} }, spyStorage, { scoutSettleTimeoutMs: 30 });
		await expect(reloadedTools.get("fusion_scout")!.execute({ questions: ["again"] }, context("one"))).rejects.toThrow("still unproven");
		expect(submissions).toBe(1);
		void inFlight;
	});

	test("an adopted terminal outcome clears the submission intent for the next scout", async () => {
		const tools = new Map<string, Tool>();
		let submissions = 0;
		const messages: unknown[] = [];
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => messages, hook: async () => {} }, tool: {
			hook: async () => {},
			list: async () => [{ id: "subagent", execute: async (input) => {
				submissions++;
				messages.push({ type: "synthetic", description: input.description, metadata: { source: "subagent", childID: `scout-${submissions}`, agent: "fusion-scout", state: "completed" }, text: `<subagent sessionID="scout-${submissions}" state="completed" description="${input.description}">\nanswer ${submissions}\n</subagent>` });
				return { output: { sessionID: `scout-${submissions}`, status: "running", output: "backgrounded" } };
			} }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} }, memoryStorage(), { scoutSettleTimeoutMs: 3000 });
		const first = await tools.get("fusion_scout")!.execute({ questions: ["q"] }, context("one"));
		expect(first.metadata?.status).toBe("completed");
		// The settled request leaves no outstanding record: the next scout runs
		// immediately without a bus event or operator action.
		const second = await tools.get("fusion_scout")!.execute({ questions: ["q2"] }, context("one"));
		expect(second.metadata?.status).toBe("completed");
		expect(submissions).toBe(2);
	});

	test("corrupt retained recovery state fails closed (P2)", async () => {
		const tools = new Map<string, Tool>();
		const values = new Map<string, unknown>();
		const storage = { get: async (key: string) => values.get(key), set: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); }, remove: async (key: string) => { values.delete(key); } };
		const hash = createHash("sha256").update(tmpdir()).digest("hex");
		values.set(`scout-pending/${hash}`, { requestId: 42, startedAt: "nope" });
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async () => {},
			list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "scout-child", status: "completed", output: "answer" } }) }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} }, storage as unknown as typeof storage & Record<string, never>, { scoutSettleTimeoutMs: 30 });
		await expect(tools.get("fusion_scout")!.execute({ questions: ["q"] }, context("one"))).rejects.toThrow("unreadable");
		await expect(tools.get("fusion_reset")!.execute({}, context("one"))).rejects.toThrow("unreadable");
	});

	test("a failed intent write blocks submission before any native work (P1 review round)", async () => {
		const tools = new Map<string, Tool>();
		let submissions = 0;
		let scoutWrites = 0;
		const base = memoryStorage();
		const storage = { get: base.get, set: async (key: string, value: unknown) => {
			// Every scout-intent write fails: submission must block.
			if (String(key).startsWith("scout-pending/")) { scoutWrites++; throw new Error("storage offline"); }
			await base.set(key, value);
		}, remove: base.remove };
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async () => {},
			list: async () => [{ id: "subagent", execute: async () => { submissions++; return { output: { sessionID: "scout-child", status: "completed", output: "answer" } }; } }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} }, storage, { scoutSettleTimeoutMs: 30 });
		const first = await tools.get("fusion_scout")!.execute({ questions: ["q"] }, context("one"));
		expect(first.content).toContain("could not persist the scout submission intent");
		expect(first.content).toContain("storage offline");
		expect(first.content).toContain("no scout was started");
		// No native work started without its duplicate protection, and a retry
		// fails the same way while storage stays broken.
		expect(submissions).toBe(0);
		expect(scoutWrites).toBe(1);
		const second = await tools.get("fusion_scout")!.execute({ questions: ["q"] }, context("one"));
		expect(second.content).toContain("storage offline");
		expect(submissions).toBe(0);
	});

	test("a failed reference bind surfaces the failure and keeps the outstanding intent (P1 review round)", async () => {
		const tools = new Map<string, Tool>();
		const values = new Map<string, unknown>();
		let submissions = 0;
		let scoutWrites = 0;
		let failBind = true;
		const busQueue: { type: string; data?: Record<string, unknown> }[] = [];
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => setTimeout(resolve, 20)); } } } } }) };
		const storage = { get: async (key: string) => values.get(key), set: async (key: string, value: unknown) => {
			// The intent write succeeds; the child-reference bind write fails.
			if (String(key).startsWith("scout-pending/") && ++scoutWrites >= 2 && failBind) throw new Error("storage offline");
			values.set(key, structuredClone(value));
		}, remove: async (key: string) => { values.delete(key); } };
		await setupTest({ location: { directory: tmpdir() }, event: eventHost, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async () => {},
			list: async () => [{ id: "subagent", execute: async () => { submissions++; return { output: { sessionID: "scout-child", status: "running", output: "backgrounded" } }; } }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} }, storage, { scoutSettleTimeoutMs: 30 });
		const result = await tools.get("fusion_scout")!.execute({ questions: ["q"] }, context("one"));
		// The failure surfaces through the tool result — the child exists, so
		// the submission intent must stay persisted (fail-closed).
		expect(result.content).toContain("Fusion scout failed");
		expect(result.content).toContain("storage offline");
		expect(submissions).toBe(1);
		// The unproven scout still gates new work.
		await expect(tools.get("fusion_scout")!.execute({ questions: ["again"] }, context("one"))).rejects.toThrow("still unproven");
		expect(submissions).toBe(1);
		// The child's terminal event resolves the record once storage accepts
		// writes again: the gate lifts without a second submission for the old
		// request.
		failBind = false;
		busQueue.push({ type: "session.execution.succeeded", data: { sessionID: "scout-child" } });
		await new Promise((resolve) => setTimeout(resolve, 120));
		const second = await tools.get("fusion_scout")!.execute({ questions: ["q2"] }, context("one"));
		expect(second.metadata?.status).toBe("pending");
		expect(submissions).toBe(2);
	});

	test("an unrelated terminal event deletes no retained scout record (P1 review round 3)", async () => {
		const tools = new Map<string, Tool>();
		let submissions = 0;
		const messages: unknown[] = [];
		const busQueue: { type: string; data?: Record<string, unknown> }[] = [];
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => setTimeout(resolve, 20)); } } } } }) };
		await setupTest({ location: { directory: tmpdir() }, event: eventHost, session: { context: async () => messages, hook: async () => {} }, tool: {
			hook: async () => {},
			list: async () => [{ id: "subagent", execute: async () => { submissions++; return { output: { sessionID: "scout-child", status: "running", output: "backgrounded" } }; } }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} }, memoryStorage(), { scoutSettleTimeoutMs: 30 });
		const result = await tools.get("fusion_scout")!.execute({ questions: ["q"] }, context("one"));
		expect(result.metadata?.status).toBe("pending");
		// An unrelated session's completion event must not resolve the record:
		// only an exact match on the terminating child clears it.
		busQueue.push({ type: "session.execution.succeeded", data: { sessionID: "ses-someone-else" } });
		busQueue.push({ type: "session.execution.failed", data: { sessionID: "ses-someone-else" } });
		await new Promise((resolve) => setTimeout(resolve, 120));
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.pendingScout?.childSessionID).toBe("scout-child");
		await expect(tools.get("fusion_scout")!.execute({ questions: ["again"] }, context("one"))).rejects.toThrow("still unproven");
		expect(submissions).toBe(1);
		// The child's own terminal event resolves it exactly.
		busQueue.push({ type: "session.execution.succeeded", data: { sessionID: "scout-child" } });
		await new Promise((resolve) => setTimeout(resolve, 120));
		const second = await tools.get("fusion_scout")!.execute({ questions: ["q2"] }, context("one"));
		expect(second.metadata?.status).toBe("pending");
		expect(submissions).toBe(2);
	});

	test("historical scout children cannot settle another request, including after reload", async () => {
		const storage = memoryStorage();
		const tools = new Map<string, Tool>();
		const busQueue: { type: string; data?: Record<string, unknown> }[] = [];
		let wake: (() => void) | undefined;
		let submissions = 0;
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => {
			for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => { wake = resolve; }); }
		} }; } }) };
		const native = { id: "subagent", execute: async () => {
			submissions += 1;
			if (submissions === 1) return { output: { sessionID: "historical-scout", status: "completed", output: "previous answer" } };
			throw new Error("connection lost after a new request was accepted");
		} };
		await setupTest({ location: { directory: "/workspace" }, event: eventHost,
			session: { context: async () => [], hook: async () => {}, list: async () => [{ id: "historical-scout", agent: "fusion-scout", parentID: "one", time: { created: 1 } }] },
			tool: { hook: async () => {}, list: async () => [native], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		}, storage);
		await tools.get("fusion_scout")!.execute({ questions: ["first task"] }, context("one"));
		const failed = await tools.get("fusion_scout")!.execute({ questions: ["second task"] }, context("one"));
		expect(failed.content).toContain("connection lost");
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.pendingScout?.requestId).toBeString();
		expect(status.pendingScout?.childSessionID).toBeUndefined();
		// Replaying the historical child's completion cannot settle the failed request.
		busQueue.push({ type: "session.execution.succeeded", data: { sessionID: "historical-scout" } }); wake?.();
		await new Promise((resolve) => setTimeout(resolve, 40));
		await expect(tools.get("fusion_scout")!.execute({ questions: ["duplicate second task"] }, context("one"))).rejects.toThrow("unresolved");
		expect(submissions).toBe(2);
		const restored = new Map<string, Tool>();
		await setupTest({ location: { directory: "/workspace" }, session: { context: async () => [], hook: async () => {} },
			tool: { hook: async () => {}, list: async () => [native], transform: async (callback) => { callback({ add: (tool) => restored.set(tool.name, tool) }); } },
		}, storage);
		await expect(restored.get("fusion_scout")!.execute({ questions: ["retry after reload"] }, context("one"))).rejects.toThrow("unresolved");
		expect(submissions).toBe(2);
	});

	test("a failed submission retains uncertainty regardless of session registry candidates", async () => {
		const busQueue: { type: string; data?: Record<string, unknown> }[] = [];
		const eventHost = { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: async () => { for (;;) { const next = busQueue.shift(); if (next) return { value: next, done: false as const }; await new Promise<void>((resolve) => setTimeout(resolve, 20)); } } } } }) };
		let listing: unknown[] = [];
		let listAvailable = true;
		const run = async () => {
			const tools = new Map<string, Tool>();
			let submissions = 0;
			await setupTest({ location: { directory: tmpdir() }, event: eventHost, session: { context: async () => [] as unknown[], hook: async () => {}, list: async () => { if (!listAvailable) throw new Error("registry unavailable"); return listing; } }, tool: {
				hook: async () => {},
				list: async () => [{ id: "subagent", execute: async () => { submissions++; throw new Error("connection failed mid-submission"); } }],
				transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
			} }, memoryStorage(), { scoutSettleTimeoutMs: 30 });
			return { tools, submissions: () => submissions };
		};
		// Case A: a child under the same parent is not evidence that it
		// belongs to this request. Its terminal event must not unlock a retry.
		{
			listing = [{ id: "orphan-1", agent: "fusion-scout", parentID: "one", time: { created: Date.now() } }];
			const { tools, submissions } = await run();
			const result = await tools.get("fusion_scout")!.execute({ questions: ["q"] }, context("one"));
			expect(result.content).toContain("connection failed mid-submission");
			expect(result.content).toContain("unresolved");
			expect(submissions()).toBe(1);
			const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
			expect(status.pendingScout?.childSessionID).toBeUndefined();
			await expect(tools.get("fusion_scout")!.execute({ questions: ["again"] }, context("one"))).rejects.toThrow("unresolved");
			busQueue.push({ type: "session.execution.succeeded", data: { sessionID: "orphan-1" } });
			await new Promise((resolve) => setTimeout(resolve, 120));
			await expect(tools.get("fusion_scout")!.execute({ questions: ["q2"] }, context("one"))).rejects.toThrow("unresolved");
			expect(submissions()).toBe(1);
		}
		// Case B: the registry shows no scout child — that absence alone is
		// never evidence (P1, review round 4: a child may be created after the
		// snapshot), so the record stays uncertain and new work stays blocked.
		{
			listing = [];
			const { tools, submissions } = await run();
			const result = await tools.get("fusion_scout")!.execute({ questions: ["q"] }, context("one"));
			expect(result.content).toContain("connection failed mid-submission");
			expect(result.content).toContain("unresolved");
			expect(submissions()).toBe(1);
			await expect(tools.get("fusion_scout")!.execute({ questions: ["again"] }, context("one"))).rejects.toThrow("unresolved");
			expect(submissions()).toBe(1);
		}
		// Case B2: an unrecognized registry response is not an empty registry —
		// the record stays uncertain too.
		{
			listing = [{ unrecognized: true }];
			const { tools, submissions } = await run();
			const result = await tools.get("fusion_scout")!.execute({ questions: ["q"] }, context("one"));
			expect(result.content).toContain("connection failed mid-submission");
			expect(result.content).toContain("unresolved");
			expect(submissions()).toBe(1);
			await expect(tools.get("fusion_scout")!.execute({ questions: ["again"] }, context("one"))).rejects.toThrow("unresolved");
			expect(submissions()).toBe(1);
		}
		// Case C: the registry is unavailable — uncertainty is retained and new
		// scout work stays blocked (fail-closed).
		{
			listAvailable = false;
			listing = [];
			const { tools, submissions } = await run();
			const result = await tools.get("fusion_scout")!.execute({ questions: ["q"] }, context("one"));
			expect(result.content).toContain("connection failed mid-submission");
			expect(result.content).toContain("unresolved");
			expect(submissions()).toBe(1);
			await expect(tools.get("fusion_scout")!.execute({ questions: ["again"] }, context("one"))).rejects.toThrow("unresolved");
			expect(submissions()).toBe(1);
		}
	});

	test("the operator resolves a childless record explicitly through /fusion-clean (P1 review round 4)", async () => {
		const commands = new Map<string, CommandDefinition>();
		const run = async () => {
			const tools = new Map<string, Tool>();
			let submissions = 0;
			await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [] as unknown[], hook: async () => {}, list: async () => [] }, command: { list: async () => ({ data: [] }), transform: async (callback) => { await callback({ add: (command) => commands.set(command.name, command) }); } }, tool: {
				hook: async () => {},
				list: async () => [{ id: "subagent", execute: async () => { submissions++; throw new Error("connection failed mid-submission"); } }],
				transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
			} }, memoryStorage(), { scoutSettleTimeoutMs: 30 });
			return { tools, submissions: () => submissions };
		};
		const { tools, submissions } = await run();
		const failed = await tools.get("fusion_scout")!.execute({ questions: ["q"] }, context("one"));
		expect(failed.content).toContain("connection failed mid-submission");
		expect(failed.content).toContain("unresolved");
		expect(submissions()).toBe(1);
		// The record is childless and uncertain: scouts stay blocked until the
		// operator resolves it.
		await expect(tools.get("fusion_scout")!.execute({ questions: ["again"] }, context("one"))).rejects.toThrow("unresolved");
		// The resolution is deliberate: an unknown argument is refused.
		await expect(commands.get("fusion-clean")!.execute({ sessionID: "one", prompt: { text: "anything-else" } })).rejects.toThrow("resolve-unproven-scout");
		// The explicit resolution lifts the childless record and reports that
		// the outcome stays unproven.
		const resolved = await commands.get("fusion-clean")!.execute({ sessionID: "one", prompt: { text: "resolve-unproven-scout" } });
		expect(resolved).toContain("resolved at operator request");
		// New scout work may run again.
		const second = await tools.get("fusion_scout")!.execute({ questions: ["q2"] }, context("one"));
		expect(second.content).toContain("connection failed mid-submission");
		expect(submissions()).toBe(2);
		// A record with a child is refused by the resolution: it settles
		// through its terminal state, not this command.
		const boundCommands = new Map<string, CommandDefinition>();
		const boundTools = new Map<string, Tool>();
		let boundSubmissions = 0;
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [] as unknown[], hook: async () => {} }, command: { list: async () => ({ data: [] }), transform: async (callback) => { await callback({ add: (command) => boundCommands.set(command.name, command) }); } }, tool: {
			hook: async () => {},
			list: async () => [{ id: "subagent", execute: async () => { boundSubmissions++; return { output: { sessionID: "scout-bound", status: "running", output: "backgrounded" } }; } }],
			transform: async (callback) => { callback({ add: (tool) => boundTools.set(tool.name, tool) }); },
		} }, memoryStorage(), { scoutSettleTimeoutMs: 30 });
		await boundTools.get("fusion_scout")!.execute({ questions: ["q"] }, context("one"));
		await expect(boundCommands.get("fusion-clean")!.execute({ sessionID: "one", prompt: { text: "resolve-unproven-scout" } })).rejects.toThrow("has a child");
		expect(boundSubmissions).toBe(1);
	});
});

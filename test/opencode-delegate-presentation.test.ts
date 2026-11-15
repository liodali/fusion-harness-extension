import { expect, test } from "bun:test";
import { delegateInput, delegateMonitor } from "../src/opencode/delegate-presentation.ts";
import { actionLabel, elapsedLabel, latestDelegateActivity } from "../src/opencode/activity-view.ts";
import { stopFeedback, type ExecutorStop } from "../src/opencode/executor-stop.ts";
import type { WorkerEvent, ExecutorEvent } from "../src/core/worker.ts";

const event = (value: ExecutorEvent) => ({ event: value }) as WorkerEvent;

test("compact input preserves the full brief and original task; legacy direct calls remain valid", () => {
	const brief = "Instructions\n".repeat(1000);
	expect(delegateInput({ action: "revise", title: "Fix upload tests", details: { brief, originalTask: "Upload support" } })).toEqual({ action: "revise", title: "Fix upload tests", brief, originalTask: "Upload support" });
	expect(delegateInput({ action: "execute", brief })).toMatchObject({ action: "execute", brief });
	expect(() => delegateInput({ action: "execute", details: { brief }, brief: "conflicting" })).toThrow("details only");
	expect(() => delegateInput({ action: "execute", details: { brief: 1 } })).toThrow("Invalid");
});

test("stalled progress never blocks work and coalesces bounded updates without losing the child reference", async () => {
	const updates: Record<string, unknown>[] = [];
	let unlock!: () => void;
	const gate = new Promise<void>((resolve) => { unlock = resolve; });
	const monitor = delegateMonitor({ action: "execute", title: "Implement objects", streaming: true, progress: async (update) => { await gate; updates.push(update); }, now: () => 1000 });
	void monitor.start();
	const published = monitor.nativeProgress({ sessionID: "ses_child", status: "running" });
	monitor.onEvent(event({ type: "tool_start", toolCallId: "call", toolName: "edit", args: { secret: "private-input" } }));
	monitor.onEvent(event({ type: "tool_start", toolCallId: "call", toolName: "edit", args: {} }));
	monitor.onEvent(event({ type: "tool_end", toolCallId: "call", toolName: "edit", isError: false, result: "private-result" }));
	const final = await monitor.finish("completed");
	expect(updates).toHaveLength(0);
	expect(final).toMatchObject({ phase: "completed", tools: 1, childSessionID: "ses_child" });
	await published;
	unlock();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(updates).toHaveLength(2);
	expect(updates[1]).toMatchObject({ sessionID: "ses_child", status: "running" });
	expect((updates.at(-1)!.fusion as { phase: string }).phase).toBe("completed");
	expect(JSON.stringify(updates)).not.toContain("private-");
	monitor.onEvent(event({ type: "tool_start", toolCallId: "late", toolName: "write", args: {} }));
	expect(monitor.snapshot().tools).toBe(1);
});

test("private reasoning and output are ignored; UI failures do not fail execution", async () => {
	const monitor = delegateMonitor({ action: "final_fix", title: "Final checks", streaming: false, progress: async () => { throw Error("UI offline"); } });
	await monitor.start();
	monitor.onEvent(event({ type: "reasoning_delta", delta: "private reasoning" }));
	monitor.onEvent(event({ type: "text_delta", delta: "private output" }));
	expect(monitor.snapshot().activity).toBe("Executor activity unavailable");
	await expect(monitor.finish("background")).resolves.toMatchObject({ phase: "background", tools: 0 });
});

test("confirmed waits surface in the activity card and close with their host outcome (R3)", async () => {
	const updates: Record<string, unknown>[] = [];
	const monitor = delegateMonitor({ action: "execute", title: "Implement objects", streaming: true, progress: async (update) => { updates.push(update); }, now: (() => { let n = 1000; return () => (n += 1000); })() });
	await monitor.start();
	monitor.waitOpened({ kind: "permission", label: "bash /tmp/x", since: 2000 });
	expect(monitor.snapshot().wait).toEqual({ kind: "permission", label: "bash /tmp/x", since: 2000 });
	// A replayed open for the same wait is bounded: one pending update, no spam.
	monitor.waitOpened({ kind: "permission", label: "bash /tmp/x", since: 2000 });
	monitor.waitClosed({ outcome: "denied" });
	expect(monitor.snapshot().wait).toBeUndefined();
	expect(monitor.snapshot().activity).toBe("Permission denied: bash /tmp/x");
	monitor.waitOpened({ kind: "user", label: "Questions — Which approach?", since: 5000 });
	monitor.waitClosed({ outcome: "answered" });
	expect(monitor.snapshot().activity).toBe("Answered question: Questions — Which approach?");
	// A finished card never carries an open wait.
	await monitor.finish("completed");
	expect(monitor.snapshot().wait).toBeUndefined();
	// Updates stay bounded: one per transition, plus the finish.
	expect(updates.length).toBeLessThanOrEqual(6);
});

test("the activity view validates the wait shape additively and the TUI label words the required action", async () => {
	const card = { type: "assistant", content: [{ type: "tool", name: "fusion_delegate", state: { status: "streaming", input: { action: "execute", title: "T" }, metadata: { fusion: { version: 1, action: "execute", title: "T", phase: "working", activity: "Running bash", tools: 1, startedAt: 1000, updatedAt: 2000, childSessionID: "ses_child", wait: { kind: "permission", label: "bash /tmp/x", since: 1500 } } } }, time: { created: 1000 } }] };
	const activity = latestDelegateActivity([card]);
	expect(activity?.wait).toEqual({ kind: "permission", label: "bash /tmp/x", since: 1500 });
	// A malformed wait is dropped, never rendered.
	const bad = structuredClone([card]) as { content: { state: { metadata: { fusion: Record<string, unknown> } } }[] }[];
	bad[0].content[0].state.metadata.fusion.wait = { kind: "terminal", label: "x", since: "no" };
	expect(latestDelegateActivity(bad)?.wait).toBeUndefined();
	const { formatWaitBadge } = await import("../src/opencode/activity-view.ts");
	expect(formatWaitBadge({ kind: "permission", label: "bash /tmp/x" })).toBe("permission requested: bash /tmp/x — allow or deny it to continue");
	expect(formatWaitBadge({ kind: "user", label: "Questions" })).toBe("question asked: Questions — answer or cancel it to continue");
	expect(formatWaitBadge(undefined)).toBe("");
});

test("activity view selects the newest delegation and keeps streamed inputs from resurrecting old activity", () => {
	const old = { type: "tool", name: "fusion_delegate", state: { status: "completed", input: { action: "execute", title: "Old" } }, time: { created: 1000 } };
	const messages = [{ type: "assistant", content: [old] }, { type: "assistant", content: [{ type: "tool", name: "fusion_delegate", state: { status: "streaming", input: {} } }] }];
	expect(latestDelegateActivity(messages)).toBeUndefined();
	expect(latestDelegateActivity(messages.slice(0, 1))).toMatchObject({ title: "Old", phase: "completed" });
	expect(actionLabel("final_fix")).toBe("Final fix");
	expect(elapsedLabel(1000, 66000)).toBe("1:05");
	expect(elapsedLabel(5000, 0)).toBe("0:00");
});

test("a matching reconciliation updates a background card without settling unrelated children", () => {
	const activity = { version: 1, action: "execute", title: "Objects", phase: "background", activity: "Awaiting reconciliation", tools: 3, startedAt: 1000, updatedAt: 2000, childSessionID: "ses_child", requestId: "req_current" };
	const parent = { type: "assistant", content: [{ type: "tool", name: "fusion_delegate", state: { status: "completed", metadata: { fusion: activity } } }] };
	const reconcile = (childSessionID: string, requestId = "req_current") => ({ type: "assistant", content: [{ type: "tool", name: "fusion_reconcile", time: { completed: 5000 }, state: { status: "completed", metadata: { childSessionID, requestId, status: "completed" } } }] });
	expect(latestDelegateActivity([parent, reconcile("ses_other")])).toMatchObject({ phase: "background", tools: 3 });
	expect(latestDelegateActivity([parent, reconcile("ses_child", "req_previous")])).toMatchObject({ phase: "background" });
	expect(latestDelegateActivity([parent, reconcile("ses_child")])).toMatchObject({ phase: "completed", tools: 3, updatedAt: 5000 });
});

test("completion while stopping is reported as completion rather than cancellation", () => {
	const stop: ExecutorStop = { requestId: "request", requestedAt: 2000, updatedAt: 3000, state: "confirmed", terminal: "completed", reason: "stop" };
	const messages = [{ type: "assistant", content: [{ type: "tool", name: "fusion_delegate", state: { metadata: { fusion: { version: 1, action: "execute", title: "Task", phase: "working", activity: "Running edit", tools: 1, startedAt: 1000, updatedAt: 2000, childSessionID: "ses_child", requestId: "request" } } } }] }, { type: "synthetic", metadata: { fusionStop: stop } }];
	expect(latestDelegateActivity(messages)).toMatchObject({ phase: "completed", activity: "Executor completed before interruption" });
	expect(stopFeedback(stop)).toContain("completed before interruption");
});

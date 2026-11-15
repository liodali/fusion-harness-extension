import { describe, expect, test } from "bun:test";
import {
	describeWaitStatus,
	OpenCodeWaitSignal,
	openCodeWaitSignal,
	piUiPromptWait,
	WaitClock,
	waitAction,
	waitLabel,
} from "../src/core/waiting.ts";

/** A pause/resume target recording every effective call, standing in for
 * ActiveClock: pause while already paused and resume while running are
 * no-ops, exactly like the real clock. */
function target() {
	const calls: ("pause" | "resume")[] = [];
	let paused = false;
	return {
		calls,
		pause: () => { if (!paused) { paused = true; calls.push("pause"); } },
		resume: () => { if (paused) { paused = false; calls.push("resume"); } },
	};
}

describe("shared waiting observation (R3)", () => {
	test("a confirmed wait pauses the active clock and closing resumes it", () => {
		const clock = target();
		const waits = new WaitClock(clock, { now: () => 1000 });
		expect(waits.openWait({ id: "perm1", kind: "permission", label: "bash /tmp/x" })).toEqual({ id: "perm1", kind: "permission", label: "bash /tmp/x", startedAt: 1000 });
		expect(clock.calls).toEqual(["pause"]);
		expect(waits.closeWait({ id: "perm1", outcome: "answered", endedAt: 4000 })).toEqual({ id: "perm1", kind: "permission", label: "bash /tmp/x", startedAt: 1000 });
		expect(clock.calls).toEqual(["pause", "resume"]);
		const status = waits.status();
		expect(status.wait).toBeUndefined();
		expect(status.openWaits).toBe(0);
		expect(status.waitingMs).toBe(3000);
	});

	test("waiting time is accounted per span and bounded by the span ring", () => {
		let now = 0;
		const waits = new WaitClock(undefined, { now: () => now, maxSpans: 2 });
		for (const [start, end, id] of [[0, 100, "a"], [200, 500, "b"], [600, 900, "c"], [1000, 1100, "d"]] as const) {
			now = start;
			waits.openWait({ id, kind: "permission", label: id });
			now = end;
			waits.closeWait({ id, outcome: "answered" });
		}
		// Only the last two spans are kept (bounded ring): 300 + 100.
		expect(waits.status().waitingMs).toBe(400);
	});

	test("reopening the same wait id is an idempotent no-op", () => {
		const clock = target();
		const waits = new WaitClock(clock, { now: () => 0 });
		waits.openWait({ id: "perm1", kind: "permission", label: "bash" });
		expect(waits.openWait({ id: "perm1", kind: "permission", label: "bash" })).toBeUndefined();
		expect(clock.calls).toEqual(["pause"]);
		waits.closeWait({ id: "perm1", outcome: "answered", endedAt: 500 });
		expect(waits.status().waitingMs).toBe(500);
	});

	test("outstanding waits are tracked by identity: answering one leaves the others waiting", () => {
		const clock = target();
		let now = 0;
		const waits = new WaitClock(clock, { now: () => now });
		// Two requests open while the turn runs (e.g. parallel tool calls).
		waits.openWait({ id: "perm_a", kind: "permission", label: "bash a" });
		now = 100;
		waits.openWait({ id: "perm_b", kind: "permission", label: "bash b" });
		// The clock stays paused across both; the older wait is reported.
		expect(clock.calls).toEqual(["pause"]);
		expect(waits.status().wait).toMatchObject({ id: "perm_a", label: "bash a" });
		expect(waits.status().openWaits).toBe(2);
		// Answering B closes only B; A remains outstanding and the clock stays paused.
		expect(waits.closeWait({ id: "perm_b", outcome: "answered", endedAt: 300 })).toMatchObject({ id: "perm_b" });
		expect(clock.calls).toEqual(["pause"]);
		expect(waits.status().wait).toMatchObject({ id: "perm_a" });
		expect(waits.status().openWaits).toBe(1);
		expect(waits.status().waitingMs).toBe(200);
		// The clock resumes only when the last outstanding wait closes.
		waits.closeWait({ id: "perm_a", outcome: "denied", endedAt: 500 });
		expect(clock.calls).toEqual(["pause", "resume"]);
		expect(waits.status().wait).toBeUndefined();
		expect(waits.status().openWaits).toBe(0);
		// The observed waiting time is the union of the spans (A 0–500, B
		// 100–300 overlap): 500ms, not the 700ms double-counted sum.
		expect(waits.status().waitingMs).toBe(500);
	});

	test("closing an unknown or already-closed id is a no-op (late/duplicate events)", () => {
		const clock = target();
		const waits = new WaitClock(clock, { now: () => 0 });
		expect(waits.closeWait({ id: "never-opened", outcome: "cancelled" })).toBeUndefined();
		waits.openWait({ id: "a", kind: "permission", label: "x" });
		waits.closeWait({ id: "a", outcome: "answered" });
		expect(waits.closeWait({ id: "a", outcome: "denied" })).toBeUndefined();
		expect(clock.calls).toEqual(["pause", "resume"]);
		expect(waits.status().waitingMs).toBe(0);
	});

	test("activity clears the stale flag and the idle threshold flags stale without an outcome claim", () => {
		let now = 0;
		const waits = new WaitClock(undefined, { now: () => now, staleAfterMs: 60_000 });
		waits.markActivity({ label: "Running bash", observation: "implementing", at: 0 });
		now = 61_000;
		expect(waits.status().stale).toBe(true);
		now = 120_000;
		// The flag is advisory; a status with an open wait is not stale.
		waits.openWait({ id: "p", kind: "permission", label: "bash" });
		expect(waits.status().stale).toBe(false);
		waits.closeWait({ id: "p", outcome: "answered" });
		// New activity clears it.
		waits.markActivity({ label: "Running edit", observation: "implementing", at: now });
		now += 10;
		expect(waits.status().stale).toBe(false);
	});

	test("reset disposes state with the worker without touching the clock target", () => {
		const clock = target();
		const waits = new WaitClock(clock, { now: () => 0 });
		waits.openWait({ id: "a", kind: "user", label: "q" });
		waits.markActivity({ label: "Working" });
		waits.reset();
		// The clock is discarded with its turn; a dangling resume could only
		// rearm a budget timer for a turn that is over.
		expect(clock.calls).toEqual(["pause"]);
		const status = waits.status();
		expect(status.wait).toBeUndefined();
		expect(status.openWaits).toBe(0);
		expect(status.waitingMs).toBe(0);
		expect(status.lastActivity).toBeUndefined();
		expect(status.stale).toBe(false);
	});

	test("wait labels are bounded and carry no control bytes or escapes", () => {
		expect(waitLabel("\x1b[31m permission \n\t edit\x00\x1f  src/app.ts  ")).toBe("permission edit src/app.ts");
		expect(waitLabel("x".repeat(500)).length).toBe(120);
	});

	test("the required action is worded per wait kind and never invents an outcome", () => {
		expect(waitAction("permission", "bash /tmp")).toBe("allow or deny it (bash /tmp) to continue");
		expect(waitAction("user", "Which approach?")).toBe("answer or cancel it (Which approach?) to continue");
		expect(waitAction("unknown", "")).toContain("inspect the worker session");
	});

	test("the shared status line reports worker, activity, durations, and required action", () => {
		const waiting = describeWaitStatus({
			worker: "Executor", observation: "waiting-permission", activeMs: 90_000, waitingMs: 30_000,
			wait: { kind: "permission", label: "bash sleep 25", startedAt: 0 }, now: 25_000,
		});
		expect(waiting).toContain("Executor");
		expect(waiting).toContain("permission requested — bash sleep 25");
		expect(waiting).toContain("for 25.0s");
		expect(waiting).toContain("active 1m 30s");
		expect(waiting).toContain("observed waits 30.0s");
		expect(waiting).toContain("allow or deny it");
		const running = describeWaitStatus({
			worker: "Executor", observation: "implementing", lastActivity: "Running bash · src/x.ts", activeMs: 60_000, waitingMs: 0, unobservedMs: 5_000,
		});
		expect(running).toContain("Executor implementing");
		expect(running).toContain("last observed: Running bash · src/x.ts");
		expect(running).toContain("active 1m");
		expect(running).toContain("unattributed 5.0s");
		const stale = describeWaitStatus({ worker: "Executor", observation: "unknown", stale: true });
		expect(stale).toContain("inspect the worker if this is unexpected");
		// The stale line never claims blocked or terminal outcomes.
		expect(stale).not.toMatch(/blocked|terminal|ended|completed|failed/i);
	});
});

describe("OpenCode wait bus translation", () => {
	test("permission.asked opens a bounded permission wait from host-provided names", () => {
		const signal = openCodeWaitSignal("permission.asked", { sessionID: "child", id: "perm_1", action: "bash", resources: ["/tmp/x", "/tmp/y"], message: "Run sleep" });
		expect(signal?.open).toEqual({ id: "perm_1", kind: "permission", label: "bash /tmp/x, /tmp/y" });
		const legacy = openCodeWaitSignal("permission.updated", { sessionID: "child", permissionID: "perm_2", action: "edit", title: "Edit src/app.ts" });
		expect(legacy?.open).toEqual({ id: "perm_2", kind: "permission", label: "edit" });
	});

	test("a permission event without an identity is not a wait signal", () => {
		expect(openCodeWaitSignal("permission.asked", { sessionID: "child", action: "bash" })).toBeUndefined();
		expect(openCodeWaitSignal("permission.replied", { sessionID: "child" })).toBeUndefined();
		expect(openCodeWaitSignal("permission.asked", undefined)).toBeUndefined();
		expect(openCodeWaitSignal("session.tool.called", { sessionID: "child", id: "call" })).toBeUndefined();
	});

	test("permission.replied distinguishes allowed and denied replies", () => {
		expect(openCodeWaitSignal("permission.replied", { sessionID: "child", requestID: "perm_1", reply: "once" })?.close).toEqual({ id: "perm_1", outcome: "answered" });
		expect(openCodeWaitSignal("permission.replied", { sessionID: "child", requestID: "perm_1", reply: "always" })?.close).toEqual({ id: "perm_1", outcome: "answered" });
		expect(openCodeWaitSignal("permission.replied", { sessionID: "child", requestID: "perm_1", reply: "reject" })?.close).toEqual({ id: "perm_1", outcome: "denied" });
		expect(openCodeWaitSignal("permission.replied", { sessionID: "child", requestID: "perm_1", reply: "unexpected" })?.close).toEqual({ id: "perm_1", outcome: "resolved" });
	});

	test("form events translate to user waits with bounded question labels", () => {
		const created = openCodeWaitSignal("form.created", { form: { id: "frm_1", sessionID: "child", title: "Questions", fields: [{ key: "q0", title: "Which approach should I take?", type: "string" }] } });
		expect(created?.open).toEqual({ id: "frm_1", kind: "user", label: "Questions — Which approach should I take?" });
		expect(openCodeWaitSignal("form.replied", { id: "frm_1", sessionID: "child", answer: { q0: "a" } })?.close).toEqual({ id: "frm_1", outcome: "answered" });
		expect(openCodeWaitSignal("form.cancelled", { id: "frm_1", sessionID: "child" })?.close).toEqual({ id: "frm_1", outcome: "cancelled" });
	});

	test("session status and idle events are activity signals, not waits", () => {
		expect(openCodeWaitSignal("session.status", { sessionID: "child", status: { type: "busy" } })).toMatchObject({ sessionID: "child", activity: { busy: true, status: "busy" } });
		expect(openCodeWaitSignal("session.status", { sessionID: "child", status: { type: "idle" } })?.activity).toEqual({ busy: false, status: "idle" });
		expect(openCodeWaitSignal("session.idle", { sessionID: "child" })?.activity).toEqual({ busy: false, status: "idle" });
	});

	test("type is exported for the plugin surface", () => {
		const probe: OpenCodeWaitSignal | undefined = openCodeWaitSignal("session.status", { sessionID: "s", status: { type: "busy" } });
		expect(probe?.activity?.busy).toBe(true);
	});
});

describe("Pi ui-prompt translation", () => {
	test("confirm dialogs are permission waits; other prompts are user waits", () => {
		expect(piUiPromptWait("confirm", "Allow bash?")).toEqual({ kind: "permission", label: "Allow bash?" });
		expect(piUiPromptWait("select", "Pick a model")).toEqual({ kind: "user", label: "Pick a model" });
		expect(piUiPromptWait("input", "Answer")).toEqual({ kind: "user", label: "Answer" });
		expect(piUiPromptWait("custom", undefined)).toEqual({ kind: "user", label: "" });
		expect(piUiPromptWait("whatever", "x")).toEqual({ kind: "unknown", label: "x" });
	});
});

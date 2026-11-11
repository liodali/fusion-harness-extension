import { describe, expect, test } from "bun:test";
import {
	addActiveTime,
	type BudgetRole,
	createRunBudget,
	describeRunBudget,
	evaluateRunBudget,
	type RunBudget,
	ActiveClock,
	readRunBudget,
	recordRoleUsage,
	remainingActiveMs,
} from "../src/core/budget.ts";
import type { RunControlPolicy } from "../src/core/run-control.ts";

const allRoles: readonly BudgetRole[] = ["supervisor", "executor", "scout"];
const workerRoles: readonly BudgetRole[] = ["executor", "scout"];

const usage = (over: Partial<Parameters<typeof recordRoleUsage>[1]["usage"]> = {}) => ({
	inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 20, reasoningTokens: 5, cost: 0.5, ...over,
});

describe("run budget records", () => {
	test("absent reads as no budget; a valid record round-trips", () => {
		expect(readRunBudget(undefined)).toBeUndefined();
		expect(readRunBudget(null)).toBeUndefined();
		const budget: RunBudget = { version: 1, activeMs: 1200, roles: { executor: { turnsReported: 2, turnsMissing: 1, cost: 0.4 } } };
		expect(readRunBudget(JSON.parse(JSON.stringify(budget)))).toEqual(budget);
	});

	test("unknown extra fields are preserved; malformed or future records throw fail-closed", () => {
		const budget = { version: 1, activeMs: 5, roles: {}, futureField: { nested: true } };
		const read = readRunBudget(budget);
		expect(read).toMatchObject({ version: 1, activeMs: 5, futureField: { nested: true } });
		for (const malformed of [
			{ version: 2, activeMs: 0, roles: {} },
			{ version: 1, activeMs: -1, roles: {} },
			{ version: 1, activeMs: 0 },
			{ version: 1, activeMs: 0, roles: { manager: { turnsReported: 0, turnsMissing: 0 } } },
			{ version: 1, activeMs: 0, roles: { executor: { turnsReported: -1, turnsMissing: 0 } } },
			{ version: 1, activeMs: 0, roles: { executor: { turnsReported: 1, turnsMissing: 0, cost: "none" } } },
			{ version: 1, activeMs: 0, roles: {}, providers: { "": { turnsReported: 0, turnsMissing: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, fieldTurns: {} } } },
			{ version: 1, activeMs: 0, roles: {}, unknownWaiver: "yes" },
			{ version: 1, activeMs: 0, roles: {}, counted: [42] },
		]) {
			expect(() => readRunBudget(malformed)).toThrow("budget");
		}
		expect(() => readRunBudget("stopped")).toThrow("Unsupported");
	});
});

describe("budget accounting", () => {
	test("a turn without usage counts as missing, never zero", () => {
		const budget = createRunBudget();
		recordRoleUsage(budget, { role: "executor", usage: usage() });
		recordRoleUsage(budget, { role: "scout" });
		expect(budget.roles.executor).toMatchObject({ turnsReported: 1, turnsMissing: 0, cost: 0.5, inputTokens: 100 });
		expect(budget.roles.scout).toMatchObject({ turnsReported: 0, turnsMissing: 1 });
		expect(budget.roles.scout?.cost).toBeUndefined();
	});

	test("a field a turn did not carry stays unknown while carried fields accumulate", () => {
		const budget = createRunBudget();
		recordRoleUsage(budget, { role: "executor", usage: usage({ cost: undefined }) });
		recordRoleUsage(budget, { role: "executor", usage: usage() });
		const entry = budget.roles.executor!;
		expect(entry.turnsReported).toBe(2);
		expect(entry.inputTokens).toBe(200);
		expect(entry.cost).toBe(0.5);
		expect(entry.fieldTurns?.cost).toBe(1);
		expect(entry.fieldTurns?.inputTokens).toBe(2);
	});

	test("duplicate dedupe keys are recorded once; distinct keys both count", () => {
		const budget = createRunBudget();
		recordRoleUsage(budget, { role: "executor", usage: usage(), dedupeKey: "reconcile:req-1" });
		recordRoleUsage(budget, { role: "executor", usage: usage(), dedupeKey: "reconcile:req-1" });
		recordRoleUsage(budget, { role: "executor", usage: usage(), dedupeKey: "reconcile:req-2" });
		expect(budget.roles.executor?.cost).toBe(1);
		expect(budget.counted).toEqual(["reconcile:req-1", "reconcile:req-2"]);
	});

	test("late readings count normally and can pass a limit after admission", () => {
		const budget = createRunBudget();
		recordRoleUsage(budget, { role: "executor", usage: usage({ cost: 0.4 }) });
		const open = evaluateRunBudget({ version: 1, observedCostLimit: 1 }, budget, { observableRoles: allRoles });
		expect(open).toMatchObject({ admit: true, status: "open" });
		recordRoleUsage(budget, { role: "executor", usage: usage({ cost: 0.7 }) });
		const crossed = evaluateRunBudget({ version: 1, observedCostLimit: 1 }, budget, { observableRoles: allRoles });
		expect(crossed).toMatchObject({ admit: false, status: "exhausted", limit: "observedCost" });
	});

	test("provider attribution accumulates per provider; unattributed turns skip the ledger", () => {
		const budget = createRunBudget();
		recordRoleUsage(budget, { role: "executor", usage: usage(), provider: "zai" });
		recordRoleUsage(budget, { role: "scout", usage: usage(), provider: "zai" });
		recordRoleUsage(budget, { role: "executor", usage: usage() });
		expect(budget.providers?.zai).toMatchObject({ turnsReported: 2, inputTokens: 200, outputTokens: 100, totalTokens: 300 });
	});

	test("active time accumulates; non-positive spans are ignored", () => {
		const budget = createRunBudget();
		addActiveTime(budget, 1500);
		addActiveTime(budget, 0);
		addActiveTime(budget, -5);
		addActiveTime(budget, Number.NaN);
		expect(budget.activeMs).toBe(1500);
	});
});

describe("active clock", () => {
	test("pauses do not consume active time but stay tracked as waiting", () => {
		let now = 1000;
		const clock = new ActiveClock(() => now);
		clock.start();
		now += 500; // active work
		clock.pause();
		now += 700; // permission wait — tracked separately
		expect(clock.active()).toBe(500);
		expect(clock.wall()).toBe(1200);
		expect(clock.waiting()).toBe(700);
		clock.resume();
		now += 300; // active again
		expect(clock.active()).toBe(800);
		clock.pause();
		expect(clock.stop()).toBe(800);
		expect(clock.active()).toBe(800);
		expect(clock.wall()).toBe(1500);
	});

	test("wall includes unpaused spans; stop commits and freezes", () => {
		let now = 0;
		const clock = new ActiveClock(() => now);
		now += 400;
		expect(clock.active()).toBe(0); // not started: wall runs, active does not
		expect(clock.wall()).toBe(400);
		clock.start();
		now += 600;
		expect(clock.stop()).toBe(600);
		now += 100; // after stop nothing accumulates
		expect(clock.active()).toBe(600);
		expect(clock.wall()).toBe(1000);
	});
});

describe("budget evaluation", () => {
	test("no policy preserves the existing unlimited behavior", () => {
		const decision = evaluateRunBudget(undefined, undefined, { observableRoles: allRoles });
		expect(decision).toEqual({ admit: true, status: "open" });
	});

	test("the exact boundary blocks: equality is reached", () => {
		const budget = createRunBudget();
		addActiveTime(budget, 60_000);
		const policy: RunControlPolicy = { version: 1, activeTimeLimitMs: 60_000 };
		expect(evaluateRunBudget(policy, budget, { observableRoles: allRoles })).toMatchObject({ admit: false, status: "exhausted", limit: "activeTime" });
		addActiveTime(budget, -0); // no negative correction: 60_000 stays at the boundary
		expect(evaluateRunBudget(policy, budget, { observableRoles: allRoles }).admit).toBe(false);
		budget.activeMs = 59_999;
		expect(evaluateRunBudget(policy, budget, { observableRoles: allRoles })).toMatchObject({ admit: true, status: "open" });
	});

	test("remaining active time drives the bounded timer bound", () => {
		const budget = createRunBudget();
		addActiveTime(budget, 10_000);
		expect(remainingActiveMs({ version: 1, activeTimeLimitMs: 30_000 }, budget)).toBe(20_000);
		expect(remainingActiveMs({ version: 1, activeTimeLimitMs: 30_000 }, undefined)).toBe(30_000);
		expect(remainingActiveMs(undefined, budget)).toBeUndefined();
		expect(remainingActiveMs({ version: 1, activeTimeLimitMs: 5_000 }, budget)).toBe(0);
	});

	test("spend at the boundary is exhausted; wording never claims a strict dollar ceiling", () => {
		const budget = createRunBudget();
		recordRoleUsage(budget, { role: "executor", usage: usage({ cost: 2 }), provider: "zai" });
		const decision = evaluateRunBudget({ version: 1, observedCostLimit: 2 }, budget, { observableRoles: allRoles });
		expect(decision).toMatchObject({ admit: false, status: "exhausted", limit: "observedCost" });
		expect(decision.reason).toContain("observed accounting, not a strict ceiling");
		expect(decision.reason).toContain("in-flight work may still spend beyond it");
	});

	test("missing cost readings make a spend-limited run unknown, never zero", () => {
		const budget = createRunBudget();
		recordRoleUsage(budget, { role: "executor", usage: usage({ cost: 0.3 }) });
		recordRoleUsage(budget, { role: "scout" }); // no usage reading at all
		const decision = evaluateRunBudget({ version: 1, observedCostLimit: 5 }, budget, { observableRoles: allRoles });
		expect(decision).toMatchObject({ admit: false, status: "unknown", limit: "observedCost" });
		expect(decision.reason).toContain("never treated as zero");
		// A reported turn that skipped its cost field is also incomplete coverage.
		const partial = createRunBudget();
		recordRoleUsage(partial, { role: "executor", usage: usage({ cost: undefined }) });
		expect(evaluateRunBudget({ version: 1, observedCostLimit: 5 }, partial, { observableRoles: allRoles }).status).toBe("unknown");
	});

	test("an explicit continue waives one unknown-budget admission, then blocks again", () => {
		const budget = createRunBudget();
		recordRoleUsage(budget, { role: "executor" }); // missing reading
		const policy: RunControlPolicy = { version: 1, observedCostLimit: 5 };
		expect(evaluateRunBudget(policy, budget, { observableRoles: allRoles }).admit).toBe(false);
		budget.unknownWaiver = true;
		const waived = evaluateRunBudget(policy, budget, { observableRoles: allRoles });
		expect(waived).toMatchObject({ admit: true, status: "unknown", waived: true });
		// The caller consumes the waiver after granting the admission.
		budget.unknownWaiver = false;
		expect(evaluateRunBudget(policy, budget, { observableRoles: allRoles }).admit).toBe(false);
	});

	test("a role that cannot be observed on the host never feeds the checks", () => {
		const budget = createRunBudget();
		recordRoleUsage(budget, { role: "executor", usage: usage({ cost: 9 }) });
		// Supervisor usage is unobservable here and stays missing on purpose.
		recordRoleUsage(budget, { role: "supervisor" });
		const decision = evaluateRunBudget({ version: 1, observedCostLimit: 5 }, budget, { observableRoles: workerRoles });
		expect(decision).toMatchObject({ admit: false, status: "exhausted" });
		// With a higher limit the unobservable role's missing reading does not block.
		const open = evaluateRunBudget({ version: 1, observedCostLimit: 50 }, budget, { observableRoles: workerRoles });
		expect(open).toMatchObject({ admit: true, status: "open" });
	});

	test("provider token ceilings check attributed providers; unattributed or incomplete coverage is unknown", () => {
		const budget = createRunBudget();
		recordRoleUsage(budget, { role: "executor", usage: usage(), provider: "zai" });
		const policy: RunControlPolicy = { version: 1, providerTokenCeilings: { zai: 150 } };
		expect(evaluateRunBudget(policy, budget, { observableRoles: workerRoles, attributedProviders: ["zai"] })).toMatchObject({ admit: false, status: "exhausted", limit: "providerTokens" });
		// The run's executor model cannot be attributed at all.
		const unattributed = evaluateRunBudget(policy, createRunBudget(), { observableRoles: workerRoles, attributedProviders: [] });
		expect(unattributed).toMatchObject({ admit: false, status: "unknown", limit: "providerTokens" });
		// A missing reading on the ceiling provider cannot verify the limit.
		const gapped = createRunBudget();
		recordRoleUsage(gapped, { role: "executor", usage: usage(), provider: "zai" });
		recordRoleUsage(gapped, { role: "scout", provider: "zai" });
		expect(evaluateRunBudget(policy, gapped, { observableRoles: workerRoles, attributedProviders: ["zai"] })).toMatchObject({ admit: false, status: "unknown" });
		// Under the ceiling with complete coverage admits.
		const small = createRunBudget();
		recordRoleUsage(small, { role: "executor", usage: usage(), provider: "zai" });
		expect(evaluateRunBudget({ version: 1, providerTokenCeilings: { zai: 1_000_000 } }, small, { observableRoles: workerRoles, attributedProviders: ["zai"] })).toMatchObject({ admit: true, status: "open" });
	});

	test("time limits survive unknown cost coverage only when cost is not limited", () => {
		const budget = createRunBudget();
		recordRoleUsage(budget, { role: "executor" }); // missing cost reading
		const timeOnly: RunControlPolicy = { version: 1, activeTimeLimitMs: 60_000 };
		expect(evaluateRunBudget(timeOnly, budget, { observableRoles: allRoles })).toMatchObject({ admit: true, status: "open" });
	});
});

describe("budget display", () => {
	test("describeRunBudget states policy, consumption, and host observability", () => {
		const budget = createRunBudget();
		addActiveTime(budget, 90_000);
		recordRoleUsage(budget, { role: "executor", usage: usage({ cost: 1.5 }) });
		recordRoleUsage(budget, { role: "scout", usage: usage({ cost: 0.25 }) });
		const lines = describeRunBudget({ version: 1, observedCostLimit: 2, activeTimeLimitMs: 60_000 }, budget, { observableRoles: workerRoles });
		const text = lines.join("\n");
		expect(text).toContain("time 1m 00s");
		expect(text).toContain("spend $2.00 observed");
		expect(text).toContain("status exhausted");
		expect(text).toContain("not observable on this host");
		expect(text).toContain("never a strict ceiling");
		expect(text).toContain("1m 30s of active execution");
	});

	test("an unlimited policy still reports observed consumption", () => {
		const lines = describeRunBudget(undefined, createRunBudget(), { observableRoles: workerRoles });
		expect(lines.join("\n")).toContain("no limits configured (unlimited)");
	});
});

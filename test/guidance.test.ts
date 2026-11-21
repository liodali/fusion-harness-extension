import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	describeRecoveryGuidance,
	deriveRecoveryGuidance,
	isRecoveryOwed,
	posixQuote,
	recoveryCategory,
	resolveCommandEntry,
	resolveScriptPath,
	resolveOperatorCommand,
	type RecoveryFacts,
	type RecoveryGuidance,
	type RecoveryToolNames,
} from "../src/core/guidance.ts";

/** OpenCode-shaped facts: the runtime can record results and await
 * completion notifications, but can never reattach a live turn. */
const OPENCODE_FACTS: RecoveryFacts = {
	ownership: "own",
	terminal: "none",
	capabilities: { activeTurnReattach: false, durableExecution: false },
};

/** Pi-durable-shaped facts: the retained submission is reattachable. */
const PI_DURABLE_FACTS: RecoveryFacts = {
	ownership: "own",
	terminal: "unprovable",
	pending: { action: "execute", requestId: "Fusion execute req-1" },
	capabilities: { activeTurnReattach: true, durableExecution: true },
};

/** Pi-session-shaped facts: no reattachment, no proof. */
const PI_SESSION_FACTS: RecoveryFacts = {
	ownership: "own",
	terminal: "unprovable",
	pending: { action: "execute", requestId: "Fusion execute req-1" },
	capabilities: { activeTurnReattach: false, durableExecution: false },
};

const OPENCODE_TOOLS: RecoveryToolNames = {
	resume: "fusion_resume",
	reconcile: "fusion_reconcile",
	delegate: "fusion_delegate",
	reset: "fusion_reset",
	startRun: "/fusion-run",
	resolveCommand: "bun '/opt/fusion/src/workspace/resolve.ts' '/workspace' 'opencode:one' 'Fusion execute req-1' --confirm-stopped",
};

const PI_TOOLS: RecoveryToolNames = {
	resume: "/fusion-resume",
	delegate: "fusion_delegate",
	reset: "/fusion-clean",
	startRun: "/fusion <task>",
	resolveCommand: "bun '/opt/fusion/src/workspace/resolve.ts' '/workspace' 'pi:one' 'Fusion execute req-1' --confirm-stopped",
};

describe("recovery categories and owed actions", () => {
	test("the three recovery kinds stay distinguishable", () => {
		expect(recoveryCategory("wait")).toBe("wait-existing");
		expect(recoveryCategory("reattach")).toBe("wait-existing");
		expect(recoveryCategory("reconcile")).toBe("adopt-result");
		expect(recoveryCategory("resolve")).toBe("operator-resolution");
		expect(recoveryCategory("take-over")).toBe("operator-resolution");
		expect(recoveryCategory("start-new")).toBe("another-run");
		expect(recoveryCategory("continue")).toBe("none");
		expect(recoveryCategory("elsewhere")).toBe("elsewhere");
		// The kinds render differently for the same tool names.
		const reattach = describeRecoveryGuidance({ ...deriveRecoveryGuidance(PI_DURABLE_FACTS), reason: "x" } as RecoveryGuidance, PI_TOOLS);
		const reconcile = describeRecoveryGuidance({ action: "reconcile", category: "adopt-result", reason: "the executor's recorded result can be settled into the run", confirmationRequired: true, pending: { action: "execute", requestId: "req" } }, { ...OPENCODE_TOOLS, resume: "/fusion-resume" });
		const resolve = describeRecoveryGuidance({ action: "resolve", category: "operator-resolution", reason: "unknown", confirmationRequired: true }, PI_TOOLS);
		const startNew = describeRecoveryGuidance({ action: "start-new", category: "another-run", reason: "no Fusion run owns this workspace or session", confirmationRequired: false }, PI_TOOLS);
		expect(new Set([reattach, reconcile, resolve, startNew]).size).toBe(4);
		expect(reattach).toContain("wait for the existing submission");
		expect(reconcile).toContain("adopt the completed result");
		expect(resolve).toContain("no exact completion proof can be adopted");
		expect(startNew).toContain("start another run");
	});

	test("owed actions are exactly the ones a surface must show", () => {
		for (const action of ["reattach", "reconcile", "resolve", "take-over", "elsewhere"] as const) expect(isRecoveryOwed(action)).toBe(true);
		for (const action of ["wait", "start-new", "continue"] as const) expect(isRecoveryOwed(action)).toBe(false);
	});
});

describe("deriveRecoveryGuidance dispositions", () => {
	test("ownership decides first: foreign coordinator recovers in its own session", () => {
		const guidance = deriveRecoveryGuidance({ ...OPENCODE_FACTS, ownership: "foreign", owner: { harness: "opencode", supervisorId: "ses_other" }, pending: { action: "execute", requestId: "req" }, terminal: "awaitable" });
		expect(guidance.action).toBe("elsewhere");
		expect(guidance.category).toBe("elsewhere");
		expect(guidance.owner).toEqual({ harness: "opencode", supervisorId: "ses_other" });
		expect(guidance.reason).toContain("opencode:ses_other");
		expect(guidance.confirmationRequired).toBe(true);
	});

	test("an unowned workspace owes nothing but a new run", () => {
		expect(deriveRecoveryGuidance({ ...OPENCODE_FACTS, ownership: "none" }).action).toBe("start-new");
	});

	test("a live transition waits, whatever else is pending", () => {
		const delegating = deriveRecoveryGuidance({ ...OPENCODE_FACTS, pending: { action: "execute", requestId: "req" }, inFlight: true, terminal: "unprovable" });
		expect(delegating.action).toBe("wait");
		const reconciling = deriveRecoveryGuidance({ ...OPENCODE_FACTS, pending: { action: "execute", requestId: "req" }, inFlight: true, terminal: "recorded" });
		expect(reconciling.action).toBe("wait");
	});

	test("an uncertain outcome reattaches when the runtime can reattach (Pi durable, restart included)", () => {
		const guidance = deriveRecoveryGuidance(PI_DURABLE_FACTS);
		expect(guidance.action).toBe("reattach");
		expect(guidance.category).toBe("wait-existing");
		expect(guidance.pending).toEqual({ action: "execute", requestId: "Fusion execute req-1" });
		expect(guidance.confirmationRequired).toBe(true);
		// A restored record derives the same route from persisted capabilities.
		const restored = deriveRecoveryGuidance({ ...PI_DURABLE_FACTS, terminal: "unprovable" });
		expect(restored.action).toBe("reattach");
	});

	test("an uncertain outcome adopts exact proof without reattachment (OpenCode)", () => {
		const recorded = deriveRecoveryGuidance({ ...OPENCODE_FACTS, pending: { action: "execute", requestId: "req" }, terminal: "recorded" });
		expect(recorded.action).toBe("reconcile");
		expect(recorded.reason).toContain("recorded result");
		const awaitable = deriveRecoveryGuidance({ ...OPENCODE_FACTS, pending: { action: "execute", requestId: "req" }, terminal: "awaitable" });
		expect(awaitable.action).toBe("reconcile");
		expect(awaitable.reason).toContain("completion notification");
		expect(awaitable.confirmationRequired).toBe(true);
	});

	test("an uncertain outcome with no adoptable proof routes to explicit resolution", () => {
		// OpenCode: retained request, no live turn, no recorded result.
		const withRequest = deriveRecoveryGuidance({ ...OPENCODE_FACTS, pending: { action: "execute", requestId: "req" }, terminal: "unprovable" });
		expect(withRequest.action).toBe("resolve");
		expect(withRequest.reason).toContain("no live turn and no recorded result");
		// Pi session backend: the same route via missing reattachment capability.
		expect(deriveRecoveryGuidance(PI_SESSION_FACTS).action).toBe("resolve");
		// Unknown outcome with no retained request at all.
		const withoutRequest = deriveRecoveryGuidance({ ...OPENCODE_FACTS, terminal: "unprovable" });
		expect(withoutRequest.action).toBe("resolve");
		expect(withoutRequest.reason).toContain("no retained request");
		expect(withoutRequest.confirmationRequired).toBe(true);
	});

	test("an incomplete protocol routes to the operator decision", () => {
		const guidance = deriveRecoveryGuidance({ ...OPENCODE_FACTS, incomplete: true, executed: true });
		expect(guidance.action).toBe("take-over");
		expect(guidance.category).toBe("operator-resolution");
		expect(guidance.reason).toContain("stopped before finishing");
	});

	test("a stopped run that owes no recovery releases before another run", () => {
		const operator = deriveRecoveryGuidance({ ...OPENCODE_FACTS, stop: { kind: "operator" }, executed: true });
		expect(operator.action).toBe("start-new");
		expect(operator.reason).toContain("was stopped");
		const policy = deriveRecoveryGuidance({ ...OPENCODE_FACTS, stop: { kind: "policy" } });
		expect(policy.reason).toContain("time or cost policy");
		// The stop never overrides an owed recovery: an uncertain retained
		// request after a stop still routes by capability.
		const stoppedUncertain = deriveRecoveryGuidance({ ...OPENCODE_FACTS, stop: { kind: "operator", confirmed: false }, pending: { action: "execute", requestId: "req" }, terminal: "awaitable" });
		expect(stoppedUncertain.action).toBe("reconcile");
		const stoppedDurable = deriveRecoveryGuidance({ ...PI_DURABLE_FACTS, stop: { kind: "operator" } });
		expect(stoppedDurable.action).toBe("reattach");
	});

	test("an incomplete protocol outranks the stop state (both are operator decisions)", () => {
		const guidance = deriveRecoveryGuidance({ ...OPENCODE_FACTS, incomplete: true, stop: { kind: "operator" }, executed: true });
		expect(guidance.action).toBe("take-over");
	});

	test("host-side retries stay visible without becoming recovery work", () => {
		const settlement = deriveRecoveryGuidance({ ...OPENCODE_FACTS, settlementWritePending: true, executed: true });
		expect(settlement.action).toBe("continue");
		expect(settlement.reason).toContain("settlement could not be written");
		expect(settlement.reason).toContain("retries when this session next settles");
		const prompt = deriveRecoveryGuidance({ ...OPENCODE_FACTS, promptDeliveryPending: true });
		expect(prompt.action).toBe("continue");
		expect(prompt.reason).toContain("Prompt delivery is unconfirmed".toLowerCase());
		const nudge = deriveRecoveryGuidance({ ...OPENCODE_FACTS, nudgeDeliveryPending: true });
		expect(nudge.action).toBe("continue");
		expect(nudge.reason).toContain("continuation nudge");
		// Recovery owed outranks a retry note: an uncertain run with a failed
		// settlement write routes to the recovery, not the retry.
		const uncertainFirst = deriveRecoveryGuidance({ ...OPENCODE_FACTS, settlementWritePending: true, pending: { action: "execute", requestId: "req" }, terminal: "recorded" });
		expect(uncertainFirst.action).toBe("reconcile");
	});

	test("a settled run owes no recovery and continues the protocol", () => {
		const delegated = deriveRecoveryGuidance({ ...OPENCODE_FACTS, executed: true });
		expect(delegated.action).toBe("continue");
		expect(delegated.reason).toContain("nothing is unsettled");
		const fresh = deriveRecoveryGuidance({ ...OPENCODE_FACTS, executed: false });
		expect(fresh.action).toBe("continue");
		expect(fresh.reason).toContain("has not delegated");
	});

	test("a retained settled record releases without recovery", () => {
		const guidance = deriveRecoveryGuidance({ ...OPENCODE_FACTS, retainedSettled: true });
		expect(guidance.action).toBe("start-new");
		expect(guidance.reason).toContain("retained run is settled");
	});

	test("deriving is idempotent: the same facts derive the same action twice", () => {
		const facts: RecoveryFacts = { ...OPENCODE_FACTS, pending: { action: "execute", requestId: "req" }, terminal: "recorded", incomplete: false, stop: { kind: "operator" } };
		const first = deriveRecoveryGuidance(facts);
		const second = deriveRecoveryGuidance(facts);
		expect(second).toEqual(first);
		// And repeating the derived action changes nothing: no fact source was
		// mutated (the facts object compares equal afterwards).
		expect(facts).toEqual({ ...OPENCODE_FACTS, pending: { action: "execute", requestId: "req" }, terminal: "recorded", incomplete: false, stop: { kind: "operator" } });
	});

	test("missing facts never invent a route", () => {
		// No pending identity at all: uncertain routes to resolution, settled routes on.
		const bare = deriveRecoveryGuidance({ ownership: "own", terminal: "unprovable" });
		expect(bare.action).toBe("resolve");
		expect(bare.pending).toBeUndefined();
		// An empty request id is not an identity.
		const blank = deriveRecoveryGuidance({ ownership: "own", terminal: "awaitable", pending: { action: "execute", requestId: "  " } });
		expect(blank.action).toBe("resolve");
	});
});

describe("describeRecoveryGuidance wording", () => {
	test("the reconcile line keeps the exact adopt-then-fallback phrasing", () => {
		const guidance = deriveRecoveryGuidance({ ...OPENCODE_FACTS, pending: { action: "execute", requestId: "Fusion execute req 1" }, terminal: "awaitable" });
		const line = describeRecoveryGuidance(guidance, { ...OPENCODE_TOOLS, resolveCommand: resolveOperatorCommand({ entry: "bun src/workspace/resolve.ts", workspace: "/workspace", runId: "opencode:one", requestId: "Fusion execute req 1" }) });
		expect(line).toContain("Call fusion_reconcile to adopt the executor's exact completion");
		expect(line).toContain("If it reports no matching notification");
		expect(line).toContain("--confirm-stopped");
		// The displayed fallback keeps exact argument quoting.
		expect(line).toContain(`'Fusion execute req 1'`);
	});

	test("the resolve line names the exact command with quoted arguments", () => {
		const guidance = deriveRecoveryGuidance(PI_SESSION_FACTS);
		const line = describeRecoveryGuidance(guidance, PI_TOOLS);
		expect(line).toContain("bun '/opt/fusion/src/workspace/resolve.ts'");
		expect(line).toContain(`'Fusion execute req-1'`);
		expect(line).toContain("--confirm-stopped");
		expect(line).toContain("after confirming the worker stopped");
	});

	test("the reattach line waits for the existing submission without new work", () => {
		const line = describeRecoveryGuidance(deriveRecoveryGuidance(PI_DURABLE_FACTS), PI_TOOLS);
		expect(line).toContain("wait for the existing submission");
		expect(line).toContain("Call /fusion-resume");
		expect(line).toContain("(retained request Fusion execute req-1)");
		expect(line).toContain("without starting new work");
		expect(line).not.toContain("--confirm-stopped");
	});

	test("the wait line never names a command", () => {
		const line = describeRecoveryGuidance(deriveRecoveryGuidance({ ...OPENCODE_FACTS, inFlight: true }), OPENCODE_TOOLS);
		expect(line).toContain("wait");
		expect(line).toContain("executor transition is in progress");
		expect(line).not.toContain("fusion_reset");
		expect(line).not.toContain("resolve.ts");
	});

	test("the incomplete line keeps the take-over phrasing", () => {
		const line = describeRecoveryGuidance(deriveRecoveryGuidance({ ...OPENCODE_FACTS, incomplete: true }), OPENCODE_TOOLS);
		expect(line).toContain("the run is incomplete");
		expect(line).toContain("take over the task yourself, or call fusion_reset to finish the run");
	});

	test("the stop-release line finishes before another run", () => {
		const line = describeRecoveryGuidance(deriveRecoveryGuidance({ ...OPENCODE_FACTS, stop: { kind: "operator" } }), OPENCODE_TOOLS);
		expect(line).toContain("finish it with fusion_reset, then run /fusion-run");
	});

	test("the no-recovery lines keep the protocol steps", () => {
		const delegated = describeRecoveryGuidance(deriveRecoveryGuidance({ ...OPENCODE_FACTS, executed: true }), OPENCODE_TOOLS);
		expect(delegated).toContain("No recovery is owed");
		expect(delegated).toContain("review the working tree and audit the original task");
		expect(delegated).toContain("call fusion_reset when it finishes");
		const fresh = describeRecoveryGuidance(deriveRecoveryGuidance({ ...OPENCODE_FACTS, executed: false }), OPENCODE_TOOLS);
		expect(fresh).toContain("No recovery is owed");
		expect(fresh).toContain("call fusion_delegate with action execute");
	});

	test("retry lines keep their self-retrying wording", () => {
		const settlement = describeRecoveryGuidance(deriveRecoveryGuidance({ ...OPENCODE_FACTS, settlementWritePending: true }), OPENCODE_TOOLS);
		expect(settlement).toContain("The last Fusion settlement could not be written; it retries when this session next settles");
		const prompt = describeRecoveryGuidance(deriveRecoveryGuidance({ ...OPENCODE_FACTS, promptDeliveryPending: true }), OPENCODE_TOOLS);
		expect(prompt).toContain("retry /fusion-run with the same task and message ID");
	});

	test("the elsewhere line names the owning session and the fallback command", () => {
		const guidance = deriveRecoveryGuidance({ ...OPENCODE_FACTS, ownership: "foreign", owner: { harness: "opencode", supervisorId: "ses_other" } });
		const line = describeRecoveryGuidance(guidance, OPENCODE_TOOLS);
		expect(line).toContain("Call fusion_resume in the owning session (opencode:ses_other)");
		expect(line).toContain("--confirm-stopped");
	});
});

describe("operator resolution command", () => {
	test("arguments are POSIX-quoted exactly as they should be typed", () => {
		const command = resolveOperatorCommand({ entry: "bun src/workspace/resolve.ts", workspace: "/work space", runId: "run id", requestId: "Fusion execute req'1" });
		expect(command).toBe(`bun src/workspace/resolve.ts '/work space' 'run id' 'Fusion execute req'\\''1' --confirm-stopped`);
	});

	test("a missing request identity passes --no-request-id", () => {
		const command = resolveOperatorCommand({ entry: "e", workspace: "/w", runId: "r" });
		expect(command).toBe("e '/w' 'r' '--no-request-id' --confirm-stopped");
		// A blank request id is not an identity either.
		expect(resolveOperatorCommand({ entry: "e", workspace: "/w", runId: "r", requestId: "  " })).toBe("e '/w' 'r' '--no-request-id' --confirm-stopped");
	});

	test("the entry is the executable's actual installed path", () => {
		// The checkout's own sources derive the absolute script path by walking
		// up from the module file to the ancestor that carries the script.
		const moduleUrl = pathToFileURL(join(import.meta.dir, "..", "src", "opencode", "index.ts")).href;
		const script = resolveScriptPath(moduleUrl);
		expect(script).toBe(join(import.meta.dir, "..", "src", "workspace", "resolve.ts"));
		expect(resolveCommandEntry(moduleUrl)).toBe(`bun ${posixQuote(script!)}`);
		// A package install under node_modules: the walk stops at the
		// package's own src, whose workspace script ships in the package.
		expect(resolveCommandEntry("file:///project/node_modules/fusion-opencode/src/opencode/index.ts")).toBe("bun '/project/node_modules/fusion-opencode/src/workspace/resolve.ts'");
		// Pi's entry file sits directly in src.
		expect(resolveCommandEntry("file:///repo/src/index.ts")).toBe("bun '/repo/src/workspace/resolve.ts'");
		// Percent-encoded file URLs decode before the walk.
		expect(resolveCommandEntry("file:///pro%20ject/node_modules/fusion-opencode/src/index.ts")).toBe("bun '/pro ject/node_modules/fusion-opencode/src/workspace/resolve.ts'");
		// No layout at all: the documented checkout-relative form is the last resort.
		expect(resolveCommandEntry(undefined)).toBe("bun src/workspace/resolve.ts");
		expect(resolveScriptPath("file:///elsewhere/tools.ts")).toBeUndefined();
	});

	test("posixQuote survives embedded quotes", () => {
		expect(posixQuote("it's")).toBe(`'it'\\''s'`);
	});
});

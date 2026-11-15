import { fileURLToPath } from "node:url";
import type { DelegationAction } from "./workflow.ts";

/**
 * R4 guided recovery: one recommended next action for a Fusion run, derived
 * from shared facts instead of per-host ad-hoc strings. The derivation is
 * harness-free: each host reports what it can honestly establish (ownership,
 * the retained request identity, terminal evidence, the stop state, and the
 * runtime capabilities), and every surface — status, resume, and the host
 * UIs — renders the same action through `describeRecoveryGuidance`.
 *
 * The three recovery kinds stay distinguishable: waiting for an existing
 * submission ("wait-existing": the transition in flight, or reattachment to
 * a durable one), adopting a completed result ("adopt-result": reconciliation
 * against exact completion proof), and starting another run after cleanup
 * ("another-run"). Explicit operator resolution is its own kind and never
 * runs automatically: when worker termination cannot be proven, releasing
 * the run requires the operator's explicit confirmation, and the displayed
 * command is presented for the operator to run — never executed here.
 */

/** The one recommended next action. */
export type RecoveryAction =
	/** An executor transition is in flight; wait for it to settle. */
	| "wait"
	/** Wait for the existing submission: reattach to the retained durable
	 * request instead of starting new work (the sanctioned recovery path for
	 * an interrupted durable turn, including a stopped run's). */
	| "reattach"
	/** Adopt an exact completed result (a recorded result, or the completion
	 * notification the coordinator still awaits). */
	| "reconcile"
	/** No exact completion proof can be adopted: inspect the worker and
	 * workspace, confirm the worker stopped, then resolve ownership
	 * explicitly with the operator command. */
	| "resolve"
	/** The supervisor stopped before finishing the run: take over the task
	 * yourself, or finish the run. */
	| "take-over"
	/** No recovery is owed here: start another run (releasing any retained
	 * record first). */
	| "start-new"
	/** The run owes no recovery; the protocol continues. */
	| "continue"
	/** Another coordinator owns this run; recover in its session. */
	| "elsewhere";

/** The recovery kind an action belongs to. R4 keeps the three recovery
 * kinds distinct in every presentation. */
export type RecoveryCategory =
	| "wait-existing"
	| "adopt-result"
	| "operator-resolution"
	| "another-run"
	| "elsewhere"
	| "none";

/** Terminal evidence for the run's outstanding worker request, as the host
 * can honestly establish it:
 * - "none": nothing is unsettled (no outstanding request, or the run settled).
 * - "recorded": an exact recorded result exists in this session.
 * - "awaitable": exact proof can still arrive (the completion notification
 *   is awaited, or a reattachable backend can surface it).
 * - "unprovable": the outcome is unknown and no exact proof can exist. */
export type TerminalProof = "none" | "recorded" | "awaitable" | "unprovable";

export type PendingAction = Exclude<DelegationAction, "resume">;

/** The facts one host observed for one run. Absent fields mean the host
 * cannot establish them; the derivation never invents them. */
export interface RecoveryFacts {
	/** Who owns the workspace record relative to this session. */
	ownership: "own" | "foreign" | "none";
	owner?: { harness: string; supervisorId: string };
	/** The retained request identity awaiting settlement. The action word is
	 * display-only; hosts retain execute/revise/final_fix requests. */
	pending?: { action: DelegationAction; requestId: string };
	/** A stop landed on the run. "confirmed" means the stop record carries a
	 * proven terminal outcome for the worker; delivery alone never confirms. */
	stop?: { kind?: "operator" | "policy"; confirmed?: boolean; terminal?: "completed" | "error" | "cancelled" };
	/** Terminal evidence for the outstanding request. */
	terminal: TerminalProof;
	/** Runtime capabilities the host can honestly report. Reattachment needs
	 * both a reattachable turn and a durable backend. */
	capabilities?: { activeTurnReattach?: boolean; durableExecution?: boolean };
	/** An executor transition (delegation or reconciliation) is in progress. */
	inFlight?: boolean;
	/** The supervisor stopped before finishing the run (protocol incomplete). */
	incomplete?: boolean;
	/** The protocol has delegated at least once. */
	executed?: boolean;
	/** A retained settled record with no live session state (adopted from a
	 * previous process): releasable, nothing to recover. */
	retainedSettled?: boolean;
	/** Host-side retries that run on their own (R4 keeps them visible without
	 * mistaking them for recovery work). */
	settlementWritePending?: boolean;
	promptDeliveryPending?: boolean;
	nudgeDeliveryPending?: boolean;
}

export interface RecoveryGuidance {
	action: RecoveryAction;
	category: RecoveryCategory;
	/** Why this action: the deciding facts, in shared wording. */
	reason: string;
	/** Resolving ownership of this run requires the operator to confirm the
	 * worker stopped first. Presentation only — nothing here automates it. */
	confirmationRequired: boolean;
	/** The retained request the recovery addresses, when any. */
	pending?: { action: DelegationAction; requestId: string };
	/** The owning coordinator, for the "elsewhere" action. */
	owner?: { harness: string; supervisorId: string };
}

export function recoveryCategory(action: RecoveryAction): RecoveryCategory {
	switch (action) {
		case "wait":
		case "reattach":
			return "wait-existing";
		case "reconcile":
			return "adopt-result";
		case "resolve":
		case "take-over":
			return "operator-resolution";
		case "start-new":
			return "another-run";
		case "elsewhere":
			return "elsewhere";
		case "continue":
			return "none";
	}
}

/** True when recovery work is owed and a surface should surface the action
 * (widget and monitor-card surfaces skip in-flight and protocol steps). */
export function isRecoveryOwed(action: RecoveryAction): boolean {
	return action === "reattach" || action === "reconcile" || action === "resolve" || action === "take-over" || action === "elsewhere";
}

const guidance = (
	action: RecoveryAction,
	reason: string,
	extra: { pending?: RecoveryGuidance["pending"]; owner?: RecoveryGuidance["owner"] } = {},
): RecoveryGuidance => ({
	action,
	category: recoveryCategory(action),
	reason,
	// Every route whose fallback is an explicit ownership resolution keeps
	// the operator's termination confirmation in front of it.
	confirmationRequired: action === "resolve" || action === "reconcile" || action === "reattach" || action === "elsewhere",
	...(extra.pending ? { pending: extra.pending } : {}),
	...(extra.owner ? { owner: extra.owner } : {}),
});

const UNCERTAIN_REASON_WITH_REQUEST = "the retained executor request has no live turn and no recorded result; automatic retry stays disabled while the outcome is unknown";
const UNCERTAIN_REASON_WITHOUT_REQUEST = "the outcome is unknown with no retained request";

/** Derive the one recommended next action. The order is deliberate:
 * ownership first (another coordinator's run is recovered there), then any
 * live transition (never act on a moving target), then the uncertain-outcome
 * routes by runtime capability — waiting for the existing submission when
 * the runtime can reattach, adopting exact proof when it can exist, and only
 * then explicit operator resolution — followed by protocol incompleteness,
 * a stopped run that owes no recovery, self-retrying host writes, and
 * finally the no-recovery protocol steps. Deriving twice from the same facts
 * yields the same action: nothing here mutates state or submits work. */
export function deriveRecoveryGuidance(facts: RecoveryFacts): RecoveryGuidance {
	const pending = facts.pending && typeof facts.pending.requestId === "string" && !!facts.pending.requestId.trim()
		? { action: facts.pending.action, requestId: facts.pending.requestId }
		: undefined;
	const uncertain = facts.terminal !== "none";
	// 1. Ownership decides first: this session may not be the coordinator.
	if (facts.ownership === "foreign") {
		return guidance("elsewhere", `the workspace record is owned by ${facts.owner ? `${facts.owner.harness}:${facts.owner.supervisorId}` : "another Fusion coordinator"}`, { pending, owner: facts.owner });
	}
	if (facts.ownership === "none") {
		return guidance("start-new", "no Fusion run owns this workspace or session");
	}
	if (facts.retainedSettled) {
		return guidance("start-new", "the retained run is settled and owes no recovery");
	}
	// 2. A live executor transition: wait, then check recovery again.
	if (facts.inFlight) {
		return guidance("wait", "an executor transition is in progress (delegation or reconciliation)");
	}
	// 3. An uncertain outcome routes by runtime capability first: waiting for
	// the existing submission never starts new work; adopting exact proof
	// comes next; without either, only explicit operator resolution remains.
	if (uncertain) {
		if (pending && facts.capabilities?.activeTurnReattach && facts.capabilities?.durableExecution) {
			return guidance("reattach", `the run retained its ${pending.action} request and the executor transcript can be reopened`, { pending });
		}
		if (pending && (facts.terminal === "recorded" || facts.terminal === "awaitable")) {
			return guidance("reconcile", facts.terminal === "recorded" ? "the executor's recorded result can be settled into the run" : "the executor's completion notification is awaited, or may already be recorded in this session", { pending });
		}
		return guidance("resolve", pending ? UNCERTAIN_REASON_WITH_REQUEST : UNCERTAIN_REASON_WITHOUT_REQUEST, { pending });
	}
	// 4. The protocol ended without finishing: the operator takes over or
	// finishes the run.
	if (facts.incomplete) {
		return guidance("take-over", "the supervisor stopped before finishing the run");
	}
	// 5. A stopped run that owes no recovery: release it, then start another.
	if (facts.stop) {
		return guidance("start-new", `the run was stopped${facts.stop.kind === "policy" ? " by its time or cost policy" : ""} and owes no recovery`);
	}
	// 6. Host-side writes that retry on their own: visible, never recovery.
	if (facts.settlementWritePending) {
		return guidance("continue", "the last Fusion settlement could not be written; it retries when this session next settles");
	}
	if (facts.promptDeliveryPending) {
		return guidance("continue", "prompt delivery is unconfirmed; retry the run command with the same task and message ID, or inspect the session before cleaning");
	}
	if (facts.nudgeDeliveryPending) {
		return guidance("continue", "the last continuation nudge could not be delivered; it retries when this session next settles, or deliver the instruction to the fusion agent directly");
	}
	// 7. Nothing is unsettled; the protocol continues.
	return guidance("continue", facts.executed ? "nothing is unsettled; the run owes no recovery" : "the protocol has not delegated yet");
}

/** Host-specific names for the surfaces an action names. `resolveCommand` is
 * the full operator resolution command, pre-quoted by the host for its
 * install form; the derivation never builds or runs it. */
export interface RecoveryToolNames {
	/** How this surface waits for the existing submission. */
	resume: string;
	/** The reconciliation tool, when the host has one. */
	reconcile?: string;
	/** The protocol delegation tool (the not-yet-executed step). */
	delegate?: string;
	/** How a run is finished and its workspace released. */
	reset: string;
	/** How another run starts. */
	startRun: string;
	/** The full operator resolution command with exact argument quoting. */
	resolveCommand: string;
	/** Optional hint appended to the wait action (the resume surface). */
	afterWait?: string;
}

/** Render the one action and its reason. The wording is shared: the same
 * run state renders the same line on both hosts, with host tool names. */
export function describeRecoveryGuidance(recovery: RecoveryGuidance, tools: RecoveryToolNames): string {
	const requestId = recovery.pending?.requestId;
	switch (recovery.action) {
		case "wait":
			return `Recovery: wait — ${recovery.reason}; check again once it settles${tools.afterWait ? `, then ${tools.afterWait}` : ""}.`;
		case "reattach":
			return `Recovery: wait for the existing submission — ${recovery.reason}. Call ${tools.resume} to look up and wait for the original durable submission${requestId ? ` (retained request ${requestId})` : ""} without starting new work; if matching evidence is unavailable, the run remains locked until you resolve it explicitly.`;
		case "reconcile":
			if (tools.reconcile) {
				return `Recovery: adopt the completed result — ${recovery.reason}. Call ${tools.reconcile} to adopt the executor's exact completion. If it reports no matching notification, inspect the worker and workspace, and after confirming the worker stopped run: ${tools.resolveCommand}.`;
			}
			break;
		case "resolve":
			return `Recovery: no exact completion proof can be adopted — ${recovery.reason}. Inspect the worker session and the working tree, and after confirming the worker stopped run: ${tools.resolveCommand}.`;
		case "take-over":
			return `Recovery: the run is incomplete (${recovery.reason}) — take over the task yourself, or call ${tools.reset} to finish the run.`;
		case "start-new":
			if (recovery.reason.startsWith("the retained run is settled")) {
				return `Recovery: nothing is owed — ${recovery.reason}; release it with ${tools.reset} or start another run with ${tools.startRun}.`;
			}
			if (recovery.reason.startsWith("the run was stopped")) {
				return `Recovery: start another run — ${recovery.reason}; finish it with ${tools.reset}, then run ${tools.startRun}.`;
			}
			return `Recovery: start another run — ${recovery.reason}; run ${tools.startRun}.`;
		case "continue":
			if (recovery.reason.startsWith("nothing is unsettled")) {
				return `No recovery is owed; the run is active — review the working tree and audit the original task, and call ${tools.reset} when it finishes.`;
			}
			if (recovery.reason.startsWith("the protocol has not delegated")) {
				return `No recovery is owed; the run is active — investigate the original task, then call ${tools.delegate ?? "the delegation tool"} with action execute.`;
			}
			if (recovery.reason.startsWith("prompt delivery")) {
				return `No recovery is owed; the run is active — prompt delivery is unconfirmed; retry ${tools.startRun} with the same task and message ID, or inspect the session before cleaning.`;
			}
			// Self-retrying host writes: the reason is already the display clause.
			return `No recovery is owed; the run is active — ${recovery.reason.charAt(0).toUpperCase()}${recovery.reason.slice(1)}.`;
		case "elsewhere":
			return `Recovery: recover in the owning session — Call ${tools.resume} in the owning session (${recovery.owner ? `${recovery.owner.harness}:${recovery.owner.supervisorId}` : "its coordinator"}), or after inspecting the worker and workspace run: ${tools.resolveCommand}.`;
	}
	// A host without a reconcile tool never derives "reconcile"; this is the
	// defensive fallback if a future fact source routes around that.
	return `Recovery: no exact completion proof can be adopted — ${recovery.reason}. Inspect the worker session and the working tree, and after confirming the worker stopped run: ${tools.resolveCommand}.`;
}

/** POSIX single-quote a shell argument so paths and request ids with spaces
 * or metacharacters stay single arguments exactly as typed. */
export function posixQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The operator resolution command with exact argument quoting. `entry` is
 * the invocation path for the current install form; the arguments are
 * identical in every form, and the command is only ever displayed — running
 * it, including its explicit `--confirm-stopped` confirmation, is the
 * operator's action. */
export function resolveOperatorCommand(input: { entry: string; workspace: string; runId?: string; requestId?: string }): string {
	return [
		input.entry,
		posixQuote(input.workspace),
		...(input.runId ? [posixQuote(input.runId)] : []),
		posixQuote(input.requestId && input.requestId.trim() ? input.requestId : "--no-request-id"),
		"--confirm-stopped",
	].join(" ");
}

/** The resolution entry for the module's own install form: the checkout
 * script in a repository/checkout install, the package `fusion-resolve` bin
 * when the module loads from node_modules. Both run the same script and
 * take the same arguments. */
export function resolveCommandEntry(moduleUrl: string | undefined): string {
	let path: string | undefined;
	if (moduleUrl && moduleUrl.startsWith("file:")) {
		try {
			path = fileURLToPath(moduleUrl);
		} catch {
			path = decodeURIComponent(moduleUrl.slice("file://".length));
		}
	} else path = moduleUrl;
	return path && path.includes("node_modules") ? "./node_modules/.bin/fusion-resolve" : "bun src/workspace/resolve.ts";
}

import { formatDuration } from "./duration.ts";
import type { RunControlPolicy } from "./run-control.ts";
import type { WorkerUsage } from "./worker.ts";

/**
 * Shared run-budget accounting (R2). The contract stays host-free:
 *
 * - Observed accounting only. A limit on spend is a limit on what this
 *   extension observed, never a strict dollar ceiling: in-flight spend can
 *   exceed a threshold because readings are delayed, and wording must say so.
 * - Missing readings stay unknown, never zero. A spend-limited run whose
 *   cost coverage is incomplete blocks submissions until the user explicitly
 *   continues or changes the policy.
 * - Clock semantics: active execution excludes permission/user waits. Wall
 *   time is tracked alongside so waits are accounted separately (R3 display)
 *   without consuming active time. Accumulated durations persist; process
 *   downtime never implies worker termination and never counts as active.
 * - Event accounting and bounded timers only — no model polling.
 */

/** Budget role keys. Which roles a harness can actually observe is declared
 * by that harness (Pi: supervisor, executor, scout; OpenCode: executor,
 * scout) and stated in its status/stats output. */
export type BudgetRole = "supervisor" | "executor" | "scout";

export const BUDGET_ROLES: readonly BudgetRole[] = ["supervisor", "executor", "scout"];

/** Observed usage for one role with honest coverage. Absent totals stay
 * absent (unknown); `turnsReported`/`turnsMissing` and `fieldTurns` say how
 * complete each total is, so a partial reading can never look whole. */
export interface RoleBudgetUsage {
	turnsReported: number;
	turnsMissing: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	reasoningTokens?: number;
	cost?: number;
	/** How many reported turns carried each field. */
	fieldTurns?: Record<string, number>;
}

/** Observed token totals for one provider, with the same coverage fields.
 * Only turns whose provider the harness could attribute land here. */
export interface ProviderBudgetUsage {
	turnsReported: number;
	turnsMissing: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	/** How many reported turns carried each token field. */
	fieldTurns: Record<string, number>;
}

/** Persisted consumed budgets. Additive unknown fields survive; a malformed
 * record throws instead of silently resetting consumption (restart cannot
 * reset spent budgets). */
export interface RunBudget {
	version: 1;
	/** Accumulated active execution time across all observed worker turns,
	 * excluding paused (permission/user wait) spans. */
	activeMs: number;
	roles: Partial<Record<BudgetRole, RoleBudgetUsage>>;
	providers?: Record<string, ProviderBudgetUsage>;
	/** Set when the user explicitly continued past an unknown budget for one
	 * admission; consumed by the next admission gate that grants it. */
	unknownWaiver?: boolean;
	/** Dedupe keys of turns already recorded (bounded ring; settlement
	 * retries and late re-reads must not double-count). */
	counted?: string[];
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

const finite = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);
const nonnegative = (value: unknown): boolean => finite(value) && (value as number) >= 0;
const nonempty = (value: unknown): value is string => typeof value === "string" && !!value.trim();

function roleUsageIs(value: unknown): value is RoleBudgetUsage {
	if (!object(value)) return false;
	if (!Number.isSafeInteger(value.turnsReported) || (value.turnsReported as number) < 0) return false;
	if (!Number.isSafeInteger(value.turnsMissing) || (value.turnsMissing as number) < 0) return false;
	for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "cost"] as const) {
		if (value[field] !== undefined && !nonnegative(value[field])) return false;
	}
	if (value.fieldTurns !== undefined) {
		if (!object(value.fieldTurns)) return false;
		if (!Object.values(value.fieldTurns).every((count) => Number.isSafeInteger(count) && (count as number) >= 0)) return false;
	}
	return true;
}

function providerUsageIs(value: unknown): value is ProviderBudgetUsage {
	if (!object(value)) return false;
	if (!Number.isSafeInteger(value.turnsReported) || (value.turnsReported as number) < 0) return false;
	if (!Number.isSafeInteger(value.turnsMissing) || (value.turnsMissing as number) < 0) return false;
	if (!nonnegative(value.inputTokens) || !nonnegative(value.outputTokens) || !nonnegative(value.totalTokens)) return false;
	if (!object(value.fieldTurns) || !Object.values(value.fieldTurns).every((count) => Number.isSafeInteger(count) && (count as number) >= 0)) return false;
	return true;
}

/** Absent input reads as no persisted budget (a fresh run). A present but
 * malformed, corrupt, or future-version record throws: consumed budgets are
 * never silently reset to zero by an unreadable file. */
export function readRunBudget(value: unknown): RunBudget | undefined {
	if (value === undefined || value === null) return undefined;
	if (!object(value) || value.version !== 1) throw new Error("Unsupported Fusion run budget record.");
	if (!nonnegative(value.activeMs) || !object(value.roles)) throw new Error("Invalid Fusion run budget record; consumed budgets stay engaged.");
	for (const [role, usage] of Object.entries(value.roles)) {
		if (!BUDGET_ROLES.includes(role as BudgetRole) || !roleUsageIs(usage)) throw new Error("Invalid Fusion run budget record; consumed budgets stay engaged.");
	}
	if (value.providers !== undefined) {
		if (!object(value.providers) || !Object.entries(value.providers).every(([provider, usage]) => nonempty(provider) && providerUsageIs(usage))) {
			throw new Error("Invalid Fusion run budget record; consumed budgets stay engaged.");
		}
	}
	if (value.unknownWaiver !== undefined && typeof value.unknownWaiver !== "boolean") throw new Error("Invalid Fusion run budget record; consumed budgets stay engaged.");
	if (value.counted !== undefined && (!Array.isArray(value.counted) || !value.counted.every(nonempty))) throw new Error("Invalid Fusion run budget record; consumed budgets stay engaged.");
	return structuredClone(value) as unknown as RunBudget;
}

/** A fresh budget for a new run. */
export function createRunBudget(): RunBudget {
	return { version: 1, activeMs: 0, roles: {} };
}

const USAGE_FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "cost"] as const;
const MAX_DEDUPE_KEYS = 16;

/** Add one turn's observed usage into a usage accumulator. Fields the turn
 * did not carry stay whatever they were (unknown, never zero); per-field
 * turn counts keep partial totals from looking complete. */
function mergeUsage(target: RoleBudgetUsage, usage: WorkerUsage): void {
	target.fieldTurns = { ...target.fieldTurns };
	for (const field of USAGE_FIELDS) {
		const value = usage[field];
		if (value === undefined || !finite(value)) continue;
		target[field] = (target[field] as number | undefined ?? 0) + value;
		target.fieldTurns[field] = (target.fieldTurns[field] ?? 0) + 1;
	}
}

/** Record one worker turn into the run budget — the single accounting write
 * both harnesses use, so dedupe and coverage rules stay identical.
 *
 * - A turn without a usage reading counts as missing: its spend stays
 *   unknown, never zero.
 * - `dedupeKey` marks an already-recorded turn (settlement retry, late
 *   reconcile re-read); duplicates are skipped entirely.
 * - `provider` attributes the turn's tokens for provider ceilings; an
 *   unattributed turn still counts for role totals, it only skips the
 *   provider ledger.
 * - Late readings count normally: they may push the observed total past a
 *   limit after work was already admitted (in-flight spend can exceed a
 *   threshold; readings are delayed, not ignored). */
export function recordRoleUsage(budget: RunBudget, input: { role: BudgetRole; usage?: WorkerUsage; provider?: string; dedupeKey?: string }): void {
	if (input.dedupeKey) {
		if (budget.counted?.includes(input.dedupeKey)) return;
		budget.counted = [...budget.counted ?? [], input.dedupeKey].slice(-MAX_DEDUPE_KEYS);
	}
	const role = budget.roles[input.role] ?? { turnsReported: 0, turnsMissing: 0 };
	if (input.usage) {
		role.turnsReported += 1;
		mergeUsage(role, input.usage);
	} else {
		role.turnsMissing += 1;
	}
	budget.roles[input.role] = role;
	if (input.provider) {
		const providers = budget.providers ?? {};
		const entry = providers[input.provider] ?? { turnsReported: 0, turnsMissing: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, fieldTurns: {} };
		// Coverage rides the attribution: a turn on this provider with no
		// reading is a gap in this provider's ledger, whatever its role saw.
		if (input.usage) entry.turnsReported += 1;
		else entry.turnsMissing += 1;
		const tokenFields = ["inputTokens", "outputTokens"] as const;
		for (const field of tokenFields) {
			const value = input.usage?.[field];
			if (value === undefined || !finite(value)) continue;
			if (field === "inputTokens") entry.inputTokens += value;
			else entry.outputTokens += value;
			entry.fieldTurns[field] = (entry.fieldTurns[field] ?? 0) + 1;
		}
		entry.totalTokens = entry.inputTokens + entry.outputTokens;
		providers[input.provider] = entry;
		budget.providers = providers;
	}
}

/** Add an observed active-execution span to the accumulated budget. */
export function addActiveTime(budget: RunBudget, milliseconds: number): void {
	if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
	budget.activeMs += Math.round(milliseconds);
}

/**
 * Active-execution clock for one worker turn. Active time excludes paused
 * spans (permission/user waits, observed by the adapter); wall time is
 * tracked alongside so a waiting span is accounted separately instead of
 * consuming execution time. Durations persist through `stop()`; a process
 * restart never counts downtime as active execution.
 */
export class ActiveClock {
	private base = 0;
	private runningAt?: number;
	private wallBase = 0;
	private wallRunningAt?: number;
	constructor(private readonly now: () => number = Date.now) {
		this.wallRunningAt = now();
	}
	/** Begin (or resume) counting active time. */
	start(): void {
		if (this.runningAt === undefined) this.runningAt = this.now();
	}
	/** Pause: the elapsed span stops consuming active time and is accounted
	 * as waiting instead. A pause while already paused is a no-op. */
	pause(): void {
		if (this.runningAt === undefined) return;
		this.base += this.now() - this.runningAt;
		this.runningAt = undefined;
	}
	/** Resume after a pause. */
	resume(): void {
		this.start();
	}
	/** Active ms accumulated so far (paused spans excluded). */
	active(): number {
		return this.base + (this.runningAt !== undefined ? this.now() - this.runningAt : 0);
	}
	/** Wall ms since construction, waiting spans included. */
	wall(): number {
		return this.wallBase + (this.wallRunningAt !== undefined ? this.now() - this.wallRunningAt : 0);
	}
	/** Wait ms so far: wall minus active, the separately tracked span. */
	waiting(): number {
		return Math.max(0, this.wall() - this.active());
	}
	/** Commit and stop: returns the active ms to record. */
	stop(): number {
		this.pause();
		const wallAt = this.wallRunningAt;
		if (wallAt !== undefined) { this.wallBase += this.now() - wallAt; this.wallRunningAt = undefined; }
		return this.base;
	}
}

export type BudgetStatus = "open" | "exhausted" | "unknown";
export type BudgetLimitKind = "activeTime" | "observedCost" | "providerTokens";

/** The admission decision one submission gate consults. `admit: false`
 * blocks the submission; the reason names the limit and never claims a
 * strict dollar ceiling. */
export interface BudgetDecision {
	admit: boolean;
	status: BudgetStatus;
	/** Which enabled limit produced a block. */
	limit?: BudgetLimitKind;
	/** Set when the block was waived for this one admission because the user
	 * explicitly continued past an unknown budget; the caller consumes the
	 * waiver and persists. */
	waived?: boolean;
	reason?: string;
}

/** Coverage of one cost/token ledger: every observed turn must have carried
 * the field for the total to be verifiable. No turns observed yet is not
 * missing coverage — there is nothing unobserved to hide. */
function ledgerComplete(entry: { turnsReported: number; turnsMissing: number; fieldTurns?: Record<string, number> }, field: string): boolean {
	if (entry.turnsMissing > 0) return false;
	if (entry.turnsReported === 0) return true;
	return (entry.fieldTurns?.[field] ?? 0) === entry.turnsReported;
}

const shortMoney = (value: number): string => `$${value.toFixed(value >= 100 ? 0 : 2)}`;

/** Evaluate the run's limits against observed accounting. Pure: nothing is
 * mutated and nothing is submitted. The caller triggers cancellation of
 * in-flight workers through the R1 stop path when a limit is reached.
 *
 * Unknown beats exhausted wording only in coverage; an actually observed
 * total at or past its limit is exhausted regardless of other roles' gaps
 * (a role that cannot be observed on this host never feeds these checks).
 */
export function evaluateRunBudget(
	policy: RunControlPolicy | undefined,
	budget: RunBudget | undefined,
	options: { observableRoles: readonly BudgetRole[]; attributedProviders?: readonly string[] } = { observableRoles: BUDGET_ROLES },
): BudgetDecision {
	if (!policy) return { admit: true, status: "open" };
	const consumed = budget ?? createRunBudget();
	const observed = (role: BudgetRole): RoleBudgetUsage | undefined =>
		options.observableRoles.includes(role) ? consumed.roles[role] : undefined;

	// Provider token ceilings: a provider the harness cannot attribute stays
	// unknown, never silently unlimited.
	if (policy.providerTokenCeilings) {
		for (const [provider, ceiling] of Object.entries(policy.providerTokenCeilings)) {
			if (!(options.attributedProviders ?? []).includes(provider)) {
				return {
					admit: false, status: "unknown", limit: "providerTokens",
					reason: `Fusion run budget is unknown: a token ceiling is configured for "${provider}" but this host cannot attribute token usage to it. Nothing will be submitted until you continue explicitly or change the policy (/fusion-budget).`,
				};
			}
			const entry = consumed.providers?.[provider];
			if (!entry || !ledgerComplete(entry, "inputTokens") || !ledgerComplete(entry, "outputTokens")) {
				return {
					admit: false, status: "unknown", limit: "providerTokens",
					reason: `Fusion run budget is unknown: token readings for "${provider}" are incomplete (some turns reported no usage), so the configured token ceiling cannot be verified. Missing readings are never treated as zero. Continue explicitly or change the policy (/fusion-budget).`,
				};
			}
			if (entry.totalTokens >= ceiling) {
				return {
					admit: false, status: "exhausted", limit: "providerTokens",
					reason: `Fusion run token limit reached: ${entry.totalTokens.toLocaleString("en-US")} tokens observed for "${provider}" (ceiling ${ceiling.toLocaleString("en-US")}). Further submission is blocked.`,
				};
			}
		}
	}

	// Observed spend: a limit on accounting, never a strict dollar ceiling.
	if (policy.observedCostLimit !== undefined) {
		const costRoles = options.observableRoles.filter((role) => consumed.roles[role]?.cost !== undefined);
		const missingTurns = options.observableRoles.reduce((sum, role) => sum + (consumed.roles[role]?.turnsMissing ?? 0), 0);
		const incompleteField = options.observableRoles.some((role) => {
			const entry = consumed.roles[role];
			return entry !== undefined && entry.turnsReported > 0 && !ledgerComplete(entry, "cost");
		});
		if (missingTurns > 0 || incompleteField) {
			const waived = consumed.unknownWaiver === true;
			return {
				admit: waived, status: "unknown", limit: "observedCost", ...(waived ? { waived: true } : {}),
				reason: `Fusion run budget is unknown: cost readings are incomplete (${missingTurns} turn${missingTurns === 1 ? "" : "s"} reported no usage${incompleteField ? ", and some reported turns carried no cost" : ""}), so the observed-spend limit of ${shortMoney(policy.observedCostLimit)} cannot be verified. Missing readings are never treated as zero. Continue explicitly or change the policy (/fusion-budget).`,
			};
		}
		const observedCost = options.observableRoles.reduce((sum, role) => sum + (consumed.roles[role]?.cost ?? 0), 0);
		if (observedCost >= policy.observedCostLimit) {
			return {
				admit: false, status: "exhausted", limit: "observedCost",
				reason: `Fusion run spending limit reached: ${shortMoney(observedCost)} observed across ${costRoles.length ? costRoles.join(", ") : "the observable roles"} (limit ${shortMoney(policy.observedCostLimit)}). This is observed accounting, not a strict ceiling: in-flight work may still spend beyond it. Further submission is blocked.`,
			};
		}
	}

	// Active execution time: the accumulated clock, persisted across restarts.
	if (policy.activeTimeLimitMs !== undefined && consumed.activeMs >= policy.activeTimeLimitMs) {
		return {
			admit: false, status: "exhausted", limit: "activeTime",
			reason: `Fusion run time limit reached: ${formatDuration(consumed.activeMs)} of active execution observed (limit ${formatDuration(policy.activeTimeLimitMs)}). Further submission is blocked.`,
		};
	}

	return { admit: true, status: "open" };
}

/** How much active time remains before the configured limit, in ms, or
 * undefined when no time limit is configured. A timer arms for this bound
 * (bounded timers, never polling). */
export function remainingActiveMs(policy: RunControlPolicy | undefined, budget: RunBudget | undefined): number | undefined {
	if (!policy?.activeTimeLimitMs) return undefined;
	const consumed = budget?.activeMs ?? 0;
	return Math.max(0, policy.activeTimeLimitMs - consumed);
}

/** Display lines for status/stats: policy, consumed amounts, and coverage,
 * with the observable roles stated honestly. Shared wording across hosts. */
export function describeRunBudget(
	policy: RunControlPolicy | undefined,
	budget: RunBudget | undefined,
	options: { observableRoles: readonly BudgetRole[]; attributedProviders?: readonly string[] },
): string[] {
	const lines: string[] = [];
	const consumed = budget ?? createRunBudget();
	if (!policy) {
		lines.push(`Budget: no limits configured (unlimited). Active execution observed: ${formatDuration(consumed.activeMs)}.`);
	} else {
		const decision = evaluateRunBudget(policy, consumed, options);
		const limits: string[] = [];
		if (policy.activeTimeLimitMs !== undefined) limits.push(`time ${formatDuration(policy.activeTimeLimitMs)}`);
		if (policy.observedCostLimit !== undefined) limits.push(`spend ${shortMoney(policy.observedCostLimit)} observed`);
		for (const [provider, ceiling] of Object.entries(policy.providerTokenCeilings ?? {})) limits.push(`tokens ${provider} ≤ ${ceiling.toLocaleString("en-US")}`);
		lines.push(`Policy: ${limits.length ? limits.join(", ") : "no limits"} | status ${decision.status}${decision.waived ? " (one admission granted by explicit continue)" : ""}.`);
		lines.push(`Active execution observed: ${formatDuration(consumed.activeMs)} (waits excluded).`);
		if (decision.reason) lines.push(`Budget: ${decision.reason}`);
	}
	const roles = options.observableRoles;
	const roleParts: string[] = [];
	for (const role of roles) {
		const entry = consumed.roles[role];
		if (!entry) { roleParts.push(`${role}: no turns yet`); continue; }
		const missing = entry.turnsMissing > 0 ? `, ${entry.turnsMissing} unknown` : "";
		const cost = entry.cost !== undefined ? `$${entry.cost.toFixed(4)}` : "cost unknown";
		roleParts.push(`${role}: ${entry.turnsReported} turn${entry.turnsReported === 1 ? "" : "s"}${missing}, ${cost}`);
	}
	lines.push(`Usage (${roles.join(", ")} observable on this host): ${roleParts.join(" | ")}`);
	const unobservable = BUDGET_ROLES.filter((role) => !roles.includes(role));
	if (unobservable.length > 0) lines.push(`Usage: ${unobservable.join(" and ")} ${unobservable.length === 1 ? "is" : "are"} not observable on this host; limits apply to observed accounting only, never a strict ceiling.`);
	return lines;
}

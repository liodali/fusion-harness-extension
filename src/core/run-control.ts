import type { WorkerCapabilities, WorkerOwner, WorkerReference } from "./worker.ts";

/**
 * Shared run-control contract. Three concerns stay separate on purpose:
 *
 * - Lifecycle (core/workflow.ts): protocol progress — phases, revisions,
 *   scout budgets. It never implies that a worker's turn ended.
 * - Observed activity (ExecutionObservation): what a host adapter can
 *   establish about a worker right now. Tool activity is advisory.
 * - Control state (RunStopIntent / RunControlPolicy): persisted stop intent
 *   and configured limits. They gate admitting new work.
 *
 * Standing rules, proven by tests in test/run-control.test.ts:
 * - Interruption delivery is not termination. A delivered or acknowledged
 *   interruption, a waiting permission request, and silence never establish
 *   that a worker's turn ended; only terminal proof does.
 * - Process-local operation promises (in-flight aborts, waits) are never
 *   persisted. A restored "requested" delivery is retryable, not proof that
 *   an interruption is still running.
 * - Loading control state never submits, interrupts, or releases anything.
 */

/** Why work was stopped. Existing records are operator stops; policy stops
 * arrive with run time/cost limits (R2). */
export type RunStopReasonKind = "operator" | "policy";

/** Per-worker interruption delivery, unified across harnesses.
 *
 * - "requested": queued or sent, delivery unconfirmed — including a record
 *   restored after a restart, whose operation no longer exists.
 * - "delivered": the host accepted the interruption. Termination is still
 *   not confirmed.
 * - "failed": the interruption attempt rejected (error recorded).
 * - "unsupported": the runtime lacks the workerAbort capability.
 * - "not-submitted": non-submission established — the worker had no pending
 *   request identity when the stop landed. An unknown delivery with a
 *   pending request reads as "requested", never as non-submission. */
export type InterruptionDelivery = "requested" | "delivered" | "failed" | "unsupported" | "not-submitted";

/** Terminal evidence for a worker's original submission. */
export type WorkerTermination =
	| { proof: "unconfirmed" }
	| { proof: "ended"; terminal: "completed" | "error" | "cancelled" };

export type StopRole = "executor" | "scout";

/** One affected worker within a stop intent. */
export interface StopWorkerState {
	role: StopRole;
	/** The unsettled request this worker was admitted for, when known. */
	requestId?: string;
	/** Native identity, when already established; a worker may still be
	 * awaiting one (delivery stays "requested" until it exists). */
	reference?: WorkerReference;
	delivery: InterruptionDelivery;
	termination: WorkerTermination;
	error?: string;
	/** Last observed activity label; advisory only. */
	detail?: string;
	/** True when the delivery is queued because the worker's native child
	 * reference is not established yet, so the interruption cannot be sent
	 * to a live turn. Absent, a "requested" delivery means the attempt
	 * itself was sent and remains unconfirmed. */
	awaitingReference?: boolean;
}

/** Persisted stop intent: recorded before more work is admitted. */
export interface RunStopIntent {
	version: 1;
	runId: string;
	owner: WorkerOwner;
	requestedAt: string;
	reason: { kind: RunStopReasonKind; detail?: string };
	workers: StopWorkerState[];
}

/** What a host adapter can establish about a worker's execution. Adapters
 * report only what their host establishes; absence of signals is "unknown",
 * never a blocked or terminal claim. */
export type ExecutionObservation =
	| "starting"
	| "implementing"
	| "checking"
	| "waiting-permission"
	| "waiting-user"
	| "awaiting-reconciliation"
	| "unknown";

export function isExecutionObservation(value: unknown): value is ExecutionObservation {
	return ["starting", "implementing", "checking", "waiting-permission", "waiting-user", "awaiting-reconciliation", "unknown"].includes(value as string);
}

/** Configured run limits (R2 enforces them). Absent limits preserve the
 * existing unlimited behavior; a present limit must be a positive finite
 * number, and an unknown provider ceiling entry is invalid. */
export interface RunControlPolicy {
	version: 1;
	/** Ceiling on accumulated active execution time. */
	activeTimeLimitMs?: number;
	/** Ceiling on observed accounting; missing cost readings stay unknown,
	 * never zero. */
	observedCostLimit?: number;
	/** Per-provider token ceilings, keyed by provider id. */
	providerTokenCeilings?: Record<string, number>;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && !!value.trim();
const isoDate = (value: unknown): boolean => typeof value === "string" && Number.isFinite(Date.parse(value));
const positiveLimit = (value: unknown): boolean => value === undefined || (typeof value === "number" && Number.isFinite(value) && value > 0);

const deliveries: readonly InterruptionDelivery[] = ["requested", "delivered", "failed", "unsupported", "not-submitted"];
const terminals: readonly NonNullable<Extract<WorkerTermination, { proof: "ended" }>["terminal"]>[] = ["completed", "error", "cancelled"];

function ownerIs(value: unknown): value is WorkerOwner {
	return object(value) && nonempty(value.harness) && nonempty(value.supervisorId) && nonempty(value.workspace);
}

/** A worker reference belongs to the intent's owner or the record is
 * foreign: harness, supervisor, and workspace must all match. */
const sameOwner = (a: WorkerOwner, b: WorkerOwner): boolean =>
	a.harness === b.harness && a.supervisorId === b.supervisorId && a.workspace === b.workspace;

function referenceIs(value: unknown): value is WorkerReference {
	return object(value) && ownerIs(value.owner) && nonempty(value.runtime) && nonempty(value.id);
}

function terminationIs(value: unknown): value is WorkerTermination {
	if (!object(value)) return false;
	if (value.proof === "ended") return terminals.includes(value.terminal as "completed");
	return value.proof === "unconfirmed";
}

function workerStateIs(value: unknown): value is StopWorkerState {
	if (!object(value)) return false;
	if (!(value.role === "executor" || value.role === "scout")) return false;
	if (!deliveries.includes(value.delivery as InterruptionDelivery)) return false;
	if (!terminationIs(value.termination)) return false;
	if (value.requestId !== undefined && !nonempty(value.requestId)) return false;
	if (value.reference !== undefined && !referenceIs(value.reference)) return false;
	if (value.error !== undefined && typeof value.error !== "string") return false;
	if (value.detail !== undefined && typeof value.detail !== "string") return false;
	if (value.awaitingReference !== undefined && typeof value.awaitingReference !== "boolean") return false;
	return true;
}

/** Absent input reads as no stop intent. A present but malformed, corrupt,
 * or future-version record throws: control state is never silently
 * downgraded to "no stop" (mirrors core/manifest.ts). Unknown extra fields
 * are preserved unvalidated for additive compatibility; reading never
 * rewrites, submits, or interrupts anything. */
export function readRunStopIntent(value: unknown): RunStopIntent | undefined {
	if (value === undefined || value === null) return undefined;
	if (!object(value) || value.version !== 1) throw new Error("Unsupported Fusion stop intent record.");
	const { owner, reason, workers } = value;
	if (!nonempty(value.runId) || !ownerIs(owner) || !isoDate(value.requestedAt) || !Array.isArray(workers) || workers.length === 0 ||
		!object(reason) || !["operator", "policy"].includes(reason.kind as string) ||
		(reason.detail !== undefined && typeof reason.detail !== "string") ||
		!workers.every(workerStateIs) ||
		!workers.every((worker) => (worker as StopWorkerState).reference === undefined || sameOwner((worker as StopWorkerState).reference!.owner, owner))) {
		throw new Error("Invalid Fusion stop intent record; control stays engaged.");
	}
	return structuredClone(value) as unknown as RunStopIntent;
}

/** Absent input reads as no policy (existing behavior). A present but
 * malformed record throws rather than silently lifting a limit. */
export function readRunControlPolicy(value: unknown): RunControlPolicy | undefined {
	if (value === undefined || value === null) return undefined;
	if (!object(value) || value.version !== 1) throw new Error("Unsupported Fusion run policy record.");
	const { providerTokenCeilings } = value;
	const ceilingIsPositive = (entry: unknown): entry is number => typeof entry === "number" && Number.isFinite(entry) && entry > 0;
	if (!positiveLimit(value.activeTimeLimitMs) || !positiveLimit(value.observedCostLimit) ||
		(providerTokenCeilings !== undefined && (!object(providerTokenCeilings) ||
			Object.keys(providerTokenCeilings).some((key) => !nonempty(key)) ||
			Object.values(providerTokenCeilings).some((entry) => !ceilingIsPositive(entry))))) {
		throw new Error("Invalid Fusion run policy record; limits stay engaged.");
	}
	return structuredClone(value) as unknown as RunControlPolicy;
}

/** Any recorded stop intent blocks admitting more work for the run,
 * whatever the delivery state of individual workers. */
export function stopBlocksAdmission(intent: RunStopIntent | undefined): boolean {
	return intent !== undefined;
}

/** Terminal proof exists only from a settled terminal outcome — never from
 * delivery, acknowledgement, waiting, or silence. */
export function terminationProved(worker: StopWorkerState): boolean {
	return worker.termination.proof === "ended";
}

/** Whether another stop should re-attempt this worker's interruption.
 * A restored "requested" delivery is retryable: its operation died with its
 * process and only the record survived. A delivered interruption or a
 * never-submitted worker has nothing to retry; an unsupported runtime needs
 * a configuration change, and the next stop re-evaluates capabilities. */
export function interruptionRetryable(worker: StopWorkerState): boolean {
	if (terminationProved(worker)) return false;
	return worker.delivery === "requested" || worker.delivery === "failed";
}

/** A stop applies to the request it was recorded against (the write-ahead
 * identity), so a later request under the same stop is still blocked while
 * the original stays identifiable. */
export function stopAppliesToRequest(intent: RunStopIntent, requestId: string): boolean {
	return intent.workers.some((worker) => worker.requestId === requestId);
}

/** Delivery a runtime can attempt for a worker, before any stop-specific
 * state: capability absence is "unsupported", never a silent no-op. */
export function planInterruptionDelivery(capabilities: WorkerCapabilities): InterruptionDelivery {
	return capabilities.workerAbort ? "requested" : "unsupported";
}

/** The per-worker decision the current stop makes, shared by both harnesses
 * so the scope, repeat-stop, and capability rules stay identical. A worker
 * with no unresolved request identity on this run has nothing to interrupt:
 * its submission never started, which reads as "not-submitted". A runtime
 * without workerAbort is "unsupported", never a silent no-op. Everything
 * else attempts the interruption. The caller supplies the harness's
 * liveness gate (an unsettled executor request, a live scout call, an
 * owned worker handle) as `hasUnresolvedRequest`.
 */
export function planWorkerInterruption(capabilities: WorkerCapabilities, worker: { hasUnresolvedRequest: boolean }): { attempt: boolean; delivery: InterruptionDelivery } {
	if (!worker.hasUnresolvedRequest) return { attempt: false, delivery: "not-submitted" };
	const planned = planInterruptionDelivery(capabilities);
	return { attempt: planned === "requested", delivery: planned };
}

/** One per-worker stop line with identical wording in both harnesses.
 * Termination is claimed only from terminal proof; a delivered
 * interruption, waiting, or silence never ends a turn. */
export function describeStopWorker(worker: StopWorkerState): string {
	const label = worker.role === "executor" ? "Executor" : "Scout";
	if (worker.termination.proof === "ended") {
		if (worker.termination.terminal === "completed") return `${label} completed before interruption; its turn has ended.`;
		if (worker.termination.terminal === "error") return worker.error ? `${label} ended with an error: ${worker.error}.` : `${label} ended with an error; its turn has ended.`;
		return `${label} turn stopped (cancelled); its submission has ended.`;
	}
	switch (worker.delivery) {
		case "delivered": return `${label} interruption delivered; termination is not confirmed.`;
		case "requested":
			// A reference or no awaitingReference flag means the interruption
			// went out to an identified worker or ran in-process; queued
			// means the worker's child reference is still missing, so the
			// delivery cannot have been sent yet.
			return worker.reference && worker.reference.id || worker.awaitingReference !== true ? `${label} interruption requested; termination is not confirmed.` : `${label} stop queued; waiting for its child reference. Termination is not confirmed yet.`;
		case "failed": return `${label} stop failed: ${worker.error ?? "interruption unavailable"}. Termination is not confirmed.`;
		case "unsupported": return `${label} stop is unsupported: this runtime cannot interrupt workers. Termination is not confirmed.`;
		case "not-submitted": return `${label} stopped before submission; no worker turn was running.`;
	}
}

/** Legacy Pi stop marker shape (FusionRun.stopped), mapped into the shared
 * contract. The marker records only executor abort delivery; termination is
 * never proven by it. */
export interface PiStopMarkerShape {
	at: string;
	reason?: string;
	abort?: "delivered" | "failed" | "pending";
}

/** Delivery for a legacy Pi marker. An absent abort field is only proof of
 * non-submission when no pending request identity exists (the write-ahead
 * record precedes any submission). With a pending request — an older
 * marker, or a crash between the initial marker write and the abort
 * attempt — delivery is unknown and stays retryable as "requested". */
const piDelivery = (abort: PiStopMarkerShape["abort"], pendingSubmission: boolean): InterruptionDelivery =>
	abort === "delivered" ? "delivered"
	: abort === "failed" ? "failed"
	: abort === "pending" ? "requested"
	: pendingSubmission ? "requested"
	: "not-submitted";

export function piStopMarkerToIntent(
	owner: WorkerOwner,
	input: { runId: string; requestId?: string; runtime?: "session" | "durable"; workerId?: string; marker: PiStopMarkerShape },
): RunStopIntent {
	const { marker } = input;
	const worker: StopWorkerState = {
		role: "executor",
		...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
		...(input.runtime !== undefined && input.workerId !== undefined ? { reference: { owner, runtime: input.runtime, id: input.workerId } } : {}),
		delivery: piDelivery(marker.abort, input.requestId !== undefined),
		termination: { proof: "unconfirmed" },
	};
	return {
		version: 1,
		runId: input.runId,
		owner,
		requestedAt: marker.at,
		reason: { kind: "operator", ...(marker.reason !== undefined ? { detail: marker.reason } : {}) },
		workers: [worker],
	};
}

/** Legacy OpenCode stop record shape (adapterData.fusionStop), mapped into
 * the shared contract. "acknowledged" is delivery only; "confirmed" proves
 * termination only together with its terminal outcome. */
export interface OpenCodeStopShape {
	requestId: string;
	requestedAt: number;
	updatedAt: number;
	state: "requested" | "acknowledged" | "confirmed" | "not-submitted" | "failed";
	childSessionID?: string;
	reason: string;
	terminal?: "completed" | "error" | "cancelled";
	error?: string;
}

export function openCodeStopToIntent(owner: WorkerOwner, stop: OpenCodeStopShape, input: { runId: string }): RunStopIntent {
	const delivery: InterruptionDelivery =
		stop.state === "acknowledged" || stop.state === "confirmed" ? "delivered"
		: stop.state === "failed" ? "failed"
		: stop.state === "not-submitted" ? "not-submitted"
		: "requested";
	const termination: WorkerTermination =
		stop.state === "confirmed" && stop.terminal !== undefined && terminals.includes(stop.terminal)
			? { proof: "ended", terminal: stop.terminal }
			: { proof: "unconfirmed" };
	const worker: StopWorkerState = {
		role: "executor",
		requestId: stop.requestId,
		...(stop.childSessionID !== undefined ? { reference: { owner, runtime: "native-subagent", id: stop.childSessionID } } : {}),
		delivery,
		termination,
		...(stop.error !== undefined ? { error: stop.error } : {}),
		...(stop.reason !== undefined ? { detail: stop.reason } : {}),
	};
	return {
		version: 1,
		runId: input.runId,
		owner,
		requestedAt: new Date(stop.requestedAt).toISOString(),
		reason: { kind: "operator", detail: stop.reason },
		workers: [worker],
	};
}

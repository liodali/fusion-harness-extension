import { describeStopWorker, type StopWorkerState, type WorkerTermination } from "../core/run-control.ts";
import { shortLabel } from "./delegate-presentation.ts";

export interface ExecutorStop {
	requestId: string;
	requestedAt: number;
	updatedAt: number;
	state: "requested" | "acknowledged" | "confirmed" | "not-submitted" | "failed";
	childSessionID?: string;
	reason: string;
	/** "policy" when a run time/cost limit triggered this stop (R2); absent
	 * reads as an operator stop. Additive; read back defensively. */
	kind?: "operator" | "policy";
	activity?: string;
	tools?: number;
	terminal?: "completed" | "error" | "cancelled";
	error?: string;
	persistenceWarning?: boolean;
	/** Per-scout stop records for the same run scope. Additive to the legacy
	 * executor-only record; read back defensively. */
	scouts?: ScoutStop[];
}

export interface ScoutStop {
	requestId?: string;
	requestedAt: number;
	updatedAt: number;
	state: "requested" | "acknowledged" | "confirmed" | "not-submitted" | "failed";
	childSessionID?: string;
	terminal?: "completed" | "error" | "cancelled";
	error?: string;
	detail?: string;
}

const SCOUT_STOP_STATES = new Set(["requested", "acknowledged", "confirmed", "not-submitted", "failed"]);
const SCOUT_TERMINALS = new Set(["completed", "error", "cancelled"]);

/** Per-entry validation: entries that no longer validate are dropped instead
 * of losing the executor record. A malformed shape never reads back as a
 * confirmed termination. */
export function readScoutStops(value: unknown): ScoutStop[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is ScoutStop => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
		const item = entry as Record<string, unknown>;
		return SCOUT_STOP_STATES.has(item.state as string)
			&& Number.isFinite(item.requestedAt) && Number.isFinite(item.updatedAt)
			&& (item.requestId === undefined || typeof item.requestId === "string")
			&& (item.childSessionID === undefined || typeof item.childSessionID === "string")
			&& (item.terminal === undefined || SCOUT_TERMINALS.has(item.terminal as string))
			&& (item.error === undefined || typeof item.error === "string")
			&& (item.detail === undefined || typeof item.detail === "string");
	});
}

export function readExecutorStop(value: unknown): ExecutorStop | undefined {
	if (!value || typeof value !== "object") return;
	const item = value as ExecutorStop;
	if (typeof item.requestId !== "string" || !Number.isFinite(item.requestedAt) || !Number.isFinite(item.updatedAt) || typeof item.reason !== "string" || !["requested", "acknowledged", "confirmed", "not-submitted", "failed"].includes(item.state)) return;
	// A malformed kind only loses the label, never the stop guard itself.
	if (item.kind !== undefined && item.kind !== "operator" && item.kind !== "policy") delete item.kind;
	// The record keeps its identity: stop flows and bus handlers mutate the
	// object they read, and persistence keys off the stored record.
	if (item.scouts !== undefined) {
		// The per-scout list is additive advisory state; entries that no
		// longer validate are dropped in place while the record rides on.
		item.scouts = Array.isArray(item.scouts) ? readScoutStops(item.scouts) : undefined;
	}
	return item;
}

const asScoutWorkerState = (scout: ScoutStop): StopWorkerState => {
	const termination: WorkerTermination = scout.state === "confirmed" && scout.terminal ? { proof: "ended", terminal: scout.terminal } : { proof: "unconfirmed" };
	return {
		role: "scout",
		delivery: scout.state === "acknowledged" || scout.state === "confirmed" ? "delivered" : scout.state === "failed" ? "failed" : scout.state === "not-submitted" ? "not-submitted" : "requested",
		termination,
		...(scout.error !== undefined ? { error: scout.error } : {}),
		...(scout.detail !== undefined ? { detail: scout.detail } : {}),
		// Without a published child reference the delivery is queued, not sent.
		...(scout.state === "requested" && !scout.childSessionID ? { awaitingReference: true } : {}),
	};
};

/** One bounded wait, not polling. Stop feedback must not hang on a slow disk
 * or interruption acknowledgement; pending operations retain their guards. */
export async function stopWait(operation: Promise<unknown>, milliseconds: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([operation.then(() => true, () => false), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); })]);
	} finally { if (timer) clearTimeout(timer); }
}

/** One bounded interruption attempt with its three outcomes kept distinct:
 * fulfilled delivery, rejection (rethrown for the caller's failure record),
 * or a bounded timeout that leaves the delivery unconfirmed ("requested") —
 * never conflated into an acknowledgement. */
export async function stopInterruptOutcome(operation: Promise<unknown>, milliseconds: number): Promise<{ settled: true } | { settled: false }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation.then((): { settled: true } => ({ settled: true }), (error: unknown) => { throw error; }),
			new Promise<{ settled: false }>((resolve) => { timer = setTimeout(() => resolve({ settled: false }), milliseconds); }),
		]);
	} finally { if (timer) clearTimeout(timer); }
}

/** Bounded deterministic feedback; cancelling never asks another model for a report. */
export function stopFeedback(stop: ExecutorStop): string {
	const status = stop.state === "confirmed" ? stop.terminal === "completed" ? "Executor completed before interruption; its turn has ended." : stop.terminal === "error" ? "Executor ended with an error; its turn has ended." : "Executor turn stopped (cancelled)."
		: stop.state === "not-submitted" ? "Executor stopped before submission."
		: stop.state === "failed" ? `Executor stop failed: ${shortLabel(stop.error ?? "interruption unavailable", 160)}. Termination is not confirmed.`
		: stop.state === "acknowledged" ? "Executor interruption requested. Termination is not confirmed yet."
		: "Executor stop queued; waiting for its child reference. Termination is not confirmed yet.";
	const scoutLines = (stop.scouts ?? []).map((scout) => describeStopWorker(asScoutWorkerState(scout)));
	return [
		[status, ...scoutLines].join("\n"),
		...(stop.kind === "policy" ? ["This stop was requested by the run's time or cost policy (observed accounting), not by the operator."] : []),
		stop.activity ? `Last observed: ${shortLabel(stop.activity)}${typeof stop.tools === "number" ? ` (${stop.tools} tools)` : ""}.` : "No executor activity was observed.",
		"Partial edits are preserved. Inspect the working tree and reconcile retained work before resetting; no automatic retry will run.",
		...(stop.persistenceWarning ? ["A stop-record write failed or timed out; verify saved status before recovery."] : []),
	].join("\n");
}
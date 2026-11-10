import { describeStopWorker, interruptionRetryable, planWorkerInterruption, type StopWorkerState, type WorkerTermination } from "../core/run-control.ts";
import type { WorkerCapabilities } from "../core/worker.ts";
import type { FusionRun, FusionStopWorker } from "../runs.ts";

/** Why further executor/scout work is refused for a stopped run, shared by
 * the delegation and scout gates so the wording stays identical. */
export const STOPPED_RUN_REFUSAL = "This Fusion run was stopped. Recover a durable turn with /fusion-resume or release the run with /fusion-clean before starting more executor work.";

/** Delivery states recorded on the stop marker. "pending" means delivery
 * was never confirmed — it is NOT proof that an abort operation is still
 * running: after a restart the promise and its follower are gone. */
export type StopAbortState = "delivered" | "failed" | "pending";

/** One live abort operation started by stopFusionRun, carrying its own
 * terminal state so a later stop can wait on it without closure state. */
export type AbortFlight = Promise<{ state: "delivered" } | { state: "failed"; error?: string }>;

/** One live worker interruption. `terminal` rides the flight only when the
 * caller's runtime can prove, in-process, that the turn ended — a worker
 * whose turn outlives its process reports delivery alone. */
export type StopWorkerFlight = Promise<{ state: "delivered"; terminal?: "completed" | "error" | "cancelled" } | { state: "failed"; error?: string }>;

/** Live abort operations keyed by run and worker ("runId" for the executor,
 * "runId:scout" for scouts), held in memory only. In-flight state lives
 * here — separate from the persisted delivery state — so a restored
 * "pending" marker (whose operation no longer exists) is retried instead of
 * being mistaken for a running abort. */
export type StopFlights = Map<string, AbortFlight | StopWorkerFlight>;

export interface StopDeps {
	/** The session's active run; mutated only by marking it stopped. */
	activeRun: FusionRun | undefined;
	/** True when the controller holds an unsettled executor request, or a
	 * delegation turn is in flight (its executor can be aborted directly). */
	uncertain: boolean;
	/** The actually delegated backend's capabilities; the shared per-worker
	 * planning reads the abort capability from here. */
	capabilities: WorkerCapabilities;
	/** Abort the live executor conversation/session, when one exists. */
	abortExecutor: () => Promise<void>;
	/** Interrupt the run's live scout turn, when one is in flight. Undefined
	 * is the liveness gate: without an active scout nothing is attempted,
	 * and a restored scout record is reported as-is instead. */
	interruptScout?: () => StopWorkerFlight;
	/** Last observed scout activity, recorded as the scout worker's detail. */
	scoutActivity?: string;
	/** Live abort operations for this session's runs. */
	flights: StopFlights;
	/** Human label of the executor model, for the recap. */
	executorLabel: string;
	/** The backend the run actually delegated on. */
	backend: "session" | "durable" | undefined;
	/** Last observed executor activity. */
	activity: string | undefined;
	/** Most recent executor progress entries, oldest first. */
	transcriptTail: string[];
	/** Persist the stopped run record; a failure must not lose the marker. */
	persist: () => Promise<void>;
	/** Timestamp source, injectable for deterministic tests. */
	now?: () => Date;
	/** Bound for the abort wait (default 1500ms); past it delivery reports pending. */
	abortTimeoutMs?: number;
	/** Bound for each marker-write wait (default 2000ms); a slow disk cannot stall the stop. */
	persistTimeoutMs?: number;
}

export interface StopOutcome {
	text: string;
	stopped: boolean;
	/** "delivered" the abort settled, "failed" it rejected, "pending" the
	 * bounded wait elapsed without it settling (it is still followed), and
	 * "skipped" nothing was known to be running or a delivery already holds. */
	abort: StopAbortState | "skipped";
	/** Per-worker delivery and terminal evidence over the whole stop scope. */
	workers: StopWorkerState[];
	error?: string;
	persisted: boolean;
}

const shortTask = (task: string): string => task.length > 80 ? `${task.slice(0, 77)}...` : task;

/** One bounded wait, never polling: the caller's recap must not hang behind
 * a stalled write or abort. The operation may still settle after the bound. */
function waitOrTimeout(operation: Promise<void>, milliseconds: number, label: string): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		operation,
		new Promise<void>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds); }),
	]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

const asWorkerState = (record: FusionStopWorker): StopWorkerState => ({
	role: record.role,
	delivery: record.delivery,
	termination: (record.terminal !== undefined ? { proof: "ended", terminal: record.terminal } : { proof: "unconfirmed" }) as WorkerTermination,
	...(record.error !== undefined ? { error: record.error } : {}),
	...(record.detail !== undefined ? { detail: record.detail } : {}),
});

/** Replace the entry for a worker role with the given record. */
const applyWorkers = (marker: NonNullable<FusionRun["stopped"]>, record: FusionStopWorker): void => {
	marker.workers = [...(marker.workers ?? []).filter((worker) => worker.role !== record.role), record];
};

/** Stop the current Fusion run and compose a deterministic recap. No model
 * is asked to summarize; every claim comes from recorded state, and
 * termination is never overstated. Ordering is deliberate: the stop marker
 * is set before any awaited I/O, so a stalled abort or write can never
 * leave the run unmarked or block the supervisor's feedback; every owned
 * worker's interruption is attempted even when another attempt failed or a
 * write stalled (a scout stop stands on its own); each abort wait is
 * bounded and reports delivery as pending until it settles; live aborts are
 * tracked in memory (not on the persisted marker), so a restored "pending"
 * after a restart is retried instead of being mistaken for a running
 * operation; and every call retries a previously failed marker write, so a
 * repeated stop never claims a persistence that did not happen. */
export async function stopFusionRun(deps: StopDeps, reason?: string): Promise<StopOutcome> {
	const run = deps.activeRun;
	if (!run) return { text: "No Fusion run is active; nothing to stop.", stopped: false, abort: "skipped", workers: [], persisted: false };
	const at = (deps.now ?? (() => new Date()))().toISOString();
	// Marker first: the delegation and scout gates key off it immediately,
	// in memory, whatever happens to the writes or abort below.
	const fresh = !run.stopped;
	const marker = run.stopped ?? { at, ...(reason?.trim() ? { reason: shortTask(reason.trim()) } : {}) };
	run.stopped = marker;
	run.updatedAt = marker.at;
	// Every stop recomposes the executor's own record from the marker's
	// delivery state, so the run-scope record never lags the `abort` field.
	applyWorkers(marker, executorWorkerRecord(marker));
	// Delivery only suppresses a retry when it was actually proven. A live
	// abort in this session is awaited rather than re-sent; a persisted
	// "pending" or "failed" is retried, because after a restart its
	// operation no longer exists and only the record survived.
	let persisted = true;
	const writeMarker = async (): Promise<void> => {
		try {
			await waitOrTimeout(deps.persist(), deps.persistTimeoutMs ?? 2000, "stop-marker write");
		} catch {
			persisted = false;
		}
	};
	await writeMarker();
	let abortError: string | undefined;
	if (deps.uncertain && marker.abort !== "delivered") {
		let flight = deps.flights.get(run.runId);
		if (!flight) {
			marker.abort = "pending";
			const operation = deps.abortExecutor();
			flight = operation.then(
				() => ({ state: "delivered" as const }),
				(error: unknown) => ({ state: "failed" as const, error: error instanceof Error ? error.message : String(error) }),
			) as AbortFlight;
			deps.flights.set(run.runId, flight);
			// The follower cleans the registry and catches the marker (and the
			// run record, best effort) up when the abort settles, even if this
			// call already returned reporting pending.
			void flight.then((result) => {
				deps.flights.delete(run.runId);
				if (marker.abort === "pending") {
					marker.abort = result.state === "failed" ? "failed" : "delivered";
					applyWorkers(marker, executorWorkerRecord(marker, result.state === "failed" ? result.error : undefined));
					void deps.persist().catch(() => {});
				}
			});
		}
		const outcome = await new Promise<"settled" | "timeout">((resolve) => {
			const timer = setTimeout(() => resolve("timeout"), deps.abortTimeoutMs ?? 1500);
			void flight!.then(() => { clearTimeout(timer); resolve("settled"); });
		});
		if (outcome === "settled") {
			const result = await flight;
			if (result.state === "failed") { marker.abort = "failed"; abortError = result.error; }
			else marker.abort = "delivered";
		} else {
			marker.abort = "pending";
		}
		// The delivery state belongs on the record; a failed write never
		// un-stops the run and stays retryable by the next stop.
		applyWorkers(marker, executorWorkerRecord(marker, abortError));
		await writeMarker();
	}
	// Scout scope: the run's live scout is interrupted with the same bounded,
	// flight-shared, retry-failed semantics as the executor. The executor's
	// outcome above never suppresses this attempt.
	const scoutDetail = deps.scoutActivity !== undefined ? { detail: deps.scoutActivity } : {};
	const restoredScout = marker.workers?.find((worker) => worker.role === "scout");
	if (deps.interruptScout && (!restoredScout || interruptionRetryable(asWorkerState(restoredScout)))) {
		const plan = planWorkerInterruption(deps.capabilities, { hasUnresolvedRequest: true });
		if (!plan.attempt) {
			applyWorkers(marker, { role: "scout", delivery: plan.delivery, ...scoutDetail });
		} else {
			const scoutKey = `${run.runId}:scout`;
			const live = !deps.flights.has(scoutKey);
			let flight = live ? deps.interruptScout()! : (deps.flights.get(scoutKey) as StopWorkerFlight)!;
			let reportedPending = false;
			if (live) {
				deps.flights.set(scoutKey, flight);
				// The follower cleans the registry and catches the per-worker
				// record up when the interruption settles, even if this call
				// already returned reporting requested.
				void flight.then((result) => {
					deps.flights.delete(scoutKey);
					if (reportedPending && marker.workers?.find((worker) => worker.role === "scout")?.delivery === "requested") {
						applyWorkers(marker, result.state === "failed"
							? { role: "scout", delivery: "failed", ...(result.error !== undefined ? { error: result.error } : {}) }
							: { role: "scout", delivery: "delivered", ...(result.terminal !== undefined ? { terminal: result.terminal } : {}) });
						void deps.persist().catch(() => {});
					}
				});
			}
			const outcome = await new Promise<"settled" | "timeout">((resolve) => {
				const timer = setTimeout(() => resolve("timeout"), deps.abortTimeoutMs ?? 1500);
				void flight.then(() => { clearTimeout(timer); resolve("settled"); });
			});
			if (outcome === "settled") {
				const result = await flight;
				if (result.state === "failed") applyWorkers(marker, { role: "scout", delivery: "failed", ...(result.error !== undefined ? { error: result.error } : {}), ...scoutDetail });
				else applyWorkers(marker, { role: "scout", delivery: "delivered", ...(result.terminal !== undefined ? { terminal: result.terminal } : {}), ...scoutDetail });
			} else {
				reportedPending = true;
				applyWorkers(marker, { role: "scout", delivery: "requested", ...scoutDetail });
			}
			await writeMarker();
		}
	}
	const abort: StopOutcome["abort"] = marker.abort ?? "skipped";
	const workers = [
		executorWorkerRecord(marker, abortError),
		...(marker.workers?.filter((worker) => worker.role === "scout") ?? []),
	];
	return {
		text: stopRecap(deps, run, abort, abortError, persisted, fresh, workers),
		stopped: true,
		abort,
		workers: workers.map(asWorkerState),
		...(abortError !== undefined ? { error: abortError } : {}),
		persisted,
	};
}

/** Compose a fresh executor record from the single delivery source on the
 * marker: the legacy `abort` field. "pending" stays a "requested" delivery
 * — an in-flight or restored operation, not a settlement; an absent abort
 * with no live executor turn reads as never-submitted. */
function executorWorkerRecord(marker: NonNullable<FusionRun["stopped"]>, abortError?: string): FusionStopWorker {
	const delivery: FusionStopWorker["delivery"] = marker.abort === "delivered" ? "delivered" : marker.abort === "failed" ? "failed" : marker.abort === "pending" ? "requested" : "not-submitted";
	return { role: "executor", delivery, ...(abortError !== undefined ? { error: abortError } : {}) };
}

function stopRecap(deps: StopDeps, run: FusionRun, abort: StopOutcome["abort"], detail?: string, persisted = true, fresh = true, workers: FusionStopWorker[] = []): string {
	const lines = [
		`Fusion executor stopped (run ${run.runId}, task "${shortTask(run.task)}")${fresh ? "." : `; already stopped at ${run.stopped?.at}.`}`,
		`Executor: ${deps.executorLabel} on the ${run.backend ?? deps.backend ?? "session"} backend. Last observed: ${deps.activity ?? "no executor activity was observed"}.`,
	];
	if (run.pending) lines.push(`Pending request: ${run.pending.action}:${run.pending.requestId}${deps.uncertain ? " (outcome uncertain)" : ""}.`);
	lines.push(`Revisions used: ${run.revisions}/3${run.finalFixUsed ? ", final fix used" : ""}.`);
	if (abort === "delivered") lines.push("Abort: delivered to the live executor conversation; termination is not independently verified.");
	else if (abort === "failed") lines.push(`Abort failed: ${detail ?? "interruption unavailable"}. Termination is not confirmed.`);
	else if (abort === "pending") lines.push("Abort: pending (the bounded stop wait elapsed without delivery); termination is not confirmed. The stop record updates when the abort settles.");
	else lines.push("Abort: no executor turn was known to be running. A durable submission left by a crash keeps running until /fusion-resume attaches to it (or /fusion-resolve resolves ownership).");
	for (const worker of workers.filter((worker) => worker.role === "scout")) lines.push(describeStopWorker(asWorkerState(worker)));
	if (!persisted) lines.push("The stop marker could not be written to the run record; it is held in this session only. Verify saved status before recovery.");
	if (deps.transcriptTail.length > 0) lines.push(`Recent executor progress:\n${deps.transcriptTail.map((entry) => `- ${entry}`).join("\n")}`);
	lines.push("Partial edits are preserved in the working tree. Inspect the changes, then recover with /fusion-resume or resolve with /fusion-resolve; /fusion-clean releases the run. No further executor or scout work will run for this run.");
	return lines.join("\n");
}

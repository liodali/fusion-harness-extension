import { describe, expect, test } from "bun:test";
import type { FusionRun } from "../src/runs.ts";
import { STOPPED_RUN_REFUSAL, stopFusionRun, type StopDeps } from "../src/pi/run-stop.ts";

function makeRun(overrides: Partial<FusionRun> = {}): FusionRun {
	return {
		runId: "run-1",
		cwd: "/repo",
		task: "implement the fixture and verify it with checks",
		brief: "executor brief",
		executor: { provider: "prov", modelId: "model", label: "prov/model", thinking: "off" },
		status: "running",
		revisions: 1,
		finalFixUsed: false,
		results: {},
		updatedAt: "2026-11-04T00:00:00.000Z",
		...overrides,
	};
}

function makeDeps(overrides: Partial<StopDeps> & { activeRun?: FusionRun } = {}): StopDeps & { persisted: string[] } {
	const persisted: string[] = [];
	return {
		persisted,
		activeRun: makeRun(),
		uncertain: false,
		capabilities: { transcriptReopen: true, activeTurnReattach: false, durableExecution: false, idempotentSubmission: false, workerAbort: true, workerEvents: true, readOnlyScout: true, exactScoutToolLimit: false },
		abortExecutor: async () => {},
		flights: new Map(),
		executorLabel: "prov/model",
		backend: "durable",
		activity: "running edit",
		transcriptTail: ["[execute] Executor started", "[tool] edit file.ts"],
		persist: async () => { persisted.push("write"); },
		now: () => new Date("2026-11-04T12:00:00.000Z"),
		...overrides,
		// Keep the capture even when persist is overridden.
		...(overrides.persist ? {} : {}),
	};
}

describe("stopFusionRun", () => {
	test("no active run reports honestly and changes nothing", async () => {
		const deps = makeDeps({ activeRun: undefined });
		const outcome = await stopFusionRun(deps);
		expect(outcome).toMatchObject({ stopped: false, abort: "skipped", persisted: false });
		expect(outcome.text).toBe("No Fusion run is active; nothing to stop.");
	});

	test("marks the run stopped, persists it, and delivers a deterministic recap without a live turn", async () => {
		const run = makeRun({ pending: { action: "revise", requestId: "req-9" } });
		const deps = makeDeps({ activeRun: run, uncertain: false });
		const outcome = await stopFusionRun(deps, "User asked to stop");
		expect(outcome.stopped).toBe(true);
		// No uncertain turn: nothing to abort, and that is reported as such.
		expect(outcome.abort).toBe("skipped");
		expect(run.stopped).toEqual({
			at: "2026-11-04T12:00:00.000Z",
			reason: "User asked to stop",
			workers: [{ role: "executor", delivery: "not-submitted" }],
		});
		expect(run.updatedAt).toBe("2026-11-04T12:00:00.000Z");
		expect(deps.persisted).toEqual(["write"]);
		expect(outcome.text).toContain("run run-1");
		expect(outcome.text).toContain("implement the fixture and verify it with checks");
		expect(outcome.text).toContain("Executor: prov/model on the durable backend");
		expect(outcome.text).toContain("Last observed: running edit");
		expect(outcome.text).toContain("Pending request: revise:req-9")
		expect(outcome.text).toContain("Revisions used: 1/3");
		expect(outcome.text).toContain("no executor turn was known to be running")
		expect(outcome.text).toContain("- [execute] Executor started")
		expect(outcome.text).toContain("Partial edits are preserved")
		expect(outcome.text).toContain("No further executor or scout work will run for this run.")
	});

	test("an uncertain turn aborts the live executor and never overstates termination", async () => {
		const run = makeRun();
		const deps = makeDeps({ activeRun: run, uncertain: true });
		const outcome = await stopFusionRun(deps);
		expect(outcome.abort).toBe("delivered");
		expect(outcome.text).toContain("Abort: delivered to the live executor conversation; termination is not independently verified.")
		expect(run.stopped).toEqual({
			at: "2026-11-04T12:00:00.000Z",
			abort: "delivered",
			workers: [{ role: "executor", delivery: "delivered" }],
		});
	});

	test("a failed abort reports the failure honestly and still stops the run", async () => {
		const run = makeRun();
		const deps = makeDeps({ activeRun: run, uncertain: true, abortExecutor: async () => { throw new Error("harness unreachable"); } });
		const outcome = await stopFusionRun(deps);
		expect(outcome).toMatchObject({ stopped: true, abort: "failed", error: "harness unreachable" });
		expect(outcome.text).toContain("Abort failed: harness unreachable. Termination is not confirmed.")
	});

	test("a stopped run keeps its delivery and repeats only the marker write", async () => {
		const run = makeRun({ stopped: { at: "2026-11-04T11:00:00.000Z", abort: "delivered" } });
		let aborts = 0;
		const deps = makeDeps({ activeRun: run, uncertain: true, abortExecutor: async () => { aborts++; } });
		const outcome = await stopFusionRun(deps);
		expect(aborts).toBe(0);
		expect(outcome.abort).toBe("delivered");
		expect(outcome.text).toContain("already stopped at 2026-11-04T11:00:00.000Z")
		expect(run.stopped).toEqual({
			at: "2026-11-04T11:00:00.000Z",
			abort: "delivered",
			workers: [{ role: "executor", delivery: "delivered" }],
		});
		// The repeat still attempted the (idempotent) marker write.
		expect(deps.persisted).toEqual(["write"]);
	});

	test("a repeated stop retries a failed marker write and reports the real outcome", async () => {
		const run = makeRun();
		let failWrites = true;
		const deps = makeDeps({ activeRun: run, persist: async () => { if (failWrites) throw new Error("disk full"); } });
		const first = await stopFusionRun(deps);
		expect(first.persisted).toBe(false);
		expect(first.text).toContain("stop marker could not be written")
		// The reviewer's repro: a second call must not claim successful
		// persistence while the write still fails.
		const stillFailing = await stopFusionRun(deps);
		expect(stillFailing.stopped).toBe(true);
		expect(stillFailing.persisted).toBe(false);
		expect(stillFailing.text).toContain("stop marker could not be written")
		expect(stillFailing.text).toContain("already stopped at")
		// Once the write succeeds the warning is honestly gone.
		failWrites = false;
		const recovered = await stopFusionRun(deps);
		expect(recovered.persisted).toBe(true);
		expect(recovered.text).not.toContain("stop marker could not be written")
	});

	test("a repeated stop retries a failed abort delivery", async () => {
		const run = makeRun();
		let attempts = 0;
		const deps = makeDeps({
			activeRun: run, uncertain: true,
			abortExecutor: async () => { attempts++; if (attempts === 1) throw new Error("harness busy"); },
		});
		const first = await stopFusionRun(deps);
		expect(first.abort).toBe("failed");
		expect(first.text).toContain("Abort failed: harness busy.")
		const second = await stopFusionRun(deps);
		expect(attempts).toBe(2);
		expect(second.abort).toBe("delivered");
		expect(run.stopped?.abort).toBe("delivered");
	});

	test("a stalled abort cannot block the stop marker or the recap", async () => {
		const run = makeRun();
		let resolveAbort!: () => void;
		let markerAtCall: { at?: string } | undefined;
		const deps = makeDeps({
			activeRun: run, uncertain: true, abortTimeoutMs: 20,
			abortExecutor: () => { markerAtCall = run.stopped; return new Promise<void>((resolve) => { resolveAbort = resolve; }); },
		});
		const outcome = await stopFusionRun(deps);
		// The marker existed before the abort was awaited, and the recap
		// returned without the abort settling.
		expect(markerAtCall?.at).toBe("2026-11-04T12:00:00.000Z");
		expect(run.stopped?.abort).toBe("pending");
		expect(outcome).toMatchObject({ stopped: true, abort: "pending", persisted: true });
		expect(outcome.text).toContain("Abort: pending (the bounded stop wait elapsed without delivery)")
		expect(outcome.text).not.toContain("stop marker could not be written")
		// When the abort finally settles, the marker and record catch up.
		resolveAbort();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(run.stopped?.abort).toBe("delivered");
		expect(deps.persisted.length).toBe(3);
	});

	test("a pending abort is not started twice by a repeated stop", async () => {
		const run = makeRun();
		let aborts = 0;
		const deps = makeDeps({ activeRun: run, uncertain: true, abortTimeoutMs: 20, abortExecutor: async () => { aborts++; await new Promise<void>(() => {}); } });
		await stopFusionRun(deps);
		await stopFusionRun(deps);
		expect(aborts).toBe(1);
		expect(run.stopped?.abort).toBe("pending");
	});

	test("a restored pending marker is retried after restart, not mistaken for a live abort", async () => {
		// The reviewer's repro: the marker says pending, but the operation and
		// its follower died with the previous session — a fresh flights map is
		// the restart state. Repeated stops must send a new abort.
		const run = makeRun({ stopped: { at: "2026-11-04T11:00:00.000Z", abort: "pending" } });
		let aborts = 0;
		const deps = makeDeps({ activeRun: run, uncertain: true, abortExecutor: async () => { aborts++; } });
		const outcome = await stopFusionRun(deps);
		expect(aborts).toBe(1);
		expect(outcome.abort).toBe("delivered");
		expect(run.stopped?.abort).toBe("delivered");
		expect(outcome.text).toContain("Abort: delivered")
		// The retry outcome is persisted, and the live flight is cleaned up.
		expect(deps.flights.has(run.runId)).toBe(false);
		const again = await stopFusionRun(deps);
		expect(again.abort).toBe("delivered");
		expect(aborts).toBe(1);
	});

	test("a live flight is awaited, not re-sent, and settles the marker", async () => {
		const run = makeRun();
		let resolveAbort!: () => void;
		let aborts = 0;
		const deps = makeDeps({
			activeRun: run, uncertain: true, abortTimeoutMs: 500,
			abortExecutor: () => { aborts++; return new Promise<void>((resolve) => { resolveAbort = resolve; }); },
		});
		const first = stopFusionRun(deps);
		// Wait for the flight to actually start before settling it.
		for (let i = 0; i < 500 && aborts === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
		resolveAbort();
		await first;
		expect(run.stopped?.abort).toBe("delivered");
		// The settled flight is gone; a later stop sees the proven delivery.
		expect(deps.flights.has(run.runId)).toBe(false);
		const second = await stopFusionRun(deps);
		expect(aborts).toBe(1);
		expect(second.abort).toBe("delivered");
		expect(second.text).toContain("already stopped at")
	});

	test("a stalled marker write cannot block the recap either", async () => {
		const run = makeRun();
		const deps = makeDeps({ activeRun: run, persistTimeoutMs: 20, persist: () => new Promise<void>(() => {}) });
		const outcome = await stopFusionRun(deps);
		expect(outcome.stopped).toBe(true);
		expect(outcome.persisted).toBe(false);
		expect(run.stopped).toBeTruthy();
		expect(outcome.text).toContain("stop marker could not be written")
	});

	test("a failed marker write keeps the in-memory stop and warns in the recap", async () => {
		const run = makeRun();
		const deps = makeDeps({ activeRun: run, persist: async () => { throw new Error("disk full"); } });
		const outcome = await stopFusionRun(deps);
		expect(outcome.stopped).toBe(true);
		expect(outcome.persisted).toBe(false);
		expect(run.stopped).toBeTruthy();
		expect(outcome.text).toContain("stop marker could not be written")
		expect(outcome.text).toContain("Verify saved status before recovery.")
	});

	test("a live scout is interrupted in scope with its confirmed terminal outcome", async () => {
		const run = makeRun();
		const deps = makeDeps({
			activeRun: run,
			interruptScout: async () => ({ state: "delivered", terminal: "cancelled" }),
			scoutActivity: "running read src/index.ts",
		});
		const outcome = await stopFusionRun(deps);
		expect(outcome.workers).toEqual([
			{ role: "executor", delivery: "not-submitted", termination: { proof: "unconfirmed" } },
			{ role: "scout", delivery: "delivered", termination: { proof: "ended", terminal: "cancelled" }, detail: "running read src/index.ts" },
		]);
		expect(run.stopped?.workers).toEqual([
			{ role: "executor", delivery: "not-submitted" },
			{ role: "scout", delivery: "delivered", terminal: "cancelled", detail: "running read src/index.ts" },
		]);
		// Termination can be claimed for an in-process scout turn, unlike the
		// executor's delivery-only reporting.
		expect(outcome.text).toContain("Scout turn stopped (cancelled); its submission has ended.");
		// The settled flight is cleaned from the session registry.
		expect(deps.flights.has(`${run.runId}:scout`)).toBe(false);
	});

	test("a scout interruption that fails is reported while the executor is still attempted", async () => {
		const run = makeRun();
		const deps = makeDeps({
			activeRun: run, uncertain: true,
			abortExecutor: async () => { throw new Error("harness unreachable"); },
			interruptScout: async () => ({ state: "failed", error: "scout session lost" }),
		});
		const outcome = await stopFusionRun(deps);
		expect(outcome.abort).toBe("failed");
		// Every worker's interruption stood on its own.
		expect(outcome.workers).toEqual([
			{ role: "executor", delivery: "failed", termination: { proof: "unconfirmed" }, error: "harness unreachable" },
			{ role: "scout", delivery: "failed", termination: { proof: "unconfirmed" }, error: "scout session lost" },
		]);
		expect(outcome.text).toContain("Abort failed: harness unreachable. Termination is not confirmed.")
		expect(outcome.text).toContain("Scout stop failed: scout session lost. Termination is not confirmed.")
		// A repeated stop retries both failed deliveries to their proven ends.
		const second = await stopFusionRun(makeDeps({ activeRun: run, uncertain: true, interruptScout: async () => ({ state: "delivered", terminal: "cancelled" }) }));
		expect(second.abort).toBe("delivered");
		expect(second.text).toContain("Scout turn stopped (cancelled); its submission has ended.");
		expect(run.stopped?.workers).toEqual([
			{ role: "executor", delivery: "delivered" },
			{ role: "scout", delivery: "delivered", terminal: "cancelled" },
		]);
	});

	test("a delivered scout delivery is not retried by a repeated stop", async () => {
		const run = makeRun({
			stopped: { at: "2026-11-04T11:00:00.000Z", abort: "delivered", workers: [{ role: "executor", delivery: "delivered" }, { role: "scout", delivery: "delivered" }] },
		});
		let scoutAttempts = 0;
		const deps = makeDeps({ activeRun: run, uncertain: false, interruptScout: async () => { scoutAttempts++; return { state: "delivered" }; } });
		const outcome = await stopFusionRun(deps);
		expect(scoutAttempts).toBe(0);
		expect(outcome.workers.find((worker) => worker.role === "scout")).toMatchObject({ delivery: "delivered", termination: { proof: "unconfirmed" } });
		expect(outcome.text).toContain("Scout interruption delivered; termination is not confirmed.");
	});

	test("a restored scout delivery is reported after restart and retried with a live scout", async () => {
		const run = makeRun({
			stopped: { at: "2026-11-04T11:00:00.000Z", abort: "delivered", workers: [{ role: "executor", delivery: "delivered" }, { role: "scout", delivery: "requested" }] },
		});
		// No live scout in this session: the record is reported as-is.
		const outcome = await stopFusionRun(makeDeps({ activeRun: run, uncertain: false }));
		expect(outcome.workers.find((worker) => worker.role === "scout")).toMatchObject({ delivery: "requested", termination: { proof: "unconfirmed" } });
		expect(outcome.text).toContain("Scout interruption requested; termination is not confirmed.");
		// A live scout in a later stop retries the restored delivery.
		const second = await stopFusionRun(makeDeps({ activeRun: run, uncertain: false, interruptScout: async () => ({ state: "delivered", terminal: "cancelled" }) }));
		expect(second.workers.find((worker) => worker.role === "scout")).toMatchObject({ delivery: "delivered", termination: { proof: "ended", terminal: "cancelled" } });
		expect(run.stopped?.workers?.find((worker) => worker.role === "scout")?.terminal).toBe("cancelled");
	});

	test("a scout on a runtime without workerAbort reports unsupported instead of a silent no-op", async () => {
		const run = makeRun();
		const deps = makeDeps({
			activeRun: run,
			capabilities: { transcriptReopen: true, activeTurnReattach: false, durableExecution: false, idempotentSubmission: false, workerAbort: false, workerEvents: true, readOnlyScout: true, exactScoutToolLimit: false },
			interruptScout: async () => { throw new Error("must not attempt the interruption"); },
		});
		const outcome = await stopFusionRun(deps);
		expect(outcome.workers.find((worker) => worker.role === "scout")).toMatchObject({ delivery: "unsupported", termination: { proof: "unconfirmed" } });
		expect(outcome.text).toContain("Scout stop is unsupported: this runtime cannot interrupt workers. Termination is not confirmed.")
		expect(run.stopped?.workers?.find((worker) => worker.role === "scout")?.delivery).toBe("unsupported");
	});

	test("the shared refusal names the recovery path", () => {
		expect(STOPPED_RUN_REFUSAL).toContain("/fusion-resume")
		expect(STOPPED_RUN_REFUSAL).toContain("/fusion-clean")
	});

	test("a long task and reason are truncated for a bounded recap", async () => {
		const run = makeRun({ task: "x".repeat(120) });
		const deps = makeDeps({ activeRun: run });
		const outcome = await stopFusionRun(deps, "r".repeat(120));
		expect(outcome.text).toContain(`task "${"x".repeat(77)}..."`)
		expect(run.stopped?.reason).toBe(`${"r".repeat(77)}...`)
	});
});

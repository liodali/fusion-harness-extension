import { describe, expect, test } from "bun:test";
import {
	describeStopWorker,
	interruptionRetryable,
	isExecutionObservation,
	openCodeStopToIntent,
	type OpenCodeStopShape,
	piStopMarkerToIntent,
	type PiStopMarkerShape,
	planInterruptionDelivery,
	planWorkerInterruption,
	readRunControlPolicy,
	readRunStopIntent,
	type StopWorkerState,
	stopAppliesToRequest,
	stopBlocksAdmission,
	terminationProved,
	type WorkerTermination,
} from "../src/core/run-control.ts";
import { PI_DURABLE_CAPABILITIES } from "../src/pi/durable/backend.ts";
import type { WorkerOwner } from "../src/core/worker.ts";

const owner: WorkerOwner = { harness: "pi", supervisorId: "supervisor", workspace: "/workspace" };
const opencodeOwner: WorkerOwner = { harness: "opencode", supervisorId: "parent", workspace: "/workspace" };
const durable = { ...PI_DURABLE_CAPABILITIES };
const noAbort = { ...PI_DURABLE_CAPABILITIES, workerAbort: false };

const unconfirmed = (): WorkerTermination => ({ proof: "unconfirmed" });

describe("stop intent records", () => {
	const intent = {
		version: 1 as const,
		runId: "run-1",
		owner,
		requestedAt: "2026-11-09T10:00:00.000Z",
		reason: { kind: "operator" as const, detail: "user asked" },
		workers: [{ role: "executor" as const, requestId: "req-1", delivery: "requested" as const, termination: unconfirmed() }],
	};

	test("absent reads as no intent; a valid record round-trips", () => {
		expect(readRunStopIntent(undefined)).toBeUndefined();
		expect(readRunStopIntent(null)).toBeUndefined();
		const read = readRunStopIntent(JSON.parse(JSON.stringify(intent)));
		expect(read).toEqual(intent);
	});

	test("additive fields are preserved unvalidated", () => {
		const read = readRunStopIntent({ ...intent, futureField: { nested: true }, workers: [{ ...intent.workers[0], future: "x" }] });
		const extras = read as unknown as Record<string, unknown>;
		expect(read).toMatchObject(intent);
		expect(extras.futureField).toEqual({ nested: true });
		expect((extras.workers as unknown as Record<string, unknown>[])[0].future).toBe("x");
	});

	test("a present but malformed record throws instead of lifting the stop", () => {
		expect(() => readRunStopIntent({ ...intent, version: 2 })).toThrow("Unsupported");
		expect(() => readRunStopIntent({ ...intent, version: 1, workers: [] })).toThrow("Invalid");
		expect(() => readRunStopIntent({ ...intent, runId: "" })).toThrow("Invalid");
		expect(() => readRunStopIntent({ ...intent, requestedAt: "not-a-date" })).toThrow("Invalid");
		expect(() => readRunStopIntent({ ...intent, reason: { kind: "mystery" } })).toThrow("Invalid");
		expect(() => readRunStopIntent({ ...intent, workers: [{ ...intent.workers[0], delivery: "vanished" }] })).toThrow("Invalid");
		expect(() => readRunStopIntent({ ...intent, workers: [{ ...intent.workers[0], termination: { proof: "guess" } }] })).toThrow("Invalid");
		expect(() => readRunStopIntent("stopped")).toThrow("Unsupported");
	});

	test("worker references owned by a foreign owner are rejected", () => {
		const reference = { owner: { ...owner, supervisorId: "other-supervisor", workspace: "/other" }, runtime: "durable", id: "42" };
		expect(() => readRunStopIntent({ ...intent, workers: [{ ...intent.workers[0], reference }] })).toThrow("Invalid");
		expect(() => readRunStopIntent({ ...intent, workers: [{ ...intent.workers[0], reference: { ...reference, owner: { ...owner, harness: "opencode" } } }] })).toThrow("Invalid");
		expect(() => readRunStopIntent({ ...intent, workers: [{ ...intent.workers[0], reference: { ...reference, owner: { ...owner, workspace: "/elsewhere" } } }] })).toThrow("Invalid");
		expect(readRunStopIntent({ ...intent, workers: [{ ...intent.workers[0], reference: { ...reference, owner } }] })).toBeDefined();
	});

	test("any recorded stop blocks admitting more work", () => {
		expect(stopBlocksAdmission(undefined)).toBe(false);
		expect(stopBlocksAdmission(readRunStopIntent(intent))).toBe(true);
	});
});

describe("legacy Pi stop markers map into the contract", () => {
	const cases: Array<[PiStopMarkerShape["abort"] | undefined, "requested" | "delivered" | "failed" | "not-submitted"]> = [
		["delivered", "delivered"],
		["failed", "failed"],
		["pending", "requested"],
		// Absent abort with a pending request (older marker, or a crash
		// between the marker write and the abort attempt) is unknown
		// delivery — retryable, never non-submission.
		[undefined, "requested"],
	];
	for (const [abort, delivery] of cases) {
		test(`abort ${abort ?? "absent"} with a pending request reads as ${delivery} with termination unconfirmed`, () => {
			const marker: PiStopMarkerShape = { at: "2026-11-09T10:00:00.000Z", ...(abort ? { abort } : {}), ...(abort ? { reason: "operator stop" } : {}) };
			const intent = piStopMarkerToIntent(owner, { runId: "run-1", requestId: "req-1", runtime: "durable", workerId: "42", marker });
			expect(intent.workers[0].delivery).toBe(delivery);
			expect(intent.workers[0].termination).toEqual({ proof: "unconfirmed" });
			expect(interruptionRetryable(intent.workers[0])).toBe(delivery === "requested" || delivery === "failed");
			expect(intent.reason.kind).toBe("operator");
			expect(intent.requestedAt).toBe(marker.at);
			expect(intent.workers[0].reference).toEqual({ owner, runtime: "durable", id: "42" });
		});
	}

	test("absent abort with a pending request and worker reference stays retryable", () => {
		// The reviewer's repro: pending request plus worker reference must
		// not map to a non-retryable not-submitted delivery.
		const intent = piStopMarkerToIntent(owner, {
			runId: "run-1", requestId: "req-1", runtime: "durable", workerId: "42",
			marker: { at: "2026-11-09T10:00:00.000Z" },
		});
		expect(intent.workers[0].delivery).toBe("requested");
		expect(interruptionRetryable(intent.workers[0])).toBe(true);
	});

	test("a marker without pending identity or worker identity still maps as not-submitted", () => {
		const intent = piStopMarkerToIntent(owner, { runId: "run-1", marker: { at: "2026-11-09T10:00:00.000Z" } });
		expect(intent.workers[0].requestId).toBeUndefined();
		expect(intent.workers[0].reference).toBeUndefined();
		expect(intent.workers[0].delivery).toBe("not-submitted");
		expect(interruptionRetryable(intent.workers[0])).toBe(false);
		expect(readRunStopIntent(intent)).toEqual(intent);
	});
});

describe("legacy OpenCode stop records map into the contract", () => {
	const base: OpenCodeStopShape = { requestId: "req-9", requestedAt: Date.parse("2026-11-09T10:00:00.000Z"), updatedAt: Date.parse("2026-11-09T10:00:01.000Z"), state: "requested", reason: "user asked" };

	test("every legacy state maps to a delivery without inventing termination", () => {
		expect(openCodeStopToIntent(opencodeOwner, { ...base, state: "requested" }, { runId: "r" }).workers[0].delivery).toBe("requested");
		expect(openCodeStopToIntent(opencodeOwner, { ...base, state: "acknowledged" }, { runId: "r" }).workers[0].delivery).toBe("delivered");
		expect(openCodeStopToIntent(opencodeOwner, { ...base, state: "failed", error: "no handle" }, { runId: "r" }).workers[0]).toMatchObject({ delivery: "failed", error: "no handle" });
		expect(openCodeStopToIntent(opencodeOwner, { ...base, state: "not-submitted" }, { runId: "r" }).workers[0].delivery).toBe("not-submitted");
		for (const state of ["requested", "acknowledged", "failed", "not-submitted"] as const) {
			expect(openCodeStopToIntent(opencodeOwner, { ...base, state }, { runId: "r" }).workers[0].termination).toEqual({ proof: "unconfirmed" });
		}
	});

	test("confirmation proves termination only with a terminal outcome", () => {
		const ended = openCodeStopToIntent(opencodeOwner, { ...base, state: "confirmed", terminal: "cancelled", childSessionID: "child-1" }, { runId: "r" });
		expect(ended.workers[0].termination).toEqual({ proof: "ended", terminal: "cancelled" });
		expect(ended.workers[0].reference).toEqual({ owner: opencodeOwner, runtime: "native-subagent", id: "child-1" });
		const claimed = openCodeStopToIntent(opencodeOwner, { ...base, state: "confirmed" }, { runId: "r" });
		expect(claimed.workers[0].termination).toEqual({ proof: "unconfirmed" });
	});
});

describe("delivery never implies termination", () => {
	for (const delivery of ["requested", "delivered", "failed", "unsupported", "not-submitted"] as const) {
		test(`${delivery} without terminal proof leaves termination unproved and blocks admission`, () => {
			const intent = readRunStopIntent({
				version: 1, runId: "run-1", owner, requestedAt: "2026-11-09T10:00:00.000Z", reason: { kind: "operator" },
				workers: [{ role: "executor", delivery, termination: { proof: "unconfirmed" } }],
			})!;
			expect(terminationProved(intent.workers[0])).toBe(false);
			expect(stopBlocksAdmission(intent)).toBe(true);
		});
	}

	test("only terminal proof terminates", () => {
		for (const terminal of ["completed", "error", "cancelled"] as const) {
			const intent = readRunStopIntent({
				version: 1, runId: "run-1", owner, requestedAt: "2026-11-09T10:00:00.000Z", reason: { kind: "operator" },
				workers: [{ role: "executor", delivery: "delivered", termination: { proof: "ended", terminal } }],
			})!;
			expect(terminationProved(intent.workers[0])).toBe(true);
		}
	});
});

describe("restart does not resurrect an operation", () => {
	const saved = {
		version: 1 as const,
		runId: "run-1",
		owner,
		requestedAt: "2026-11-09T10:00:00.000Z",
		reason: { kind: "operator" as const },
		workers: [{ role: "executor" as const, requestId: "req-1", delivery: "requested" as const, termination: unconfirmed() }],
	};

	test("a restored requested delivery is retryable, not proof of a live abort", () => {
		// The record crosses a restart: JSON round-trip, no process state.
		const restored = readRunStopIntent(JSON.parse(JSON.stringify(saved)))!;
		const worker = restored.workers[0];
		expect(terminationProved(worker)).toBe(false);
		expect(interruptionRetryable(worker)).toBe(true);
		expect(stopBlocksAdmission(restored)).toBe(true);
	});

	test("delivered, settled, and never-submitted workers are not retried", () => {
		expect(interruptionRetryable({ role: "executor", delivery: "delivered", termination: unconfirmed() })).toBe(false);
		expect(interruptionRetryable({ role: "executor", delivery: "not-submitted", termination: unconfirmed() })).toBe(false);
		expect(interruptionRetryable({ role: "executor", delivery: "unsupported", termination: unconfirmed() })).toBe(false);
		expect(interruptionRetryable({ role: "executor", delivery: "requested", termination: { proof: "ended", terminal: "cancelled" } })).toBe(false);
		expect(interruptionRetryable({ role: "scout", delivery: "failed", termination: unconfirmed() })).toBe(true);
	});
});

describe("stop scope is decided per worker by the shared rule", () => {
	test("a worker with no unresolved request reads as not-submitted and is never attempted", () => {
		expect(planWorkerInterruption(durable, { hasUnresolvedRequest: false })).toEqual({ attempt: false, delivery: "not-submitted" });
		expect(planWorkerInterruption(noAbort, { hasUnresolvedRequest: false })).toEqual({ attempt: false, delivery: "not-submitted" });
	});

	test("a live worker on a runtime without workerAbort plans unsupported", () => {
		expect(planWorkerInterruption(noAbort, { hasUnresolvedRequest: true })).toEqual({ attempt: false, delivery: "unsupported" });
	});

	test("a live worker on an abort-capable runtime is attempted as requested", () => {
		expect(planWorkerInterruption(durable, { hasUnresolvedRequest: true })).toEqual({ attempt: true, delivery: "requested" });
		const session = { ...PI_DURABLE_CAPABILITIES, workerAbort: false };
		expect(planWorkerInterruption(session, { hasUnresolvedRequest: true })).toEqual({ attempt: false, delivery: "unsupported" });
	});
});

describe("per-worker stop lines", () => {
	test("terminal proof is the only wording that claims a turn ended", () => {
		for (const [worker, expected] of [
			[{ role: "scout", delivery: "delivered" as const, termination: { proof: "ended" as const, terminal: "cancelled" as const } }, "Scout turn stopped (cancelled); its submission has ended."],
			[{ role: "executor", delivery: "requested" as const, termination: { proof: "ended" as const, terminal: "completed" as const } }, "Executor completed before interruption; its turn has ended."],
			[{ role: "scout", delivery: "requested" as const, termination: { proof: "ended" as const, terminal: "error" as const }, error: "provider down" }, "Scout ended with an error: provider down."],
			[{ role: "scout", delivery: "failed" as const, termination: { proof: "ended" as const, terminal: "error" as const } }, "Scout ended with an error; its turn has ended."],
		] as Array<[StopWorkerState, string]>) {
			expect(describeStopWorker(worker)).toBe(expected);
		}
	});

	test("requested wording distinguishes a sent attempt from a delivery queued behind a missing child reference", () => {
		expect(describeStopWorker({ role: "executor", delivery: "requested", termination: unconfirmed(), awaitingReference: true })).toBe("Executor stop queued; waiting for its child reference. Termination is not confirmed yet.");
		expect(describeStopWorker({ role: "scout", delivery: "requested", termination: unconfirmed(), awaitingReference: false })).toBe("Scout interruption requested; termination is not confirmed.");
	});

	test("delivery wording distinguishes delivered, requested-with-reference, waiting-for-reference, failed, unsupported, and not-submitted", () => {
		const owner: WorkerOwner = { harness: "opencode", supervisorId: "parent", workspace: "/workspace" };
		expect(describeStopWorker({ role: "executor", delivery: "delivered", termination: unconfirmed() })).toBe("Executor interruption delivered; termination is not confirmed.");
		expect(describeStopWorker({ role: "scout", delivery: "requested", termination: unconfirmed(), reference: { owner, runtime: "native-subagent", id: "child-7" } })).toBe("Scout interruption requested; termination is not confirmed.");
		// Absent awaitingReference means the attempt itself was sent (see the
		// contract comment); only an explicit true reads as queued.
		expect(describeStopWorker({ role: "scout", delivery: "requested", termination: unconfirmed(), awaitingReference: true })).toBe("Scout stop queued; waiting for its child reference. Termination is not confirmed yet.");
		expect(describeStopWorker({ role: "scout", delivery: "failed", termination: unconfirmed() })).toBe("Scout stop failed: interruption unavailable. Termination is not confirmed.");
		expect(describeStopWorker({ role: "scout", delivery: "unsupported", termination: unconfirmed() })).toBe("Scout stop is unsupported: this runtime cannot interrupt workers. Termination is not confirmed.");
		expect(describeStopWorker({ role: "executor", delivery: "not-submitted", termination: unconfirmed() })).toBe("Executor stopped before submission; no worker turn was running.");
	});
});

describe("capabilities and request matching", () => {
	test("a runtime without workerAbort plans unsupported, never a silent no-op", () => {
		expect(planInterruptionDelivery(durable)).toBe("requested");
		expect(planInterruptionDelivery(noAbort)).toBe("unsupported");
	});

	test("a stop applies to its recorded request identity", () => {
		const intent = piStopMarkerToIntent(owner, { runId: "run-1", requestId: "req-1", marker: { at: "2026-11-09T10:00:00.000Z" } });
		expect(stopAppliesToRequest(intent, "req-1")).toBe(true);
		expect(stopAppliesToRequest(intent, "req-other")).toBe(false);
	});
});

describe("execution observations", () => {
	test("only defined observations validate; everything else is unknown", () => {
		for (const observation of ["starting", "implementing", "checking", "waiting-permission", "waiting-user", "awaiting-reconciliation", "unknown"]) {
			expect(isExecutionObservation(observation)).toBe(true);
		}
		expect(isExecutionObservation("waiting")).toBe(false);
		expect(isExecutionObservation("finished")).toBe(false);
		expect(isExecutionObservation(undefined)).toBe(false);
	});
});

describe("run control policies", () => {
	test("absent policy preserves existing behavior", () => {
		expect(readRunControlPolicy(undefined)).toBeUndefined();
		expect(readRunControlPolicy(null)).toBeUndefined();
	});

	test("valid limits round-trip and additive fields are preserved", () => {
		const policy = { version: 1 as const, activeTimeLimitMs: 3600_000, observedCostLimit: 5, providerTokenCeilings: { "zai": 1_000_000 }, future: true };
		expect(readRunControlPolicy(policy)).toEqual(policy);
	});

	test("a present but malformed policy throws instead of lifting limits", () => {
		expect(() => readRunControlPolicy({ version: 2 })).toThrow("Unsupported");
		expect(() => readRunControlPolicy({ version: 1, activeTimeLimitMs: 0 })).toThrow("Invalid");
		expect(() => readRunControlPolicy({ version: 1, observedCostLimit: -1 })).toThrow("Invalid");
		expect(() => readRunControlPolicy({ version: 1, providerTokenCeilings: { "zai": 0 } })).toThrow("Invalid");
		expect(() => readRunControlPolicy({ version: 1, providerTokenCeilings: { "": 10 } })).toThrow("Invalid");
		expect(() => readRunControlPolicy({ version: 1, providerTokenCeilings: [] as unknown as Record<string, number> })).toThrow("Invalid");
	});
});

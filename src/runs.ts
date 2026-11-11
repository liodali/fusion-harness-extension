import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { RunBudget } from "./core/budget.ts";
import type { FusionRunMetrics } from "./metrics.ts";
import type { RunManifest } from "./core/manifest.ts";
import type { RunControlPolicy } from "./core/run-control.ts";

export type FusionRunStatus = "running" | "done" | "failed" | "interrupted";

/** One affected worker inside a persisted stop marker: the run-scope record
 * additive to the legacy executor-only `abort` field (which stays mirrored
 * here for existing Pi tooling). */
export interface FusionStopWorker {
	role: "executor" | "scout";
	delivery: "requested" | "delivered" | "failed" | "unsupported" | "not-submitted";
	terminal?: "completed" | "error" | "cancelled";
	error?: string;
	detail?: string;
}

export interface FusionRunExecutor {
	provider: string;
	modelId: string;
	label: string;
	thinking: ThinkingLevel;
}

export interface FusionRun {
	/** Shared recovery record; legacy fields remain readable by existing Pi tooling. */
	manifest?: RunManifest;
	runId: string;
	cwd: string;
	task: string;
	brief: string;
	originalTask?: string;
	executor: FusionRunExecutor;
	sessionFile?: string;
	backend?: "session" | "durable";
	conversationId?: number;
	/** Write-ahead identity of the last unsettled executor submission. */
	pending?: { action: "execute" | "revise" | "final_fix"; requestId: string };
	/** Set when the supervisor stopped the run; refuses further executor and
	 * scout work until recovery or cleanup. `abort` records delivery: a
	 * pending abort is still in flight and the marker catches up when it
	 * settles; a failed delivery is retried by a repeated stop. `workers`
	 * records every owned worker in stop scope (executor, scouts) with its
	 * own delivery and confirmed terminal outcome; unknown extra fields stay
	 * readable. `kind` distinguishes an operator stop from a policy stop
	 * (a run time/cost limit was reached); absent reads as operator. */
	stopped?: { at: string; reason?: string; abort?: "delivered" | "failed" | "pending"; workers?: FusionStopWorker[]; kind?: "operator" | "policy" };
	manualResolution?: { at: string };
	metrics?: FusionRunMetrics;
	/** Configured run limits (R2). Absent preserves the existing unlimited
	 * behavior; limits stay configurable before a run and raisable mid-run. */
	policy?: RunControlPolicy;
	/** Consumed budgets persisted with the run: accumulated active
	 * execution and per-role observed usage with coverage. Restart cannot
	 * reset them. */
	budget?: RunBudget;
	status: FusionRunStatus;
	revisions: number;
	finalFixUsed?: boolean;
	results: Record<string, string>;
	updatedAt: string;
}

export function runsDir(agentDir: string): string {
	return join(agentDir, "fusion", "runs");
}

export function newRunId(): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${stamp}-${suffix}`;
}

function isFusionRun(value: unknown): value is FusionRun {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.runId === "string" &&
		typeof record.cwd === "string" &&
		typeof record.task === "string" &&
		typeof record.brief === "string" &&
		typeof record.status === "string" &&
		typeof record.updatedAt === "string"
	);
}

/** A shape-valid stop marker, or undefined for absent or malformed values.
 * Recovery treats a persisted marker as authoritative so a stale or missing
 * native run file cannot lose the stopped-work guard. */
export function readStopMarker(value: unknown): FusionRun["stopped"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const marker = value as Record<string, unknown>;
	if (typeof marker.at !== "string" || !marker.at.trim()) return undefined;
	if (marker.reason !== undefined && typeof marker.reason !== "string") return undefined;
	if (marker.abort !== undefined && !["delivered", "failed", "pending"].includes(marker.abort as string)) return undefined;
	// The per-worker run-scope list is additive advisory state: entries that
	// no longer validate are dropped instead of losing the whole guard, and
	// reading builds a copy rather than rewriting the caller's record.
	if (marker.workers === undefined) return marker as FusionRun["stopped"];
	const roles = new Set(["executor", "scout"]);
	const deliveries = new Set(["requested", "delivered", "failed", "unsupported", "not-submitted"]);
	const terminals = new Set(["completed", "error", "cancelled"]);
	const validWorker = (worker: unknown): boolean => {
		if (!worker || typeof worker !== "object" || Array.isArray(worker)) return false;
		const entry = worker as Record<string, unknown>;
		return roles.has(entry.role as string)
			&& deliveries.has(entry.delivery as string)
			&& (entry.terminal === undefined || terminals.has(entry.terminal as string))
			&& (entry.error === undefined || typeof entry.error === "string")
			&& (entry.detail === undefined || typeof entry.detail === "string");
	};
	const workers = Array.isArray(marker.workers) ? (marker.workers as unknown[]).filter(validWorker) : undefined;
	const { workers: _dropped, ...rest } = marker;
	return { ...rest, ...(workers !== undefined ? { workers } : {}) } as FusionRun["stopped"];
}

export async function writeRun(dir: string, run: FusionRun): Promise<void> {
	await mkdir(dir, { recursive: true });
	run.updatedAt = new Date().toISOString();
	const file = join(dir, `${run.runId}.json`);
	const tmp = `${file}.tmp`;
	await writeFile(tmp, `${JSON.stringify(run, null, "\t")}\n`);
	await rename(tmp, file);
}

export async function readRun(dir: string, id: string): Promise<FusionRun | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(join(dir, `${id}.json`), "utf8"));
		return isFusionRun(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export async function listRuns(dir: string, cwd: string): Promise<FusionRun[]> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const runs: FusionRun[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try {
			const parsed: unknown = JSON.parse(await readFile(join(dir, name), "utf8"));
			if (isFusionRun(parsed) && parsed.cwd === cwd) {
				runs.push(parsed);
			}
		} catch {}
	}
	runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	return runs;
}

export async function markInterrupted(dir: string, cwd: string): Promise<FusionRun[]> {
	const changed: FusionRun[] = [];
	for (const run of await listRuns(dir, cwd)) {
		if (run.status !== "running") continue;
		run.status = "interrupted";
		await writeRun(dir, run);
		changed.push(run);
	}
	return changed;
}

export function delegationKey(action: string, brief: string, revision: number): string {
	return createHash("sha256").update(`${action}:${revision}\n${brief}`).digest("hex");
}

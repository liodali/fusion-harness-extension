import { FusionController } from "../core/controller.ts";
import { createManifestStore, readRunManifest, translateOpenCodeV1, type RunManifest } from "../core/manifest.ts";
import { ActiveClock, addActiveTime, type BudgetRole, createRunBudget, describeRunBudget, evaluateRunBudget, readRunBudget, type RunBudget, recordRoleUsage, remainingActiveMs } from "../core/budget.ts";
import { readRunControlPolicy, type RunControlPolicy } from "../core/run-control.ts";
import { canonicalWorkspace, openWorkspaceRegistry, type WorkspaceLease } from "../workspace/ownership.ts";
import { EXECUTOR_SYSTEM_PROMPT, FUSION_SUMMARY_HEADING, MAX_SCOUT_CALLS, buildScoutPrompt, buildSupervisorPrompt } from "../prompts.ts";
import { MAX_SCOUT_TOOL_CALLS, formatScoutResponse, scoutCapDecision } from "../core/scout.ts";
import { MAX_REVISIONS } from "../limits.ts";
import { getOutputPrice, isModelInTier, type FusionModelTier } from "../pricing.ts";
import { RECENT_MODEL_COHORT, isRecentModel } from "../recent-models.ts";
import { formatCompactReport } from "../report.ts";
import { formatDuration } from "../core/duration.ts";
import { snapshotWorkspace, snapshotWorkspaceAfter, workspaceDiffStat, workspaceEvidenceRefs } from "../workspace/evidence.ts";
import { nodeGitExec } from "../workspace/node-git.ts";
import { OPENCODE_CAPABILITIES, type NativeSubagentExecute, type NativeToolContext } from "./native-executor.ts";
import { createOpenCodeWorkerRuntime, type OpenCodeWorkerRuntime, type ScoutCap } from "./worker-runtime.ts";
import { FUSION_AGENTS, fusionPermissionsEqual } from "./agents.ts";
import { DELEGATE_INPUT, delegateInput, delegateMonitor, shortLabel } from "./delegate-presentation.ts";
import { readExecutorStop, stopFeedback, stopInterruptOutcome, stopWait, type ExecutorStop, type ScoutStop } from "./executor-stop.ts";
import { describeWaitStatus, openCodeWaitSignal, WaitClock, type WaitKind, type OpenCodeWaitSignal, type OpenWait } from "../core/waiting.ts";
import { deriveRecoveryGuidance, describeRecoveryGuidance, isRecoveryOwed, resolveCommandEntry, resolveOperatorCommand, type RecoveryGuidance } from "../core/guidance.ts";
import { buildDoctorReport, describeDoctorAuth, describeDoctorReport, type DoctorFacts, type DoctorModelFact } from "../core/doctor.ts";
import { loadedPackageIdentity } from "../version.ts";
import { inspectOwnershipStorage } from "../workspace/ownership.ts";
import type { ExecutionObservation } from "../core/run-control.ts";
import type { WorkerConfig, WorkerHandle, WorkerModelConfig, WorkerTurnRequest, WorkerTurnResult } from "../core/worker.ts";
import { createHash, randomUUID } from "node:crypto";
import type { WorkspaceSnapshot } from "../workspace/evidence.ts";
/** The official server plugin contract (`@opencode/plugin`, pinned 2.3.0).
 * The official TUI side is typed directly in `src/opencode/tui.ts`; the server
 * side keeps the documented `PluginContext` boundary view (below) and validates
 * the official contract through the derived type checks further down
 * (docs/opencode-contract-matrix.md). */
import type { Plugin } from "@opencode/plugin";

interface ToolContext extends NativeToolContext { readonly agent: string }
/** Fusion's tool-registration boundary: the official `Tool.Info` (`@opencode/plugin`,
 * promise/tool.d.ts) types `input` as the schema-generic `Tool.ValueSchema` union,
 * while Fusion registers plain JSON-schema objects. This mirror keeps the
 * observed registration contract (docs/opencode-contract-matrix.md row 6);
 * the host validates tool input/output at runtime. */
interface ToolDefinition {
	name: string;
	description: string;
	input: Record<string, unknown>;
	options: { codemode: false };
	execute: (input: unknown, context: ToolContext) => Promise<{ content: string; metadata?: Record<string, unknown> }>;
}
/** Tool-call hook event. Mirrors the official `ToolHooks["execute.before"]`
 * shape (`tool`, `sessionID`, `agent`, `messageID`, `id`, `input`);
 * `sessionID`/`input` stay optional here so the guard also holds on pre-2.2.3
 * hosts whose hook event carried only tool/agent (compatibility boundary,
 * docs/opencode-contract-matrix.md row 6). Scout-child calls are counted by
 * `sessionID`. */
interface ToolHookEvent {
	tool: string;
	agent: string;
	/** Session that executes the tool; scout-child calls are counted by this ID. */
	sessionID?: string;
	input?: unknown;
}
/** The subset of the host's model catalog entry Fusion validates and reports on (pinned live on v2.2.3). */
interface HostModel {
	id?: string;
	modelID?: string;
	providerID?: string;
	type?: string;
	name?: string;
	status?: string;
	enabled?: boolean;
	variants?: readonly { id?: string }[];
	/** Per-tier pricing; the first entry is the base tier. */
	cost?: readonly { output?: number }[];
	time?: { released?: number };
}
/** A plugin-registered native command; `execute` performs the action, its return value is presentation-only. */
interface CommandDefinition {
	name: string;
	description: string;
	execute: (args: { sessionID: string; prompt?: { text?: string }; delivery?: string }) => unknown;
}
interface CommandEditor {
	add(command: CommandDefinition): unknown;
}
/** v2.2.5 `Agent.Info` subset Fusion reads and writes. `system` is the prompt; there is no `prompt` field. */
interface AgentRecord {
	id: string;
	name: string;
	mode: "subagent" | "primary" | "all";
	hidden: boolean;
	description?: string;
	system?: string;
	permissions?: { action: string; resource: string; effect: string }[];
}
/** Pinned live on OpenCode v2.2.5: the agent editor has exactly these methods — no `add`. `update` on a missing ID creates the agent. */
interface AgentEditor {
	list(): readonly AgentRecord[];
	get(id: string): AgentRecord | undefined;
	default(id: string | undefined): void;
	update(id: string, update: (agent: AgentRecord) => void): void;
	remove(id: string): void;
}
/** A registration handle returned by transforms; disposing removes the transform's effect. Mirrors the official `Registration`. */
interface NativeRegistration {
	dispose(): unknown;
}
/**
 * Fusion's view of the host plugin context: the structural subset of the
 * official `Plugin.Context` (`@opencode/plugin`, promise/plugin.d.ts) that
 * Fusion uses, narrowed at the documented compatibility boundaries
 * (docs/opencode-contract-matrix.md): optional domains keep the pre-2.2.3
 * host floor (agent/event/model/command), `AgentRecord`/`AgentEditor` mirror
 * the official `Agent.Info`/`AgentEditor`, `HostModel` mirrors the official
 * `Model.Info` subset, `ToolDefinition`/`CommandDefinition` keep the observed
 * registration contracts, and the subagent executor keeps
 * `NativeSubagentExecute` (the official tool generics do not name the subagent
 * input shape). The setup context is typed as the official `Plugin.Context`;
 * the view below is assigned from it once, so official-type drift fails
 * typecheck here instead of silently changing behavior.
 */
interface PluginContext {
	location: { directory: string };
	storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown>; remove(key: string): Promise<unknown> };
	/** Pinned live on OpenCode v2.2.5. Absence leaves Fusion's agents to manual Markdown installation. */
	agent?: {
		transform(callback: (editor: AgentEditor) => void): Promise<NativeRegistration>;
		list?(): Promise<unknown>;
		reload?(): Promise<void>;
	};
	tool: {
		list(): Promise<readonly { id: string; execute: NativeSubagentExecute<ToolContext> }[]>;
		transform(callback: (editor: { add(tool: ToolDefinition): void }) => void): Promise<unknown>;
		hook(name: "execute.before", callback: (event: ToolHookEvent) => void): Promise<unknown>;
	};
	session: {
		context(input: { sessionID: string }): Promise<readonly unknown[]>;
		get(input: { sessionID: string }): Promise<{ id: string; parentID?: string; location?: { directory?: string } }>;
		hook(name: "context", callback: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void): Promise<unknown>;
		/** Present in OpenCode v2 hosts; absence leaves worker abort unsupported. */
		interrupt?(input: { sessionID: string; resume?: boolean }): Promise<unknown>;
		/** Present in OpenCode v2 hosts; absence leaves /fusion unable to inject the supervisor prompt. */
		prompt?(input: { sessionID: string; id?: string; text?: string }): Promise<unknown>;
		switchAgent?(input: { sessionID: string; agent: string }): Promise<unknown>;
		synthetic?(input: { sessionID: string; text: string; description?: string; resume?: boolean; metadata?: Record<string, unknown> }): Promise<unknown>;
	};
	/** Pinned in OpenCode v2.2.2: options-object subscribe returning a lazy async iterable. Absence leaves worker events unsupported. */
	event?: {
		subscribe(options?: { types?: string[]; signal?: AbortSignal }): AsyncIterable<{ id?: string; type: string; data?: Record<string, unknown> }>;
	};
	/** Pinned live on OpenCode v2.2.3: `{ location, data }` with the flat model catalog. Absence leaves Fusion on host-default models. */
	model?: {
		list(): Promise<{ location?: unknown; data?: readonly HostModel[] }>;
	};
	/** Observed defensively when the host exposes it; absence leaves the doctor's host version "not observable". */
	app?: { version?: string };
	/** Pinned live on OpenCode v2.2.3: transform registers commands (`{name, description, execute}`); execute receives `{ sessionID, prompt: { text }, delivery }` and its return value is presentation-only. Absence leaves Fusion without user-facing commands. */
	command?: {
		list(): Promise<{ location?: unknown; data?: readonly { name?: string; description?: string }[] }>;
		transform(callback: (editor: CommandEditor) => unknown): Promise<unknown>;
	};
}

/**
 * Official-contract validation (C1, docs/opencode-contract-matrix.md). The
 * supported package exposes its server context through `Plugin.Context`; the
 * aliases below must each stay `true`. They check the contracts Fusion's
 * correctness depends on — the tool context a Fusion tool receives, the
 * message list the completion-notification matcher consumes, the session
 * surfaces Fusion calls with its exact argument shapes, the pinned agent
 * editor method set, and the command invocation shape. Official-shape drift
 * fails typecheck here without runtime cost and without casting.
 */
type HostToolContext = Parameters<Awaited<ReturnType<Plugin.Context["tool"]["list"]>>[number]["execute"]>[1];
type OfficialToolContextSatisfiesBoundary = HostToolContext extends ToolContext ? true : false;
type SessionContextIsMessageList = Awaited<ReturnType<Plugin.Context["session"]["context"]>> extends readonly unknown[] ? true : false;
type FusionPromptCall = { sessionID: string; id: string; text: string };
type OfficialSessionPromptAcceptsFusion = Plugin.Context["session"]["prompt"] extends (input: FusionPromptCall, ...rest: never[]) => unknown ? true : false;
type FusionInterruptCall = { sessionID: string; resume?: boolean };
type OfficialSessionInterruptAcceptsFusion = Plugin.Context["session"]["interrupt"] extends (input: FusionInterruptCall, ...rest: never[]) => unknown ? true : false;
/** The pinned agent-editor method set: list/get/default/update/remove, no `add`
 * (matrix row 4). `update`'s callback must receive the agent record object. */
type OfficialAgentEditor = Parameters<Parameters<Plugin.Context["agent"]["transform"]>[0]>[0];
type OfficialAgentEditorContract = ("list" | "get" | "default" | "update" | "remove") extends keyof OfficialAgentEditor
	? "add" extends keyof OfficialAgentEditor ? false
	: OfficialAgentEditor["update"] extends (id: string, update: (agent: infer Agent) => void) => unknown ? (Agent extends object ? true : false)
	: false
	: false;
/** Command registration: the editor adds `{name, execute}` definitions whose
 * invocation carries `sessionID`, `prompt`, and `delivery` (matrix row 10). */
type OfficialCommandEditor = Parameters<Parameters<Plugin.Context["command"]["transform"]>[0]>[0];
type OfficialCommandDefinition = OfficialCommandEditor["add"] extends (definition: infer Definition) => unknown ? Definition : never;
type OfficialCommandInvocationContract = OfficialCommandDefinition extends { name: string; execute: (input: infer Invocation) => unknown }
	? Invocation extends { sessionID: string; prompt: unknown; delivery: unknown } ? true : false
	: false;
const OFFICIAL_CONTRACT_VALIDATED: [
	OfficialToolContextSatisfiesBoundary,
	SessionContextIsMessageList,
	OfficialSessionPromptAcceptsFusion,
	OfficialSessionInterruptAcceptsFusion,
	OfficialAgentEditorContract,
	OfficialCommandInvocationContract,
] = [true, true, true, true, true, true];
void OFFICIAL_CONTRACT_VALIDATED;

/** Dedicated disposable read-only scout subagent. */
const SCOUT_AGENT = "fusion-scout";
/** Read/search/list operations the scout may execute; everything else is refused before its effects occur. OpenCode v2 tool names. */
const SCOUT_TOOLS = new Set(["read", "grep", "glob"]);
/** Fusion tools hidden from the fusion agent when persistent mode is off and its session has no active run. Read-only reporting tools stay visible. */
const FUSION_GATED_TOOLS = ["fusion_start", "fusion_delegate", "fusion_scout", "fusion_reconcile", "fusion_reset", "fusion_configure"];
const FUSION_TOOLS = [...FUSION_GATED_TOOLS, "fusion_resume", "fusion_stats", "fusion_status", "fusion_stop"];

interface Run {
	controller: FusionController;
	handle: WorkerHandle;
	runtime: OpenCodeWorkerRuntime;
	runId: string;
	lease?: WorkspaceLease;
	lastResult?: RunManifest["lastResult"];
	model?: RunManifest["model"];
	adapterData?: RunManifest["adapterData"];
	setContext(worker: WorkerHandle, context: ToolContext): void;
	reconciling?: boolean;
	before?: WorkspaceSnapshot;
	/** The supervisor exhausted its continuation budget on an unfinished protocol. */
	incomplete?: boolean;
	turnAbort?: AbortController;
	monitor?: ReturnType<typeof delegateMonitor>;
	stopFlight?: Promise<ExecutorStop | undefined>;
	interruptFlight?: Promise<void>;
	persistFlight?: Promise<void>;
	/** R2 run policies: the turn's active clock and the bounded time-limit
	 * timer are process-local; only accumulated durations persist. */
	turnClock?: ActiveClock;
	/** Which worker armed the turn's clock (executor or scout). */
	turnClockWorker?: "executor" | "scout";
	budgetTimer?: ReturnType<typeof setTimeout>;
	/** R3 confirmed-wait observation for the live worker turn: open waits
	 * pause the turn's active clock. Process-local, disposed with the turn. */
	turnWaits?: WaitClock;
	/** R3 wait observation for owned children without a live turn here
	 * (backgrounded executor or scout children). Keyed by child session. */
	childWaits?: Map<string, WaitClock>;
}
/** Match OpenCode's completion notification to this specific native job generation. */
function notificationResult(messages: readonly unknown[], childID: string, description: string): { state: "completed" | "error" | "cancelled"; output: string } {
	for (const item of messages) {
		if (!item || typeof item !== "object") continue;
		const message = item as Record<string, unknown>;
		if (message.type !== "synthetic" || message.description !== description || !message.metadata || typeof message.metadata !== "object") continue;
		const metadata = message.metadata as Record<string, unknown>;
		if (metadata.source !== "subagent" || metadata.childID !== childID || metadata.agent !== "fusion-executor" || (metadata.state !== "completed" && metadata.state !== "error" && metadata.state !== "cancelled") || typeof message.text !== "string") continue;
		const prefix = `<subagent sessionID="${childID}" state="${metadata.state}" description="${description}">\n`;
		const suffix = "\n</subagent>";
		if (!message.text.startsWith(prefix) || !message.text.endsWith(suffix)) continue;
		const output = message.text.slice(prefix.length, -suffix.length);
		return { state: metadata.state, output };
	}
	throw new Error("No matching completion notification yet. Retry reconciliation if it arrives; otherwise inspect the worker and workspace, then explicitly resolve ownership after confirming the worker has stopped.");
}

/** OpenCode v2 server plugin. A plugin instance is scoped to one location. */
export default {
	id: "fusion",
	async setup(ctx: PluginContext, dependencies: { ownershipRoot?: string; canonicalize?: (cwd: string) => Promise<string>; openRegistry?: typeof openWorkspaceRegistry; waitStaleAfterMs?: number } = {}) {
		const native = (await ctx.tool.list()).find((tool) => tool.id === "subagent");
		if (!native) throw new Error("Fusion requires OpenCode's native subagent tool.");
		const canonicalize = dependencies.canonicalize ?? canonicalWorkspace;
		const workspace = await canonicalize(ctx.location.directory);
		const registry = await (dependencies.openRegistry ?? openWorkspaceRegistry)(dependencies.ownershipRoot);
		const runs = new Map<string, Run>();
		let owner: string | undefined;
		let resetting = false;
		let starting = false;
		let configuring = false;
		let promptInFlight = false;
		const modelKey = `model/${createHash("sha256").update(ctx.location.directory).digest("hex")}`;
		const storedModel = await ctx.storage.get(modelKey);
		function readModel(value: unknown): WorkerModelConfig | undefined {
			if (value === undefined || value === null) return undefined;
			if (!value || typeof value !== "object") throw new Error("Invalid saved Fusion model configuration.");
			const model = value as Record<string, unknown>;
			if (typeof model.provider !== "string" || !model.provider.trim() || typeof model.modelId !== "string" || !model.modelId.trim() || (model.variant !== undefined && (typeof model.variant !== "string" || !model.variant.trim()))) throw new Error("Invalid saved Fusion model configuration.");
			return { provider: model.provider, modelId: model.modelId, ...(typeof model.variant === "string" ? { variant: model.variant } : {}) };
		}
		let preferredModel = readModel(storedModel);
		/** Persisted run-limit preference for this location (R2). A stored
		 * malformed record throws fail-closed: the plugin surfaces it instead
		 * of silently running without the configured limits. */
		const policyKey = `policy/${createHash("sha256").update(ctx.location.directory).digest("hex")}`;
		const preferredPolicy = readRunControlPolicy(await ctx.storage.get(policyKey));
		/** Mutable view of the location preference (the /fusion-budget command
		 * rewrites it); runs adopt it before any work starts. */
		const preferredPolicyRef: { current: RunControlPolicy | undefined } = { current: preferredPolicy };
		// Persistent mode (default off, persisted per location): when off, gated
		// Fusion tools are visible to a fusion session only while a run is active;
		// /fusion starts runs, so the user keeps explicit control.
		let fusionMode = (await ctx.storage.get("fusion-mode")) === true;
		const setFusionMode = async (enabled: boolean): Promise<void> => {
			await ctx.storage.set("fusion-mode", enabled);
			fusionMode = enabled;
		};
		// One subscription fans every raw bus event out to each runtime's owned-child
		// routing (one async iterable cannot be consumed twice). When the host does
		// not expose the pinned subscribe surface, streaming stays unsupported.
		const busSinks = new Set<(event: { id?: string; type: string; data?: Record<string, unknown> }) => void>();
		/** Recent child terminal observations from the bus. The stop's own
		 * interrupt fires a terminal event that can arrive before the stop
		 * writes its per-worker record, so a bounded ring lets the stop adopt
		 * evidence the sink already saw instead of missing it forever. */
		const recentChildTerminals: { childSessionID: string; terminal: "completed" | "error" | "cancelled"; created: number }[] = [];
		const busController = new AbortController();
		const busHost = typeof ctx.event?.subscribe === "function" ? ctx.event : undefined;
		if (busHost) {
			void (async () => {
				const iterator = busHost.subscribe({ signal: busController.signal })[Symbol.asyncIterator]();
				for (;;) {
					const next = await iterator.next();
					if (next.done) break;
					for (const sink of busSinks) {
						try { sink(next.value); } catch {}
					}
				}
			})().catch(() => { /* bus ended or failed: streaming is best-effort; settlement paths do not depend on it */ });
		}
		// Native notification matching depends on this exact description format.
		const services = {
			now: () => Date.now(),
			newRunId: () => randomUUID(),
			newRequestId: (action: "execute" | "revise" | "final_fix" | "resume") => `Fusion ${action} ${randomUUID()}`,
		};
		// Scout enforcement outlives the fusion_scout tool call: the host may
		// background a scout, and its child keeps running after the call returns.
		// Guards are tracked per child session and stay armed until that child's
		// execution is observed to end. The host fires the hook synchronously
		// before every tool execution (pinned in OpenCode v2.2.3: events carry
		// the executing session), so refusing here denies the call before its
		// effects occur — the exact-cap requirement for scouts.
		/** The scout's worker handle when this instance created it; a child
		 * left behind by a previous plugin instance is placed under a guard
		 * without one and cannot be interrupted through a handle here — its
		 * record stays queued and a terminal child event still confirms it. */
		type ScoutGuardEntry = { cap: ScoutCap; handle?: WorkerHandle; terminate: () => void; release?: () => void };
		const scoutGuards = new Map<string, ScoutGuardEntry>();
		const hasBackgroundScout = () => [...scoutGuards.values()].some((entry) => !!entry.release);
		let activeScout: { entry: ScoutGuardEntry; childSessionID?: string; requestId?: string } | undefined;
		let scoutInFlight = false;
		const SCOUT_TERMINAL_EVENTS = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]);
		function freshScoutCap(): ScoutCap {
			let count = 0;
			let refused = false;
			return {
				consume: () => {
					count += 1;
					const decision = scoutCapDecision(count, MAX_SCOUT_TOOL_CALLS);
					if (decision !== "allow") refused = true;
					return decision;
				},
				get refused() { return refused; },
				get count() { return count; },
			};
		}
		const MAX_TRACKED_SCOUTS = 8;
		function trackScoutGuard(childSessionID: string, entry: ScoutGuardEntry): void {
			if (!scoutGuards.has(childSessionID) && scoutGuards.size >= MAX_TRACKED_SCOUTS) {
				throw new Error("Fusion scout tracking is full; wait for an existing scout to stop.");
			}
			// A live child's cap must survive until its terminal event. Refuse new
			// entries at capacity instead of evicting enforcement for existing work.
			scoutGuards.set(childSessionID, entry);
		}
		// A scout child that is tracked but never backgrounded (or left behind by a
		// previous plugin instance) releases its guard and handle when its
		// execution reaches a terminal state.
		const onScoutBusEvent = (event: { type: string; data?: Record<string, unknown> }): void => {
			const data = event.data && typeof event.data === "object" ? event.data : undefined;
			const sessionID = data && typeof data.sessionID === "string" ? data.sessionID : undefined;
			const entry = sessionID !== undefined ? scoutGuards.get(sessionID) : undefined;
			if (!entry || !SCOUT_TERMINAL_EVENTS.has(event.type)) return;
			scoutGuards.delete(sessionID!);
			entry.release?.();
		};
		busSinks.add(onScoutBusEvent);
		// Supervisor-turn completion channel (pinned live on v2.2.3: every session
		// turn ends in exactly one session.execution.succeeded | interrupted |
		// failed event carrying the session ID and a native event id;
		// session.text.ended carries each text part's final text). A normal end
		// feeds the shared completion policy: when the protocol is unfinished and
		// the nudge budget allows, the controller's continuation text is sent as
		// the next turn via session.prompt, bounded by MAX_SETTLE_NUDGES and
		// persisted before delivery. Interrupted and failed turns never nudge.
		// Completion is bound to Fusion turns (the context hook records the agent
		// whose context was last built) and to observed event ids, so ordinary
		// agents and redeliveries never nudge or settle the run.
		const supervisorText = new Map<string, string>();
		const turnAgent = new Map<string, string>();
		const turnVisibility = new Map<string, { agent: string; tools: string[] }>();
		const processedTurnIds = new Map<string, Set<string>>();
		/** Settlement is serialized per run: one terminal settles at a time, in bus order. */
		const settlementChains = new Map<string, Promise<void>>();
		const forgetTurnState = (sessionID: string): void => {
			supervisorText.delete(sessionID);
			turnAgent.delete(sessionID);
			turnVisibility.delete(sessionID);
			processedTurnIds.delete(sessionID);
		};
		const seenTerminalId = (sessionID: string, id: string | undefined): boolean => {
			if (typeof id !== "string") return true;
			let seen = processedTurnIds.get(sessionID);
			if (!seen) { seen = new Set(); processedTurnIds.set(sessionID, seen); }
			if (seen.has(id)) return false;
			seen.add(id);
			if (seen.size > 64) { const oldest = seen.values().next().value; if (oldest !== undefined) seen.delete(oldest); }
			return true;
		};
		const onTurnBusEvent = (event: { id?: string; type: string; data?: Record<string, unknown> }): void => {
			const data = event.data && typeof event.data === "object" ? event.data : undefined;
			const sessionID = data && typeof data.sessionID === "string" ? data.sessionID : undefined;
			if (!sessionID) return;
			const run = runs.get(sessionID);
			if (!run) return;
			// Completion is bound to turns of the Fusion agent: a session reused
			// with an ordinary agent never nudges or settles the Fusion run.
			if (turnAgent.get(sessionID) !== "fusion") return;
			if (event.type === "session.execution.started") {
				// The final assistant response is what the summary policy evaluates.
				supervisorText.set(sessionID, "");
				return;
			}
			if (event.type === "session.text.ended" && typeof data?.text === "string") {
				supervisorText.set(sessionID, data.text.slice(-20000));
				return;
			}
			const terminal = event.type === "session.execution.succeeded" ? "completed" : event.type === "session.execution.interrupted" ? "aborted" : event.type === "session.execution.failed" ? "error" : undefined;
			if (!terminal) return;
			if (!seenTerminalId(sessionID, event.id)) return;
			const lastPart = supervisorText.get(sessionID) ?? "";
			supervisorText.delete(sessionID);
			const status = run.runtime.status(run.handle);
			// A backgrounded executor, an in-flight reconciliation, or a running
			// scout means the turn is not really settled — for ANY terminal,
			// including interrupts and failures: keep the run active so its
			// control tools (fusion_reconcile among them) stay available, and let
			// the outstanding work steer what happens next.
			const workUnresolved = status.backgroundPending || status.unsettled || run.reconciling || scoutInFlight || hasBackgroundScout();
			// Cancellation is recorded the moment an interrupt or failure
			// arrives — not when its queued settlement runs — so a settlement
			// paused at persistence can never resume into delivering the
			// cancelled nudge. Outstanding work keeps recovery controls active,
			// but never revokes cancellation of a pending continuation.
			if (terminal !== "completed") {
				const pendingNudge = run.adapterData?.fusionNudge as { state?: unknown } | undefined;
				if (pendingNudge?.state === "pending") run.adapterData = { ...run.adapterData, fusionNudge: { ...pendingNudge, state: "cancelled" } };
			}
			// Settlement is serialized per run: terminals queue behind earlier
			// settlements so a late interrupt can never interleave with an
			// in-flight nudge delivery or state write.
			const previous = settlementChains.get(sessionID) ?? Promise.resolve();
			const chained = previous.then(() => settleTurn(sessionID, run, { lastPart, terminal, workUnresolved })).catch(() => { /* settlement failures are reported where they happen */ });
			settlementChains.set(sessionID, chained);
		};
		busSinks.add(onTurnBusEvent);
		/** Settle one completed Fusion turn: nudge, hold, or finish the run. */
		async function settleTurn(sessionID: string, run: Run, turn: { lastPart: string; terminal: "completed" | "aborted" | "error"; workUnresolved: boolean }): Promise<void> {
			// Revalidate after every await: a reset, an interrupt, or an agent
			// switch while settlement is in flight must not deliver a stale nudge
			// or mutate a run this instance no longer owns.
			const stale = (): boolean => runs.get(sessionID) !== run || turnAgent.get(sessionID) !== "fusion";
			// Cancellation and outstanding work are re-read from the run at
			// delivery time — not from locals captured at settlement start —
			// because an interrupt can cancel the nudge and a worker can
			// background while a settlement is paused at persistence.
			const nudgeCancelled = (): boolean => !!readExecutorStop(run.adapterData?.fusionStop) || (run.adapterData?.fusionNudge as { state?: unknown } | undefined)?.state === "cancelled";
			const workUnresolvedNow = (): boolean => {
				const status = run.runtime.status(run.handle);
				return status.backgroundPending || status.unsettled || run.reconciling || scoutInFlight || hasBackgroundScout();
			};
			const persistRun = async (): Promise<boolean> => {
				if (!run.lease) return true;
				try {
					await persist(sessionID, run);
					if ((run.adapterData?.fusionSettlement as { state?: unknown } | undefined)?.state === "pending") run.adapterData = { ...run.adapterData, fusionSettlement: { state: "saved" } };
					return true;
				} catch {
					run.adapterData = { ...run.adapterData, fusionSettlement: { state: "pending" } };
					return false;
				}
			};
			const reportIssue = async (text: string): Promise<void> => {
				try {
					await reportCommand(sessionID, "Fusion settlement issue", text);
				} catch { /* hosts without session.synthetic surface the failure through fusion_status instead. */ }
			};
			// Unresolved worker or reconciliation work keeps the run active across
			// every terminal so fusion_reconcile stays available; the outstanding
			// work steers what happens next. Event-time cancellation recorded
			// before this settlement queued still becomes durable here — staleness
			// first so a reset mid-hold is never overwritten, and persistence
			// after so a reload cannot revive a continuation its turn cancelled.
			if (turn.workUnresolved) {
				if (stale()) return;
				if (!(await persistRun())) await reportIssue("Fusion could not write its settlement; it will retry when this session next settles.");
				return;
			}
			// Nudge delivery requires the host's prompt surface; without it, no
			// budget is consumed and an unfinished protocol reports incomplete.
			const deliverPrompt = (input: { sessionID: string; id?: string; text?: string }): Promise<unknown> | undefined =>
				typeof ctx.session.prompt === "function" ? ctx.session.prompt(input) : undefined;
			const canDeliver = typeof ctx.session.prompt === "function" && !nudgeCancelled();
			const pendingNudge = run.adapterData?.fusionNudge as { id?: unknown; text?: unknown; state?: unknown } | undefined;
			// A settlement write left pending by an earlier terminal is retried
			// before anything else happens this turn.
			if ((run.adapterData?.fusionSettlement as { state?: unknown } | undefined)?.state === "pending") {
				if (!(await persistRun())) await reportIssue("Fusion could not write its settlement; it will retry when this session next settles.");
			}
			if (stale()) return;
			if (turn.terminal !== "completed") {
				// Cancelled or errored turns settle without continuation; an
				// undelivered nudge is dropped with the turn it belonged to.
				if (pendingNudge?.state === "pending") run.adapterData = { ...run.adapterData, fusionNudge: { ...pendingNudge, state: "cancelled" } };
				run.controller.settled(fusionMode);
				if (!(await persistRun())) await reportIssue("Fusion could not write its settlement; it will retry when this session next settles.");
				return;
			}
			// A nudge whose delivery failed is retried at the next completed turn
			// end before a new nudge is considered; the budget was already
			// consumed, and the intent is re-persisted before the retry sends.
			if (canDeliver && pendingNudge?.state === "pending" && typeof pendingNudge.id === "string" && typeof pendingNudge.text === "string") {
				if (!(await persistRun())) {
					await reportIssue("Fusion could not write its continuation intent; the nudge will retry when this session next settles.");
					return;
				}
				// The pause at persistence is exactly where an interrupt lands:
				// a cancellation it recorded there, or work that became
				// unresolved during the pause, aborts this delivery.
				if (stale() || nudgeCancelled() || workUnresolvedNow()) return;
				try {
					await deliverPrompt({ sessionID, id: pendingNudge.id, text: pendingNudge.text });
					run.adapterData = { ...run.adapterData, fusionNudge: { id: pendingNudge.id, text: pendingNudge.text, state: "delivered" } };
					await persistRun();
				} catch {
					await reportIssue("Fusion could not deliver its continuation nudge; it will retry when this session next settles. If it keeps failing, deliver the instruction to the fusion agent directly.");
				}
				return;
			}
			// Nudges are only consumed when they can actually be delivered.
			const nudge = canDeliver ? run.controller.continuation({ lastAssistantText: turn.lastPart, outcome: "completed", canContinue: !turn.workUnresolved }) : undefined;
			if (nudge) {
				const id = `msg_fusion_nudge_${randomUUID().replaceAll("-", "")}`;
				// Retain the retryable delivery state and persist the nudge budget
				// before sending, so a reload can neither resend nor forget it.
				run.adapterData = { ...run.adapterData, fusionNudge: { id, text: nudge, state: "pending" } };
				if (!(await persistRun())) {
					await reportIssue("Fusion could not write its continuation intent; the nudge will retry when this session next settles.");
					return;
				}
				// Same pause, same exposure: an interrupt recorded during the
				// persistence await cancels this nudge before it is sent.
				if (stale() || nudgeCancelled() || workUnresolvedNow()) return;
				try {
					await deliverPrompt({ sessionID, id, text: nudge });
					run.adapterData = { ...run.adapterData, fusionNudge: { id, text: nudge, state: "delivered" } };
					await persistRun();
				} catch {
					await reportIssue("Fusion could not deliver its continuation nudge; it will retry when this session next settles. If it keeps failing, deliver the instruction to the fusion agent directly.");
				}
				return;
			}
			if (stale()) return;
			const protocolComplete = run.controller.state.executed && turn.lastPart.includes(FUSION_SUMMARY_HEADING);
			if (!protocolComplete) {
				// The nudge budget ran out (or delivery is unsupported) on an
				// unfinished protocol: report the run incomplete instead of marking
				// it complete, and keep the state across reloads.
				run.incomplete = true;
				run.adapterData = { ...run.adapterData, fusionIncomplete: true };
				if (!(await persistRun())) await reportIssue("Fusion could not write its settlement; it will retry when this session next settles.");
				return;
			}
			run.incomplete = false;
			run.adapterData = { ...run.adapterData, fusionIncomplete: false };
			run.controller.settled(fusionMode);
			// Final settlement survives reload: the manifest carries the deactivated
			// run and its completion phase.
			if (!(await persistRun())) await reportIssue("Fusion could not write its settlement; it will retry when this session next settles.");
		}
		busSinks.add(onTurnBusEvent);
		function resolveScoutGuard(event: ToolHookEvent): ScoutGuardEntry | undefined {
			if (typeof event.sessionID === "string" && event.sessionID) {
				const tracked = scoutGuards.get(event.sessionID);
				if (tracked) return tracked;
				if (activeScout) {
					activeScout.childSessionID ??= event.sessionID;
					if (activeScout.childSessionID === event.sessionID) return activeScout.entry;
				}
				// A fusion-scout child this instance never armed must not run
				// unguarded either: give it a fresh cap and track it.
				// Reserve a slot for the active scout until its child is published.
				if (activeScout && !scoutGuards.has(activeScout.childSessionID ?? "") && scoutGuards.size >= MAX_TRACKED_SCOUTS - 1) {
					throw new Error("Fusion scout tracking is full; wait for an existing scout to stop.");
				}
				const fresh: ScoutGuardEntry = { cap: freshScoutCap(), terminate: () => {} };
				trackScoutGuard(event.sessionID, fresh);
				return fresh;
			}
			return activeScout?.entry;
		}
		await ctx.tool.hook("execute.before", (event) => {
			if (event.agent === "fusion" && event.tool === "subagent") throw new Error("Use fusion_delegate to start Fusion executor work.");
			if (event.agent !== SCOUT_AGENT) return;
			const guard = resolveScoutGuard(event);
			if (!guard) return;
			if (!SCOUT_TOOLS.has(event.tool)) throw new Error(`Fusion scout may only use read, grep, and glob; "${event.tool}" is denied before execution.`);
			const decision = guard.cap.consume();
			if (decision === "allow") return;
			if (decision === "terminate") guard.terminate();
			throw new Error("Tool call limit reached. Answer now with what you have.");
		});
		await ctx.session.hook("context", (event) => {
			// Bind the session's latest turn to its agent: completion events are
			// only handled for turns the Fusion agent drove.
			if (typeof event.sessionID === "string" && event.sessionID) {
				turnAgent.set(event.sessionID, event.agent);
				if (turnAgent.size > 32) { const oldest = turnAgent.keys().next().value; if (oldest !== undefined) turnAgent.delete(oldest); }
			}
			if (event.agent === "fusion") delete event.tools.subagent;
			// Match requireSupervisor at discovery time too. Showing Build tools
			// it cannot execute seeds misleading failures into the conversation
			// before the user switches to Fusion.
			else for (const name of FUSION_TOOLS) delete event.tools[name];
			// Defense in depth: hide every non-allowlisted tool from the scout agent
			// when the host exposes child sessions here. The execute.before guard
			// above stays the enforced boundary either way.
			if (event.agent === SCOUT_AGENT) for (const name of Object.keys(event.tools)) if (!SCOUT_TOOLS.has(name)) delete event.tools[name];
			// Persistent-mode gating (mode off is the default): mutation tools are
			// visible to the fusion agent only while its session runs a run. The
			// event fires per turn, so toggling applies from the next turn. The
			// host refuses calls to tools absent from this record, so hiding here
			// is enforced availability, not guidance.
			if (event.agent === "fusion" && !fusionMode) {
				const sessionID = typeof event.sessionID === "string" ? event.sessionID : undefined;
				if (!runs.get(sessionID ?? "")?.controller.state.runActive) for (const name of FUSION_GATED_TOOLS) delete event.tools[name];
			}
			if (event.sessionID) {
				turnVisibility.set(event.sessionID, { agent: event.agent, tools: FUSION_TOOLS.filter((name) => Object.hasOwn(event.tools, name)).sort() });
				if (turnVisibility.size > 32) turnVisibility.delete(turnVisibility.keys().next().value!);
			}
		});
		// Native agent contribution (pinned live on OpenCode v2.2.5; see
		// docs/opencode-install-and-config-plan.md step 1): the agent editor has
		// no `add` method — `update()` on a missing ID creates the agent from an
		// `Agent.Info.default` draft — so Fusion contributes its supervisor,
		// executor, and scout through update-on-missing. Markdown/config-defined
		// agents with the same ID keep precedence over plugin contributions on
		// this host, which is exactly the collision policy: a legacy manual
		// install stays authoritative and is never silently overridden.
		// Conflicts are detected in the transform callback when the editor
		// already exposes the legacy agent, and — authoritatively — by
		// re-reading the merged registry at query time (agentReport below),
		// because the first transform replay may run before Markdown agents are
		// visible in its editor. The transform callback runs after setup returns
		// and replays on every registry rebuild, so contribution state is
		// deduplicated here and registry reads are never awaited inside setup
		// (a read awaited in setup never resolves on this host).
		const agentContribution: { supported: boolean; contributed: string[]; acceptedLegacy: string[]; conflicts: { id: string; differences: string[] }[] } = {
			supported: typeof ctx.agent?.transform === "function",
			contributed: [],
			acceptedLegacy: [],
			conflicts: [],
		};
		const agentRegistration = agentContribution.supported ? await ctx.agent!.transform((editor) => {
			for (const definition of FUSION_AGENTS) {
				const existing = editor.get(definition.id);
				if (existing) {
					const differences: string[] = [];
					if (existing.mode !== definition.mode) differences.push("mode");
					if ((existing.description ?? "") !== definition.description) differences.push("description");
					if ((existing.system ?? "") !== definition.system) differences.push("system");
					if (!fusionPermissionsEqual(existing.permissions, definition.permissions)) differences.push("permissions");
					if (differences.length === 0) {
						if (!agentContribution.acceptedLegacy.includes(definition.id)) agentContribution.acceptedLegacy.push(definition.id);
					} else if (!agentContribution.conflicts.some((conflict) => conflict.id === definition.id)) {
						agentContribution.conflicts.push({ id: definition.id, differences });
					}
					continue;
				}
				editor.update(definition.id, (agent) => {
					agent.mode = definition.mode;
					agent.description = definition.description;
					agent.system = definition.system;
					agent.permissions = definition.permissions.map((rule) => ({ action: rule.action, resource: rule.resource, effect: rule.effect }));
				});
				if (!agentContribution.contributed.includes(definition.id)) agentContribution.contributed.push(definition.id);
			}
		}) : undefined;
		/** Authoritative agent report at query time. The transform callback runs
		 * before Markdown/config agents are guaranteed visible in its editor
		 * (live-observed on v2.2.5: first replay may not see them, later replays
		 * do), so detection recorded during the transform is advisory; this read
		 * — safe outside setup, where registry reads never resolve — reconciles
		 * what actually holds in the merged registry. */
		async function agentReport(): Promise<{ supported: boolean; contributed: string[]; acceptedLegacy: string[]; conflicts: { id: string; differences: string[] }[]; observed?: { id: string; state: "available" | "conflict" | "unavailable"; differences?: string[] }[] }> {
			if (!agentContribution.supported) return { ...agentContribution, observed: [] };
			const report = { ...agentContribution, observed: [] as { id: string; state: "available" | "conflict" | "unavailable"; differences?: string[] }[] };
			if (typeof ctx.agent?.list !== "function") return report;
			try {
				const listed = await ctx.agent.list();
				const agents = Array.isArray(listed) ? listed : Array.isArray((listed as { data?: unknown[] })?.data) ? (listed as { data: unknown[] }).data : [];
				const byId = new Map<string, AgentRecord>();
				for (const agent of agents) if (agent && typeof (agent as AgentRecord).id === "string") byId.set((agent as AgentRecord).id, agent as AgentRecord);
				for (const definition of FUSION_AGENTS) {
					const agent = byId.get(definition.id);
					if (!agent) { report.observed!.push({ id: definition.id, state: "unavailable" }); continue; }
					const differences: string[] = [];
					if (agent.mode !== definition.mode) differences.push("mode");
					if ((agent.description ?? "") !== definition.description) differences.push("description");
					if ((agent.system ?? "") !== definition.system) differences.push("system");
					if (!fusionPermissionsEqual(agent.permissions, definition.permissions)) differences.push("permissions");
					report.observed!.push(differences.length > 0 ? { id: definition.id, state: "conflict", differences } : { id: definition.id, state: "available" });
				}
			} catch {
				/* the registry read is unavailable: the advisory transform state stands */
			}
			return report;
		}
		const storageKey = `run/${createHash("sha256").update(ctx.location.directory).digest("hex")}`;
		async function makeRun(sessionID: string, record?: RunManifest): Promise<Run> {
			const toolContexts = new WeakMap<WorkerHandle, ToolContext>();
			const workerOwner = { harness: "opencode", supervisorId: sessionID, workspace };
			// The run object is referenced by the runtime's usage events; the
			// holder stays empty until the run exists below.
			const runRef: { current?: Run } = {};
			const runtime = createOpenCodeWorkerRuntime<ToolContext>({
				execute: native!.execute,
				contextFor: (request) => { const toolContext = toolContexts.get(request.worker); if (!toolContext) throw new Error("OpenCode tool context is unavailable."); return toolContext; },
				interrupt: typeof ctx.session.interrupt === "function" ? ((childSessionID: string) => Promise.resolve(ctx.session.interrupt!({ sessionID: childSessionID, resume: false }))) : undefined,
				bus: busHost ? { add: (sink) => { busSinks.add(sink); return () => { busSinks.delete(sink); }; } } : undefined,
				validateReference: async (reference) => {
					const [parent, child] = await Promise.all([ctx.session.get({ sessionID }), ctx.session.get({ sessionID: reference.id })]);
					if (parent.id !== sessionID || !parent.location?.directory || await canonicalize(parent.location.directory) !== workspace || child.id !== reference.id || child.parentID !== sessionID || !child.location?.directory || await canonicalize(child.location.directory) !== workspace) throw new Error("OpenCode child ownership or workspace does not match.");
				},
				onUsage: (info) => {
					const run = runRef.current;
					if (run) checkInFlightCost(sessionID, run, info.delta);
				},
			});
			const state = record ? { ...record.state, delegating: false } : { runActive: false, phase: "idle" as const, settleNudges: 0, delegating: false, executed: false, revisions: 0, finalFixUsed: false, resumePending: false, scoutCalls: 0 };
			const controller = new FusionController(state, services, runtime);
			const runId = record?.runId ?? randomUUID();
			const reference = record?.worker;
			// A configured model reaches the executor handle at creation; the scout
			// role reads it per call from the run record.
			const model = record ? record.model : preferredModel;
			const config: WorkerConfig = { role: "executor", ...(model ? { model } : {}) };
			const handle = record?.pending ? await runtime.restorePending(workerOwner, config, { runId, requestId: record.pending.requestId }, reference) : reference ? await runtime.open(reference, config) : await runtime.create(workerOwner, config);
			if (record?.pending) controller.setPending({ action: record.pending.action, requestId: record.pending.requestId });
			controller.setUncertain(!!record && record.recovery !== "settled");
			// A restored run's policy and consumed budgets are read fail-closed
			// here: restart cannot reset them, and a malformed record surfaces
			// instead of silently running unlimited.
			if (record?.adapterData) {
				readRunControlPolicy((record.adapterData as Record<string, unknown>).fusionPolicy);
				readRunBudget((record.adapterData as Record<string, unknown>).fusionBudget);
			}
			const run: Run = { controller, handle, runtime, runId, lastResult: record?.lastResult, model,
				// A fresh run adopts the location's configured limits before any
				// work starts (scouting included); a restored run keeps its own.
				adapterData: record?.adapterData ?? (preferredPolicyRef.current ? { fusionPolicy: structuredClone(preferredPolicyRef.current) } : undefined),
				incomplete: (record?.adapterData as { fusionIncomplete?: unknown } | undefined)?.fusionIncomplete === true, setContext(worker, context) { toolContexts.set(worker, context); } };
			runRef.current = run;
			return run;
		}
		const store = createManifestStore({
			read: () => ctx.storage.get(storageKey), write: async (value) => { await ctx.storage.set(storageKey, value); }, remove: async () => { await ctx.storage.remove(storageKey); },
		}, { harness: "opencode", workspace }, (raw) => {
			const legacy = translateOpenCodeV1(raw, ctx.location.directory, OPENCODE_CAPABILITIES);
			legacy.owner.workspace = workspace;
			if (legacy.worker) legacy.worker.owner.workspace = workspace;
			return legacy;
		});
		let localSaved = await store.load();
		const sharedSaved = await registry.inspect(workspace);
		if (!sharedSaved && localSaved) {
			const archived = await registry.archived(localSaved.runId);
			if (archived && archived.owner.harness === "opencode" && archived.owner.workspace === workspace && archived.owner.supervisorId === localSaved.owner.supervisorId && archived.recovery === "settled" &&
				(!localSaved.pending && !localSaved.adapterData?.legacyOpenCode || !!localSaved.pending && (archived.lastResult?.requestId === localSaved.pending.requestId || archived.operatorResolution?.pending?.requestId === localSaved.pending.requestId))) localSaved = undefined;
		}
		if (sharedSaved && sharedSaved.manifest.owner.workspace !== workspace) throw new Error("An overlapping Fusion workspace requires recovery before this location can be used.");
		const saved = sharedSaved?.manifest.owner.harness === "opencode" ? sharedSaved.manifest : localSaved;
		if (saved) {
			if (sharedSaved && (sharedSaved.manifest.runId !== saved.runId || sharedSaved.manifest.owner.harness !== "opencode")) throw new Error("Another Fusion run owns this workspace.");
			const run = await makeRun(saved.owner.supervisorId, saved);
			run.lease = await registry.claim(saved, sharedSaved?.token);
			runs.set(saved.owner.supervisorId, run);
			owner = saved.owner.supervisorId;
		}
		function manifest(run: Run): RunManifest {
			const pending = run.controller.pending;
			if (pending?.action === "resume") throw new Error("OpenCode cannot persist a resume action.");
			return readRunManifest({ version: 2, runId: run.runId, owner: run.handle.owner,
				state: { ...run.controller.state, delegating: !!pending && run.controller.state.delegating }, worker: run.handle.reference,
				capabilities: run.runtime.capabilities, recovery: pending ? "pending" : run.controller.uncertain ? "manual" : "settled",
				pending, lastResult: run.lastResult, model: run.model, adapterData: run.adapterData }, { harness: "opencode", workspace });
		}
		async function persist(_sessionID: string, run: Run, settled = false): Promise<void> {
			if (!run.lease) throw new Error("Fusion workspace has not been claimed.");
			const operation = (run.persistFlight ?? Promise.resolve()).catch(() => {}).then(async () => {
				const value = { ...manifest(run), ...(settled ? { recovery: "settled" as const } : {}) };
				await run.lease!.save(value);
				await store.save(value);
			});
			run.persistFlight = operation;
			try { await operation; } finally { if (run.persistFlight === operation) run.persistFlight = undefined; }
		}
		async function saveStop(sessionID: string, run: Run, stop: ExecutorStop): Promise<void> {
			if (!run.lease) return;
			if (!await stopWait(persist(sessionID, run), 250)) stop.persistenceWarning = true;
		}
		async function stopNotice(sessionID: string, stop: ExecutorStop): Promise<void> {
			if (!ctx.session.synthetic) return;
			const text = stopFeedback(stop);
			try { await ctx.session.synthetic({ sessionID, text, description: `Fusion executor stop\n${text}`, resume: false, metadata: { fusionStop: { ...stop } } }); } catch {}
		}
		async function confirmStop(sessionID: string, run: Run, stop: ExecutorStop, terminal: "completed" | "error" | "cancelled"): Promise<void> {
			if (stop.state === "confirmed") return;
			stop.state = "confirmed";
			stop.terminal = terminal;
			stop.updatedAt = Date.now();
			// A bus-read stop may be a validated copy, not the stored record.
			run.adapterData = { ...run.adapterData, fusionStop: stop };
			await run.monitor?.finish("stopped", stopRecoveryLine(run));
			await saveStop(sessionID, run, stop);
			await stopNotice(sessionID, stop);
		}
		async function interruptExecutor(sessionID: string, run: Run, stop: ExecutorStop): Promise<void> {
			if (run.interruptFlight) return run.interruptFlight;
			const operation = (async () => {
				const confirmed = () => stop.state === "confirmed";
				const reference = run.handle.reference;
				if (!reference || confirmed() || run.controller.pending?.requestId !== stop.requestId) return;
				stop.childSessionID = reference.id;
				try {
					const child = await ctx.session.get({ sessionID: reference.id });
					if (child.id !== reference.id || child.parentID !== sessionID || !child.location?.directory || await canonicalize(child.location.directory) !== workspace || reference.owner.supervisorId !== sessionID || reference.owner.workspace !== workspace) throw new Error("Executor ownership does not match this Fusion session.");
					if (run.controller.pending?.requestId !== stop.requestId || confirmed()) return;
					const interruption = run.runtime.abort(run.handle);
					run.turnAbort?.abort(new Error("Fusion executor stop requested."));
					await interruption;
					if (!confirmed()) stop.state = "acknowledged";
				} catch (error) {
					if (!confirmed()) { stop.state = "failed"; stop.error = shortLabel(error instanceof Error ? error.message : String(error), 160); }
				} finally {
					run.turnAbort?.abort(new Error("Fusion executor stop requested."));
					stop.updatedAt = Date.now();
					// A bus-read stop may be a validated copy, not the stored record.
					run.adapterData = { ...run.adapterData, fusionStop: stop };
					await saveStop(sessionID, run, stop);
				}
			})();
			run.interruptFlight = operation;
			try { await operation; } finally { if (run.interruptFlight === operation) run.interruptFlight = undefined; }
		}
		async function stopExecutor(sessionID: string, reason = "User requested stop", kind?: "operator" | "policy"): Promise<ExecutorStop | undefined> {
			const run = runs.get(sessionID);
			if (!run) {
				if (await registry.inspect(workspace)) throw new Error("The Fusion run belongs to another session; stop it from its owning session.");
				return;
			}
			if (owner && owner !== sessionID || run.handle.owner.supervisorId !== sessionID || run.handle.owner.workspace !== workspace) throw new Error("The Fusion run belongs to another session.");
			if (run.stopFlight) return run.stopFlight;
			const operation = (async () => {
				const requestId = run.controller.pending?.requestId ?? `idle:${run.runId}`;
				const existing = readExecutorStop(run.adapterData?.fusionStop);
				if (existing?.requestId === requestId && existing.state === "confirmed") return existing;
				const activity = run.monitor?.snapshot();
				const stop: ExecutorStop = existing?.requestId === requestId ? existing : { requestId, requestedAt: Date.now(), updatedAt: Date.now(), state: "requested", reason: shortLabel(reason, 120), activity: activity?.activity, tools: activity?.tools };
				if (kind === "policy") stop.kind = "policy";
				run.adapterData = { ...run.adapterData, fusionStop: stop, fusionNudge: { ...(run.adapterData?.fusionNudge as object ?? {}), state: "cancelled" } };
				run.monitor?.requestStop();
				const saving = saveStop(sessionID, run, stop);
				if (!run.controller.pending) stop.state = "not-submitted";
				else if (run.handle.reference && (run.controller.submissionBegan || !run.controller.state.delegating)) await stopWait(interruptExecutor(sessionID, run, stop), 1500);
				else run.turnAbort?.abort(new Error("Fusion executor stop requested."));
				// Same run scope: every owned scout is attempted even when the
				// executor attempt above failed or reported not-submitted.
				await stopOwnedScouts(sessionID, run, stop);
				await saving;
				stop.updatedAt = Date.now();
				await saveStop(sessionID, run, stop);
				return stop;
			})();
			run.stopFlight = operation;
			try { return await operation; } finally { if (run.stopFlight === operation) run.stopFlight = undefined; }
		}
		/** Attempt the owned run's scout interruption. Stop scope covers every
		 * scout the run owns: the live fusion_scout call (possibly backgrounded
		 * by the host) and every tracked background guard, deduplicated by
		 * child reference. A scout without a published child reference stays
		 * queued — its delivery rides the child's execution-started event — so
		 * the attempt here never invents a delivery that could not be sent. */
		/** One live interruption per owned scout child, keyed by the child
		 * session and held in memory only (never the persisted record). A
		 * repeated stop awaits the in-flight attempt instead of starting
		 * another one, and the attempt's own follower classifies the record —
		 * delivery, failure with its error, or a ring-confirmed terminal —
		 * whenever the host interrupt actually settles, even after the stop
		 * that started it already returned reporting requested. */
		const scoutInterruptFlights = new Map<string, Promise<void>>();
		function interruptScoutRecord(sessionID: string, run: Run, stop: ExecutorStop, record: ScoutStop, handle: WorkerHandle): Promise<void> {
			const key = record.childSessionID;
			if (key === undefined) return Promise.resolve();
			const existing = scoutInterruptFlights.get(key);
			if (existing) return existing;
			const settled = (): boolean => record.state === "confirmed";
			const operation = run.runtime.abort(handle).then(async () => {
				if (!settled()) { record.state = "acknowledged"; record.updatedAt = Date.now(); }
				const observed = recentChildTerminals.find((entry) => entry.childSessionID === key && entry.created > stop.requestedAt);
				if (observed && !settled()) { record.state = "confirmed"; record.terminal = observed.terminal; record.updatedAt = Date.now(); }
				run.adapterData = { ...run.adapterData, fusionStop: stop };
				await saveStop(sessionID, run, stop);
			}, async (error: unknown) => {
				if (!settled()) { record.state = "failed"; record.error = shortLabel(error instanceof Error ? error.message : String(error), 160); record.updatedAt = Date.now(); run.adapterData = { ...run.adapterData, fusionStop: stop }; await saveStop(sessionID, run, stop); }
			}).finally(() => { scoutInterruptFlights.delete(key); });
			scoutInterruptFlights.set(key, operation);
			return operation;
		}
		async function stopOwnedScouts(sessionID: string, run: Run, stop: ExecutorStop): Promise<void> {
			const at = Date.now();
			const candidates = new Map<string, { handle?: WorkerHandle; childSessionID?: string; requestId?: string }>();
			if (activeScout) {
				const key = activeScout.childSessionID ?? `request:${activeScout.requestId ?? "unidentified"}`;
				candidates.set(key, { handle: activeScout.entry.handle, childSessionID: activeScout.childSessionID, requestId: activeScout.requestId });
			}
			for (const [childSessionID, entry] of scoutGuards) {
				if (activeScout && activeScout.childSessionID === childSessionID) continue;
				candidates.set(childSessionID, { handle: entry.handle, childSessionID });
			}
			let scouts = stop.scouts ? [...stop.scouts] : [];
			const findRecord = (childSessionID: string | undefined, requestId: string | undefined): ScoutStop | undefined => {
				if (childSessionID) { const hit = scouts.find((record) => record.childSessionID === childSessionID); if (hit) return hit; }
				if (requestId) { const hit = scouts.find((record) => record.childSessionID === undefined && record.requestId === requestId); if (hit) return hit; }
				return undefined;
			};
			for (const candidate of candidates.values()) {
				const record = (candidate.childSessionID ?? candidate.requestId) !== undefined ? findRecord(candidate.childSessionID, candidate.requestId) : undefined;
				if (record && !record.requestId && candidate.requestId) record.requestId = candidate.requestId;
				const current: ScoutStop = record ?? { requestedAt: at, updatedAt: at, state: "requested", ...(candidate.childSessionID ? { childSessionID: candidate.childSessionID } : {}), ...(candidate.requestId ? { requestId: candidate.requestId } : {}), detail: "scout was inside the stop scope" };
				// A proven terminal record is never re-attempted or re-reported,
				// regardless of what a concurrent bus event confirms in between.
				const confirmed = (): boolean => current.state === "confirmed";
				if (confirmed()) continue;
				if (!record) scouts = [...scouts, current];
				// A queued record adopts its published child reference here, so a
				// later stop or the bus can send and confirm its delivery.
				if (record && !record.childSessionID && candidate.childSessionID) record.childSessionID = candidate.childSessionID;
				if (!current.childSessionID) continue; // still queued until the child publishes its reference
				if (!candidate.handle) continue; // a foreign child cannot be interrupted through a handle here; its record stays queued until the child's terminal event
				try {
					// The attempt runs as a shared flight (see interruptScoutRecord):
					// a repeated stop awaits the live attempt instead of starting
					// another, and the three outcomes stay distinct — a fulfilled
					// abort is delivery, a rejected abort is a failure with its
					// error, and a bounded timeout is an unconfirmed in-flight
					// delivery ("requested"), never an acknowledged one.
					await stopInterruptOutcome(interruptScoutRecord(sessionID, run, stop, current, candidate.handle), 1500);
				} catch (error) {
					if (!confirmed()) { current.state = "failed"; current.error = shortLabel(error instanceof Error ? error.message : String(error), 160); current.updatedAt = Date.now(); }
				}
				// The stop's own interrupt fires the child's terminal event;
				// when the sink already saw it, the record confirms from that
				// evidence instead of waiting for a delivery that passed. This
				// runs after the delivery classification so a terminal outcome
				// observed in the ring always wins.
				const observed = recentChildTerminals.find((entry) => entry.childSessionID === current.childSessionID && entry.created > stop.requestedAt);
				if (observed && !confirmed()) { current.state = "confirmed"; current.terminal = observed.terminal; current.updatedAt = Date.now(); }
			}
			// Only mark the scope when there is something in it: a scope-less
			// stop leaves the legacy executor-only record shape untouched.
			if (candidates.size > 0) stop.scouts = scouts;
		}
		/** Confirm one scout record from a terminal execution event, persisting
		 * the record and reporting through the same bounded notice. The record
		 * read back from the stored stop may be a fresh validated copy; the
		 * mutated stop is written back before persistence. */
		async function confirmScoutStop(sessionID: string, run: Run, stop: ExecutorStop, record: ScoutStop, terminal: "completed" | "error" | "cancelled"): Promise<void> {
			record.state = "confirmed";
			record.terminal = terminal;
			record.updatedAt = Date.now();
			run.adapterData = { ...run.adapterData, fusionStop: stop };
			await saveStop(sessionID, run, stop);
			await stopNotice(sessionID, stop);
		}
		/** Send a queued scout delivery once its child reference is live; the
		 * scout analog of the executor's execution-started trigger. The
		 * attempt itself is the shared per-child flight, so a repeated stop
		 * or an earlier queued dispatch never double-interrupts. */
		async function interruptQueuedScout(sessionID: string, run: Run, stop: ExecutorStop, record: ScoutStop): Promise<void> {
			if (!stop.scouts || !record.childSessionID || record.state === "confirmed") return;
			const guard = scoutGuards.get(record.childSessionID);
			if (!guard?.handle) return;
			await stopInterruptOutcome(interruptScoutRecord(sessionID, run, stop, record, guard.handle), 1500);
			await saveStop(sessionID, run, stop);
		}
		const onStopBusEvent = (event: { created?: number; type: string; data?: Record<string, unknown> }): void => {
			if (typeof event.created !== "number" || typeof event.data?.sessionID !== "string") return;
			// Feed the recent-terminal ring before anything else: the stop's own
			// interrupt can fire a terminal event that lands before it writes
			// its per-worker record, so stops adopt already-seen evidence.
			const scoutTerminal = event.type === "session.execution.interrupted" ? "cancelled" : event.type === "session.execution.succeeded" ? "completed" : event.type === "session.execution.failed" ? "error" : undefined;
			if (scoutTerminal) {
				recentChildTerminals.push({ childSessionID: event.data.sessionID, terminal: scoutTerminal, created: event.created });
				if (recentChildTerminals.length > 100) recentChildTerminals.splice(0, recentChildTerminals.length - 100);
				// A child whose execution ended cannot be waiting anymore: its
				// background wait observation is disposed with it (R3).
				releaseChildWait(event.data.sessionID);
			}
			for (const [sessionID, run] of runs) {
				const stop = readExecutorStop(run.adapterData?.fusionStop);
				if (!stop || stop.state === "confirmed" || event.created <= stop.requestedAt || stop.requestId !== run.controller.pending?.requestId || run.handle.reference?.id !== event.data.sessionID) continue;
				if (event.type === "session.execution.started") void interruptExecutor(sessionID, run, stop);
				const terminal = event.type === "session.execution.interrupted" ? "cancelled" : event.type === "session.execution.succeeded" ? "completed" : event.type === "session.execution.failed" ? "error" : undefined;
				if (terminal) void confirmStop(sessionID, run, stop, terminal);
			}
			// Scout children report through the same execution events: confirm
			// each stop-scope record's terminal outcome, and send a queued
			// delivery when a child starts.
			for (const [sessionID, run] of runs) {
				const stop = readExecutorStop(run.adapterData?.fusionStop);
				if (!stop?.scouts || event.created <= stop.requestedAt) continue;
				for (const record of stop.scouts!) {
					const stateIsConfirmed = record.state === "confirmed";
					const childMatch = record.childSessionID === event.data.sessionID;
					const hasChild = !!record.childSessionID;
					if (!record.childSessionID || record.state === "confirmed" || record.childSessionID !== event.data.sessionID) continue;
					const scoutTerminal = event.type === "session.execution.interrupted" ? "cancelled" : event.type === "session.execution.succeeded" ? "completed" : event.type === "session.execution.failed" ? "error" : undefined;
					if (event.type === "session.execution.started") void interruptQueuedScout(sessionID, run, stop, record);
					if (scoutTerminal) void confirmScoutStop(sessionID, run, stop, record, scoutTerminal);
				}
			}
		};
		busSinks.add(onStopBusEvent);
		function hasUnconfirmedPrompt(run: Run): boolean {
			const prompt = run.adapterData?.fusionPrompt;
			return !!prompt && typeof prompt === "object" && (prompt as { state?: unknown }).state === "pending";
		}
		// R4 guided recovery. The resolution entry matches this module's own
		// install form (checkout script, or the package bin under node_modules);
		// the arguments are shared and exactly quoted. The command is only ever
		// displayed — running it, with its explicit --confirm-stopped, is the
		// operator's action.
		const RESOLVE_ENTRY = resolveCommandEntry(import.meta.url);
		type RecoveryView = { guidance: RecoveryGuidance; line: string };
		/** One shared derivation for the run's recommended recovery action: the
		 * same facts feed status, resume, and the activity card, so every
		 * surface names the same next step. */
		function runRecovery(run: Run): RecoveryView {
			const status = run.runtime.status(run.handle);
			const guidance = deriveRecoveryGuidance({
				ownership: "own",
				pending: run.controller.pending,
				// The stop record's confirmed flag means a proven terminal outcome;
				// delivery alone never confirms termination.
				stop: readStopFacts(run),
				terminal: run.controller.uncertain ? (status.unsettled ? "recorded" : status.backgroundPending ? "awaitable" : "unprovable") : "none",
				capabilities: run.runtime.capabilities,
				inFlight: !!run.controller.state.delegating || !!run.reconciling,
				incomplete: !!run.incomplete,
				executed: run.controller.state.executed,
				settlementWritePending: (run.adapterData?.fusionSettlement as { state?: unknown } | undefined)?.state === "pending",
				promptDeliveryPending: (run.adapterData?.fusionPrompt as { state?: unknown } | undefined)?.state === "pending",
				nudgeDeliveryPending: (run.adapterData?.fusionNudge as { state?: unknown } | undefined)?.state === "pending",
			});
			return { guidance, line: describeRecoveryLine(guidance, run.runId) };
		}
		function readStopFacts(run: Run): { kind?: "operator" | "policy"; confirmed?: boolean; terminal?: "completed" | "error" | "cancelled" } | undefined {
			const stop = readExecutorStop(run.adapterData?.fusionStop);
			if (!stop) return undefined;
			return { kind: stop.kind, confirmed: stop.state === "confirmed", ...(stop.terminal ? { terminal: stop.terminal } : {}) };
		}
		function describeRecoveryLine(guidance: RecoveryGuidance, runId?: string): string {
			return describeRecoveryGuidance(guidance, {
				resume: "fusion_resume",
				reconcile: "fusion_reconcile",
				delegate: "fusion_delegate",
				reset: "fusion_reset",
				startRun: "/fusion-run",
				resolveCommand: resolveOperatorCommand({ entry: RESOLVE_ENTRY, workspace, runId, requestId: guidance.pending?.requestId }),
			});
		}
		/** The shared derivation for a record this session does not own. */
		function foreignRecovery(manifest: RunManifest): RecoveryView {
			const guidance = deriveRecoveryGuidance({
				ownership: "foreign",
				owner: manifest.owner,
				pending: manifest.pending,
				terminal: manifest.recovery === "settled" ? "none" : "unprovable",
				capabilities: manifest.capabilities,
			});
			return { guidance, line: describeRecoveryLine(guidance, manifest.runId) };
		}
		function recoveryPayload(guidance: RecoveryGuidance) {
			return {
				action: guidance.action,
				category: guidance.category,
				reason: guidance.reason,
				confirmationRequired: guidance.confirmationRequired,
				owed: isRecoveryOwed(guidance.action),
				...(guidance.pending ? { pending: guidance.pending } : {}),
			};
		}
		/** The activity card's recovery line: only for actions an operator
		 * must act on (owed recovery, or a stopped run's release step).
		 * Protocol steps and in-flight waits stay on status/resume. */
		function cardRecoveryLine(run: Run): string | undefined {
			const view = runRecovery(run);
			return isRecoveryOwed(view.guidance.action) || view.guidance.action === "start-new" ? view.line : undefined;
		}
		/** The recovery line for a stopped run's card, derived at the stop
		 * with the live transition excluded (the stop is the transition):
		 * a proven or never-submitted outcome releases the run; anything
		 * else stays unprovable until evidence lands. Status and resume
		 * remain the live surfaces. */
		function stopRecoveryLine(run: Run): string {
			const stop = readExecutorStop(run.adapterData?.fusionStop);
			const guidance = deriveRecoveryGuidance({
				ownership: "own",
				pending: run.controller.pending,
				stop: stop ? { kind: stop.kind, confirmed: stop.state === "confirmed", ...(stop.terminal ? { terminal: stop.terminal } : {}) } : { kind: "operator" },
				terminal: stop?.state === "confirmed" || stop?.state === "not-submitted" ? "none" : "unprovable",
				capabilities: run.runtime.capabilities,
				executed: run.controller.state.executed,
			});
			return describeRecoveryLine(guidance, run.runId);
		}
		// R2 run time and cost policies. Only the executor and scout roles are
		// observable on this host (the supervisor's own turn is not surfaced
		// to plugins); budget displays state that honestly, and limits apply
		// to observed accounting, never a strict ceiling.
		const BUDGET_ROLES_OPENCODE: readonly BudgetRole[] = ["executor", "scout"];
		/** The run's persisted policy, read fail-closed: a malformed record
		 * throws instead of silently lifting a limit. */
		function runPolicy(run: Run): RunControlPolicy | undefined {
			return readRunControlPolicy((run.adapterData as Record<string, unknown> | undefined)?.fusionPolicy);
		}
		/** The run's live budget record (identity-preserving, like the stop
		 * record): validation is fail-closed, and accounting mutates the
		 * stored object so persistence rides the next manifest write. */
		function runBudget(run: Run): RunBudget {
			const stored = (run.adapterData as Record<string, unknown> | undefined)?.fusionBudget;
			if (stored === undefined || stored === null) {
				const fresh = createRunBudget();
				run.adapterData = { ...run.adapterData, fusionBudget: fresh };
				return fresh;
			}
			readRunBudget(stored);
			return stored as RunBudget;
		}
		function evaluateRunPolicy(run: Run): ReturnType<typeof evaluateRunBudget> {
			const model = run.model;
			return evaluateRunBudget(runPolicy(run), runBudget(run), { observableRoles: BUDGET_ROLES_OPENCODE });
		}
		/** The submission refusal for a budget-blocked run, or undefined when
		 * the work may proceed. Only the pre-submission gate consumes the
		 * one-shot unknown-budget waiver, after all setup has passed. */
		async function budgetRefusal(sessionID: string, run: Run, consumeWaiver = false): Promise<string | undefined> {
			const decision = evaluateRunPolicy(run);
			if (decision.waived) {
				if (!consumeWaiver) return undefined;
				runBudget(run).unknownWaiver = false;
				await persist(sessionID, run);
				return undefined;
			}
			if (decision.admit) return undefined;
			return decision.reason;
		}
		/** Arm the bounded active-time timer for a turn about to run; when the
		 * remaining budget elapses mid-turn, cancellation is requested through
		 * the R1 stop path with a policy reason — never by polling. The bound
		 * subtracts the live turn clock's active time, so a clock paused by a
		 * confirmed wait (R3) rearms on resume instead of firing while the
		 * worker is not executing. */
		function armBudgetTimer(sessionID: string, run: Run): void {
			disarmBudgetTimer(run);
			const remaining = remainingActiveMs(runPolicy(run), runBudget(run));
			if (remaining === undefined) return;
			const bound = remaining - (run.turnClock?.active() ?? 0);
			if (bound <= 0) { firePolicyTimeStop(sessionID, run); return; }
			run.budgetTimer = setTimeout(() => {
				run.budgetTimer = undefined;
				if (runs.get(sessionID) !== run) return;
				firePolicyTimeStop(sessionID, run);
			}, bound);
		}
		/** The mid-turn policy stop for a reached active-time limit (shared by
		 * the timer and the rearm-on-resume bound check). */
		function firePolicyTimeStop(sessionID: string, run: Run): void {
			const limit = runPolicy(run)?.activeTimeLimitMs ?? 0;
			void stopExecutor(sessionID, `Fusion policy stop: the run's active time limit of ${formatDuration(limit)} was reached (observed accounting; the in-flight turn may spend slightly beyond it).`, "policy")
				.then((stop) => stop && stopNotice(sessionID, stop))
				.catch(() => {});
		}
		function disarmBudgetTimer(run: Run): void {
			if (run.budgetTimer !== undefined) { clearTimeout(run.budgetTimer); run.budgetTimer = undefined; }
		}
		/** R3: advisory stale-activity threshold (5 minutes without observed
		 * activity). Flagged on inspection only; never an outcome claim. */
		const WAIT_STALE_AFTER_MS = 300000;
		/** Commit the turn's active clock and return the elapsed active ms for
		 * the caller to record exactly once. Idempotent; adds nothing itself.
		 * The turn's wait observation is disposed with the clock (R3): a turn
		 * end without a closing event still closes any open wait honestly. */
		function commitBudgetClock(run: Run): number | undefined {
			const clock = run.turnClock;
			run.turnClock = undefined;
			run.turnClockWorker = undefined;
			run.turnWaits?.reset();
			run.turnWaits = undefined;
			if (!clock) return undefined;
			return clock.stop();
		}
		/** The turn's wait clock, created lazily with its target: an open wait
		 * pauses the live turn clock (waiting time never consumes active
		 * time) and its close rearms the bounded budget timer. */
		function turnWaitClock(sessionID: string, run: Run, worker: "executor" | "scout"): WaitClock {
			if (run.turnWaits) return run.turnWaits;
			run.turnWaits = new WaitClock({
				pause: () => { if (run.turnClockWorker === worker) { run.turnClock?.pause(); disarmBudgetTimer(run); } },
				resume: () => { if (run.turnClockWorker === worker) { run.turnClock?.resume(); armBudgetTimer(sessionID, run); } },
			}, { staleAfterMs: waitStaleAfterMs() });
			return run.turnWaits;
		}
		/** A wait clock for an owned child without a live turn here: observed
		 * for display only; nothing pauses. Bounded per run. */
		function childWaitClock(run: Run, childSessionID: string): WaitClock {
			const waits = run.childWaits ?? new Map<string, WaitClock>();
			run.childWaits = waits;
			let clock = waits.get(childSessionID);
			if (!clock) {
				if (waits.size >= 8) return new WaitClock(undefined, { staleAfterMs: waitStaleAfterMs() });
				clock = new WaitClock(undefined, { staleAfterMs: waitStaleAfterMs() });
				waits.set(childSessionID, clock);
			}
			return clock;
		}
		/** R3: when the worker's turn ends here but its child may still be
		 * executing (backgrounded, or an unknown outcome), every outstanding
		 * wait moves to the child's tracker so each question or permission
		 * request stays visible until the child's turn really ends. */
		function transferTurnWaitToChild(run: Run, childSessionID: string | undefined): void {
			if (!childSessionID) return;
			const clock = run.turnWaits;
			if (!clock) return;
			const child = childWaitClock(run, childSessionID);
			for (const open of clock.outstanding()) {
				child.openWait({ id: open.id, kind: open.kind, label: open.label, startedAt: open.startedAt });
			}
		}
		/** Which run worker owns this child session, if any. Ownership comes
		 * from the executor handle's reference, the live scout, or the tracked
		 * background scout guards; anything else is not ours. */
		function ownedWaitWorker(run: Run, childSessionID: string): "executor" | "scout" | undefined {
			if (run.handle.reference?.id === childSessionID) return "executor";
			if (activeScout?.entry.handle?.owner.supervisorId === run.handle.owner.supervisorId && activeScout.childSessionID === childSessionID) return "scout";
			const guard = scoutGuards.get(childSessionID);
			if (guard?.handle?.owner.supervisorId === run.handle.owner.supervisorId) return "scout";
			return undefined;
		}
		/** Apply one translated wait signal to its run worker. Live turns use
		 * the turn's clock-connected tracker; backgrounded children use a
		 * per-child display tracker. The executor's monitor is updated so the
		 * host UI shows the wait. Unknown event shapes change nothing. */
		function applyWaitSignal(sessionID: string, run: Run, role: "executor" | "scout", childSessionID: string, signal: OpenCodeWaitSignal): void {
			const live = role === "executor"
				? !!(run.controller.state.delegating && run.turnClockWorker === "executor")
				: !!(scoutInFlight && activeScout?.childSessionID === childSessionID && run.turnClockWorker === "scout");
			const clock = live ? turnWaitClock(sessionID, run, role) : childWaitClock(run, childSessionID);
			let opened: OpenWait | undefined;
			if (signal.open) opened = clock.openWait(signal.open);
			const closed = signal.close ? clock.closeWait(signal.close) : undefined;
			if (signal.activity) {
				clock.markActivity({ observation: signal.activity.busy ? "implementing" : "unknown" });
				if (!signal.activity.busy && clock === run.turnWaits) clock.noteStale();
			}
			if (role !== "executor") return;
			// The card names the wait that closed (it may not be the one the
			// card displayed), then shows the oldest one still outstanding.
			if (closed) run.monitor?.waitClosed({ outcome: signal.close?.outcome, kind: closed.kind, label: closed.label });
			const status = clock.status();
			if (status.wait) run.monitor?.waitOpened({ kind: status.wait.kind, label: status.wait.label, since: status.wait.startedAt });
		}
		/** R3 waiting status for fusion_status/stats: the current worker, last
		 * observed activity, active/waiting durations, and the required
		 * action. Absent means nothing is waiting or stale right now. */
		function runWaitStatus(run: Run): Record<string, unknown> | undefined {
			const executorWait = run.turnWaits?.status();
			const activeMs = run.turnClock?.active();
			// The live turn always reports its worker, last observed activity,
			// and durations; an open wait or a stale flag adds the required
			// action on top.
			if (executorWait) {
				const activity = run.monitor?.snapshot();
				const worker = run.turnClockWorker === "scout" ? "Scout" : "Executor";
				const observation: ExecutionObservation = executorWait.wait ? executorWait.wait.kind === "permission" ? "waiting-permission" : executorWait.wait.kind === "user" ? "waiting-user" : "unknown" : run.turnClockWorker === "scout" ? "implementing" : activity?.phase === "starting" ? "starting" : activity?.phase === "stopping" ? "awaiting-reconciliation" : "implementing";
				return {
					worker,
					observation,
					...(activity?.activity ? { lastActivity: activity.activity } : {}),
					...(activeMs !== undefined ? { activeMs } : {}),
					waitingMs: executorWait.waitingMs,
					openWaits: executorWait.openWaits,
					...(executorWait.wait ? { wait: executorWait.wait } : {}),
					stale: executorWait.stale,
				};
			}
			// Owned children without a live turn here (backgrounded executor or
			// scout children) can still be waiting on a permission or question.
			for (const [childSessionID, clock] of run.childWaits ?? []) {
				const status = clock.status();
				if (!status.wait) continue;
				return {
					worker: ownedWaitWorker(run, childSessionID) === "scout" ? "Scout" : "Executor",
					observation: status.wait.kind === "permission" ? "waiting-permission" : status.wait.kind === "user" ? "waiting-user" : "unknown",
					background: true,
					childSessionID,
					waitingMs: status.waitingMs,
					wait: status.wait,
				};
			}
			return undefined;
		}
		/** The required-action line for an open wait, in the shared wording.
		 * A stale live turn (no observed activity for the threshold) gets the
		 * advisory inspection line instead — never an outcome claim. */
		function waitNextAction(run: Run): string | undefined {
			const status = runWaitStatus(run);
			if (!status || typeof status.worker !== "string") return undefined;
			const worker = status.worker as string;
			const observation = (status.observation as ExecutionObservation) ?? "unknown";
			if (status.wait) {
				return describeWaitStatus({
					worker,
					observation,
					activeMs: typeof status.activeMs === "number" ? status.activeMs : undefined,
					waitingMs: typeof status.waitingMs === "number" ? status.waitingMs : undefined,
					wait: status.wait as { kind: WaitKind; label: string; startedAt: number },
				});
			}
			if (status.stale) {
				return describeWaitStatus({
					worker,
					observation,
					lastActivity: typeof status.lastActivity === "string" ? status.lastActivity : undefined,
					activeMs: typeof status.activeMs === "number" ? status.activeMs : undefined,
					stale: true,
				});
			}
			return undefined;
		}
		/** R3: translate one raw bus event into the shared wait signals and
		 * route it to the owned run workers it belongs to. Non-wait events and
		 * unowned children are silent; nothing is invented for either. */
		const onWaitBusEvent = (event: { type: string; data?: Record<string, unknown> }): void => {
			const signal = openCodeWaitSignal(event.type, event.data);
			if (!signal) return;
			for (const [sessionID, run] of runs) {
				if (owner && owner !== sessionID) continue;
				const role = ownedWaitWorker(run, signal.sessionID);
				if (!role) continue;
				try { applyWaitSignal(sessionID, run, role, signal.sessionID, signal); } catch { /* display-only routing never breaks execution */ }
			}
		};
		/** Release one child's wait observation when the host proves its turn
		 * ended; a live-turn clock is left to the turn's own disposal. */
		const releaseChildWait = (childSessionID: string): void => {
			for (const run of runs.values()) run.childWaits?.get(childSessionID)?.reset();
		};
		busSinks.add(onWaitBusEvent);
		/** Advisory stale-activity threshold: five minutes without observed
		 * activity (injectable for fixtures). Flagged on inspection only. */
		const waitStaleAfterMs = (): number => dependencies.waitStaleAfterMs ?? 300000;
		/** Record a turn without a usage reading: its spend stays unknown,
		 * never zero, so a spend-limited run blocks until coverage returns. */
		function recordMissingTurn(run: Run, role: BudgetRole, dedupeKey?: string): void {
			recordRoleUsage(runBudget(run), { role, provider: run.model?.provider, ...(dedupeKey !== undefined ? { dedupeKey } : {}) });
		}
		/** The accumulated observed spend across observable roles, from the
		 * run's budget ledger. */
		function observedCost(run: Run): number {
			const budget = runBudget(run);
			return BUDGET_ROLES_OPENCODE.reduce((sum, role) => sum + (budget.roles[role]?.cost ?? 0), 0);
		}
		/** The mid-turn cost check behind the runtime's usage events: when the
		 * observed total plus this turn's partial delta reaches a configured
		 * spend limit, cancellation is requested through the R1 stop path.
		 * In-flight spend can exceed the threshold; readings are delayed and
		 * the wording never claims a strict ceiling. A stop for this request
		 * is never re-fired while usage events keep streaming. */
		function checkInFlightCost(sessionID: string, run: Run, delta: { cost?: number }): void {
			const policy = runPolicy(run);
			if (!policy || policy.observedCostLimit === undefined) return;
			const pendingId = run.controller.pending?.requestId;
			if (pendingId && readExecutorStop(run.adapterData?.fusionStop)?.requestId === pendingId) return;
			const candidate = observedCost(run) + (delta.cost ?? 0);
			if (candidate < policy.observedCostLimit) return;
			void stopExecutor(sessionID, `Fusion policy stop: observed spending of $${candidate.toFixed(2)} reached the run's $${policy.observedCostLimit} limit (observed accounting; the in-flight turn may spend beyond it).`, "policy")
				.then((stop) => stop && stopNotice(sessionID, stop))
				.catch(() => {});
		}
		/** Aggregate one observed worker turn into the run's persisted usage
		 * record. A turn whose result carried no usage reading counts as missing,
		 * so the totals honestly under-report instead of guessing, and per-field
		 * coverage (`fieldTurns`) keeps a token-carrying turn from making a
		 * cost-only turn's totals look complete. `dedupeKey` suppresses a
		 * re-recorded turn across settlement retries. */
		function recordUsage(run: Run, result: WorkerTurnResult, dedupeKey?: string): void {
			const current = (run.adapterData?.fusionUsage ?? {}) as Record<string, unknown> & { turnsReported?: number; turnsMissing?: number; counted?: string[]; fieldTurns?: Record<string, number> };
			if (dedupeKey && current.counted?.includes(dedupeKey)) return;
			const next: Record<string, unknown> = { ...current };
			next.turnsReported = (current.turnsReported ?? 0) + (result.usage ? 1 : 0);
			next.turnsMissing = (current.turnsMissing ?? 0) + (result.usage ? 0 : 1);
			const fieldTurns = { ...(current.fieldTurns ?? {}) };
			for (const [field, value] of Object.entries(result.usage ?? {})) {
				if (typeof value !== "number" || !Number.isFinite(value)) continue;
				next[field] = (typeof current[field] === "number" ? current[field] as number : 0) + value;
				fieldTurns[field] = (fieldTurns[field] ?? 0) + 1;
			}
			next.fieldTurns = fieldTurns;
			if (dedupeKey) next.counted = [...current.counted ?? [], dedupeKey].slice(-16);
			run.adapterData = { ...run.adapterData, fusionUsage: next };
			// The same turn feeds the run budget's role ledger (R2): per-role
			// observed usage with its own coverage and provider attribution,
			// shared dedupe key so a retried settlement cannot double-count.
			recordRoleUsage(runBudget(run), { role: result.role, usage: result.usage, provider: run.model?.provider, ...(dedupeKey !== undefined ? { dedupeKey } : {}) });
		}
		// The native executor is called directly below; model-originated calls pass
		// through OpenCode's tool hook and must not bypass Fusion's run guards.
		// Both guards (subagent denial and scout cap) live in the single
		// execute.before hook registered above.
		function requireSupervisor(context: ToolContext): void {
			if (context.agent !== "fusion") throw new Error("Fusion tools are available only to the fusion primary agent.");
		}
		/** The flat model catalog; unavailable catalogs leave Fusion on host-default models. */
		async function hostModels(): Promise<readonly (HostModel & { id: string; providerID: string })[]> {
			if (typeof ctx.model?.list !== "function") throw new Error("The OpenCode model catalog is unavailable in this host; configure models through OpenCode itself instead.");
			const response = await ctx.model.list();
			const models = Array.isArray(response?.data) ? response.data : [];
			return models.filter((entry): entry is HostModel & { id: string; providerID: string } => typeof entry?.id === "string" && typeof entry?.providerID === "string");
		}
		/** Validate an explicit provider/model/variant choice against the active catalog. */
		async function validateCatalogModel(provider: string, modelId: string, variant?: string): Promise<{ config: WorkerModelConfig; metadata: Record<string, unknown> }> {
			const models = await hostModels();
			const entry = models.find((candidate) => candidate.providerID === provider && (candidate.id === modelId || candidate.modelID === modelId));
			if (!entry) {
				const known = [...new Set(models.map((candidate) => candidate.providerID))].sort().slice(0, 12).join(", ");
				throw new Error(`"${provider}/${modelId}" is not in the OpenCode model catalog${known ? ` (known providers: ${known})` : ""}. Check opencode models and try again.`);
			}
			if (entry.enabled === false) throw new Error(`"${provider}/${modelId}" is disabled in the OpenCode catalog.`);
			if (variant !== undefined) {
				const variants = (entry.variants ?? []).map((candidate) => typeof candidate?.id === "string" ? candidate.id : "").filter(Boolean);
				if (!variants.includes(variant)) throw new Error(`"${provider}/${modelId}" has no variant "${variant}"${variants.length ? ` (available: ${variants.join(", ")})` : " (no variants)"}.`);
			}
			const fusionModel = { id: entry.id, provider: entry.providerID, name: entry.name ?? "", cost: { output: entry.cost?.[0]?.output } };
			const tier: FusionModelTier = isModelInTier(fusionModel, "supervisor") ? "supervisor" : "executor";
			return {
				config: { provider, modelId, ...(variant !== undefined ? { variant } : {}) },
				metadata: {
					name: entry.name,
					status: entry.status,
					outputPricePerM: getOutputPrice(fusionModel),
					tier,
					recentCohort: RECENT_MODEL_COHORT,
					inRecentCohort: isRecentModel(fusionModel),
				},
			};
		}
		const creating = new Map<string, Promise<Run>>();
		async function runFor(sessionID: string): Promise<Run> {
			const existing = runs.get(sessionID);
			if (existing) return existing;
			let pending = creating.get(sessionID);
			if (!pending) {
				pending = makeRun(sessionID).then((run) => { runs.set(sessionID, run); return run; });
				creating.set(sessionID, pending);
			}
			try { return await pending; } finally { if (creating.get(sessionID) === pending) creating.delete(sessionID); }
		}
		/** Shared run-start control behind fusion_start and the /fusion command. */
		async function startRun(sessionID: string, task: string): Promise<Run> {
			if (resetting || starting || configuring) throw new Error("A Fusion run transition is in progress.");
			if (owner && owner !== sessionID) throw new Error("Another Fusion session owns this workspace. Finish and reset that run first.");
			if (scoutInFlight || hasBackgroundScout()) throw new Error("A Fusion scout is still running; wait for it to stop before starting a run.");
			const run = await runFor(sessionID);
			if (resetting || starting || configuring) throw new Error("A Fusion run transition is in progress.");
			if (readExecutorStop(run.adapterData?.fusionStop)) throw new Error("This Fusion run was stopped. Reconcile retained work and reset before starting another run.");
			if (run.controller.state.runActive || run.controller.state.executed || run.controller.pending || run.controller.uncertain || run.reconciling) throw new Error("Finish and reset the existing Fusion run before starting another.");
			starting = true;
			const priorState = structuredClone(run.controller.state);
			try {
				const parent = await ctx.session.get({ sessionID });
				if (parent.id !== sessionID || !parent.location?.directory || await canonicalize(parent.location.directory) !== workspace) throw new Error("OpenCode supervisor session or workspace does not match.");
				// Scouting that preceded the run start is part of the same run.
				run.controller.start(task, { preserveScoutCalls: true });
				if (!run.lease) run.lease = await registry.claim(manifest(run));
				owner = sessionID;
				await persist(sessionID, run);
				return run;
			} catch (error) {
				// A successful claim is authoritative even if the secondary store fails.
				// Keep that run available for reset rather than releasing ownership silently.
				if (!run.lease) Object.assign(run.controller.state, priorState);
				throw error;
			} finally { starting = false; }
		}
		/** One configuration operation shared by the fusion_configure tool and
		 * the /fusion-config command: validate the selection against the live
		 * catalog before any mutation, serialize with run start/reset/delegation
		 * transitions, persist the preference, and apply it immediately only to
		 * a safely replaceable executor handle — one that cannot have produced
		 * worker work: no submission, no native child to orphan, and no scout
		 * activity or history (scouts run on the run's model, so a mid-run
		 * change would misreport what this run used). Pending, uncertain,
		 * backgrounded, and foreign-owned work never has its handle replaced.
		 * Failures stay retryable: a failed preference write releases the
		 * replacement handle and changes nothing; a failed handle replacement
		 * never reaches the write. */
		async function configureExecutorModel(sessionID: string, selection: { provider: string; modelId: string; variant?: string }): Promise<{ applied: "now" | "next-run"; appliedReason: string; config: WorkerModelConfig; metadata: Record<string, unknown> }> {
			const { config, metadata } = await validateCatalogModel(selection.provider, selection.modelId, selection.variant);
			if (resetting || starting || configuring) throw new Error("A Fusion run transition is in progress.");
			configuring = true;
			try {
				const run = await runFor(sessionID);
				const active = run.runtime.status(run.handle);
				const executorStarted = run.controller.state.executed || !!run.controller.pending || run.controller.uncertain || run.reconciling || active.backgrounded || active.backgroundPending || active.unsettled;
				// Scout work counts: an in-flight or backgrounded scout holds a
				// handle built from the run's model, and completed scouts already
				// consumed their budget on it.
				const scoutActive = scoutInFlight || hasBackgroundScout();
				const scoutDone = run.controller.state.scoutCalls > 0;
				const workStarted = executorStarted || scoutActive || scoutDone;
				let applied: "now" | "next-run";
				let appliedReason = "";
				if (!workStarted && !run.handle.reference) {
					const replacement = await run.runtime.create({ harness: "opencode", supervisorId: sessionID, workspace }, { role: "executor", model: config });
					try { await ctx.storage.set(modelKey, config); } catch (error) { await run.runtime.release(replacement); throw error; }
					await run.runtime.release(run.handle);
					run.handle = replacement;
					run.model = config;
					applied = "now";
				} else {
					await ctx.storage.set(modelKey, config);
					applied = "next-run";
					appliedReason = executorStarted ? "executor work has already started" : scoutActive ? "a Fusion scout is still running" : scoutDone ? "a scout has already run in this run" : "the executor child already exists";
				}
				preferredModel = config;
				if (run.lease) await persist(sessionID, run);
				return { applied, appliedReason, config, metadata };
			} finally { configuring = false; }
		}
		/** Presentation shared by the tool and the command. */
		function formatConfiguredModel(result: { applied: "now" | "next-run"; appliedReason: string; config: WorkerModelConfig; metadata: Record<string, unknown> }): string {
			return `Fusion executor model configured for ${result.applied === "now" ? "this run" : `the next run (${result.appliedReason})`}: ${result.config.provider}/${result.config.modelId}${result.config.variant ? ` (variant ${result.config.variant})` : ""}. The scout uses its run's executor model; the supervisor's model stays OpenCode's own selector. ${JSON.stringify(result.metadata)}`;
		}
		/** Parse /fusion-config text per the published contract. The explicit
		 * selection splits on the FIRST slash so model IDs containing slashes
		 * still work; the variant is one optional whitespace-separated token. */
		function parseConfigCommand(text: string): { action: "show" } | { action: "list"; filter?: string } | { action: "set"; provider: string; modelId: string; variant?: string } | { action: "error"; message: string } {
			const trimmed = text.trim();
			if (!trimmed) return { action: "show" };
			const tokens = trimmed.split(/\s+/);
			if (tokens[0] === "list") {
				const filter = tokens.slice(1).join(" ").trim();
				return { action: "list", ...(filter ? { filter } : {}) };
			}
			if (tokens.length > 2) return { action: "error", message: "Too many arguments." };
			const slash = tokens[0].indexOf("/");
			if (slash <= 0 || slash >= tokens[0].length - 1) return { action: "error", message: "A model selection must be <provider>/<model>." };
			const provider = tokens[0].slice(0, slash);
			const modelId = tokens[0].slice(slash + 1);
			return { action: "set", provider, modelId, ...(tokens[1] !== undefined ? { variant: tokens[1] } : {}) };
		}
		/** Bounded, optionally filtered listing of validated catalog choices. */
		async function listCatalogModels(filter: string | undefined): Promise<string> {
			const enabled = (await hostModels()).filter((entry) => entry.enabled !== false);
			const needle = filter?.toLowerCase();
			const matched = enabled.filter((entry) => !needle || `${entry.providerID}/${entry.id}`.toLowerCase().includes(needle) || (entry.name ?? "").toLowerCase().includes(needle));
			const MAX_LISTED = 40;
			const shown = matched.slice(0, MAX_LISTED);
			const lines = shown.map((entry) => {
				const variants = (entry.variants ?? []).map((candidate) => typeof candidate?.id === "string" ? candidate.id : "").filter(Boolean);
				return `- ${entry.providerID}/${entry.id}${entry.name ? ` (${entry.name})` : ""}${variants.length ? ` [variants: ${variants.join(", ")}]` : ""}`;
			});
			const header = matched.length > MAX_LISTED
				? `${matched.length} models match; showing the first ${MAX_LISTED}. Narrow the output with /fusion-config list <filter>.`
				: `${matched.length} model${matched.length === 1 ? "" : "s"} ${needle ? `matching "${filter}"` : "available"}.`;
			return `${header}\n${lines.join("\n")}`;
		}
		/** The no-argument view: saved preference, current run model, and the
		 * command syntax. Read-only — it never creates a run or claims the
		 * workspace, unlike an explicit selection. */
		function configStatusText(sessionID: string): string {
			const format = (model: WorkerModelConfig | undefined) => model ? `${model.provider}/${model.modelId}${model.variant ? `#${model.variant}` : ""}` : undefined;
			const run = runs.get(sessionID);
			const visible = turnVisibility.get(sessionID);
			return [
				"Fusion executor model configuration.",
				`Fusion mode: ${fusionMode ? "on" : "off"}.`,
				visible ? `Last Fusion context hook: agent=${visible.agent}; tools=${visible.tools.join(", ") || "none"}.` : "Last Fusion context hook: no model turn observed in this session since plugin load.",
				`Saved preference: ${format(preferredModel) ?? "none"}.`,
				`Current run: ${run ? format(run.model) ?? "the host-configured model" : "no run in this session"}.`,
				"Usage:",
				"  /fusion-config <provider>/<model> [variant]",
				"  /fusion-config list [filter]",
				"The selection splits on the first slash, so model IDs containing slashes work.",
				"The executor and the scout share the chosen model; the supervisor's model stays OpenCode's own selector.",
			].join("\n");
		}
		/** Release settled Fusion resources for a session, or a settled workspace record left by another one. */
		async function cleanWorkspace(sessionID: string): Promise<string> {
			if (resetting || starting || configuring || promptInFlight) throw new Error("A Fusion run transition is in progress.");
			// A persistent-mode run stays armed (runActive true) after it settles;
			// phase "complete" is the settled marker, so it releases like any
			// other settled run instead of deadlocking the session's cleanup.
			const cleanable = (state: { runActive: boolean; phase: string }): boolean => state.runActive && state.phase !== "complete";
			const run = runs.get(sessionID);
			if (run) {
				if (run.stopFlight || run.interruptFlight || readExecutorStop(run.adapterData?.fusionStop) && run.persistFlight) throw new Error("Executor stop or persistence is still in progress.");
				if (hasUnconfirmedPrompt(run)) throw new Error("Fusion prompt delivery is unconfirmed. Retry /fusion-run with the same task before cleaning.");
				if (cleanable(run.controller.state)) throw new Error("The Fusion run is still active; finish and reset it before cleaning.");
				const error = run.controller.resetError(false, run.reconciling);
				if (error) throw new Error(`${error} Clean releases settled resources only.`);
				if (scoutInFlight || hasBackgroundScout()) throw new Error("A Fusion scout is still running; wait for it to stop before cleaning.");
				resetting = true;
				try {
					await store.removeSettled(run.runId);
					await run.lease?.release();
					await run.runtime.release(run.handle);
					await run.runtime.shutdown();
					runs.delete(sessionID);
					forgetTurnState(sessionID);
					if (owner === sessionID) owner = undefined;
					return "Released Fusion resources for this session.";
				} finally { resetting = false; }
			}
			resetting = true;
			try {
				const owned = await registry.inspect(workspace);
				if (!owned) return "No Fusion resources to clean in this workspace.";
				if (owned.manifest.recovery !== "settled") throw new Error(`The workspace Fusion record is ${owned.manifest.recovery}; reconcile it or run the explicit operator resolution before cleaning.`);
				if (owned.manifest.state.runActive && owned.manifest.state.phase !== "complete" || scoutInFlight || hasBackgroundScout()) throw new Error("A Fusion run or scout is still active; clean it from its owning session after it finishes.");
				// An adopted run's held lease is the same record: release through it
				// rather than claiming the workspace a second time in this process.
				const holder = [...runs.values()].find((candidate) => candidate.lease && candidate.lease.manifest.runId === owned.manifest.runId);
				if (holder?.lease) {
					const error = holder.controller.resetError(false, holder.reconciling);
					if (error || cleanable(holder.controller.state)) throw new Error("The owning Fusion run is still active; clean it from its owning session after it finishes.");
					await store.removeSettled(holder.runId);
					await holder.lease.release();
					holder.lease = undefined;
					await holder.runtime.release(holder.handle);
					await holder.runtime.shutdown();
					runs.delete(holder.handle.owner.supervisorId);
					forgetTurnState(holder.handle.owner.supervisorId);
					if (owner === holder.handle.owner.supervisorId) owner = undefined;
					return "Released settled Fusion ownership for this workspace.";
				}
				// Claim-then-release archives the settled record without touching any transcript.
				const lease = await registry.claim(owned.manifest, owned.token);
				await lease.release();
				return "Released settled Fusion ownership for this workspace.";
			} finally { resetting = false; }
		}
		/** User-driven /fusion-budget: the only path that changes run limits
		 * (the supervisor's tools can read them, never raise or clear them).
		 * With a run in this session the change applies to that run's
		 * persisted policy and persists immediately; without one it applies
		 * to the next run in this location via the stored preference.
		 * `continue` grants the one-shot unknown-budget waiver. */
		async function budgetCommand(sessionID: string, text: string): Promise<string> {
			const parseDuration = (raw: string): number | undefined => {
				const match = /^(\d+)(ms|s|m|h)?$/.exec(raw);
				if (!match) return undefined;
				const value = Number(match[1]);
				const unit = match[2] ?? "ms";
				return value * (unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000);
			};
			const run = runs.get(sessionID);
			const working = (): { policy: RunControlPolicy; runScoped: boolean } => {
				const runScoped = run !== undefined;
				return { policy: structuredClone(runScoped ? runPolicy(run) : preferredPolicy) ?? { version: 1 }, runScoped };
			};
			const commit = async (policy: RunControlPolicy | undefined, runScoped: boolean): Promise<void> => {
				if (policy) readRunControlPolicy(policy);
				if (runScoped && run) {
					run.adapterData = { ...run.adapterData, fusionPolicy: policy };
					await persist(sessionID, run);
				} else {
					if (policy) await ctx.storage.set(policyKey, policy);
					else await ctx.storage.set(policyKey, undefined);
					preferredPolicyRef.current = policy;
				}
			};
			const tokens = text.trim().split(/\s+/).filter(Boolean);
			if (tokens.length === 0 || tokens[0] === "show") {
				const lines = describeRunBudget(run ? runPolicy(run) : preferredPolicyRef.current, run ? runBudget(run) : createRunBudget(), { observableRoles: BUDGET_ROLES_OPENCODE });
				lines.push("Set limits: /fusion-budget time 30m | cost 5 | token <provider> <tokens> | clear time|cost|token <provider>|all | continue (waive one unknown-budget block).");
				return lines.join("\n");
			}
			const action = tokens[0];
			const { policy, runScoped } = working();
			if (action === "time" || action === "cost") {
				const value = tokens[1] !== undefined ? (action === "time" ? parseDuration(tokens[1]) : Number(tokens[1])) : undefined;
				if (value === undefined || !Number.isFinite(value) || value <= 0) throw new Error(`Provide a positive ${action === "time" ? "duration like 30m" : "dollar amount"}.`);
				if (action === "time") policy.activeTimeLimitMs = Math.round(value);
				else policy.observedCostLimit = value;
				await commit(policy, runScoped);
				return `Fusion run limit set for ${runScoped ? "this run" : "the next run"}: ${action} ${action === "time" ? formatDuration(policy.activeTimeLimitMs!) : `$${policy.observedCostLimit}`} (observed accounting, not a strict ceiling).`;
			}
			if (action === "token") {
				const provider = tokens[1];
				const count = tokens[2] !== undefined ? Number(tokens[2]) : undefined;
				if (!provider || count === undefined || !Number.isFinite(count) || count <= 0) throw new Error("Provide a provider and a positive token count: /fusion-budget token <provider> <tokens>.");
				policy.providerTokenCeilings = { ...policy.providerTokenCeilings, [provider]: Math.round(count) };
				await commit(policy, runScoped);
				return `Fusion run limit set for ${runScoped ? "this run" : "the next run"}: tokens ${provider} ≤ ${Math.round(count).toLocaleString("en-US")}.`;
			}
			if (action === "clear") {
				const target = tokens[1];
				if (target === "time") delete policy.activeTimeLimitMs;
				else if (target === "cost") delete policy.observedCostLimit;
				else if (target === "token" && tokens[2]) { const ceilings = { ...policy.providerTokenCeilings }; delete ceilings[tokens[2]]; policy.providerTokenCeilings = Object.keys(ceilings).length > 0 ? ceilings : undefined; }
				else if (target === "all") { delete policy.activeTimeLimitMs; delete policy.observedCostLimit; delete policy.providerTokenCeilings; }
				else throw new Error("Clear what? /fusion-budget clear time|cost|token <provider>|all.");
				const empty = policy.activeTimeLimitMs === undefined && policy.observedCostLimit === undefined && policy.providerTokenCeilings === undefined;
				await commit(empty ? undefined : policy, runScoped);
				return `Fusion run limit cleared (${target}) for ${runScoped ? "this run" : "the next run"}${empty ? "; no limits remain" : ""}.`;
			}
			if (action === "continue") {
				if (!run) return "No Fusion run in this session; nothing is blocked.";
				runBudget(run).unknownWaiver = true;
				await persist(sessionID, run);
				return "Fusion run budget: one admission will proceed despite incomplete cost readings; the block returns afterwards unless readings become complete.";
			}
			throw new Error("Unknown /fusion-budget action. Use: show | time <duration> | cost <dollars> | token <provider> <tokens> | clear time|cost|token <provider>|all | continue.");
		}
		// R5 diagnostics. The default report is local and read-only: the host's
		// own model catalog through the existing validateCatalogModel resolver,
		// the runtime's capability view, the read-only ownership storage probe,
		// the agent registry report, and the shared R4 recovery derivation. It
		// never performs a model call, never touches the native subagent, and
		// never carries a credential value. The auth probe is a separate
		// explicit action and states honestly that this host exposes no local
		// credential validation to the plugin.
		const FUSION_COMMAND_NAMES = ["fusion-run", "fusion-mode", "fusion-config", "fusion-budget", "fusion-status", "fusion-stats", "fusion-resume", "fusion-clean", "fusion-stop", "fusion-doctor"];
		const SUPPORTED_HOST_RANGE = "v2.2.3 – v2.2.5";
		function hostSupportsOpenCode(version: string | undefined): boolean | undefined {
			if (version === undefined) return undefined;
			const parsed = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
			if (!parsed) return undefined;
			const [major, minor, patch] = [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])];
			return major === 2 && minor === 2 && patch >= 3 && patch <= 5;
		}
		async function doctorFacts(sessionID: string): Promise<DoctorFacts> {
			const identity = await loadedPackageIdentity(import.meta.url);
			const fusionVersion = identity ? `${identity.name}@${identity.version}` : "unknown";
			const hostVersion = typeof ctx.app?.version === "string" && ctx.app.version.trim() ? ctx.app.version.trim() : undefined;
			const run = runs.get(sessionID);
			const configured = run?.model ?? preferredModel;
			const modelFacts: DoctorModelFact[] = [];
			if (configured) {
				try {
					const { metadata } = await validateCatalogModel(configured.provider, configured.modelId, configured.variant);
					modelFacts.push({
						role: "executor",
						label: `${configured.provider}/${configured.modelId}${configured.variant ? `#${configured.variant}` : ""}`,
						inCatalog: true,
						...(!metadata.inRecentCohort ? { policyNote: `outside the ${metadata.recentCohort} cohort (validated at selection; tier tags reflect the cohort)` } : {}),
					});
				} catch (error) {
					modelFacts.push({
						role: "executor",
						label: `${configured.provider}/${configured.modelId}${configured.variant ? `#${configured.variant}` : ""}`,
						inCatalog: false,
						problem: error instanceof Error ? error.message : String(error),
					});
				}
			}
			let catalogAvailable = true;
			let catalogProblem: string | undefined;
			try { await hostModels(); } catch (error) {
				catalogAvailable = false;
				catalogProblem = error instanceof Error ? error.message : String(error);
			}
			const commandRegistry = typeof ctx.command?.list === "function"
				? await ctx.command.list().then((response) => (Array.isArray(response?.data) ? response.data : undefined)).catch(() => undefined)
				: undefined;
			const listedCommands = commandRegistry?.map((command) => command.name).filter((name): name is string => typeof name === "string") ?? undefined;
			const missingCommands = listedCommands ? FUSION_COMMAND_NAMES.filter((name) => !listedCommands.includes(name)) : undefined;
			const nativePresent = await ctx.tool.list().then((tools) => tools.some((tool) => tool.id === "subagent")).catch(() => false);
			const ownershipProbe = await inspectOwnershipStorage(dependencies.ownershipRoot).catch((error: unknown): Awaited<ReturnType<typeof inspectOwnershipStorage>> => ({
				directory: "-", ready: false, initialized: false,
				problem: error instanceof Error ? error.message : String(error),
			}));
			const ownershipOverride = dependencies.ownershipRoot !== undefined || process.env.FUSION_OWNERSHIP_DIR !== undefined
				? "an ownership-root override is active for this process; every Pi and OpenCode process for this workspace must use the same directory"
				: undefined;

			const conflicts: string[] = [];
			if (run) {
				if (run.controller.uncertain) conflicts.push("the executor turn's outcome is uncertain");
				if (run.controller.pending) conflicts.push(`a pending ${run.controller.pending.action} request is retained (${run.controller.pending.requestId})`);
				const stop = readExecutorStop(run.adapterData?.fusionStop);
				if (stop && stop.state !== "confirmed") conflicts.push(`the run was stopped (${stop.kind ?? "operator"}); interruption delivery is ${stop.state}`);
				const status = run.runtime.status(run.handle);
				if (status.backgroundPending) conflicts.push("the executor turn is backgrounded; its completion notification is awaited");
			}
			let owned: RunManifest | undefined;
			let registryProblem: string | undefined;
			if (ownershipProbe.initialized) {
				try { owned = (await registry.inspect(workspace))?.manifest; }
				catch (error) { registryProblem = error instanceof Error ? error.message : String(error); }
			}
			if (registryProblem) conflicts.push(`the ownership registry could not be read: ${registryProblem}`);
			if (owned && owned.owner.supervisorId !== sessionID) conflicts.push(`another session owns this workspace (run ${owned.runId}, owner ${owned.owner.harness}:${owned.owner.supervisorId})`);
			let guidance: RecoveryView["guidance"] | undefined;
			let guidanceLine: string | undefined;
			if (run) {
				const view = runRecovery(run);
				guidance = view.guidance;
				guidanceLine = view.line;
			} else if (owned && owned.owner.supervisorId !== sessionID) {
				const view = foreignRecovery(owned);
				guidance = view.guidance;
				guidanceLine = view.line;
			} else if (owned && owned.recovery !== "settled") {
				// A restored record this session owns but has not reattached to:
				// the retained request is still owed even though no live run
				// exists here, so the workspace must not read as healthy — the
				// retained state is a conflict with its own recovery route.
				if (owned.pending) conflicts.push(`the persisted run record retains a pending ${owned.pending.action} request (${owned.pending.requestId})`);
				else conflicts.push("the persisted run record owes manual recovery without exact request proof");
				const derived = deriveRecoveryGuidance({
					ownership: "own",
					pending: owned.pending,
					terminal: "unprovable",
					capabilities: owned.capabilities,
					executed: owned.state.executed,
				});
				guidance = derived;
				guidanceLine = describeRecoveryLine(derived, owned.runId);
			}

			const agentReportData = await agentReport();
			const agentFacts = (agentReportData.observed && agentReportData.observed.length > 0
				? agentReportData.observed.map((observed) => ({ id: observed.id, state: observed.state, ...(observed.differences ? { differences: observed.differences } : {}) }))
				: agentReportData.contributed.map((id) => ({ id, state: "available" as const })));
			const hostSupport = hostSupportsOpenCode(hostVersion);
			return {
				harness: "opencode",
				fusionVersion,
				...(hostVersion !== undefined ? { hostVersion } : {}),
				supportedHostRange: SUPPORTED_HOST_RANGE,
				...(hostSupport !== undefined ? { hostSupported: hostSupport } : {}),
				mode: {
					enabled: fusionMode,
					kind: "persistent mode",
					hint: fusionMode
						? "fusion tools stay available to the fusion agent between runs"
						: "fusion tools require an active run; /fusion-run starts one",
				},
				tools: {
					expected: FUSION_TOOLS,
					registered: [...FUSION_TOOLS],
					...(missingCommands ? { commands: { missing: missingCommands, note: "the host's registry view may predate plugin contributions; a restart re-registers" } } : {}),
				},
				agents: {
					kind: "host-agents",
					contributionSupported: agentReportData.supported,
					facts: agentFacts,
				},
				models: {
					catalogAvailable,
					...(catalogProblem ? { catalogProblem } : {}),
					facts: modelFacts,
					authProbe: "network",
					authProbeDetail: "This host exposes no local credential validation to the plugin; checking a credential requires a network/model request.",
					note: "the supervisor's model stays OpenCode's own selector; Fusion validates only the executor and scout model",
				},
				backend: {
					configured: "OpenCode native subagent",
					capabilities: { ...OPENCODE_CAPABILITIES, workerAbort: typeof ctx.session.interrupt === "function", workerEvents: !!busHost },
					available: nativePresent,
					...(nativePresent ? {} : { problem: "the native subagent tool is no longer in the host tool list; the executor cannot run" }),
					note: `${typeof ctx.session.interrupt === "function" ? "worker abort available" : "worker abort unavailable (no session interruption surface)"}; ${busHost ? "worker events streaming via the host bus" : "no event bus: worker activity and waits are not streamed"}`,
				},
				ownership: {
					directory: ownershipProbe.directory,
					ready: ownershipProbe.ready,
					initialized: ownershipProbe.initialized,
					...(ownershipProbe.entries !== undefined ? { entries: ownershipProbe.entries } : {}),
					...(ownershipProbe.problem ? { problem: ownershipProbe.problem } : {}),
					...(ownershipProbe.fix ? { fix: ownershipProbe.fix } : {}),
					...(ownershipOverride ? { overrideNote: ownershipOverride } : {}),
				},
				recovery: {
					conflicts,
					...(guidance && guidanceLine ? { guidance: { line: guidanceLine, action: guidance.action, owed: isRecoveryOwed(guidance.action) } } : {}),
				},
			};
		}
		async function doctorContent(sessionID: string, authProbe: boolean): Promise<string> {
			const facts = await doctorFacts(sessionID);
			const report = buildDoctorReport(facts);
			const lines = describeDoctorReport(report);
			if (authProbe) lines.push(...describeDoctorAuth(facts));
			return lines.join("\n");
		}
		async function statusContent(sessionID: string): Promise<string> {
			const run = runs.get(sessionID);
			if (!run) {
				const owned = await registry.inspect(workspace);
				if (!owned) {
					const report = await agentReport();
					const observedConflicts = (report.observed ?? []).filter((entry) => entry.state === "conflict");
					if (observedConflicts.length > 0) {
						const detail = observedConflicts.map((conflict) => `${conflict.id} (${conflict.differences!.join(", ")})`).join("; ");
						return `No Fusion run in this session. Installed agent definitions override this plugin's for: ${detail}. Update or remove those agent files to let the plugin manage them.`;
					}
					return "No Fusion run in this session.";
				}
				const foreign = foreignRecovery(owned.manifest);
				return JSON.stringify({ message: "Another Fusion run owns this workspace.", runId: owned.manifest.runId, owner: owned.manifest.owner, recovery: owned.manifest.recovery, pending: owned.manifest.pending, guidedRecovery: recoveryPayload(foreign.guidance), nextAction: foreign.line });
			}
			const status = run.runtime.status(run.handle);
			const promptDelivery = run.adapterData?.fusionPrompt as { state?: unknown } | undefined;
			const nudgeDelivery = (run.adapterData?.fusionNudge as { state?: unknown } | undefined)?.state;
			const settlementWrite = (run.adapterData?.fusionSettlement as { state?: unknown } | undefined)?.state;
			const stopped = readExecutorStop(run.adapterData?.fusionStop);
			// R4 guided recovery: one recommended action derived from shared
			// facts (ownership, pending identity, terminal proof, stop state,
			// capabilities). The R3 wait action still leads while a worker wait
			// is open; a stopped run keeps its per-worker recap and gains the
			// recovery line beneath it.
			const recovery = runRecovery(run);
			const budgetDecision = evaluateRunPolicy(run);
			const budgetStatus = { policy: runPolicy(run) ?? null, status: budgetDecision.status, ...(budgetDecision.reason ? { reason: budgetDecision.reason } : {}), budget: runBudget(run) };
			// R3: waiting/blocked presentation. An open wait names the required
			// action in the shared wording; without the bus, waits are honestly
			// unobservable instead of guessed.
			const waiting = runWaitStatus(run);
			const waitActionLine = waitNextAction(run);
			const waitNote = busHost ? undefined : "worker waits are not observable on this host (no event bus); status cannot report permission or question waits";
			const nextActionWithWait = waitActionLine ?? (stopped ? `${stopFeedback(stopped)}\n${recovery.line}` : recovery.line);
			return JSON.stringify({ ...run.controller.state, runId: run.runId, owner: run.handle.owner, workspaceClaimed: !!run.lease, model: run.model, fusionMode: fusionMode ? "on" : "off", pending: run.controller.pending, promptDelivery: promptDelivery?.state, nudgeDelivery, settlementWrite, incomplete: !!run.incomplete, childSessionID: run.handle.reference?.id, capabilities: run.runtime.capabilities, uncertain: run.controller.uncertain, backgroundPending: status.backgroundPending, reconciling: !!run.reconciling, stop: stopped, budget: budgetStatus, ...(waiting ? { waiting } : {}), ...(waitNote ? { waitNote } : {}), agents: await agentReport(), guidedRecovery: recoveryPayload(recovery.guidance), nextAction: nextActionWithWait });
		}
		/** Resume presentation: recovery surface for the owned or adopted run.
		 * Routed to fusion_reconcile only when exact completion proof can exist;
		 * operator resolution is documented textually, never implied. */
		async function resumeContent(sessionID: string): Promise<string> {
			const run = runs.get(sessionID);
			if (!run) {
				const owned = await registry.inspect(workspace);
				if (!owned) return "No Fusion run in this session.";
				// R4: the same shared derivation for a run this session does not
				// own — recover in the owning session, with explicit operator
				// resolution documented as the fallback, never implied.
				const foreign = foreignRecovery(owned.manifest);
				return JSON.stringify({
					message: "The workspace Fusion record is not attached to this session; recovery happens in its owning session or through explicit operator resolution.",
					runId: owned.manifest.runId, owner: owned.manifest.owner, recovery: owned.manifest.recovery, pending: owned.manifest.pending,
					activeTurnReattach: "refused",
					reattachReason: "Fusion never reattaches another session's executor turn into this session.",
					guidedRecovery: recoveryPayload(foreign.guidance),
					nextAction: foreign.line,
				});
			}
			const status = run.runtime.status(run.handle);
			const outstanding = { backgroundPending: status.backgroundPending, recordedResult: !!status.unsettled, reconciling: !!run.reconciling, delegating: !!run.controller.state.delegating, scoutInFlight, backgroundScout: hasBackgroundScout() };
			const pendingRequest = run.controller.pending;
			const recovery = runRecovery(run);
			// The reconciliation capability mirrors the derived action: one
			// derivation, reported as capability and as next action, so the two
			// surfaces can never disagree.
			const reconcile: { capability: "available" | "busy" | "unavailable"; detail: string } = recovery.guidance.action === "reconcile"
				? { capability: "available", detail: status.unsettled ? "the executor's recorded result can be settled into the run" : "the executor's completion notification is awaited, or may already be recorded in this session" }
				: recovery.guidance.action === "wait"
					? { capability: "busy", detail: "another executor transition is in progress" }
					: { capability: "unavailable", detail: run.controller.uncertain
						? (pendingRequest ? "the retained executor request has no live turn and no recorded result; automatic retry stays disabled while the outcome is unknown" : "the outcome is unknown with no retained request")
						: "nothing is unsettled; the run owes no recovery" };
			const nextAction = describeRecoveryGuidance(recovery.guidance, {
				resume: "fusion_resume",
				reconcile: "fusion_reconcile",
				delegate: "fusion_delegate",
				reset: "fusion_reset",
				startRun: "/fusion-run",
				resolveCommand: resolveOperatorCommand({ entry: RESOLVE_ENTRY, workspace, runId: run.runId, requestId: recovery.guidance.pending?.requestId }),
				afterWait: "call fusion_resume again",
			});
			return JSON.stringify({ ...run.controller.state, runId: run.runId, owner: run.handle.owner, model: run.model, childSessionID: run.handle.reference?.id, pendingRequest, outstanding, uncertain: run.controller.uncertain, reconcile: reconcile.capability, reconcileDetail: reconcile.detail, activeTurnReattach: "refused", reattachReason: "OpenCode cannot reattach a live or interrupted executor turn back into this session; recovery routes through the completion notification (fusion_reconcile) or explicit operator resolution.", incomplete: !!run.incomplete, guidedRecovery: recoveryPayload(recovery.guidance), nextAction });
		}
		function statsContent(sessionID: string): string {
			const run = runs.get(sessionID);
			if (!run) return "No Fusion run in this session.";
			const usage = (run.adapterData?.fusionUsage ?? {}) as Record<string, unknown> & { turnsReported?: number; turnsMissing?: number; fieldTurns?: Record<string, number> };
			const reported = usage.turnsReported ?? 0;
			const missing = usage.turnsMissing ?? 0;
			// A summed field is only complete when every reporting turn carried
			// it: a token total that came from fewer turns than reported must
			// not look whole.
			const fieldsFull = reported > 0 && !(["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "cost"] as const).some((field) => typeof usage[field] === "number" && (usage.fieldTurns?.[field] ?? 0) !== reported);
			return JSON.stringify({ runId: run.runId, executed: run.controller.state.executed,
				revisions: { used: run.controller.state.revisions, limit: MAX_REVISIONS },
				scoutCalls: { used: run.controller.state.scoutCalls, limit: MAX_SCOUT_CALLS },
				finalFixUsed: run.controller.state.finalFixUsed,
				lastResult: run.lastResult ? { requestId: run.lastResult.requestId, status: run.lastResult.status } : undefined,
				usage: {
					available: reported > 0,
					reason: reported > 0 ? undefined : run.controller.state.executed || run.controller.state.scoutCalls > 0 ? "No Fusion worker turn has reported usage on this host yet." : "No Fusion worker turn has run yet.",
					complete: missing === 0 && (reported === 0 || fieldsFull),
					turns: { reported, missing },
					fieldTurns: usage.fieldTurns,
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					cacheReadTokens: usage.cacheReadTokens,
					cacheWriteTokens: usage.cacheWriteTokens,
					reasoningTokens: usage.reasoningTokens,
					cost: usage.cost,
				},
				// R2 run policies: the current policy, consumed amounts, and the
				// observable-roles statement. The supervisor role is not
				// observable on this host; limits apply to observed accounting
				// only, never a strict ceiling.
				policy: runPolicy(run) ?? null,
				budget: runBudget(run),
				budgetStatus: evaluateRunPolicy(run).status,
				observableRoles: BUDGET_ROLES_OPENCODE,
				unobservableRoles: ["supervisor"],
				// R3 waiting/blocked presentation: the current worker's open wait
				// and durations; waiting time never feeds the budget checks.
				...(runWaitStatus(run) ? { waiting: runWaitStatus(run) } : {}),
				...(busHost ? {} : { waitNote: "worker waits are not observable on this host (no event bus)" }),
			});
		}

		await ctx.tool.transform((editor) => {
			editor.add({
				name: "fusion_stop",
				description: "Stop this supervisor's Fusion run — the executor and every scout it owns — when the user requests it. Requests native interruption of each worker and returns bounded activity feedback; each worker's delivery is reported separately, and acknowledgement is not proof of termination. Do not retry, reset, or start more work after stopping; reconcile retained results first.",
				input: { type: "object", properties: { reason: { type: "string", maxLength: 120 } }, additionalProperties: false },
				options: { codemode: false },
				async execute(input, context) {
					requireSupervisor(context);
					const reason = input && typeof input === "object" ? (input as { reason?: unknown }).reason : undefined;
					if (reason !== undefined && typeof reason !== "string") throw new Error("Invalid Fusion stop reason.");
					const stop = await stopExecutor(context.sessionID, reason);
					return { content: stop ? stopFeedback(stop) : "No Fusion run in this session.", metadata: stop ? { stop: { ...stop }, childSessionID: stop.childSessionID } : {} };
				},
			});
			editor.add({
				name: "fusion_start",
				description: "Start a Fusion run with the user's original request before scouting or delegation. Finish and reset the previous run first.",
				input: { type: "object", properties: { task: { type: "string", minLength: 1 } }, required: ["task"], additionalProperties: false },
				options: { codemode: false },
				async execute(input, context) {
					requireSupervisor(context);
					if (!input || typeof input !== "object" || typeof (input as Record<string, unknown>).task !== "string" || !(input as { task: string }).task.trim()) throw new Error("Fusion requires a non-empty original task.");
					const run = await startRun(context.sessionID, (input as { task: string }).task.trim());
					return { content: "Fusion run started. Investigate the original request, then use fusion_scout and fusion_delegate as needed.", metadata: { runId: run.runId } };
				},
			});
			editor.add({
				name: "fusion_configure",
				description: "Configure the Fusion executor model (used by the executor and the scout) by validating provider, model, and an optional variant against the OpenCode catalog. Applies to this run when no executor work has started; otherwise to the next run.",
				input: { type: "object", properties: { provider: { type: "string", minLength: 1 }, model: { type: "string", minLength: 1 }, variant: { type: "string", minLength: 1 } }, required: ["provider", "model"], additionalProperties: false },
				options: { codemode: false },
				async execute(input, context) {
					requireSupervisor(context);
					if (!input || typeof input !== "object") throw new Error("Invalid Fusion configuration input.");
					const value = input as Record<string, unknown>;
					if (typeof value.provider !== "string" || !value.provider.trim() || typeof value.model !== "string" || !value.model.trim() || (value.variant !== undefined && (typeof value.variant !== "string" || !value.variant.trim()))) throw new Error("Invalid Fusion configuration input.");
					const result = await configureExecutorModel(context.sessionID, { provider: value.provider.trim(), modelId: value.model.trim(), ...(typeof value.variant === "string" && value.variant.trim() ? { variant: value.variant.trim() } : {}) });
					return { content: formatConfiguredModel(result), metadata: { model: result.config, applied: result.applied, ...result.metadata } };
				},
			});
			editor.add({
				name: "fusion_delegate",
				description: "Delegate a decided implementation brief to the Fusion executor. Supply a short title and put the full brief in details.brief so it stays collapsed in the UI. Use execute once, then up to three revise calls and one final_fix after the acceptance audit. Review the actual working tree after each call.",
				input: DELEGATE_INPUT,
				options: { codemode: false },
				async execute(input, context) {
					requireSupervisor(context);
					if (resetting || starting || configuring) throw new Error("Fusion reset is in progress, a run is starting, or configuration is in progress.");
					const value = delegateInput(input);
					const action = value.action;
					const run = await runFor(context.sessionID);
					if (resetting || starting || configuring) throw new Error("Fusion reset is in progress, a run is starting, or configuration is in progress.");
					if (context.signal.aborted) throw new Error("Fusion delegation cancelled before submission.");
					if (run.reconciling) throw new Error("Fusion reconciliation is already in progress.");
					if (readExecutorStop(run.adapterData?.fusionStop)) throw new Error("This Fusion run was stopped. Reconcile retained work and reset before further delegation.");
					// A budget-blocked run refuses new submissions; the pre-submission
					// gate below rechecks after setup and consumes any waiver.
					const delegateBudgetError = await budgetRefusal(context.sessionID, run);
					if (delegateBudgetError) throw new Error(delegateBudgetError);
					if (run.controller.uncertain) throw new Error("The executor's last turn has an unknown outcome. Review the child session and working tree before recovery; automatic retry is disabled.");
					if (owner && owner !== context.sessionID) throw new Error("Another Fusion session owns this workspace. Finish and reset that run first.");
					if (action === "execute" && run.controller.state.originalTask && typeof value.originalTask === "string" && value.originalTask !== run.controller.state.originalTask) throw new Error("The original task was already recorded by fusion_start and cannot be replaced.");
					const error = run.controller.beginDelegation(action, OPENCODE_CAPABILITIES, value.brief);
					if (error) throw new Error(error);
					const monitor = delegateMonitor({ action, title: value.title, requestId: run.controller.pending?.requestId, streaming: !!busHost, progress: (update) => context.progress(update) });
					run.monitor = monitor;
					const turnAbort = new AbortController();
					run.turnAbort = turnAbort;
					const parentCancelled = () => { void stopExecutor(context.sessionID, "Supervisor turn cancelled").then((stop) => stop && stopNotice(context.sessionID, stop)).catch(() => {}); };
					context.signal.addEventListener("abort", parentCancelled, { once: true });
					// Keep the native call's ownership/request/cancellation fields. The
					// progress overlay adds display metadata after reference persistence.
					run.setContext(run.handle, { ...context, progress: (update) => { run.turnWaits?.markActivity(); return monitor.nativeProgress(update); } });
					if (action === "execute") {
						run.controller.startExecution(run.controller.state.originalTask ?? (typeof value.originalTask === "string" && value.originalTask.trim() ? value.originalTask : value.brief), value.brief);
					}
					run.controller.setPhase(action === "execute" ? "executing" : action === "revise" ? "revising" : "finalizing");
					const promptText = run.controller.delegationPrompt(action, value.brief);
					const prompt = action === "execute" ? `${EXECUTOR_SYSTEM_PROMPT}\n\n${promptText}` : promptText;
					// beginDelegation minted and recorded the pending request identity.
					const description = run.controller.pending?.requestId;
					if (!description) throw new Error("Fusion delegation lost its pending request identity.");
					const request: WorkerTurnRequest = { runId: run.runId, requestId: description, worker: run.handle, prompt };
					try {
						await monitor.start();
						return await run.controller.performWorkerDelegation(request, { signal: AbortSignal.any([context.signal, turnAbort.signal]), onEvent: (update) => { run.turnWaits?.markActivity({ observation: "implementing" }); monitor.onEvent(update); } }, {
							// Authoritative in-sequence claim: the precondition above is a
							// fast guard, this re-check wins the workspace before intent.
							claim: async () => {
								if (owner && owner !== context.sessionID) throw new Error("Another Fusion session owns this workspace. Finish and reset that run first.");
								if (!run.lease) run.lease = await registry.claim(manifest(run));
								owner = context.sessionID;
							},
							recordIntent: () => persist(context.sessionID, run),
							snapshot: async () => {
								if (readExecutorStop(run.adapterData?.fusionStop)?.requestId === request.requestId) throw new Error("Fusion executor stopped before submission.");
								const before = await snapshotWorkspace(ctx.location.directory, nodeGitExec);
								if (readExecutorStop(run.adapterData?.fusionStop)?.requestId === request.requestId) throw new Error("Fusion executor stopped before submission.");
								run.before = before;
								return before;
							},
							// The budget gate rechecks immediately before submission (a
							// late reading during setup can cross a limit) and consumes
							// any unknown-budget waiver here, at the real admission.
							// The turn's active clock and bounded timer start after it.
							submissionGate: async () => {
								if (readExecutorStop(run.adapterData?.fusionStop)?.requestId === request.requestId) throw new Error("Fusion executor stopped before submission.");
								const refusal = await budgetRefusal(context.sessionID, run, true);
								if (refusal) throw new Error(refusal);
								run.turnClock = new ActiveClock();
								run.turnClock.start();
								run.turnClockWorker = "executor";
								// R3: the turn's wait observation rides the same lifetime;
								// confirmed waits pause this clock.
								turnWaitClock(context.sessionID, run, "executor");
								armBudgetTimer(context.sessionID, run);
							},
							recordReference: async (reference) => {
								// A queued stop interrupts the owned child without waiting
								// on the reference persistence below: a stalled storage
								// write must not delay interrupting a running child (the
								// bus watcher would otherwise retry the interruption only
								// on a later qualifying event). Persistence still gates
								// the forwarded progress, and since nothing has been
								// submitted in the pre-submission path, the idle child
								// only needs the stop-before-submission throw.
								const stop = readExecutorStop(run.adapterData?.fusionStop);
								if (stop?.requestId === request.requestId && run.controller.submissionBegan) void interruptExecutor(context.sessionID, run, stop);
								await persist(context.sessionID, run);
								if (stop?.requestId === request.requestId && !run.controller.submissionBegan) throw new Error("Fusion executor stopped before submission.");
								await monitor.nativeProgress({ sessionID: reference.id });
							},
							collect: async (result, before) => {
								recordUsage(run, result);
								// The turn's active time lands with its usage; both ride
								// the next strict settlement write.
								addActiveTime(runBudget(run), commitBudgetClock(run) ?? 0);
								disarmBudgetTimer(run);
								const workspaceAfter = await snapshotWorkspaceAfter(before, nodeGitExec);
								const evidence = await workspaceEvidenceRefs(before, nodeGitExec, undefined, workspaceAfter);
								run.lastResult = { requestId: result.requestId, status: result.status, text: result.text, evidence: evidence ?? [] };
								return { result, parsed: run.controller.executorReport(result.text), diffStat: await workspaceDiffStat(before, nodeGitExec) };
							},
							settle: async ({ result, parsed, diffStat }) => {
								const stop = readExecutorStop(run.adapterData?.fusionStop);
								if (stop?.requestId === result.requestId) await confirmStop(context.sessionID, run, stop, result.status);
								await run.runtime.settle(request, async () => {
									await run.controller.persistSettlement(result.status, async () => {
										run.lastResult = { requestId: result.requestId, status: result.status, text: result.text, evidence: run.lastResult?.evidence ?? [] };
										await persist(context.sessionID, run, true);
									});
								});
								run.before = undefined;
								// Display activity is advisory, not evidence of complete edits.
								const activity = await monitor.finish(result.status === "completed" ? "completed" : "failed");
								return { content: formatCompactReport(parsed.report, diffStat, parsed.prose, [busHost ? "review the full working tree" : "executor tool activity unavailable; review the full working tree"]), metadata: { childSessionID: run.handle.reference?.id, action, fusion: activity } };
							},
						});
					} catch (error) {
						const stop = readExecutorStop(run.adapterData?.fusionStop);
						if (stop && !run.controller.submissionBegan) { stop.state = "not-submitted"; stop.updatedAt = Date.now(); await stopNotice(context.sessionID, stop); }
						// R4 review fix: the activity card's recovery line is derived
						// AFTER the controller's failure finalization (uncertainty,
						// retained request, delegation end) — deriving before it left
						// the uncertain card without guidance while status already
						// recommended reconciliation.
						try {
							if (run.controller.submissionBegan) recordMissingTurn(run, "executor", request.requestId);
							// The turn ends here but the child may still be executing
							// (backgrounded, or an unknown outcome): an outstanding wait
							// transfers to the child's tracker so it stays visible.
							const childDone = stop?.requestId === request.requestId && stop.state === "confirmed";
							if (run.controller.submissionBegan && !childDone) transferTurnWaitToChild(run, run.handle.reference?.id);
							addActiveTime(runBudget(run), commitBudgetClock(run) ?? 0);
							disarmBudgetTimer(run);
							run.controller.failDelegation();
							if (!run.lease) { run.controller.clearPending(); throw error; }
							if (!run.controller.submissionBegan && !run.controller.pending) throw error;
							if (!run.controller.submissionBegan && run.controller.pending) {
								// No native call occurred. Clear the write-ahead intent before
								// allowing another attempt; a failed clear remains uncertain.
								const pending = run.controller.pending;
								run.controller.clearPending();
								let cleared = false;
								try {
									await persist(context.sessionID, run);
									cleared = true;
								} catch {
									run.controller.setPending(pending);
								}
								if (cleared) { run.before = undefined; throw error; }
							}
							// Child creation and submission can fail before progress delivers an ID.
							// Without proof of settlement, retrying could duplicate edits.
							run.controller.setUncertain(true);
							// Save a child ID returned only in the native result as well as IDs
							// delivered through progress. Failure keeps the run locked.
							if (run.controller.pending) await persist(context.sessionID, run);
							if (run.runtime.status(run.handle).backgrounded) {
								// The background card publishes before the return so the
								// result metadata carries the finished phase.
								await monitor.finish("background");
								return { content: "Fusion executor is running in the background. After OpenCode delivers its completion notification, call fusion_reconcile before reviewing or delegating again.", metadata: { childSessionID: run.handle.reference?.id, status: "running", fusion: monitor.snapshot() } };
							}
							throw error;
						} finally {
							// Ending the delegation here — before the card derives its
							// recovery facts — keeps the transition's own liveness out of
							// the card's guidance; the outer finally's endDelegation is
							// idempotent. One bounded publication: an earlier finish
							// (the background path) makes this a no-op by its guard.
							run.controller.endDelegation(action);
							const endPhase = stop && !run.controller.submissionBegan ? "stopped" : run.runtime.status(run.handle).backgrounded ? "background" : run.controller.submissionBegan ? "uncertain" : "failed";
							await monitor.finish(endPhase, endPhase === "background" ? undefined : cardRecoveryLine(run));
						}
					} finally {
						context.signal.removeEventListener("abort", parentCancelled);
						if (run.turnAbort === turnAbort) run.turnAbort = undefined;
						run.controller.endDelegation(action);
					}
				},
			});
			editor.add({
				name: "fusion_scout",
				description:
					`Ask the Fusion scout read-only questions about this repository. Runs as an isolated disposable ${SCOUT_AGENT} subagent with read-only tools (read, grep, glob). Pass 1-5 questions; each call answers all of them with path:line citations. At most ${MAX_SCOUT_CALLS} calls per run.`,
				input: { type: "object", properties: { questions: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 5 } }, required: ["questions"], additionalProperties: false },
				options: { codemode: false },
				async execute(input, context) {
					requireSupervisor(context);
					if (resetting || starting || configuring) throw new Error("Fusion reset is in progress, a run is starting, or configuration is in progress.");
					if (!input || typeof input !== "object") throw new Error("Invalid Fusion scout input.");
					const value = input as Record<string, unknown>;
					if (!Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > 5 || !value.questions.every((question) => typeof question === "string" && !!question.trim())) throw new Error("Invalid Fusion scout input.");
					if (scoutInFlight) {
						// A stopped run is the more important refusal even while a
						// scout of that run is still winding down: the stop intent
						// outlives the in-flight turn.
						const stoppedRun = runs.get(context.sessionID);
						if (stoppedRun && readExecutorStop(stoppedRun.adapterData?.fusionStop)) throw new Error("This Fusion run was stopped; do not start more scout work.");
						throw new Error("A Fusion scout is already running; wait for it to answer before asking again.");
					}
					// Claim the in-flight slot synchronously, before any await: a
					// concurrent reset or start must see the scout as running from
					// the first moment, not only after its setup awaits resolve.
					scoutInFlight = true;
					try {
					const questions = value.questions as string[];
					// Scouting precedes the first delegation, so it lazily creates this
					// session's run. A scout-only run claims no workspace and makes no
					// native call until a real delegation submits; the invocation budget
					// is still the shared per-run controller budget.
					const run = await runFor(context.sessionID);
					if (resetting || starting || configuring) throw new Error("Fusion reset is in progress, a run is starting, or configuration is in progress.");
					if (readExecutorStop(run.adapterData?.fusionStop)) throw new Error("This Fusion run was stopped; do not start more scout work.");
					// A budget-blocked run refuses scout work too; the pre-submission
					// recheck below consumes any waiver at the real admission.
					const scoutBudgetError = await budgetRefusal(context.sessionID, run);
					if (scoutBudgetError) throw new Error(scoutBudgetError);
					if (scoutGuards.size >= MAX_TRACKED_SCOUTS) throw new Error("Fusion scout tracking is full; wait for an existing scout to stop.");
					let handle: WorkerHandle | undefined;
					let cap: ScoutCap | undefined;
					let requestId: string | undefined;
					let requestStarted = false;
					const onAbort = () => activeScout?.entry.terminate();
					let response: { content: string; metadata?: Record<string, unknown> };
					try {
						const budgetError = run.controller.beginScout();
						if (budgetError) return { content: budgetError };
						// The invocation counter is advisory budget state; a failed advisory
						// write must not block a read-only scout. Settlement writes keep
						// their strict fault guarantees.
						if (run.lease && !run.persistFlight) { try { await persist(context.sessionID, run); } catch {} }
						handle = await run.runtime.create(run.handle.owner, { role: "scout", maxToolCalls: MAX_SCOUT_TOOL_CALLS, ...(run.model ? { model: run.model } : {}) });
						run.setContext(handle, context);
						cap = run.runtime.scoutCap(handle, MAX_SCOUT_TOOL_CALLS);
						requestId = `Fusion scout ${randomUUID()}`;
						activeScout = {
							entry: { cap, handle, terminate: () => { void run.runtime.abort(handle!).catch(() => {}); } },
							requestId,
						};
						context.signal.addEventListener("abort", onAbort, { once: true });
						// A stop or a budget block may have engaged while the scout's
						// setup above awaited: recheck immediately before submission
						// so a stopped or blocked run never admits scout work. The
						// scout's clock and timer start after both gates pass.
						if (readExecutorStop(run.adapterData?.fusionStop)) throw new Error("Fusion run stopped before submission; the scout turn never started.");
						const scoutGateRefusal = await budgetRefusal(context.sessionID, run, true);
						if (scoutGateRefusal) throw new Error(scoutGateRefusal);
						run.turnClock = new ActiveClock();
						run.turnClock.start();
						run.turnClockWorker = "scout";
						// R3: the scout turn's wait observation rides the same lifetime.
						turnWaitClock(context.sessionID, run, "scout");
						armBudgetTimer(context.sessionID, run);
						// The scout runs on the configured executor model (Pi parity).
						const request: WorkerTurnRequest = { runId: run.runId, requestId, worker: handle, prompt: buildScoutPrompt(questions) };
						requestStarted = true;
						const result = await run.runtime.submit(request, { signal: context.signal, onEvent: () => { run.turnWaits?.markActivity({ observation: "implementing" }); }, onReference: async (reference) => {
							if (!activeScout) throw new Error("Fusion scout guard is unavailable.");
							activeScout.childSessionID = reference.id;
							trackScoutGuard(reference.id, activeScout.entry);
							// A stop that queued this scout's delivery adopts the published
							// child reference and dispatches the interruption immediately:
							// the delivery must not wait for a later execution-start event
							// that may never come.
							const stopWithQueue = readExecutorStop(run.adapterData?.fusionStop);
							const queued = requestId ? stopWithQueue?.scouts?.find((entry) => entry.requestId === requestId && !entry.childSessionID) : undefined;
							if (queued) {
								queued.childSessionID = reference.id;
								queued.updatedAt = Date.now();
								void interruptQueuedScout(context.sessionID, run, stopWithQueue!, queued);
								if (run.lease && !run.persistFlight) { try { await persist(context.sessionID, run); } catch {} }
							}
						} });
						recordUsage(run, result);
						// The scout turn's active time lands with its usage. A
						// backgrounded scout child keeps executing: its outstanding
						// wait transfers to the child tracker first.
						if (handle && run.runtime.status(handle).backgroundPending) transferTurnWaitToChild(run, handle.reference?.id);
						addActiveTime(runBudget(run), commitBudgetClock(run) ?? 0);
						disarmBudgetTimer(run);
						// The accumulated totals are advisory: they ride the next strict
						// settlement write, with a best-effort persist here so a claimed
						// run keeps them across reloads without ever blocking the answer.
						if (run.lease && !run.persistFlight) { try { await persist(context.sessionID, run); } catch {} }
						const capped = result.role === "scout" ? (cap.refused || result.capped) : false;
						const { text } = formatScoutResponse({ status: result.status, text: result.text, errorMessage: result.errorMessage, capped, usage: result.usage });
						response = { content: text, metadata: { childSessionID: handle.reference?.id, status: result.status, capped, questions: questions.length } };
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						// A scout turn that started but never answered is a coverage
						// gap: its spend stays unknown, never zero. A refusal before
						// submission leaves no turn to record.
						if (run.controller.state.scoutCalls > 0 && requestStarted) recordMissingTurn(run, "scout", requestId);
						// A host that backgrounded the scout anyway keeps the child
						// running: its outstanding wait transfers to the child tracker.
						if (requestStarted && handle && run.runtime.status(handle).backgroundPending) transferTurnWaitToChild(run, handle.reference?.id);
						addActiveTime(runBudget(run), commitBudgetClock(run) ?? 0);
						disarmBudgetTimer(run);
						response = { content: `Fusion scout failed: ${message}`, metadata: { error: message } };
					} finally {
						context.signal.removeEventListener("abort", onAbort);
						activeScout = undefined;
					}
					// Disposition. A backgrounded scout keeps running after this call
					// returns, so its guard stays armed — and its handle stays released-
					// pending so terminate can still interrupt the child — until the
					// child's execution is observed to end. Otherwise dispose now,
					// without deleting the transcript; a release refusal is surfaced
					// without discarding the answer.
					let releaseNote: string | undefined;
					const childID = handle?.reference?.id;
					if (handle && cap && childID && run.runtime.status(handle).backgroundPending) {
						trackScoutGuard(childID, {
							cap,
							handle,
							terminate: () => { void run.runtime.abort(handle!).catch(() => {}); },
							release: () => { void run.runtime.release(handle!).catch(() => {}); },
						});
					} else if (handle) {
						if (childID) scoutGuards.delete(childID);
						try { await run.runtime.release(handle); } catch (error) { releaseNote = error instanceof Error ? error.message : String(error); }
					}
					return releaseNote ? { ...response, content: `${response.content}\n\n(Fusion scout could not be released: ${releaseNote})` } : response;
					} finally { activeScout = undefined; scoutInFlight = false; }
				},
			});
			editor.add({
				name: "fusion_reconcile", description: "Reconcile a backgrounded Fusion executor after OpenCode delivers its completion notification.", input: { type: "object", properties: {}, additionalProperties: false }, options: { codemode: false },
				async execute(_input, context) {
					requireSupervisor(context);
					if (resetting || starting || configuring) throw new Error("A Fusion run transition is in progress.");
					const run = runs.get(context.sessionID);
					if (!run?.controller.uncertain || !run.controller.pending || !run.runtime.status(run.handle).backgroundPending && !run.runtime.status(run.handle).unsettled) throw new Error("No backgrounded Fusion turn is available for reconciliation.");
					if (run.controller.state.delegating || run.reconciling) throw new Error("Fusion reconciliation is already in progress.");
					const pending = run.controller.pending;
					run.reconciling = true;
					try {
						run.setContext(run.handle, context);
						const request: WorkerTurnRequest = { runId: run.runId, requestId: pending.requestId, worker: run.handle, prompt: "" };
						const unresolvedStatus = run.runtime.status(run.handle);
						const unsettled = unresolvedStatus.unsettled;
						const persistResult = async (result: import("../core/worker.ts").WorkerTurnResult) => {
							// The proven terminal result updates a matching stop record
							// before the settlement clears the pending intent: after a
							// successful cancelled-work reconciliation, stop feedback
							// must read confirmed termination instead of a still
							// unconfirmed interrupt. confirmStop is idempotent and
							// bounded-wait on its persistence, like on the bus path.
							const stop = readExecutorStop(run.adapterData?.fusionStop);
							if (stop?.requestId === result.requestId) await confirmStop(context.sessionID, run, stop, result.status);
							// A proven terminal result is also proof the child's turn
							// ended: any wait it still held (a completion notification
							// can arrive without the child's terminal bus event) is
							// disposed with it, so status stops asking the user to
							// answer a question whose turn is over.
							if (run.handle.reference) releaseChildWait(run.handle.reference.id);
							await run.controller.persistSettlement(result.status, async () => {
								// The reconciled turn's usage is recorded inside the
								// persisted settlement itself, so a reload before
								// another write loses neither the settlement nor the
								// count. The dedupe key (keyed on the pending request)
								// keeps a re-run of the same reconciliation — after a
								// failed settlement write, for instance — from
								// counting the turn twice. A recorded (unsettled)
								// result was already counted when its turn
								// completed, so only notification-adopted turns are
								// new to the totals.
								if (!unsettled) recordUsage(run, result, `reconcile:${pending.requestId}`);
								// Reconciliation settles the same request the evidence was
								// collected for; anything else gets empty evidence.
								const retained = run.lastResult;
								run.lastResult = { requestId: result.requestId, status: result.status, text: result.text, evidence: retained?.requestId === result.requestId ? retained.evidence ?? [] : [] };
								await persist(context.sessionID, run, true);
							});
						};
						const result = unsettled
							? await run.runtime.settle(request, persistResult)
							: await run.runtime.reconcile(request, { signal: context.signal, onEvent: () => {}, onReference: () => persist(context.sessionID, run) }, async (childID, _request, signal) => {
								if (signal.aborted) throw new Error("Fusion reconciliation was cancelled.");
								const retained = run.lastResult;
								if (retained?.requestId === pending.requestId && retained.text !== undefined) return { status: retained.status, text: retained.text };
								const messages = await ctx.session.context({ sessionID: context.sessionID });
								if (signal.aborted) throw new Error("Fusion reconciliation was cancelled.");
								const notification = notificationResult(messages, childID, pending.requestId);
								return { status: notification.state, text: notification.output };
							}, persistResult);
						run.controller.setUncertain(false);
						const terminalState = result.status;
						const parsed = run.controller.executorReport(result.text);
						const stat = await workspaceDiffStat(run.before, nodeGitExec);
						run.before = undefined;
						if (terminalState !== "completed") return { content: `Fusion executor ${terminalState}: ${result.text}\nReview the full working tree before deciding whether to revise.`, metadata: { childSessionID: run.handle.reference?.id, requestId: pending.requestId, action: pending.action, status: terminalState } };
						return { content: formatCompactReport(parsed.report, stat, parsed.prose, ["reconciled background turn; review the full working tree"]), metadata: { childSessionID: run.handle.reference?.id, requestId: pending.requestId, action: pending.action, status: terminalState } };
					} finally { run.reconciling = false; }
				},
			});
			editor.add({
				name: "fusion_resume", description: "Show this Fusion run's recovery state: owner, pending request, reconciliation capability, and the next valid action. Refuses outright anything it cannot honestly promise, including mid-turn reattachment.", input: { type: "object", properties: {}, additionalProperties: false }, options: { codemode: false },
				async execute(_input, context) {
					requireSupervisor(context);
					return { content: await resumeContent(context.sessionID) };
				},
			});
			editor.add({
				name: "fusion_status", description: "Show the current Fusion run state.", input: { type: "object", properties: {}, additionalProperties: false }, options: { codemode: false },
				async execute(_input, context) {
					requireSupervisor(context);
					return { content: await statusContent(context.sessionID) };
				},
			});
			editor.add({
				name: "fusion_stats", description: "Show the current Fusion run's review and scout budgets and its observed worker token and cost totals.", input: { type: "object", properties: {}, additionalProperties: false }, options: { codemode: false },
				async execute(_input, context) {
					requireSupervisor(context);
					return { content: statsContent(context.sessionID) };
				},
			});
			editor.add({
				name: "fusion_reset", description: "Finish a settled Fusion run and release its workspace for another session.", input: { type: "object", properties: {}, additionalProperties: false }, options: { codemode: false },
				async execute(_input, context) {
					requireSupervisor(context);
					if (resetting || starting || configuring) throw new Error("Fusion reset is in progress, a run is starting, or configuration is in progress.");
					if (promptInFlight) throw new Error("Fusion prompt delivery is in progress.");
					// Refuse before any mutation: dismantling storage, ownership, or the
					// executor underneath an in-flight scout leaves the run partially
					// reset and unrecoverable by retry.
					if (scoutInFlight || hasBackgroundScout()) throw new Error("A Fusion scout is still running; wait for it to stop before resetting.");
					const run = runs.get(context.sessionID);
					if (!run) return { content: "No Fusion run in this session." };
					if (run.stopFlight || run.interruptFlight || readExecutorStop(run.adapterData?.fusionStop) && run.persistFlight) throw new Error("Executor stop or persistence is still in progress.");
					if (hasUnconfirmedPrompt(run)) throw new Error("Fusion prompt delivery is unconfirmed. Retry /fusion-run with the same task before resetting.");
					const error = run.controller.resetError(false, run.reconciling);
					if (error) throw new Error(error);
					resetting = true;
					try {
						await store.removeSettled(run.runId);
						await run.lease?.release();
						await run.runtime.release(run.handle);
						await run.runtime.shutdown();
						runs.delete(context.sessionID);
						forgetTurnState(context.sessionID);
						if (owner === context.sessionID) owner = undefined;
						return { content: "Fusion run reset." };
					} finally { resetting = false; }
				},
			});
		});
		// User-facing controls over the native command surface (pinned live on
		// v2.2.3: `execute` receives { sessionID, prompt: { text } } and its return
		// value is presentation-only, so commands perform actions; the run's task
		// prompt is injected through session.prompt).
		async function reportCommand(sessionID: string, description: string, content: string): Promise<string> {
			if (!ctx.session.synthetic) throw new Error("This OpenCode host cannot deliver Fusion command output; use the Fusion status or stats tool.");
			// OpenCode 2.2.5's TUI renders synthetic messages from `description`
			// only (SessionNoticeMessageV2); `text` alone is model/inbox content.
			// Keep the full report visible without submitting a model turn.
			await ctx.session.synthetic({ sessionID, text: content, description: `${description}\n${content}`, resume: false });
			return content;
		}
		const commandRegistration = await ctx.command?.transform?.((editor) => {
			editor.add({
				name: "fusion-run",				description: "Start a Fusion run with the given task [task]",
				execute: async (args) => {
					const task = args.prompt?.text?.trim();
					if (!task) throw new Error("Provide a task: /fusion-run <task>");
					if (typeof ctx.session.prompt !== "function") throw new Error("This host cannot inject the run prompt; tell the fusion agent the task directly instead.");
					if (typeof ctx.session.switchAgent !== "function") throw new Error("This host cannot select the Fusion agent; select it before starting a run.");
					if (promptInFlight) throw new Error("Fusion prompt delivery is already in progress.");
					const existing = runs.get(args.sessionID);
					const delivery = existing?.adapterData?.fusionPrompt as { id?: unknown; task?: unknown; state?: unknown } | undefined;
					const retry = !!existing && delivery?.state === "pending" && delivery.task === task && typeof delivery.id === "string";
					const run = retry ? existing! : await startRun(args.sessionID, task);
					promptInFlight = true;
					try {
						const messageID = retry ? delivery!.id as string : `msg_fusion_${randomUUID().replaceAll("-", "")}`;
						if (!retry) {
							run.adapterData = { ...run.adapterData, fusionPrompt: { id: messageID, task, state: "pending" } };
						}
						await persist(args.sessionID, run);
						const label = run.model ? `${run.model.provider}/${run.model.modelId}${run.model.variant ? `#${run.model.variant}` : ""}` : "the host-configured model";
						await ctx.session.switchAgent({ sessionID: args.sessionID, agent: "fusion" });
						await ctx.session.prompt({ sessionID: args.sessionID, id: messageID, text: buildSupervisorPrompt(task, label) });
						run.adapterData = { ...run.adapterData, fusionPrompt: { id: messageID, task, state: "delivered" } };
						try { await persist(args.sessionID, run); }
						catch (error) { run.adapterData = { ...run.adapterData, fusionPrompt: { id: messageID, task, state: "pending" } }; throw error; }
						return `Fusion run started (${label}).`;
					} catch (error) {
						throw new Error(`Fusion prompt delivery could not be confirmed. Retry /fusion-run with the same task to reuse the same message ID, or inspect the session before cleaning. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
					} finally { promptInFlight = false; }
				},
			});
			editor.add({
				name: "fusion-mode",
				description: "Show or toggle Fusion persistent mode [on|off]",
				execute: async (args) => {
					if (!ctx.session.synthetic) throw new Error("This OpenCode host cannot deliver Fusion command output.");
					const arg = args.prompt?.text?.trim().toLowerCase();
					// No argument is read-only: it reports the current mode without
					// touching storage, like the /fusion-config no-argument view.
					if (!arg) return await reportCommand(args.sessionID, "Fusion mode", [
						`Fusion persistent mode is ${fusionMode ? "on" : "off"}.`,
						fusionMode ? "Fusion tools stay available to the fusion agent between runs; tasks can start without /fusion-run." : "Fusion tools require an active run; /fusion-run starts one.",
						"Usage: /fusion-mode <on|off>.",
					].join("\n"));
					if (arg !== "on" && arg !== "off") throw new Error("Use /fusion-mode, /fusion-mode on, or /fusion-mode off.");
					const enabled = arg === "on";
					await setFusionMode(enabled);
					return await reportCommand(args.sessionID, "Fusion mode", enabled
						? "Fusion persistent mode enabled: fusion tools stay available to the fusion agent between runs."
						: "Fusion persistent mode disabled: fusion tools require an active run (/fusion-run starts one).");
				},
			});
			editor.add({
				name: "fusion-config",
				description: "Show or set the Fusion executor model (executor and scout) [list [filter] | provider/model [variant]]",
				execute: async (args) => {
					if (!ctx.session.synthetic) throw new Error("This OpenCode host cannot deliver Fusion command output.");
					// The command is user-driven: no supervisor authorization, no
					// active run required, and no model call — an explicit selection
					// shares the serialized operation the fusion_configure tool uses.
					const parsed = parseConfigCommand(args.prompt?.text ?? "");
					if (parsed.action === "error") throw new Error(`${parsed.message} Usage: /fusion-config [list [filter] | <provider>/<model> [variant]]`);
					if (parsed.action === "show") return await reportCommand(args.sessionID, "Fusion config", configStatusText(args.sessionID));
					if (parsed.action === "list") return await reportCommand(args.sessionID, "Fusion config models", await listCatalogModels(parsed.filter));
					const result = await configureExecutorModel(args.sessionID, parsed);
					return await reportCommand(args.sessionID, "Fusion config", formatConfiguredModel(result));
				},
			});
			editor.add({
				name: "fusion-budget",
				description: "Show or set Fusion run limits: active time, observed spend, provider token ceilings [show | time <30m> | cost <dollars> | token <provider> <tokens> | clear time|cost|token <provider>|all | continue]",
				execute: async (args) => {
					if (!ctx.session.synthetic) throw new Error("This OpenCode host cannot deliver Fusion command output.");
					return await reportCommand(args.sessionID, "Fusion budget", await budgetCommand(args.sessionID, args.prompt?.text ?? ""));
				},
			});
			editor.add({
				name: "fusion-status",
				description: "Show the current Fusion run state",
				execute: async (args) => await reportCommand(args.sessionID, "Fusion status", await statusContent(args.sessionID)),
			});
			editor.add({
				name: "fusion-stats",
				description: "Show the current Fusion run's budgets",
				execute: async (args) => await reportCommand(args.sessionID, "Fusion stats", statsContent(args.sessionID)),
			});
			editor.add({
				name: "fusion-resume",
				description: "Show the Fusion run's recovery state",
				execute: async (args) => await reportCommand(args.sessionID, "Fusion resume", await resumeContent(args.sessionID)),
			});
			editor.add({
				name: "fusion-clean",
				description: "Release settled Fusion resources for this workspace",
				execute: async (args) => {
					if (!ctx.session.synthetic) throw new Error("This OpenCode host cannot deliver Fusion command output.");
					return await reportCommand(args.sessionID, "Fusion clean", await cleanWorkspace(args.sessionID));
				},
			});
			editor.add({
				name: "fusion-stop",
				description: "Stop the owned Fusion run (executor and scouts) immediately and report observed activity (no model call)",
				async execute(args) {
					if (!ctx.session.synthetic) throw new Error("This host cannot deliver Fusion stop feedback.");
					const stop = await stopExecutor(args.sessionID, args.prompt?.text?.trim() || undefined);
					if (!stop) return reportCommand(args.sessionID, "Fusion executor stop", "No Fusion run in this session.");
					await stopNotice(args.sessionID, stop);
					return stopFeedback(stop);
				},
			});
			editor.add({
				name: "fusion-doctor",
				description: "Diagnose Fusion locally (read-only): versions, mode, tools, agents, models, backend, ownership storage, recovery conflicts [auth]",
				execute: async (args) => {
					if (!ctx.session.synthetic) throw new Error("This OpenCode host cannot deliver Fusion command output.");
					const request = args.prompt?.text?.trim().toLowerCase();
					if (request && request !== "auth") throw new Error("Usage: /fusion-doctor [auth]. Default diagnostics are local, read-only, and never make a model call.");
					return await reportCommand(args.sessionID, "Fusion doctor", await doctorContent(args.sessionID, request === "auth"));
				},
			});
		});
		// Embedding hosts may call this on unload. Process exit also releases SQLite locks.
		/** Dispose a native registration handle defensively: unload paths must never throw. */
		const disposeRegistration = (registration: unknown): void => {
			if (!registration || typeof (registration as { dispose?: unknown }).dispose !== "function") return;
			try { void Promise.resolve((registration as { dispose: () => unknown }).dispose()).catch(() => {}); } catch {}
		};
		return {
			close() {
				busController.abort();
				busSinks.delete(onScoutBusEvent);
				busSinks.delete(onTurnBusEvent);
				busSinks.delete(onStopBusEvent);
				scoutGuards.clear();
				settlementChains.clear();
				activeScout = undefined;
				for (const run of runs.values()) run.lease?.close();
				// Owned native registrations (agents, commands) are removed so a
				// close-without-unload cannot leave Fusion's contributions behind.
				disposeRegistration(agentRegistration);
				disposeRegistration(commandRegistration);
			},
		};
	},
};

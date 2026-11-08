import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	AssistantEntry,
	type Conversation,
	type ConversationId,
	createRegistry,
	type Cursor,
	type EntryRecord,
	type EntryId,
	type Extension,
	Harness,
	type HarnessOptions,
	type SettledSubmissionRecord,
	type Submission,
	type SubmissionId,
	type TaskId,
	UserEntry,
	watchEvents,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
	type ExecutorBackend,
	type ExecutorConfig,
	type ExecutorEvent,
	type ExecutorHandle,
	type ExecutorResumeOptions,
	type ExecutorTurnResult,
	lastAssistantOutputFromMessages,
	type ScoutRequest,
	type ScoutResult,
} from "../executor-backend.ts";
import type { WorkerCapabilities } from "../../core/worker.ts";
import { aggregateUsage, createEmptyUsage } from "../../usage.ts";
import { createFusionContext } from "./context.ts";
import { createDurableEventMapper } from "./events.ts";
import { scoutCallsDoc, scoutTools } from "./scout-tools.ts";
import { staleWork } from "./stale.ts";

/** Sentinel thrown when cancellation is observed after asynchronous setup
 * but before the submission is sent; settle() converts it into an aborted
 * turn result so a cancelled stop can never leave a fresh submission behind. */
class CancelledBeforeSubmission extends Error {
	constructor() {
		super("Cancelled before the durable submission was sent.");
	}
}

async function collectAssistantMessages(
	conversation: Conversation,
	boundary: (entry: EntryRecord) => boolean,
	requireExactTurn = false,
	expectedAnswer?: EntryId,
): Promise<AssistantMessage[]> {
	const messages: AssistantMessage[] = [];
	let cursor: Cursor | undefined;
	let foundBoundary = false;
	let foundAnswer = expectedAnswer === undefined;
	for (;;) {
		const page = await conversation.entries({}, 50, cursor, BACKGROUND_CONTEXT);
		let reached = false;
		for (const entry of page.items) {
			if (boundary(entry)) {
				reached = true;
				foundBoundary = true;
				break;
			}
			if (requireExactTurn && UserEntry.is(entry)) throw new Error("Cannot recover: a newer user turn obscures the requested submission.");
			const message = AssistantEntry.is(entry) ? entry.model?.[0] : undefined;
			if (message !== undefined) {
				if (requireExactTurn && expectedAnswer !== undefined && !foundAnswer && entry.id !== expectedAnswer) throw new Error("Cannot recover: a newer assistant message obscures the requested submission.");
				if (entry.id === expectedAnswer) foundAnswer = true;
				messages.push(message as unknown as AssistantMessage);
			}
		}
		if (reached || page.next === undefined) break;
		cursor = page.next;
	}
	if (requireExactTurn && (!foundBoundary || !foundAnswer)) throw new Error("Cannot recover: the requested submission's transcript evidence is incomplete.");
	messages.reverse();
	return messages;
}

export async function createDurableExecutorBackend(): Promise<ExecutorBackend> {
	const executorContext = createFusionContext("executor");
	const scoutContext = createFusionContext("scout");
	const executorExtensions: Extension[] = [
		CodingTools as unknown as Extension,
		executorContext.extension,
	];
	const scoutExtensions: Extension[] = [scoutTools, scoutContext.extension];
	const protectedConversations = new Set<number>();
	let harnessPromise: Promise<Harness> | undefined;
	const openHarness = (): Promise<Harness> => {
		harnessPromise ??= (async () => {
			const agentDir = getAgentDir();
			await mkdir(join(agentDir, "fusion"), { recursive: true });
			const storage = await openNodeSqliteStorage(join(agentDir, "fusion", "durable.sqlite"));
			const registry = createRegistry();
			registry.install(CodingTools as unknown as Extension);
			registry.install(executorContext.extension);
			registry.install(scoutContext.extension);
			registry.install(scoutTools);
			const models = await ModelRuntime.create({
				authPath: join(agentDir, "auth.json"),
				modelsPath: join(agentDir, "models.json"),
			});
			return Harness.open(
				storage,
				{
					models: models as unknown as HarnessOptions["models"],
					registry,
					settings: { extensions: executorExtensions },
					env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
				},
				BACKGROUND_CONTEXT,
			);
		})().catch((error: unknown) => {
			harnessPromise = undefined;
			throw error;
		});
		return harnessPromise;
	};
	const discardStale = async (harness: Harness): Promise<void> => {
		const stale = staleWork(
			await harness.inspect(BACKGROUND_CONTEXT),
			protectedConversations,
		);
		for (const id of stale.submissions) {
			try {
				await harness.abortSubmission(id as SubmissionId, BACKGROUND_CONTEXT);
			} catch {}
		}
		for (const id of stale.tasks) {
			try {
				await harness.abortTask(id as TaskId, BACKGROUND_CONTEXT);
			} catch {}
		}
	};
	const settle = async (
		harness: Harness,
		conversation: Conversation,
		start: () => Promise<Submission>,
	options: { signal?: AbortSignal; onEvent?: (event: ExecutorEvent) => void },
	requireExactTurn = false,
	/** start() attaches to a submission that already exists (resume):
	 * cancellation must still wait on it for the real outcome instead of
	 * fabricating a terminal result, or a still-running submission would be
	 * falsely settled. */
	attachToExisting = false,
	): Promise<ExecutorTurnResult> => {
		const { signal, onEvent } = options;
		const map = createDurableEventMapper();
		// No submission exists for a turn cancelled before submission.
		const cancelled = (): ExecutorTurnResult => ({
			text: "",
			stopReason: "aborted",
			errorMessage: "Cancelled before the executor submission was sent.",
			usage: createEmptyUsage(),
		});
		const abortExecutor = (): void => {
			void conversation.abort(BACKGROUND_CONTEXT);
		};
		// Attached before any awaited setup so cancellation during event
		// subscription still reaches the conversation, and detached in the
		// finally below whatever happened. A signal that was already aborted
		// never fires the event, so request the abort directly.
		signal?.addEventListener("abort", abortExecutor, { once: true });
		if (signal?.aborted) abortExecutor();
		let stream: Awaited<ReturnType<typeof watchEvents>> | undefined;
		let record: SettledSubmissionRecord;
		try {
			stream = await watchEvents(harness, conversation.id, BACKGROUND_CONTEXT);
			stream.start(async (events) => {
				for (const event of events) {
					for (const mapped of map(event)) {
						try {
							onEvent?.(mapped);
						} catch {}
					}
				}
			});
			// Cancellation during subscription setup must never create a
			// submission. A resume is different: its submission already exists,
			// so it waits for that submission's real outcome below instead of
			// returning a terminal result that would falsely settle the run.
			if (signal?.aborted && !attachToExisting) return cancelled();
			try {
				// start() rechecks cancellation after its own asynchronous setup
				// (discardStale) and throws CancelledBeforeSubmission instead of
				// submitting; anything else propagates to the caller.
				record = await (await start()).wait(BACKGROUND_CONTEXT);
			} catch (error) {
				if (error instanceof CancelledBeforeSubmission) return cancelled();
				throw error;
			}
		} finally {
			signal?.removeEventListener("abort", abortExecutor);
			if (stream !== undefined) {
				try {
					await stream.stop();
				} catch {}
			}
		}
		const placed = record.entry;
		const messages =
			placed === undefined
				? []
				: await collectAssistantMessages(conversation, (entry) => entry.id === placed, requireExactTurn, record.status === "done" ? record.answer : undefined);
		const result: ExecutorTurnResult = {
			...lastAssistantOutputFromMessages(messages),
			usage: aggregateUsage(messages),
		};
		if (record.status === "unanswered") {
			if (result.stopReason !== "error" && result.stopReason !== "aborted") {
				result.stopReason = signal?.aborted ? "aborted" : "error";
			}
			result.errorMessage ??= record.reason;
		}
		return result;
	};
	const resumeTurn = async (
		harness: Harness,
		conversation: Conversation,
		options: ExecutorResumeOptions,
	): Promise<ExecutorTurnResult> => {
		if (!options.requestId) throw new Error("Cannot recover without the original executor request ID; inspect the run manually.");
		const record = await conversation.commit((tx) => tx.submissionByRequest(conversation.id, options.requestId!), BACKGROUND_CONTEXT);
		if (!record || record.type !== "input" || record.conversationId !== conversation.id || record.requestId !== options.requestId) {
			throw new Error("No matching executor submission found; the outcome remains uncertain.");
		}
		return settle(harness, conversation, async () => {
			const submission = await harness.submission(record.id, BACKGROUND_CONTEXT);
			if (!submission) throw new Error("Interrupted executor submission not found.");
			return submission;
		}, options, true, true);
	};
	const makeHandle = (
		harness: Harness,
		conversation: Conversation,
		config: ExecutorConfig,
	): ExecutorHandle => {
		let currentThinking = config.thinking;
		return {
			model: config.model,
			thinking: config.thinking,
			resumeRef: () => String(conversation.id),
			prompt: (text, options) =>
				settle(
					harness,
					conversation,
					async () => {
						protectedConversations.add(conversation.id);
						await discardStale(harness);
						// Cancellation during that await only aborted an idle
						// conversation; recheck immediately before submitting so a
						// cancelled stop never records a new submission.
						if (options.signal?.aborted) throw new CancelledBeforeSubmission();
						return conversation.submit(
							{ type: "input", content: text, requestId: options.requestId },
							BACKGROUND_CONTEXT,
						);
					},
					options,
				),
			resume: (options) => resumeTurn(harness, conversation, options),
			abort: () => conversation.abort(BACKGROUND_CONTEXT),
			setThinking: async (level) => {
				if (level !== currentThinking) {
					await conversation.configure({ thinkingLevel: level }, BACKGROUND_CONTEXT);
					currentThinking = level;
				}
			},
			dispose: () => {},
		};
	};
	return {
		kind: "durable",
		capabilities: PI_DURABLE_CAPABILITIES,
		async createExecutor(config: ExecutorConfig): Promise<ExecutorHandle> {
			const harness = await openHarness();
			const instructions = await executorContext.instructions(config.cwd);
			const conversation = await harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: {
						model: { provider: config.model.provider, modelId: config.model.id },
						thinkingLevel: config.thinking,
						cwd: config.cwd,
						instructions,
						extensions: executorExtensions,
					},
				},
				BACKGROUND_CONTEXT,
			);
			protectedConversations.add(conversation.id);
			return makeHandle(harness, conversation, config);
		},
		async openExecutor(config: ExecutorConfig, ref: string): Promise<ExecutorHandle> {
			const harness = await openHarness();
			const conversation = await harness.conversation(
				Number(ref) as ConversationId,
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) {
				throw new Error("Durable executor conversation not found.");
			}
			protectedConversations.add(conversation.id);
			await discardStale(harness);
			return makeHandle(harness, conversation, config);
		},
		async scout(request: ScoutRequest): Promise<ScoutResult> {
			const harness = await openHarness();
			const instructions = await scoutContext.instructions(request.cwd);
			const conversation = await harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: {
						model: { provider: request.model.provider, modelId: request.model.id },
						thinkingLevel: request.thinking,
						cwd: request.cwd,
						instructions,
						extensions: scoutExtensions,
					},
					init: async (tx, conversationId) => {
						const doc = await tx.doc(scoutCallsDoc, conversationId);
						doc.max = request.maxToolCalls;
					},
				},
				BACKGROUND_CONTEXT,
			);
			protectedConversations.add(conversation.id);
			// A failed wait may leave work running; retain protection for this backend lifetime.
			await discardStale(harness);
			const result = await settle(
				harness,
				conversation,
				() =>
					conversation.submit(
						{
							type: "input",
							content: request.prompt,
							requestId: `scout:${randomUUID()}`,
						},
						BACKGROUND_CONTEXT,
					),
				request,
			);
			const doc = await harness.snapshot(
				scoutCallsDoc,
				conversation.id,
				BACKGROUND_CONTEXT,
			);
			return { ...result, capped: (doc?.count ?? 0) > request.maxToolCalls };
		},
		async dispose(): Promise<void> {
			const pending = harnessPromise;
			if (pending === undefined) return;
			await (await pending).close(BACKGROUND_CONTEXT);
			if (harnessPromise === pending) harnessPromise = undefined;
		},
	};
}

export const PI_DURABLE_CAPABILITIES: Readonly<WorkerCapabilities> = Object.freeze({
	transcriptReopen: true,
	activeTurnReattach: true,
	durableExecution: true,
	idempotentSubmission: false,
	readOnlyScout: true,
	workerAbort: true,
	workerEvents: true,
	exactScoutToolLimit: true,
});

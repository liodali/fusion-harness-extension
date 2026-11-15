import { formatDuration } from "./duration.ts";
import type { ExecutionObservation } from "./run-control.ts";

/**
 * Shared waiting/blocked-state observation (R3). The contract stays host-free:
 *
 * - A confirmed wait is a native signal the host explicitly opened (a
 *   permission request, a user question, a blocking UI prompt). It pauses the
 *   worker's active clock: waiting time never consumes active execution time.
 * - Wait labels are bounded and composed only from host-provided names
 *   (permission action/resources/message, question titles). Private
 *   reasoning, tool arguments beyond the host's own label, and tool-result
 *   bodies never enter a wait label.
 * - Unrecognized observation is "unknown", never a blocked or terminal
 *   claim. The stale flag marks a span without observed activity for
 *   inspection; it never asserts an outcome.
 * - Updates are bounded: outstanding waits are tracked by identity
 *   (several can be open; the clock resumes after the last closes),
 *   idempotent replays are no-ops, and the span history is a bounded ring.
 */

/** What kind of confirmed wait is open. "unknown" marks a wait the adapter
 * could observe but could not classify; it never invents a purpose. */
export type WaitKind = "permission" | "user" | "unknown";

/** How a confirmed wait ended, when the host reports it. Absent means the
 * adapter closed the wait without an outcome (turn end, restart). */
export type WaitOutcome = "answered" | "denied" | "cancelled" | "resolved";

export interface OpenWait {
	/** Host identity of the open wait (permission/form/prompt id). */
	id: string;
	kind: WaitKind;
	/** Bounded label composed from host-provided names only. */
	label: string;
	/** Epoch ms when the wait opened. */
	startedAt: number;
}

/** A wait the translation opens; the receiving clock stamps startedAt. */
export type IncomingWait = Omit<OpenWait, "startedAt">;

/** One completed wait span. */
export interface WaitSpan {
	kind: WaitKind;
	label: string;
	startedAt: number;
	endedAt: number;
	outcome?: WaitOutcome;
}

export interface WaitStatusSnapshot {
	/** The oldest outstanding wait, when any is open. */
	wait?: OpenWait;
	/** How many waits are outstanding right now (bounded by host behavior). */
	openWaits: number;
	/** Accumulated duration of completed wait spans, in ms. */
	waitingMs: number;
	/** Last observed worker activity. */
	lastActivity?: { label: string; at: number; observation: ExecutionObservation };
	/** True when no activity was observed for the stale threshold. Advisory
	 * only: it must never read as blocked or terminal. */
	stale: boolean;
}

/** One bounded wait-observing tracker for one worker turn. `target` is the
 * worker's active clock (or undefined when the worker is backgrounded and
 * no live clock exists — waits are still observed for display). */
export class WaitClock {
	/** Outstanding waits by host identity; several can be open at once
	 * (e.g. parallel tool calls each awaiting a permission decision). */
	private openWaits = new Map<string, OpenWait>();
	private spans: WaitSpan[] = [];
	private last?: { label: string; at: number; observation: ExecutionObservation };
	/** The last observed activity, or the clock's start when none was seen:
	 * a turn with no observable activity still ages toward the threshold. */
	private lastActivityAt?: number;
	private readonly startedAt: number;
	/** Set by the host when its idle timer fires; advisory, never an outcome. */
	private staleFlag = false;

	constructor(
		private readonly target: { pause(): void; resume(): void } | undefined,
		private readonly options: { now?: () => number; maxSpans?: number; staleAfterMs?: number } = {},
	) {
		this.startedAt = this.now();
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}

	/** Open a confirmed wait: the worker's active clock pauses (the first
	 * open pauses; already paused is a no-op). Outstanding waits are tracked
	 * by identity: a second request while one is open does not close the
	 * first, and reopening the same id (a replayed event) is a no-op.
	 * Returns the opened wait, or undefined for an empty id or a replay. */
	openWait(input: { id: string; kind: WaitKind; label: string; startedAt?: number }): OpenWait | undefined {
		if (!input.id.trim()) return undefined;
		if (this.openWaits.has(input.id)) return undefined;
		const wait: OpenWait = { id: input.id, kind: input.kind, label: waitLabel(input.label), startedAt: input.startedAt ?? this.now() };
		this.openWaits.set(input.id, wait);
		this.target?.pause();
		return wait;
	}

	/** Close the matching open wait and record its span. The active clock
	 * resumes only when the last outstanding wait closes: answering one of
	 * several requests leaves the others waiting (and the clock paused).
	 * Returns the closed wait, or undefined when the id was not open (late,
	 * duplicate, or foreign event). */
	closeWait(input: { id: string; outcome?: WaitOutcome; endedAt?: number }): OpenWait | undefined {
		const open = this.openWaits.get(input.id);
		if (!open) return undefined;
		this.openWaits.delete(input.id);
		const span: WaitSpan = { kind: open.kind, label: open.label, startedAt: open.startedAt, endedAt: input.endedAt ?? this.now() };
		if (input.outcome !== undefined) span.outcome = input.outcome;
		this.spans = [...this.spans, span].slice(-(this.options.maxSpans ?? 16));
		if (this.openWaits.size === 0) this.target?.resume();
		return open;
	}

	/** The outstanding waits, oldest first (by when each opened). */
	outstanding(): OpenWait[] {
		return [...this.openWaits.values()].sort((a, b) => a.startedAt - b.startedAt);
	}

	/** Record observed worker activity. Tool names and host-rendered labels
	 * only; the caller must never pass private reasoning or result bodies. */
	markActivity(input?: { label?: string; observation?: ExecutionObservation; at?: number }): void {
		const at = input?.at ?? this.now();
		this.lastActivityAt = at;
		this.staleFlag = false;
		if (input?.label !== undefined || input?.observation !== undefined) {
			this.last = { label: waitLabel(input.label ?? this.last?.label ?? ""), at, observation: input.observation ?? this.last?.observation ?? "implementing" };
		}
	}

	/** Host idle-timer flag: no observed activity for a while. Never asserts
	 * a blocked or terminal outcome; the next activity clears it. */
	noteStale(): void {
		if (this.openWaits.size > 0) return;
		this.staleFlag = true;
	}

	status(): WaitStatusSnapshot {
		// The observed waiting time is the union of the wait spans: two
		// overlapping requests (e.g. parallel permission asks) must not
		// double-count the time both were open.
		const merged: WaitSpan[] = [];
		for (const span of [...this.spans].sort((a, b) => a.startedAt - b.startedAt)) {
			const last = merged.at(-1);
			if (last && span.startedAt <= last.endedAt) last.endedAt = Math.max(last.endedAt, span.endedAt);
			else merged.push({ ...span });
		}
		const waitingMs = merged.reduce((sum, span) => sum + Math.max(0, span.endedAt - span.startedAt), 0);
		const now = this.now();
		const idleSince = this.lastActivityAt ?? this.startedAt;
		const idleMs = Math.max(0, now - idleSince);
		const stale = this.openWaits.size === 0 && (this.staleFlag || idleMs >= (this.options.staleAfterMs ?? 300000));
		const oldest = this.outstanding()[0];
		return {
			...(oldest ? { wait: { ...oldest } } : {}),
			openWaits: this.openWaits.size,
			waitingMs,
			...(this.last ? { lastActivity: { ...this.last } } : {}),
			stale,
		};
	}

	/** Dispose with the worker: state is process-local and never persisted.
	 * The clock target is left alone — the caller discards the clock (and
	 * its turn) together, so a dangling resume could only rearm a timer for
	 * a turn that is over. */
	reset(): void {
		this.openWaits.clear();
		this.spans = [];
		this.last = undefined;
		this.lastActivityAt = undefined;
		this.staleFlag = false;
	}
}

/** Bound and sanitize a wait label: strip ANSI and control characters,
 * collapse whitespace, and truncate. Hosts must pass only host-provided
 * names; the sanitizer guarantees no control bytes or oversized labels. */
export function waitLabel(value: string, limit = 120): string {
	return value
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, limit);
}

/** The required operator action for an open wait, with identical wording in
 * both hosts. "unknown" asks for inspection without inventing a purpose. */
export function waitAction(kind: WaitKind, label: string): string {
	if (kind === "permission") return `allow or deny it (${label || "the permission request"}) to continue`;
	if (kind === "user") return `answer or cancel it (${label || "the question"}) to continue`;
	return `inspect the worker session (${label || "unrecognized wait"})`;
}

/** One shared waiting/blocked-state display line. `waitingMs` counts only
 * observed wait spans; `unobservedMs` is wall time the adapter could not
 * attribute to active execution or a confirmed wait, reported as such. */
export function describeWaitStatus(input: {
	worker: string;
	observation: ExecutionObservation;
	lastActivity?: string;
	activeMs?: number;
	waitingMs?: number;
	unobservedMs?: number;
	wait?: { kind: WaitKind; label: string; startedAt: number };
	stale?: boolean;
	now?: number;
}): string {
	const now = input.now ?? Date.now();
	const parts: string[] = [];
	if (input.activeMs !== undefined) parts.push(`active ${formatDuration(input.activeMs)}`);
	if (input.waitingMs !== undefined && input.waitingMs > 0) parts.push(`observed waits ${formatDuration(input.waitingMs)}`);
	if (input.unobservedMs !== undefined && input.unobservedMs > 0) parts.push(`unattributed ${formatDuration(input.unobservedMs)}`);
	const durations = parts.length > 0 ? ` (${parts.join(", ")})` : "";
	if (input.wait) {
		const held = ` for ${formatDuration(Math.max(0, now - input.wait.startedAt))}`;
		const action = waitAction(input.wait.kind, input.wait.label);
		const name = input.wait.kind === "permission" ? "permission requested" : input.wait.kind === "user" ? "question asked" : "unrecognized wait";
		return `${input.worker} ${input.observation === "unknown" ? "waiting" : `waiting (${input.observation})`}: ${name}${input.wait.label ? ` — ${input.wait.label}` : ""}${held}${durations}; ${action}.`;
	}
	const activity = input.lastActivity !== undefined && input.lastActivity.trim() ? ` — last observed: ${input.lastActivity}` : "";
	const stale = input.stale ? " No observed activity for a while; inspect the worker if this is unexpected." : "";
	return `${input.worker} ${input.observation}: ${input.observation === "unknown" ? "the adapter cannot establish what the worker is doing" : "the worker is executing"}${activity}${durations}.${stale}`;
}

/** OpenCode wait bus events, pinned live on v2.3.0 and read defensively for
 * additive compatibility:
 * - `permission.asked` / `permission.updated`: data carries `sessionID`, an
 *   identity (`id`/`requestID`/`permissionID`), and host-provided names
 *   (`action`, `resources`, `message`, `title`).
 * - `permission.replied`: `requestID`/`permissionID`/`id` plus `reply`
 *   ("once"/"always" allowed, "reject" denied; anything else unresolved).
 * - `form.created`: `data.form` carries `id`, `sessionID`, `title`, and
 *   `fields` (field titles are host-provided names, not tool bodies).
 * - `form.replied` / `form.cancelled`: the form id ends the wait.
 * - `session.status` (busy/idle/retry) and `session.idle` are activity
 *   signals, not outcomes.
 * Anything unrecognizable is not a wait signal; the caller keeps its
 * previous observation (unknown), never a blocked or terminal claim. */
export interface OpenCodeWaitSignal {
	/** The session the signal belongs to, resolved from the event shape. */
	sessionID: string;
	open?: IncomingWait;
	close?: { id: string; outcome?: WaitOutcome };
	/** Activity-only signal (the worker is executing, or went idle). */
	activity?: { busy: boolean; status?: string };
}

export function openCodeWaitSignal(type: string, data: Record<string, unknown> | undefined): OpenCodeWaitSignal | undefined {
	const record = data && typeof data === "object" ? data : undefined;
	if (!record) return undefined;
	// form.created nests the session under data.form; every other wait event
	// carries it at the top level.
	const nestedForm = type === "form.created" && record.form && typeof record.form === "object" ? record.form as Record<string, unknown> : undefined;
	const sessionId = typeof (nestedForm?.sessionID ?? record.sessionID) === "string" ? (nestedForm?.sessionID ?? record.sessionID) as string : undefined;
	if (!sessionId) return undefined;
	const identity = [record.id, record.requestID, record.permissionID].find((value) => typeof value === "string" && !!value.trim()) as string | undefined;
	const busy = (status: unknown): OpenCodeWaitSignal => ({ sessionID: sessionId, activity: { busy: true, ...(typeof status === "string" ? { status } : {}) } });
	switch (type) {
		case "permission.asked":
		case "permission.updated": {
			if (!identity) return undefined;
			const pieces: string[] = [];
			if (typeof record.action === "string" && record.action.trim()) pieces.push(record.action.trim());
			const resources = Array.isArray(record.resources) ? record.resources.filter((value): value is string => typeof value === "string" && !!value.trim()) : [];
			if (resources.length > 0) pieces.push(resources.join(", "));
			if (pieces.length === 0 && typeof record.message === "string") pieces.push(record.message);
			if (pieces.length === 0 && typeof record.title === "string") pieces.push(record.title);
			return { sessionID: sessionId, open: { id: identity, kind: "permission", label: waitLabel(pieces.join(" ")) } };
		}
		case "permission.replied": {
			if (!identity) return undefined;
			const reply = typeof record.reply === "string" ? record.reply : undefined;
			return { sessionID: sessionId, close: { id: identity, outcome: reply === "reject" ? "denied" : reply === "once" || reply === "always" ? "answered" : "resolved" } };
		}
		case "form.created": {
			const form = nestedForm;
			const formId = typeof form?.id === "string" ? form.id : undefined;
			if (!form || !formId) return undefined;
			const label = [typeof form.title === "string" ? form.title : ""];
			const fields = Array.isArray(form.fields) ? form.fields : [];
			for (const field of fields) {
				const title = field && typeof field === "object" && typeof (field as Record<string, unknown>).title === "string" ? (field as Record<string, unknown>).title as string : undefined;
				if (title?.trim()) { label.push(title); break; }
			}
			return { sessionID: sessionId, open: { id: formId, kind: "user", label: waitLabel(label.filter(Boolean).join(" — ")) } };
		}
		case "form.replied":
		case "form.cancelled": {
			if (!identity) return undefined;
			return { sessionID: sessionId, close: { id: identity, outcome: type === "form.replied" ? "answered" : "cancelled" } };
		}
		case "session.status": {
			const status = record.status && typeof record.status === "object" ? (record.status as Record<string, unknown>).type : undefined;
			if (status === "busy") return busy(status);
			if (status === "retry") return busy(status);
			return { sessionID: sessionId, activity: { busy: false, ...(typeof status === "string" ? { status } : {}) } };
		}
		case "session.idle":
			return { sessionID: sessionId, activity: { busy: false, status: "idle" } };
		default:
			return undefined;
	}
}

/** Pi's blocking extension UI prompts (pinned on the Pi SDK: `ui_prompt_start`
 * / `ui_prompt_end` with kind select/confirm/input/editor/custom). A confirm
 * dialog is an approval gate ("permission"); every other kind is a user
 * question. The outcome is not carried by the end event, so Pi closes waits
 * without an outcome. */
export function piUiPromptWait(kind: string, title: string | undefined): { kind: WaitKind; label: string } {
	return {
		kind: kind === "confirm" ? "permission" : kind === "select" || kind === "input" || kind === "editor" || kind === "custom" ? "user" : "unknown",
		label: waitLabel(typeof title === "string" ? title : ""),
	};
}

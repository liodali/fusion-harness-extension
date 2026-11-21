/**
 * R5 diagnostics core. Pure, harness-free: hosts gather the facts with their
 * own read-only surfaces (catalog validation, capability tables, ownership
 * probes, the shared recovery derivation) and this module renders one bounded,
 * actionable report. The default report is computed entirely from local
 * reads — it never performs a model call, never submits work, and never
 * carries credential values: facts describe *whether* credentials exist and
 * where they come from, never what they are.
 */
import type { WorkerCapabilities } from "./worker.ts";
import type { RecoveryGuidance } from "./guidance.ts";

export type DoctorStatus = "ok" | "warn" | "fail" | "unknown";

export interface DoctorCheck {
	/** Stable identifier for fixtures and tests. */
	id: string;
	title: string;
	status: DoctorStatus;
	/** Bounded human detail; never credential values, environment dumps, or prompts. */
	detail: string;
	/** The recommended fix for anything that is not ok. */
	fix?: string;
}

/** One configured role model as the doctor read it from the host. */
export interface DoctorModelFact {
	role: "supervisor" | "executor";
	label: string;
	/** The host's own model catalog contains this exact model (local read). */
	inCatalog: boolean;
	/** Where a host validated it, its own message (reuse of existing validation). */
	problem?: string;
	/** Local credential posture when the host can read it; never a credential value. */
	auth?: { configured: boolean; source?: string };
	/** Selection-policy drift the host's own policy reports (e.g. cohort tier). */
	policyNote?: string;
}

/** A Fusion agent the host exposes, from the host's own agent view. */
export interface DoctorAgentFact {
	id: string;
	state: "available" | "conflict" | "unavailable";
	differences?: string[];
}

export interface DoctorFacts {
	/** "pi" | "opencode" — display only. */
	harness: string;
	/** The loaded Fusion package identity (best effort; "unknown" when unobservable). */
	fusionVersion: string;
	/** Host version when observable; undefined stays "not observable" — never guessed. */
	hostVersion?: string;
	/** Declared supported host range, when the host has one. */
	supportedHostRange?: string;
	/** undefined = unknown; false = observed outside the supported range. */
	hostSupported?: boolean;
	mode: { enabled: boolean; kind: string; hint: string };
	tools: {
		expected: string[];
		/** Names the host actually carries right now (active or configured). */
		registered: string[];
		/** Expected names the host holds but keeps out of the active set by design. */
		gated?: string[];
		gatedNote?: string;
		/** Host command-registry observation, when the host exposes one:
		 * Fusion commands the registry does not list. */
		commands?: { missing: string[]; note?: string };
	};
	agents?: {
		/** "host-agents": the host exposes named agents Fusion contributes to;
		 * "not-applicable": this host has no named Fusion agents (the check
		 * reads ok with an explanation instead of a fake failure). */
		kind: "host-agents" | "not-applicable";
		contributionSupported?: boolean;
		facts?: DoctorAgentFact[];
		note?: string;
	};
	models: {
		/** The host catalog itself was readable and usable for validation. */
		catalogAvailable: boolean;
		catalogProblem?: string;
		/** The host's own fix for an unusable catalog, when it has one. */
		catalogFix?: string;
		facts: DoctorModelFact[];
		/** Can this host validate credentials without a network/model request? */
		authProbe: "local" | "network";
		authProbeDetail: string;
		/** Host roles Fusion does not choose or validate (e.g. the supervisor's model). */
		note?: string;
	};
	backend: {
		configured: string;
		capabilities?: WorkerCapabilities;
		available: boolean;
		problem?: string;
		note?: string;
	};
	ownership: {
		directory: string;
		/** The storage is usable (exists, private, readable). */
		ready: boolean;
		initialized: boolean;
		/** Owner rows readable at probe time (read-only count). */
		entries?: number;
		problem?: string;
		/** The probe's own recommended fix for its problem, when the generic
		 * directory wording would mislead (e.g. pending crash recovery). */
		fix?: string;
		/** Directory override note (must match across every process). */
		overrideNote?: string;
	};
	recovery: {
		/** Bounded conflict lines (pending identities, stop markers, foreign runs). */
		conflicts: string[];
		guidance?: { line: string; action: string; owed: boolean };
	};
}

export interface DoctorReport {
	harness: string;
	fusionVersion: string;
	checks: DoctorCheck[];
	summary: string;
}

const MAX_CONFLICTS = 6;

function summarize(checks: DoctorCheck[]): string {
	const counts = { ok: 0, warn: 0, fail: 0, unknown: 0 } as Record<DoctorStatus, number>;
	for (const check of checks) counts[check.status] += 1;
	const parts: string[] = [];
	if (counts.fail > 0) parts.push(`${counts.fail} failure${counts.fail === 1 ? "" : "s"}`);
	if (counts.warn > 0) parts.push(`${counts.warn} warning${counts.warn === 1 ? "" : "s"}`);
	if (counts.unknown > 0) parts.push(`${counts.unknown} unknown`);
	if (counts.ok > 0) parts.push(`${counts.ok} ok`);
	return parts.length > 0 ? parts.join(", ") : "no checks";
}

/** One doctor check per acceptance surface, in fixed order. Every check that
 * is not ok carries the recommended fix. */
export function buildDoctorReport(facts: DoctorFacts): DoctorReport {
	const checks: DoctorCheck[] = [];
	checks.push(versionsCheck(facts));
	checks.push(modeCheck(facts));
	checks.push(toolsCheck(facts));
	if (facts.agents) checks.push(agentsCheck(facts.agents));
	checks.push(modelsCheck(facts.models));
	checks.push(backendCheck(facts.backend));
	checks.push(ownershipCheck(facts.ownership));
	checks.push(recoveryCheck(facts.recovery));
	return { harness: facts.harness, fusionVersion: facts.fusionVersion, checks, summary: summarize(checks) };
}

function versionsCheck(facts: DoctorFacts): DoctorCheck {
	const host = facts.hostVersion !== undefined ? facts.hostVersion : "not observable";
	const detail = `Fusion ${facts.fusionVersion} | host ${host}${facts.supportedHostRange ? ` (supported ${facts.supportedHostRange})` : ""}`;
	if (facts.hostSupported === false) {
		return {
			id: "versions",
			title: "Versions",
			status: "warn",
			detail,
			fix: `Host ${facts.hostVersion} is outside Fusion's supported range${facts.supportedHostRange ? ` ${facts.supportedHostRange}` : ""}: the plugin API is hand-mirrored and a release outside it must be re-pinned and its surfaces reverified (see docs/install.md). Fusion features that touch the host's agent/command surfaces may be missing.`,
		};
	}
	return { id: "versions", title: "Versions", status: "ok", detail };
}

function modeCheck(facts: DoctorFacts): DoctorCheck {
	return {
		id: "mode",
		title: "Mode",
		status: "ok",
		detail: `${facts.mode.kind} ${facts.mode.enabled ? "on" : "off"} — ${facts.mode.hint}`,
	};
}

function toolsCheck(facts: DoctorFacts): DoctorCheck {
	const { expected, registered, gated, gatedNote, commands } = facts.tools;
	const missing = expected.filter((name) => !registered.includes(name));
	if (missing.length > 0) {
		return {
			id: "tools",
			title: "Tools",
			status: "fail",
			detail: `${expected.length - missing.length}/${expected.length} registered (${expected.join(", ")}); missing: ${missing.join(", ")}.`,
			fix: "The host did not accept the tool registration. Restart the host, reinstall Fusion (docs/install.md), and check the host version — unsupported releases may drop plugin tools.",
		};
	}
	const gatedList = gated && gated.length > 0 ? `; gated ${gatedNote ? `(${gatedNote})` : ""}: ${gated.join(", ")}` : "";
	const missingCommands = commands && commands.missing.length > 0
		? `; the host command registry does not list: ${commands.missing.join(", ")}${commands.note ? ` (${commands.note})` : ""}`
		: "";
	if (missingCommands) {
		return {
			id: "tools",
			title: "Tools",
			status: "warn",
			detail: `${expected.join(", ")} registered by Fusion${gatedList}${missingCommands}.`,
			fix: "Restart the host so the command transform replays, and compare with the versions check: a host outside Fusion's supported range may not load the plugin's command surfaces (docs/install.md).",
		};
	}
	return { id: "tools", title: "Tools", status: "ok", detail: `${expected.join(", ")} registered${gatedList}.` };
}

function agentsCheck(agents: NonNullable<DoctorFacts["agents"]>): DoctorCheck {
	if (agents.kind === "not-applicable") {
		return { id: "agents", title: "Agents", status: "ok", detail: agents.note ?? "this host runs Fusion's workers without named host agents" };
	}
	const facts = agents.facts ?? [];
	if (!agents.contributionSupported && facts.length === 0) {
		return {
			id: "agents",
			title: "Agents",
			status: "warn",
			detail: "This host exposes no native agent-contribution surface, so Fusion registered no agents itself.",
			fix: "Install the legacy agent Markdown files (docs/install.md, legacy manual install) or use a supported host version with the native agent surface.",
		};
	}
	if (facts.length === 0) {
		return {
			id: "agents",
			title: "Agents",
			status: "warn",
			detail: "The host's agent surface is available, but Fusion's contribution registered no agents.",
			fix: "Restart the host and reinstall Fusion; a host outside the supported range may not apply plugin agent contributions (compare the versions check, docs/install.md).",
		};
	}
	const problems = facts.filter((agent) => agent.state !== "available");
	if (problems.length > 0) {
		const detail = problems.map((agent) => agent.state === "conflict"
			? `${agent.id} overridden${agent.differences?.length ? ` (${agent.differences.join(", ")})` : ""}`
			: `${agent.id} not visible to the host`).join("; ");
		return {
			id: "agents",
			title: "Agents",
			status: "warn",
			detail: `${detail}. Available: ${facts.filter((agent) => agent.state === "available").map((agent) => agent.id).join(", ") || "none"}.`,
			fix: facts.some((agent) => agent.state === "conflict")
				? "Update or remove the installed agent definitions that override Fusion's (a Markdown/config agent keeps precedence on OpenCode v2.2.5) so the plugin manages them."
				: "Restart the host or reinstall Fusion's agents (docs/install.md); the first registration replay may not see later contributions.",
		};
	}
	return {
		id: "agents",
		title: "Agents",
		status: "ok",
		detail: `${facts.map((agent) => agent.id).join(", ")} available${agents.contributionSupported ? " (plugin-contributed)" : ""}.`,
	};
}

function modelsCheck(models: NonNullable<DoctorFacts["models"]>): DoctorCheck {
	if (!models.catalogAvailable) {
		return {
			id: "models",
			title: "Models",
			status: "fail",
			detail: models.catalogProblem ?? "The host model catalog is unavailable.",
			fix: models.catalogFix ?? "Fix the host's model configuration first; Fusion cannot validate any model without the catalog.",
		};
	}
	if (models.facts.length === 0) {
		return {
			id: "models",
			title: "Models",
			status: "fail",
			detail: "No Fusion models are configured.",
			fix: "Configure models: /fusion-config <provider>/<model> (or /fusion-config select on Pi) before starting a run.",
		};
	}
	const failing = models.facts.filter((fact) => !fact.inCatalog);
	const authFailing = models.facts.filter((fact) => fact.auth && !fact.auth.configured);
	if (failing.length > 0) {
		const detail = failing.map((fact) => `${fact.role} ${fact.label}: ${fact.problem ?? "not in the host catalog"}`).join("; ");
		return {
			id: "models",
			title: "Models",
			status: "fail",
			detail,
			fix: "Re-select a catalog model: /fusion-config list [filter], then /fusion-config <role> <provider>/<model>.",
		};
	}
	if (authFailing.length > 0) {
		const detail = authFailing.map((fact) => `${fact.role} ${fact.label}: no credentials configured for ${fact.label.split("/")[0] ?? fact.label}`).join("; ");
		return {
			id: "models",
			title: "Models",
			status: "fail",
			detail,
			fix: "Add credentials for the provider through the host's login/auth flow (Pi: provider auth; OpenCode: its models connect flow), then rerun /fusion-doctor auth.",
		};
	}
	const notes = models.facts
		.filter((fact) => fact.policyNote)
		.map((fact) => `${fact.role} ${fact.label}: ${fact.policyNote}`);
	const authParts = models.facts
		.filter((fact) => fact.auth?.configured)
		.map((fact) => `${fact.role} ${fact.label}${fact.auth?.source ? ` (auth: ${fact.auth.source})` : ""}`);
	const detail = `${models.facts.map((fact) => fact.label).join(", ")} in the catalog${authParts.length ? `; ${authParts.join(", ")}` : ""}${notes.length ? `; ${notes.join("; ")}` : ""}${models.note ? `; ${models.note}` : ""}`;
	const status: DoctorStatus = notes.length > 0 ? "warn" : "ok";
	return { id: "models", title: "Models", status, detail, ...(status === "warn" ? { fix: "Selection policy drift is advisory: the run works today; re-select a model in the current cohort before relying on tier behavior." } : {}) };
}

function backendCheck(backend: NonNullable<DoctorFacts["backend"]>): DoctorCheck {
	if (!backend.available) {
		return {
			id: "backend",
			title: "Backend",
			status: "fail",
			detail: `${backend.configured} unavailable${backend.problem ? `: ${backend.problem}` : "."}`,
			fix: "Fix the backend problem above, or switch to an available backend (Pi: /fusion-config select, or run with the session backend).",
		};
	}
	const capabilities = backend.capabilities
		? `; capabilities ${Object.entries(backend.capabilities).filter(([, value]) => value).map(([key]) => key).join(", ") || "none"}`
		: "";
	return {
		id: "backend",
		title: "Backend",
		status: "ok",
		detail: `${backend.configured} available${capabilities}${backend.note ? `; ${backend.note}` : ""}`,
	};
}

function ownershipCheck(ownership: NonNullable<DoctorFacts["ownership"]>): DoctorCheck {
	if (!ownership.ready) {
		return {
			id: "ownership",
			title: "Ownership storage",
			status: "fail",
			detail: `${ownership.directory} unusable${ownership.problem ? `: ${ownership.problem}` : "."}`,
			fix: ownership.fix ?? "Fix the ownership directory above. It must be a private directory (mode 0700) owned by the current user; FUSION_OWNERSHIP_DIR must point at the same directory from every Pi and OpenCode process for this workspace.",
		};
	}
	return {
		id: "ownership",
		title: "Ownership storage",
		status: "ok",
		detail: `${ownership.directory} ready${ownership.initialized ? `, ${ownership.entries ?? 0} owned record${(ownership.entries ?? 0) === 1 ? "" : "s"}` : ", not initialized yet (created on first run)"}${ownership.overrideNote ? `; ${ownership.overrideNote}` : ""}`,
	};
}

function recoveryCheck(recovery: NonNullable<DoctorFacts["recovery"]>): DoctorCheck {
	if (recovery.conflicts.length === 0) {
		return { id: "recovery", title: "Recovery", status: "ok", detail: "no interrupted runs, pending requests, or foreign owners for this workspace" };
	}
	const shown = recovery.conflicts.slice(0, MAX_CONFLICTS);
	const more = recovery.conflicts.length - shown.length;
	// The shared guidance line self-labels ("Recovery: …"), so it reads as its
	// own sentence after the conflicts.
	const guidance = recovery.guidance?.owed !== false && recovery.guidance ? ` ${recovery.guidance.line}` : "";
	return {
		id: "recovery",
		title: "Recovery",
		status: "warn",
		detail: `${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}.${guidance}`,
		fix: recovery.guidance?.line ?? "Recover in the owning session, or explicitly resolve ownership after confirming the worker has stopped.",
	};
}

/** The explicit authentication probe's presentation. The default report
 * never includes credential posture; `/fusion-doctor auth` adds these lines.
 * The probe reads only local posture — whether credentials exist and where
 * they come from — and never performs the network/model request a live
 * validation would require; that is always the operator's own action. */
export function describeDoctorAuth(facts: DoctorFacts): string[] {
	const lines: string[] = [];
	for (const fact of facts.models.facts) {
		if (!fact.auth) continue;
		lines.push(`${fact.role} ${fact.label}: credentials ${fact.auth.configured ? "configured" : "NOT configured"}${fact.auth.source ? ` (source: ${fact.auth.source})` : ""}`);
	}
	if (lines.length === 0) lines.push("No Fusion model carries a locally readable credential posture on this host.");
	lines.push(facts.models.authProbeDetail);
	lines.push("This diagnostic never issues a model request; checking that a credential is still accepted can be billed, so it stays your own action (run a trivial task).");
	return lines;
}

/** Bounded rendering: one line per check plus its fix, the summary first.
 * The cap applies to the emitted lines so a pathological host cannot flood
 * the UI; hidden checks are counted, never dropped silently. */
export function describeDoctorReport(report: DoctorReport, maxLines = 24): string[] {
	const lines: string[] = [`Fusion doctor (${report.harness}, ${report.fusionVersion}): ${report.summary}`];
	let shown = 0;
	for (const check of report.checks) {
		const cost = 1 + (check.fix ? 1 : 0);
		if (shown > 0 && lines.length + cost > maxLines) break;
		const mark = check.status === "ok" ? "ok" : check.status === "warn" ? "warn" : check.status === "fail" ? "FAIL" : "unknown";
		lines.push(`${mark} — ${check.title}: ${check.detail}`);
		if (check.fix) lines.push(`  fix: ${check.fix}`);
		shown += 1;
	}
	const hidden = report.checks.length - shown;
	if (hidden > 0) lines.push(`…and ${hidden} more check${hidden === 1 ? "" : "s"}; resolve the failures above first.`);
	return lines;
}

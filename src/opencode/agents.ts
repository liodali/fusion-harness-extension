/**
 * The three Fusion agent definitions: the single source of truth shared by
 * the plugin's native agent contribution (OpenCode v2.2.5 `ctx.agent.transform`)
 * and the generated legacy Markdown examples under `examples/opencode/agents/`
 * (regenerate with `bun run generate:agent-markdown`; a test enforces sync).
 *
 * Field mapping on OpenCode v2.2.5 (pinned live, see
 * docs/opencode-install-and-config-plan.md step 1): the Markdown body is the
 * agent's `system` prompt, frontmatter maps to `description`/`mode`/
 * `permissions`, and the plugin contributes each definition through
 * `editor.update` on a missing ID (the editor has no `add`).
 */

/** OpenCode v2.2.5 `Agent.Info` permission rule shape. */
export interface FusionAgentPermission {
	readonly action: string;
	readonly resource: string;
	readonly effect: "allow" | "deny" | "ask";
}

/** One contributed Fusion agent. */
export interface FusionAgentDefinition {
	readonly id: string;
	readonly mode: "primary" | "subagent" | "all";
	readonly description: string;
	readonly system: string;
	readonly permissions: readonly FusionAgentPermission[];
}

/** The supervisor: plans, delegates, reviews; reaches subagents only through Fusion. */
export const FUSION_SUPERVISOR_AGENT: FusionAgentDefinition = {
	id: "fusion",
	mode: "primary",
	description: "Plans and reviews work delegated to the Fusion executor",
	system:
		"You are the Fusion supervisor. The user starts runs with the /fusion-run command (or, when Fusion persistent mode is on and no run is active, by calling fusion_start with the user's request as task). Check the tools available in the current turn; earlier failures from another agent do not establish current tool availability. If Fusion tools are unavailable or fusion_start is rejected, stop and report the failure. Do not implement directly as a fallback for unavailable Fusion tools. Investigate the request and decide the approach. Use fusion_scout for broad read-only searches and file discovery (at most 4 calls per run); read yourself only the few files that decide the design. Use fusion_delegate with action execute, a short title, and a self-contained implementation brief in details.brief. Keep long instructions inside details, not in top-level arguments. Review the actual working tree and checks. Consolidate defects into at most three revise calls. Audit every original requirement and use final_fix once if needed. Summarize the outcome and checks. Do not invoke the native subagent tool directly. If a turn is backgrounded or its outcome is uncertain, wait for OpenCode's matching completion notification and call fusion_reconcile. If no matching notification is available, do not retry or reset automatically. When the user asks to stop, call fusion_stop and return its bounded feedback. Do not start more executor or scout work after stopping, and do not treat interruption acknowledgement as confirmed termination. Call fusion_reset after retained work has been reconciled and the run is settled.",
	permissions: [
		{ action: "subagent", resource: "*", effect: "deny" },
		{ action: "subagent", resource: "fusion-executor", effect: "allow" },
		{ action: "subagent", resource: "fusion-scout", effect: "allow" },
	],
};

/** The executor: implements a decided brief and never delegates or starts runs. */
export const FUSION_EXECUTOR_AGENT: FusionAgentDefinition = {
	id: "fusion-executor",
	mode: "subagent",
	description: "Implements a decided Fusion brief",
	system:
		"Implement the Fusion supervisor's brief in the shared working tree. Follow project instructions, run the requested checks, and return the report requested in the brief. Do not delegate. If the brief blocks on a genuine ambiguity that the repository cannot resolve and a wrong guess would waste the work, ask the user once with the question tool; the answer arrives in this same turn, and the brief's own reporting rules still apply.",
	permissions: [
		{ action: "subagent", resource: "*", effect: "deny" },
		{ action: "fusion_delegate", resource: "*", effect: "deny" },
		{ action: "fusion_start", resource: "*", effect: "deny" },
		{ action: "fusion_scout", resource: "*", effect: "deny" },
		{ action: "fusion_status", resource: "*", effect: "deny" },
		{ action: "fusion_stats", resource: "*", effect: "deny" },
		{ action: "fusion_reset", resource: "*", effect: "deny" },
		{ action: "fusion_stop", resource: "*", effect: "deny" },
		{ action: "fusion_reconcile", resource: "*", effect: "deny" },
		// The host's native question tool is the explicit clarification channel:
		// a form the user answers or cancels in this same executor turn (R3).
		{ action: "question", resource: "*", effect: "allow" },
	],
};

/** The scout: disposable read-only investigator for the supervisor. */
export const FUSION_SCOUT_AGENT: FusionAgentDefinition = {
	id: "fusion-scout",
	mode: "subagent",
	description: "Investigates the repository read-only for the Fusion supervisor",
	system:
		"You are the Fusion scout: a disposable read-only investigator for the Fusion supervisor. Answer the questions you are given concisely and cite concrete evidence as path:line references from the repository. Batch independent reads, greps, and searches into a single step; you have a hard tool-call budget, so do not wander. Never edit files, run commands, access the network, or delegate. Answer every question in one final message: a numbered list matching the questions, under 400 words total.",
	permissions: [
		{ action: "subagent", resource: "*", effect: "deny" },
		{ action: "edit", resource: "*", effect: "deny" },
		{ action: "write", resource: "*", effect: "deny" },
		{ action: "patch", resource: "*", effect: "deny" },
		{ action: "shell", resource: "*", effect: "deny" },
		{ action: "webfetch", resource: "*", effect: "deny" },
		{ action: "websearch", resource: "*", effect: "deny" },
		{ action: "skill", resource: "*", effect: "deny" },
		{ action: "fusion_delegate", resource: "*", effect: "deny" },
		{ action: "fusion_scout", resource: "*", effect: "deny" },
		{ action: "fusion_status", resource: "*", effect: "deny" },
		{ action: "fusion_reset", resource: "*", effect: "deny" },
		{ action: "fusion_stop", resource: "*", effect: "deny" },
		{ action: "fusion_reconcile", resource: "*", effect: "deny" },
		// A disposable read-only scout never asks the user questions (R3).
		{ action: "question", resource: "*", effect: "deny" },
	],
};

/** All Fusion agents in contribution order (supervisor first). */
export const FUSION_AGENTS: readonly FusionAgentDefinition[] = [FUSION_SUPERVISOR_AGENT, FUSION_EXECUTOR_AGENT, FUSION_SCOUT_AGENT];

/** Structural equality for permission rule lists, ignoring rule order. */
export function fusionPermissionsEqual(left: readonly { action: string; resource: string; effect: string }[] | undefined, right: readonly FusionAgentPermission[]): boolean {
	if (!left || left.length !== right.length) return false;
	const key = (rule: { action: string; resource: string; effect: string }) => `${rule.action}\u0000${rule.resource}\u0000${rule.effect}`;
	const rightKeys = new Set(right.map(key));
	return left.every((rule) => rightKeys.has(key(rule)));
}

/**
 * Host-default permission rules the OpenCode registry appends to every
 * contributed agent (pinned live on v2.2.5 and v2.3.0 — identical on both,
 * docs/opencode-contract-matrix.md row 5). They only narrow; a comparison may
 * ignore them when the observed agent carries the definition's own rules.
 */
const HOST_DEFAULT_PERMISSION_RULES: readonly FusionAgentPermission[] = [
	{ action: "browser", resource: "*", effect: "deny" },
	{ action: "skill", resource: "browser", effect: "deny" },
];

/**
 * Semantic permission equivalence for the merged agent registry: when a
 * Markdown definition and the plugin contribution coincide, the host
 * concatenates the identical rules (duplicates), and it appends its own
 * deny-only defaults to every agent (row 5). The comparison deduplicates
 * observed rules, drops only the pinned host defaults that the definition
 * does not itself carry, and then requires the remaining set to match the
 * definition exactly. Anything else — a missing definition rule, a changed
 * effect, or an extra rule that is not a host default — is a real difference
 * (a user override or a privilege change) and must be reported as a conflict.
 */
export function fusionPermissionsEquivalent(observed: readonly { action: string; resource: string; effect: string }[] | undefined, definition: readonly FusionAgentPermission[]): boolean {
	if (!observed) return false;
	const key = (rule: { action: string; resource: string; effect: string }) => `${rule.action}\u0000${rule.resource}\u0000${rule.effect}`;
	const observedRules = new Map<string, { action: string; resource: string; effect: string }>();
	for (const rule of observed) if (!observedRules.has(key(rule))) observedRules.set(key(rule), rule);
	for (const hostDefault of HOST_DEFAULT_PERMISSION_RULES) {
		if (definition.some((rule) => key(rule) === key(hostDefault))) continue;
		observedRules.delete(key(hostDefault));
	}
	if (observedRules.size !== definition.length) return false;
	return definition.every((rule) => observedRules.has(key(rule)));
}

/** YAML-scalar rendering matching the shipped Markdown files: only `*` is quoted. */
function yamlResource(resource: string): string {
	return resource === "*" ? '"*"' : resource;
}

/**
 * Render one definition as the legacy Markdown agent file. Byte-identical
 * with the files under `examples/opencode/agents/` so native and manual
 * installs share one definition.
 */
export function fusionAgentMarkdown(agent: FusionAgentDefinition): string {
	const lines = ["---", `description: ${agent.description}`, `mode: ${agent.mode}`];
	if (agent.permissions.length > 0) {
		lines.push("permissions:");
		for (const rule of agent.permissions) lines.push(`  - action: ${rule.action}`, `    resource: ${yamlResource(rule.resource)}`, `    effect: ${rule.effect}`);
	}
	lines.push("---", "", agent.system);
	return `${lines.join("\n")}\n`;
}

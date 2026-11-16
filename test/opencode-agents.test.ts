import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FUSION_AGENTS, FUSION_EXECUTOR_AGENT, FUSION_SCOUT_AGENT, FUSION_SUPERVISOR_AGENT, fusionAgentMarkdown, fusionPermissionsEqual, fusionPermissionsEquivalent } from "../src/opencode/agents.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("centralized Fusion agent definitions", () => {
	test("the shipped legacy Markdown examples are byte-identical with the definitions", async () => {
		for (const agent of FUSION_AGENTS) {
			const file = await readFile(join(repo, "examples/opencode/agents", `${agent.id}.md`), "utf8");
			expect(file).toBe(fusionAgentMarkdown(agent));
		}
	});

	test("three agents: one primary supervisor and two restricted subagents", () => {
		expect(FUSION_AGENTS.map((agent) => agent.id)).toEqual(["fusion", "fusion-executor", "fusion-scout"]);
		expect(FUSION_SUPERVISOR_AGENT.mode).toBe("primary");
		expect(FUSION_EXECUTOR_AGENT.mode).toBe("subagent");
		expect(FUSION_SCOUT_AGENT.mode).toBe("subagent");
	});

	test("the supervisor may reach only the two Fusion subagents", () => {
		const permissions = FUSION_SUPERVISOR_AGENT.permissions;
		expect(permissions).toContainEqual({ action: "subagent", resource: "*", effect: "deny" });
		expect(permissions).toContainEqual({ action: "subagent", resource: "fusion-executor", effect: "allow" });
		expect(permissions).toContainEqual({ action: "subagent", resource: "fusion-scout", effect: "allow" });
		expect(permissions.filter((rule) => rule.effect === "allow")).toHaveLength(2);
	});

	test("the executor cannot delegate, start runs, or recurse", () => {
		for (const denied of ["subagent", "fusion_delegate", "fusion_start", "fusion_scout", "fusion_reconcile", "fusion_reset"]) {
			expect(FUSION_EXECUTOR_AGENT.permissions).toContainEqual({ action: denied, resource: "*", effect: "deny" });
		}
		// The native question tool is the executor's explicit clarification
		// channel (R3); every Fusion-internal escalation path stays denied.
		expect(FUSION_EXECUTOR_AGENT.permissions).toContainEqual({ action: "question", resource: "*", effect: "allow" });
	});

	test("the scout is read-only: every mutating action is denied", () => {
		for (const rule of FUSION_SCOUT_AGENT.permissions) expect(rule.effect).toBe("deny");
		for (const denied of ["subagent", "edit", "write", "patch", "shell", "webfetch", "websearch", "skill", "fusion_delegate"]) {
			expect(FUSION_SCOUT_AGENT.permissions).toContainEqual({ action: denied, resource: "*", effect: "deny" });
		}
		// A disposable scout never asks the user questions (R3).
		expect(FUSION_SCOUT_AGENT.permissions).toContainEqual({ action: "question", resource: "*", effect: "deny" });
	});

	test("permission equality is order-insensitive and rejects differences", () => {
		const permissions = FUSION_SUPERVISOR_AGENT.permissions;
		expect(fusionPermissionsEqual(permissions, [...permissions].reverse())).toBe(true);
		expect(fusionPermissionsEqual(undefined, permissions)).toBe(false);
		expect(fusionPermissionsEqual(permissions.slice(0, 2), permissions)).toBe(false);
		expect(fusionPermissionsEqual([...permissions, { action: "read", resource: "*", effect: "allow" }], permissions)).toBe(false);
	});

	test("semantic equivalence accepts the merged registry's duplicated rules and host defaults (row 5)", () => {
		const permissions = FUSION_SUPERVISOR_AGENT.permissions;
		// The merged registry concatenates the identical Markdown and plugin
		// rule sets and appends the host's own deny-only defaults.
		const merged = [...permissions, ...permissions, { action: "browser", resource: "*", effect: "deny" }, { action: "skill", resource: "browser", effect: "deny" }];
		expect(fusionPermissionsEquivalent(merged, permissions)).toBe(true);
		expect(fusionPermissionsEquivalent([...permissions, { action: "browser", resource: "*", effect: "deny" }, { action: "skill", resource: "browser", effect: "deny" }], permissions)).toBe(true);
		expect(fusionPermissionsEquivalent([...permissions], permissions)).toBe(true);
	});

	test("semantic equivalence still reports real user overrides and privilege changes", () => {
		const permissions = FUSION_SUPERVISOR_AGENT.permissions;
		// A user relaxed the subagent deny: the definition rule is gone and a
		// new allow rule appeared.
		const relaxed = [...permissions.filter((rule) => !(rule.action === "subagent" && rule.resource === "*")), { action: "subagent", resource: "*", effect: "allow" }, { action: "browser", resource: "*", effect: "deny" }, { action: "skill", resource: "browser", effect: "deny" }];
		expect(fusionPermissionsEquivalent(relaxed, permissions)).toBe(false);
		// A user narrowed an action with a non-default extra deny.
		expect(fusionPermissionsEquivalent([...permissions, { action: "webfetch", resource: "*", effect: "deny" }, { action: "browser", resource: "*", effect: "deny" }, { action: "skill", resource: "browser", effect: "deny" }], permissions)).toBe(false);
		// A definition rule went missing entirely.
		expect(fusionPermissionsEquivalent([...permissions.slice(1), { action: "browser", resource: "*", effect: "deny" }, { action: "skill", resource: "browser", effect: "deny" }], permissions)).toBe(false);
		// An effect changed for the same action/resource.
		const changed = permissions.map((rule) => (rule.action === "subagent" && rule.resource === "fusion-executor" ? { ...rule, effect: "deny" as const } : rule));
		expect(fusionPermissionsEquivalent(changed, permissions)).toBe(false);
		// No permissions at all is never equivalent.
		expect(fusionPermissionsEquivalent(undefined, permissions)).toBe(false);
		expect(fusionPermissionsEquivalent([], permissions)).toBe(false);
		// A definition may itself carry a host-default rule; then it is not
		// dropped from the observed set.
		const withDefault = [...permissions, { action: "browser", resource: "*", effect: "deny" } as const];
		expect(fusionPermissionsEquivalent([...permissions, { action: "browser", resource: "*", effect: "deny" }], withDefault)).toBe(true);
		expect(fusionPermissionsEquivalent(permissions, withDefault)).toBe(false);
	});
});

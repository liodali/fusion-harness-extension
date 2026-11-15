import { describe, expect, test } from "bun:test";
import {
	buildDoctorReport,
	describeDoctorAuth,
	describeDoctorReport,
	type DoctorFacts,
} from "../src/core/doctor.ts";

/** A healthy session's facts as both hosts would gather them locally. */
const HEALTHY: DoctorFacts = {
	harness: "opencode",
	fusionVersion: "fusion-opencode@0.1.4",
	hostVersion: "v2.2.5",
	supportedHostRange: "v2.2.3 – v2.2.5",
	hostSupported: true,
	mode: { enabled: true, kind: "persistent mode", hint: "fusion tools stay available to the fusion agent between runs" },
	tools: { expected: ["fusion_start", "fusion_stop"], registered: ["fusion_start", "fusion_stop"] },
	agents: { kind: "host-agents", contributionSupported: true, facts: [{ id: "fusion", state: "available" }, { id: "fusion-executor", state: "available" }, { id: "fusion-scout", state: "available" }] },
	models: {
		catalogAvailable: true,
		facts: [{ role: "executor", label: "zai/glm-5.3-flash", inCatalog: true }],
		authProbe: "network",
		authProbeDetail: "This host exposes no local credential validation to the plugin; checking a credential requires a network/model request.",
	},
	backend: {
		configured: "OpenCode native subagent",
		capabilities: { transcriptReopen: true, activeTurnReattach: false, durableExecution: false, idempotentSubmission: false, readOnlyScout: true, exactScoutToolLimit: true, workerAbort: true, workerEvents: true },
		available: true,
	},
	ownership: { directory: "/home/u/.local/state/fusion/ownership", ready: true, initialized: true, entries: 1 },
	recovery: { conflicts: [] },
};

const healthyById = (facts: DoctorFacts) => new Map(buildDoctorReport(facts).checks.map((check) => [check.id, check]));

describe("doctor report over healthy facts", () => {
	test("every check reads ok with a bounded summary", () => {
		const report = buildDoctorReport(HEALTHY);
		expect(report.checks.map((check) => [check.id, check.status])).toEqual([
			["versions", "ok"], ["mode", "ok"], ["tools", "ok"], ["agents", "ok"], ["models", "ok"], ["backend", "ok"], ["ownership", "ok"], ["recovery", "ok"],
		]);
		expect(report.summary).toBe("8 ok");
	});

	test("the rendering is one line per check plus fixes, summary first", () => {
		const lines = describeDoctorReport(buildDoctorReport(HEALTHY));
		expect(lines[0]).toContain("Fusion doctor (opencode, fusion-opencode@0.1.4): 8 ok");
		expect(lines.filter((line) => line.startsWith("ok — "))).toHaveLength(8);
		expect(lines).toHaveLength(9);
	});

	test("the report is deterministic and computed synchronously", () => {
		const first = buildDoctorReport(HEALTHY);
		const second = buildDoctorReport(HEALTHY);
		expect(second).toEqual(first);
		// Pure core: building a report performs no async work and no model call.
		const sync = buildDoctorReport(HEALTHY);
		expect(sync.checks).toHaveLength(8);
	});

	test("the renderer never prints fields it was not written to read", () => {
		// An adapter bug that attaches a credential value to the facts must not
		// leak through: the renderer reads only reviewed, bounded fields.
		const facts = { ...HEALTHY, apiKey: "sk-secret-do-not-print", authHeader: "Bearer x" } as unknown as DoctorFacts;
		for (const line of describeDoctorReport(buildDoctorReport(facts))) {
			expect(line).not.toContain("sk-secret-do-not-print");
			expect(line).not.toContain("Bearer x");
		}
	});
});

describe("tools and agents", () => {
	test("a tool the host did not accept fails with the reinstall fix", () => {
		const check = healthyById({ ...HEALTHY, tools: { expected: ["fusion_start", "fusion_stop"], registered: ["fusion_start"] } }).get("tools")!;
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("missing: fusion_stop");
		expect(check.fix).toContain("reinstall Fusion");
	});

	test("gated tools read ok and say when they become visible", () => {
		const check = healthyById({ ...HEALTHY, tools: { expected: ["fusion_start", "fusion_delegate", "fusion_stop"], registered: ["fusion_start", "fusion_delegate", "fusion_stop"], gated: ["fusion_delegate"], gatedNote: "visible when a run is active or Fusion mode is on" } }).get("tools")!;
		expect(check.status).toBe("ok");
		expect(check.detail).toContain("gated (visible when a run is active or Fusion mode is on): fusion_delegate");
	});

	test("a command the host registry does not list warns with the restart and version fix", () => {
		const check = healthyById({ ...HEALTHY, tools: { expected: ["fusion_start", "fusion_stop"], registered: ["fusion_start", "fusion_stop"], commands: { missing: ["fusion-doctor"], note: "the host's registry view may predate plugin contributions" } } }).get("tools")!;
		expect(check.status).toBe("warn");
		expect(check.detail).toContain("does not list: fusion-doctor");
		expect(check.fix).toContain("Restart the host");
	});

	test("agent conflicts and missing contributions carry their own fixes", () => {
		const conflict = healthyById({ ...HEALTHY, agents: { kind: "host-agents", contributionSupported: true, facts: [{ id: "fusion", state: "conflict", differences: ["system"] }, { id: "fusion-executor", state: "available" }, { id: "fusion-scout", state: "available" }] } }).get("agents")!;
		expect(conflict.status).toBe("warn");
		expect(conflict.detail).toContain("fusion overridden (system)");
		expect(conflict.fix).toContain("override Fusion's");

		const unavailable = healthyById({ ...HEALTHY, agents: { kind: "host-agents", contributionSupported: true, facts: [{ id: "fusion", state: "available" }, { id: "fusion-scout", state: "unavailable" }] } }).get("agents")!;
		expect(unavailable.status).toBe("warn");
		expect(unavailable.fix).toContain("Restart the host or reinstall");

		const unsupported = healthyById({ ...HEALTHY, agents: { kind: "host-agents", contributionSupported: false, facts: [] } }).get("agents")!;
		expect(unsupported.status).toBe("warn");
		expect(unsupported.fix).toContain("legacy agent Markdown");

		const contributedNothing = healthyById({ ...HEALTHY, agents: { kind: "host-agents", contributionSupported: true, facts: [] } }).get("agents")!;
		expect(contributedNothing.status).toBe("warn");
		expect(contributedNothing.detail).toContain("registered no agents");
	});

	test("hosts without named Fusion agents read ok with the explanation", () => {
		const check = healthyById({ ...HEALTHY, agents: { kind: "not-applicable", note: "this host runs the executor and scout as Fusion child sessions" } }).get("agents")!;
		expect(check.status).toBe("ok");
		expect(check.detail).toContain("child sessions");
	});
});

describe("versions", () => {
	test("a host outside the supported range warns with the re-pin fix", () => {
		const check = healthyById({ ...HEALTHY, hostVersion: "v2.3.0", hostSupported: false }).get("versions")!;
		expect(check.status).toBe("warn");
		expect(check.detail).toContain("host v2.3.0");
		expect(check.fix).toContain("re-pinned and its surfaces reverified");
		expect(check.fix).toContain("docs/install.md");
	});

	test("an unobservable host version stays honest without failing", () => {
		const check = healthyById({ ...HEALTHY, hostVersion: undefined, hostSupported: undefined }).get("versions")!;
		expect(check.status).toBe("ok");
		expect(check.detail).toContain("host not observable");
	});
});

describe("models", () => {
	test("a configured model missing from the live catalog fails with the re-select fix", () => {
		const check = healthyById({
			...HEALTHY,
			models: { ...HEALTHY.models, facts: [{ role: "executor", label: "zai/glm-5.3-flash", inCatalog: false, problem: '"zai/glm-5.3-flash" is not in the OpenCode model catalog (known providers: anthropic).' }] },
		}).get("models")!;
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("executor zai/glm-5.3-flash");
		expect(check.detail).toContain("not in the OpenCode model catalog");
		expect(check.fix).toContain("/fusion-config list");
	});

	test("no configured models fails with the configuration fix", () => {
		const check = healthyById({ ...HEALTHY, models: { ...HEALTHY.models, facts: [] } }).get("models")!;
		expect(check.status).toBe("fail");
		expect(check.fix).toContain("Configure models");
	});

	test("an unusable host catalog fails with the host's own problem and fix", () => {
		const check = healthyById({
			...HEALTHY,
			models: { ...HEALTHY.models, catalogAvailable: false, catalogProblem: "The OpenCode model catalog is unavailable in this host; configure models through OpenCode itself instead." },
		}).get("models")!;
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("model catalog is unavailable");
		expect(check.fix).toContain("Fix the host's model configuration");
	});

	test("the explicit auth probe surfaces missing local credentials as a failure", () => {
		// Default diagnostics never carry the credential posture: the probe is
		// the separate, explicit action that adds it.
		const withoutAuth = healthyById(HEALTHY).get("models")!;
		expect(withoutAuth.detail).not.toContain("auth:");
		const probeOk = healthyById({
			...HEALTHY,
			models: { ...HEALTHY.models, facts: [{ role: "executor", label: "zai/glm-5.3-flash", inCatalog: true, auth: { configured: true, source: "stored" } }] },
		}).get("models")!;
		expect(probeOk.status).toBe("ok");
		expect(probeOk.detail).toContain("zai/glm-5.3-flash (auth: stored)");
		const failing = healthyById({
			...HEALTHY,
			models: { ...HEALTHY.models, facts: [{ role: "executor", label: "zai/glm-5.3-flash", inCatalog: true, auth: { configured: false } }] },
		}).get("models")!;
		expect(failing.status).toBe("fail");
		expect(failing.detail).toContain("no credentials configured for zai");
		expect(failing.fix).toContain("auth");
	});

	test("selection-policy drift is advisory and never a failure", () => {
		const check = healthyById({
			...HEALTHY,
			models: { ...HEALTHY.models, facts: [{ role: "executor", label: "zai/glm-5.3-flash", inCatalog: true, policyNote: "outside the 2026-10 cohort" }] },
		}).get("models")!;
		expect(check.status).toBe("warn");
		expect(check.detail).toContain("outside the 2026-10 cohort");
		expect(check.fix).toContain("advisory");
	});

	test("the auth probe wording never claims a billed request was made", () => {
		const probed: DoctorFacts = {
			...HEALTHY,
			models: { ...HEALTHY.models, facts: [{ role: "executor", label: "zai/glm-5.3-flash", inCatalog: true, auth: { configured: true, source: "stored" } }] },
		};
		const lines = describeDoctorAuth(probed);
		expect(lines.some((line) => line.includes("executor zai/glm-5.3-flash: credentials configured (source: stored)"))).toBe(true);
		expect(lines.some((line) => line.includes("no local credential validation to the plugin"))).toBe(true);
		expect(lines.at(-1)).toContain("never issues a model request");
		for (const line of lines) expect(line).not.toContain("probe validated the credential");
	});

	test("a host with no locally readable posture says so instead of guessing", () => {
		const lines = describeDoctorAuth(HEALTHY);
		expect(lines[0]).toContain("No Fusion model carries a locally readable credential posture");
	});
});

describe("backend, ownership, and recovery", () => {
	test("an unavailable backend fails with its problem and the switch fix", () => {
		const check = healthyById({ ...HEALTHY, backend: { ...HEALTHY.backend, configured: "Pi durable backend", available: false, problem: "the pi-durable package is not installed" } }).get("backend")!;
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("Pi durable backend unavailable: the pi-durable package is not installed");
		expect(check.fix).toContain("switch to an available backend");
	});

	test("an available backend lists its verified capabilities", () => {
		const check = healthyById(HEALTHY).get("backend")!;
		expect(check.detail).toContain("workerAbort, workerEvents");
		expect(check.detail).toContain("readOnlyScout");
	});

	test("an ownership storage problem fails with the private-directory fix", () => {
		const check = healthyById({
			...HEALTHY,
			ownership: { directory: "/shared/ownership", ready: false, initialized: false, problem: "the ownership directory must be private (mode 0700); it is mode 755" },
		}).get("ownership")!;
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("mode 755");
		expect(check.fix).toContain("mode 0700");
		expect(check.fix).toContain("FUSION_OWNERSHIP_DIR");
	});

	test("an uninitialized but usable registry reads ok and says when it materializes", () => {
		const check = healthyById({ ...HEALTHY, ownership: { directory: "/home/u/.local/state/fusion/ownership", ready: true, initialized: false } }).get("ownership")!;
		expect(check.status).toBe("ok");
		expect(check.detail).toContain("not initialized yet (created on first run)");
	});

	test("recovery conflicts carry the guided action and stay bounded", () => {
		const conflicts = Array.from({ length: 10 }, (_, index) => `run r-${index} is interrupted`);
		const check = healthyById({
			...HEALTHY,
			recovery: { conflicts, guidance: { line: "Recovery: wait for the existing submission — the retained durable request can be reattached without starting new work", action: "reattach", owed: true } },
		}).get("recovery")!;
		expect(check.status).toBe("warn");
		expect(check.detail).toContain("r-5 is interrupted");
		expect(check.detail).not.toContain("r-6 is interrupted");
		expect(check.detail).toContain("and 4 more");
		expect(check.detail).toContain("Recovery: wait for the existing submission");
		expect(check.fix).toContain("reattach");
	});

	test("no conflicts and an unowed action read ok", () => {
		const check = healthyById({
			...HEALTHY,
			recovery: { conflicts: [], guidance: { line: "start another run: no Fusion run owes recovery", action: "start-new", owed: false } },
		}).get("recovery")!;
		expect(check.status).toBe("ok");
	});
});

describe("bounded output", () => {
	test("the line cap hides whole checks and counts them", () => {
		const facts: DoctorFacts = {
			...HEALTHY,
			tools: { expected: ["a", "b"], registered: ["a", "b"] },
			recovery: { conflicts: Array.from({ length: 20 }, (_, index) => `run r-${index} is interrupted (pending execute)`) },
		};
		const lines = describeDoctorReport(buildDoctorReport(facts), 6);
		expect(lines.length).toBeLessThanOrEqual(7);
		expect(lines.at(-1)).toMatch(/…and \d+ more checks?;/);
	});
});

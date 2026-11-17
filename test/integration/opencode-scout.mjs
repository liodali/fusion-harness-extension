// Opt-in live model test: a restricted Fusion scout against a real serve-mode
// OpenCode. Entry is through the supported controls only: the fixture verifies
// prerequisites model-free BEFORE any paid prompt (active agent, persistent
// mode state, and expected tool visibility through the real command API and
// the host's own context hook), then enables `/fusion-mode on` — these
// scenarios exercise persistent mode, so they do not go through /fusion-run.
//
// Scenarios: A a read-only scout answers with citations and leaves the tree
// untouched; B the shared per-run invocation budget refuses the fifth call;
// C an interrupted supervisor leaves the scout cancelled without poisoning
// the run; D a catalog-configured executor model reaches the scout child.
// Set FUSION_OPENCODE_MODEL; filter with FUSION_SCOUT_ONLY=A,B,C,D.
//
// Negative checks are preserved: with mode off and no active run the gated
// Fusion tools must be hidden from the fusion agent (asserted through the
// real context hook before the mode toggle), and the probe agent's capture
// proves what the model would have been able to call.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeArtifact } from "./artifact.mjs";
import { Database } from "bun:sqlite";

const model = process.env.FUSION_OPENCODE_MODEL;
if (!model) throw new Error("Set FUSION_OPENCODE_MODEL to an authenticated OpenCode model (provider/model).");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const provider = model.split("/")[0];
const modelID = model.split("/")[1];
const results = [];
const prerequisiteChecks = [];
const ONLY = process.env.FUSION_SCOUT_ONLY?.split(",").map((s) => s.trim()).filter(Boolean);
const run = (name) => !ONLY || ONLY.includes(name);
const secrets = [];

const OBSERVER = `
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
export default { id: "fusion-scout-observer", async setup(ctx) {
	const busPath = join(ctx.location.directory, "bus-capture.jsonl");
	const turnsPath = join(ctx.location.directory, "turns.json");
	const capturePath = join(ctx.location.directory, "capture.json");
	const ac = new AbortController();
	const turns = [];
	// Sessions created by the visibility probe stop before any model request:
	// the hook captures the agent's real tool record and throws, so the probe
	// is model-free while real (paid) sessions pass through untouched.
	const probeSessions = new Set<string>();
	await ctx.tool.hook("execute.after", async (event) => {
		if (!["fusion_scout", "fusion_delegate", "fusion_reset", "fusion_status", "fusion_configure"].includes(event.tool)) return;
		const raw = event.result?.output ?? event.result?.content;
		const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((part) => (part && typeof part === "object" && typeof part.text === "string" ? part.text : "")).join("") : JSON.stringify(raw ?? "");
		turns.push({ tool: event.tool, status: event.status, error: String(event.error ?? ""), childSessionID: event.result?.metadata?.childSessionID, capped: event.result?.metadata?.capped, toolStatus: event.result?.metadata?.status, meta: event.result?.metadata, text });
		try { await writeFile(turnsPath, JSON.stringify(turns)); } catch {}
	});
	await ctx.session.hook("context", async (event) => {
		if (probeSessions.has(event.sessionID ?? "")) {
			await writeFile(capturePath, JSON.stringify({ sessionID: event.sessionID, agent: event.agent, tools: Object.keys(event.tools) }));
			throw new Error("SCOUT_VISIBILITY_PROBE_STOP_BEFORE_MODEL");
		}
	});
	await ctx.command.transform(ed => ed.add({ name: "scout-visibility-probe", description: "Capture the fusion agent's tool visibility without a model call", execute: async () => {
		const session = await ctx.session.create({});
		if (session?.id) probeSessions.add(session.id);
		await ctx.session.switchAgent({ sessionID: session.id, agent: "fusion" });
		try { await ctx.session.prompt({ sessionID: session.id, text: "Diagnostic only. Do not edit files." }); } catch {}
		return "probe issued";
	} }));
	const iter = ctx.event.subscribe({ signal: ac.signal })[Symbol.asyncIterator]();
	void (async () => {
		for (;;) {
			const next = await iter.next();
			if (next.done) break;
			try { await appendFile(busPath, JSON.stringify(next.value) + "\\n"); } catch {}
		}
	})().catch(() => {});
	return () => ac.abort();
} };
`;

async function credentials(env) {
	await mkdir(join(env.XDG_DATA_HOME, "opencode"), { recursive: true });
	let auth = {};
	try { auth = JSON.parse(await readFile(join(homedir(), ".local/share/opencode/auth.json"), "utf8")); } catch {}
	if (auth[provider]) {
		await writeFile(join(env.XDG_DATA_HOME, "opencode/auth.json"), JSON.stringify({ [provider]: auth[provider] }), { mode: 0o600 });
		for (const value of Object.values(auth[provider])) if (typeof value === "string" && value.length > 12) secrets.push(value);
	}
	let account;
	try { account = JSON.parse(await readFile(join(homedir(), ".local/share/opencode/account.json"), "utf8")); } catch {}
	const accountID = account?.active?.[provider];
	const selectedAccount = accountID && account?.accounts?.[accountID];
	if (selectedAccount) {
		await writeFile(join(env.XDG_DATA_HOME, "opencode/account.json"), JSON.stringify({ version: account.version, accounts: { [accountID]: selectedAccount }, active: { [provider]: accountID } }), { mode: 0o600 });
		for (const value of Object.values(selectedAccount?.credential ?? {})) if (typeof value === "string" && value.length > 12) secrets.push(value);
	}
	let databaseCredential;
	let db;
	try {
		db = new Database(join(homedir(), ".local/share/opencode/opencode.db"), { readonly: true });
		const rows = db.query("SELECT value FROM credential WHERE integration_id = ? AND active = 1").all(provider);
		if (rows.length > 1) throw new Error(`Multiple active credentials for ${provider}`);
		if (rows.length === 1) databaseCredential = JSON.parse(rows[0].value);
	} catch (error) {
		if (!String(error).includes("unable to open database file") && !String(error).includes("no such table")) throw error;
	} finally { db?.close(); }
	if (databaseCredential) for (const value of Object.values(databaseCredential)) if (typeof value === "string" && value.length > 12) secrets.push(value);
	const goKey = process.env.OPENCODE_API_KEY ?? databaseCredential?.key ?? selectedAccount?.credential?.key ?? auth[provider]?.key;
	assert.ok(selectedAccount || auth[provider] || databaseCredential || (provider === "opencode-go" && goKey), `No OpenCode credential for provider ${provider}`);
	if (provider === "opencode-go" && goKey) { env.OPENCODE_API_KEY = goKey; if (typeof goKey === "string" && goKey.length > 12) secrets.push(goKey); }
}

/** The model-free pre-prompt gate: verify the active agent, persistent-mode
 * state, and expected tool visibility through supported host surfaces before
 * any scenario prompt is paid for. Asserts the negative check (mode off hides
 * the gated tools), toggles `/fusion-mode on` through the real command API,
 * verifies the delivered report, and re-probes for the gated visibility the
 * scenarios depend on. Returns the probe captures for the artifact. */
async function verifyPrerequisites({ api, waitFor, project }) {
	const GATED = ["fusion_start", "fusion_delegate", "fusion_scout", "fusion_reconcile", "fusion_reset", "fusion_configure"];
	let pollLog = Date.now();
	const readCapture = async () => { try { return JSON.parse(await readFile(join(project, "capture.json"), "utf8")); } catch { return undefined; } };
	const runProbe = async (sessionID, label) => {
		await rm(join(project, "capture.json"), { force: true });
		const reply = await api(`/api/session/${sessionID}/command`, { method: "POST", body: JSON.stringify({ name: "scout-visibility-probe", text: "" }) });
		assert.ok(reply.status >= 200 && reply.status < 300, `visibility probe command returned ${reply.status}`);
		const capture = await waitFor(async () => {
			const value = await readCapture();
			return value && typeof value.sessionID === "string" ? value : undefined;
		}, 30000, `the ${label} visibility capture`);
		return capture;
	};
	// 1. Negative check: mode off (the default) with no run — the gated tools
	// must be hidden from the fusion agent through the real context hook.
	// Lazy activation: the probe command exists only after the plugin's
	// command transform completes, so wait for the registry first. Transient
	// connection errors stay inside the bounded wait instead of failing the
	// first poll.
	await waitFor(async () => {
		try {
			const commands = await (await api("/api/command")).json();
			const names = (Array.isArray(commands) ? commands : commands.data ?? []).map((command) => command?.name);
			return names.includes("fusion-mode") && names.includes("scout-visibility-probe");
		} catch (error) {
			if (Date.now() - pollLog < 8000) console.error(`[scout-fixture] /api/command poll failed: ${String(error?.cause?.code ?? error?.code ?? error?.message ?? error).slice(0, 120)}`);
			return undefined;
		}
	}, 60000, "plugin activation (the Fusion and probe commands)");
	const controlSession = await (await api("/api/session", { method: "POST", body: JSON.stringify({ agent: "fusion", model: { providerID: provider, id: modelID } }) })).json();
	const controlID = controlSession.id ?? controlSession.data?.id;
	assert.ok(controlID, "the control session was not created");
	const agentInfo = await (await api(`/api/session/${controlID}`)).json();
	const observedAgent = agentInfo.agent ?? agentInfo.data?.agent;
	prerequisiteChecks.push({ check: "active agent is fusion", sessionID: controlID, observedAgent, pass: observedAgent === "fusion" });
	assert.equal(observedAgent, "fusion", `the control session runs agent ${observedAgent}, not fusion`);
	const offCapture = await runProbe(controlID, "mode-off");
	const offTools = offCapture.tools.filter((name) => name.startsWith("fusion"));
	const offGated = GATED.filter((name) => offTools.includes(name));
	prerequisiteChecks.push({ check: "mode off with no run hides the gated Fusion tools", capture: offTools, pass: offGated.length === 0 });
	assert.deepEqual(offGated, [], `mode off must hide the gated Fusion tools, saw ${offGated.join(", ")}`);
	// 2. Enable persistent mode through the supported command surface and
	// verify the delivered report before paying for any prompt.
	const modeReply = await api(`/api/session/${controlID}/command`, { method: "POST", body: JSON.stringify({ name: "fusion-mode", text: "on" }) });
	assert.ok(modeReply.status >= 200 && modeReply.status < 300, `the fusion-mode command returned ${modeReply.status}`);
	const modeReport = await waitFor(async () => {
		const inbox = await (await api(`/api/session/${controlID}/inbox`)).json();
		const entries = inbox.data ?? inbox ?? [];
		return entries.find((entry) => entry?.type === "synthetic" && typeof entry?.payload?.text === "string" && entry.payload.text.includes("Fusion persistent mode enabled"))?.payload?.text;
	}, 30000, "the delivered fusion-mode report");
	prerequisiteChecks.push({ check: "the fusion-mode command reports persistent mode enabled", report: (modeReport ?? "").slice(0, 160), pass: !!modeReport });
	assert.ok(modeReport, "the fusion-mode report was not delivered");
	// 3. Positive check: with mode on, the gated tools the scenarios need are
	// visible to the fusion agent.
	const onCapture = await runProbe(controlID, "mode-on");
	const onTools = onCapture.tools.filter((name) => name.startsWith("fusion"));
	prerequisiteChecks.push({ check: "mode on exposes the gated Fusion tools to the fusion agent", capture: onTools, pass: GATED.every((name) => onTools.includes(name)) });
	assert.deepEqual(GATED.filter((name) => !onTools.includes(name)), [], `mode on must expose the gated Fusion tools, missing ${GATED.filter((name) => !onTools.includes(name)).join(", ")}`);
	return { controlSession: controlID, offTools, onTools };
}

async function withServer(name, runScenario) {
	const root = await mkdtemp(join(tmpdir(), `fusion-opencode-scout-${name}-`));
	let child;
	try {		const project = join(root, "project");
		await mkdir(join(project, ".opencode/plugins"), { recursive: true });
		await mkdir(join(project, ".opencode/agents"), { recursive: true });
		await mkdir(join(project, "src"), { recursive: true });
		await cp(join(repo, "src"), join(project, ".opencode/fusion"), { recursive: true });
		await cp(join(repo, "examples/opencode/agents"), join(project, ".opencode/agents"), { recursive: true });
		await writeFile(join(project, ".opencode/plugins/fusion.ts"), 'export { default } from "../fusion/opencode/index.ts";\n');
		await writeFile(join(project, ".opencode/plugins/observer.ts"), OBSERVER);
		// Read/search/list stay available to every agent; everything with effects is denied.
		await writeFile(join(project, "opencode.json"), JSON.stringify({ permissions: [
			...["edit", "write", "patch", "shell", "external_directory", "webfetch", "websearch", "skill"].map((action) => ({ action, resource: "*", effect: "deny" })),
			{ action: "read", resource: "*", effect: "allow" },
			{ action: "grep", resource: "*", effect: "allow" },
			{ action: "glob", resource: "*", effect: "allow" },
		] }));
		const notes = "# Notes\n\nThe rendezvous fruit is cantaloupe.\nNothing else matters here.\n";
		const app = "export function scoutTarget(): string {\n\treturn \"falcon\";\n}\n";
		await writeFile(join(project, "notes.md"), notes);
		await writeFile(join(project, "src/app.ts"), app);
		const env = Object.fromEntries(["PATH", "HOME", "SHELL", "TMPDIR", "LANG", "SYSTEMROOT"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
		for (const [key, folder] of Object.entries({ XDG_DATA_HOME: "data", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state" })) env[key] = join(root, folder);
		env.FUSION_OWNERSHIP_DIR = join(root, "ownership");
		await credentials(env);
		child = spawn(process.env.FUSION_OPENCODE_BIN || "opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
		let startup = "";
		for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { startup += data; });
		const deadline = Date.now() + 40000;
		for (;;) {
			const url = startup.match(/server listening on (http:\/\/[^\s]+)/)?.[1];
			const password = startup.match(/server password ([^\s]+)/)?.[1];
			if (url && password) {
				if (typeof password === "string" && password.length > 12) secrets.push(password);
				const authHeader = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
				const probe = await fetch(`${url}/api/location`, { headers: { authorization: authHeader }, signal: AbortSignal.timeout(10000) });
				assert.equal(probe.status, 200);
				const api = async (path, init) => {
					let response;
					try {
						response = await fetch(`${url}${path}`, { ...init, headers: { authorization: authHeader, "content-type": "application/json", ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(20000) });
					} catch (error) {
						throw new Error(`OpenCode API ${path} failed while the server ${child.exitCode !== null ? `exited (${child.exitCode})` : "was running"}; log tail: ${startup.slice(-800)}`);
					}
					const text = await response.text();
					return { status: response.status, body: text, json: () => JSON.parse(text) };
				};
				const readJson = async (file, fallback) => { try { return JSON.parse(await readFile(join(project, file), "utf8")); } catch { return fallback; } };
				const readBus = async () => (await readFile(join(project, "bus-capture.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
				const waitFor = async (predicate, ms, label) => {
					const start = Date.now();
					for (;;) {
						const value = await predicate();
						if (value) return value;
						if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${label}`);
						await new Promise((r) => setTimeout(r, 800));
					}
				};
				const newParent = async () => {
					const created = await api("/api/session", { method: "POST", body: JSON.stringify({ agent: "fusion", model: { providerID: provider, id: modelID } }) });
					assert.equal(created.status, 200, `session create failed: ${created.body.slice(0, 300)}`);
					return created.json().id ?? created.json().data?.id;
				};
				const promptParent = async (parent, text) => {
					const prompt = await api(`/api/session/${parent}/prompt`, { method: "POST", body: JSON.stringify({ text }) });
					assert.equal(prompt.status, 200, `prompt failed: ${prompt.body.slice(0, 300)}`);
				};
				// Model-free prerequisites before any paid prompt.
				const prereq = await verifyPrerequisites({ api, waitFor, project });
				const outcome = await runScenario({ project, api, readJson, readBus, waitFor, newParent, promptParent, notes, app, prereq });
				const version = (await readBus()).find((e) => e.type === "session.created")?.data?.version ?? startup.match(/version ([\d.]+)/)?.[1] ?? "unknown";
				results.push({ scenario: name, model, provider, version, ...outcome });
				return;
			}
			if (child.exitCode !== null) throw new Error(`Server exited: ${startup.slice(-400)}`);
			if (Date.now() > deadline) throw new Error(`Server never listened: ${startup.slice(-400)}`);
			await new Promise((r) => setTimeout(r, 50));
		}
	} finally {
		if (child?.exitCode === null) child.kill("SIGKILL");
		await Promise.race([new Promise((r) => child?.once("exit", r)), new Promise((r) => setTimeout(r, 3000))]);
		await rm(root, { recursive: true, force: true });
	}
}

async function scenarioA({ project, readJson, readBus, waitFor, newParent, promptParent, notes, app }) {
	const parent = await newParent();
	await new Promise((r) => setTimeout(r, 3000));
	await promptParent(parent, "Use fusion_scout once with these two questions: \"Which fruit name appears in notes.md, and on which line?\" and \"Which function is defined in src/app.ts, on which line, and what exact string does it return?\" After the scout answers, call fusion_reset.");
	await waitFor(async () => {
		const turns = await readJson("turns.json", []);
		return turns.some((t) => t.tool === "fusion_reset");
	}, 600000, "the scout answer and reset");
	const turns = await readJson("turns.json", []);
	const scout = turns.find((t) => t.tool === "fusion_scout");
	assert.ok(scout, "No fusion_scout turn recorded");
	assert.equal(scout.status, "completed", "The scout turn did not complete");
	assert.equal(scout.capped, false, "The scout reported capping on a normal answer");
	assert.ok(scout.childSessionID, "The scout did not report its child session");
	assert.ok(scout.text.includes("cantaloupe"), `The scout missed the notes answer: ${scout.text.slice(0, 300)}`);
	assert.ok(scout.text.includes("falcon"), `The scout missed the function answer: ${scout.text.slice(0, 300)}`);
	assert.ok(scout.text.includes("Scout usage: in "), `The scout result lacks the usage line: ${scout.text.slice(0, 300)}`);
	const bus = await readBus();
	const scoutChildren = bus.filter((e) => e.type === "session.created" && e.data?.agent === "fusion-scout");
	assert.equal(scoutChildren.length, 1, "Expected exactly one disposable scout child");
	const scoutChild = scoutChildren[0].data.sessionID;
	assert.equal(scoutChild, scout.childSessionID, "The reported scout child does not match the bus");
	const usageReadings = bus.filter((e) => e.type === "session.usage.updated" && e.data?.sessionID === scoutChild);
	assert.ok(usageReadings.length >= 1, "No usage accounting arrived for the scout child");
	// Read-only proof: the working tree is byte-identical after scouting.
	assert.equal(await readFile(join(project, "notes.md"), "utf8"), notes, "The scout modified notes.md");
	assert.equal(await readFile(join(project, "src/app.ts"), "utf8"), app, "The scout modified src/app.ts");
	const reset = turns.find((t) => t.tool === "fusion_reset");
	assert.ok(reset && reset.status === "completed", "The post-scout reset failed");
	return { scoutChild, scoutText: scout.text.slice(0, 200), usageReadings: usageReadings.length, turns: turns.map((t) => t.tool) };
}

async function scenarioB({ readJson, readBus, waitFor, newParent, promptParent }) {
	const parent = await newParent();
	await new Promise((r) => setTimeout(r, 3000));
	await promptParent(parent, "Call fusion_scout four times with the single question \"What is in notes.md?\". Important: call the tool strictly one at a time — wait for each answer before calling it again. Do not read any files yourself, and do not call fusion_reset yet.");
	await waitFor(async () => {
		const turns = await readJson("turns.json", []);
		return turns.filter((t) => t.tool === "fusion_scout" && t.toolStatus === "completed").length >= 4;
	}, 300000, "four completed scout calls");
	// The shared budget is exhausted; the next call must be refused by the tool
	// itself before any native scout child is created.
	await promptParent(parent, "Now call fusion_scout one more time, with the single question \"What is in notes.md?\". Call the tool exactly once and report its answer verbatim.");
	await waitFor(async () => {
		const turns = await readJson("turns.json", []);
		return turns.some((t) => t.tool === "fusion_scout" && t.text.includes("Scout limit reached"));
	}, 180000, "the refused fifth scout call");
	await promptParent(parent, "Call fusion_reset now.");
	await waitFor(async () => {
		const turns = await readJson("turns.json", []);
		return turns.some((t) => t.tool === "fusion_reset");
	}, 120000, "the post-budget reset");
	const turns = await readJson("turns.json", []);
	const scouts = turns.filter((t) => t.tool === "fusion_scout");
	const answered = scouts.filter((t) => t.toolStatus === "completed" && !t.text.includes("Scout limit reached"));
	const refused = scouts.filter((t) => t.text.includes("Scout limit reached"));
	assert.ok(answered.length >= 4, `Expected at least four answered scout calls, saw ${answered.length} of ${scouts.length}`);
	assert.ok(refused.length >= 1, `No fusion_scout turn was budget-refused: ${scouts.map((t) => t.text.slice(0, 80)).join(" | ")}`);
	for (const refusal of refused) assert.ok(refusal.text.includes("at most 4 fusion_scout calls"), `Unexpected refusal text: ${refusal.text.slice(0, 160)}`);
	// Every non-answered turn must be a Fusion guard (budget refusal or the
	// concurrent-scout guard), never a failed scout child.
	for (const other of scouts.filter((t) => !answered.includes(t) && !refused.includes(t))) {
		assert.ok(`${other.error} ${other.text}`.includes("already running"), `Unexpected scout error: ${other.error.slice(0, 160)} ${other.text.slice(0, 160)}`);
	}
	// The refused call created no native scout child: exactly four exist.
	const bus = await readBus();
	const scoutChildren = bus.filter((e) => e.type === "session.created" && e.data?.agent === "fusion-scout");
	assert.equal(scoutChildren.length, 4, `Expected exactly four scout children, saw ${scoutChildren.length}`);
	assert.ok(turns.some((t) => t.tool === "fusion_reset" && t.status === "completed"), "The post-budget reset failed");
	return { scoutTurns: scouts.length, answered: answered.length, refusals: refused.length, scoutChildren: scoutChildren.length };
}

async function scenarioC({ project, api, readJson, readBus, waitFor, newParent, promptParent, notes, app }) {
	const parent = await newParent();
	await new Promise((r) => setTimeout(r, 3000));
	await promptParent(parent, "Use fusion_scout with one question: \"List every file in this repository and describe the full contents of each file in detail, including anything relevant to a migration of the build system.\" The answer must be thorough.");
	const scoutChild = await waitFor(async () => (await readBus()).find((e) => e.type === "session.created" && e.data?.agent === "fusion-scout")?.data?.sessionID, 90000, "the scout child session");
	// Let the scout start reading, then interrupt the supervisor mid-scout.
	await new Promise((r) => setTimeout(r, 6000));
	const interrupt = await api(`/api/session/${parent}/interrupt`, { method: "POST", body: "{}" });
	assert.equal(interrupt.status, 200, `parent interrupt failed: ${interrupt.body.slice(0, 200)}`);
	await waitFor(async () => {
		const bus = await readBus();
		return bus.some((e) => e.type === "session.execution.interrupted" && e.data?.sessionID === scoutChild);
	}, 60000, "the interrupted scout child");
	// The cancelled scout left no effects and no lock: a scripted reset on the same session succeeds.
	await promptParent(parent, "The scout was interrupted. Call fusion_reset now.");
	await waitFor(async () => {
		const turns = await readJson("turns.json", []);
		return turns.some((t) => t.tool === "fusion_reset");
	}, 120000, "the post-interrupt reset");
	const turns = await readJson("turns.json", []);
	const reset = turns.find((t) => t.tool === "fusion_reset");
	assert.ok(reset && reset.status === "completed", "The post-interrupt reset failed");
	assert.equal(await readFile(join(project, "notes.md"), "utf8"), notes, "The interrupted scout modified notes.md");
	assert.equal(await readFile(join(project, "src/app.ts"), "utf8"), app, "The interrupted scout modified src/app.ts");
	return { scoutChild, scoutInterrupted: true, resetCompleted: reset.status === "completed", turns: turns.map((t) => t.tool) };
}

async function scenarioD({ api, readJson, readBus, waitFor, newParent, promptParent, notes }) {
	const parent = await newParent();
	await new Promise((r) => setTimeout(r, 3000));
	// Configure the executor model through the catalog-validated control, then
	// scout: the scout child must run on the configured model.
	await promptParent(parent, `Call fusion_configure with provider "${provider}" and model "${modelID}". Then call fusion_scout once with the single question "What is in notes.md?". Then call fusion_reset. Do not read any files yourself.`);
	await waitFor(async () => {
		const turns = await readJson("turns.json", []);
		return turns.some((t) => t.tool === "fusion_reset");
	}, 240000, "configure, scout, and reset");
	const turns = await readJson("turns.json", []);
	const configure = turns.find((t) => t.tool === "fusion_configure");
	assert.ok(configure, "No fusion_configure turn recorded");
	assert.equal(configure.status, "completed", "The configure turn failed");
	assert.equal(configure.meta?.applied, "now", `Configure did not apply to this run: ${configure.text.slice(0, 200)}`);
	assert.equal(configure.meta?.model?.providerID ?? configure.meta?.model?.provider, provider, "Configure recorded the wrong provider");
	const scout = turns.find((t) => t.tool === "fusion_scout");
	assert.ok(scout && scout.status === "completed" && scout.childSessionID, "The scout after configure did not complete");
	const childInfo = await api(`/api/session/${scout.childSessionID}`);
	const childBody = childInfo.json();
	const childModel = childBody.model ?? childBody.data?.model;
	assert.ok(childModel, `The child session does not expose its model: ${JSON.stringify(childBody).slice(0, 300)}`);
	assert.equal(childModel.providerID ?? childModel.provider, provider, "The scout child ran on the wrong provider");
	assert.equal(childModel.id ?? childModel.modelID, modelID, "The scout child ran on the wrong model");
	assert.ok(turns.some((t) => t.tool === "fusion_reset" && t.status === "completed"), "The post-configure reset failed");
	return { configure: configure.meta, childModel, scoutText: scout.text.slice(0, 120) };
}

const artifact = { ok: false, model, provider, scenarios: results, prerequisiteChecks };
try {
	if (run("A")) await withServer("a", scenarioA);
	if (run("B")) await withServer("b", scenarioB);
	if (run("C")) await withServer("c", scenarioC);
	if (run("D")) await withServer("d", scenarioD);
	artifact.ok = true;
	console.log(JSON.stringify(results, null, 2));
} catch (error) {
	artifact.error = String(error?.message ?? error);
	console.error(`SCOUT FIXTURE FAILURE: ${artifact.error}`);
	console.error(JSON.stringify({ scenarios: results, prerequisiteChecks }, null, 1).slice(0, 8000));
	process.exitCode = 1;
} finally {
	await writeArtifact("opencode-scout", artifact, { secrets });
}

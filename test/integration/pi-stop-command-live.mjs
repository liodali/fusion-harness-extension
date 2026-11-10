// Opt-in LIVE native probe (R1): proves Pi dispatches an extension command
// while the supervisor is blocked inside an active delegation tool call.
// A real Pi host runs in RPC mode with the real Fusion extension; a real
// model-driven supervisor calls fusion_delegate; a real executor turn runs
// a long bash command; then the USER COMMAND PATH (/fusion-stop) is invoked
// mid-flight. No fixture calls any Fusion tool: the only inputs are RPC
// prompt records, exactly what a user submits.
//
// Scope and evidence: dispatch-during-streaming (prompt disposition
// "handled" while fusion_delegate has no result), the stop command's recap
// notification, executor abort delivery, delegation settlement text, the
// saved stop marker, and no late writes from an aborted shell. What this
// still does not prove: the interactive TUI's editor/Escape path (the RPC
// input path is the documented equivalent for programmatic control).
//
// Usage: FUSION_PI_CMD_STOP_LIVE=1 [FUSION_PI_CMD_STOP_SUPERVISOR=openai-codex/gpt-6-sol]
//        [FUSION_PI_CMD_STOP_MODEL=zai/glm-5.3-flash] bun run test:pi-stop-command-live
// The supervisor must clear the premium tier (>= $10/M output, recent
// cohort) to appear in Fusion's supervisor picker; the executor the cheap
// tier. Both need working credentials in ~/.pi/agent/auth.json.
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, access, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeArtifact } from "./artifact.mjs";

if (process.env.FUSION_PI_CMD_STOP_LIVE !== "1") throw Error("Opt in with FUSION_PI_CMD_STOP_LIVE=1; this fixture consumes model tokens.");
const split = (spec) => { const [provider, ...rest] = spec.split("/"); const id = rest.join("/"); if (!provider || !id) throw new Error(`expected provider/id, got ${spec}`); return { provider, id }; };
const supervisorSpec = split(process.env.FUSION_PI_CMD_STOP_SUPERVISOR ?? "openai-codex/gpt-6-sol");
const executorSpec = split(process.env.FUSION_PI_CMD_STOP_MODEL ?? "zai/glm-5.3-flash");
const repo = resolve(import.meta.dir, "../..");
const hostCli = join(repo, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const root = await mkdtemp(join(tmpdir(), "fusion-pi-cmd-stop-"));
const project = join(root, "project");
const agentDir = join(root, "agent");
await mkdir(project, { recursive: true });
await mkdir(agentDir, { recursive: true });

const result = { ok: false, supervisor: `${supervisorSpec.provider}/${supervisorSpec.id}`, executor: `${executorSpec.provider}/${executorSpec.id}`, host: "bundled SDK cli.js", inputPath: "rpc prompt records", phases: {} };
const assert = (phase, label, condition, detail = "") => { if (!condition) throw new Error(`CMD-STOP FAILURE [${phase}] ${label}${detail ? `: ${detail}` : ""}`); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function bounded(operation, ms, label) { let timer; try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Timed out: ${label}`)), ms); })]); } finally { clearTimeout(timer); } }

const git = (...gitArgs) => new Promise((resolveGit, rejectGit) => {
	const child = spawn("git", ["-C", project, ...gitArgs], { stdio: "ignore" });
	child.on("error", rejectGit);
	child.on("exit", (code) => (code === 0 ? resolveGit() : rejectGit(new Error(`git ${gitArgs.join(" ")} exited ${code}`))));
});

let child;
let settling = false;
try {
	// ---- Isolation: credentials copied into a disposable agent dir; the
	// ownership registry and every Fusion write stay under the temp root.
	process.env.FUSION_OWNERSHIP_DIR = join(root, "ownership");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	for (const name of ["auth.json", "models-store.json"]) await cp(join(homedir(), ".pi/agent", name), join(agentDir, name));
	try { await cp(join(homedir(), ".pi/agent/models.json"), join(agentDir, "models.json")); } catch (error) { if (error.code !== "ENOENT") throw error; }
	await git("init", "-q");
	await git("config", "user.email", "cmd-stop@local");
	await git("config", "user.name", "Cmd Stop Probe");
	await writeFile(join(project, "seed.txt"), "seed\n");
	await git("add", ".");
	await git("commit", "-qm", "seed");

	// ---- RPC client: JSON records on stdin/stdout.
	const pending = new Map();
	const waiters = [];
	const events = [];
	const seen = (predicate) => events.some(predicate);
	const waitFor = (predicate) => { const hit = events.find(predicate); if (hit) return Promise.resolve(hit); return new Promise((resolve) => { waiters.push({ predicate, resolve }); }); };
	let nextId = 0;
	const write = (record) => { child.stdin.write(`${JSON.stringify(record)}\n`); };
	const send = (command) => new Promise((resolveSend, rejectSend) => {
		const id = `probe-${nextId++}`;
		pending.set(id, { resolve: resolveSend, reject: rejectSend });
		write({ id, ...command });
	});

	// Dialog auto-answer: the only scripted interaction. The stop itself is
	// a plain prompt record — the user input path under proof.
	const pickOption = (title, options) => {
		const want = title.toLowerCase().includes("supervisor") ? `${supervisorSpec.provider}/${supervisorSpec.id}` : title.toLowerCase().includes("executor") ? `${executorSpec.provider}/${executorSpec.id}` : undefined;
		if (want) { const hit = options.find((option) => option.includes(want)); if (hit) return hit; }
		if (title.toLowerCase().includes("backend")) { const hit = options.find((option) => option.includes("session")); if (hit) return hit; }
		// A low-reasoning executor runs the literal command instead of
		// deliberating about it (the durable fixture uses thinking off).
		if (title.toLowerCase().includes("executor thinking")) {
			for (const level of ["off", "low", "minimal"]) {
				const hit = options.find((option) => option.trim().toLowerCase().startsWith(level));
				if (hit) return hit;
			}
		}
		return options[0];
	};
	const answerUi = (record) => {
		if (record.method === "select") { const value = pickOption(String(record.title ?? ""), record.options ?? []); if (value !== undefined) write({ type: "extension_ui_response", id: record.id, value }); else write({ type: "extension_ui_response", id: record.id, cancelled: true }); return; }
		if (record.method === "input") {
			// Model search dialogs: query by the wanted model id so the
			// filtered select actually offers it (an empty query would cap
			// the list before reaching it).
			const title = String(record.title ?? "").toLowerCase();
			const query = title.includes("supervisor") ? supervisorSpec.id : title.includes("executor") ? executorSpec.id : "";
			write({ type: "extension_ui_response", id: record.id, value: query });
			return;
		}
		if (record.method === "confirm") { write({ type: "extension_ui_response", id: record.id, confirmed: true }); return; }
	};

	child = spawn(process.execPath, [hostCli, "--mode", "rpc", "--no-session", "--extension", join(repo, "src/index.ts"), "--provider", supervisorSpec.provider, "--model", supervisorSpec.id],
		{ cwd: project, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
	let buffer = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		let index;
		while ((index = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (!line) continue;
			let record;
			try { record = JSON.parse(line); } catch { continue; }
			if (record.type === "response" && record.id && pending.has(record.id)) { pending.get(record.id).resolve(record); pending.delete(record.id); continue; }
			if (record.type === "extension_ui_request") {
				if (["select", "input", "confirm"].includes(record.method)) {
					diagnostics.dialogs.push({ method: record.method, title: record.title, options: (record.options ?? []).slice(0, 12) });
					answerUi(record);
				}
				if (record.method === "notify") { events.push({ type: "ui-notify", text: String(record.message ?? "") }); note({ type: "ui-notify", text: String(record.message ?? "") }); }
				continue;
			}
			events.push(record);
			note(record);
			for (let i = waiters.length - 1; i >= 0; i--) { if (waiters[i].predicate(record)) { waiters[i].resolve(record); waiters.splice(i, 1); } }
		}
	});
	let stderrText = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => { stderrText += chunk; });
	const diagnostics = { eventTypes: {}, notifies: [], firstTexts: [], errors: [], dialogs: [], stderr: "", raw: [] };
	const note = (record) => {
		if (diagnostics.raw.length < 40) diagnostics.raw.push(JSON.stringify(record).slice(0, 300));
		diagnostics.eventTypes[record.type] = (diagnostics.eventTypes[record.type] ?? 0) + 1;
		if (record.type === "ui-notify") diagnostics.notifies.push(record.text);
		if (record.type === "message_update" && record.assistantMessageEvent?.type === "text_delta" && diagnostics.firstTexts.length < 5) {
			const slot = diagnostics.firstTexts.length;
			diagnostics.firstTexts[slot] = (diagnostics.firstTexts[slot] ?? "") + record.assistantMessageEvent.delta;
			if (diagnostics.firstTexts[slot].length > 400) diagnostics.firstTexts.push("…");
		}
		if (record.type === "extension_error" || record.type === "error") diagnostics.errors.push(JSON.stringify(record).slice(0, 400));
		if (record.type === "message_end" && (diagnostics.messageEnds ??= []).length < 6) {
			const message = record.message ?? {};
			diagnostics.messageEnds.push(JSON.stringify({ reason: message.stopReason, error: message.errorMessage, parts: (message.content ?? []).map((part) => part.type) }).slice(0, 300));
		}
		if (record.type === "tool_execution_end" && (diagnostics.delegateEnds ??= []).length < 3) diagnostics.delegateEnds.push(JSON.stringify(record.result ?? {}).slice(0, 500));
	};
	result.diagnostics = diagnostics;
	const dieOnExit = new Promise((_, reject) => { child.on("exit", (code) => { if (!settling) reject(new Error(`Pi exited early (${code}). stderr: ${stderrText.slice(-2000)}`)); }); });

	const delegateStarted = () => waitFor((record) => record.type === "tool_execution_start" && record.toolName === "fusion_delegate");
	const delegateUpdate = () => waitFor((record) => record.type === "tool_execution_update" && record.toolName === "fusion_delegate");
	const delegateEnded = () => waitFor((record) => record.type === "tool_execution_end" && record.toolName === "fusion_delegate");
	const delegatePayload = (record) => JSON.stringify({ partial: record.partialResult, result: record.result });
	const delegateResultText = (record) => JSON.stringify(record.result ?? {});

	// ---- Phase 1: start a run through the user command path.
	const task = "Cancellation integration probe. Do not scout and do not explore the repository. Immediately call the fusion_delegate tool with action \"execute\" and pass this exact brief, word for word: 'Use the bash tool to actually execute this command: sleep 45; printf completed > completion-marker.txt — do not simulate it, do not describe it, run it with bash and wait for it to finish, then report DONE. This is the complete task; nothing else is needed.' Then wait for its result.";
	const started = await bounded(send({ type: "prompt", message: `/fusion ${task}` }), 60000, "/fusion command response");
	assert("start", "/fusion is dispatched as an extension command", started.success === true && started.data?.disposition === "handled", JSON.stringify(started));
	result.phases.runCommand = "handled";

	// ---- Phase 2: wait for the supervisor to block inside fusion_delegate
	// with real executor activity.
	await bounded(Promise.race([delegateStarted(), dieOnExit]), 240000, "fusion_delegate tool start");
	result.phases.delegationStarted = true;
	await bounded(Promise.race([delegateUpdate(), dieOnExit]), 120000, "executor activity while the supervisor is blocked");
	result.phases.executorActiveDuringBlock = true;
	// Stop the moment the executor's long bash command is observably
	// running — racing the delegation's own completion, since a delegation
	// that ends before the stop leaves nothing to interrupt.
	const bashOrEnd = await bounded(Promise.race([
		waitFor((record) => record.type === "tool_execution_update" && record.toolName === "fusion_delegate" && /bash/i.test(delegatePayload(record))).then(() => "bash"),
		delegateEnded().then(() => "ended"),
		dieOnExit,
	]), 90000, "executor bash observation");
	if (bashOrEnd === "ended") throw new Error("The delegation finished before the stop was sent (the executor did not run the long bash command); rerun the probe.");
	const bashObservedAt = Date.now();
	result.bashObserved = true;

	// ---- Phase 3: the proof. A user command record while the delegation is
	// still in flight must dispatch immediately.
	assert("stop", "no fusion_delegate result before the stop", !seen((record) => record.type === "tool_execution_end" && record.toolName === "fusion_delegate"));
	const stopPromptSentAt = Date.now();
	const stopped = await bounded(send({ type: "prompt", message: "/fusion-stop probe stop" }), 30000, "/fusion-stop command response");
	assert("stop", "/fusion-stop dispatches during active delegation", stopped.success === true && stopped.data?.disposition === "handled", JSON.stringify(stopped));
	result.phases.stopDispatchedWhileDelegating = true;
	const notify = await bounded(waitFor((record) => record.type === "ui-notify" && record.text.includes("Fusion executor stopped")), 30000, "stop recap notification");
	result.phases.stopRecapNotified = true;
	assert("stop", "the recap states the run and recovery path", notify.text.includes("/fusion-resume") || notify.text.includes("stopped"), notify.text.slice(0, 200));

	// ---- Phase 4: the abort ends the executor turn; the blocked supervisor
	// settles the delegation itself.
	const ended = await bounded(Promise.race([delegateEnded(), dieOnExit]), 120000, "fusion_delegate settlement after the abort");
	result.phases.delegationSettled = true;
	assert("settle", "the delegation reports the stop", /stopped with status/.test(delegateResultText(ended)), delegateResultText(ended).slice(0, 300));
	const abortedWhileStopped = seen((record) => record.type === "tool_execution_end" && record.toolName === "fusion_delegate" && /stopped with status "aborted"/.test(delegateResultText(record)));
	result.phases.abortedSettlement = abortedWhileStopped;

	// ---- Phase 5: durable state matches the command's claims. The recap
	// names the run id; read that exact record (the host's ctx.cwd is the
	// realpath of the temp project, so scanning by cwd string is unreliable).
	const runId = notify.text.match(/run ([0-9A-Za-z.-]+),/)?.[1];
	await delay(1500);
	let saved;
	if (runId) {
		try { saved = JSON.parse(await readFile(join(agentDir, "fusion", "runs", `${runId}.json`), "utf8")); } catch {}
	}
	assert("record", "the stop marker is saved with the command's reason", saved?.stopped?.reason === "probe stop", JSON.stringify(saved ?? null));
	assert("record", "the run settled as failed with no pending request", saved?.status === "failed" && saved?.pending === undefined, JSON.stringify({ status: saved?.status, pending: saved?.pending }));
	result.savedRun = saved ? { runId: saved.runId, status: saved.status, stopped: saved.stopped, pending: saved.pending, updatedAt: saved.updatedAt } : null;
	result.phases.stopRecordSaved = true;

	// ---- Phase 6: the aborted shell must not outlive the stop.
	const remaining = bashObservedAt + 48000 - Date.now();
	if (remaining > 0) await delay(remaining);
	assert("late-write", "no marker written by the aborted shell", (await exists(join(project, "completion-marker.txt"))) === false);
	result.phases.noLateWrite = true;

	result.ok = true;
} catch (error) {
	result.error = String(error?.message ?? error);
	result.diagnostics.stderr = stderrText.slice(-1500);
	process.exitCode = 1;
} finally {
	settling = true;
	try { if (child?.stdin) child.stdin.end(); } catch {}
	try {
		await Promise.race([new Promise((resolveExit) => { if (child) child.once("exit", resolveExit); else resolveExit(); }), delay(5000)]);
		if (child && child.exitCode === null) child.kill("SIGKILL");
	} catch {}
	await writeArtifact("pi-stop-command-live", result);
	await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify(result));
process.exit(process.exitCode ?? 0);

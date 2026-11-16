// Opt-in live model test. All project and OpenCode state is disposable.
// Entry is through the supported user-facing controls only: the fixture
// verifies prerequisites model-free BEFORE any paid prompt (active agent,
// persistent-mode state, and expected tool visibility through the real
// command API and the host's own context hook), then starts the run with
// `/fusion-run` — the paid supervisor protocol flows from the run prompt.
// The negative check is preserved: with mode off and no active run the gated
// Fusion tools must be hidden from the fusion agent.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeArtifact } from "./artifact.mjs";
import { Database } from "bun:sqlite";

const model = process.env.FUSION_OPENCODE_MODEL;
if (!model) throw new Error("Set FUSION_OPENCODE_MODEL to an authenticated OpenCode model (provider/model).");
const [modelRef, variant] = model.split("#");
const [provider, modelID] = modelRef.split("/");
if (!provider || !modelID) throw new Error(`FUSION_OPENCODE_MODEL must be provider/model, got ${model}`);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = await mkdtemp(join(tmpdir(), "fusion-opencode-live-"));
const prerequisiteChecks = [];
const secrets = [];
let child;
let url;
let password;
let startup = "";
const artifact = { ok: false, model, variant: variant ?? null, prerequisiteChecks, turns: [], usageEvents: 0, fixture: null };
try {
  const project = join(root, "project");
  await mkdir(join(project, ".opencode/plugins"), { recursive: true });
  await mkdir(join(project, ".opencode/agents"), { recursive: true });
  await cp(join(repo, "src"), join(project, ".opencode/fusion"), { recursive: true });
  await cp(join(repo, "examples/opencode/agents"), join(project, ".opencode/agents"), { recursive: true });
  await writeFile(join(project, ".opencode/plugins/fusion.ts"), 'export { default } from "../fusion/opencode/index.ts";\n');
  await writeFile(join(project, ".opencode/plugins/workflow-driver.ts"), `
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
export default { id: "fusion-workflow-driver", async setup(ctx) {
  const turns: { action?: string; childSessionID?: string }[] = [];
  let usageEvents = 0;
  let resetCompleted = false;
  const write = async () => { try { await writeFile(join(ctx.location.directory, "observer.json"), JSON.stringify({ turns, usageEvents, resetCompleted })); } catch {} };
  const probeSessions = new Set<string>();
  await ctx.tool.hook("execute.after", async (event) => {
    if (event.tool === "fusion_delegate" && event.status === "completed") {
      turns.push({ action: event.result?.metadata?.action, childSessionID: event.result?.metadata?.childSessionID });
      await write();
    }
    if (event.tool === "fusion_reset" && event.status === "completed") { resetCompleted = true; await write(); }
    if (event.tool?.startsWith("fusion_") && event.status !== "completed") { await writeFile(join(ctx.location.directory, "failed-calls.json"), JSON.stringify({ tool: event.tool, error: String(event.error ?? "").slice(0, 400) })); }
  });
  await ctx.session.hook("context", async (event) => {
    if (probeSessions.has(event.sessionID ?? "")) {
      await writeFile(join(ctx.location.directory, "capture.json"), JSON.stringify({ sessionID: event.sessionID, agent: event.agent, tools: Object.keys(event.tools) }));
      throw new Error("WORKFLOW_VISIBILITY_PROBE_STOP_BEFORE_MODEL");
    }
  });
  await ctx.command.transform(ed => ed.add({ name: "workflow-visibility-probe", description: "Capture the fusion agent's tool visibility without a model call", execute: async () => {
    const session = await ctx.session.create({});
    if (session?.id) probeSessions.add(session.id);
    await ctx.session.switchAgent({ sessionID: session.id, agent: "fusion" });
    try { await ctx.session.prompt({ sessionID: session.id, text: "Diagnostic only. Do not edit files." }); } catch {}
    return "probe issued";
  } }));
  const iter = ctx.event.subscribe()[Symbol.asyncIterator]();
  void (async () => { for (;;) { const next = await iter.next(); if (next.done) break; if (next.value?.type === "session.usage.updated") { usageEvents++; await write(); } } })().catch(() => {});
  // Configure the executor model against the live catalog before any run
  // (the /fusion-config command shares the same serialized operation; this
  // model-free configuration reaches executor and scout children).
  const tools = await ctx.tool.list();
  const configure = tools.find((tool) => tool.id === "fusion_configure");
  if (!configure) throw new Error("fusion_configure was not registered before the driver loaded");
  const probeSession = await ctx.session.create({});
  const configureContext = { sessionID: probeSession.id, agent: "fusion", messageID: "msg_workflow_configure", id: "call_workflow_configure", signal: new AbortController().signal, progress: async () => {} };
  const applied = await configure.execute({ provider: ${JSON.stringify(provider)}, model: ${JSON.stringify(modelID)}${variant ? `, variant: ${JSON.stringify(variant)}` : ""} }, configureContext);
  await writeFile(join(ctx.location.directory, "configure.json"), JSON.stringify(String(applied?.content ?? "").slice(0, 300)));
} };
`);
  await writeFile(join(project, "opencode.json"), JSON.stringify({ permissions: [
    ...["shell", "external_directory", "webfetch", "websearch", "skill", "glob", "grep", "read", "edit"].map((action) => ({ action, resource: "*", effect: "deny" })),
    ...["read", "edit"].flatMap((action) => ["fixture.txt", "*/fixture.txt"].map((resource) => ({ action, resource, effect: "allow" }))),
  ] }));
  const env = Object.fromEntries(["PATH", "HOME", "SHELL", "TMPDIR", "LANG", "SYSTEMROOT"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  for (const [key, folder] of Object.entries({ XDG_DATA_HOME: "data", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state" })) env[key] = join(root, folder);
  env.FUSION_OWNERSHIP_DIR = join(root, "ownership");
  await mkdir(join(env.XDG_DATA_HOME, "opencode"), { recursive: true });
  // Copy only credentials, never the user's database, plugins, or project config.
  let auth = {};
  try { auth = JSON.parse(await readFile(join(homedir(), ".local/share/opencode/auth.json"), "utf8")); } catch {}
  if (auth[provider]) {
    await writeFile(join(env.XDG_DATA_HOME, "opencode/auth.json"), JSON.stringify({ [provider]: auth[provider] }), { mode: 0o600 });
    for (const value of Object.values(auth[provider])) if (typeof value === "string" && value.length > 12) secrets.push(value);
  }
  // OpenCode v2 uses account.json for active integrations; retain only this provider.
  let account;
  try { account = JSON.parse(await readFile(join(homedir(), ".local/share/opencode/account.json"), "utf8")); } catch {}
  const accountID = account?.active?.[provider];
  const selectedAccount = accountID && account?.accounts?.[accountID];
  if (selectedAccount) {
    await writeFile(join(env.XDG_DATA_HOME, "opencode/account.json"), JSON.stringify({ version: account.version, accounts: { [accountID]: selectedAccount }, active: { [provider]: accountID } }), { mode: 0o600 });
    for (const value of Object.values(selectedAccount?.credential ?? {})) if (typeof value === "string" && value.length > 12) secrets.push(value);
  }
  // V2 stores active credentials in its database. Read only the requested
  // provider's active value; never copy the database into the fixture.
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
  child = spawn(process.env.FUSION_OPENCODE_BIN || "opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { startup += data; });
  url = await (async () => {
    const deadline = Date.now() + 40000;
    for (;;) {
      const found = startup.match(/server listening on (http:\/\/[^\s]+)/)?.[1];
      password = startup.match(/server password ([^\s]+)/)?.[1];
      if (found && password) return found;
      if (child.exitCode !== null) throw new Error(`Server exited: ${startup.slice(-400)}`);
      if (Date.now() > deadline) throw new Error(`Server never listened: ${startup.slice(-400)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
  if (typeof password === "string" && password.length > 12) secrets.push(password);
  const authHeader = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const probe = await fetch(`${url}/api/location`, { headers: { authorization: authHeader }, signal: AbortSignal.timeout(10000) });
  assert.equal(probe.status, 200);
  const api = async (path, init) => {
    const response = await fetch(`${url}${path}`, { ...init, headers: { authorization: authHeader, "content-type": "application/json", ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(20000) });
    const text = await response.text();
    return { status: response.status, body: text, json: () => JSON.parse(text) };
  };
  const waitFor = async (predicate, ms, label) => {
    const start = Date.now();
    for (;;) {
      const value = await predicate();
      if (value) return value;
      if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 800));
    }
  };
  const readJson = async (file) => { try { return JSON.parse(await readFile(join(project, file), "utf8")); } catch { return undefined; } };
  const readCapture = async () => readJson("capture.json");
  const runProbe = async (sessionID, label) => {
    await rm(join(project, "capture.json"), { force: true });
    const reply = await api(`/api/session/${sessionID}/command`, { name: "workflow-visibility-probe", text: "" });
    assert.ok(reply.status >= 200 && reply.status < 300, `visibility probe command returned ${reply.status}`);
    return await waitFor(async () => {
      const value = await readCapture();
      return value && typeof value.sessionID === "string" ? value : undefined;
    }, 30000, `the ${label} visibility capture`);
  };
  const GATED = ["fusion_start", "fusion_delegate", "fusion_scout", "fusion_reconcile", "fusion_reset", "fusion_configure"];
  // Lazy plugin activation: wait for the fusion agent, then the driver's
  // configure report.
  await waitFor(async () => {
    const agents = await api("/api/agent").json();
    return (Array.isArray(agents) ? agents : agents.data ?? []).some((agent) => agent?.id === "fusion");
  }, 60000, "plugin activation (the fusion agent)");
  await waitFor(async () => readJson("configure.json"), 60000, "the driver's catalog configuration");
  // 1. Negative check: mode off with no run — gated tools hidden.
  const controlSession = await api("/api/session", { method: "POST", body: JSON.stringify({ agent: "fusion", model: { providerID: provider, id: modelID } }) }).json();
  const controlID = controlSession.id ?? controlSession.data?.id;
  assert.ok(controlID, "the control session was not created");
  const agentInfo = await api(`/api/session/${controlID}`).json();
  const observedAgent = agentInfo.agent ?? agentInfo.data?.agent;
  prerequisiteChecks.push({ check: "active agent is fusion", observedAgent, pass: observedAgent === "fusion" });
  assert.equal(observedAgent, "fusion", `the control session runs agent ${observedAgent}, not fusion`);
  const offTools = (await runProbe(controlID, "mode-off")).tools.filter((name) => name.startsWith("fusion"));
  prerequisiteChecks.push({ check: "mode off with no run hides the gated Fusion tools", capture: offTools, pass: GATED.every((name) => !offTools.includes(name)) });
  assert.deepEqual(offTools, [], `mode off must hide the gated Fusion tools, saw ${offTools.join(", ")}`);
  // 2. Enable persistent mode through the supported command surface and
  // verify the delivered report before the paid run.
  const modeReply = await api(`/api/session/${controlID}/command`, { name: "fusion-mode", text: "on" });
  assert.ok(modeReply.status >= 200 && modeReply.status < 300, `the fusion-mode command returned ${modeReply.status}`);
  const modeReport = await waitFor(async () => {
    const inbox = await api(`/api/session/${controlID}/inbox`).json();
    const entries = inbox.data ?? inbox ?? [];
    return entries.find((entry) => entry?.type === "synthetic" && typeof entry?.payload?.text === "string" && entry.payload.text.includes("Fusion persistent mode enabled"))?.payload?.text;
  }, 30000, "the delivered fusion-mode report");
  prerequisiteChecks.push({ check: "the fusion-mode command reports persistent mode enabled", report: (modeReport ?? "").slice(0, 160), pass: !!modeReport });
  assert.ok(modeReport, "the fusion-mode report was not delivered");
  // 3. Positive check: with mode on, the delegated workflow's tools are visible.
  const onTools = (await runProbe(controlID, "mode-on")).tools.filter((name) => name.startsWith("fusion"));
  prerequisiteChecks.push({ check: "mode on exposes the gated Fusion tools to the fusion agent", capture: onTools, pass: GATED.every((name) => onTools.includes(name)) });
  assert.deepEqual(GATED.filter((name) => !onTools.includes(name)), [], `mode on must expose the gated Fusion tools, missing ${GATED.filter((name) => !onTools.includes(name)).join(", ")}`);
  // 4. The paid run starts through /fusion-run — everything the model does
  // flows from the run prompt (the supported new-task entry).
  const runSession = await api("/api/session", { method: "POST", body: JSON.stringify({ agent: "fusion", model: { providerID: provider, id: modelID } }) }).json();
  const runID = runSession.id ?? runSession.data?.id;
  assert.ok(runID, "the run session was not created");
  const task = 'Test the Fusion workflow in this disposable directory. Use fusion_delegate execute to create fixture.txt containing exactly "alpha\\n". Then use fusion_delegate revise to change it to exactly "beta\\n". Then use fusion_delegate final_fix to change it to exactly "gamma\\n". Each step must be delegated to the same executor, even though this is a test. Review the file after each step. Finally report the outcome and call fusion_reset.';
  const runReply = await api(`/api/session/${runID}/command`, { name: "fusion-run", text: task });
  assert.ok(runReply.status >= 200 && runReply.status < 300, `the fusion-run command returned ${runReply.status}`);
  const startedReport = await waitFor(async () => {
    const inbox = await api(`/api/session/${runID}/inbox`).json();
    const entries = inbox.data ?? inbox ?? [];
    return entries.find((entry) => entry?.type === "synthetic" && typeof entry?.payload?.text === "string" && entry.payload.text.startsWith("Fusion run started"))?.payload?.text;
  }, 30000, "the delivered fusion-run report");
  assert.ok(startedReport, "the fusion-run report was not delivered");
  artifact.runStarted = startedReport.slice(0, 160);
  // 5. Wait for the run to finish (the task ends with fusion_reset), then
  // assert the protocol's outcomes.
  await waitFor(async () => {
    const observer = await readJson("observer.json");
    return observer?.turns?.some((turn) => turn.action === "final_fix");
  }, 420000, "the execute, revise, and final_fix delegations");
  await waitFor(async () => (await readJson("observer.json"))?.resetCompleted === true, 180000, "the run to settle after final_fix (fusion_reset)");
  const contents = await readFile(join(project, "fixture.txt"), "utf8").catch(() => undefined);
  const observer = await readJson("observer.json") ?? { turns: [], usageEvents: 0, resetCompleted: false };
  artifact.fixture = contents ?? null;
  artifact.turns = observer.turns;
  artifact.usageEvents = observer.usageEvents;
  const failedCall = await readJson("failed-calls.json");
  if (failedCall) artifact.failedCall = failedCall;
  assert.equal(contents, "gamma\n", "Executor did not complete all fixture changes");
  assert.deepEqual(observer.turns.map((turn) => turn.action), ["execute", "revise", "final_fix"], "Expected three completed delegation actions");
  assert.ok(observer.turns[0].childSessionID && observer.turns.every((turn) => turn.childSessionID === observer.turns[0].childSessionID), "Expected the same executor child for all turns");
  artifact.ok = true;
} catch (error) {
  artifact.error = String(error?.message ?? error);
  artifact.serverLog = startup.slice(-4000);
  console.error(`WORKFLOW FIXTURE FAILURE: ${artifact.error.replace(new RegExp(secrets.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g"), "[redacted]")}`);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  await Promise.race([new Promise((r) => child?.once("exit", r)), new Promise((r) => setTimeout(r, 3000))]);
  try { await writeArtifact("opencode-workflow", artifact, { secrets }); } catch {}
  await rm(root, { recursive: true, force: true });
}

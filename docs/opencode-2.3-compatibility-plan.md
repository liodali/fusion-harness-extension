# OpenCode 2.3.0 compatibility plan

Date: 2026-11-16. Status: C1 complete; C2–C6 planned.

Goal: support OpenCode **2.3.0** with working package/Git installation,
agent registration, executor and scout workflows, and R0–R5 controls. Keep
2.2.5 as the regression baseline. Passing on 2.3.0 does not establish support
for every later 2.3.x release.

R0–R5 are implemented and reviewed. This is the follow-up to the
[final acceptance record](./run-control-and-observability-plan.md#completion-gate),
not a reopening of those feature slices. Do not publish a release as part of
this work unless requested.

## Evidence and boundaries

The recorded baseline is 617 tests passing, typecheck clean, and successful
packing/clean consumption. On the real 2.3.0 host, smoke, stop, restart,
delegate display, and doctor command checks pass. Remaining failures:

| Gap | Recorded evidence | Required outcome |
| --- | --- | --- |
| Native loading | [Native surface artifact](../artifacts/opencode-native-surface-2026-11-16T085210-207Z.json): four failures covering reinstall, Git agent contribution, Git command registration, and active package-plugin loading | Installed plugin actually loads and contributes the expected surfaces; reinstall leaves exactly one contribution |
| Package loading | [Package-load artifact](../artifacts/opencode-package-load-2026-11-16T085149-344Z.json): active non-builtin source assertion fails | Identify whether the host envelope changed or loading failed; prove the exact tarball is loaded |
| Scout fixture startup | [Scout diagnosis](../artifacts/opencode-scout-v23-diagnosis.json): model prompted with mode off and no active run | Start through supported Fusion controls; retain the negative mode-gating checks |
| Scout background completion | Same diagnosis: native foreground call returns `running`; scout has no settlement handler and reports failure while the child answers | Adopt the original scout's exact result, or report pending/unknown honestly, without resubmission |
| Manual agent definitions | Same diagnosis: generated Markdown and plugin contributions are reported as permission conflicts on 2.3.0 | Equivalent shipped definitions agree; real user overrides remain visible |

The server adapter currently mirrors a local `PluginContext`; the TUI imports
official types from `@opencode/plugin/tui`. The development dependency and CI
host are pinned to 2.2.5. An SDK dependency update alone will not repair native
behavior. Do not replace host plugin context calls with a REST client merely
to claim SDK usage.

All development checks use isolated workspaces, config, credentials, and
ownership storage. Default checks make zero model calls. Live acceptance is
separate, explicitly opted into, and records usage. Do not use monitoring
prompts, summarizer calls, or polling models to implement compatibility.

## Implementation order

Complete and review each slice before moving to the next. Update the checkboxes
and evidence record only after the corresponding acceptance checks pass.

### C1 — Pin the host contracts and official types

- [x] Record the exact 2.3.0 CLI binary/package and available matching official
  plugin package version. Compare its declarations with the current 2.2.5
  declarations and the real host; do not infer exports from version numbers.
- [x] Create a small contract matrix for plugin discovery/export shape,
  registry source/status envelopes, agent editors and permission precedence,
  tool context/progress, subagent results, events/forms, interruption, command
  delivery, catalog entries, and completion notifications.
- [x] Use exported official server and TUI types wherever the supported
  package exposes them. Reduce the local `PluginContext`, tool, and event
  mirrors to explicitly documented compatibility boundaries. Validate the
  plugin export against the official contract without broad `any` casts.
- [x] Pin the chosen development dependency and lockfile. If a needed contract
  has no public type, retain a narrow adapter with runtime validation and a
  model-free native contract fixture; document that limitation.
- [x] Keep version-dependent parsing in `src/opencode/`; shared orchestration
  remains host-free. Prove that the dedicated package still loads without Pi
  SDKs or an accidentally required development-only SDK dependency.

Acceptance: typecheck, core-boundary and clean-install checks pass. The matrix
names the official type or observed host evidence for each contract and marks
2.2.5/2.3.0 differences explicitly. No support-range change yet.

### C2 — Repair fixture entry and evidence reporting

- [x] Update `test/integration/opencode-scout.mjs` and audit workflow/parity
  fixtures for direct prompting that bypasses current mode/run gates. Prefer
  `/fusion-run` for a new task; use `/fusion-mode on` explicitly for scenarios
  that exercise persistent mode.
- [x] Before a paid prompt, check the active agent, mode/run state, and expected
  tool visibility through supported local host surfaces. Fail early with a
  bounded artifact when prerequisites are missing.
- [x] Preserve negative checks: mode off with no run must hide gated tools,
  and a non-Fusion agent must not gain delegation authority.
- [x] Ensure native/package fixtures exit nonzero on failed assertions and
  write `ok: false` with the failing surface, installed version/source, and
  relevant bounded host response. A successful print line is not a pass.

Acceptance: model-free tool-visibility checks pass on both hosts. The scout
fixture no longer needs scratch modifications to make its tools visible.

### C3 — Fix loading, registration, and agent compatibility

- [ ] Reproduce the four native-surface failures and the package-load failure
  on the pinned 2.3.0 binary. Classify each as a product failure or a stale
  response-shape assertion using C1 evidence.
- [ ] Adapt plugin discovery and registry parsing to the verified shapes.
  Keep assertions for actual activation, package identity, native source,
  all three agents, and all ten Fusion commands. Do not suppress failures or
  treat a successful module import as proof of host activation.
- [ ] Verify registration disposal and reinstall: one plugin contribution,
  one of each agent/command, and no stale contributions after removal.
- [ ] Compare permission semantics on 2.3.0. Update contribution/Markdown
  generation or semantic comparison where needed; regenerate shipped agents.
  Ignore ordering/default expansion only when the host proves equivalence.
  Keep real user overrides and privilege differences reported as conflicts.
- [ ] Preserve restrictions: executor cannot delegate recursively; scout
  cannot mutate or ask interactive questions; supervisor can reach only the
  intended Fusion workers. Executor questions remain supported native forms.

Acceptance: `test:opencode-native`, `test:opencode-package-load`, and
`test:opencode-tool-visibility` pass on 2.3.0 and the 2.2.5 baseline. Test these
install forms independently: dedicated tarball with empty agent directories,
Git installation, copied checkout, and documented legacy Markdown install.
Include a deliberate user override and confirm it remains detectable.

### C4 — Support backgrounded scouts without duplicate work

- [ ] Add a model-free regression reproducing a scout whose native result is
  `running`, including the child's answer arriving before and after that
  return. Preserve ordinary foreground completion on 2.2.5.
- [ ] Implement scout-specific exact completion adoption through the original
  child session and request/job identity. Reuse the native completion evidence
  mechanism where applicable; keep executor reconciliation separate from
  active-turn reattachment and from a new scout submission.
- [ ] Preferred behavior: await that original scout's completion with a
  bounded, cancellation-aware wait. If proof is unavailable at the deadline,
  return an explicit pending/unknown disposition instead of a completed answer
  or an internal executor-settlement error. Specify the status/recovery action
  for that disposition before integrating it into the entrypoint.
- [ ] Retain the child handle, ownership, invocation/tool caps, stop authority,
  and necessary request metadata until terminal proof or explicit operator
  resolution. Persist any new recovery fields additively; a restart must not
  silently discard a still-running child or recreate the request.
- [ ] Deduplicate progress, completion, and late usage by the exact request.
  Await child-reference persistence before forwarding progress. Missing or
  foreign evidence never unlocks or settles the child.
- [ ] Preserve R1–R5 behavior while pending: stop reaches the owned scout;
  waits remain visible; reset/release cannot abandon uncertain work; budget
  coverage stays honest; doctor and recovery name the same next action.

Acceptance: tests cover foreground/background completion, early/late and
duplicate delivery, wrong child/request, missing notification, timeout, abort,
failed persistence with retry, restart, and stop during a question/permission
wait. Each logical scout makes exactly one native submission, consumes one
invocation slot, and counts usage once. No additional model calls.

### C5 — Integrate controls, packaging, and CI

- [ ] Run the complete unit suite and typecheck, plus native smoke, restart,
  tool visibility, delegate display, stop, ownership, and doctor checks.
  Include executor foreground-to-background behavior alongside scouts.
- [ ] Build and pack one dedicated tarball, record its SHA256, and pass that
  exact artifact to package-load/display/stop checks and a clean consumer.
  Verify server/TUI entrypoints, zero Pi SDKs, and the installed resolve CLI
  from a directory outside the package checkout.
- [ ] Extend `.github/workflows/package-opencode.yml` with model-free host
  coverage for 2.2.5 and 2.3.0. Preserve package/content checks and retain
  failure artifacts from each matrix entry. Model credentials are not needed
  for pull-request checks.
- [ ] Keep the upstream missing-notification restart limitation explicit:
  missing proof leaves work locked with an actionable recovery path; it is
  never solved by resubmitting or automatically confirming termination.

Acceptance: all applicable model-free checks pass on both pinned hosts against
the exact commit/tarball. No Pi regressions (`test:pi-load` and existing shared
controller/stop tests). Any retained older-version support claim needs its own
recorded evidence; do not silently broaden the range to untested releases.

### C6 — Live acceptance and support declaration

- [ ] With explicit opt-in and working credentials, run `test:opencode-scout`,
  `test:opencode-workflow`, and `test:opencode-parity` on 2.3.0. Audit their
  prerequisites in C2 first. Use tiny tasks and bounded turns/time/cost.
- [ ] Prove the supervisor receives the scout answer and continues the Fusion
  protocol, rather than merely showing an answer in the child's transcript.
  Verify invocation refusal, no resubmission, revise/final-fix, stop, and
  reconciliation through user-facing controls.
- [ ] Record version, install form, commit/tarball SHA, commands, outcomes,
  artifacts, observed tokens/cost, and remaining limitations. Distinguish
  fixture-driven native controls from a model-driven supervisor workflow.
- [ ] After acceptance passes, update the support/version check in
  `/fusion-doctor`, dependency/CI pins, README, install/testing guides, the
  run-control plan, and handoff. Explain which legacy install steps remain
  necessary. Keep pending credential-dependent checks marked incomplete.

Acceptance: 2.3.0 is declared supported only after loading/registration,
background scout behavior, model-free controls, clean package consumption,
and live workflow evidence pass. Expired credentials can block live acceptance
but do not excuse product or model-free fixture failures. Cross-harness live
Pi parity remains a separate opt-in gate; do not describe it as verified by
these OpenCode-only runs.

## Finish criteria and evidence log

No open 2.3.0 loading or scout-result failures; all C1–C6 acceptance gates are
recorded; no weakened ownership, stop, permission, accounting, or recovery
guarantees; no paid default diagnostic/monitoring calls. Packaging a release is
a subsequent requested action.

For each slice append: commit, exact host/plugin versions, checks run, artifact
paths, result, and limits. Initial state: C1–C6 unchecked; the failure artifacts
above are baseline evidence, not passing acceptance for this plan.

### C1 — recorded 2026-11-16

- Commit: the C1 commit (type pin, official-contract validation, contract
  matrix, isolation-rule update).
- Versions: OpenCode CLI `v2.3.0` (local binary) and `v2.2.5`
  (`npm install --prefix <scratch> @opencode/cli@2.2.5`, used for the 2.2.5
  side of the probes); official plugin declarations from the published
  `@opencode/plugin@2.2.5` and `@opencode/plugin@2.3.0` tarballs
  (`dist/promise/*.d.ts` compared directly) plus `@opencode/schema@2.3.0`;
  development dependency pinned to `@opencode/plugin@2.3.0` in
  `package.json`/`bun.lock`.
- Matrix: `docs/opencode-contract-matrix.md` — twelve contracts, each naming
  the official type or recorded host evidence, with explicit 2.2.5/2.3.0
  differences. Headline findings, all probe-pinned on both hosts:
  1. The server context declarations Fusion uses (`plugin.d.ts`,
     `agent.d.ts`, `event.d.ts`, `model.d.ts`, `storage.d.ts`,
     `command.d.ts`, TUI `index.d.ts`) are **identical** between 2.2.5 and
     2.3.0; only `promise/tool.d.ts` (cooperative-stop `signal`
     documentation) and `promise/session.d.ts` (additive hooks:
     `SessionRequestMessage`, `fork`, `experimental.model.resolve`) differ.
  2. The host backgrounds **foreground** subagent calls on 2.3.0
     (`status: "running"`, `output: "pending"`); the child's completion later
     lands in the parent session context as the pinned synthetic
     `<subagent …>` notification (`agent: "fusion-scout"` live-captured on
     2.3.0 with a real child answer, `state: "completed"`). This is the C4
     adoption mechanism; executor reconciliation already uses it.
  3. The four native-surface failures and the package-load failure reproduce
     only when fixtures read the registry in a **single shot**: plugin
     activation is lazy per location and contributions land after the first
     `/api/agent` response. With bounded polling, the same installs pass on
     2.3.0 (`plugin add` git source and project-config path plugin; agents
     `fusion`/`fusion-executor`/`fusion-scout` contributed once each, all ten
     commands, `/api/plugin` active with a non-builtin source). Classified
     for C3 as stale response-shape assertions, not product failures.
  4. The agent registry (both hosts, `ctx.agent.list()` and `/api/agent`)
     concatenates identical permission rules when a Markdown definition and
     the plugin contribution coincide, and appends host defaults
     (`browser/* deny`, `skill/browser deny`) to every agent — identical on
     2.2.5 and 2.3.0. The plugin's exact-length permission comparison
     therefore reports shipped-equivalent definitions as conflicts on **both**
     hosts; the C3 fix is a semantic comparison that ignores only the pinned
     host defaults while keeping every real override visible.
- Type adoption: the TUI side keeps its official `@opencode/plugin/tui`
  `Plugin` typing (unchanged); the server side keeps the documented
  `PluginContext` boundary view and now validates the official contract
  through six derived compile-time checks in `src/opencode/index.ts`
  (`OFFICIAL_CONTRACT_VALIDATED`) — official drift fails typecheck with zero
  casts. Local mirrors (`ToolDefinition`, `CommandDefinition`, `AgentRecord`,
  `AgentEditor`, `HostModel`, `ToolHookEvent`, `NativeRegistration`) carry
  comments naming their official equivalents; no `any` was introduced.
  Rationale for not typing `setup` directly as `Plugin.Context`: the official
  context requires branded IDs and full `SessionInfo`/`StorageDomain` shapes,
  which would force branded casts through every test fake — the boundary-view
  plus validation approach keeps the official contract enforced where it is
  load-bearing without that coupling.
- Isolation rule: `test/package-isolation.test.ts` now classifies import
  kinds — the OpenCode closure may carry the official plugin package only as
  a type-only import (erased at load); every other bare specifier and every
  runtime import stays a violation, and the Pi-reach rule still flags type
  imports of Pi sources.
- Checks: `bunx tsc --noEmit` clean; `bun test` 617 pass / 0 fail (46 files);
  `test:clean-install` ok (`artifacts/clean-install-2026-11-16T220839-095Z.json`:
  bare consumer loads the OpenCode entry, zero prohibited SDKs, Pi entry
  honestly refused); core-boundary green inside the suite.
- Limits: the matrix's rows 2/3/5/7/12 have no public type — they remain
  runtime-validated adapters and model-free fixtures, documented in the
  matrix. Probe scripts used to pin the evidence live under `test/spike/`
  (`scout-background-probe.mjs`, `permission-probe.mjs`,
  `permission-plugin-only-probe.mjs`, `agent-list-probe.mjs`); they are not
  CI fixtures. No support-range change was made: the documented range stays
  v2.2.3–v2.2.5 until C5/C6 evidence lands.

### C2 — recorded 2026-11-16

- Commit: the C2 commit (fixture entry rework).
- Versions: OpenCode CLI `v2.3.0` and `v2.2.5` (scratch-pinned binary), model
  credentials not used — every check in this slice is model-free.
- `test/integration/opencode-scout.mjs`: entry is now through the supported
  controls only. Before any paid prompt the fixture (1) waits for plugin
  activation (the Fusion and probe commands in `/api/command`), (2) creates a
  control session with `agent: fusion` and asserts the active agent from the
  host's own session record, (3) runs a model-free visibility probe — a
  driver-created session whose context hook captures the fusion agent's real
  tool record and stops before any model request — asserting the **negative**
  gate: with persistent mode off and no active run, the six gated tools are
  hidden, (4) toggles `/fusion-mode on` through the real command API and
  verifies the delivered report ("Fusion persistent mode enabled"), and
  (5) re-probes for the gated visibility the scenarios depend on. Each
  prerequisite lands in the artifact with its evidence; a failed prerequisite
  exits before any prompt is paid for. Scenarios A–D are unchanged in intent
  (persistent-mode scenarios: they call `fusion_scout` directly). The fixture
  now writes `artifacts/opencode-scout-*.json` (`ok`, scenarios,
  prerequisiteChecks) and exits nonzero on failure — validated with a
  deliberate credential failure
  (`artifacts/opencode-scout-2026-11-16T221459-394Z.json`).
- `test/integration/opencode-workflow.mjs`: rewritten from the `opencode run
  --agent fusion` CLI direct prompt (which bypasses the M6.3 mode/run gates)
  to a serve-mode host driven through the command API: model-free driver
  setup (catalog-backed `fusion_configure` before any run), the same
  prerequisite gate (active agent, mode-off negative probe, `/fusion-mode on`
  + delivered report, mode-on positive probe), then `/fusion-run <task>` as
  the paid entry. Completion is observed through the driver's `execute.after`
  evidence (`execute` → `revise` → `final_fix` delegations, one executor
  child, `fusion_reset` completed) instead of CLI JSON events; the artifact
  records turns, usage events, the fixture file, and any failed Fusion call.
  No live run was executed in this slice (C6 scope); the prerequisite
  mechanics themselves were validated model-free on the real 2.3.0 host
  (`test/spike/prereq-mechanics-check.mjs`: mode off shows only the four
  reporting tools, mode on shows all ten).
- `test/integration/opencode-parity.mjs`: audited — already enters through
  `/fusion-run` with the command API and writes a failure artifact with
  exitCode 1; no change needed.
- Native/package fixture reporting: unchanged — they already exit nonzero and
  write `ok:false` artifacts with the failing surface, host version, and
  install identity (re-confirmed against the recorded baseline artifacts).
- Checks: `bun run test:opencode-tool-visibility` passes on **both** hosts
  (2.3.0 and 2.2.5): mode off → gated tools hidden for `fusion`; `build` →
  no Fusion tools at any mode; mode on → all ten Fusion tools for `fusion`.
  Syntax checks for all three audited fixtures pass.
- Limits: the scout and workflow fixtures' paid scenarios are C6 scope;
  their prerequisite gates and artifact paths are validated above.

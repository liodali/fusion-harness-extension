# Run control and observability implementation plan

Date: 2026-11-09. Status: R0 complete (contract adopted by both harnesses'
stop paths); R1 complete (dispatch, `/fusion-stop`, full run scope for both
harnesses, acceptance gates rerun — records below); R2 complete (run time
and cost policies on both harnesses — record below); R3 complete (waiting
and blocked states on both harnesses — record below); R4 complete (guided
recovery on both harnesses — record below); R5 complete (local diagnostics
on both harnesses — record below). All five slices are done.

This follows the multi-harness implementation and the stop/recovery fixes.
The next work makes running work controllable, bounds resource use, and makes
waiting and recovery understandable across Pi and OpenCode.

## Existing baseline

- Both harnesses have the supervisor-facing `fusion_stop` tool. OpenCode also
  has `/fusion-stop` and a TUI button. Pi currently relies on host interruption
  while its supervisor is blocked inside delegation.
- Stop records and pending request identities survive recovery. Interruption
  delivery is distinct from confirmed worker termination.
- Revision, final-fix, scout-call, and scout-tool limits exist. Elapsed-time and
  observed-spend limits for a run do not yet exist.
- Status, usage reporting, workspace ownership, and explicit recovery exist.
  These are the starting points for the new controls.
- The latest reviewed baseline passed 438 tests, typecheck, and Pi loading.
  The live Pi Durable stop integration subsequently passed with a real worker
  and fixture-driven supervisor; see the
  [live integration record](./opencode-install-and-config-plan.md#live-pi-durable-stop-integration-2026-11-08).
  That fixture and its documentation are currently local changes; inspect the
  working tree before implementation and preserve them.

## Order and scope

| Slice | Deliverable | Depends on |
| --- | --- | --- |
| R0 | Shared run-control contract and persistence rules | Existing worker contracts |
| R1 | Direct stop-run command and all owned workers | R0 |
| R2 | Run time and cost policies | R1 |
| R3 | Waiting and blocked-state presentation | R0; integrate R1/R2 reasons |
| R4 | Guided recovery with one recommended next action | R1 and R3 |
| R5 | Installation/configuration diagnostics | R0; reuse R3/R4 reporting |

Implement and review one slice at a time. Preserve existing commands and saved
runs. Keep host APIs, credentials, native UI, and subprocess control in adapters.
Do not introduce additional model calls for monitoring, stopping, or recaps.

## R0 — Shared contract

- [x] Define a run-control interface with owner/run/request identities, stop
  reasons, affected workers, and per-worker interruption delivery/outcome.
- [x] Keep lifecycle, observed activity, and control state separate. A waiting
  permission request, an interruption acknowledgement, or silence does not
  establish completion.
- [x] Define execution observations: starting, implementing, checking,
  waiting-permission, waiting-user, awaiting-reconciliation, unknown. Adapters
  report only what their host can establish; tool activity remains advisory.
- [x] Persist stop intent and configured policies before admitting more work.
  Keep process-local operation promises separate from saved delivery state.
  (Contract and persistence rules defined; the persist-before-admission
  sequencing is enforced when R1/R2 wire the stop paths.)
- [x] Specify additive saved-record compatibility and restoration behavior.
  Legacy records retain their existing behavior; loading never submits work.
- [x] Map existing Pi/OpenCode stop records into the contract before replacing
  duplicated policy. Maintain the public `fusion_stop` tool. (Both harnesses'
  stop paths are untouched; the mappers are additive.)

Acceptance: contract tests cover legacy reads, unknown outcomes, missing host
capabilities, request matching, and restart without resurrecting an old
operation.

Record (2026-11-09): implemented in `src/core/run-control.ts` —
`RunStopIntent`/`StopWorkerState` (identities, reason kinds
operator/policy, per-worker `InterruptionDelivery`
requested/delivered/failed/unsupported/not-submitted and `WorkerTermination`
unconfirmed/ended), `ExecutionObservation` + validator, `RunControlPolicy`
v1 readers (absent = existing behavior; present-but-malformed throws so a
stop or limit is never silently lifted; unknown extra fields preserved for
additive compatibility, mirroring `core/manifest.ts`), legacy mappers
`piStopMarkerToIntent` (abort pending → requested; absent → not-submitted)
and `openCodeStopToIntent` (acknowledged → delivered; confirmed proves
termination only with a terminal outcome), and rules
`stopBlocksAdmission`, `terminationProved` (delivery/acknowledgement/
waiting/silence never terminate), `interruptionRetryable` (a restored
requested/failed delivery is retryable — a saved record is not a live
operation), `stopAppliesToRequest`, `planInterruptionDelivery`
(workerAbort absence → unsupported). Verified: `test/run-control.test.ts`
(27 cases) covering every acceptance clause; full suite 465 pass;
typecheck clean. No host adapter changes, no model calls; `fusion_stop`
unchanged on both harnesses.

Review fixes (2026-11-10, local):

- An absent Pi marker `abort` no longer maps to `not-submitted`
  unconditionally: with a pending request identity (older markers, or a
  crash between the initial marker write and the abort attempt) delivery
  is unknown and maps to retryable `requested`. `not-submitted` requires
  established non-submission (no pending request identity; the
  write-ahead record precedes any submission). The repro (pending
  request plus worker reference → retryable false) fails against the
  previous mapping.
- `readRunStopIntent` rejects worker references owned by a foreign
  owner: harness, supervisor, and workspace must match the enclosing
  intent's owner. A different supervisor or workspace previously passed
  shape validation alone.

## R1 — Direct stop run

- [x] Probe Pi command dispatch during active delegation. Implement `/fusion-stop`
  so it can request cancellation without waiting for the blocked supervisor.
  If command dispatch requires host interruption, integrate that path and verify
  it in the native host before advertising immediate stopping. (Probed and
  verified natively; see the R1 record below. No host interruption needed:
  Pi executes extension commands immediately during streaming.)
- [x] Define stop scope as the current run's executor and active/background
  scouts. Preserve the existing tool/command names and explain their run scope.
  (`fusion_stop`/`fusion-stop`/`fusion-reset` names untouched; both harnesses'
  tool and command descriptions state the full run scope; the OpenCode TUI
  button is "[Stop run]" and dispatches the same command.)
- [x] Track each owned worker and its cancellation source, including workers
  awaiting a child reference. Refuse foreign run/session targets.
  (Per-worker `StopWorkerState` records deliver `awaitingReference` honestly;
  OpenCode scout records key by childSessionID/requestId and adopt published
  references; foreign targets were already refused on both sides.)
- [x] Mark stopping synchronously, suppress nudges, block new submissions, and
  attempt every worker interruption even when another fails or storage stalls.
  (The stop marker precedes all I/O; the scout attempt stands on its own when
  the executor's attempt failed; `sessionStop` gates scout and delegate work
  for the run-less scout-only phase; the scout submit rechecks the marker.)
- [x] Return bounded feedback per worker: requested, delivered, failed,
  unsupported, and confirmed terminal outcome when available. Preserve partial
  edits and ownership until settlement or explicit operator resolution.
  (`describeStopWorker` renders identical per-worker lines; the in-process Pi
  scout may claim confirmed termination; OpenCode scout records confirm from
  the child's terminal event or the already-seen evidence ring.)
- [x] Make repeat stops safe: share live attempts, retry failed or restored
  attempts, and retain any worker with an unresolved outcome.
  (Flights-keyed sharing per worker, `interruptionRetryable` for restored
  records, provided liveness gates keep restored "requested" deliveries honest.)
- [x] Update Pi presentation and OpenCode's existing button/status to use the
  same stop-scope semantics. (`/fusion-stop` command, `fusion_stop` tool, the
  TUI button, and `fusion_status` stop output all report the run scope; the
  contract line wording is shared.)

R1 record (2026-11-10, dispatch probe): static evidence — Pi's
`AgentSession.prompt` handles extension commands before its streaming gate
("execute immediately, even during streaming",
pi-coding-agent `agent-session.js`; the TUI submits streaming input through
`session.prompt`, `interactive-mode.js`; documented for RPC in
`rpc-commands.md`). `/fusion-stop` is implemented on a shared
`stopCurrentRun` path with the `fusion_stop` tool (identical marker, abort,
and persistence semantics) and registered on the Pi surface
(`pi-load` expects it). The probe found and fixed a real gap: a healthy
in-flight delegation was not abortable, because `controller.uncertain` is
set only on resume/error paths and the stop skipped the abort entirely;
`stopCurrentRun` now treats `controller.state.delegating` as interruptible
and aborts the executor handle directly. Native evidence:
`test/integration/pi-stop-command-live.mjs` (opt-in, real RPC host from the
bundled SDK, model-driven supervisor `openrouter/anthropic/claude-sonnet-5`,
executor `zai/glm-5.3-flash`) — artifact
`artifacts/pi-stop-command-live-2026-11-10T004921-*.json` (`ok: true`):
`/fusion-stop` prompt record handled while `fusion_delegate` was unresolved,
abort delivered mid-bash, delegation settled in 1.8s, stop marker saved with
`abort: "delivered"`, no late shell write after the 45s window; executor
usage 7,788 tokens / $0.0011, supervisor ~$0.03. Follow-ups recorded: the
SDK classifies the aborted session turn as `stopReason "error"` with
"The operation was aborted" (same as the 2026-11-08 durable record), so the
settle reports "error" rather than "cancelled" — classify aborted session
turns in R1; `state.delegating` in the Pi extension state is vestigial
(never set — `fusion-resolve`'s busy guard reads it) — clean up in R1.
Environment note: a "medium" supervisor thinking level stalled the model
request in the bundled SDK 1.0.3 host (reproduced across two providers;
default levels worked) — the probe uses defaults; worth an isolated
reproduction before reporting upstream. The interactive TUI editor/Escape
path remains untested by fixtures.

Review fixes (2026-11-10, local, same slice):

- P1 — a stop during executor setup no longer reaches a submission: the
  shared `performDelegation` sequence gained an optional `submissionGate`
  port, invoked between the setup hooks and submission; the Pi port
  rechecks the stop marker and cancels the pending turn with a revision
  refund (submission never began). Resume is exempt — reattaching to the
  original durable submission is the sanctioned recovery path for a
  stopped run. The repro (stop returns during setup, then one executor
  prompt runs) fails against the previous implementation. Coverage:
  controller tests (gate ordering, cancel + refund, exempt-path sequence)
  and a fixture-driven setup-window stop test in the pi controller probe.
- P1 — a stop landing after the gate no longer reaches a submission: the
  stop aborted only the native handle, while the worker runtime was still
  awaiting its per-turn `setThinking` between the gate and `prompt()`; the
  idle handle consumed the abort and execution continued. The stop path
  now also aborts the active delegation's adopted worker via
  `runtime.abort(worker)`, which cancels the turn's own signal — the
  runtime's pre-submission checks (`aborted before submission`) then fire
  and no prompt runs. The repro (stop returns during that await, then one
  executor prompt runs) fails against the previous implementation.
  Coverage: a fixture-driven turn-level `setThinking` park test in the pi
  controller probe (park keyed to the delegation's own setThinking
  sequence; aborted mid-gate, zero prompts, marker and write-ahead intent
  both saved).
- P2 — the live probe's bash acknowledgment is now a structured tool-start
  observation: it matches Fusion's rendered `[tool] bash ...` progress
  entry (produced from the executor's tool_start event) instead of any
  "bash" word in the payload; model prose cannot satisfy the gate.
- P2 — probe diagnostics (`stderrText`, `dialogs`) moved to outer scope so
  a failure before or during initialization reports the original error
  instead of throwing a ReferenceError from the catch; stdin writes are
  guarded against a dead host.

Second review round (same fixes, recorded after nailing down the gate
exemption): the fixture probes park on the delegation's own setThinking
sequence, not absolute call counts, so they stay deterministic across test
runs sharing the mock.

Correction to a recorded follow-up (2026-11-10, R1 run-scope work): the
"vestigial `state.delegating`" note was wrong — the Pi extension's
`FusionState` object IS the controller's lifecycle state (`new
FusionController(state, ...)` shares one object), so `state.delegating`
and `state.executed` are written by `beginDelegation`/the settle path and
both busy guards read live values. No cleanup needed.

R1 run-scope (2026-11-10): stop now covers the whole owned run. Shared
contract adoption: `planWorkerInterruption` decides per-worker attempts
(no unresolved request → "not-submitted"; missing workerAbort →
"unsupported"; else attempt) and `describeStopWorker` renders identical
per-worker lines in Pi and OpenCode; `StopWorkerState` gained
`awaitingReference` so "requested" honestly distinguishes a sent attempt
from a delivery queued behind a missing child reference. Pi: the stop
marker carries a per-worker `workers` list (`readStopMarker` validates
entries additively), `stopFusionRun` interrupts the live scout with the
same bounded, flight-shared, retry-failed semantics as the executor (a
failed executor attempt never suppresses the scout attempt), each worker's
delivery is reported separately (with a confirmed terminal outcome allowed
for the in-process scout), and the `fusion_scout` tool rechecks the stop
marker immediately before submission. A stop landing on the scout-only
phase (no run record exists yet — the record materializes at the first
executor delegation) interrupts the scout and carries the stop in the
session (`state.sessionStop`, gates further scout and delegate work, no
fake persistence). Follow-up fixed: a turn aborted through the runtime's
own signal is classified "cancelled" even when the SDK reports it as
stopReason "error". Coverage: contract tests (scope decision, per-worker
lines), run-stop unit tests (scout scope, partial failure, restored
records, sharing, retries, unsupported), controller-probe fixture (stop
during a parked scout flight: abort observed by the scout session,
terminal-claiming recap, no new work admitted, no record written), and a
worker-runtime classification test with mutation checks both ways.

R1 run-scope (2026-11-10, continued, OpenCode): stop scope covers the run's
active and backgrounded scouts next to the executor. Per-scout records
live on the executor stop record (`ExecutorStop.scouts`, read back
defensively), are interrupted through the runtime with the same bounded
wait as the executor, adopt their published child reference (a queued
delivery becomes sending on the child's execution-started event), and are
confirmed by the same terminal child events; a child left by a previous
plugin instance stays queued honestly (no invented delivery). Read back
identity: `readExecutorStop` keeps returning the live record so stop flows
and bus handlers mutate what is stored. The `fusion_stop` tool, the
`/fusion-stop` command, and the TUI stop button now describe and deliver
the full run scope (executor + scouts); stop feedback renders each worker
separately through the shared `describeStopWorker`. Coverage: plugin
fixtures (live scout child interrupted + confirmed via the bus; queued
delivery completes when the child starts publishing; rechecks before the
scout submission; display), with mutation checks both ways.

Acceptance: executor-only, scout-only, executor plus scout, delayed reference,
foreign owner, partial failure, stalled persistence, repeated stop, restart,
and late events. Native Pi acceptance must stop active delegation from the user
command path; calling a tool concurrently from a fixture is insufficient proof.
Rerun OpenCode native stop/display fixtures and the Pi Durable live fixture.

R1 acceptance record (2026-11-10, run-scope completion):

- Executor-only stop with a restored record and stalled persistence:
  run-stop unit tests (repeat stop, failed-write retry, restored pending
  marker retried after restart).
- Scout-only + executor-and-scout + partial failure + unsupported + stopped
  gates: run-stop unit tests and the pi controller probe fixture (stop during
  a parked scout flight; scout abort observed; per-worker record; no run
  record written for the scout-only scope; refusal of further scout and
  delegate work).
- Delayed child reference (Queued delivery): the opencode plugin fixture —
  a stop lands while the scout child has no published reference, the record
  reads queued ("waiting for its child reference"), and the child's start
  event sends the delivery; the same fixture confirms a live scout child
  through the bus.
- Foreign owner: both harnesses' existing ownership refusals remain in the
  covered gates (opencode plugin fixture "reports foreign interruption
  honestly", Pi ownership gates).
- Stalled persistence + repeated stop: run-stop unit tests (persistTimeoutMs,
  failed write retry) and the opencode plugin fixture "a slow persistence
  write cannot prevent a pre-submission stop".
- Restart recovery: the pi stop-shared-recovery fixture and the run-stop
  restored-record tests; restored stop markers round-trip through the shared
  manifest with the per-worker list validated additively.
- Late events: the already-seen child-terminal ring covers terminal events
  that land before the stop writes its record (native probe evidence).
- Native gates rerun and passing: the Pi command-stop native probe
  (`test:pi-stop-command-live`, artifact `...T212653*`: ok true, all phases,
  stop marker now carries `workers: [{role: "executor", delivery:
  "delivered"}]`); the Pi Durable stop live fixture (`test:pi-durable-stop-live`,
  artifact ...T212824*: abort delivered, shared stop saved, restart guard,
  recovered, no late write; the fixture's `originalTurn` reads the raw SDK
  stopReason "error" while the runtime classifies the own-signal abort as
  "cancelled" downstream); the OpenCode native stop probe
  (`test:opencode-stop-native`, artifact ...T212058*: both phases pass —
  executor child interrupted + confirmed cancelled with retained pending;
  scout child interrupted + record confirmed cancelled from the already-seen
  evidence; refused further scout work; the scout-only run released before
  the executor phase); the OpenCode display fixture (…T212731*: ok true,
  stop button clicked, feedback visible, completed rendering).
- Known-environment failures (not caused by this work): `test:pi-parity`
  aborts on the expired OpenCode Console API key (401 api_key_expired); the
  medium thinking-level model stall from the R1 record remains unreproduced
  upstream; concurrent `fusion_stop` tool + in-flight scout coverage is
  native-only for the OpenCode child path, not for the Pi command path
  (the Pi scout stop ran through the command fixture, which is the
  sanctioned user path; a further live probe for a scout stop consumed
  mid-command was judged redundant — the probe's delegate stop uses the
  same command path already proven natively).

Review round (2026-11-11, run-scope fixes):

- P1 — a queued OpenCode scout delivery now dispatches the moment its child
  reference is published (the adoption in the scout's `onReference` calls
  `interruptQueuedScout` directly); it no longer waits for a later
  execution-start event that may never come. The repro (published
  reference, zero interruptions) fails against the previous
  implementation.
- P2 — interruption attempts report their three outcomes separately in
  both the stop scope and the queued path: a fulfilled abort is
  "acknowledged" delivery, a rejected abort is "failed" with its error,
  and a bounded timeout leaves the delivery as unconfirmed "requested" —
  never an acknowledgement. `stopWait`'s boolean (which conflated
  rejection with timeout) was replaced by `stopInterruptOutcome`; the
  repro (a rejected host interrupt recorded as acknowledged) fails
  against the previous implementation.
- P2 — the Pi runtime preserves a successful native outcome when a
  cancellation races the turn's settlement: the SDK's completion reason
  is "stop" (not "completed"), so the classification now downgrades only
  an aborted signal that the SDK reports as stopReason "error"; "stop"
  (and any other non-error, non-aborted reason) stays completed. The
  repro (a completed result classified cancelled) fails against the
  previous implementation. Coverage: plugin fixtures (rejected interrupt
  → failed record with its error; parked interrupt → requested stays
  requested after the bounded wait; queued delivery acknowledged
  immediately after publication), a worker-runtime test with the real
  "stop" reason under an aborted signal, and mutation checks reverting
  each fix. The native OpenCode stop probe reruns end to end (both
  phases pass).

- P2 — a scout interruption that outlives the stop's bounded wait is now
  tracked as a per-child live flight (in memory only, never the persisted
  record): a repeated stop awaits the in-flight attempt instead of
  starting another interruption, and the attempt's own follower
  classifies the record — delivery, failure with its error, or a
  ring-confirmed terminal — whenever the host interrupt actually
  settles, so a late delivery can no longer leave the record stuck at
  "requested". The repro (two interrupt calls for one scout, then the
  delivery resolved with the status still requested) fails against the
  previous implementation. Both the stop scope and the queued
  publication dispatch funnel through the same flight. Coverage: a
  plugin fixture (stop, repeat stop, single interrupt call, late
  delivery acknowledged) with a mutation check, and the native OpenCode
  stop probe plus the display fixture rerun passing.

## R2 — Run time and cost policies

- [x] Add optional limits for active run time, observed spend, and supported
  provider token ceilings. Defaults preserve existing behavior.
- [x] Define clock semantics: measure active execution; permission/user waits
  are tracked separately and do not consume active execution time. Persist
  accumulated durations; process downtime does not imply worker termination.
- [x] Count supervisor, executor, and scout usage separately and show coverage.
  State explicitly which roles are observable on each host.
- [x] Treat spend thresholds as limits on observed accounting. Stop admitting
  work when reached and request cancellation through R1. In-flight spend can
  exceed a threshold; use hard provider limits only where supported.
- [x] When cost coverage is incomplete, display budget status as unknown. In
  an explicitly enabled spend-limited run, block further submission until the
  user explicitly continues or changes the policy; never treat missing cost
  as zero or silently retry work.
- [x] Make limits configurable before a run and expose current policy,
  consumed amounts, and stop reason through config/status/stats.
- [x] Use event accounting and bounded timers without model polling. Persist
  thresholds and consumed budgets so restart cannot reset them.

Acceptance: exact boundary, crossing mid-turn, late/duplicate readings, missing
cost fields, provider errors, paused clock, restart, and no submission after
exhaustion. Verify no claims of a strict dollar ceiling when readings are delayed.

### R2 record (2026-11-11)

Core (`src/core/budget.ts`, harness-free; boundary-checked by
`test/core-boundary.test.ts`): `RunBudget` persisted record (activeMs,
per-role usage with turnsReported/turnsMissing/fieldTurns coverage,
per-provider token ledgers, one-shot unknownWaiver, dedupe ring),
`readRunBudget` fail-closed (malformed throws; consumed budgets are never
silently reset), `recordRoleUsage` (missing reading = unknown turn, never
zero; dedupeKey suppresses settlement retries and late re-reads; late
readings count normally and can cross a limit after admission),
`ActiveClock` (active excludes paused spans; wall tracks them separately as
waiting), `evaluateRunBudget` (pure admission decision: boundary equality
exhausts; missing/incomplete cost coverage under a spend limit is "unknown"
and blocks until the explicit continue; an unobservable or unattributable
role/provider never feeds the checks and says so), `remainingActiveMs` for
the bounded timer, and `describeRunBudget` with identical host wording.
`formatDuration` moved to `src/core/duration.ts` for the boundary.

Wording rule (tested): blocked/limit messages say "observed accounting,
not a strict ceiling" and "in-flight work may still spend beyond it";
unknown-budget messages say readings are "never treated as zero".

- Pi (`70e80c1`, surface `ce37625`): `/fusion-budget` command (show/set/
  clear/continue; validates through `readRunControlPolicy` before storing;
  run-scoped when a record exists, session-scoped before it). The
  delegation and scout tools refuse budget-blocked submissions; the
  submission gate rechecks after setup and consumes the waiver there
  (advisory checks cannot burn it); resume stays exempt as recovery. Each
  turn's active time is clocked (executor from the submission gate,
  scout around its turn; supervisor turns contribute usage at `agent_end`)
  and recorded per role with provider attribution; the persisted run
  record and its shared-manifest mirror (`legacyPi`) carry policy and
  budget, restored fail-closed, so restart cannot reset them. The bounded
  active-time timer requests cancellation mid-turn through `stopFusionRun`
  with `kind: "policy"` on the marker (additive; `piStopMarkerToIntent`
  maps it). Probe coverage (`test/integration/pi-controller-probe.mjs`):
  exact boundary blocks and raises unblock; missing readings block as
  unknown, continue grants exactly one admission, clearing the limit
  unblocks; the timer's policy stop lands mid-turn with the executor live
  and refuses further work; budgets persist on the run record. Mutation
  checks: removing the submission-gate check, the timer arming, or the
  unknown rule re-fails the corresponding probe test.
- OpenCode (`51a399b`, `2fb6837`): `/fusion-budget` user command only (the
  supervisor's tools read but cannot change limits); the preference is
  stored per location and adopted by fresh runs before any work (scouting
  included); restored runs keep their own policy/budget, read fail-closed
  at `makeRun`. Executor and scout submissions pass the same gate; the
  pre-submission `submissionGate` port rechecks and consumes the waiver.
  `recordUsage` feeds the run budget per role with provider attribution
  (the supervisor is not observable on this host and stats say so); the
  runtime gained an `onUsage` hook firing the attributable in-flight delta
  on verified mid-turn readings (duplicates/stale readings never re-fire),
  and both the usage-event cost check and the active-time timer request
  cancellation through `stopExecutor` with `kind: "policy"` on the stop
  record (additive; `stopFeedback` labels policy stops). The scout claims
  its in-flight slot synchronously so a concurrent reset always sees it
  running. Plugin coverage: mid-turn spend crossing stops the live child
  and refuses further work with the exhausted status and per-role ledger
  in stats/status; unknown-block → one continue admission → blocked again
  → clearing unblocks; the timer's policy stop lands mid-turn; a fresh
  instance restoring the saved record keeps policy, ledger, and policy
  stop (restart cannot reset). Runtime coverage: attributable deltas fire,
  replays/stale readings do not. Mutation checks: disabling the in-flight
  cost check, the timer arming, or the gate re-fails the corresponding
  plugin test.
- Clock pauses: the pause accounting is core-proven (waits do not consume
  active time; wall tracks them). The harnesses measure the turn's active
  span and do not yet observe permission/user waits mid-turn — wiring
  waiting observations into the clock is R3's translation step. Until then
  the recorded active time is an upper bound for turns with waits, and no
  status line claims otherwise.
- Provider-side hard limits: not configured by this extension anywhere;
  ceilings here are observed-accounting only, as the wording states.

Review round (2026-11-14, four findings — all fixed in `bee1fe3`):

- P1 — a waiver can no longer bypass known exhaustion. The evaluation now
  runs in two passes: known exhaustion (observed spend, observed provider
  tokens, accumulated active time — each at or past its limit) blocks
  unconditionally, before the unknown-coverage branches can return; the
  explicit continue waives an unknown budget only. The repro (observed
  spend of $10 against a $1 limit, with a missing reading and a waiver)
  now reads exhausted; reverting to the original order re-fails the test.
- P1 — the Pi scout arms the bounded active-time timer before submission,
  exactly like the executor: a limit elapsing mid-scout requests
  cancellation through the stop path (session stop for the scout-only
  phase, run marker with kind "policy" once a record exists). The repro
  (parked scout still running with a 1ms limit) now aborts the scout and
  refuses further scout work; removing the arm re-fails the test.
- P2 — each turn's active clock commits exactly once on both harnesses:
  the commit returns the elapsed span and the caller records it, instead
  of the commit adding it and the caller adding it again (1000ms persisted
  as 2000ms). Probe and plugin tests park a turn and bound the persisted
  activeMs below 2x; re-adding inside the commit re-fails each.
- P2 — a provider token ceiling no longer blocks a fresh run: no observed
  turns on the ceiling provider means zero observed tokens (the first
  turn starts), while recorded-but-unattributed turns or incomplete
  provider ledgers read as unknown and are waivable by the explicit
  continue (the token-unknown branches now honor the waiver). The
  attributedProviders option was replaced by a persisted
  unattributedTurns counter, so the harness no longer has to declare
  attribution capability — absence of attribution is observed state.
  Coverage: budget tests (fresh-run admits, unattributed → unknown →
  waiver grants one admission, exhaustion precedes waiver across all
  three limits) with mutation checks reverting each fix.

- P1 — Pi no longer drops budget accounting before the first executor
  delegation: the session budget is created on first use, so scout cost,
  missing readings, and elapsed time land in the accounting instead of
  vanishing (the repro — with a $1 limit, a second scout starting after
  the first returned unknown usage — now refuses the second scout as
  unknown, grants exactly one admission on continue, and blocks again).
  The whole session budget (dedupe ring, unattributed turns, waiver
  state) carries into the persisted run record at the first delegation,
  and /fusion-budget continue works in the scout-only phase. Coverage: a
  probe test (second scout refused, continue → one scout, waiver
  consumed, delegation carries budget+policy into the run record) with a
  mutation check reverting the lazy initialization.

- P2 — scout-only budgets no longer survive cleanup: successful
  `/fusion-clean`, `/fusion-mode off`, and starting a new run all reset
  the session budget alongside the other session counters, so a stale
  unknown reading from one task cannot gate the next task's first scout
  (the repro — clean, then a new task whose first scout is blocked —
  now starts on a fresh budget). The budget carried into a run still
  spans that run's whole scout-only phase: startRun clears it, the first
  delegation seeds it. Coverage: two probe tests (cleanup boundary, and
  the un-cleaned new-task boundary) with a mutation check keeping the
  stale budget through cleanup.

## R3 — Waiting and blocked states

- [x] Translate native permission/input requests and worker activity into the
  shared observations. Register and dispose subscriptions with worker lifetime.
- [x] Show current worker, last observed activity, elapsed active/waiting time,
  and the reason attention is needed in each host's existing UI.
- [x] Route executor clarification to the supervisor/user through an explicit
  supported host mechanism. Preserve the pending task while awaiting an answer;
  avoid creating a replacement submission to deliver that answer.
- [x] Label unsupported observation as unknown. An idle timer may flag stale
  activity for inspection; it must not invent a blocked or terminal outcome.

Acceptance: permission allowed/denied, clarification answered/cancelled, long
checks, unsupported events, stale activity, background work, and recovery.
Updates must be bounded and exclude private reasoning and tool-result bodies.

### R3 record (2026-11-15)

Core (`src/core/waiting.ts`, harness-free; boundary-checked by
`test/core-boundary.test.ts`): `WaitKind` permission/user/unknown,
`WaitOutcome`, `OpenWait`/`WaitSpan`, `WaitClock` (one open wait per tracker,
idempotent replays are no-ops, a different id closes the previous span without
an outcome, late closes for unknown ids never fire, bounded 16-span ring;
`markActivity` from host-rendered labels only; `staleAfterMs` advisory flag
computed on inspection — no timers, never an outcome claim; `reset()`
disposes with the worker), `waitLabel` (strips ANSI/control bytes, collapses
whitespace, truncates), `waitAction`/`describeWaitStatus` (shared wording in
both hosts), `openCodeWaitSignal` (bus event translation, below), and
`piUiPromptWait`. Verified: `test/waiting.test.ts` (17 cases).

Host pins (2026-11-15, live OpenCode v2.3.0 serve + binary): bus envelope
`{ id, created?, type, data }` confirmed on `GET /api/event`;
`permission.asked` (`data.id/sessionID/action/resources/message`),
`permission.replied` (`requestID`, `reply: once|always|reject`),
`form.created` (`data.form: { id: frm_*, sessionID, title, fields[] }`),
`form.replied` (`{ id, sessionID, answer }`), `form.cancelled`
(`{ id, sessionID }`), `session.status` (`idle/retry/busy`). `form.replied`
and `form.cancelled` were exercised against the real server (model-free,
`POST /api/session/:id/form`); `permission.*` shapes come from the host
binary's schema (`Permission.Request`, `Permission.Reply`). The translation
reads the older `permission.updated` name and `permissionID` identities
defensively; an unparseable shape is not a wait signal and changes nothing.

- OpenCode: one plugin bus sink (`onWaitBusEvent`, beside the stop sink —
  no per-worker subscriptions to leak) routes signals to owned children
  (executor reference, live scout, or tracked background scout guard). A
  live turn's wait clock pauses `run.turnClock` and disarms the budget
  timer; the close resumes the clock and rearms the timer with the
  still-open active budget (`bound = remaining − clock.active()`), so a
  wait never consumes active time and never grants extra budget. The
  executor's monitor card (`DelegateActivity.wait`, validated additively in
  the activity view; TUI badge `formatWaitBadge`) shows the wait and its
  outcome line ("Answered question: …", "Permission denied: …", "Question
  cancelled: …"). `fusion_status`/`fusion_stats` gained `waiting` (worker,
  observation, last activity, activeMs, waitingMs, wait, stale) and fold
  the shared required-action line into `nextAction`; hosts without the bus
  say waits are not observable instead of guessing. Backgrounded children
  get per-child display clocks (no clock to pause), disposed when the
  child's terminal event proves the turn ended. Clarification: the
  executor agent now pins `question` `allow` (the host's native form tool —
  the answer continues the same child turn; the pending request is
  preserved and no replacement submission is made) and the scout pins
  `question` `deny`; agent definitions and generated Markdown stay in sync.
  Coverage (`test/opencode-plugin.test.ts`, 9 cases): permission allowed
  (clock pauses — flat activeMs while parked; wait closes; committed
  activeMs excludes the span), denied (`reject`), form answered/cancelled
  with the pending request unchanged and exactly one subagent call,
  unsupported events (unknown types, identity-less permission events,
  foreign child terminal) change nothing and the delegation completes,
  stale flag (20ms threshold injection) with advisory wording that never
  claims blocked/terminal, the timer-suspension sequence (110ms active →
  400ms wait → rearmed ~90ms bound → policy stop fires while still parked;
  committed activeMs ≈ pre-wait + short park, the 400ms wait contributed
  none of it), stop during an open wait (stop lands, wait closes, no
  further work), backgrounded child form wait reported without pausing any
  live clock and disposed on the child's terminal event, and restart
  (restored instance reports no wait state). Mutation checks, each re-fail
  verified: wait clocks without the clock target (pause + timer tests
  fail), timer bound without the live-clock subtraction (no policy stop),
  and clocks that never pause (committed activeMs 647ms for a 200ms limit).
- Pi: `pi.on("ui_prompt_start"/"ui_prompt_end")` (Pi SDK pin; the surface
  is now eight event hooks in `test:pi-load`) translate the supervisor
  session's blocking extension prompts — a `confirm` is a permission wait,
  select/input/editor/custom are user waits; the end event carries no
  outcome, so Pi closes waits without one. A run-scoped `WaitClock`
  (module state, disposed on stop/clean/mode-off/agent_settled-non-persistent/
  shutdown) pauses `budgetClock` while a delegation is live; the timer
  rearms on resume with the same corrected bound. The widget gains the
  wait line with the required action; `/fusion-status` reports it and
  states the host capability honestly: executor-child waits and executor
  questions are not observable (executor sessions run without host
  permission gates and have no UI). Executor events and supervisor turn
  ends mark observed activity. `firePolicyTimeStop` is shared by the timer
  and the rearm bound and refuses a stopped run or a turn that is no
  longer live (this also fixed a latent re-arm-after-stop window).
  Coverage (`test/integration/pi-controller-probe.mjs`, 4 cases): wait
  opens/closes with the widget line and required action, the committed
  activeMs excludes the wait span, the same timer-suspension sequence
  (80ms active → 400ms wait → ~70ms rearmed bound → policy stop while
  parked; activeMs excludes the wait), status wording plus the
  unsupported-executor-waits capability note, and prompts outside an
  active run never become run waits. Mutation checks, each re-fail
  verified: bound without the live-clock subtraction (no policy stop) and
  clocks that never pause (committed activeMs 590ms for a 150ms limit).
- Bounded updates: the monitor keeps at most one pending progress update
  (unchanged); wait transitions add one card update each; status/stats
  wait blocks are small fixed-shape objects; labels come only from
  host-provided names (permission action/resources/message, form title +
  first field title, prompt title) through `waitLabel` — never private
  reasoning, tool arguments, or tool-result bodies.

Acceptance notes: permission allowed/denied — OpenCode plugin fixtures;
clarification answered/cancelled — OpenCode form fixtures (the host's
question tool is the explicit supported mechanism; on Pi no executor→user
channel exists and status says so); long checks — activity keeps the
observation at "implementing" and the stale threshold is advisory only;
unsupported events and stale activity — dedicated fixtures on both
harnesses plus core tests asserting the wording never claims blocked or
terminal; background work — a backgrounded child's form wait is reported
without pausing any live clock and is disposed on its terminal event;
recovery — the restored instance reports no wait state while pending
identities and budgets persist, and `session.idle`/`session.status` never
establish termination (the contract's standing rule). The interactive TUI
row rendering is exercised by the existing display fixture path; the
wait badge was added under the same metadata contract. Live model-backed
verification of a real executor `question` call end-to-end remains open
for the parity run (the form/permission event shapes themselves were
verified against the real server and binary).

Environment note (pre-existing, not caused by this slice): this machine's
OpenCode moved to v2.3.0, and the plugin-loading surfaces regressed there —
`test:opencode-native` fails four checks (package plugin loading, agent
contribution, command registration) both with and without R3's changes
(verified by stashing the slice), and a scratch probe shows the Fusion
plugin contributing nothing on v2.3.0 through either install form. The R3
event pins above are real v2.3.0 observations; loading the plugin on v2.3.0
needs the documented re-pin work (supported range stays v2.2.3–v2.2.5 until
that lands). The model-free display fixture still passes natively.

Review round (2026-11-15, three findings — all fixed):

- P1 — supervisor dialogs no longer bypass Pi's executor time limit. The
  run-scoped wait clock was pausing the delegation's active clock and
  disarming its timer for supervisor UI prompts, although the executor
  child continues independently — a 100ms limit no longer stopped a turn
  that had run 220ms past it. The Pi wait clock is now display state only
  (no clock target): a supervisor dialog is reported with its required
  action while the executor's own schedule is untouched. The repro
  (150ms limit, a 400ms dialog) now fires the policy stop on the
  executor's schedule; the display test asserts the recorded active time
  covers the dialog span instead of excluding it. Mutation check:
  re-adding the clock target re-fails the repro.
- P2 — OpenCode no longer loses waits when the turn becomes background
  work. The catch/commit path reset the live wait tracker, so an
  unanswered question or permission request vanished from status and the
  recommended action once the native call returned backgrounded. The turn
  end now transfers every outstanding wait into the child's tracker
  (startedAt preserved), for the backgrounded executor, an unknown
  outcome, and backgrounded scouts; the child's terminal event still
  disposes it. The repro (question asked mid-turn, then backgrounded)
  keeps reporting the wait with the required action. Mutation check:
  disabling the transfer re-fails the repro.
- P2 — overlapping requests no longer overwrite each other. The tracker
  closed the previous wait when a different identity opened, so opening A,
  opening B, and answering B left nothing waiting although A was
  unanswered. `WaitClock` now tracks outstanding waits by identity: a
  second open keeps the first, the clock pauses on the first open and
  resumes only when the last closes, the status reports the oldest
  outstanding wait plus `openWaits`, and the observed waiting time is the
  union of the spans (overlaps never double-count). The card names the
  wait that actually closed (it may not be the one displayed) and then
  shows the oldest one still outstanding. The repro (A open, B open,
  answer B) now reports A with the required action. Mutation check:
  restoring the overwrite-on-open behavior re-fails the identity test.
  The per-turn disposal (`reset()`) also no longer resumes its clock
  target — a dangling resume could only rearm a timer for a turn that is
  over.

- P2 — reconciliation no longer leaves stale waits visible. The
  completion notification can arrive without the child's terminal bus
  event, so nothing disposed the child's transferred wait tracker:
  reconciliation settled the executor while status kept asking the user
  to answer the old question. The reconcile path now releases the
  executor child's waits inside `persistResult` — the point where a
  proven terminal result exists — so a settled child can no longer hold
  an outstanding question or permission request. The repro (question
  opens → child backgrounds → notification without terminal event →
  reconciliation succeeds) now clears the wait with the settlement.
  Mutation check: disabling the release re-fails the repro.

Fixture hardening (same round, no product change): the pre-existing R2
timer fixtures armed 1ms limits, where the timer can fire inside the
window between the submission gate and the native submission — the
runtime's pre-submission abort check then correctly cancels the turn
instead of submitting, which raced the fixtures' completing-turn
assertions under load (reproduced and verified as correct behavior).
Both harnesses' timer fixtures now arm 60ms limits with proportionate
parks, so the mid-turn stop on a live executor is deterministic; the
active-time accounting fixture widened its bounds the same way. The
full suite is green across repeated runs.

Environment note (2026-11-15, not caused by this slice): the machine's
OpenCode host updated from v2.2.5 to v2.3.0 on 2026-11-13, and the
`test:opencode-native` surface fixture now fails four checks (package
agent/command reinstall, Git-install agent contribution and command
registration, active package-plugin load) — reproduced identically with
this slice's changes stashed, so it is a host-version regression in the
plugin-loading surfaces Fusion hand-mirrors, exactly the
"re-pinned and reverifies" boundary `docs/install.md` documents for
releases outside v2.2.3–v2.2.5. A scratch v2.3.0 serve with the Fusion
plugin in both install forms (opencode.json `plugins`,
`.opencode/plugins/`) loaded no fusion agents or commands. Re-pinning the
v2.3.0 plugin surface is its own slice; until then the R3 wait-event pins
stand on the live model-free server probe and the host binary's schema,
and the unit/plugin fixtures (not the host) carry the behavior.

## R4 — Guided recovery

- [x] Derive one recommended next action from ownership, pending identity,
  terminal proof, stop state, and runtime capabilities.
- [x] Show the action and its reason consistently in status/resume and the UI.
  Keep existing resume, reconcile, resolve, and clean operations available.
- [x] Distinguish reattaching/waiting for an existing submission, adopting a
  completed result, and starting another run after cleanup.
- [x] Require explicit operator confirmation when termination cannot be proven.
  Never automate `--confirm-stopped`, delete evidence, or release uncertain work.
- [x] Preserve exact argument quoting and native/package installation paths
  for any displayed operator command.

Acceptance: every recovery disposition on both harnesses, absent completion
notification, foreign coordinator, restart, failed settlement write, and
idempotent repeated actions. Model-free tests must prove no accidental submit.

### R4 record (2026-11-15)

Core (`src/core/guidance.ts`, harness-free; auto-covered by
`test/core-boundary.test.ts`): `RecoveryAction` (wait/reattach/reconcile/
resolve/take-over/start-new/continue/elsewhere) and `RecoveryCategory`
(wait-existing / adopt-result / operator-resolution / another-run /
elsewhere / none — the three recovery kinds stay distinct in every
presentation), `RecoveryFacts` (ownership, owner, pending identity, stop
state with proven-terminal confirmation, terminal proof
none/recorded/awaitable/unprovable, capabilities, inFlight, incomplete,
executed, retainedSettled, and the self-retrying host writes),
`deriveRecoveryGuidance` (pure; documented precedence: ownership first,
then the live transition, then the uncertain-outcome routes BY CAPABILITY —
reattachment when the runtime can reattach to the retained durable request,
reconciliation when exact proof can exist, and only then explicit operator
resolution — followed by protocol incompleteness, a stopped run that owes
no recovery, the self-retrying writes, and the no-recovery protocol steps),
`isRecoveryOwed`, `describeRecoveryGuidance` (shared wording, host tool
names as parameters), and `posixQuote`/`resolveOperatorCommand`/
`resolveCommandEntry` (exact argument quoting; the entry matches the
module's own install form — the checkout script, or the package
`fusion-resolve` bin under node_modules; the command is only ever
displayed). Verified: `test/guidance.test.ts` (29 cases) covering every
disposition, category distinctness, the confirmation-required truth
table, idempotent derivation, missing-fact honesty, and the command
builder's quoting and install forms.

- OpenCode: one shared `runRecovery` derivation feeds `fusion_status`,
  `fusion_resume`, and the activity card, so the surfaces cannot disagree;
  the resume payload's `reconcile` capability now MIRRORS the derived
  action (available ↔ reconcile, busy ↔ wait) instead of being computed
  separately. Status keeps the stop recap as the primary line and gains the
  recovery line beneath it; an open R3 wait still leads. Both payloads gain
  `guidedRecovery` (action, category, reason, confirmationRequired, owed,
  pending). The stop record's confirmed terminal outcome and the runtime's
  recorded-result / awaited-notification evidence feed `terminal` honestly.
  The activity card gains a bounded `recovery` line (validated additively
  in the activity view; a TUI row shows it) set at the turn's terminal
  phases (stopped/uncertain/failed — not for background or settled turns).
  The foreign status/resume payloads route through the same derivation
  (`elsewhere`, with the owning session and the exact resolve fallback).
  Coverage (`test/opencode-plugin.test.ts`): the reworked
  "fusion_resume routes recovery honestly" pins `guidedRecovery` on every
  block (resolve with the command, reconcile before and after a
  notification, continue when nothing is owed); a new test derives one
  action across status AND resume for an incomplete protocol (take-over),
  a failed settlement write (continue + its retry reason, then healed), and
  a foreign coordinator (elsewhere on both surfaces, identical lines,
  idempotent repeats, and a subagent mock that refuses every call); and a
  stop fixture proves the recap keeps the per-worker lines while the
  recovery line rides beneath it (adopt-the-result while the notification
  is awaited; the ring-confirmed cancellation still owes its settlement —
  the stop never overrides an owed recovery — with no further interrupts
  and identical repeated readings).
- Pi: `piRecoveryFacts`/`piRecoveryView` derive from the live run
  (controller pending, uncertain, real backend capabilities via
  `piBackendCaps`/`piStopCapabilities` — the stop path's capability table
  previously hardcoded `activeTurnReattach: false` even for durable; it
  now mirrors `PI_DURABLE_CAPABILITIES`/`PI_SESSION_CAPABILITIES` without
  loading the Durable chain), a retained record (persisted capabilities +
  pending decide the route after a restart), or a foreign record.
  `/fusion-status` gains the `Recovery: …` segment (only when recovery is
  owed or a stop record exists, so a healthy run stays quiet), the widget
  gains the same line, and the stop recap's closing advice is now derived
  instead of static — a durable pending reattachment is named exactly,
  a session-backend stop quotes the resolution command, and a stop with
  no unsettled request says to release it first. The widget refreshes at
  the recovery-fact transitions (delegation end, settlements, explicit
  resolution) so a line never outlives the state it described.
  `/fusion-resume` surfaces the derived action when no run is listable but
  the facts still owe recovery. Coverage (probe, 3 new cases): the
  session-uncertain run derives resolve on status, widget, and the stop
  recap with the exact quoted command (workspace, runId, requestId) and
  zero prompt submissions across repeated readings and explicit resolution;
  the durable-uncertain run derives reattachment on status, widget, and
  stop (retained request named, no command displayed, no submission), keeps
  it after the stop, and a fresh instance derives the same route from the
  persisted record; the foreign coordinator derives elsewhere with the
  owning session and the quoted fallback, submitting nothing.
- Explicit confirmation: `confirmationRequired` is true exactly when the
  route's fallback is an ownership resolution (resolve/reconcile/reattach/
  elsewhere); the displayed command carries `--confirm-stopped` and is
  never executed by anything here; the reset/resolve/clean guards keep
  refusing uncertain and unsettled runs, and resolution still requires the
  operator's own verification (Pi's dialog, the CLI's required flag).
- Failed settlement write: OpenCode's `fusionSettlement` pending state
  derives a `continue` action whose reason is the retry wording (recovery
  still outranks it when owed); Pi has no persisted settlement-pending
  flag — its equivalent disposition is the stop-marker write failure,
  reported in the recap as before, with the recovery line derived from the
  retained record.
- Model-free submit proof: the plugin fixtures' subagent mocks refuse every
  call in the foreign/resolved scenarios, and the probe counts executor
  prompts and durable resume submissions (zero across every guidance
  reading); the derivation itself is pure and performs no I/O.

Native/model-free reruns (2026-11-15): `test:opencode-delegate-display`
ok (model-free, fixtureFeed, stop/completed rendering); `test:opencode-smoke`
ok (v2.3.0 host, registration/run-start/config/refusals, no model
execution); `test:opencode-restart` ok (restored pending, missing-evidence
blocked, zero resubmissions, reconciled); `test:pi-load` ok (surface with
the eight R3 event hooks); `test:ownership-cross-process` ok;
`test:consumer-install` ok (package artifacts). Live model fixtures
(`test:opencode-workflow`, parity) remain opt-in and were not run. The
pre-existing v2.3.0 plugin-loading surface regression (recorded in R3) is
unchanged by this slice.

Review round (2026-11-15, three findings — all fixed):

- P2 — resolution commands no longer depend on the process's current
  directory. `resolveCommandEntry` emitted relative entries
  (`bun src/workspace/resolve.ts`, `./node_modules/.bin/…`) that do not
  exist in a consuming workspace when Fusion loads from another checkout
  or a global plugin cache. It now derives the executable's actual
  installed path from the module's own location — the shared sources ship
  the script at `<package root>/src/workspace/resolve.ts` in every install
  form, so a walk upward from the module file stops at the first ancestor
  carrying it (a location that cannot be stat'ed falls back to the
  structural `src` segment; no layout at all keeps the documented
  relative form as the last resort) — and quotes it, so paths with spaces
  stay single arguments. The repro (a synthetic node_modules module URL
  deriving a relative path) now derives `bun '<abs>/src/workspace/resolve.ts'`;
  reverting to the relative form re-fails the entry test. Coverage: the
  entry unit test walks the real checkout and synthetic package shapes;
  the plugin, probe, and stop-recap fixtures compute the same entry from
  the same module file and assert it exactly; the parity assertion reads
  the location-independent invariant.
- P2 — failed delegations no longer omit the card's recovery guidance.
  The delegation catch derived the card's recovery line before the
  controller marked the turn uncertain and ended the delegation, so the
  uncertain card published no line while status already recommended
  reconciliation. The catch now finalizes the controller facts first
  (failDelegation's uncertainty, the retained/cleared write-ahead intent,
  and endDelegation before the publication) and derives the card line
  from those finalized facts in a bounded finally; the background path
  still publishes before its return so the result metadata carries the
  finished phase. The repro (a subagent call that throws after the child
  reference arrives) now publishes an uncertain card whose recovery line
  equals status's next action for the same facts; deriving before the
  finalization re-fails the test. The card's bound rose to 600 chars so
  the full line — including the quoted fallback command — is never
  truncated into an unusable partial command (the view validates the same
  bound).
- P2 — reconciled cards no longer retain obsolete resolution advice. The
  activity view's matching-reconciliation override replaced phase and
  activity but kept the card's previous recovery line ("adopt the
  completed result…" after the run had settled). The override now clears
  the recovery field; status and resume remain the live surfaces. The
  repro (matching child/request identities) now reads
  `recovery: undefined` on the reconciled card; non-matching
  reconciliations still leave the card untouched; removing the clear
  re-fails the view test.

Mutation checks, each re-fail verified: the relative entry form (guidance
entry test), the pre-finalization card derivation (plugin card
publication test), and the reconciliation clear (activity-view test).

## R5 — Diagnostics

- [x] Add `/fusion-doctor`: loaded Fusion/host versions, mode, registered tools,
  agent availability, configured model availability, backend capabilities,
  ownership storage readiness, and recovery conflicts.
- [x] Make default diagnostics local and read-only, with bounded output and
  actionable errors. Do not dump credentials, environment variables, or prompts.
- [x] Offer an explicit authentication probe separately. Explain whether the
  host can validate credentials locally or a network/model request is required;
  obtain opt-in before a potentially billed request.
- [x] Report installed capability/version mismatches honestly and reuse the
  existing config/catalog validation rather than introducing a second resolver.

Acceptance: expired/missing credentials, missing agent/tool, invalid model,
unavailable Durable backend, inaccessible registry, and older supported hosts.
Default doctor must make zero model calls and leave all run records untouched.

### R5 record (2026-11-15)

Core (`src/core/doctor.ts`, harness-free; auto-covered by
`test/core-boundary.test.ts`): `DoctorFacts` (versions with an optional
declared supported range, mode, tools with a host command-registry
observation, optional agents with a "not applicable" shape for hosts without
named Fusion agents, models with per-fact catalog/auth/policy fields and an
auth-probe capability statement, backend capabilities, ownership storage
state, recovery conflicts plus the shared guidance line),
`buildDoctorReport` (one fixed-order check per surface; every non-ok check
carries a fix), `describeDoctorReport` (bounded: one line per check plus its
fix, the summary first, hidden checks counted), and `describeDoctorAuth`
(the probe's presentation — posture lines plus the host's honest statement
and the never-billed rule). The renderer reads only reviewed fields: a test
attaches a fake credential value to the facts and proves no check line
prints it. Verified: `test/doctor.test.ts` (25 cases).

Version identity (`src/version.ts`, node builtins only, imported by both
entrypoints): `loadedPackageIdentity` walks up from the loading module's own
URL to the nearest package.json carrying a name and version — the checkout
reports `fusion-harness-extension`, the dedicated package `fusion-opencode`,
so the doctor's "Fusion <version>" always reflects what the host actually
loaded. Only positive hits are cached: an intermediate directory without a
manifest must not terminate a later walk from a deeper start (found by the
plugin fixture run; the first walk succeeded and every later one returned
"unknown").

- Pi (`src/index.ts`, command `fusion-doctor [auth]`): the host version is
  the loaded `@earendil-works/pi-coding-agent` package (resolved from the
  extension's own import; unobservable stays "not observable"). Tools are
  observed from `pi.getAllTools()` (falling back honestly to the active set
  when the host exposes no configured-tool list) with the mode gating stated
  (`fusion_delegate`/`fusion_scout` visible when a run is active or Fusion
  mode is on); a tool missing from the host's list fails with the reinstall
  fix. Models reuse `collectModels(ctx)` for catalog membership, the
  registry's own `getError()` for catalog problems, and the selection-policy
  check (`isRecentModel`/`isModelInTier`) as an advisory note; a run's
  persisted executor model is validated against the live catalog too. The
  auth probe reads `hasConfiguredAuth`/`getProviderAuthStatus` (local,
  posture only — source labels, never values) and is attached only for
  `auth`, so the default report stays availability-only. The backend check
  reports the active run's backend or the session's, with the capability
  table from `piStopCapabilities` (the same table the stop path plans from)
  and a durable-availability probe only when durable is configured or
  needed. Ownership uses a new read-only `inspectOwnershipStorage`
  (`src/workspace/ownership.ts`): lstat + the registry's own privacy rules
  (real directory, mode 0700, owned by the user), no creation, and — only
  when owners.sqlite already exists — a `PRAGMA query_only=1` row count, so
  the probe never touches run records and never creates storage. Recovery
  conflicts: uncertain outcome, session-scoped stop, retained pending
  request, stop marker, foreign owner, listed interrupted runs, and — when a
  listed run needs the durable backend — its unavailability, each with the
  R4 shared derivation for the recommended action (a listed-not-attached run
  derives from its translated manifest with the run's own backend
  capabilities, so an unavailable durable backend routes to operator
  resolution instead of a doomed reattachment). On a machine that never ran
  Fusion, the doctor reads the run files directly instead of calling
  `unresolvedRuns`, because that listing opens the ownership registry — the
  default doctor creates nothing (asserted by the probe fixture).
- OpenCode (`src/opencode/index.ts`, command `/fusion-doctor [auth]`): the
  host version reads `ctx.app?.version` defensively (pinned live on
  v2.3.0; absent stays "not observable") and is checked against the
  documented supported range v2.2.3 – v2.2.5, warning with the re-pin fix.
  Tools report the plugin's registrations plus the host command-registry
  observation (`ctx.command.list()`), warning with the restart/versions fix
  when Fusion commands are not listed; the native subagent's presence is the
  backend's availability. Agents reuse `agentReport()` verbatim (observed
  available/conflict/unavailable; contribution produced nothing and the
  legacy-install cases each carry their own fix). Models reuse
  `validateCatalogModel` — the same resolver `/fusion-config` uses, so its
  exact "not in the OpenCode model catalog (known providers: …)" message
  becomes the doctor's detail — and report the supervisor's model as the
  host's own selector. The auth probe states that this host exposes no local
  credential validation to the plugin. Ownership reuses the setup-time
  ownership root; recovery reuses `runRecovery`/`foreignRecovery`/the
  persisted-record derivation so the doctor's action cannot disagree with
  status.
- Both reports render through the shared core, so the two hosts' wording for
  the same state is identical except for the facts.

Acceptance mapping:

- Missing agent/tool — Pi tools check (fixture: a host whose configured-tool
  list omits Fusion's registrations fails with the reinstall fix); OpenCode
  agents check (fixture: contribution captured but never replayed warns
  "registered no agents"; an empty registry list warns "not visible to the
  host").
- Invalid model — both fixtures: a configured model that left the live
  catalog fails with the reused resolver's message and the re-select fix
  (Pi: catalog shrink after configuration; OpenCode: stale saved preference
  against the live catalog).
- Expired/missing credentials — the explicit probe: Pi reports "credentials
  NOT configured" as a models failure with the add-credentials fix; OpenCode
  states the network requirement (a locally expired-but-configured
  credential is not detectable without a request, and the probe says so
  rather than guessing).
- Unavailable Durable backend — the Pi recovery conflict names the
  reattachment need and the backend's unavailability (probe fixture with the
  backend disabled), while a resumed durable run reports its
  `activeTurnReattach, durableExecution` capabilities.
- Inaccessible registry — the probe reports mode/permission/symlink/corrupt
  failures with the 0700 fix; the Pi fixture uses a mode-0755 directory and
  asserts the exact wording.
- Older supported hosts — the OpenCode versions check warns on v2.3.0 with
  the re-pin requirement (live-verified); unobservable versions stay honest
  on both hosts.
- Zero model calls / records untouched — every fixture counts submissions
  and executor executions (zero across every doctor reading; the OpenCode
  fixtures' executor mock refuses every call), and the Pi healthy fixture
  asserts no ownership storage was created. The renderer never prints
  credential values (facts carry posture only; a leaked extra field is
  dropped).

Mutation checks, each re-fail verified: the supported-range comparison
disabled (OpenCode version test fails), the registry-backed listing forced
on (Pi read-only/creation assertion fails), the auth posture attached
outside the probe (Pi probe-separation assertion fails), and the gating
conflated with missing registration (core tools test fails).

Review round (2026-11-15, two P2 findings — both fixed):

- P2 — the ownership probe could modify storage. `inspectOwnershipStorage`
  opened owners.sqlite with a writable connection and relied on
  `PRAGMA query_only=1`, which blocks application writes but not SQLite's
  own crash recovery: with a hot rollback journal present, the first read
  rolled the journal back (modifying database bytes and deleting the
  journal). The probe now opens the connection with `{ readOnly: true }`
  (enforced by SQLite: a recovery attempt fails with
  SQLITE_READONLY_ROLLBACK instead of being applied) and, when a read
  fails with `owners.sqlite-journal` present, reports "interrupted write
  pending crash recovery; recovery requires a writable open, which this
  probe does not perform" — with the writable-open action (any Fusion
  command that opens the registry, e.g. /fusion-status) as the probe's own
  fix, threaded through the doctor facts so the check's fix line names
  recovery instead of the generic directory wording. A stale invalid
  journal (header never synced, zeroed magic — what a process killed
  before its first database write leaves behind) is not hot, reads fine,
  and is not reported as recovery. Reproduction and proof: a hot journal
  crafted byte-wise (synced header + one page-1 record) is applied by a
  writable open (journal deleted) and refused by the read-only probe
  (database bytes and journal bytes both survive untouched); the probe
  test also proves the journal was genuinely hot by letting a writable
  open recover it afterwards. Mutation check: reverting to the writable
  open re-fails the probe test (the journal is consumed).
- P2 — OpenCode reported retained pending work as healthy after a
  restart. The doctor's own-unsettled-record branch (a record this
  session owns with recovery pending or manual, present while no live run
  exists here) derived the recovery guidance but added no conflict, so the
  recovery check could still render "no interrupted runs, pending
  requests, or foreign owners". The branch now adds the retained state as
  a conflict — "the persisted run record retains a pending <action>
  request (<requestId>)" for pending, "owes manual recovery without exact
  request proof" for manual — so the check reads warn with the shared
  guidance line as its fix. Covered by fixtures for both shapes, each
  asserting the healthy wording is absent; the mutation check (conflict
  push removed) re-fails.

Coverage after the round: `bun test` 617 pass, typecheck clean; the
model-free OpenCode v2.3.0 smoke reruns end to end with the read-only
probe (the real registry still reads "1 owned record" through it).

Coverage: `bun test` 612 pass (25 new core + 5 Pi probe + 6 OpenCode plugin
+ 1 Pi-load surface), typecheck clean, `test:pi-load` ok (surface now
includes `fusion-doctor`), `test:opencode-delegate-display`, `test:opencode-restart`,
`test:ownership-cross-process`, `test:consumer-install` ok.

Native evidence (model-free, OpenCode v2.3.0 host via `test:opencode-smoke`,
extended for R5): the real host registers `/fusion-doctor` (in
`/api/command` alongside the other Fusion commands) and the smoke executes
it and the `auth` probe through the real command surface — 8 checks
rendered, `Fusion fusion-harness-extension@0.1.4 | host 2.3.0` with the
supported-range warning, the real host's capabilities reported
(`workerAbort, workerEvents` available), the ownership probe reading a real
registry with a left-over owner from the probe's own earlier phase, and the
recovery check surfacing that foreign record with the shared guided line and
the exactly quoted `--confirm-stopped` resolve command. Zero executor
execution and zero model calls. The smoke's install form now copies
`package.json` so the version check is observable there.

Environment notes: `test:opencode-native` still fails its four pre-existing
v2.3.0 plugin-loading surface checks (recorded in R3/R4, reproduced with the
slice stashed); `test:opencode-package-load` prints ok with no failures but
exits 1, reproduced identically with the slice stashed — both pre-existing
and untouched by R5. Live model fixtures (parity) remain opt-in and were not
run. The auth probe's "configured but expired" honesty: neither host's
local posture proves a credential still works; the probe says a model
request is required for that, and never issues one.

## Completion gate

For each slice, record affected tests, typecheck, host versions, and native
evidence here. Use isolated workspaces for integrations. Live model checks are
opt-in; record measured usage and their exact scope. Do not equate fixture-driven
controls with a model-driven supervisor or terminal acceptance.

Completion requires all five feature slices on both harnesses, documented
capability limits, preservation of recovery/ownership guarantees, updated user
guides, and native command/display checks. Prepare a release only when requested.

Completion record (2026-11-15): all five slices are implemented and recorded
above. R5's native command check ran through the real OpenCode v2.3.0 host
(model-free smoke, doctor + auth probe); Pi's surface check is
`test:pi-load` and its behavior evidence is fixture-driven, so a live
model-backed Pi host verification of `/fusion-doctor` (and the R1–R4 native
Pi cases still open in the R1/R4/M7.3 notes) remains opt-in parity work, as
does the v2.3.0 plugin-loading surface re-pin. Updated guides:
`docs/install.md` (Diagnostics section), `README.md` (command table), and
`docs/opencode-testing.md` (R5 row).

Final acceptance pass (2026-11-16):

- Suite: `bun test` 617 pass / 0 fail (46 files, 2,544 expect calls) and
  typecheck clean — the R5 baseline unchanged. Bun 1.4.4, Node v24.22.1.
- Hosts on this machine: OpenCode v2.3.0 (documented supported range
  v2.2.3–v2.2.5; the loading-surface regression below is unchanged); the Pi
  native evidence runs on the bundled `@earendil-works/pi-coding-agent`
  1.0.3 host (the live fixtures' "bundled SDK cli.js"); the machine's `pi`
  CLI is 1.5.2 and no fixture drives it — the Pi loading check exercises
  the manifest surface, not the binary.
- OpenCode native, model-free (real v2.3.0 serve hosts): smoke ok — 10
  Fusion commands registered and listed in `/api/command`, run
  start/status/reset, catalog-backed configure, recursive worker refusal,
  stats reporting the initial budget with usage unavailable, and the R5
  doctor (8 checks: the v2.3.0 supported-range warning, tools/agents/
  backend/ownership ok, the foreign-owner recovery line with the
  location-derived `bun '<installed resolve.ts>' --confirm-stopped`
  command) plus the auth probe ("never issues a model request"). Stop
  probe ok — executor and scout children interrupted and confirmed
  cancelled, pending retained, reset. Restart fixture ok — restored
  pending, same child, missing-evidence blocked with zero resubmissions,
  reconciled. Display fixture ok — running, stop feedback, and completed
  rows, title, collapsed brief. The known-regressed loading surfaces rerun
  identically: native-surface fails its four recorded v2.3.0 checks;
  package-load prints ok:false ("the fusion plugin is active from a
  non-builtin source") and exits 1.
- OpenCode native, live (opencode-go/glm-5.3-flash): the scout invocation
  budget fixture cannot pass on v2.3.0 — two identical timeouts, diagnosed
  to two layers (`artifacts/opencode-scout-v23-diagnosis.json`): (1) the
  fixture predates the M6.3 mode gate — it prompts the fusion agent with no
  run active and mode off, so all six gated tools are hidden; with
  `/fusion-mode on` through the real command API the tool became visible
  and was called; (2) the v2.3.0 host backgrounds foreground subagent
  jobs, so the scout's native result carries status "running" and
  `native-executor.ts` routes to `settleBackground`, which the scout
  handle has no handler for — the tool reports failure while the child
  answers correctly through the host's own subagent delivery (the scratch
  probe saw the right answers: cantaloupe at notes.md:3, falcon in
  src/app.ts). Both layers are re-pin scope; no product change was made in
  this pass, and the recorded live budget-refusal evidence remains the
  2026-10-30 v2.2.3 run plus the current unit/plugin coverage.
- Pi native: pi-load ok (11 commands including fusion-doctor, 8 hooks,
  discovery-shim parity). The controller probe ran green in an isolated
  directory (40/40): budget boundary/unknown/continue/clear, executor and
  scout timers landing mid-turn, cleanup resetting scout-only budgets,
  waiting widget/status/activeMs exclusion and timer suspension, stop
  gates, and the R5 doctor fixtures (healthy 8-ok report, drifted model,
  missing tool, auth posture, ownership storage problems, interrupted runs
  with durable unavailability). Live stop/recovery rerun:
  pi-stop-command-live ok (all phases; the stop marker carries
  `workers:[{role:"executor",delivery:"delivered"}]`; no late write;
  executor 8,105 tokens / $0.0012; supervisor openai-codex/gpt-6-sol via
  the bundled-SDK host) and pi-durable-stop-live ok (real Durable storage;
  abort delivered; shared stop saved; restart guard; recovered; cleaned;
  no late write; 7,369 tokens / $0.0011). Cross-process ownership ok (Pi
  holds; OpenCode refused by direct path, symlink alias, and nested
  location).
- Packing and clean consumption: `build:opencode-package` regenerates
  dist/fusion-opencode@0.1.4; `npm pack ./dist/fusion-opencode` packs 59
  files (685.9 kB) with `src/workspace/resolve.ts` mode 755 (note: npm
  treats a bare `dist/fusion-opencode` argument as a GitHub shorthand —
  pack the local path form). Root package: consumer-install ok — both
  guided installs (bun and npm with the documented ~1.0.3 override)
  resolve pi-codemode 1.0.4 carrying the released symbol, imports pass,
  and all six shipped assets are present; the unguided rows are recorded
  (bun resolves 1.5.2 and fails the import exactly as documented; npm
  resolves 1.0.4 and passes). clean-install ok — a bare consumer loads the
  OpenCode entry with zero Pi SDKs, the Pi entry is honestly refused, and
  the fusion-resolve bin is present with its shebang and the documented
  usage exit. In a manual clean-workspace check, the plugin tarball
  installs, the fusion-resolve bin link is created and executes directly,
  and the plugin entry imports (id "fusion", setup function).
- Resolve CLI exec-bit review (the tree's only content-free change): the
  bin's `#!/usr/bin/env bun` shebang plus mode 755 is the conventional
  form; it survives npm pack and direct execution works in a consumer.
  Both bun and npm force bin targets executable on install (verified with
  a mode-644 mutant: both installers still land 755 and the bin executes),
  so the tracked bit is not load-bearing for installs — it matters only
  for running the checkout script directly, and the displayed operator
  command always invokes it through `bun`. Keep the change; no fixture
  depends on it either way.
- Remaining limitations (unchanged in substance): the v2.3.0 re-pin
  (loading surfaces, agent-definition conflicts on the manual install
  form, the backgrounded-foreground-job scout disposition, and the scout
  fixture's pre-M6.3 gate shape); the opt-in live workflow/parity runs
  (test:opencode-workflow; test:pi-parity still blocked by the expired
  OpenCode Console API key); live model-backed Pi doctor parity (Pi native
  doctor evidence stays fixture-driven); and the upstream
  missing-notification restart gap.

Follow-up implementation and acceptance are tracked in the
[OpenCode 2.3.0 compatibility plan](./opencode-2.3-compatibility-plan.md).
R0–R5 implementation completion does not establish OpenCode 2.3.0 support;
the follow-up's C1–C6 gates must pass before that support claim changes.

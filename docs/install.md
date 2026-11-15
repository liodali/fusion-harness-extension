# Fusion — install and operating guide

Fusion is a supervisor-executor orchestration extension that runs on two
harnesses with one shared policy core. This guide is the consolidated install
and operating documentation; each claim it makes is pinned by the repository's
own verification (see "Verifying your install" at the end).

## The two entrypoints

`package.json` exposes an explicit `exports` map — import paths a host can
rely on:

| Import | Loads | Consumer |
| --- | --- | --- |
| `fusion-harness-extension` | Pi extension (`src/index.ts`) | Pi hosts |
| `fusion-harness-extension/pi` | same file (alias) | Pi hosts |
| `fusion-harness-extension/opencode` | OpenCode plugin (`src/opencode/index.ts`) | OpenCode hosts |
| `fusion-harness-extension/package.json` | package metadata | tooling |
| `fusion-resolve` (bin) | operator ownership resolution CLI (`src/workspace/resolve.ts`, runs under bun) | operators, package installs |

The import graphs behind the two entrypoints are isolated and statically
pinned (`test/package-isolation.test.ts`): the OpenCode closure contains no
`src/pi/**`, never the Pi extension entry, and has **zero bare package
imports** (only `node:*` builtins); the Pi closure never reaches
`src/opencode/**`.

## Dependencies an install actually pulls

Every `@earendil-works/*` package and `typebox` is declared as an **optional
peer**. Consequences, verified through `test:consumer-install` from fresh
consumer directories (real tarball installs):

- **OpenCode-only install**: installs no Pi SDKs and no Pi Durable. The
  OpenCode plugin imports nothing but Node builtins, so nothing is missing at
  runtime.
- **Pi install**: the host must supply the Pi stack it already runs
  (`@earendil-works/pi-agent-core`, `pi-ai`, `pi-coding-agent`, `pi-durable`,
  `pi-tui`, `typebox`). These are optional peers — the host is responsible
  for them because it *is* the Pi runtime.
- **Compatibility constraint** (read before a fresh Pi-flavored install):
  `@earendil-works/pi-coding-agent@1.0.3` declares
  `@earendil-works/pi-codemode: ^1.0.3`, but its own dist needs symbols
  (`MCP_TYPESCRIPT_PREAMBLE`) that only the 1.0.x codemode line carries.
  Unguided resolution can pick a newer codemode and crash the Pi-side import
  chain. **Constrain it in the consumer's own package.json** — overrides are
  only honored where they are written:
  ```json
  { "overrides": { "@earendil-works/pi-codemode": "~1.0.3" } }
  ```
  `test:consumer-install` asserts this override green on both bun and npm and
  additionally records the unguided outcomes per manager (bun drifts and
  crashes today; npm currently resolves in-window because fusion's optional
  peer participates in its placement). This range gap is an upstream issue;
  if upstream tightens the declared range, the recorded rows turn green
  without any change here.

## Installing for Pi

1. Install `fusion-harness-extension` into the Pi host (or workspace). A Pi host
   resolves the extension from the targets listed in the package manifest's
   `pi.extensions` field — `./src/index.ts`, the extension's default export.
   The package also ships a project-local discovery file,
   `.pi/extensions/fusion.ts`, which re-exports that same extension; both
   forms are pinned by `test:pi-load`, which loads the manifest targets
   exactly as the manifest states them and asserts the shim re-exports the
   same module.
2. Ensure the Pi stack versions are compatible (see the codemode constraint
   above). Development pins validated in this repository:
   `@earendil-works/*` 1.0.3, `typebox` 1.3.27.
3. Point every Pi process that may touch the same workspaces at the same
   ownership directory (below).

Registration surface a Pi host sees — tools: `fusion_delegate`,
`fusion_scout`, `fusion_stop`; commands: `fusion`, `fusion-config`, `fusion-mode`,
`fusion-status`, `fusion-stats`, `fusion-resume`, `fusion-resolve`,
`fusion-clean`; events: `input`, `agent_end`, `agent_before_settle`,
`agent_settled`, `session_start`, `session_shutdown`.

Run state is written under the Pi agent directory (`fusion/runs`), scoped to
the host; the ownership registry is shared across harnesses (below).

## Installing for OpenCode

### Native Git install (Fusion 0.1.1+, OpenCode v2.2.5)

```sh
opencode plugin add 'github:liodali/fusion-harness-extension#v0.1.4'
```

This installs into OpenCode's global plugin configuration. Restart OpenCode
in your workspace, then use `/fusion-config` and `/fusion-run <task>`.
All three agents are registered automatically; no wrapper or Markdown copy
is needed. Remove any previous Fusion wrapper before enabling the package.
The referenced release tag must exist on GitHub. To use the development
branch after these changes are pushed, replace `#v0.1.4` with `#main`.

The Git package preserves its Pi default export and supplies OpenCode through
`exports["./server"]`, which OpenCode v2.2.5 prefers over `exports["."]`.
The model-free native fixture verifies this with Fusion's actual package
assets in a throwaway Git repository, in addition to the Pi load checks.
The dedicated artifact/npm package below remains supported.

There are two supported shapes: the **dedicated `fusion-opencode` package**
(preferred — the plugin contributes its agents itself, nothing to copy) and
the **legacy manual install** (copy the agent Markdown files yourself). Do
not mix them: on OpenCode v2.2.5 a Markdown-defined agent keeps precedence
over the plugin's contribution, so leftover copies silently override the
plugin's definitions. `/fusion-status` reports such conflicts.

### Dedicated package (preferred)

Once the package is published, install it through OpenCode's native plugin
manager:

```sh
opencode plugin add fusion-opencode
```

Until then, use the package built by the **Package OpenCode plugin** workflow
(see below): the `fusion-opencode-<commit>` artifact contains
`fusion-opencode-<version>.tgz`. Install it as your project's plugin:

```sh
sha256sum -c /path/to/extracted-artifact/SHA256SUMS # run from the extracted directory
cd /path/to/your/project
bun add /path/to/extracted-artifact/fusion-opencode-<version>.tgz
```

Then add the plugin to your project's `opencode.json(c)`. **Append to the
existing `plugins` array — do not replace the file**, or you will lose your
configured providers, plugins, and permissions:

```jsonc
// opencode.jsonc — merge into your existing configuration
{
  // ...your existing providers, permissions, and other settings...
  "plugins": [
    // ...your existing plugin entries, if any...
    "./node_modules/fusion-opencode"
  ]
}
```

Only if the project has no configuration file at all:

```sh
printf '{"plugins":["./node_modules/fusion-opencode"]}\n' > opencode.json
```

Restart OpenCode in that project. The plugin registers the `fusion`,
`fusion-executor`, and `fusion-scout` agents natively (no
`.opencode/agents/` copies needed), together with the Fusion tools and
`/fusion-run`, `/fusion-config`, `/fusion-status`, `/fusion-stats`,
`/fusion-resume`, `/fusion-clean`, and `/fusion-mode` commands. The package
has no dependencies — no Pi SDKs and no `@opencode/plugin` SDK — and loading
it through the native `plugins` entry, an empty-agent project, and a full
model-free run lifecycle are covered by `bun run test:opencode-package-load`.

The development version additionally provides `/fusion-stop` and an executor
activity card for OpenCode 2.2.5. They ship in the v0.1.4 release.

### Downloading a GitHub Actions package

Run **Package OpenCode plugin** from the repository's Actions tab (Run
workflow). The workflow also runs for `v*` tags and relevant pull requests.
It checks package isolation and a clean consumer install, verifies the
native host surfaces (`test:opencode-native`), loads the exact dedicated
tarball through the real package loader (`test:opencode-package-load`), and
uploads `fusion-opencode-<commit>` containing both package tarballs
(`fusion-harness-extension` and `fusion-opencode`) plus `SHA256SUMS`.

This workflow uploads build artifacts; it does not publish to npm or create a
GitHub release. `opencode plugin add` accepts Git sources as shown above and
published npm packages; it does not accept the downloaded tarball directly.
The artifact path configures the installed local `node_modules` directory
through `opencode.json` instead.

**Supported versions: OpenCode v2.2.3 – v2.2.5.** The plugin API is
hand-mirrored in `src/opencode/index.ts` — there is no `@opencode-ai`
dependency — so an OpenCode release outside this range must be re-pinned and
its surfaces reverified (plugin tools/commands, `session.execution.*` and
`session.text.ended` events, `session.prompt`, catalog shape) before it can
be declared supported. The R3 wait events (`permission.asked`/`replied`,
`form.created`/`replied`/`cancelled`, `session.status`/`session.idle`) were
pinned live on v2.3.0 and are read defensively (the older
`permission.updated` name and `permissionID` identities are accepted; an
unparseable shape is not a wait signal); on hosts without these events the
waiting status honestly reports that waits are not observable. Native agent
contribution
(`ctx.agent.transform`, update-on-missing semantics, Markdown precedence,
lazy per-location activation) is verified live on v2.2.5 and recorded in
`docs/opencode-install-and-config-plan.md`; on hosts without that surface the
plugin skips contribution silently and the legacy agent files below are
required. This boundary is deliberate honesty, not a bug.

### Legacy manual install (Pi package + copied agents)

1. Install the Pi-shaped package and load the plugin through the `./opencode`
   entry — a project-local discovered plugin that re-exports it:
   ```ts
   // .opencode/plugins/fusion.ts
   export { default } from "fusion-harness-extension/opencode";
   ```
   (The parity fixture uses the equivalent copied-checkout form: it copies
   `src` into the project `.opencode/fusion` and re-exports
   `../fusion/opencode/index.ts` — both shapes load the same entry.)
2. Copy the three agent definitions into the project's `.opencode/agents/`:
   - `fusion.md` — primary supervisor agent; grants subagents only for the
     two Fusion subagents and denies direct subagents otherwise.
   - `fusion-executor.md` — subagent that implements the decided brief and is
     denied every Fusion control except its tool surface. It may use the
     host's native `question` tool to ask the user one clarifying question
     mid-turn; the answer arrives in the same turn (no new submission), and
     Fusion reports the open question in status and the activity card.
   - `fusion-scout.md` — read-only investigation subagent; it cannot ask
     questions.
   The agent files are generated from the same definitions the plugin
   contributes natively (`src/opencode/agents.ts`; regenerate with
   `bun run generate:agent-markdown`, kept in sync by
   `test/opencode-agents.test.ts`) and ship in both packages
   (`node_modules/fusion-harness-extension/examples/opencode/agents/` or
   `node_modules/fusion-opencode/examples/opencode/agents/` in an install;
   `examples/opencode/agents/` in this checkout).
   These are the exact agent files the live parity fixture ran with
   (`opencode-go/glm-5.3-flash`, OpenCode v2.2.5). Other permission
   inheritance shapes remain unverified.
3. **Credentials — gateway models need a credential PAIR.** A serve-mode
   gateway model (e.g. `opencode-go/glm-5.3-flash`) requires two rows in the
   host credential store: the provider API key **and** the opencode account
   credential. A bare provider key is rejected by the workspace policy. This
   is a recorded M6.6 finding from the live parity run.

## Configuration

| Setting | Meaning | Default |
| --- | --- | --- |
| `FUSION_OWNERSHIP_DIR` | Directory of the cross-process workspace-claim registry (SQLite). Must be a private directory owned by the current user (mode 0700), and **the same for every Pi and OpenCode process working on the same workspaces** | `~/.local/state/fusion/ownership` |

Model/variant selection is not an env var: on OpenCode, the `/fusion-config`
command (`/fusion-config` shows the saved preference and syntax;
`/fusion-config list [filter]` lists catalog choices with variants, bounded to
40 lines; `/fusion-config <provider>/<model> [variant]` selects — split on the
first slash so model IDs containing slashes work) and the `fusion_configure`
tool the supervisor can call share one serialized operation that validates
against the live host catalog before mutating anything, persists the
preference across restarts, and applies it to the current run only while no
executor/scout work has started (otherwise it is saved for the next run).
Invalid input changes nothing. On Pi, `fusion-config` is the equivalent
command and accepts the same non-interactive paths, so you are never forced
into the selection dialogs: `/fusion-config` shows the current
configuration; `/fusion-config list [filter]` lists catalog choices with
tier tags (bounded to 40 lines); `/fusion-config supervisor
<provider>/<model> [thinking]` and `/fusion-config executor
<provider>/<model> [thinking]` select directly (split on the first slash so
model IDs containing slashes work; thinking must be one of the model's
supported levels, otherwise the role's default is used; tier rules from the
recent cohort are enforced). `/fusion-config select` runs the original
interactive dialog chain. The executor and the scout share the chosen
model; the supervisor's model stays the host's own selector unless set
explicitly.

### Fusion mode on/off (`/fusion-mode [on | off]`)

`/fusion-mode` toggles. An explicit argument always behaves
deterministically: `/fusion-mode off` disables Fusion (or reports it is
already off) and never opens a dialog; `/fusion-mode on` enables it. With
no models configured yet, a bare `/fusion-mode` runs the interactive
selection chain once; after that it toggles directly. If your selected
supervisor provider has no credentials, the error names the provider —
switch with `/fusion-config supervisor <provider>/<model>`.

### Run time and cost limits (`/fusion-budget`)

Both harnesses accept optional per-run limits, configured through the
`/fusion-budget` user command — the supervisor's tools can read the policy
and consumed amounts but can never raise or clear a limit. Grammar is
identical on both hosts:

| Command | Effect |
| --- | --- |
| `/fusion-budget` | Show the current policy, status, consumed amounts, and coverage |
| `/fusion-budget time 30m` | Ceiling on accumulated active execution (`ms`/`s`/`m`/`h`) |
| `/fusion-budget cost 5` | Ceiling on observed spend (host currency) |
| `/fusion-budget token <provider> <tokens>` | Ceiling on tokens attributed to that provider |
| `/fusion-budget clear time\|cost\|token <provider>\|all` | Remove limits |
| `/fusion-budget continue` | Grant exactly one admission past an unknown budget |

Without an active run the limits apply to the next run (OpenCode persists the
preference per location; Pi keeps it for the session); with an active run
they apply to that run immediately — raising or clearing a limit mid-run is
the explicit way to unblock an exhausted run. Defaults preserve the existing
unlimited behavior.

These are limits on **observed accounting**, never strict dollar ceilings:
usage readings arrive at turn settlement (Pi) or with per-child usage events
(OpenCode), so in-flight work can spend past a threshold. Missing readings
stay unknown, never zero: a spend-limited run whose cost coverage is
incomplete blocks submissions with status `unknown` until you run
`/fusion-budget continue` (one admission) or change the policy. On OpenCode
the supervisor's own usage is not observable — status/stats state that, and
limits apply to what the executor and scout report. When a limit is reached,
further executor and scout submissions are refused, and in-flight work is
interrupted through the run's stop path with a policy stop reason
(`fusion_stop`/`/fusion-stop` machinery; no additional model calls). The
accumulated active time and per-role usage (supervisor, executor, scout)
persist with the run record, so a restart cannot reset spent budgets; active
time excludes permission/user waits, which are tracked separately.

## Waiting and blocked states (R3)

While a run is active, both harnesses report what a worker is waiting on
instead of guessing. A **confirmed wait** is a wait the host explicitly
opened for a worker's own execution; a confirmed worker wait pauses that
worker's active clock, so waiting time never consumes active execution time
(and the bounded active-time timer rearms on resume rather than firing while
the worker is not executing). Waits that belong to the supervisor session
rather than a worker are display state only and never pause a worker's
clock — a supervisor dialog cannot extend or bypass a worker's time limit.

- **OpenCode**: `permission.asked`/`permission.replied` and
  `form.created`/`form.replied`/`form.cancelled` events for owned children
  (pinned live on v2.3.0; older hosts' `permission.updated` shapes are read
  defensively). Several concurrent requests are tracked by identity: the
  status reports the oldest one still outstanding and the clock stays
  paused until the last one closes. If the turn becomes background work,
  outstanding waits transfer to the child's tracker so they stay visible
  until the child's turn really ends. The executor's activity card shows
  the open wait with the required action; `fusion_status`/`fusion_stats`
  report the current worker, last observed activity, active/waiting
  durations, and the required action. The executor's clarification channel
  is the host's native `question` tool (a form in the child session): the
  user's answer reaches the same pending turn — Fusion never creates a
  replacement submission to deliver it.
- **Pi**: the supervisor session's blocking extension UI prompts
  (`ui_prompt_start`/`ui_prompt_end`) are the observable user-input waits
  while a run is active; the widget shows the wait with the required action
  and `/fusion-status` reports it. These are supervisor-session waits, not
  worker waits: they never pause the executor's clock or its time-limit
  timer. Executor-child waits and executor questions are **not observable
  on this host** (executor sessions run without host permission gates and
  have no UI); status says so instead of inventing a wait.

Unrecognized events change nothing: they never invent a blocked or terminal
outcome. A turn with no observed activity for a while (five minutes) is
flagged as stale for inspection — an advisory note that never claims the
worker is blocked or ended. Wait observation is process-local: a restart
reports no wait state until events recur; the pending request identity and
the run's budgets are unaffected.

## Operating

OpenCode (user-facing commands): `fusion-run` — starts a run,
`fusion-mode` — persistent mode gate, `fusion-status`, `fusion-stats`,
`fusion-resume`, `fusion-clean`. The supervisor calls `fusion_reset` itself
at summary time unless the task says otherwise.

In the development version, use `/fusion-stop`, click **Stop executor** in the
activity card, or ask the Fusion supervisor to stop its executor. The stop
request targets the current supervisor's child and reports the last observed
tool activity without an extra model call. An acknowledged request is not
proof of termination. Partial changes remain in the working tree; check
`/fusion-status` and `/fusion-resume`, inspect the changes, and follow the
reconciliation or operator-resolution instructions before cleanup. Background
activity may be unavailable until a completion notification is reconciled.

On Pi, asking the supervisor to stop calls the `fusion_stop` tool: it aborts
a live executor conversation (durable or session backend), marks the run
stopped so further executor and scout work is refused, and returns a
deterministic recap — last observed activity, pending request, abort
delivery, and the `/fusion-resume` / `/fusion-resolve` / `/fusion-clean`
recovery path. No model summarizes the stop.

Pi: the `fusion` command starts a run; `fusion-status` / `fusion-stats` /
`fusion-resume` / `fusion-clean` mirror the OpenCode controls;
`fusion-resolve` runs operator resolution (below).

Persistent mode keeps the `fusion` agent and Fusion tools available between
runs. A persistent-mode run settles to `runActive: true` with
`phase: "complete"` and is releasable by `fusion-clean`; an unfinished run is
refused. Treat both active values when inspecting state.

`fusion-stats` reports real worker token/cost totals from observed
`session.usage.updated` deltas, aggregated per turn and persisted across
reload. Turns whose readings are missing are counted, not guessed — the
summary is `complete: false` until every reporting turn is covered, and the
summable fields (`inputTokens`, `outputTokens`, `cacheReadTokens`,
`cacheWriteTokens`, `reasoningTokens`, `cost`) each track
per-field turn coverage (`fieldTurns`).

Every run completes with a final message carrying the heading
`## Fusion summary`.

## Recovery: what is automatic, what needs an operator, what is blocked

**Automatic** (unit-pinned and live-observed): pending-turn semantics with
settle/uncertain transitions on submission failures; bounded settle nudges
(event-time cancellation is unconditional on interrupts/failures); stale-run
detection across reload; early-settlement prevention so a supervisor cannot
prematurely finish a delegation sequence.

**Guided recovery (one recommended action).** `fusion_status` and
`fusion_resume` (and Pi's `/fusion-status` and the widget, and the OpenCode
activity card) derive one recommended next action from shared facts —
workspace ownership, the retained request identity, terminal evidence, the
stop state, and the runtime's real capabilities — and show the action with
its reason consistently on every surface. The recovery kinds stay
distinguishable:

- **Waiting for an existing submission** (`wait-existing`): an executor
  transition is in flight, or the retained durable request reattaches. A
  durable turn is recovered by waiting for the original submission
  (OpenCode exposes this through `fusion_resume`'s presentation; Pi through
  `/fusion-resume` and `fusion_delegate` action `resume`) — never by
  starting new work. A stop does not change this: a stopped run's durable
  turn still reattaches.
- **Adopting a completed result** (`adopt-result`): when exact completion
  proof can exist — an exact recorded result in the session, or the
  completion notification the coordinator still awaits — the presentation
  directs `fusion_reconcile`, with explicit operator resolution quoted as
  the fallback when no notification can exist.
- **Explicit operator resolution** (`operator-resolution`): when no exact
  completion proof can be adopted, the presentation says so and quotes the
  resolution command. Releasing uncertain work always requires the
  operator's explicit confirmation that the worker stopped; nothing here
  automates `--confirm-stopped`, deletes evidence, or releases uncertain
  work.
- **Starting another run** (`another-run`): after a run settles (or a
  stopped run with no unsettled request), the presentation says to release
  the run first and then start another.

Status and resume carry the derived action as `guidedRecovery`
(`action`, `category`, `reason`, `confirmationRequired`, `owed`, and the
pending identity when one is retained); their `nextAction` line renders the
same action with host tool names.

**Operator resolution command.** The presentation quotes the executable's
actual installed path, derived from the Fusion module's own location — the
shared sources ship the script at `<package root>/src/workspace/resolve.ts`
in every install form, so the quoted path is absolute and independent of
the directory the operator runs it from:

```
bun '<installed>/src/workspace/resolve.ts' <workspace> <run-id> <request-id|--no-request-id> --confirm-stopped
```

The package `fusion-resolve` bin remains a documented alternative for
package installs (run from the project root, same arguments):

```
./node_modules/.bin/fusion-resolve <workspace> <run-id> <request-id|--no-request-id> --confirm-stopped
bunx --bun fusion-resolve <workspace> <run-id> <request-id|--no-request-id> --confirm-stopped
```

(The bin has a `#!/usr/bin/env bun` shebang, so the TypeScript executes
under bun in both forms.) Every argument is POSIX-quoted by the
presentation exactly as it should be typed; request ids carry spaces, so
the raw form would fail `resolve.ts` argument validation. The command is
only ever displayed — running it, and confirming the worker stopped, is the
operator's action.

**Blocked upstream (not fixable in this repository).** Recovery from a
restart that lost the completion notification depends on parental-completion
delivery after restart — tracked upstream as anomalyco/opencode#36349. The
related parent-completion stall (a supervisor turn left open after its
executor child finished) reproduces live and is recovered by the parity
fixture via interrupt → `fusion-clean` → reissue. Re-run the opt-in fixtures
after any upstream restart-delivery change.

## Verifying your install

Model-free (always safe to run):

| Check | Command |
| --- | --- |
| Full unit + probe suites (both harnesses, real-SDK durable probes) | `bun test` |
| Types | `bun run typecheck` |
| OpenCode registration/catalog/configure/run-start smoke (v2.2.x host) | `bun run test:opencode-smoke` |
| Pi extension install-shim load | `bun run test:pi-load` |
| Native agent/command surfaces, reload, and isolated package-manager removal/reinstall (OpenCode v2.2.5) | `bun run test:opencode-native` |
| Actual per-turn Fusion tool visibility with mode off/on and Build → Fusion switching, aborted before model requests | `bun run test:opencode-tool-visibility` |
| Dedicated package load, configuration persistence across restart, recovery CLI, and legacy-agent coexistence | `bun run test:opencode-package-load` |
| Real cross-process workspace-claim hold | `bun run test:ownership-cross-process` |
| Dependency contract (entrypoints, closure isolation, consumer pins) | `bun test test/package-isolation.test.ts` |
| Clean-install smoke (local tarball, model-free, registry-free): bare consumer installs no Pi SDK, loads `./opencode`, Pi entry honestly refused | `bun run test:clean-install` |
| Parse-only syntax gate (Bun-native, replaces `node --check`) | `bun run test:syntax` |

To verify one dedicated artifact throughout acceptance, build and pack it once:

```sh
bun run build:opencode-package
npm pack ./dist/fusion-opencode --pack-destination dist
export FUSION_OPENCODE_TARBALL="$PWD/dist/fusion-opencode-$(bun -p 'require("./package.json").version').tgz"
bun run test:opencode-package-load
```

Keep that variable set for `bun run test:opencode-parity` below. Both reports
record its SHA-256, so the model-free and live results can be matched to the
same tarball. Parity uses existing provider credentials in an isolated test
workspace and consumes model usage. The native package-manager fixture uses
a throwaway Git probe package and a snapshot of Fusion's real dual-harness
package; neither check changes your global OpenCode configuration.

Network/opt-in (consumes something — registry or model usage):

| Check | Command |
| --- | --- |
| Fresh-consumer dependency contract (real installs; asserts consumer override on bun+npm) | `bun run test:consumer-install` |
| Full OpenCode parity workflow live (`opencode-go/glm-5.3-flash`, two runs) | `bun run test:opencode-parity` |
| Full Pi acceptance workflow live (real Pi SDK executor/scout sessions; supervisor fixture-driven — real-worker integration, not native supervisor acceptance; `--model zai/glm-5.3-flash`, `--supervisor opencode-go/gemini-4-argon` defaults) | `bun run test:pi-parity` |
| Pi Durable live stop, restart, and recovery (one real worker; fixture-driven supervisor) | `FUSION_PI_STOP_LIVE=1 FUSION_PI_STOP_MODEL=zai/glm-5.3-flash bun run test:pi-durable-stop-live` |
| Pi native `/fusion-stop` dispatch during active delegation (real RPC host, model-driven supervisor and executor) | `FUSION_PI_CMD_STOP_LIVE=1 [FUSION_PI_CMD_STOP_SUPERVISOR=openrouter/anthropic/claude-sonnet-5] [FUSION_PI_CMD_STOP_MODEL=zai/glm-5.3-flash] bun run test:pi-stop-command-live` |

The command-stop fixture drives a real Pi host in RPC mode with the real
extension loaded: a model-driven supervisor calls `fusion_delegate`, a real
executor runs a long bash turn, and the `/fusion-stop` user command is
dispatched mid-flight through a plain prompt record — the documented input
path. It proves dispatch-during-streaming (`disposition: "handled"` while
the delegation is unresolved), abort delivery, settlement, the saved stop
marker, and no late writes from the aborted shell. It does not exercise the
interactive TUI editor or Escape handling.

The Durable stop fixture uses an isolated workspace and copies Pi credentials
into a temporary agent directory. It observes a real bash invocation, restores
that submission's pending identity into Fusion, invokes the registered
`fusion_stop`, checks both stop records, restarts, recovers the original result,
and releases ownership. It waits beyond the delayed command's intended write
time to detect a surviving shell. The fixture and Fusion share one real Durable
backend; it does not exercise a model-driven supervisor or the Pi terminal UI.

### Integration artifacts

If the supervisor says Fusion tools are unavailable, stop the turn and run
`/fusion-config` in that same session. Versions 0.1.3 and later show
the instance's loaded mode and the Fusion tools left by its last context
hook. This is diagnostic evidence, not a live model turn or a claim about
later filters from other plugins. With mode on, a Fusion turn should include
`fusion_start`, `fusion_scout`, and `fusion_delegate`; Build should receive
no Fusion tools. Earlier rejected Build calls do not establish current Fusion
tool availability. The native visibility fixture checks these states without
credentials, model requests, or project edits.

Every integration fixture writes a **sanitized artifact** to `artifacts/`
under the repository root (local-only, gitignored; override with
`FUSION_ARTIFACT_DIR`): `test:clean-install`, `test:consumer-install`,
`test:opencode-parity`, and `test:pi-parity` each emit
`artifacts/<fixture>-<timestamp>.json` on success and failure. Artifacts use
one schema (`fusion-integration-artifact/1`) and carry the fixture name,
generation time, tool versions (bun/node; manager versions for consumer
installs; `pi-coding-agent` for Pi runs; the OpenCode host version for
parity runs), the model(s) used, run/request/child identities, the scoped
assertions, and the outcomes. Sanitization: absolute user and temp paths are
reduced to markers, the parity fixtures redact credential material before
writing, and artifacts never contain transcript bodies or prompt text.

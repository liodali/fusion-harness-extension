# OpenCode host contract matrix (2.2.5 ↔ 2.3.0)

Date: 2026-11-16. Scope: the host contracts Fusion's OpenCode adapter depends
on, pinned for the 2.3.0 compatibility plan
(`docs/opencode-2.3-compatibility-plan.md`, slice C1). Each contract names the
official type in `@opencode/plugin` (the supported package) or recorded host
evidence, and states the 2.2.5/2.3.0 difference explicitly. Evidence sources:

- Official declarations: `@opencode/plugin@2.2.5` and `@opencode/plugin@2.3.0`
  (`dist/promise/*.d.ts`), plus `@opencode/schema@2.3.0` for raw shapes.
- Observed host evidence: model-free fixtures on the pinned binaries
  (`opencode v2.2.5`, `opencode v2.3.0`) recorded under `artifacts/`, and the
  probe sessions summarized per row.

The development dependency is pinned to `@opencode/plugin@2.3.0`; the official
server types are identical for every surface Fusion uses, so typechecking
against them covers the 2.2.5 baseline as well.

| # | Contract | Official type / observed evidence | 2.2.5 | 2.3.0 |
| --- | --- | --- | --- | --- |
| 1 | Plugin discovery and export shape | `Plugin.Plugin` (`dist/promise/plugin.d.ts`, identical in both versions): `{ id: string; setup(context): Promise<Cleanup \| void> }`. Discovery resolves the package export — Fusion ships `./server` → `src/opencode/index.ts` and `./tui` → `src/opencode/tui.ts`. Live evidence (2.3.0, `test:opencode-native` phase B/C reproduction): a Git-installed package whose root export throws is skipped when `./server` is present; the probe package loaded `./server`, and Fusion loaded and contributed through both `opencode plugin add` (git source) and a project `plugins` entry. | Server export loaded from package installs and project config. | Unchanged. `/api/plugin` additionally reports `features.tui: true` for plugins that ship a TUI slot (observed 2026-11-16). |
| 2 | Plugin activation timing | No official type. Live evidence (2.3.0): activation is lazy per location — the first API request for a location triggers `setup`, and agent/command contributions land **asynchronously after** the triggering response (artifacts `opencode-native-surface-2026-11-16T085210-207Z.json` failures 1–4 reproduce when fixtures read once; bounded polling shows all contributions arrive). | Same lazy activation; single-shot fixture reads happened to observe settled registries. | Contribution completion lags the first `/api/agent` response by a bounded interval; single-shot reads are not contract-observant. Fixtures must poll for activation (C3 fix; product unchanged). |
| 3 | Registry source/status envelopes (`/api/plugin`) | No official type for the HTTP envelope. Live evidence (2.3.0): installed package plugin → `{ id, source: { type: "package", target: "git+file://…", version: "<git sha>" }, features: { server, tui }, state: { status: "active" } }`; project-config path plugin → `source: { type: "local", path }`; builtins → `source: { type: "builtin" }`. `test:opencode-package-load` on 2.3.0 failed only because its read raced activation (row 2), not because the envelope changed. | Same envelope (`source.type` `package`/`local`/`builtin`, `state.status` `active`). | Unchanged shape. The `features.tui` flag is additive. |
| 4 | Agent editor | Official `AgentEditor` (`dist/promise/agent.d.ts`, identical both versions): `list/get/default/update/remove` — no `add`; `update` on a missing ID creates the agent from an `Agent.Info.default` draft (`mode` starts `primary`, observed). `Agent.Info` from `@opencode/schema/agent`: `system` is the prompt; there is no `prompt` field. | Pinned live on 2.2.5 (fixture phase A passes unchanged). | Unchanged. |
| 5 | Agent registry merge and permission precedence | No official type; host-observed. Merged registry view (via `ctx.agent.list()` and `/api/agent`, identical on **both** hosts): for an agent defined by a Markdown file and updated by the plugin, identical rules are **concatenated** (duplicated), and the host appends default deny rules `{action:"browser",resource:"*",effect:"deny"}` and `{action:"skill",resource:"browser",effect:"deny"}`. Markdown-defined agents stay authoritative over plugin `update`s (phase A). Consequence: the plugin's permission comparison must be semantic (dedupe + ignore pinned host defaults), or equivalent shipped definitions are reported as conflicts (C3 fix; behavior identical on both hosts — the recorded 2.3.0 diagnosis overstated this as a host regression). | Concatenation + the same two host default rules observed live. | Unchanged. |
| 6 | Tool context and progress | Official `ToolContext` (`dist/promise/tool.d.ts`): 2.2.5 = `Omit<Tool.Context, "progress">` + `{ signal: AbortSignal; progress: (update: Tool.Metadata) => Promise<void> }`; 2.3.0 = `Omit<Tool.Context, "progress" \| "cancel">` + the same members, with `signal` now documented as the **cooperative-stop opt-in** ("Reading it … opts the tool into a cooperative stop: on the user's stop the signal aborts and whatever the tool then returns or throws is still reported as the call's result"). Raw `Tool.Context` (`@opencode/schema/tool`): `sessionID`, `agent`, `messageID`, `id`, `progress`, optional `cancel` (Effect). Fusion's `NativeToolContext` mirror (`src/opencode/native-executor.ts`) keeps `sessionID`/`signal`/`progress` and adapters add `agent`; `fusion_scout` and Fusion tools read the signal, so they already opt into cooperative stop on 2.3.0. | `execute.before` hook event: `{ tool, sessionID, agent, messageID, id, input }` (official `ToolHooks`). | Same members; the `signal` documentation changes from plain abort to cooperative stop (behavior Fusion already relies on for stop-during-scout). |
| 7 | Native subagent results (foreground vs backgrounded) | No official type; host-observed. Native `execute` resolves `{ output: { sessionID, status: "completed" \| "running", output } }` (Fusion's `NativeSubagentOutput` mirror). | Foreground calls complete in the foreground (pinned by the M5 live pass on 2.2.3–2.2.5); `status: "running"` occurs only when the host explicitly backgrounds a job. | **Breaking change:** a foreground subagent call is backgrounded — the resolved result carries `status: "running"` and `output: "pending"` (live-captured 2026-11-16, both executor and scout children; the restart fixture's simulation matches). Completion proof arrives later as the notification of row 11. Fusion's executor path already handles this (`backgroundPending` → `fusion_reconcile`); the scout path needed the C4 bounded adoption. |
| 8 | Events and forms | Official `EventDomain.subscribe(options?: SubscribeOptions) → AsyncIterable<SelectedEvent<OpenCodeEvent>>` (`dist/promise/event.d.ts`, identical both versions). Pinned live (2.2.2/2.2.3, re-verified in fixtures): terminal turns arrive as `session.execution.succeeded \| interrupted \| failed` with `data.sessionID`; wait surfaces (`session.permission.updated`, `session.form.*`, usage updates) route by `data.sessionID`. 2.3.0 `session.d.ts` adds hooks/events `fork` and `experimental.model.resolve`, and `SessionRequestMessage` (message `metadata` readable in `session.context` results) — none change Fusion's consumption. | Options-object subscribe, lazy async iterable. | Unchanged for the events Fusion consumes; additive hooks only. |
| 9 | Interruption | Official `SessionDomain` includes `interrupt` (both versions): `ctx.session.interrupt({ sessionID, resume? })`. Fusion surfaces it through the runtime's `abort` (`capabilities.workerAbort` only when present). Live evidence: native scout/executor children report `outcome: "interrupted"` (`test:opencode-stop-native` passes on 2.3.0). | Same. | Unchanged. |
| 10 | Command delivery | Official `CommandDomain`: `CommandEditor.add({ name, description?, execute: (input: CommandInvocation) => Promise<void> })` with `CommandInvocation = { sessionID, prompt: PromptInput.Prompt, delivery: SessionInbox.Delivery }` (identical both versions). Return value is presentation-only; reports are delivered through `ctx.session.synthetic` (2.2.5 renders synthetic `description` in the TUI — kept). The command API (`POST /api/session/:id/command`, 204) is the supported model-free delivery surface. | Same. | Unchanged. |
| 11 | Model catalog entries | Official `ModelDomain` (`dist/promise/model.d.ts`, identical both versions) + live pinning (2.2.3): `ctx.model.list()` resolves `{ location, data: Model[] }` with the flat catalog; Fusion reads `providerID`, `id`/`modelID`, `enabled`, `cost[]`, `variants` (`HostModel` mirror in `src/opencode/index.ts`). `@opencode/schema/model` `Model.Info` is the official shape. | Same. | Unchanged. |
| 12 | Subagent completion notifications | No official type; host-observed and reused as the completion-evidence mechanism. A finished child lands in the **parent** session's `ctx.session.context({ sessionID })` as a synthetic message `{ type: "synthetic", description, metadata: { source: "subagent", childID, agent, state: "completed" \| "error" \| "cancelled" }, text: "<subagent sessionID=\"…\" state=\"…\" description=\"…\">\\n…\\n</subagent>" }`. `agent` is the child's agent (`fusion-executor` — pinned via the restart fixture; `fusion-scout` — live-captured 2026-11-16 on 2.3.0). | Same mechanism (executor reconciliation already depends on it). | Unchanged shape; on 2.3.0 it is the *only* completion proof because foreground calls background (row 7). |

## Contracts with no public type (documented limitation)

Rows 2, 3, 5, 7, 11 (HTTP envelopes and merge behavior) and 12 (notification
shape) have no exported type in `@opencode/plugin`. Fusion keeps narrow
structural mirrors with runtime validation for them:

- `NativeSubagentOutput` and the notification matcher in `src/opencode/`
  (row 7/12) — validated by `test/opencode-native-executor.test.ts`,
  `test/opencode-worker-runtime.test.ts`, and the model-free native fixtures.
- The permission comparison (`src/opencode/agents.ts`) pins the observed host
  default rule set; it is version-dependent parsing kept in `src/opencode/`
  (row 5).
- `/api/plugin` and `/api/agent` consumers stay in the model-free fixtures
  (rows 2/3), never in shared orchestration.

## 2.3.0 behavioral deltas Fusion must absorb (summary)

1. **Foreground subagent calls background** (row 7): every native
   `fusion_delegate`/`fusion_scout` submission may resolve `status: "running"`.
   Executor work already adopts this through `fusion_reconcile`; scout work is
   the C4 slice (bounded wait for the row-12 notification, pending/unknown
   disposition at the deadline, never a resubmission).
2. **Lazy-activation lag** (row 2): fixtures (not the product) must wait for
   contributions before asserting registry state.
3. **Registry rule concatenation** (row 5): the plugin's permission comparison
   must be semantic on both hosts; shipped-equivalent definitions agree, real
   overrides stay visible.
4. **Cooperative stop documentation** (row 6): Fusion tools reading the tool
   signal keep their stop behavior; on 2.3.0 a stopped tool call may return its
   disposition as the call's result instead of being interrupted — the C4
   pending disposition is designed to be returned exactly this way.

No other deltas affect Fusion's contracts. The plugin/TUI declaration files are
byte-identical between `@opencode/plugin` 2.2.5 and 2.3.0 except
`promise/tool.d.ts` (row 6) and `promise/session.d.ts` (row 8, additive).

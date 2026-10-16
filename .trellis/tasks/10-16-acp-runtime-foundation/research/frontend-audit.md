# Research: ACP frontend flow, usability, and contract audit

- Query: Why is the ACP Agent experience effectively unusable, what is currently wired, and how should a HiFox-inspired interaction be built on verified backend capabilities?
- Scope: internal; supplied HiFox screenshots used as visual reference only
- Date: 2026-10-16
- Method: Static inspection of the current working tree, prior task artifacts, shared IPC/types, shell conventions, and smoke-test sources. No product code changes, vendor prompts, credentials, browser/native app control, or test execution.

## Findings

### 1. Historical intent and incomplete acceptance

The original ACP task was a protocol/client MVP, not an established working vendor integration. `.trellis/tasks/10-09-acp-agent-console/prd.md` explicitly names OpenHands as an architectural reference and `zed-industries/codex-acp` as the Codex adapter, while selecting a handwritten NDJSON JSON-RPC implementation. Its real-agent end-to-end acceptance checkbox remains unchecked. The documented completed evidence is a mock agent and service smoke tests. The claim that the client is generic across all ACP agents therefore exceeds its demonstrated acceptance evidence.

The old PRD also asks to reuse the existing chat entry and scroll patterns, expose editable agent display names and command registration, and display the bound task status plus workflow phase. The current page uses a separate renderer/compiler and a minimal scroll effect, the settings UI only edits commands and enable switches, and the task badge uses `status ?? phase` rather than both. The old design excludes `session/load`, so historical session display is not a vendor-session resume feature.

The old design contains assumptions that require fresh protocol/source review before reuse: “no official TS SDK”, a fixed `gemini --acp` command, and hand-mapped permission behavior. Those claims were not externally revalidated by this subtask; the main session owns current upstream research.

### 2. Files found

| Path | Role |
| --- | --- |
| `src/renderer/src/pages/AcpConsole.tsx` | Entire ACP page, event compiler, permission cards, and Jira picker |
| `src/renderer/src/pages/Settings.tsx` | `AcpAgentsSection` application settings registration UI |
| `src/renderer/src/api.ts` | Typed `window.trellis` bridge and `hasIpc` flag |
| `src/preload/index.ts` | ACP invoke/event bridge |
| `src/shared/types.ts` | Agent/session/timeline/API types |
| `src/shared/ipc-channels.ts` | Central ACP channel names |
| `src/main/ipc/acp.ts` | IPC handlers; supplies project root for new/list |
| `src/main/services/acp.ts` | Handwritten transport, process lifecycle, registry, event mapping, persistence |
| `src/renderer/src/store/slices/session.ts` | Shared settings persistence action |
| `src/renderer/src/store/types.ts` | Route and store contracts; no ACP domain state |
| `src/renderer/src/my/navigation.ts` | Fixed peer navigation and project-scoped ACP route |
| `src/renderer/src/my/layout/MyApp.tsx` | Page mounting and root identity reset |
| `src/renderer/src/chat/useTranscriptScroll.ts` | Existing chat follow/pause/return-to-bottom hook |
| `src/renderer/src/chat/useChatEntries.ts` | Existing stable chat entry generation pattern |
| `src/renderer/src/components/MarkdownView.tsx` | Existing Markdown renderer |
| `scripts/smoke/acp.mjs` | Real service driven by mock agent with Electron stubs |
| `scripts/smoke/acp-project-scope.mjs` | Service/project boundary checks and lightweight page hook harness |
| `scripts/smoke/acp-mock-agent.mjs` | Permissive handwritten test agent |
| `.trellis/tasks/10-09-acp-agent-console/{prd,design,implement}.md` | Original requirement/architecture/acceptance records |

### 3. Current actual flow

1. The fixed peer module `conversations` opens the existing `acp` route. Route scope is `project` (`my/navigation.ts:31`, `:55`, `:61`). Project or route changes remount the page through the page/root ErrorBoundary key (`my/layout/MyApp.tsx:64-78`).
2. `AcpConsolePage` owns agents, sessions, active session, event arrays, input draft, create flag, and Jira modal in component state (`AcpConsole.tsx:151-157`). There is no ACP store slice.
3. A root-specific scope generation tracks session ownership, early status events, and reload serials (`AcpConsole.tsx:161-174`). Subscriptions accept root-bearing timeline events and hold rootless done/status events until ownership is known (`:216-267`). List snapshots merge with live events by ID (`:137-142`, `:194-214`). These are deliberate protections to preserve.
4. The main page fetches agent status once on mount/root generation (`:258-260`) and lists project sessions. The refresh icon refreshes sessions only (`:369`). It does not re-probe agents.
5. Selecting a new-session dropdown option invokes `api.acpSessionNew({agentId, taskDir?})`, immediately selects the returned local ID, and reloads the records (`:275-294`). The selector only includes agents with `enabled && available` (`:340`, `:353-367`). The IPC handler takes the current main-process project root (`src/main/ipc/acp.ts:28-31`).
6. The service spawns the shell command in the project root and returns a local session ID before asynchronous initialize/new completes (`src/main/services/acp.ts:460-545`). The frontend gets status changes via `acpDone`, renders raw status strings, and only enables its composer at `ready` (`AcpConsole.tsx:406-410`, `:482`).
7. Sending clears the single input immediately and awaits a prompt invoke (`:296-303`). Output events are accumulated, compiled into adjacent text/thought groups or tool state, and rendered with `EventRow` (`:61-117`, `:465-467`).
8. Permission cards are actionable only if root-owned live events still have a pending request, and closed/error sessions have no actionable permission (`:179-192`, `:305-312`, `:585-613`). Root re-entry lists only restore requests still owned by the running main process; `listAcpSessions` reconciles pending flags (`src/main/services/acp.ts:176-178`). Preserve this behavior.
9. Cancel and kill invoke real service methods; reopen creates a fresh session with the previous agent/task binding (`AcpConsole.tsx:424-448`). Historical vendor session resume is absent.
10. Jira selection uses real query/import/new-session APIs, with project generation guards (`:673-769`); it is a manual flow. It does not automatically give imported issue content to the agent or send a prompt (`:756-761`).

### 4. Concrete failures and gaps

#### Blocking foundation and capability representation

| Priority | Finding and consequence | Verified anchors |
| --- | --- | --- |
| P0 | The UI has no way to distinguish executable presence, supported adapter/protocol, authentication, initialized state, and usable session. All registry health is reduced to one `available` boolean. A PATH hit can be labeled “可用” even when no valid ACP conversation is possible. | `shared/types.ts:1624-1627`; `Settings.tsx:1141-1146`; `services/acp.ts:59-75` |
| P0 | Settings says an undetected command can be forcibly enabled, but both page selection and service creation reject `available=false`. This is a user-visible dead end; turning on the checkbox does not allow the promised action. | `Settings.tsx:1144`; `AcpConsole.tsx:340`, `:356`; `services/acp.ts:464-465` |
| P0 | “重新探测” reuses a process-lifetime cache keyed only by executable head. If an executable was missing, installing it or fixing PATH and pressing retry cannot change that cached false value during this app run. The same head with different arguments shares the same health result. | `Settings.tsx:1102-1105`, `:1159-1161`; `services/acp.ts:51-75` |
| P0 | Current backend contracts contain no auth, version/capability diagnostics, model/mode configuration, cwd override, terminal, resource attachments, or detailed startup phases. Adding HiFox-like active selectors before these exist would create display-only controls. | `shared/types.ts:1360-1370`, `:1616-1648`; `preload/index.ts:120-131`; `main/ipc/acp.ts:19-40` |
| P0 | The returned agent-side session ID is only printed into a status event. Prompt sends no sessionId; cancel sends the panel-local ID. A real protocol implementation can reject this despite the mock accepting it. This is backend evidence included to explain why frontend polishing cannot establish usability; main research should decide the corrected remote-ID contract. | `services/acp.ts:534-538`, `:559`, `:575`; mock ignores prompt session identity at `acp-mock-agent.mjs:57-59` |
| P1 | `tool_call_update` has no branch. Only `tool_call` generates a timeline update, so agents using separate patch notifications can leave the UI tool spinner permanently pending even when work completed. | `services/acp.ts:394-428`; page consumes only emitted tool snapshots at `AcpConsole.tsx:89-103`, `:574-582` |

#### Composer, session identity, and asynchronous actions

| Priority | Finding and consequence | Verified anchors |
| --- | --- | --- |
| P1 | Input is one shared string, while session click changes only activeId. A draft written for session A remains in session B and can be sent to the wrong agent/context. Navigation away also drops the draft and selected session because both are component state. | `AcpConsole.tsx:153-155`, `:379`, `:296-303`; `MyApp.tsx:64-78` |
| P1 | Busy placeholder promises “可先输入，回合结束后发送”, but textarea is disabled unless ready. This prevents preparing the next instruction and contradicts its own help text. | `AcpConsole.tsx:480-482` |
| P1 | `send` allows a `busy` session, has no local in-flight lock, and clears the input before acceptance. The visible button blocks busy, but rapid handlers before the busy update or programmatic calls are not serialized, while the backend also accepts busy. Failure loses the draft and only gives a toast. | `AcpConsole.tsx:296-303`, `:491`; `services/acp.ts:551-559` |
| P1 | Enter handling has no composition check. Enter used to confirm a Chinese IME candidate can submit the message. | `AcpConsole.tsx:484-489` |
| P1 | Cancel/kill responses are discarded. There is no action-pending state, acknowledgement, or error feedback; an unsuccessful stop can appear to have done nothing. The request is real, but the interaction is incomplete. | `AcpConsole.tsx:425`, `:444`; method result types at `shared/types.ts:1365-1366` |
| P1 | Agent list/list-session load failures are silent (`res.ok=false` does nothing), and IPC promise rejection has no catch at these callsites. Initial failure can look like a valid empty list; transport failure can leave controls unusable without repair guidance. | `AcpConsole.tsx:194-214`, `:258-260`; `Settings.tsx:1102-1105` |
| P2 | Reopen creates a fresh agent session and does not carry history. Label “重开” needs to explain the new-session behavior rather than imply resume. No resume API or persistent vendor ID exists. | `AcpConsole.tsx:429-437`; `shared/types.ts:1631-1648` |

#### Transcript and layout

| Priority | Finding and consequence | Verified anchors |
| --- | --- | --- |
| P1 | Streaming chunks coalesce into an existing item, but follow-scroll depends only on item count. Once a long message/thought begins, new text increases height without rerunning the effect. Tool updates also retain item count. The reader can appear to stop receiving output below the viewport. | `AcpConsole.tsx:76-85`, `:98`, `:269-273` |
| P1 | Scroll-follow is one ref shared across sessions and only resets on root generation; changing activeId does not reset/restore viewport state or expose a “latest” button. Being scrolled up in A affects B. | `AcpConsole.tsx:160`, `:224`, `:269-273`, `:379`, `:455-458` |
| P1 | Agent replies are rendered as raw `whitespace-pre-wrap` text. Code fences, headings, links, and tables are unformatted although the project already has MarkdownView. | `AcpConsole.tsx:561-564`; `components/MarkdownView.tsx:53`; existing Chat usage at `pages/Chat.tsx:586`, `:641` |
| P1 | Startup is raw status text plus one post-session-new text event and truncated stderr. There is no structured per-phase start/end/outcome/duration/error. HiFox-style “started/handshake/ready/first response” cannot be reconstructed truthfully from current events. | `AcpConsole.tsx:615-617`; `services/acp.ts:515-538`; status union at `shared/types.ts:1629` |
| P2 | Tool cards are one-line truncated snapshots, without expansion for parameters/content/diff/locations. The service also narrows content to a short preview; the renderer cannot recover omitted structure. Thought is individually collapsible, but there is no run/turn-level activity group. | `AcpConsole.tsx:566-582`; `services/acp.ts:408-420` |
| P2 | Left and right asides are always fixed width (`w-60`, `w-44`) and shrink disabled. The transcript must absorb all narrow-width pressure, contradicting the 960px layout requirement. This is static layout evidence, not a measured native screenshot result. | `AcpConsole.tsx:345-347`, `:399`, `:501` |
| P2 | Task binding badge chooses `status ?? phase`, omitting the phase whenever record.status exists. Trellis events with taskDir are appended to all active sessions of the project rather than only that task; metadata remains present, but unrelated task events are mixed into a conversation. | `AcpConsole.tsx:420`, `:228-236`; `services/acp.ts:214-239` |
| P2 | Jira modal uses custom fixed divs, with no shared Modal/Escape layer, dialog role, focus trapping, or busy-close guard. The shell spec requires shared top-layer Escape behavior. | `AcpConsole.tsx:772-788`; no `Modal`/`useEscLayer` import in `:10-40` |

#### Registration/configuration

- The registration data type supports arbitrary IDs and display names, and service listing merges custom rows, but Settings provides no add/remove/name-edit UI (`shared/types.ts:1616-1621`; `services/acp.ts:78-89`; `Settings.tsx:1131-1174`). A user can edit only commands and enable switches for rows that already exist.
- Settings immediately mutates local rows then fires an unawaited save, without saved/dirty/error state (`Settings.tsx:1113-1120`). Blur saves the command; a “test connection” button does not exist. Restore presets shows a success-style notification after `saveSettings` returns, without a diagnostic rerun beyond the cached executable lookup (`:1165-1169`).
- ACP settings are distinct from generic API models; no current contract connects `models` route data or `settings.dispatch.codexModel` to ACP model selection. Do not reuse those settings silently.

### 5. Real controls versus absent capabilities

| Current control / requested reference | Reality today | Contract work before strengthening the UI |
| --- | --- | --- |
| New-session agent selector | Real list and spawn call; requires enabled + PATH result | Durable agent profile identity; explicit adapter/version/health/auth diagnostics |
| Refresh icon | Real session re-list only | Separate refresh sessions vs recheck runtime actions |
| Settings enable/command | Real settings save; no full registration or connection test | Validated draft/save result; structured launch spec; add/edit/remove policy |
| Send | Real prompt invocation and output subscription | Remote session identity; per-turn request ID and single active turn; acceptance vs completion result |
| Stop turn / end session | Real IPC calls | Ack/error states; cancelling state; vendor stopReason semantics; cleanup confirmation |
| Permission buttons | Real response invocation; guarded live-pending state | Exact supported options, expiry/decision state and request pending lock; never revive historical approvals |
| Thought disclosure | Real reported thought text | Preserve only agent-provided events; no fabricated thought content |
| Tool card | Real reported snapshot, often incomplete | Full and patch update normalization; retained structured content; expandable rows |
| Trellis cards / task/artifact links | Real first-party signals and existing navigation | Explicit task provenance/filtering; preserve project isolation |
| Agent detail panel | Absent | Profile/config/session health APIs; distinguish profile settings from session effective settings |
| Model/mode selector | Absent | Advertised capability/options/current value + acknowledged change API |
| Working directory control | Absent; cwd fixed to project root | Policy for project root versus custom cwd, validation and effective cwd response; do not create a second project selector |
| Agent instructions | Absent | Explicit supported injection mechanism and effective prompt provenance; no local-only fake save |
| Runtime/computer/environment | Absent; child inherits main process env | Validated launch specification and environment policy, with secrets excluded from renderer diagnostics |
| Attachments, MCP/tools/skills/Git controls | No ACP API | Scope separately; implement actual protocol/config behavior before exposing actions |
| Task/run/token statistics | Only local session timestamps/events exist; no trustworthy token usage field | Agent-reported usage provenance and counted entity definitions; omit unavailable metrics |

### 6. Phased UX proposal tied to backend work

#### Phase A — establish one trustworthy runnable path

Goal: an actual installed adapter can initialize, create, prompt, stream, request permission, finish, cancel, fail, and exit without the user needing to debug hidden state.

- Keep the existing fixed peer navigation and project selector. ACP remains the project-scoped Conversations page; the Agent catalogue and configuration are page-owned views/panels.
- Add runtime setup/health to the page empty state, with truthful distinctions such as not configured, executable missing, protocol failure, authentication required, connecting, ready, running, cancelling, ended. Final names depend on backend outcome codes, not frontend guesses from stderr.
- Separate discovery diagnostics from launch: show effective executable/adapter version, error phase, actionable retry, and a complete per-phase startup report. “Test” must actually exercise the required connection contract; mark it as connection-only if it sends no prompt.
- Define backend DTOs for profile summary, diagnostics, negotiated capabilities, lifecycle phase events, effective cwd, local session ID versus remote agent session ID, and per-turn status. Preserve root-bearing event ownership and generation isolation.
- Fix current composer/scroll/error defects alongside the foundation. Drafts should be keyed by canonical root + session ID (with a separate new-session draft), and session-changing actions should retain the correct draft. Reject simultaneous turns until the backend explicitly supports queueing.
- Validate with a stricter protocol fixture and at least one actual vendor integration. A service mock pass cannot be the release acceptance criterion for usability.

#### Phase B — HiFox-inspired catalogue, transcript, and detail panel

- Catalogue: Agent cards with name, adapter/runtime, last checked health, a primary start-conversation action, and a configuration action. Distinguish the mock fixture visibly from production profiles. Session list should support discoverability without being the only place to understand an Agent.
- Conversation: transcript is the central reading surface. Group real startup phases into a collapsible “Preparing environment” section, display measured durations, retain individual failure details, and separate initialization completion from first agent output.
- Render agent Markdown with the existing safe MarkdownView; reuse/adapt the existing chat follow/pause/latest behavior rather than the current item-count effect. Maintain reading position per session.
- Group thought and tool activity by turn; default verbose reasoning/tool details to collapsed, surface pending approvals and active failures prominently, and retain every reported tool patch/result. Do not fabricate thinking, elapsed phases, or success badges.
- Right configuration drawer: Agent profile/effective session details first (adapter, effective cwd, actual model/mode if known, task binding, capabilities). Only show editable controls when the service advertises and implements the action. Unsupported settings can be absent or explicitly unavailable with a reason.
- At narrow widths the detail drawer closes or overlays, then the session/catalogue pane yields; primary conversation/stop/approve controls remain reachable. Use current `my` tokens/shared UI primitives and shared modal/Escape behavior.

#### Phase C — expand capabilities with independent acceptance

- Dynamic model/mode/config selection only after negotiated options and change acknowledgement exist.
- Instructions, custom environment/cwd, attachments/resources, terminal/fs support, tools/MCP, and session load/list/resume each need a protocol/permission/persistence contract and real adapter validation. They are not all implied by “complete ACP”.
- Keep Jira manual import as a secondary task-association flow. Support binding an existing Trellis task without requiring Jira if product scope confirms it. Establish whether Trellis events are an explicitly project-wide activity rail or task-filtered conversation annotations.
- Remote computers, organization teams, IM integration, marketplaces, parallel multi-agent orchestration, and HiFox statistics are separate product scopes; the screenshots do not establish authorization or backend readiness for these features.

### 7. Verification shape

Existing evidence is useful and should remain regression coverage:

- `scripts/smoke/acp.mjs:60-127` drives the real service against the mock agent for permission, event, persistence, and kill behavior.
- `scripts/smoke/acp-project-scope.mjs:138-219` uses a custom hook harness. Its own comment states that child components and DOM remain unmounted. It checks late list/create/output generations and live permission restoration (`:236-296`), not scroll, focus, IME, CSS, Markdown, or a real Electron lifecycle.
- `scripts/smoke/acp-mock-agent.mjs:49-59` returns a fixed remote ID and accepts prompt without checking it; `:96` uses another full `tool_call` for completion. This cannot validate remote session identity or patch-update handling.

Required new evidence should cover:

1. Strict fixture: unique remote session IDs, required session ID on prompt/cancel, separate tool patch updates, unsupported capabilities, auth-needed failure, process errors, cancel result, and invalid permission option behavior.
2. Real mounted UI: many chunks within one text/thought item, auto-follow while at bottom, pause while reading history, return-to-latest, per-session draft/scroll retention, Chinese IME Enter, duplicate-send prevention, stop failure, and permission double-click/expiry.
3. Existing cross-root checks: A → B → A asynchronous isolation, no foreign session/events, project-unbound state, live-only approvals, no stopping another project's agents on project switch.
4. Actual adapter/Electron acceptance: startup phase truthfulness, actual prompt/tool/permission lifecycle, cancel and process cleanup, no reliance on mock availability. Record exact runtime and adapter versions with the evidence.
5. Responsive/light/dark/keyboard check at 960px and larger, including shared Escape stack and drawer focus return. These require real rendered UI; pure state assertions are insufficient.

## Related Specs

- `.trellis/workflow.md`: plan artifacts first; research persists under the active task; implementation follows reviewed planning.
- `.trellis/spec/frontend/index.md`: frontend layers and must-read list.
- `.trellis/spec/frontend/ipc-electron.md`: typed shared IPC and main-process native operations; subscriptions require cleanup.
- `.trellis/spec/frontend/store-conventions.md`: one domain per Zustand slice, stable public imports, bounded `tpanel.` persistence; avoid monolithic session slice growth.
- `.trellis/spec/frontend/react-pitfalls.md`: state that must survive unmount belongs above the unmount boundary; stable identity matters.
- `.trellis/spec/frontend/my-ui-module.md:78-230`: fixed peer navigation, real project selector, root generation/ownership guards, live-only permission restoration, current tokens, shared Escape layers, 960px reachability, and tests' non-E2E limits.
- `.trellis/spec/shared/code-quality.md`: explicit types and visible error handling.

## External References

- No new external sources were retrieved in this subtask. The old task records OpenHands, `zed-industries/codex-acp`, and ACP v1 as historical references; they are not evidence of today's supported commands, SDK availability, or compatibility.
- Supplied reference images show a HiFox Agent catalogue and a conversation with startup milestones, collapsible thought, model/runtime/directory controls, and Agent details. They inform composition only; no assertion was made about HiFox's internals or protocol correctness.

## Decisions Needed

- Which actual vendor/adapter is the first required acceptance target? The former task allowed any locally available Agent; claiming all Agents work needs a compatibility matrix.
- Should the initial release support existing authenticated local CLIs, or must it also perform authentication in the panel? This determines setup scope.
- Should runtime cwd remain the selected project root for this release? A separate cwd control must not silently change project identity or event ownership.
- Are Agent profile instructions and task binding part of the first usable milestone, or a next capability after the transport is verified?
- Are Trellis rail annotations task-filtered or deliberately project-wide? The UI must label the chosen scope.
- What does “session history” promise: read-only transcripts, or actual vendor resume? Current implementation supports transcripts only.

## Caveats / Not Found

- This report preserves the current working tree, including pre-existing dirty ACP frontend/service/IPC changes. It is a static audit, not a claim that every suspected runtime interaction was reproduced.
- No tests were run because researcher writes are restricted to this task's research directory and the smoke scripts create files outside it. The report inspects their source and documented prior evidence only.
- Root session owns current upstream documentation, historical conversation search, and the final product/architecture decisions. No new task status/config/dependency writes were made here.
- The new frontend DTO names above describe required information, not a finalized implementation schema. Their final shape should follow the backend foundation design and chosen adapter compatibility contract.

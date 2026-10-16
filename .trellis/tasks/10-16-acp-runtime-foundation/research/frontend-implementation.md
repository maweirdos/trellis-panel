# ACP frontend implementation handoff

Date: 2026-10-16. Scope: assigned renderer implementation; no product-vendor/native acceptance claim.

## Change boundary

The prior page treated executable registration as Agent identity, discarded drafts before acceptance, disabled busy drafting, had no IME guard or acknowledgement UI, and reduced tools to truncated lines. The new page keeps the existing project-scoped ACP route and shell while owning profiles/catalogue, runtime setup, transcript and session configuration. It does not replace ordinary Chat, add global navigation, or implement runtime/protocol behavior in the renderer.

## Owned files

- `src/renderer/src/pages/AcpConsole.tsx`: stable route export to the page-owned ACP workspace.
- `src/renderer/src/acp/ConsoleWorkspace.tsx`: root-generation state, early event/list reconciliation, live permission filtering, explicit start/send/stop/resume, responsive recent-session catalogue and conversation.
- `src/renderer/src/acp/{ProfileEditor,RuntimePanel,SessionDetails,TranscriptRow,JiraPicker}.tsx`: profile CRUD; explicit Node/setup/refresh; capability-backed acknowledged configuration/material snapshots; Markdown/thought/tool/raw output/diff/locations; preserved manual Jira import/start using shared Modal and a synchronous duplicate-action guard.
- `src/renderer/src/acp/timeline.ts`: presentation projection preserving tool patch absence/null, turn-scoped tool IDs, unknown payload inspection and authoritative permission snapshot replacement.
- `src/renderer/src/acp/view-state.ts`: bounded project/session draft, selection and follow/scroll preferences under `tpanel.acp.view.*`, with memory fallback for unavailable storage.
- `src/renderer/src/pages/Settings.tsx`: ACP section only; shared RuntimePanel plus separately saved custom launch commands. Existing executable/args fields and other ACP settings are preserved.
- `scripts/smoke/acp-ui.mjs`: real component hook/event handlers plus pure projection tests; no mounted DOM or native claims.

## Contract decisions coordinated with backend

- Runtime health is launch readiness, separate from actual connected session readiness. A PATH hit is never labeled a successful protocol connection.
- Configuration uses actual public capability strings `session/set_model`, `session/set_mode`, `session/set_config_option`; current values change only after the returned acknowledged session.
- `restorePending` means the public runtime selected history but deferred native load until the next explicit send. It is displayed as “发送时验证恢复”, remains disconnected, permits an explicit send, and disables live configuration. Failed load does not create or replay another conversation.
- `onAcpState` owns full nonterminal metadata; `AcpDoneEvent` preserves root/connection/session fields when available and remains compatible with legacy rootless terminal events.
- Task-scoped Trellis events reach matching bound tasks; unbound events are visibly labeled project activity.

## Verification performed

- `node scripts/smoke/acp-ui.mjs`: 29 checks passed. Includes A→B→A old list/create/output closures, foreign events/status, early permissions before list/create, expired authoritative permissions, per-session drafts, IME and 229 Enter guards, synchronous send/approval locks, rejection preservation, busy drafting, newer draft protection on late acknowledgement, exact second same-kind option ID and reject_always styling, scroll pause/follow/restoration, tool partial patch/null/cross-turn IDs, and model configuration pending/failure/acknowledgement.
- `npm run typecheck`: passed after dependency worker completed final patch preparation. An earlier transient pretypecheck failure occurred during intentional dependency patch regeneration; final guard passed.
- `npm run build`: passed. Existing Vite/config/dynamic-import warnings remain; acpx CommonJS import.meta warning concerns its unused shared-owner route and must be considered during packaged validation by the coordinator.
- `node scripts/smoke/uiux-wiring.mjs`: passed.
- `node scripts/smoke/navigation.mjs`: passed.
- `git diff --check`: no whitespace errors; existing repository CRLF warnings are unrelated.

Existing `acp-project-scope.mjs` is owned by backend. Its obsolete renderer-specific hook harness may be removed only because this new harness retains the baseline generation/early-permission/foreign-root checks; service and IPC coverage remain separate.

## Native QA paths for coordinator

1. Existing Conversations module → “Agent 工作台”. “全部 Agent” presents real profile cards. “创建 Agent”, per-card “配置 [name]”, “开始会话” and “最近对话” are functional.
2. Header “Runtime 设置” → “选择 Node”, “重新探测”, and explicit per-runtime “安装适配器”. “管理自定义 Runtime 命令” opens application Settings ACP section.
3. “最近会话” remains available at 960px. Left desktop list yields below 1100px; right detail pane yields below 1500px and remains accessible through “会话配置与材料”.
4. Conversation startup expands actual observations; tools/“Agent 思考摘要” expand details. Tool raw data, supported output/diff/locations and unknown payloads remain inspectable.
5. Textarea `aria-label="Agent 指令"`; send control `title="发送指令"`. Verify actual Chinese IME, Shift+Enter, busy drafting, rapid duplicate click, failed send preservation, switching sessions/route/root, actual scrolling and “回到最新”.
6. “中止本轮” and “结束” show request/error feedback and await backend status. Historical records offer supported “恢复原会话” separately from “新会话”; lazy restore must remain visibly unconfirmed until send.
7. “会话配置与材料” opens actual model/mode/config when reported and material/profile provenance. Verify allowed/denied permission options and disabled pending state through actual product-created sessions.
8. Jira remains manual: query → select/import (jiraKey reuse) → create task-bound session, with no prompt sent implicitly. Task/artifact/spec/Jira navigation remains functional.

Native keyboard/focus, light/dark/960px layout, actual scrolling/IME and real-vendor permissions/cancel/resume remain coordinator-owned acceptance. The harness is deliberately not evidence for these rows.

## Native-review presentation follow-up

The coordinator observed repeated `session updated` and raw `usage updated` rows surrounding a real Codex answer. `timeline.ts` now groups routine session/usage/configuration and known informational diagnostics per turn. `TranscriptRow.tsx` displays one closed “运行活动 · N 条” disclosure, with readable Chinese categories and every original event/raw payload retained inside. Actual startup observations remain in StartupGroup, while thought/tool/permission and explicit error diagnostics remain visible separately. No usage values or durations are calculated or inferred.

A second native finding showed a meaningful tool title replaced by `tool call`. The selected runtime normalizes an omitted tool patch title to that literal placeholder. The presentation reducer now retains the existing meaningful title for that specific normalized `tool_call_update` case, while still applying changed status/output/null fields and respecting explicit non-placeholder title changes.

Public normalization loses the difference between an omitted title and an explicitly supplied literal `tool call`. This narrow presentation policy therefore also retains the previous display title in that unusual deliberate-rename case; the unmodified raw event remains inspectable. It does not claim exact original-title presence semantics.

`acp-ui.mjs` now has 35 passing checks: four additional grouping/raw-retention/visible-error assertions and two normalized-tool-title assertions. Scoped web TypeScript and the latest `npm run build` both passed after the dependency worker declared its optional metadata patch stable. The earlier preparation failure was limited to that intentional regeneration window. Native retest remains with the coordinator.

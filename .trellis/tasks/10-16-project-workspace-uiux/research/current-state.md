# Read-only current-state research — 2026-10-16

Sources: repository inspection by shell and content explorers. Neither explorer edited product code, started implementation, or ran tests. This is an evidence inventory, not completed functionality.

## Shell

- `components/TitleBar.tsx:29–52` has a passive project-name badge and native event calls; `App.tsx:181–188` preview skips the title bar, while `:195` native renders it. Share the normal-window header and guard native controls.
- `my/layout/WorkspaceSidebar.tsx:63–108` owns the real project menu; `:119–176` owns the old nested three-domain tree. Extract menu, replace hierarchy, retain actual scope behavior.
- `my/navigation.ts:17` covers all 17 Page values and owns scope notes; retain it as the sole route metadata source. `my/CommandPalette.tsx:45–57` consumes it with a special iteration action.
- `my/layout/PageFrame.tsx:10–24` repeats project identity and mixes project ACP/channel/local API modes. Remove repeated identity; retain distinct actual ranges.
- `my/store.ts:103–120` separates first snapshot synchronization from real root changes. `store/slices/session.ts:78–111` rejects stale project-open replies and merges only recent projects. Do not regress either.
- `WorkItemsPage.tsx:1416–1476` already implements cycle/rollover behavior, `:1537` repeats project identity. Iteration navigation currently guesses identity from groupBy, which confuses grouping with location.
- `src/main/index.ts:135` sets minimum width 960; four permanent columns cannot fit.

## Central task defect

- `TaskDetail.tsx:306–316` writes expansion origin; `store/slices/ui.ts:36–54` records/returns it. No current UI consumes the return action.
- `my/layout/MyApp.tsx:75` renders only WorkItemsPage for tasks; `:166–175` always renders openTaskDir as an absolute right drawer. There is no real expanded central task host.
- `my/pages/IssuePeek.tsx:98–101` full detail merely shows the task drawer. `:235` and `:411` document actions directly open independent windows.
- No current `[data-page-scroll]` source host supports the existing capture logic.
- Legacy `pages/Tasks.tsx` was deleted at `c251a9a`; `git show c251a9a^:src/renderer/src/pages/Tasks.tsx` contains TaskWorkspace (historical line 302), DocumentReader (1385/1392), ObservationPanel (1441) and closeWorkspace (1703). It also depends on removed modals and old styling: use as behavior evidence, do not restore the whole file.

## Reader lifetime and materials

- `reader/DocumentReader.tsx:43`, `reader/use-document-reader.ts:80` already support text/revision/diagnostics, pending-update notices, explicit reading of newer versions, diff and anchored scroll.
- `use-document-reader.ts:215` clears a session on unmount; `reader/reading-session.ts:38` rebuilds the baseline. A keyed remount during expansion can silently lose pending state.
- `TaskDetail.tsx:378` enumerates actual task artifacts; classify them for browsing without changing paths or inventing lifecycle facts.
- `observation/ObservationPanel.tsx:339` accepts workspaceId/taskRef and retains actual assembled/emitted/unknown receipts. Reuse it.
- `scripts/smoke/reader-wiring.mjs` tests document services, pure reader state/hub/Esc/scroll behavior, not mounted React routing. It cannot validate the missing central flow.

## Workflow boundaries

- `shared/types.ts:36` TaskRecord has no approver, approval-version or handoff entity.
- `main/services/scan.ts:443–458` allows metadata updates, reserves status/completedAt to external Trellis lifecycle commands.
- No UI-only confirmation/finish/start controls should write these lifecycle fields. File existence is not approval or check success.

## Knowledge and norms

- `pages/Knowledge.tsx:49–56` combines local libraries and company WeKnora. `:130` independently appends remote results; preserve local-first behavior.
- `shared/types.ts:1000` KbDoc contains actual path/library/group/mtime; retain original task file identity.
- `Knowledge.tsx:410` uses a fixed 420px results column; `Spec.tsx:262` uses 320px. Adapt to new available width.
- `Knowledge.tsx:628` only changes page to spec and loses file selection. A root-scoped target is required.
- `Spec.tsx:424` requires specSelected even when search/log loadDoc clears it; loaded selected content then fails to render. Separate display from editing eligibility.
- `main/services/knowledge.ts:257–310` writes notes into project `.trellis/notes`; no private ACL exists. QA history is personal userData, a different range.
- Remote previews have no local revision contract. Do not invent version fixing or local-Git compare.

## Overview and team

- Existing task assignee/creator/status/priority/cycle/mtime, developer identity and journal/session records can support responsibility/record views.
- `YourWorkPage.tsx:94` labels recent updates while sorting createdAt; use actual updatedAt or change label. Creator can be read from the real snapshot rather than inferred from activity[0].
- `Team.tsx:550` derives activity from mtimes/lastSeen. Assignee is not necessarily the actor; lastSeen is not live presence. No real approval recipient, waiting time or delivery/read state exists.
- `my/pages/IssuePeek.tsx:145` comments use temporary mirror state; `my/adapter.ts:118` rebuilds comments as empty on snapshot sync. Do not present as durable team discussion.

## Scope compatibility and dirty baseline

- API chat lives at userData/chat-sessions (`main/services/chat-store.ts:46–50`), lists globally (`:140`) with no IPC root (`main/ipc/chat.ts:28`). Keep local/cross-project label and old history.
- ACP already filters by root before truncation. Preserve current generation guards, actionable live permissions and no revival of expired/history permissions.
- Settings includes application, connection and some current-project actions (`pages/Settings.tsx:582–1085`). Do not label the entire page project-only.
- Existing dirty work includes App/MyApp/sidebar/PageFrame/palette/my-store/IssuePeek/session plus navigation/root-preference helpers and navigation/ACP scope smoke. Other main/preload/doc/ACP changes belong to ongoing work and must not be overwritten.
- Related tasks: 10-14-my-ui-shell (superseded hierarchy, retain features), 10-15-weekly-cycles (retain cycle semantics), 10-15-unify-plane-uiux (retain tokens), 10-15-preview-fallback-guards (retain honest no-bridge behavior).

## Check strategy

Light-theme evidence: `my/my-tokens.css:227–241` already defines separate canvas/surface/layer roles, while `my/my.css:29–33` defines raised/overlay shadows. User confirmed retaining the current style and improving its light-theme hierarchy. This is a surface-use and hierarchy audit first, not a new palette or generated-token rewrite. Verify actual rendered text/background combinations and selected/hover/focus states in addition to screenshots.

Automated checks: typecheck/build, navigation/root-race smoke, ACP scope/lifecycle smoke and document/reading smoke. Mounted UI/native checks additionally required for expansion/return, pending revisions, 960px, themes, drag and window buttons. No tests have been run for this planning-only change.

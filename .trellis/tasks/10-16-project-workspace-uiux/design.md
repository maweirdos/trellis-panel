# Project workspace UIUX — technical design

Status: approved for implementation on 2026-10-16 following the user's “可以，继续” response to the updated complete planning summary.

Current checkpoint: the user subsequently requested a Codex-level visual correction and then explicitly authorized committing this version. The latest renderer uses a borderless project title, desktop icon rail and quiet context rows; supported native theme-aware border/background mapping is scoped to the main window. See `research/visual-refinement.md`. Native visual acceptance remains pending; do not archive the task as visually complete merely because work commits exist.

## 1. Smallest complete change

Fix the shell hierarchy and make its central workspace real. Reuse existing task, iteration, document, knowledge, team and Agent capabilities; do not add a second application or a workflow execution platform.

The current design source is the window-root model in `docs/proposals/2026-10-15-hifox-roadmap/05-project-workspace-and-integrations.md`. The three images in `docs/proposals/2026-10-16-workbench-layout/assets/` guide content density, material reading and auxiliary panels. Their sidebar project selector is superseded by the window header. On 2026-10-16 the user confirmed retaining a fixed module rail and collapsible contextual sidebar, keeping the current visual style and improving light-theme hierarchy. The references do not establish approval, remote versioning or runtime capabilities.

## 2. Layout and information architecture

### Approved navigation structure — 2026-10-16

Use a fixed module rail and a collapsible contextual sidebar. The earlier single-sidebar sketch is retired; do not use it as an implementation target.

```text
┌───────────────────────────────────────────────────────────────────────┐
│ Trellis   [ current project ▾ ]        Search / commands    window UI │
├───────┬───────────────────┬───────────────────────────────────────────┤
│ Fixed │ Context for the   │ Current working object                    │
│ module│ selected module   │                                           │
│ rail  │                   │ Task / document / conversation            │
│       │ Views or objects, │                                           │
│       │ collapsible       │                [context on demand]        │
└───────┴───────────────────┴───────────────────────────────────────────┘
```

The rail keeps overview/intake/work items/iterations/knowledge/conversations/team/analytics as peers, with accessible names and discoverable labels. It does not introduce a second project identity. The contextual sidebar does not repeat the main menu: work items show views/filters, knowledge shows sources/directories, and conversations show project sessions. Hide it when a module has no useful contextual navigation. Its collapse never removes or reorders the module rail. The extra fixed width is small (roughly 56px); collapse context or overlay auxiliary panels at narrow widths.

Group headings inside contextual navigation are inert labels. Only destinations receive active styling. The header owns project identity; page headers own module/object identity. The updated complete planning summary, including this layout, has been approved for implementation.

### Visual continuity and light-theme hierarchy

Keep the current typography, leaf-green accent, icon family, component density and radius tokens. No new visual identity is needed. Existing surface tokens already differ in `my-tokens.css:227–241`, and raised/overlay shadows exist in `my.css:29–33`; first correct their semantic use.

| Region/state | Intended treatment with existing semantic tokens |
| --- | --- |
| Fixed rail and header | Restrained canvas treatment; stable structural separation and strong current-module indication |
| Contextual sidebar | Recessed layer treatment distinct from central content; quiet labels and visible selected object |
| Central reading/work | Primary surface and clearest text hierarchy; avoid wrapping every section in another card |
| Optional context | Secondary surface separated from primary content; does not compete with primary action |
| Menus/dialogs | Existing surface, defined border and overlay shadow; distinguish elevation from normal content |
| Hover / selected / keyboard focus | Distinct semantic feedback; selection persists without hover, focus has a visible independent ring |

Do not hand-edit generated token data or scatter literal colors. If actual light-mode comparison still shows insufficient hierarchy, adjust theme-scoped semantic overrides at the existing theme entry, keeping dark-mode values stable. Target 4.5:1 for ordinary body/primary navigation text in changed surfaces; distinguish important states with shape/text as well as color. Verify actual rendered pairs, not CSS variable names alone.

### Route compatibility

Keep `useApp.page` and the existing 17 `Page` values. Extend typed navigation metadata rather than introduce a parallel router.

| Visible location | Existing destination / behavior |
| --- | --- |
| Overview | `dashboard`, actual personal/project snapshot views |
| Intake | `inbox`; existing Jira source view reachable here, with its current query/import scope note |
| Work items | `tasks` with explicit `workItemsView='items'`; archive is a secondary view/action |
| Iterations | `tasks` with explicit `workItemsView='iterations'`, reusing cycle grouping/model |
| Knowledge | `knowledge`; `spec` is the existing linked normative editor/reader |
| Conversations | project ACP `acp`; `channels` remains a distinct collaboration mode with its existing semantics |
| Team / Analytics | `team` / `analytics`, peers of work items |
| Tools & settings | `architecture`, `studio`, `gateway`, `models`, `settings`, local cross-project `chat`; retain command access |

`workItemsView` is navigation identity, not inferred from `groupBy`. Ordinary cycle grouping never changes active navigation. Entering iterations explicitly sets the appropriate grouping. Do not rewrite cycle persistence or natural-week rollover.

API chat history is local and cross-project; do not place it as a project ACP tab or migrate its history. Company knowledge remains explicitly sourced. The existing settings page contains mixed scopes; keep it reachable and label actual targets rather than claim a settings backend separation.

## 3. Shared main-window header

Extract the current real-project menu into a reusable `ProjectSwitcher` and have a shared main-window header display it once. Desktop and `?my=1` preview use the same shell composition. Native maximize/minimize/close/capsule controls subscribe only when the real bridge is available.

Keep the header outside normal page content. Maintain `drag-region` only on passive space; menus, search and controls use `no-drag`. Browser preview does not fake OS buttons or native open capability. Do not wrap document/capsule/quicktodo windows in this header.

Reuse `projectRootKey`, `projectChoices`, `openProjectPath` and current root/revision guards. Preserve initial null→root deep-link focus and root-scoped favorites/views. Do not simplify asynchronous recent-project refresh into a full settings replacement.

## 4. Task workspace presentation and lifetime

### State contract

Keep task identity (`openTaskDir`, archived flag) independent of module identity. Give task presentation an explicit preview/workspace value. Preserve the existing `expandTaskWorkspace` and `returnFromWorkspace` API intent, but stop depending on `page='tasks'` to express presentation.

The source route remains mounted while a task is expanded. Capture source identity, relevant scroll hosts and the focus return target. Source-local tabs and collapsed groups survive because the source component is not unmounted. A deliberate module navigation closes task presentation through the existing navigation action, rather than leaving an invisible stale focus mode.

Root changes must discard the previous project's task presentation, captured source and pending material selection. A deep link retains its initial selected task. Browser URLs do not gain a new router in this change.

### One content instance

Place one task surface in a stable shell slot, beside the source body. In preview mode it occupies the right drawer area; in workspace mode it fills the central region. Change container layout/classes rather than render separate drawer/workspace component branches. Keep task and document keys based on actual root/task/file identity, not presentation.

Hide the source body from pointer, keyboard and accessibility interaction while central focus is active, without unmounting it. Restore focus and scroll on return. Escape follows the existing overlay stack; it must not close the reader twice or navigate behind an open menu.

Adapt `TaskDetail` to shared content/presentation rather than restore the deleted 1700-line legacy `Tasks.tsx`. Remove drawer-only width/resize affordances in workspace mode. Integrate existing `DocPane`/`DocumentReader` and `ObservationPanel`, preserving revision, pending updates, raw formats and receipt semantics.

### Material organization

Use a small pure classifier for file-based convenience groups. It may match known PRD/design/implement/check artifacts, but never infer approvals or successful checks. Unknown files remain visible under all materials. Missing/unreadable files render diagnostics through the existing reader.

Properties and evidence use the auxiliary region; it is closed or overlaid when width is insufficient. At 960px do not display navigation, material list, reader and a permanently open right panel simultaneously.

## 5. Knowledge and norms

Keep Knowledge's real local index and independent WeKnora request. Make browse/results responsive and allow the reader to occupy the central width. Project files retain their original paths and use existing reading/version contracts. Synthetic task summaries remain labeled summaries, not authoritative standalone documents.

Add or reuse a one-shot root-scoped target path when navigating from Knowledge to Spec. Consume only a target within the current project; clear it on project change. Spec display depends on loaded selected content, not solely a tree node, so search/log results render. Editing eligibility remains separate from display eligibility and retains conflict checks.

Use “project notes” for `.trellis/notes`. Remote previews display only supported metadata and source; do not invent local revisions or Git comparison controls for remote content.

## 6. Overview and team

Overview uses exclusive views/tabs for assigned, created and recently updated work. Derive creator/updatedAt from actual snapshot data. Keep task navigation, existing keyboard interactions and maintenance actions, while reducing redundant first-screen cards and lists.

Team remains a snapshot-derived responsibility view. Group by actual assignee/status, include unassigned work and retain existing analysis/report tabs. Use “recent records” and “a task assigned to X changed” where actor identity is unknown. Do not synthesize reviewer identities, waiting durations or notifications. Existing transient peek comments must not be presented as durable shared discussion.

## 7. Extension points

Reserve external-app placement through shared navigation metadata/tools, with a clear explanation and links to currently supported configuration. Existing Jira/GitLab actions keep their real behavior. New app SDKs, authorization flows, sync, native web embeds and platform APIs are deferred.

Do not ship empty permanent bottom tools or mock Run/Git buttons. The layout must accommodate future bottom tools without coupling normal business pages to them. Roadmap retains three developer priorities: multi-project/service startup, basic logs, read-only Git. Display preference is not authorization and does not execute anything.

## 8. Files and ownership boundaries

| Area | Expected files | Constraint |
| --- | --- | --- |
| Shell/header/nav | `App.tsx`, `components/TitleBar.tsx`, `my/layout/*`, `my/navigation.ts`, `my/CommandPalette.tsx`, `my/store.ts` | Single shell coordinator; preserve existing dirty changes and root guards |
| Task presentation | `pages/TaskDetail.tsx`, `my/pages/IssuePeek.tsx`, `store/types.ts`, `store/slices/ui.ts`, small task/material helper | Shared surface contract agreed before integration; no main-process lifecycle writes |
| Content views | `my/pages/WorkItemsPage.tsx`, `YourWorkPage.tsx`, `pages/Knowledge.tsx`, `Spec.tsx`, `Team.tsx` | Preserve actual capability and root-scoped identities |
| Verification/docs | navigation and focused task smoke, design QA, frontend contract, roadmap status note | Do not claim pure helper tests verify mounted UI |

Main/preload/ACP/doc service dirty changes are outside the implementation footprint unless a directly demonstrated regression demands a separately reviewed adjustment. No database/schema or IPC additions are planned.

## 9. Risks, rollout and rollback

Implement in slices: shell → central task → content views → verification. Maintain useful intermediate states and run focused checks after each slice. Use the existing token system throughout.

Record starting dirty state and hashes/patches for overlapping files before implementation. Roll back only the current task's hunks or restore against that baseline, never `git reset` or overwrite pre-existing work. Avoid staging/committing unrelated files.

Reader continuity and native title-bar behavior are highest-risk acceptance areas. Browser validation proves layout and renderer behavior only. Real project switching, file update/revision handling and native controls require native/evidence-backed checks. If blocked, mark those checks explicitly unverified.

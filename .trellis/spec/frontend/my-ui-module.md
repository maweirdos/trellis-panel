# Global shell UI conventions (`src/renderer/src/my/`)

Read this before modifying the shell or adding a `my.*` style consumer. Detailed
style ownership and executable checks live in [css-design.md](./css-design.md).

## Shared sidebar geometry

Context owners consume `useSidebarWidthStyle` and `SidebarResizeHandle`.
`tpanel.my.ui` stores the sidebar width alongside font/collapse preferences,
clamped to220–400px. The Standard default is240px; switching density selects
224/240/256px for Compact/Standard/Comfortable. Existing stored widths remain
valid, and users can still resize manually. Shell context and Knowledge/Spec/Channels/Chat/ACP-owned browsers must not
render duplicate sidebars or invent a separate width. Preserve drag, keyboard,
double-click reset and globally reachable expand/collapse behavior.

## Module boundaries

- `App.tsx` renders `my/layout/MyApp` as the sole shell; main `useApp.page` is the
  route authority. Keep data, store, icons, UI primitives, layout and pages in their
  current modules. Renderer native actions retain their existing IPC boundaries.
- `main.tsx` imports `my/my.css` once, including for independent windows; MyApp does
  not own a font import or a second style entry point.
- `?my=1` is the no-IPC development preview. It is not evidence that native project,
  connected-session or window interactions have succeeded.
- Header changes preserve the existing personal/team navigation, page layouts,
  filters, forms and task flows. Add integration points to their current components;
  prototype fixture pages are not replacement implementations.

## Desktop global header

`TitleBar` owns one global row: brand, desktop Work/Code dropdown, team space,
context collapse, command search, actual application activity, account and native
window controls. `ShellViewSwitcher` retains the persisted
`collaboration | development` values; its desktop dropdown changes only this
presentation preference. Preserve the separate `host="web"` control.

`AccountMenu` reuses the existing rail account identity, theme/settings actions
and controlled `ConnectionPanel` with its dirty-close handling. The desktop rail
keeps its module order and Settings entry; do not duplicate the account owner.

`TeamContextSwitcher` keeps its default behavior. The global variant reads actual
joined spaces and source status. Selecting outside the original team surface
changes the team selection without routing, replacing the source view or
rebinding an engineering project. Explicit space management uses the existing
team destination. Refresh through the existing bootstrap; do not add a header
poller or fabricate membership/data for browser previews.

The compact Code tools row reuses `ProjectSwitcher`, `DevelopmentScopeTag`,
`GitBranchControl` and `ApplicationPanel`. It is available in Code engineering
areas and open task surfaces. Team/settings domains, API chat, creations and the
personal team-task list retain their existing page design without this row.
Preserve source mounting, native mutation guards and running-process authority;
the header is not a new task or conversation router.

## Page layout contracts

All routes choose `full` or `centered` in `layout/PageLayout.tsx`'s exhaustive
`PAGE_LAYOUTS` registry. Page identity still belongs to navigation metadata; the
layout registry owns only geometry. `PageFrame` and pages with custom module
headers use the same `PageLayout`/`PageHeader`/`PageBody`/`PageContent` components.

- Settings destinations use a density-specific 760/800/820px column, an icon/title/description page
  heading and a single PageBody scrollbar. `settings-catalog.ts` supplies both
  headings and the searchable grouped navigation. `PreferenceSection` panels
  include the group heading and divided rows; `PreferenceRow` owns control geometry.
- Other centered routes use the shared 1120px content width plus 24px gutters
  (16px at 960px); their frame headers and scope notes remain fixed.
- Full workspaces fill the available width/height; their actual tables, boards,
  source browsers and editors retain scroll ownership.
- Personal home uses the full width with global PageContent gutters, a shared
  12-column grid (task list 9, recent/todo sidebar 3), compact four-column metrics,
  and one explicit `PageBody.my-home-body` vertical scroll owner. Narrow windows
  stack the sidebar below the task list. Onboarding retains its own centered
  layout and must not inherit the dashboard route's width contract.
- Home summary cards are read-only. Source/status/text/order filters live only in
  the task list; status-derived phase aliases must not add another filter layer.
  Continue-task banners use an actual project binding or explicit local visit,
  never an inferred highest-priority task or an unverified online indicator.
  Task completion and physical archival stay distinct. Reminders and percentages
  require real records and defined denominators; never append demo signals to
  production queues. Todo drafts clear only after successful persistent saves.
- Nested Studio/flow/document/catalogue panes reuse `PageContent` with an explicit
  standard variant. Compact footers use `PageSection`, with no extra page padding.
  Task preview/expanded presentation changes only the shared content variant; do
  not change reader keys or mount another reader. Standalone documents also use
  the shared centered content container. ACP text measure remains its canonical
  conversation token inside the full workspace, rather than a private page width.

Do not add a leaf page max-width or compensate with nested outer padding. Change
the canonical page tokens and shared layout once. See [css-design.md](./css-design.md)
for component signatures, spacing and scroll alignment.

## Canonical design tokens

- `my-tokens.css` is hand-maintained and owns every visual value: dark/light
  colors, platform font stacks, text/line/weight scales, spaces, radii, dimensions,
  shadows, motion and stacking. Change a visual value there, not in a late page
  override. `my.css` imports tokens, shared components and shell composition.
- Tailwind `colors.my.*` maps variables and does not support alpha suffixes. Use
  semantic subtle/hover roles, never `bg-my-accent/20`.
- Accent is neutral inversion: dark mode white fill with dark ink, light mode dark
  fill with white ink. Use `text-my-on-accent` on accent fills, and
  `text-my-on-color` on semantic colored fills. No leaf palette/brand override.
  Green remains success/completion or user-label data only.
- Compact/Standard/Comfortable density uses13/14/15px UI/document/chat text
  with1.75 line height and the shared16px paragraph gap. Metadata, body, chat, document and
  activity consume global semantic roles. The current `--my-font-sans` stack uses
  locally bundled Inter for Latin/numerals and Source Han Sans SC for Chinese,
  followed by platform fallbacks; code and diagrams use their global mono roles.
- Type/radius classes are `text-my-*` and `rounded-my-*`. All ordinary rectangular
  controls and surfaces use `--my-radius-base` at10px, including cards, menus,
  composer containers, dialogs and badges. Density does not override this value;
  functional circles/tracks and zero-radius joins retain their geometry.
- Existing Tailwind spacing steps consume global `--my-space-*`. Headers use the
  shared density metrics; icon controls use26/28/30px. Add
  semantic metrics before introducing private geometry in a new component.
- Ordinary title bar and icon rail share `--my-bg-shell`; context navigation uses
  `--my-bg-sidebar`, and main content uses canvas. The shell owns a6px inset and10px
  radius through global tokens. Context/main panels join without double rounded
  corners. Navigation selection uses its dedicated subtle role. Transparent
  document/capsule/quick-todo roots do not inherit the ordinary shell frame.
- All roots expose `.my-root` plus theme and font-size attributes. Normal content
  wrappers inherit; do not nest an unconfigured style root that resets font size.
  Capsule/quick-todo roots preserve their transparent background.

## Theme, state and shared primitives

Theme comes from existing application settings and `data-my-theme`; the initial
root document also follows `html.dark`. `tpanel.my.ui` stores font/layout/group/
order/sidebar preferences and preserves unrelated legacy values. There is no
custom accent editor. Invalid/missing font size normalizes to standard; explicit
small/large and cross-window storage synchronization remain supported.

Use `my/ui.tsx` Button/Dropdown/Modal/Checkbox/Tabs/SearchInput/Avatar/Tooltip/
EmptyState. `Avatar tone="accent"` is mandatory for a neutral accent background;
user-colored identities retain on-color text. Work-item layout controls have
accessible names and pressed state. Use `my-control`, `my-input`, `my-chip`,
`my-kbd`, `my-scrollbar`, `my-pop`, `my-fade`, `my-peek-in` and shared component
classes instead of copying visual values. Keep visible neutral keyboard focus,
text selection for documents/input, reduced motion and disabled/error states.

Dropdown measures actual menu dimensions, clamps to the viewport and closes on
outside click/Escape/outer scroll. Menu-internal scrolling stays usable. Near a
header, position tooltip content below the trigger to avoid the window chrome.

## Brand and graphics

`resources/brand/mark.svg` is the canonical TP grid mark. `my/BrandMark.tsx` masks
that source with currentColor; PNG/ICO/favicon/tray assets are generated from the
same path. See `resources/brand/README.md`. TitleBar and Settings use BrandMark,
not Leaf. Windows packaging and runtime window/tray icons use committed assets.

State/priority/label colors are semantic tokens, including default state objects.
Custom label, identity and chart data can retain their own color values without
becoming an application brand palette. `StateGroupIcon`, `PriorityIcon`,
`LayoutIcon`, `NavIcon` and `WorkspaceMark` retain their existing semantics.

## Quality gates

Run static `npm run check:ui` plus `npm run typecheck` and `npm run build`.
Inspect actual navigation, ACP and reader interactions separately for contrast,
geometry/focus, six theme/font cases and same-source image assets.
Do not treat a synthetic/no-IPC preview as proof of vendor/native behavior.
The old ink/mist/leaf and private pixel font/radius classes are forbidden.

## Navigation and project scope contract (2026-10-16)

### 1. Scope / trigger

The ordinary window has one real project selector in the shared TitleBar, a fixed module
rail and a collapsible contextual sidebar. Its five primary modules, in order, are
首页 (home), 智能体 (agents), 任务 (tasks), 团队 (team), 知识 (knowledge); 设置
(settings) remains at the bottom. Iterations/intake/tools belong to tasks; analytics
and reports belong to team. Home has no context sidebar. The former task-parent tree and
`ProjectSidebar` are retired. Preserve the frontend and ACP contracts below.

### 2. Signatures

- `my/navigation.ts`: `PAGE_NAVIGATION satisfies Record<Page, PageNavigation>` is the shared
  source for route title, domain, scope, source notes, and command hints. Sidebar, PageFrame,
  and CommandPalette consume it. The route remains `useApp.page`.
- `PRIMARY_NAVIGATION` defines peer order. `activeModule(page)` resolves
  selection; `hasShellContext(page)` excludes page-owned knowledge/session browsers and
  modules without useful contextual navigation.
- `useMy.workItemsView: 'items' | 'iterations'` / `setWorkItemsView(view)` express navigation
  identity; `groupBy` only expresses grouping; `itemsGroupBy` preserves ordinary grouping.
- `TaskDetail({ presentation?: 'preview' | 'workspace' })` defaults to preview.
  `expandTaskWorkspace(origin, materialPath?)` preserves source `page`;
  `taskExpandOrigin !== null` means workspace. `returnFromWorkspace()` retains the current
  task in its source preview. `taskMaterialTarget` is a one-shot file target.
- `openSpecDocument(path)` captures `{ projectRoot, path }` in `specDocumentTarget`.
- Dropdown/Modal register stable `useId` layers through `useEscLayer`; a single ordinary
  App listener calls `dispatchEscKey`. Doc/capsule/quicktodo modes remain independent.
- Modal's DOM host is the nearest App-owned `.my-root`, found through its source
  anchor. Portals retain React context, so inactive retained sources still render
  no modal and do not restore focus. The backdrop must cover the whole native
  window's web surface, including the HTML title bar, without enabling dragging.
- `projectRootKey(root: string | null | undefined): string | null` is the frontend identity
  helper. Windows drive/UNC paths normalize separators and case; POSIX paths preserve case.
- `loadProjectPreferences(root, storage?)` / `saveProjectPreferences(root, prefs, storage?)`
  own root-scoped favorites and saved views.
- Main service: `listAcpSessions(projectRoot: string, limit = 20)`.
  Renderer IPC is `api.acpSessions()`; the handler supplies `getProjectRoot()`.
  Agent workspace/profile/runtime/permission and lazy-restore contracts are defined
  in [ACP runtime](../backend/acp-runtime.md). Keep drafts/scroll per root/session,
  IME-safe explicit sends, collapsed routine activity and visible approvals/errors.
  The compact workspace/Settings-only appearance, exact principal review, connection
  re-reference and reader host contracts are in [conversation-workspace](./conversation-workspace.md).
  ACP owns one module header instead of nesting another PageFrame; other framing remains unchanged.

### 3. Contracts

- Project name/path comes from the real snapshot and recent project settings, never the
  demo dataset's workspace/projects. An unbound browser preview says no project is open
  and disables native project-opening actions.
- Desktop and no-IPC preview share the header. Native controls/subscriptions require
  `hasIpc`; title-bar interactive areas are `no-drag`. Selecting the current canonical
  root closes the menu without reopening the project. Context collapse never hides or
  reorders the rail, and context does not repeat the main menu or project selector.
- Ordinary work items grouped by cycle remain work items; entering iterations is explicit.
- MyApp retains one stable task surface and a mounted source PageBody, hidden/inert while
  expanded. Capture/restore nested scroll and source focus. Task/DocPane/reader keys use
  root/task/file identity, never presentation; compact/full changes cannot restart the
  load/watch effect or discard displayed/base/latest revisions. External changes only
  prompt; explicit reading of the newer version changes displayed content.
- Material groups establish no approvals or successful checks. Exact implement.jsonl and
  check.jsonl belong to execution and validation; task.json/unknown records remain raw.
- Knowledge retains original paths, independent company retrieval and honest source labels.
  Project notes have no private ACL; remote previews do not claim local revisions. Spec
  displays loaded search/log content independently of editable tree selection. Cross-page
  targets must match root and reject parent traversal before any read.
- Knowledge browsing uses a collapsible directory tree and a paged document list. Local
  pages use the bounded `kbBrowse` snapshot; remote pages use the selected library and
  upstream directory/page. Keep partial coverage, old-service fallback and failed or
  pending searches distinct from empty results. Changing the project, scope, search or
  folder invalidates incompatible results; retained note drafts must not be silently lost.
  The directory toggle remains available at the tree boundary when folded.
- Reject stale note read/edit/save responses after selection changes. Failed note reads do
  not create blank replacement drafts. Existing kbSaveNote lacks expected-mtime support;
  do not imply it has Spec's external conflict protection.
- Escape dismisses only the top layer: dropdown/context/diff before task. Returning from
  workspace re-registers preview so the next Escape can close it. Do not combine independent
  component Escape listeners with global task dismissal.
- Retain the shared design language and canonical tokens. Use canvas for periphery, layers for
  context and surface-1 for the central task workspace. The desktop rail uses global
  geometry tokens: 48/52/54px module rail, 32/34/36px targets, 18/20/21px icons
  with1.7 stroke. The 44/48/50px header chrome keeps
  `--my-shell-chrome-size`; rail width uses its own `--my-module-rail-width` so a
  spacing adjustment does not increase every page header.
  The header brand slot shares the rail width. All module buttons inherit the shared
  `--my-control-radius`. Geometry follows the selected density preset;
  on short windows let primary navigation scroll while footer actions stay reachable. Keep full accessible names and hover labels rather than permanent
  10px captions; selected backgrounds/icons are restrained and neutral. Use neutral inversion for
  product emphasis; green remains a semantic success/completion or label color. The project name is a borderless title at rest, not a select/input;
  context rows use soft selection without persistent card borders/shadows. Measure actual
  foreground/background pairs; keyboard focus remains distinct from hover/selection.
- Scope identifies the page context, not a promise that every external result is filtered:
  Jira query results follow external criteria while imports target the current project;
  company knowledge and personal Q&A history have their own cross-project ranges. Keep
  these notes in route metadata. API chat history is local and cross-project; do not assign
  its old records to the current project. Application settings do not use project breadcrumbs.
- `MyApp` synchronizes the initial snapshot in a layout effect and subscribes to later
  snapshots. Initial null-to-root synchronization preserves an existing task deep link.
  Actual root changes clear prior selection/filter/peek state and remount project content.
- Root preferences use `tpanel.my.project.${encodeURIComponent(projectRootKey(root))}`,
  bounded to 50 favorites and 30 views. Legacy unscoped keys remain intact and are not
  automatically claimed by any project. Theme/layout preferences remain application-wide.
- Successful `session.openProjectPath` displays the snapshot before asynchronously refreshing
  recent projects. Only that settings field is merged; operation generation/root guards
  discard stale responses, including after close. History-read failure does not undo an open.
- ACP filters both active and persisted records by root **before** truncating historical
  results. The service remains a leaf and does not import application state.
- ACP page callbacks use a root generation and scoped session ownership. A root-bearing
  timeline permission event may arrive before the create/list reply. Only requests still
  pending in this process are actionable after re-entering a project. Old records, resolved
  requests, and timed-out requests cannot revive approvals. Project changes do not stop
  other projects' running agents.

### 4. Validation / error matrix

| Condition | Required behavior |
| --- | --- |
| No snapshot / no IPC | Honest unbound preview; native project opening disabled; no real project inferred |
| ACP list with no current root | IPC returns existing `noProject()` failure; service empty-root call returns no sessions |
| Corrupt or unavailable preference storage | Empty scoped preferences / in-memory fallback; no legacy deletion |
| Same task directory name in different roots | Independent favorites, views, and ACP records |
| Old list/settings/create response after a switch | Discard it, including A → B → A generations |
| Pending permission after returning to its root | Restore only while the current process still owns the pending request |
| Resolved, expired, or historical permission | Read-only history; never actionable |
| Recent-project read failure | Keep successful project open and existing settings |
| Task items or iterations | Keep the task module selected |
| Context collapsed | Keep fixed module order and accessible names |
| Pending update across preview/expand/return | Preserve displayed/base/latest and notice |
| Close task / deliberate navigation / actual root change | Clear presentation and one-shot targets |
| Spec target from old root or containing parent traversal | Reject without starting a read |
| Late note A reply after B/new note | Ignore A; retain current selection/draft |
| Company query fails | Keep local results and honest remote failure |
| Menu over central task + Escape | Close only the menu |
| 960px viewport | Primary actions reachable; context/auxiliary panels yield to reading |

### 5. Good / base / bad cases

- Good: switching between two roots with the same display name still shows distinct paths
  and independent task preferences. An older current-project ACP history remains discoverable
  even when other projects have more than 20 newer histories.
- Base: a project with no sessions shows an empty project list; application settings remain
  reachable through the unified tool menu and Ctrl+K.
- Bad: a late response from root A overwrites root B, or a persisted permission becomes an
  approval card after restart. Both are regressions.
- Good reading case: A is displayed, B arrives, preview/expand/return retain A with B
  pending until explicit “阅读新版”; reading B preserves the opening baseline A.

### 6. Required checks

Run `npm run typecheck`, `npm run build` and static `npm run check:ui`. Verify route/root identity, scoped persistence, legacy keys, initial focus and asynchronous recent-project failure/close behavior. Check filtering before history limits, foreign-action rejection and exact permission ownership/expiry.

Inspect actual early-event and generation handling, drafts/IME/follow-scroll, lazy restore, source/reader retention, Escape priority, stale replies and visible errors. Use real file changes and light/dark/focus/OS controls for native acceptance; temporary scripts and captures belong in OS TEMP.

### 7. Wrong vs correct

Wrong: display a global list as project conversations, then filter its first 20 records;
derive the selector from the demo workspace; maintain unrelated route-title lists in three places.

Correct: inject the real project root at the ACP IPC boundary, filter before limiting,
select projects from real snapshots/settings, and consume typed route metadata throughout the shell.

Wrong: `{workspace ? <Reader key="full" /> : <Reader key="preview" />}` creates separate
lifetimes. Correct: retain one task/reader instance, vary presentation/container props, and
register floating layers in the common Escape stack so only its top layer consumes Escape.


## Consolidated module navigation and personal home (2026-10-18)

### 1. Scope / trigger

Use the five-module ownership above for all existing routes and future roadmap entries.
Short fixed labels identify one concept; actual task/document names retain their full
values with truncation only in presentation. The project selector remains unique.

### 2. Signatures

- `ModuleLinks({domain:'agents'|'knowledge',agentView?,onAgentView?})` embeds in each
  existing source/session sidebar. It must not add a second shell sidebar or reader.
- `useMy.teamView`: `overview|members|activity|reports`; analytics is the existing
  `analytics` route owned by team. `toolView`: `git|run|architecture|studio`.
- `requestAgentView(view|null)` and `setAgentSessionTarget(id|null)` are one-shot
  presentation targets, reset on root changes and consumed in the active ACP scope.
- `loadNavigationLocation(root,developer)` / `saveNavigationLocation(...)` persist
  validated route/view preferences; `rememberModulePage(page)` remembers the last
  route of each module within the current project session.
- `rememberVisit({kind,target,title,archived?})`, `usePersonalHistory()` and
  `clearPersonalHistory()` own the local personal recent list.

### 3. Contracts

- Secondary navigation: agents 对话/角色/频道/问答; tasks 全部/迭代/接入/归档/工具
  plus separate collapsible 视图 and 收藏; team 概况/成员/动态/统计/报告;
  knowledge 资料/规范/公司库; settings 偏好/模型/引擎/集成/MCP.
- Task filters remain reachable in the page header with the sidebar open or closed.
  Intake switches 待办/Jira in the content header; tools switch Git/运行/架构/定制.
- Team is a people/workload/activity projection over existing tasks and developer
  records, without a second task lifecycle, priority, iteration or assignment editor.
  All previews reuse the existing task detail and preserve the source route.
- Statistics owns snapshot/flow/workflow views; label their denominators: snapshot
  excludes archived tasks and closed means completed; flow totals use the persisted
  transition log, daily trend 14 days, cycle metrics use current completed tasks.
  Workflow inactivity excludes planning, while efficiency inactivity includes it.
- Reports share one entry with 日报/周报 switches and reuse existing generators.
- Home defaults to real local access history; 收藏/我负责/我创建 use the existing
  task facts. Never relabel project-wide file updates as personal activity.
- Local keys are `tpanel.my.history.v1:<encoded normalized root>:<encoded developer>`
  (60 explicit opens max) and `tpanel.my.navigation.v1:<root>:<developer>`.
  Missing developer uses `local`, not a fabricated team identity. No document bytes,
  conversation messages, permissions, passwords or execution authorization are stored.
- Startup may restore validated presentation only once, when no explicit task/document
  target exists. Actual project-open/reset behavior remains owned by the main store.
  Restoration never sends, creates or starts an Agent. ACP history uses its original
  root/session/draft/reader identity; only explicit selection updates personal history.
- API Q&A remains local and cross-project; company sources retain their own scope.
  Existing reader/controller ownership and Settings-only ACP retention remain unchanged.

### 4. Validation / error matrix

| Input | Result |
| --- | --- |
| Unknown/corrupt stored navigation | Ignore it; retain the normal startup route |
| Initial task or document deep link | It takes precedence over saved navigation |
| Module switch within current root | Return to its last route and current view |
| Actual project/root switch | Clear transient section targets and preserve existing project reset |
| Same paths in different roots or developer names | Separate local history and navigation keys |
| No root, or storage denied | No project history is claimed; in-memory behavior remains usable |
| Empty personal history | Honest empty state; no mtime-based backfill |
| Removed task/history session | Hide missing task or show unavailable conversation without launching |
| Document history outside the current root/with parent traversal | Do not replay the read |

### 5. Good / base / bad cases

Good: 团队→成员→task preview retains the team source; iteration stays in tasks.
Base: choose 智能体→问答 and retain its existing cross-project history.
Bad: placing tasks in a second team editor, or restoring a conversation by creating a
new runtime session, or inferring personal reads from task modification times.

### 6. Review / validation

Verify ownership across the five modules, malformed navigation storage, initial deep-link precedence, root/developer isolation, stored iteration grouping, one-shot ACP targets and personal recent replay. Run `npm run typecheck`, `npm run build` and static `npm run check:ui`; keep any scripted validation in OS TEMP. Source review alone does not establish runtime acceptance.

### 7. Wrong vs correct

Wrong: selecting 迭代 highlights a separate rail item or team navigation links to a
second task manager. Correct: the rail highlights 任务 for items and iterations, team
owns its people/activity/statistics/report projections, and task actions share one owner.

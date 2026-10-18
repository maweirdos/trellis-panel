# Global shell UI conventions (`src/renderer/src/my/`)

Read this before modifying the shell or adding a `my.*` style consumer. Detailed
style ownership and executable checks live in [css-design.md](./css-design.md).

## Shared sidebar geometry

Context owners consume `useSidebarWidthStyle` and `SidebarResizeHandle`.
`tpanel.my.ui` stores a default275px width, clamped to220–400px, alongside existing
font/collapse preferences. Never replace an already stored width when the default
changes. Shell context and Knowledge/Spec/Channels/Chat/ACP-owned browsers must not
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

## Page layout contracts

All routes choose `full` or `centered` in `layout/PageLayout.tsx`'s exhaustive
`PAGE_LAYOUTS` registry. Page identity still belongs to navigation metadata; the
layout registry owns only geometry. `PageFrame` and pages with custom module
headers use the same `PageLayout`/`PageHeader`/`PageBody`/`PageContent` components.

- Centered: overview, analytics, team, archive, Settings, integrations, gateway and
  local developer tools. Shared content width is1120px plus24px horizontal gutters
  (16px at960px). The body scrolls while frame headers and scope notes stay fixed.
- Full: work items/iterations, intake, Jira, knowledge, spec, ACP, channels, API chat,
  architecture, Studio and models. Workspaces fill the available width/height;
  their actual tables, boards, source browsers and editors retain scroll ownership.
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
- Standard UI/document type is14px; small/large are13/15px. Chat uses14/15/16px
  with1.65 line height and a shared paragraph gap. Metadata, body, chat, document and
  activity consume global semantic roles. Default font is the platform sans stack
  (Segoe UI and CJK fallbacks on Windows); code and diagrams use their global mono
  roles. No bundled Inter or network font service.
- Type/radius classes are `text-my-*` and `rounded-my-*`. Buttons/rows use10px,
  panels12/16px, menus18px, composer20px and dialogs24px. Small badges keep4/6px.
- Existing Tailwind spacing steps consume global `--my-space-*`. Headers use the
  shared48px chrome metric; icon controls28px. Fields derive from type and padding. Add
  semantic metrics before introducing private geometry in a new component.
- Ordinary title bar and icon rail share `--my-bg-shell`; context navigation uses
  `--my-bg-sidebar`, and main content uses canvas. The shell owns a6px inset and16px
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

Run `npm run check:ui` plus typecheck/build and the relevant navigation, ACP and
reader smoke checks. The UI gate checks token closure/cycles, contrast, actual
Chromium geometry/focus, six theme/font cases and same-source image assets.
Do not treat a synthetic/no-IPC preview as proof of vendor/native behavior.
The old ink/mist/leaf and private pixel font/radius classes are forbidden.

## Navigation and project scope contract (2026-10-16)

### 1. Scope / trigger

The ordinary window has one real project selector in the shared TitleBar, a fixed module
rail and a collapsible contextual sidebar. Overview, intake, work items, iterations,
knowledge, conversations, team and analytics are peers. The former task-parent tree and
`ProjectSidebar` are retired. Preserve the frontend and ACP contracts below.

### 2. Signatures

- `my/navigation.ts`: `PAGE_NAVIGATION satisfies Record<Page, PageNavigation>` is the shared
  source for route title, domain, scope, source notes, and command hints. Sidebar, PageFrame,
  and CommandPalette consume it. The route remains `useApp.page`.
- `PRIMARY_NAVIGATION` defines peer order. `activeModule(page, workItemsView)` resolves
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
- Reject stale note read/edit/save responses after selection changes. Failed note reads do
  not create blank replacement drafts. Existing kbSaveNote lacks expected-mtime support;
  do not imply it has Spec's external conflict protection.
- Escape dismisses only the top layer: dropdown/context/diff before task. Returning from
  workspace re-registers preview so the next Escape can close it. Do not combine independent
  component Escape listeners with global task dismissal.
- Retain the shared design language and canonical tokens. Use canvas for periphery, layers for
  context and surface-1 for the central task workspace. The desktop rail uses global
  geometry tokens: 48px rail/header chrome, 32px targets, 18px icons with 1.7 stroke,
  and 8px gaps/insets. Rail width and header height share `--my-shell-chrome-size`.
  The header brand slot shares the rail width. Keep full accessible names and hover labels rather than permanent
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
| Work items grouped by cycle | Keep work-items module selected |
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

- `node scripts/smoke/navigation.mjs`: all 17 routes, Windows/UNC/POSIX identity, distinct
  roots with equal names, scoped persistence, legacy-key preservation, initial focus,
  root transitions, and asynchronous recent-project refresh/failure/close behavior.
- `node scripts/smoke/acp.mjs`: existing ACP service lifecycle and permission behavior.
- `node scripts/smoke/acp-project-scope.mjs`: mixed active/history roots, filtering before
  limit, trusted-root IPC injection, foreign action rejection, approval ownership and expiry.
- `node scripts/smoke/acp-ui.mjs`: actual ACP handlers for early events, root A→B→A,
  connection generations, live approval restoration, drafts, IME, follow-scroll projection,
  lazy restore, collapsed activity and visible errors. This is not mounted/native E2E evidence.
- `node scripts/smoke/task-presentation.mjs`: composed source/reader actions, target cleanup,
  exact known manifests and raw fallback. `node scripts/smoke/uiux-wiring.mjs`: actual
  component hook/event handlers for Escape priority, stale note replies, local-first results
  and Spec display/target guards. These are not mounted/native E2E evidence.
- Existing reading-session/task-reader/reader-wiring tests plus actual UI checks for file
  changes, same reader during presentation changes, scroll/focus, light/dark and OS controls.
  After development HMR, establish a fresh reader before judging live subscriptions; record
  anomalies without inferring their cause from a passing pure-state test.
- `npm run typecheck` and `npm run build`; browser walkthrough for navigation, Ctrl+K,
  scope notes, and collapse. Browser demo data is not proof of real IPC or vendor CLI behavior.

### 7. Wrong vs correct

Wrong: display a global list as project conversations, then filter its first 20 records;
derive the selector from the demo workspace; maintain unrelated route-title lists in three places.

Correct: inject the real project root at the ACP IPC boundary, filter before limiting,
select projects from real snapshots/settings, and consume typed route metadata throughout the shell.

Wrong: `{workspace ? <Reader key="full" /> : <Reader key="preview" />}` creates separate
lifetimes. Correct: retain one task/reader instance, vary presentation/container props, and
register floating layers in the common Escape stack so only its top layer consumes Escape.

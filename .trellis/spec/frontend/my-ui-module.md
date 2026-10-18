# 外壳 UI 约定（src/renderer/src/my/）

> 外壳 UI 约定。改动该模块或新增 `my.*` 色板消费前必读。

## 共享侧栏尺寸

模块上下文侧栏统一消费 `useSidebarWidthStyle` 与 `SidebarResizeHandle`，宽度保存在 `tpanel.my.ui`：默认260px，范围220–400px；沿用字体、折叠等既有偏好。外壳拥有的侧栏与 Knowledge/Spec/Channels/Chat/ACP 页面拥有的侧栏不重复渲染，不另设页面宽度；标题栏统一折叠/展开，页面不得再用独立布尔值阻断全局展开。拖动、键盘微调和双击复位使用同一组件，配色使用全局语义 token。

## 模块边界

- 整个模块自包含在 `src/renderer/src/my/`：类型(`types.ts`)、演示数据(`data.ts`)、
  自治 zustand store(`store.ts`)、图标(`icons.tsx`)、基础件(`ui.tsx`)、
  令牌与样式(`my-tokens.css` / `my.css`)、外壳(`layout/`)、界面(`pages/`)。
- 集成点：`App.tsx` 直接渲染 `my/layout/MyApp`（唯一应用壳，路由以主 store `page` 为事实）。
  **禁止在模块内 import 主 store 之外的跨域逻辑；window.api 仅经 `my/store.ts` 的动作桥接使用。**
- 开发验证入口：dev 渲染层 URL 加 `?my=1` 直渲染模块（无 IPC 依赖，可用浏览器截图；
  打包后 file: 协议自然失效）。

## 设计令牌（p.* 色板）

- `my-tokens.css` 为外壳自有设计令牌（浅/深两组挂在 `[data-my-theme='light'|'dark']`），**勿手改色值**。
- Tailwind 侧 `colors.my.*`（tailwind.config.js）映射到 `var(--my-…)`，**不支持 alpha 修饰符**。
- **品牌强调色 = 面板 leaf 绿**：`--my-bg-accent-*` / `--my-border-accent-*` / `--my-txt-accent-*`
  在 my.css 中覆写为 `rgb(var(--leaf-*-rgb))` 引用（非硬编码），自动随面板深浅主题切换；
  改品牌色只动 styles.css 的 leaf 变量。
- **排版/圆角令牌**：`--my-text-2xs..xl`（10/11/12/13/14/16px）与 `--my-radius-sm..xl`（4/6/8/12px）
  定义在 my.css，Tailwind 侧对应 `text-my-2xs..my-xl`、`rounded-my-sm..my-xl`。
  外壳与页面**禁止写死字号/圆角**（text-[13px]/rounded-md 等），一律用令牌类。
- 常用类：`bg-my-canvas`、`bg-my-layer-1(-hover/-active/-selected)`、`bg-my-layer-2/3`、
  `bg-my-surface-1/2`、`text-my-primary/-secondary/-tertiary/-placeholder`、
  `text-my-accent-text`、`bg-my-accent(-hover)`、`border-my-line(-1/-strong/-accent)`、
  `text-my-icon-*`、`text-my-danger-text/-warning-text/-success-text/-info-text`、
  `text-my-urgent/high/medium/low/none`（优先级色）、
  `bg-my-label-<fam>` / `text-my-label-<fam>-text` 等（fam: indigo emerald grey crimson yellow orange pink purple）。

## 主题机制

- 主题 = 模块根节点 `data-my-theme` 属性（不是主站的 `dark` 类）；初始值取持久化偏好，
  键 `tpanel.my.ui`（localStorage，遵循 `tpanel.` 前缀约定），存 theme/layout/groupBy/orderBy/customAccent。
- 自定义强调色通过根节点内联覆盖 `--my-bg-accent-primary` 实现。

## 视觉签名组件（icons.tsx，自绘 SVG）

- `StateGroupIcon`（backlog 虚线环 / unstarted 空环 / started 进度环+内圈 / completed 实心勾 / cancelled 实心叉）
- `PriorityIcon`（urgent 方块感叹号 / high·medium·low 三阶竖条 / none 横杠）
- `LayoutIcon`：List/Columns3/Table2/ChartGantt/Calendar；`NavIcon`：LayoutDashboard/Inbox/
  ChartColumn/ListTodo/RotateCw/Box/Eye/FileText/CircleAlert；`WorkspaceMark` 为自拟色块标记。
- 默认状态色：Backlog #A3A3A3 / Todo #3A3A3A / In Progress #F59E0B / Done #16A34A / Cancelled #EF4444。

## 交互约定

- 控制高度体系：`my-control`（28px）/`my-control-sm`（24px）/`my-control-lg`（32px）。
- 弹层动画类：`my-pop`（下拉）、`my-fade`、`my-peek-in`（peek 浮层）；滚动容器用 `my-scrollbar`。
- 下拉统一用 `my/ui.tsx` 的 `Dropdown`（fixed 定位 + 外点/Esc/滚动关闭；开箱后按菜单实测高度定位，
  下方空间不足贴上缘，水平收进视口——不要回退成估算高度）；
  已知测试陷阱：截图工具会触发 resize 导致弹层关闭——自动化验证时用「打开后立即
  evaluate 读取 `.my-pop` 内容或坐标点击」而非截图中间态。
- 字体：Inter Variable（`@fontsource-variable/inter`，注意本仓库 npm install 需 `--legacy-peer-deps`）。

## 旧体系禁用与迁移映射（2026-10 全量统一后生效）

旧面板样式体系（`styles.css` 的 ink/mist/leaf 色板与 `.card/.btn*/.field/.chip` 组件类）已清除，
壳内**禁止再引入**。等价对照：

- 亮/中/暗文本：`text-my-primary / secondary / tertiary / placeholder`；表面：`bg-my-canvas`（页底）、
  `bg-my-layer-1/2/3`（凹→凸）、`bg-my-surface-1/2`（输入/嵌入面）、`border-my-line(-strong)`。
- 品牌强调（原 leaf 系）：`bg-my-accent(-hover)`、`bg-my-accent-subtle(-hover)`、`text-my-accent-text`、
  `border-my-line-accent(-subtle)`。语义彩色一律成对：`bg-my-<sem>-subtle + text-my-<sem>-text`
  （sem: success/warning/danger/info），描边用 `border-my-line-<sem>`。
- 徽标基类 `my-chip`（my.css，20px 高）+ 语义色类；彩色标签用 label 族
  `bg-my-label-<fam> / text-my-label-<fam>-text / border-my-label-<fam>-border`。
- **`my.*` 色板不支持 alpha 修饰符**（禁写 `bg-my-accent/20`），半透明场景用 subtle/hover 令牌。
- 字号/圆角只用令牌类（`text-my-2xs..my-xl`、`rounded-my-sm..my-xl`），禁写死 px 与裸 tailwind 档位；
  按钮统一 `my/ui.tsx` 的 `Button`，输入用 SearchInput 同款工具类。
- styles.css 现仅存：leaf 变量（品牌色桥）、全局基础、令牌化的 `.md` 排版块、
  `[data-my-theme='dark']` 祖先选择器的 `.arch-*`、透明窗阴影类（`.capsule-*`）。
- 令牌作用域在 `.my-root`：CapsuleView/QuickTodoView 等独立窗口的根节点必须带
  `my-root` + `data-my-theme`（App.tsx 已处理，新增窗体时照做）。
- 类有效性自查：TSX 用到的 `my-*` 类必须能在构建产物 CSS 中找到（脚本
  `.trellis/tasks/10-15-unify-plane-uiux/check_my_classes.py`，可复用为门禁）。

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
- Retain current design language and generated tokens. Use canvas for periphery, layers for
  context and surface-1 for the central task workspace. The desktop rail uses 40px icon
  targets with 22px icons, full accessible names and hover labels rather than permanent
  10px captions; selected backgrounds/icons are restrained and neutral. Keep green for
  product emphasis. The project name is a borderless title at rest, not a select/input;
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

# Design — 参考 UI 克隆模块

## 1. 参考来源（已核实）

- 仓库稀疏克隆：`D:\my_demo\my-ref`（参考仓库 master，`apps/web`）。
- 设计令牌：`上游设计令牌包 0.9.7`（npm 包已解包到 `my-ref/_vendor/package`）。
  419 个浅色令牌 + 281 个深色覆盖，已用脚本解析 var() 链并把 oklch 转 hex，
  产物 `_vendor/extract/my-tokens.css`（`[data-my-theme=light|dark]` 两组）。
- 关键色板：浅色 canvas `#f2f2f3` / layer-1 `#fafafa` / layer-2 `#ffffff`、文本 `#0f0f10`、
  品牌蓝 `#006399`；深色 canvas `#0f0f10` / layer-1 `#191b1c` / layer-2 `#202223`、
  文本 `#e4e6e7`、品牌蓝 `#2893cc`。边框 subtle 浅 `#eaebec` / 深 `#222425`。
- 默认状态（apps/api/my/seeds/data/states.json）：
  Backlog `#A3A3A3`(backlog) / Todo `#3A3A3A`(unstarted) / In Progress `#F59E0B`(started) /
  Done `#16A34A`(completed) / Cancelled `#EF4444`(cancelled)。
- 字体：Inter Variable（@fontsource-variable/inter 新依赖）+ 系统 mono 回退。
- 静态尺度（上游令牌包 @theme）：header 高 3.25rem(52px)、控制高度 xs20/sm24/md28/lg32/xl36/2xl40px、
  control-radius 4/6/8px、shadow raised-100/200/300、overlay-100/200、radius-3xl 20px、
  弹层宽 204–400px。
- 状态图标（上游令牌包 icons/work-item-states）：外圈圆 + 组别图案（backlog 虚线点环、
  unstarted 空心圆、started 右半填充、completed 实心+对勾、cancelled X）。
  优先级图标（properties/priority-*）：三根圆角竖条高度 1/2/3，urgent=旗形红、
  none=虚线圆。布局图标（layouts）：list/board/grid(table)/timeline/timeline-calendar。

## 2. 模块结构（新增 `src/renderer/src/my/`）

```
my/
  index.ts              # export MyApp
  my.css             # 令牌 + 字体 + 滚动条 + 模块级样式（无全局污染，选择器前缀 .my-root）
  types.ts              # 领域类型
  data.ts               # 确定性演示数据（中文内容）
  store.ts              # zustand：导航状态 + 工作项视图状态 + 主题 + 弹层
  icons.tsx             # 状态/优先级/布局/品牌 SVG
  ui.tsx                # 基础件：Avatar/AvatarStack/Button/Dropdown/Tooltip/Modal/
                        #   Checkbox/LinearProgress/AreaChart 等单一文件内小件
  layout/
    MyApp.tsx        # 壳：WorkspaceSidebar + (ProjectSidebar|空) + 内容路由 + 弹层宿主
    WorkspaceSidebar.tsx
    ProjectSidebar.tsx
  pages/                # 每个界面一个文件（或目录）
    WorkItemsPage.tsx   # 工具栏 + 5 布局 + 筛选/显示/分组 + 创建弹窗
    IssuePeek.tsx       # peek-over 详情浮层
    CyclesPage.tsx
    ModulesPage.tsx
    ViewsPage.tsx
    PagesPage.tsx
    IntakePage.tsx
    YourWorkPage.tsx
    AnalyticsPage.tsx
    ProjectsPage.tsx
    InboxPage.tsx
    SettingsPage.tsx    # 项目/工作区/偏好外观 三组
  CommandPalette.tsx
```

## 3. 关键设计决策

- **自治 store**：`my/store.ts` 独立 `create`（不复用主 AppState）。理由：域完全独立、
  避免污染主 store 切片；持久化仅主题/布局偏好，键 `tpanel.my.ui`。
  与主站集成只通过 `Page` 联合类型新增 `'my'`。
- **主题机制**：MyApp 根节点挂 `data-my-theme`；初始值取主站 settings.theme
  （dark 默认），模块内 Appearance 设置可覆盖并持久化。Tailwind3 的 `dark:` 类不用于本模块
  （面板根已切 `dark` 类，两者隔离）。
- **Tailwind 扩展**：`tailwind.config.js` 增 `colors.p.*` 语义别名（canvas/surface-1/2、
  layer-1..3 及 hover/active/selected、accent(+hover/subtle)、primary/secondary/tertiary/
  placeholder 文本、icon-*、border subtle/strong/accent、danger/warning/success/info、
  priority 五色、label 8 色系），值指向 `var(--my-…)`；`boxShadow` 增 raised/overlay；
  `fontSize` 增 11/13px；fontFamily 增 Inter 前置。不与既有 ink/mist/leaf 冲突。
- **路由（模块内）**：store 维护 `{ scope: 'workspace'|'project', page: MyPage, projectId? }`，
  MyPage = 'your-work'|'inbox'|'analytics'|'projects'|'workspace-settings'|'profile'|
  'work-items'|'cycles'|'modules'|'views'|'pages'|'intake'|'project-settings'。
- **数据流**：data.ts 生成不可变演示集；store 内 workItems 可变（勾完成/改状态/创建），
  操作均为纯函数 set；peek/create 用 id 引用。
- **新依赖**：仅 `@fontsource-variable/inter`（构建期打包，离线可用）。
- **Electron 约束**：不用 window.api；不用 prompt/alert/confirm；滚动容器用项目既有
  scrollbar 样式类。

## 4. 兼容与回滚

- 集成面最小：`store/types.ts` Page 加 `'my'`、`Sidebar.tsx` 加入口、`App.tsx` 加 lazy 路由。
- 回滚 = revert 三处集成 + 删 `my/` 目录，不影响其他页面。

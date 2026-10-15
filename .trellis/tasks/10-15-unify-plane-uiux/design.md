# Design — 旧体系 → 外壳令牌体系迁移

## 1. 迁移映射表(唯一对照标准)

色板语义映射(`my.*` 令牌不支持 alpha 修饰符,半透明一律用 subtle/hover 令牌):

| 旧写法 | 新写法 | 说明 |
|---|---|---|
| `text-mist-50/100/200` | `text-my-primary` | 最亮文本 |
| `text-mist-300/400` | `text-my-secondary` | 次级文本 |
| `text-mist-500/600` | `text-my-tertiary` / `text-my-placeholder` | 弱化/占位 |
| `bg-ink-950/900` 页面底 | `bg-my-canvas` | |
| `bg-ink-850/800` 面板/卡片底 | `bg-my-layer-1/2` 或 `bg-my-surface-1/2` | 按层级语义选 |
| `bg-ink-700/600` 凹陷/悬停底 | `bg-my-layer-1-hover` / `bg-my-layer-2-hover` | |
| `border-ink-700/600/500` | `border-my-line` / `border-my-line-strong` | |
| `bg-leaf-dim/90`、`text-leaf` | `bg-my-accent(-hover)`、`text-my-accent-text` | 品牌强调 |
| `bg-leaf/20`、`bg-leaf-dim/10` | `bg-my-accent-subtle(-hover)` | 强调浅底 |
| `text-leaf-soft`、`border-leaf-dim/40` | `text-my-accent-text`、`border-my-line-accent(-subtle)` | |
| `text-blue-300/400`、`text-sky-300`、`bg-blue-500/15`、`bg-sky-500/10` | `text-my-info-text` + `bg-my-info-subtle`;作标签时用 `bg-my-label-indigo(-bg)` 族 | 信息/链接 |
| `text-emerald-400` 类 | `text-my-success-text` + `bg-my-success-subtle`;标签用 `bg-my-label-emerald` 族 | 成功 |
| `text-red/rose-*`、`text-amber-*` | `text-my-danger-text` / `text-my-warning-text` + 对应 `*-subtle` | 危险/警告 |
| `text-my-placeholder` 已有 | 保留 | |

组件类映射:

| 旧 | 新 |
|---|---|
| `.card` | `rounded-my-lg border border-my-line bg-my-layer-2` + `shadow-[var(--my-shadow-raised-200)]`;弹窗场景直接用 `my/ui.tsx` 的 `Modal` |
| `.btn / .btn-primary / .btn-ghost / .btn-outline` | `my/ui.tsx` `Button`(variant: primary/neutral/ghost/outline/danger) |
| `.field` | `SearchInput` 同款输入样式:`h-8 rounded-my-md border border-my-line bg-my-surface-1 text-my-sm focus:border-my-line-accent`(`select.field` 加 `Dropdown` 替代或保留 select 外壳套同款样式) |
| `.chip` | 徽标统一写法:`inline-flex h-[20px] items-center gap-1 rounded-my-sm px-1.5 text-my-xs font-medium` + 语义色(label 族 / info-subtle / layer-2) |
| `rounded-br-p-md`、`rounded-tl-p-md`(死类) | `rounded-my-md` |
| `text-[10.5px]`、`text-[13px]` 等写死 | `text-my-2xs..my-xl` |
| 裸 `text-xs/sm`、`rounded-md/lg/xl/2xl` | `text-my-xs/sm`、`rounded-my-md/lg/xl` |
| `.dark .xxx` 组件级选择器 | `[data-my-theme='dark'] .xxx`(html.dark 与 data-my-theme 同步,但后者才是壳的主题事实) |

优先级/状态徽标改用外壳签名:`text-my-urgent/high/medium/low/none`、
`my/icons.tsx` 的 `PriorityIcon`/`StateGroupIcon`(badges.tsx 迁移时对齐 WorkItemsPage 现有写法)。

## 2. 令牌作用域与特殊窗口

- `--my-*` 全部定义在 `.my-root` 作用域(my.css),`my.css` 经 MyApp 静态导入全局加载。
- 主应用根、DocWindow、`?my=1` 预览根已带 `my-root` + `data-my-theme`。
- **CapsuleView / QuickTodoView**(无框透明小窗):App.tsx 对应分支根节点补
  `my-root` 类与 `data-my-theme`(取 `useMy` 持久化主题),保持 `bg-transparent`;
  否则令牌不解析,迁移后颜色全失效。
- reader(ArtifactReader/JsonTree/CodeView)渲染在主应用 `my-root` 内,直接迁。

## 3. styles.css 收敛后职责

保留:leaf 变量(品牌色桥,勿动)、全局 scrollbar/reset、`input user-select`、
`.md` 排版块(色值改 my 令牌变量)、`.arch-*`(SVG 主题选择器改
`[data-my-theme='dark']` 祖先式)、`.capsule-*`、`.toast-enter`(随 Toasts 迁移评估,
若只剩 CSS 动画可留)。删除:`.card/.btn/.btn-primary/.btn-ghost/.btn-outline/.field/.chip`
(最后消费者迁完后)。

## 4. 改动面与并行切分(文件级互斥)

> 执行修订:孤儿实删 6 个(FocusTimer/TaskInsightsModal/HandoffModal/DispatchModal/
> PlannerModal/旧 CommandPalette);DiffModal 实为 TaskDetail 消费、Select 实为
> PlanningModal 消费、MermaidBlock/AsciiDiagramBlock 实为 MarkdownView 消费,均保留迁移。

```
主线独占(已完成):styles.css(.md 令牌化/.arch 主题化/删死 CSS)、my.css(+.my-chip)、
  App.tsx(胶囊/速记窗根补 my-root)、MarkdownView、MermaidBlock、AsciiDiagramBlock、
  Dialogs、badges、Select、my/ui.tsx(Button +autoFocus)、删 6 个孤儿
子代理 A:pages/TaskDetail.tsx、pages/DiffModal.tsx
子代理 B:pages/Chat.tsx、pages/Channels.tsx、pages/AcpConsole.tsx
子代理 C:pages/Jira.tsx、components/PlanningModal.tsx、pages/Team.tsx、
  pages/Archive.tsx、pages/Inbox.tsx
子代理 D:pages/Knowledge.tsx、pages/Spec.tsx、pages/Studio.tsx、
  components/FlowStudio.tsx
子代理 E:pages/Models.tsx、pages/Gateway.tsx、pages/Architecture.tsx、
  pages/Settings.tsx
子代理 F1:components/{Toasts,Onboarding,IntakeModal,ArtifactViewer,ErrorBoundary,
  CapsuleView,QuickTodoView}.tsx
子代理 F2:reader/{ArtifactReader,JsonTree,CodeView,ReaderVersionBar,
  DocumentDiffPanel,ContextManifestView,DocumentReader}.tsx、
  observation/{ObservationPanel,EvidenceBadge}.tsx
```

互斥规则:子代理只改分派清单内的文件;共享契约(my 令牌映射表、my/ui.tsx、
共享组件新样式)由主线完成后再派发,子代理只消费不修改。徽标基类用 `my-chip`
(my.css 新增),语义色随场景追加。

## 5. 兼容与风险

- **MarkdownView 双消费方**:面板 reader 与 my 模块 DocWindow 都用;`.md` 排版块
  改令牌后两处均渲染在 `my-root` 内(已核实),无作用域问题。
- **Dialogs(DialogHost)**:App 全局确认框宿主 + ObservationPanel/4 页面消费;
  保持导出 API 不变,只迁样式,避免跨层改动。
- **`.field` 的 select 特判**:原生 select 的 option 底色在深色令牌下用
  `color-scheme` 处理,不硬编码 ink 色。
- **快捷键/焦点行为**:迁移仅动 className 与组件替换,不动事件逻辑;
  Button 替换注意原 `type="button"` 与 disabled 语义保持。
- **回滚**:文件级互斥 ⇒ 任意子集可 `git checkout -- <file>` 单独回滚;
  孤儿删除独立成一步,可单独 revert。

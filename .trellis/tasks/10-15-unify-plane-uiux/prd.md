# PRD — 统一 Plane 外壳 UI/UX:旧样式页面与共享组件全量迁移

## 背景

面板前端存在两套 UI 体系并存:

- **A 套(目标体系)**:Plane 风格外壳 `src/renderer/src/my/` —— `my-*` 语义令牌
  (`my-tokens.css`/`my.css`,随 `data-my-theme` 深浅切换)+ `my/ui.tsx` 基础件
  (Button/Dropdown/Modal/Checkbox/Tabs/SearchInput/EmptyState/Tooltip/LabelPill)。
  外壳(双侧栏)、YourWork/WorkItems/Analytics、IssuePeek、CreateIssueModal、DocWindow 已达标。
- **B 套(旧体系)**:`styles.css` 的 ink/mist/leaf 色板 + `.card/.btn*/.field/.chip`
  组件类,散落在 14 个框架页、TaskDetail、5 个旧共享组件与 App 级浮层中。

审计结论(旧体系残留清单):

| 类别 | 文件 | 残留 |
|---|---|---|
| 重度偏离页 | TaskDetail(60 处)、Chat(28)、AcpConsole(31)、Channels(34)、Jira(彩色 chip)、Models(硬编码 blue/emerald/indigo) | mist/ink/leaf 类、`.chip`、硬编码色 |
| 完全未迁 | DiffModal(孤儿,无引用) | 通篇 ink/mist |
| 轻度残留 | Knowledge/Spec/Studio/Settings/Gateway/Inbox/Archive/Team/Architecture | 零星旧类、裸字号/圆角 |
| 旧共享组件 | MarkdownView(9 处消费)、Dialogs(6 处)、badges(4 处)、PlanningModal(Jira)、FlowStudio(Studio) | 旧色板/旧组件类 |
| App 级浮层 | Toasts、DialogHost(经 Dialogs)、Onboarding、IntakeModal、ArtifactViewer+reader(ArtifactReader/JsonTree/CodeView)、CapsuleView、QuickTodoView、ErrorBoundary | 旧色板;胶囊/速记窗根节点缺 `my-root`/`data-my-theme` |
| 孤儿死代码 | DiffModal、FocusTimer、Select、DispatchModal、PlannerModal、HandoffModal、TaskInsightsModal、MermaidBlock、AsciiDiagramBlock、旧 CommandPalette(components/) | 零引用 |

## Goal

壳内所有可达界面统一到 A 套体系:删除 B 套残留,页面/组件只消费 `my-*` 令牌与
`my/ui.tsx` 基础件;清理孤儿死代码。**功能逻辑、数据流、IPC、快捷键一律不动。**

## Requirements

- **R1 令牌统一**:壳内所有可达界面删除 `mist-*`/`ink-*`/`leaf(soft|dim|deep)`/裸
  `blue|sky|emerald|red|rose|amber-*` 色类与硬编码色值,按语义映射到 `my-*` 令牌;
  `my.*` 不支持 alpha 修饰符,半透明场景用 `*-subtle`/`*-hover` 令牌表达。
- **R2 排版/圆角令牌**:壳内禁止写死字号(`text-[13px]`、`text-[10.5px]`)与裸
  `rounded-md/lg/xl/2xl`;一律 `text-my-2xs..my-xl`、`rounded-my-sm..my-xl`;
  裸 `text-xs/sm` 迁移为 `text-my-xs/sm`。控制高度走 `my-control(-sm/-lg)` 体系。
- **R3 基础件归一**:页面内自造按钮/下拉/弹窗/确认框,能替换为 `my/ui.tsx`
  基础件的替换;不能直接替换的对齐其视觉与交互约定(`my-pop` 动画、外点/Esc 关闭、
  `my-scrollbar`、聚焦描边 accent)。
- **R4 共享组件迁移**:MarkdownView(含 `.md` 排版块)、Dialogs、badges、
  PlanningModal、FlowStudio 迁到 `my-*` 令牌;`.md`/`.arch-*` 等 styles.css 排版块
  改为主题感知(优先 `[data-my-theme]` 祖先选择器),供壳内消费。
- **R5 浮层迁移**:Toasts、DialogHost、Onboarding、IntakeModal、ArtifactViewer+reader、
  ErrorBoundary 迁令牌;CapsuleView/QuickTodoView(无框透明窗)根节点补
  `my-root` + `data-my-theme` 以启用令牌,保持 `bg-transparent` 窗体约束不变。
- **R6 死代码清理**:删除 10 个孤儿组件文件;`.btn*/.field/.card/.chip` 在最后
  消费者迁完后从 styles.css 删除。
- **R7 职责边界**:完成后 `styles.css` 只保留:leaf 变量(品牌色桥)、全局滚动条/
  基础 reset、主题感知的排版块(`.md`/`.arch-*`)、透明窗体样式;壳内组件不再消费
  ink/mist/leaf 类。
- **R8 不回归**:各页面核心功能(阅读、归档恢复、待办 intake、频道、Agent 会话、
  团队、Jira、架构图、定制中心、模型、网关、设置、聊天、任务详情抽屉)行为不变。

## Acceptance Criteria

- **AC1** `npm run typecheck`、`npm run build` 通过;孤儿删除后无悬空引用。
- **AC2** grep 门禁:`src/renderer/src/{pages,components,reader,observation,chat}` 与
  `my/` 下无 `mist-\d|ink-\d|bg-leaf|text-leaf|leaf-soft|leaf-dim|rounded-br-p-md`
  色板类残留;无 `text-\[\d+(\.\d+)?px\]` 写死字号(注释除外)。
- **AC3** 深/浅主题(`data-my-theme=light/dark`)逐页视觉验证:14 框架页 +
  TaskDetail 抽屉 + peek + 主要浮层,浅色下无旧 ink 深底残留,深浅两态均符合外壳观感。
- **AC4** 关键交互抽查:下拉/弹窗开关(Esc/外点)、输入聚焦描边、滚动条、按钮
  hover/禁用态与外壳一致;快捷键(C / / / Ctrl+K / Ctrl+B / ?)不回归。
- **AC5** 胶囊窗/速记窗仍为透明无框窗,且文字/控件随主题令牌着色。

## 范围外

- 不新增/删除页面与功能;不改 store、IPC、主进程。
- styles.css 的 leaf 变量与全局基础样式保持(品牌色桥,见 my-ui-module.md)。
- TitleBar 已达标,仅在波及时顺带核查。

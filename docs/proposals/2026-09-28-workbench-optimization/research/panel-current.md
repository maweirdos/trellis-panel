# Trellis Panel 产品现状盘点（2026-09-29）

> 调研范围：README.md、`src/renderer/src/App.tsx`、`pages/` 与 `components/` 全部文件清单、`src/shared/ipc-channels.ts`、`src/main/` 目录结构，外加 Sidebar / CommandPalette / TitleBar / store 切片 / QuickTodoView / IntakeModal / CapsuleView / Inbox 等关键文件的定向阅读。所有结论均标注出处；没读到的地方明说。

## 一、现有页面 / 功能全清单

侧边栏导航分四组（`src/renderer/src/components/Sidebar.tsx:26-61`），App.tsx 按需加载 17 个页面模块（`src/renderer/src/App.tsx:18-33`）。

### 工作台组

| 页面 | 文件 | 一句话说明 |
| --- | --- | --- |
| 概览 | `pages/Dashboard.tsx`（203 行） | 任务状态统计、当前任务卡片、AI 平台检测（Dashboard.tsx:148）、活跃 AI 会话列表（:162）、项目配置一览 workflow.md / config.yaml（:177-181）。 |
| 待办池 | `pages/Inbox.tsx`（237 行） | 需求收集池：待办存 `.trellis/todos/*.md`（Inbox.tsx:12-13），卡片支持复制 AI 认领指令（:27-35）、查看文档、标记已转任务、删除；工具栏「从 Jira 导入 / 新建待办」（:79-84）。 |
| 任务看板 | `pages/Tasks.tsx`（1790 行，全站最大页面） | 看板 / 阅读 / 列表 / 泳道四视图 + 拖拽切状态 + 阅读模式任务轨 PRD 排版 + 头部专注计时 / DoD 门禁 / 归档 / AI 拆分子任务 / AI 提交信息 / PR 描述（README:22，本次未逐行核对该页内部实现）。 |

### 知识组

| 页面 | 文件 | 一句话说明 |
| --- | --- | --- |
| 知识库 | `pages/Knowledge.tsx`（769 行） | 六个库 tab：我的笔记 / 需求库 / 规范库 / Wiki 库 / 归档库 / 公司库（WeKnora）+「全部」联合检索（Knowledge.tsx:50-56）；本地检索先上屏、公司库异步追加（:92-122）；AI 问答带来源引用、公司库来源标注（:228-275）。 |
| 规范文档 | `pages/Spec.tsx`（502 行） | 目录树 + 渲染 + 在线编辑（带冲突检测）+ 引用统计识别死规范（README:25；`spec:backlinks` IPC 见 ipc-channels.ts:42-44）。 |
| 归档 | `pages/Archive.tsx`（59 行） | 兼容新旧两种归档布局的只读浏览（README:29）。 |

### 协作组

| 页面 | 文件 | 一句话说明 |
| --- | --- | --- |
| AI 频道 | `pages/Channels.tsx`（429 行） | trellis channel 运行时看板：实时事件流、面板直接发消息（as panel-ui）、forum/chat 频道创建（Channels.tsx:120-126）、启动 worker / 软中断 / 删除；任务派发台走 `channel:dispatch`（ipc-channels.ts:60-65）。 |
| 团队协作 | `pages/Team.tsx`（856 行） | 动态流为主视图，效率分析 / 站会 / 周报收进次级 Tab（Team.tsx:30, 634）；周报分团队 / 个人两档（:472-473），支持生成、复制、保存（`report:generate/standup/save` IPC）。 |
| Jira 任务 | `pages/Jira.tsx`（448 行） | 我的待办 / 当前冲刺 / 自定义 JQL 查询（Jira.tsx:32），导入转 Trellis 任务、状态同步（:162-166）、进度评论回写（:301）、AI 规划入口（:285 → PlanningModal）。 |

### 系统组

| 页面 | 文件 | 一句话说明 |
| --- | --- | --- |
| 架构图 | `pages/Architecture.tsx`（285 行） | Trellis 工作流三泳道 SVG 可视化（会话 / 调度 / 生命周期），节点点击看触发时机与实现文件（README:35）。 |
| 定制中心 | `pages/Studio.tsx`（1335 行） | 八个 section：AI 工作流 / 工作流 / Slash 命令 / 子代理 / 技能 / 钩子 / config.yaml / 平台与团队（Studio.tsx:36-43）；AI 工作流部分由 `components/FlowStudio.tsx`（584 行）承载。 |
| 模型管理 | `pages/Models.tsx`（1134 行） | 多供应商 AI 模型配置页，内置官方模板（DeepSeek / 智谱 BigModel / Kimi 等，Models.tsx:24 起 OFFICIAL_TEMPLATES），支持连通性测试与模型启停。 |
| MCP 网关 | `pages/Gateway.tsx`（914 行） | 网关状态 / 上游连通测试 / 工具调试器（testTool）/ 安全配置 / spec 同步（ipc-channels.ts:108-116 gateway 域 7 通道对应）。 |
| 设置 | `pages/Settings.tsx`（1077 行） | 主题与 CLI 命令（Settings.tsx:869-899）、Jira 连接、GitLab 连接（:141-155）、AI / tpanel / hooks 安装、Web 看板开关等全局配置。 |

### 不在侧边栏的页面 / 视图

| 项 | 文件 | 一句话说明 |
| --- | --- | --- |
| AI 对话 | `pages/Chat.tsx`（769 行） | 左会话列表 / 中转录 / 下 Composer 三栏（Chat.tsx:28-30 注释）；模型按会话绑定；具备 agent 工具循环、权限卡、steer 插话、消息分支、截图、蒸馏沉淀（ipc-channels.ts:121-135 chat 域 14 通道）。**入口只有 Ctrl+K 命令面板**（CommandPalette.tsx:50「AI 对话」），侧边栏无此项。 |
| 任务详情 | `pages/TaskDetail.tsx`（936 行） | 24 字段编辑 + 暂存 Diff（DiffModal.tsx）+ Git 状态 / 建分支 + 写冲突检测 + GitLab MR 状态与创建（TaskDetail.tsx:380-386, 819-824）；作为右侧悬浮层只挂在 dashboard / archive / inbox 三页（App.tsx:149-155），tasks 页一体化内置。 |
| 胶囊模式 | `components/CapsuleView.tsx`（520 行） | 置顶小卡片：当前任务 + 子任务进度 + 一键回主面板；从 TitleBar 画中画按钮进入（TitleBar.tsx:51）。 |
| 速记窗 | `components/QuickTodoView.tsx`（277 行） | 全局热键（默认 Alt+N，`src/main/index.ts:281`）呼出的 540×420 无框 Markdown 迷你窗：整段一条或按行拆分多条落 `.trellis/todos/`，Esc / 失焦隐藏、草稿 localStorage 保留（QuickTodoView.tsx:38-42 注释）。 |
| 命令面板 | `components/CommandPalette.tsx`（135 行） | Ctrl+K 全局呼出：13 个页面跳转 + 任务搜索（前 200 条）+ 3 个动作（新建待办 / 重扫描 / 切换主题）（:38-71）。 |
| 产物查看器 | `components/ArtifactViewer.tsx`（302 行） | 多标签 Markdown / Mermaid / ASCII 线框 / 代码查看，preview / pinned 双模式（store/types.ts:46-50 ViewerTab）。 |
| 需求录入 | `components/IntakeModal.tsx`（159 行） | 新建待导向导，可直达 PlanningModal「AI 规划成任务」需求直通车（IntakeModal.tsx:14-19 注释、:34-40）。 |

### 全局共享组件（components/ 清单）

TitleBar、Sidebar（可折叠，Sidebar.tsx:92）、Onboarding、Toasts、DialogHost（confirmDialog / promptDialog，Studio.tsx:509 有使用）、MarkdownView、MermaidBlock、AsciiDiagramBlock、CodeView、JsonTree、FlowStudio、PlanningModal、DoDModal、FocusTimer、CapsuleView、QuickTodoView、CommandPalette、IntakeModal、ArtifactViewer、badges、Select。

## 二、跨页面共享的能力

数据面单一事实源是 zustand store（`src/renderer/src/store/`，切片见 types.ts:176 组合），主进程事件经 `project:snapshot` 全量推送（ipc-channels.ts:209）。

1. **项目快照**：`project:snapshot` 事件全量推送，SessionSlice 持有（store/types.ts:57-58），watcher 防抖监听（README:123-124）；所有页面从 useApp 读同一份。
2. **待办**：`.trellis/todos/*.md` 落盘，`todo:list/save/delete`（ipc-channels.ts:33-37）+ TodosSlice；速记窗、待办池页、命令面板「新建待办」、IntakeModal 四处共用同一数据。
3. **知识库（五库 + 公司库）**：`kb:search/saveNote/deleteNote/qaHistory/qaSave/qaClear`（ipc-channels.ts:77-84）；Knowledge 页、AI 对话（先查知识库再回答）、AI 规划（PlanningModal / Jira）共用。
4. **AI 工作流（Flow）**：`flow:*` 12 个 invoke + `flow:output/flow:done` 事件流（ipc-channels.ts:85-96, 221-222）；目前只有定制中心的 FlowStudio 一个 UI 消费方。
5. **AI 频道**：`channel:list/send/action/dispatch`（ipc-channels.ts:60-65）；Channels 页 + 任务派发台。
6. **应用内 AI**：`ai:chat/test/fetch-models/test-model/prdDraft/summary/plan/splitEpic/commitMsg/prDesc`（ipc-channels.ts:137-148）；被任务页（拆分 / 提交信息 / PR 描述）、Jira AI 规划、知识库问答、Chat 页共用，模型由 Models 页 / settings.ai.providers 统一配置。
7. **AI 对话（Chat 域）**：14 个 invoke + `chat:output/done/permission/steer` 四个事件（ipc-channels.ts:121-135, 217-225）；ChatSlice 全局挂 store，Ctrl+. 全局中止（App.tsx:60-63）。
8. **速记窗**：主进程独立 BrowserWindow（`src/main/index.ts:153-209`），`quicktodo:shown` 事件回焦（ipc-channels.ts:229），热键可配（index.ts:281）。
9. **胶囊模式**：`win:capsule` + `capsule:onTop/setShape/resize/close`（ipc-channels.ts:168-179）。
10. **桥接**：深链 `trellis-panel://` + tpanel 命令安装 + hooks 写入 + `bridge:focus-task` 任务聚焦事件（ipc-channels.ts:160-163, 213；App.tsx:72-86 消费）。
11. **WeKnora 公司库联动**：`weknora:test/search/listDocs/read/testMcp`（ipc-channels.ts:101-107）；Knowledge 公司库 tab、AI 规划上下文、归档沉淀共用。
12. **知识库 MCP**：`kbmcp:install/status`（ipc-channels.ts:97-99），把四库暴露给 Claude Code / Codex。
13. **MCP 网关**：gateway 域 7 通道（ipc-channels.ts:108-116），独立子服务目录 `src/main/services/gateway/`。
14. **访问令牌**：`access:status/rotateToken`（ipc-channels.ts:117-120），深链防伪 & tpanel 认证。
15. **Jira / GitLab 双集成**：`jira:*` 5 通道（:187-193）、`gitlab:test/taskStatus/createMr`（:194-198）；GitLab 的 UI 在 Settings 连接配置 + TaskDetail 的 MR 状态 / 创建 MR（TaskDetail.tsx:755, 819-824）。
16. **Git 能力**：`git:taskInfo/createBranch`（:48-51），任务详情页消费。
17. **报表 / 分析**：`analytics:get`、`report:generate/standup/save`（:52-59），Team 页消费。
18. **CLI 子进程**：`cli:run/abort` + `cli:output/done` 事件流（:156-159, 215-216），preload 仍暴露 runCli/abortCli/onCliOutput/onCliDone（`src/preload/index.ts:53-56`）——**但渲染层 api.ts 与所有 tsx 均无调用**（本次 grep 证实，见空缺 #1）。
19. **Web 只读看板**：`httpapi` 本地 HTTP 服务（README:41-45，ipc/httpapi.ts 存在）。
20. **Shell 工具**：`shell:reveal/openInEditor/openExternal` + `util:clipboard`（ipc-channels.ts:199-203, 165-166），多处页面共用。
21. **收件箱（遗留）**：InboxSlice + `inbox-storage.ts` 对快照做 reconciliation（已删任务剔除、外部推进自动 accepted，inbox-storage.ts:5-11）；`inbox:new` 事件在主进程已无发送方（ipc-channels.ts:230-234 注明遗留），App.tsx:87-92 仍订阅。

## 三、明显的能力空缺点

按证据强度排列，前两条是「文档宣称与代码不符」的硬差异：

1. **CLI 终端 UI 已不存在，但 README 仍宣称有**。README:32 功能总览列「CLI 终端 | 运行 trellis 命令，实时输出、可中止」；`pages/` 下无对应页面（17 个页面文件里没有 CLI 页），`src/renderer/src/api.ts` 无 cli 方法，全部 tsx 中 grep `cliRun|cliAbort|cli:` 零命中。而主进程链路完整保留：`src/main/services/cli.ts`、`src/main/ipc/cli.ts`、ipc 注册表 cli 域、preload 四个方法。即：**前后端断链，能力在但无入口**（Settings.tsx:894-899 只剩 cliCommand 配置项）。
2. **Chat 页（769 行、14 个 IPC 通道的重头能力）没有侧边栏入口**。Sidebar GROUPS（Sidebar.tsx:26-61）四组 14 项里没有 chat；唯一入口是 Ctrl+K 命令面板（CommandPalette.tsx:50）。发现路径深，新用户基本撞不上。
3. **命令面板页面清单缺 models / gateway**。CommandPalette.tsx:38-52 的 pages 数组有 13 项，不含「模型管理」「MCP 网关」；这两个页只能靠侧边栏点进。
4. **命令面板动作覆盖极窄**。动作组仅 3 个：新建待办 / 重新扫描 / 切换主题（CommandPalette.tsx:69-71）；搜索面也只覆盖页面名 + 任务标题（:57-68），不搜知识库、规范、归档、频道——与面板庞大的能力面不匹配。
5. **`inbox:new` 死事件路径**。ipc-channels.ts:230-234 自己注明「主进程当前无发送方」，但 App.tsx:87-92 仍订阅并跳转 inbox 页，InboxSlice + inbox-storage.ts 的 reconcile 逻辑仍在维护——要么删干净要么恢复发送方，现在是半悬空状态。
6. **README 架构段落落后于代码**。README:94-112 的 services 清单缺 `activity.ts / chat.ts / chat-store.ts / fence.ts / git.ts / gitlab.ts / proxy.ts / report.ts / todo.ts` 及 `access/`、`gateway/` 两个子目录（本次 `dir src/main/services` 实测存在）。GitLab 集成（3 个 IPC 通道 + Settings 配置 + TaskDetail MR 按钮）在 README 全文只字未提。
7. **概览页相对单薄**。Dashboard.tsx 全站最薄的主页面之一（203 行），静态统计为主；相比 Tasks（1790 行）/ Studio（1335 行）等页承载的密度，概览没有承担「工作台首页」的聚合作用（此条为文件规模与内容的观察，非功能错误）。

### 本次没做 / 读不到的

- 未逐行核对 Tasks.tsx（1790 行）、Studio.tsx（1335 行）、Settings.tsx（1077 行）的内部完整实现，相关描述引自 README + 文件头部 / 定向 grep。
- 未运行应用本身（纯静态盘点），所有「能力可用」的判断基于代码链路存在（IPC 注册 → preload → api.ts → 页面调用），未做运行时验证。
- `src/main/services/` 下 `activity.ts / fence.ts / proxy.ts / access/ / gateway/` 等仅确认文件存在与 IPC 通道对应，未深入读实现。

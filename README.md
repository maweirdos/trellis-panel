# Trellis Panel

> Trellis 工作流可视化面板 — Windows 桌面客户端（Electron + React + TypeScript）

Trellis Panel 是 [Trellis](https://docs.trytrellis.app/zh/start/install-and-first-task)（面向 AI coding 平台的工作流框架）的本地可视化面板。它直接读取项目中的 `.trellis/` 目录，把任务、规范文档、开发者工作区和 AI 会话以图形界面呈现，并通过桥接层与 codex / zcode / claude 等 AI 工具实时联动、与 Jira 双向同步。

## 功能总览

| 页面 | 能力 |
| --- | --- |
| 概览 | 任务状态统计（全中文）、当前任务、AI 平台检测、活跃 AI 会话、项目配置一览 |
| 任务看板 | **看板 / 列表 / 泳道** 三种视图；固定高度列内滚动；拖拽切换状态；优先级/子任务进度/产物数/Jira 徽章 |
| 任务详情 | 右侧悬浮层；24 字段中文化；**修改暂存 + Diff 预览**；**Git 状态**（领先/落后、合并检测、提交列表、一键建分支）；**写冲突检测**（外部修改不覆盖）；一键交给 Codex / ZCode / Claude |
| 产物查看 | 全屏查看器：Markdown + **Mermaid** + **ASCII 线框图**渲染，原文/渲染切换、复制 |
| 规范文档 | 目录树 + 渲染 + **在线编辑（带冲突检测）** + **引用统计**（识别从未被引用的死规范） |
| 工作区 | 开发者日志与共享索引 |
| 归档 | 兼容新旧两种归档布局 |
| 团队协作 | 三标签：动态流 / **效率分析**（交付周期、流转热度、停滞预警）/ **周报生成**（团队/个人，Markdown 导出） |
| AI 频道 | **trellis channel 运行时看板**：实时事件流（create/message/progress/done），面板直接向频道发消息驱动 AI worker |
| Jira 任务 | 我的待办 / **当前冲刺** / 自定义 JQL；导入任务（**可配置状态映射**）；双向同步；流转推送；进度回写评论；密码 DPAPI 加密 |
| CLI 终端 | 运行 trellis 命令，实时输出、可中止 |
| 胶囊模式 | 置顶小卡片：当前任务 + 进度 + AI 快捷接手 |
| 桌面集成 | **托盘常驻**（关闭最小化到托盘）、**全局快捷键**、开机自启、**自动检查更新** |

## MCP Server（AI 原生接入）

设置页一键启动本地服务（默认端口 39573，Bearer 令牌鉴权）：

- **HTTP MCP**：`POST http://127.0.0.1:39573/mcp` — 工具：`get_tasks` / `get_task` / `update_task_status` / `search_spec` / `read_spec` / `get_overview`
- **stdio MCP**：`tpanel mcp` — 标准 stdio 桥接，适配 codex / zcode / claude 的 `mcpServers` 配置
- **只读 Web 看板**：`GET /` — 自动刷新的团队看板页，可选局域网开放

设置页提供一键复制的 codex / claude 客户端配置。

## AI 工具桥接（codex / zcode / claude）

1. **深链协议** `trellis-panel://`（带每安装令牌 `&t=` 防伪）：
   `open-task?dir=…` / `notify?text=…` / `task-event?path=…`
2. **tpanel 命令**：`tpanel notify|open|task-event|mcp`（设置页一键安装/更新）
3. **Trellis hooks**：一键写入 `.trellis/config.yaml`，任务生命周期事件实时推送面板
4. **面板 → AI**：任务详情「Codex / ZCode / Claude 接手」，自动注入任务上下文到 Windows Terminal

## Jira 集成

- 查询：我的待办 / 当前冲刺 / 自定义 JQL
- **导入**：一键转为 Trellis 任务（状态按 statusCategory 或自定义映射表转换）
- **同步**：Jira → Trellis 状态同步（可开 10 分钟自动同步）；Trellis → Jira 流转推送
- **回写**：Trellis 进度以评论形式发到 Jira
- 安全：密码经 safeStorage（DPAPI）加密存储

## 快速开始

```bash
npm install
npm run dev        # 开发调试
npm run build      # 生产构建
npm run dist:dir   # 便携目录版 → release/win-unpacked/
npm run dist       # NSIS 安装包 → release/TrellisPanel-Setup-<version>.exe
npm run typecheck  # 类型检查
```

示例项目：`examples/demo-project/`（含 Mermaid/ASCII 产物、Jira 关联任务），可直接用面板打开体验。

## 架构

```
src/
├─ shared/types.ts        # IPC 契约：task.json 24 字段 Schema、Jira/桥接/胶囊类型
├─ main/                  # Electron 主进程（所有文件 I/O、网络、子进程）
│  ├─ index.ts            # 窗口（主窗/胶囊窗）、深链协议、IPC 注册
│  └─ services/
│     ├─ scan.ts          # .trellis 扫描器 + task.json 白名单写回
│     ├─ watcher.ts       # chokidar 监听 + 防抖
│     ├─ cli.ts           # trellis CLI 子进程（流式输出、进程树终止）
│     ├─ jira.ts          # Jira REST API v2（搜索/流转/评论）
│     ├─ bridge.ts        # 深链解析、tpanel 安装、hooks 写入、通知广播
│     └─ store.ts         # 设置持久化
├─ preload/index.ts       # contextBridge 类型化 API
└─ renderer/src/
   ├─ pages/              # Dashboard / Tasks / TaskDetail+Diff / Spec / Workspace
   │                      # / Archive / Team / Jira / Cli / Settings
   └─ components/         # CapsuleView / ArtifactViewer / MermaidBlock / MarkdownView / Toasts ...
```

### 性能与稳定性设计

- 主进程承担全部 I/O；快照式 IPC；监听防抖 300ms；CLI 长输出 10fps 批量刷新；
- Mermaid 按需动态 import（不进首屏 chunk）；
- 读取保护：扩展名白名单 + 路径包含校验 + 5MB 上限；写回保留未知字段；
- 看板列固定高度内滚动、悬浮详情不挤压布局、窗口缩放以 flex/min-w-0 约束不乱版。

## License

MIT

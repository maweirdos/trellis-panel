# Trellis Panel

> Trellis 工作流可视化面板 — Windows 桌面客户端（Electron + React + TypeScript）

Trellis Panel 是 [Trellis](https://docs.trytrellis.app/zh/start/install-and-first-task)（面向 AI coding 平台的工作流框架）的本地可视化面板。它直接读取项目中的 `.trellis/` 目录，把任务、规范文档、开发者工作区和 AI 会话以图形界面呈现，并通过桥接层与 codex / zcode / claude 等 AI 工具实时联动、与 Jira 双向同步。

## 功能总览

| 页面 | 能力 |
| --- | --- |
| 概览 | 任务状态统计（全中文）、当前任务、AI 平台检测、活跃 AI 会话、项目配置一览 |
| 任务看板 | **看板 / 列表 / 泳道** 三种视图；固定高度列内滚动，不再无限拉长页面；拖拽切换状态；优先级/子任务进度/产物数/Jira 徽章 |
| 任务详情 | 右侧**悬浮层**（不挤压看板）；24 字段中文化展示；**修改暂存 + 保存前 Diff 预览**；子任务勾选；一键把任务交给 Codex / ZCode / Claude |
| 产物查看 | **全屏查看器**：大空间阅读，Markdown 渲染，**Mermaid 图表**与 **ASCII 线框图**友好渲染，原文/渲染切换、一键复制 |
| 规范文档 | `.trellis/spec/` 目录树 + Markdown/Mermaid 渲染 |
| 工作区 | 开发者日志（journal-N.md）与共享索引 |
| 归档 | 兼容新旧两种归档布局（`.trellis/archive/` 与 `.trellis/tasks/archive/YYYY-MM/`） |
| 团队协作 | 全队当前焦点、成员工作量条形图、团队动态流（任务/日志/AI 会话）、成员任务明细、任务分享（Markdown 到剪贴板） |
| Jira 任务 | 连接 Jira Server/DC：我的待办查询（自定义 JQL）、**导入为 Trellis 任务**（按状态类别自动映射）、**Jira ↔ Trellis 状态同步**、Trellis 状态推送 Jira 流转、进度回写 Jira 评论 |
| CLI 终端 | 在项目目录运行 trellis 命令，实时输出、可中止 |
| 胶囊模式 | 置顶小卡片常驻：当前任务 + 子任务进度 + Codex/ZCode 快捷接手 + 回到主面板 |
| 实时同步 | chokidar 监听 `.trellis/`，防抖增量推送；AI 工具改动任务即刻反映 |

## AI 工具桥接（codex / zcode / claude）

三条通道，让 AI 应用"调起"面板：

1. **深链协议** `trellis-panel://`
   - `trellis-panel://open-task?dir=<任务目录绝对路径>` — 聚焦面板并打开该任务
   - `trellis-panel://notify?text=消息` — 弹出面板通知
   - `trellis-panel://task-event?path=<task.json 路径>` — AI 更新任务后推送事件（面板重扫 + 通知）
   任意程序可执行 `start trellis-panel://open-task?dir=...`（Windows）。

2. **tpanel 命令**（设置页一键安装到 `%APPDATA%\npm`，已在 PATH）
   ```bat
   tpanel notify "任务已完成"
   tpanel open D:\proj\.trellis\tasks\09-06-xxx
   tpanel task-event        :: 读取 %TASK_JSON_PATH%（供 trellis hooks 调用）
   ```

3. **Trellis 任务 hooks**（设置页一键写入 `.trellis/config.yaml`）
   ```yaml
   hooks:
     after_create:  ["tpanel task-event"]
     after_start:   ["tpanel task-event"]
     after_finish:  ["tpanel task-event"]
     after_archive: ["tpanel task-event"]
   ```
   AI 工具在任务生命周期内每次落盘，面板都会实时收到通知并刷新。

反向：面板里的任务详情提供「Codex / ZCode / Claude 接手」按钮——自动组装任务上下文提示词并在 Windows Terminal 中拉起对应 CLI。

## Jira 集成

设置页填写 Jira Server 地址 + 用户名/密码（或 Token），即可：

- 查询「我的待办」（默认 `assignee = currentUser()`，支持自定义 JQL）
- 一键**导入为 Trellis 任务**：标题/优先级/负责人自动映射，`meta.jiraKey` 建立关联
- **Jira → Trellis**：按 statusCategory 同步状态（待办→规划中、进行/待测→进行中、完成→已完成）
- **Trellis → Jira**：把 Trellis 状态推送为 Jira 流转（开始/评审/完成）
- **回写进度**：把 Trellis 任务进度以评论形式发到 Jira

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

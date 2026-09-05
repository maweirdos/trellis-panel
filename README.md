# Trellis Panel

> Trellis 工作流可视化面板 — Windows 桌面客户端（Electron + React + TypeScript）

Trellis Panel 是 [Trellis](https://docs.trytrellis.app/zh/start/install-and-first-task)（面向 AI coding 平台的工作流框架）的本地可视化面板。它直接读取项目中的 `.trellis/` 目录，把任务、规范文档、开发者工作区和 AI 会话以图形界面呈现，并支持状态写回与 CLI 调用。

![tech](https://img.shields.io/badge/Electron-33-47848F) ![tech](https://img.shields.io/badge/React-18-61DAFB) ![tech](https://img.shields.io/badge/TypeScript-5-3178C6) ![tech](https://img.shields.io/badge/TailwindCSS-3-06B6D4)

## 功能

| 页面 | 能力 |
| --- | --- |
| 概览 | 任务状态统计（规划/进行/评审/完成）、当前任务、AI 平台检测、活跃 AI 会话、项目配置一览 |
| 任务看板 | 按 `task.json` status 四列看板；**拖拽卡片切换状态（写回 task.json）**；搜索、按负责人/优先级过滤 |
| 任务详情 | 完整 24 字段展示与行内编辑（标题/状态/优先级/负责人/分支/PR/描述/备注）、子任务勾选、任务产物（prd.md / research / *.jsonl）预览 |
| 规范文档 | `.trellis/spec/` 目录树 + Markdown 渲染（GFM：表格/任务列表/代码块） |
| 工作区 | `.trellis/workspace/` 开发者日志（journal-N.md）与共享索引浏览 |
| 归档 | 兼容新旧两种归档布局（`.trellis/archive/` 与 `.trellis/tasks/archive/YYYY-MM/`） |
| CLI 终端 | 在项目目录运行 trellis 命令（platforms / workflow / mem …），实时输出、可中止 |
| 实时同步 | chokidar 监听 `.trellis/` 变更，300ms 防抖后自动重扫并推送 |
| 其他 | 自定义无边框标题栏、深/浅主题、最近项目、打包为 NSIS 安装包 |

## 快速开始

### 环境要求

- Node.js ≥ 20（开发 Windows 11 上以 Node 24 验证）
- 已安装 Trellis 的项目（`npm i -g @mindfoldhq/trellis && trellis init`）

### 开发运行

```bash
npm install
npm run dev        # electron-vite dev，热更新
```

### 生产构建与打包

```bash
npm run build      # 构建主进程 / preload / 渲染端到 out/
npm run dist:dir   # 便携目录版 → release/win-unpacked/Trellis Panel.exe
npm run dist       # NSIS 安装包 → release/TrellisPanel-Setup-<version>.exe
npm run typecheck  # 主进程 + 渲染端类型检查
```

## 架构

```
src/
├─ shared/types.ts        # IPC 契约：task.json 24 字段 Schema、快照/设置/事件类型
├─ main/                  # Electron 主进程（所有文件 I/O 与子进程都在这里）
│  ├─ index.ts            # 窗口创建、IPC 注册、单实例锁
│  └─ services/
│     ├─ scan.ts          # .trellis 扫描器：任务/归档/规范树/工作区/会话 + task.json 写回
│     ├─ watcher.ts       # chokidar 监听 + 防抖增量推送
│     ├─ cli.ts           # trellis CLI 子进程（流式输出、进程树终止）
│     └─ store.ts         # 设置持久化（userData/settings.json）
├─ preload/index.ts       # contextBridge 暴露类型化 API（contextIsolation 开启）
└─ renderer/src/          # React 18 渲染端（零 Node 访问）
   ├─ store.ts            # zustand 全局状态
   ├─ pages/              # Dashboard / Tasks / TaskDetail / Spec / Workspace / Archive / Cli / Settings
   └─ components/         # TitleBar / Sidebar / MarkdownView / badges
```

### 性能与稳定性设计

- **主进程承担全部 I/O**：渲染进程通过 contextIsolation 与主进程通信，不接触 Node API；
- **快照式 IPC**：扫描结果一次性序列化推送（几十个任务的 JSON 在毫秒级），避免碎片化消息；
- **增量监听**：chokidar 忽略 `.backup-*`、`node_modules`、`.git`，事件防抖 300ms 后才重扫；
- **安全读取**：文件读取白名单扩展名 + 项目路径包含校验 + 5MB 上限；task.json 写回仅允许白名单字段且未知字段原样保留；
- **CLI 进程树终止**：Windows 上通过 `taskkill /T /F` 完整结束 cmd→trellis→node/python 链。

### 数据兼容性

`task.json` 结构严格对齐 `@mindfoldhq/trellis-core` 的 `TrellisTaskRecord`（24 字段标准 Schema）。
状态 → 阶段映射：`planning→计划`、`in_progress→实现`、`review→评审`、`completed/done→完成`。

## License

MIT

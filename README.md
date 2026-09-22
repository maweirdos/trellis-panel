# Trellis Panel

<div align="center">
  <img src="https://img.shields.io/github/license/maweirdos/trellis-panel" alt="License">
  <img src="https://img.shields.io/badge/Windows-10%2B-0078D6" alt="Windows">
  <img src="https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white" alt="Electron">
  <img src="https://img.shields.io/badge/React-18-20232A?logo=react&logoColor=61DAFB" alt="React">
  <img src="https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Web-%E7%9C%8B%E6%9D%BF-38bdf8" alt="Web 看板">
  <img src="https://img.shields.io/badge/Jira-双向同步-0052CC?logo=jira&logoColor=white" alt="Jira 双向同步">
</div>

> Trellis 工作流可视化面板 — Windows 桌面客户端（Electron + React + TypeScript）

Trellis Panel 是 [Trellis](https://docs.trytrellis.app/zh/start/install-and-first-task)（面向 AI coding 平台的工作流框架）的本地可视化面板。它直接读取项目中的 `.trellis/` 目录，把任务、规范文档、开发者工作区和 AI 会话以图形界面呈现：AI 工具在仓库里的任务操作通过桥接层实时反映到面板，Jira 双向同步。面板是 .trellis 的可视化浏览器，不接管、不派发 AI 会话。

## 功能总览

| 页面 | 能力 |
| --- | --- |
| 概览 | 任务状态统计（全中文）、当前任务、AI 平台检测、活跃 AI 会话、项目配置一览 |
| 任务看板 | **看板 / 阅读 / 列表 / 泳道** 四种视图；拖拽切换状态；大列自动折叠（>8 条只留最近 5 条）；**阅读模式**：任务轨 + PRD 排版阅读（章节导航、宽度切换、上一篇/下一篇）；头部集成**专注计时 · 完成门禁（DoD）· 归档 · AI 拆分子任务 · AI 提交信息 / PR 描述** |
| 任务详情 | 右侧悬浮层；24 字段中文化；**修改暂存 + Diff 预览**；**Git 状态**（领先/落后、合并检测、提交列表、一键建分支）；**写冲突检测**（外部修改不覆盖） |
| 产物查看 | 全屏查看器：Markdown + **Mermaid** + **ASCII 线框图**渲染，原文/渲染切换、复制 |
| 规范文档 | 目录树 + 渲染 + **在线编辑（带冲突检测）** + **引用统计**（识别从未被引用的死规范） |
| 知识库 | **五库一体**：需求库（任务 PRD / task.json 提炼）/ 规范库 / Wiki 库（README·docs）/ 归档库 / **我的笔记**（`.trellis/notes/`，面板内新建·编辑·删除）；本地倒排索引全文检索（CJK 二元分词 + TF-IDF、高亮片段）；**AI 问答带来源引用 + 问答历史落盘**；接入 AI 后支持基于当前库的问答 |
| 定制中心 | **可视化定制 Trellis 工作流**：workflow.md 与 `.trellis/workflows/` 变体（结构解析、契约校验、四级解析链可视化、新建/设为团队与个人默认）；**AI 工作流（Flow）**：一句话需求 → AI 设计多代理工作流（阶段 / 子代理 / 工具调用 / 质量门禁 / 钩子，Flow DSL 存储 `.trellis/flows/`）→ 可视化预览 → 一键运行 → 实时阶段进度 → 运行历史与产物回看，内置模板（项目知识调研 / 项目健康巡检 / 文档评审）；**Slash 命令 / 子代理 / 技能**跨平台扫描与表单化编辑（frontmatter + 正文，新建/删除）；**跨平台矩阵**：同名扩展在哪些平台存在/缺失一目了然，一键补齐到缺失平台（nested↔hyphen 命名互转、gemini TOML 转换、格式不同自动跳过）；**钩子**（平台 settings.json 注册表 + config.yaml 生命周期钩子 + 脚本浏览）；**config.yaml** 结构化编辑（packages / default_workflow / codex.dispatch_mode 等）；**平台与团队**：22 平台检测与文件计数、团队共享 vs 个人配置导览 |
| AI 频道 | **trellis channel 运行时看板**：实时事件流（create/message/progress/done）、本项目/全局过滤、面板直接发消息（as panel-ui）驱动 AI worker、forum 线程视图、启动 worker / 软中断 / 删除等动作；**任务派发台**：把看板任务（自动携带 PRD 摘录/子任务）或一句话需求派给 AI worker——自动建 dispatch-* 频道 + 结构化指令，事件实时回流面板 |
| 归档 | 兼容新旧两种归档布局 |
| 团队协作 | 五标签：动态流 / **效率分析**（交付周期、流转热度、停滞预警 + **AI 深度诊断**：停滞归因、负载观察、本周行动建议）/ **站会**（今日完成·进行·评审·阻塞一键生成）/ **周报生成**（团队/个人，Markdown 导出）/ **工作流洞察**（解析链、workflow 分布、停滞预警、平台覆盖） |
| Jira 任务 | 我的待办 / **当前冲刺** / 自定义 JQL；加入待办（**可配置状态映射**）；双向同步；流转推送；进度回写评论；密码 DPAPI 加密；**AI 规划**：issue → 检索知识库 → AI 生成结构化计划（PRD/子任务/workflow pin/分支建议）→ 评审修订 → 一键落成 Trellis 任务并生成 codex/Claude Code/ZCode 启动衔接 |
| CLI 终端 | 运行 trellis 命令，实时输出、可中止 |
| 胶囊模式 | 置顶小卡片：当前任务 + 进度 + 一键回主面板 |
| 桌面集成 | **托盘常驻**（关闭最小化到托盘）、**全局快捷键**、开机自启、**自动检查更新** |
| 架构图 | **Trellis 工作流可视化**：会话层 / 调度层 / 生命周期三泳道 SVG 流程图——SessionStart 上下文注入、每轮 workflow-state 注入、PreToolUse/PostToolUse、子代理派发、任务状态机与生命周期钩子；流动光点动画、节点点击查看触发时机与实现文件、当前任务实时点亮状态节点 |
| 命令面板 | **Ctrl+K** 全局呼出：页面跳转、任务搜索、常用动作（新建待办 / 重扫描 / 切换主题），键盘导航 |
| 应用内 AI | 设置页接入 **OpenAI 兼容 baseUrl 自定义模型**（Ollama / LM Studio / One-API / 云端均可用，Key 经 DPAPI 加密）；驱动 **AI 对话（Agent 模式默认开启：自动携带项目上下文与会话绑定任务，先查知识库再回答，回答附来源引用，可一键沉淀为知识笔记）**、知识库问答、PRD 草稿、任务摘要、任务规划 |
| 知识库 MCP | **AI 编码工具的持久记忆大脑**：一键安装本地 stdio MCP 服务器（零依赖脚本），自动注册到 Claude Code（`.mcp.json`，随仓库共享）与 Codex（`~/.codex/config.toml`）；AI 写代码时随时 `kb_search` / `kb_read` / `kb_context` / `kb_overview` 查询四库——进程内倒排索引，**实测单查询 30~50ms**，无网络、无 embedding |
| WeKnora 联动 | **公司级知识库联邦**：本地四库保持毫秒级不动，WeKnora 作为公司来源异步追加——知识库页「公司库」tab + 「全部」检索态追加命中，右侧直接读远程正文；AI 规划并行纳入公司库摘录（跨项目规范 / 历史归档）；**归档任务自动沉淀公司库**（PRD + 分支 + 交付提交，闭环飞轮）；`.trellis/spec` 变更静默同步（删旧推新）；一键注册 WeKnora 内置 MCP 端点给 Claude / Codex / ZCode；API Key 与端点令牌 DPAPI 加密，断网时本地检索零影响 |

## Web 看板（只读）

设置页一键启动本地 HTTP 服务（默认端口 39573）：

- **只读看板**：`GET /` — 自动刷新的团队看板页，可选局域网开放给其他成员查看

## AI 工具桥接（codex / zcode / claude）

1. **深链协议** `trellis-panel://`（带每安装令牌 `&t=` 防伪）：
   `open-task?dir=…` / `notify?text=…` / `task-event?path=…`
2. **tpanel 命令**：`tpanel notify|open|task-event`（设置页一键安装/更新）
3. **Trellis hooks**：一键写入 `.trellis/config.yaml`，任务生命周期事件实时推送面板

面板只做被动通知与可视化，不通过 MCP 暴露任何写入口；AI 接活走项目内的
`python ./.trellis/scripts/jira.py list / import <KEY>`（Trellis 侧 Jira 拉取）。

## 推荐任务流

```text
AI 会话内 jira.py list / import <KEY>（或面板手工建待办）
  → 任务写入 .trellis/tasks/（jiraKey 防重）
  → AI 按 workflow.md 规划、实施并更新状态
  → 面板文件监听 + tpanel task-event 实时展示，Jira 按映射同步
```

## Jira 连接

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
│     ├─ httpapi.ts       # 只读 Web 看板 HTTP 服务
│     ├─ studio.ts        # 定制中心：workflow/命令/子代理/技能/钩子/config.yaml 扫描与白名单写回
│     ├─ knowledge.ts     # 五库知识库：倒排索引全文检索（CJK 二元分词 + TF-IDF）+ 我的笔记读写 + 问答历史
│     ├─ kb-distill.ts    # 知识飞轮：对话 → AI 加工（拟题/打标/整理）→ 沉淀笔记
│     ├─ flow.ts          # AI 工作流：Flow DSL CRUD/校验/AI 生成（自然语言→多代理编排）/模板
│     ├─ flow-run.ts      # AI 工作流运行时：阶段推进、agent 工具循环、门禁重试、事件流与运行历史
│     ├─ chat-context.ts  # 对话系统提示词：面板助手人设 + 项目实时上下文（任务/规范/会话绑定任务）
│     ├─ ai.ts            # 应用内 AI：OpenAI 兼容 baseUrl 自定义模型客户端
│     ├─ weknora.ts       # WeKnora 公司库联动：REST 客户端（联邦检索/归档沉淀/spec 同步/MCP 端点探测）
│     ├─ kbmcp.ts         # 知识库 MCP stdio 服务器（零依赖脚本 + 一键注册 AI 工具）
│     ├─ plan.ts          # 规划工作台：KB 检索 → AI 结构化任务计划 + 启动衔接
│     ├─ channels.ts      # trellis channel 运行时读取 + 动作 + 任务派发台
│     └─ store.ts         # 设置持久化
├─ preload/index.ts       # contextBridge 类型化 API
└─ renderer/src/
   ├─ pages/              # Dashboard / Tasks(含阅读模式) / TaskDetail+Diff / Spec
   │                      # / Knowledge / Studio / Channels / Archive / Team / Jira / Settings
   └─ components/         # CapsuleView / ArtifactViewer / MermaidBlock / MarkdownView / Toasts ...
```

### 性能与稳定性设计

- 主进程承担全部 I/O；快照式 IPC；监听防抖 300ms；CLI 长输出 10fps 批量刷新；
- Mermaid 按需动态 import（不进首屏 chunk）；
- 读取保护：扩展名白名单 + 路径包含校验 + 5MB 上限；写回保留未知字段；
- 看板列固定高度内滚动、悬浮详情不挤压布局、窗口缩放以 flex/min-w-0 约束不乱版。

## License

MIT

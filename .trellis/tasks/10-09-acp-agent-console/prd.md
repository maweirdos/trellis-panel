# ACP Agent 控制台：任务对话窗口混排 Trellis 流程可视化

## Goal

在 trellis-panel 内做 ACP 客户端：经 `codex-acp` 适配器把 Codex 作为 stdio 子进程接入，任务对话窗口实时混排 **agent 轨道**（回复流、工具调用卡、权限请求卡）与 **Trellis 轨道**（任务流转、文档创建、spec 注入/更新、Jira 同步事件卡），卡片直达既有产物查看器；会话内提供人工审查式工单工作流（查询列表 → 点选 → 开始任务）。用户在同一个窗口里「看着 agent 干活 + 看着 Trellis 流程推进」，无需在看板与终端之间来回切换。

## 背景与借鉴研判（2026-10-08 调研）

- **OpenHands 已转型 ACP 控制中心**：官方主仓库自述 "control center for running OpenHands, Claude Code, Codex, Gemini, or any ACP-compatible agent"——既做 ACP agent（software-agent-sdk 内置 ACP Server，Zed 官方列名），也做 ACP 客户端编排外部 agent。与本任务同构，可作架构参照（进程管理 / 会话生命周期 / 权限 UX）。
- **Codex 接入路径**：Codex CLI 无原生 ACP，走 `zed-industries/codex-acp` 适配器；Gemini CLI 原生（`gemini --acp`），留作注册表第二项。
- **ACP v1 协议面**：JSON-RPC 2.0、NDJSON 帧（UTF-8、`\n` 分隔、消息内禁换行）；agent 侧 `initialize`/`session/new`/`session/prompt`/`session/cancel`；客户端侧必须实现 `session/request_permission`，可选 fs/terminal/elicitation 能力（MVP 不声明，见 Key Decisions）。
- **OpenHands Jira（Issue-to-PR 自动化）借鉴结论**：其 label 触发 + 15 分钟轮询 + 自动派发的自动化模式**不采纳**；采纳的是其人工替代形态——工单查询列举 → 用户选取 → 开始任务，全程人工审查（见 R7）。另采纳其安全立场：外部内容不可信、最小权限、面板不为外部 agent 开写入口。
- **关键架构事实**：ACP 只携带 agent 对话/工具/权限；Trellis 事件来自面板自有信号轨（文件监听 + tpanel 钩子 + 第一方 Jira 动作）。两条轨道在渲染层合流，时间差 ≤ 数百毫秒。

## Confirmed Facts（仓库证据）

| 事实 | 锚点 |
| --- | --- |
| `.trellis/` 文件监听已有文件级探针（add/change 直通，spec 同步在用） | `src/main/services/watcher.ts:10-46` |
| tpanel 深链三通道（notify / open-task / task-event）已打通，生命周期钩子可实时推送 | `src/main/services/bridge.ts:11-13,136-139` |
| 任务生命周期钩子事件面：after_create / after_start / after_finish / after_archive | `src/main/services/studio.ts:520`，`.trellis/config.yaml` hooks 节 |
| 权限卡三态 UX（allow-once / allow-session / deny + 120s 超时默认拒绝）已在面板自家对话落地 | `docs/roadmap.md` TPD-020 |
| stdio JSON-RPC 子进程经验：MCP 服务器（kbmcp）与 CLI 流式输出（cli.ts）均有先例 | `src/main/services/kbmcp.ts`、`src/main/services/cli.ts` |
| 会话存储 v2 树、Entry 管道 + 滚动状态机已在对话页落地，组件模式可复用 | `docs/roadmap.md` TPD-016/017/023 |
| 产物查看器（Markdown/Mermaid/ASCII、原文切换）现成 | `src/renderer/src/components/ArtifactViewer` |
| Jira 双向同步（我的待办/当前冲刺/JQL、导入 jiraKey 防重、流转、回写评论）为面板第一方能力 | `src/main/services/jira.ts`、`ipcInvoke.task.createFromJira` |
| IPC 中央注册表 + 错误码信封 + runId 关联事件流约定，为新通道既定契约 | `src/shared/ipc-channels.ts:1-10`、`docs/roadmap.md` TPD-001..004 |

## Requirements

1. **ACP 客户端服务（`src/main/services/acp.ts`）**：NDJSON JSON-RPC 客户端，spawn 适配器（默认 `codex-acp`，命令模板可配）；`initialize` 能力协商（不声明 fs/terminal/elicitation）、`session/new`（cwd=项目根）、`session/prompt`、`session/cancel`；消费 `session/update`；进程崩溃错误态 / 一键重启 / 退出树杀；事件经中央注册表 `acp` 域广播（runId 关联 output/done 成对）。
2. **权限审批**：`session/request_permission` → 三态权限卡（允许一次 / 本次会话允许 / 拒绝，120s 超时默认拒绝；「本次会话允许」按会话记忆）→ 回写 ACP。面板成为外部 agent 的执行治理层。
3. **任务对话窗口（新页 AcpConsole）**：会话列表 + 会话流（回复流式渲染、工具调用卡、思考折叠，复用对话页 Entry 管道组件模式，只抽不改）；头部绑定 Trellis 任务徽标（状态 × workflow 阶段）。
4. **Trellis 轨道卡片（混排核心）**：统一 `TimelineEvent {ts, source: 'acp'|'trellis', kind, …}` 归一化既有信号——task-status（watcher + tpanel）、doc-created（`.trellis/tasks/**` 新增 prd/design/research）、spec-injected（Studio 钩子一键接线 `tpanel notify` 上报）、spec-updated（`.trellis/spec/**` 变更）、jira-sync（面板第一方动作）。卡片按时间插入对话流，点击直达任务详情/产物查看器/规范页。关联键 projectRoot + taskDir。
5. **工单人工审查流（R7）**：会话页「从 Jira 选工单」→ 复用 jira 查询渲染工单卡片 → 用户点选 → 既有 `task:createFromJira`（jiraKey 防重）→ 任务绑定当前会话 → 用户向 agent 下达推进指令。**无任何自动触发/轮询/自动派发/自动回推**；agent 侧可另行走 `jira.py` 工具调用（acp 轨道可见），但卡片信号只信面板第一方数据。
6. **agent 注册表（设置页）**：命令模板 + 显示名 + 启用开关；预置 codex-acp 与 `gemini --acp`（按命令本机可用性默认启用）；注册表对任意 NDJSON ACP agent 通用；未配置前功能不可见（天然回滚安全）。
7. **边界**：不解析/不信任 agent 输出中的 Trellis 语义；ACP 会话为「一等可见性模式」，文件仍是唯一真相源；不动既有 Chat 页存储（ACP 会话独立持久化 `userData/acp-sessions/`）。

## Acceptance Criteria（验证记录见下方「验证」节）

- [x] mock 冒烟：`scripts/smoke/acp-mock-agent.mjs` 回放对话+工具+权限场景，协议栈断言通过（不依赖真 codex）。
- [ ] 真跑端到端：面板启动本机可用的 ACP agent（codex-acp / `gemini --acp` 任一）会话 → 发「按 workflow 推进当前任务」类指令 → 窗口可见流式回复与工具调用卡。**待用户机器**（本机未装，协议栈已被服务级冒烟全覆盖）。
- [x] 权限闭环：三态卡渲染 + allow_once 放行回写 + 拒绝路径 + 120s 超时默认拒绝逻辑落地；放行/拒绝路径经服务级冒烟验证，**120s 超时实跑待用户桌面会话**。
- [x] Trellis 混排：≥3 类卡片（task-status 含状态字段 / doc-created 直达产物查看器 / spec-updated），ts 时间序天然一致（服务级冒烟覆盖）。
- [x] 工单人工流：查工单 → 点选 → jiraKey 防重导入 → 绑定会话代码链路完成（复用 `createTaskRecord` 冲突路径）；**真实 Jira 实跑待用户配置**。
- [x] 会话与任务绑定：头部徽标取 taskDir → snapshot（record.status/phase）；跨项目按 projectRoot 过滤不错串。
- [x] 进程治理：kill → closed → 再发被拒（冒烟验证）；崩溃错误态 + 同 agent 一键重开（UI）；before-quit 树杀清理。
- [x] typecheck node+web；IPC 通道全走中央注册表（注册表冒烟 138/138）；看板零回归（watcher 挂点只增不改）。

## Key Decisions

- **D1 工单走人工审查流，不做 OpenHands 式自动化闭环**（用户 2026-10-08 决定）：查询列举 → 人工点选 → 开始任务；label 轮询、自动派发、自动回推全部排除。
- **D2 多 agent 就绪，验收以本机可用 agent 为准**（用户 2026-10-09 放宽「ACP 不限于 codex」）：协议栈与 UI 对任意 NDJSON ACP agent 通用，注册表预置 codex-acp 与 `gemini --acp`；mock 冒烟保证协议栈覆盖，真跑验收用本机装了的 agent。
- **D3 不声明 ACP 客户端 fs/terminal/elicitation 能力**：与面板「无写入口」安全立场一致；mock 冒烟先验证 codex-acp 依赖面，若确需则最小补只读 `fs/read_text_file` 并升级权限卡（风险已记 implement.md）。
- **D4 NDJSON 协议栈手写**（≈8 方法/通知，零依赖）：与 kbmcp.ts 手写 JSON-RPC 同风格。

## Out of Scope

- Jira 自动化闭环：label/状态触发、轮询调度、自动派发 agent、PR/提交自动回推 Jira。
- 多 agent 并行编排/编排 DSL（Flow 已有，不重复）；WeKnora/知识库联动变化。
- ACP v2 特性、终端共享编辑、agent 侧 MCP 代理转发、session/load 会话恢复。
- 22 平台矩阵的 ACP 列补齐提示（Studio 跨平台矩阵改动）。

## 验证（2026-10-09 机器验证）

- typecheck node+web 通过；`npm run build` 通过；IPC 注册表冒烟通过（138 个 invoke 通道全注册，含 acp 域 7 个 + 3 个事件通道）；render-contract 冒烟无回归。
- mock 冒烟 `node scripts/smoke/acp-mock-agent.mjs`：9/9（握手/建会话/思考/工具 pending/权限三态/放行→completed/end_turn/拒绝路径/-32601）。
- **服务级冒烟** `node scripts/smoke/acp.mjs`：19/19——esbuild 打包**真实 `services/acp.ts`**（mock-electron 桩）驱动**真实 mock agent 子进程**全链路：注册表探测 → 建会话握手 → prompt（用户回显/思考/工具/消息分片）→ 权限广播 → allow_once 放行回写 → 工具 completed → turn-done → 回 ready → 记录落盘 → trellis 轨道七项 → kill → closed → 结束后再发被拒。
- watcher 挂点零侵入：state.ts 仅在既有 onFile 回调追加 `routeWatcherEvent`，原路由未动。

## Notes

- 复杂任务：`design.md`（架构/协议契约/事件模型/权衡）与 `implement.md`（十步清单/验证命令/风险与回滚点）已就绪。
- start 前检查已核：codex-acp / gemini 本机均未安装 → 预置项探测显示「未探测到」但仍可强制启用；内置 mock agent 始终可用作端到端体验。
- spec-injected 卡片的 Studio 钩子一键接线 UI 未做（MVP 以 `acp:spec-injected:` notify 前缀路由实现，通道已验证）；接线 UI 留作后续小任务。

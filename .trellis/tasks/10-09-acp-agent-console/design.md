# 技术设计：ACP Agent 控制台

## 架构与边界

```
Renderer: AcpConsole.tsx（新页）
  ├─ 会话列表（agent × 项目）
  ├─ 会话流：Entry 管道复用 Chat 页组件模式
  │    ├─ agent 轨道：回复流 / 工具调用卡 / 思考折叠 / 权限卡（三态）
  │    └─ trellis 轨道：任务流转 / 文档创建 / spec 注入·更新 / Jira 同步卡片
  ├─ 头部：绑定任务徽标（task.json 状态 × workflow 阶段，快照驱动）
  └─ 工单选择器（人工审查流）：jira 查询 → 卡片列表 → 点选 → 开始任务
        ▲ IPC（中央注册表 acp 域；runId 关联 output/done 成对事件）
Main:
  acp.ts（新服务）
  ├─ NDJSON JSON-RPC 客户端：spawn 适配器（默认 codex-acp，可配 gemini --acp）
  ├─ initialize 能力协商 / session new·prompt·cancel / 会话状态机
  ├─ session/update 消费 → 归一化 TimelineEvent → broadcast
  ├─ request_permission 挂起队列 → 渲染层权限卡 → 响应回写（120s 超时默认拒绝）
  └─ 进程治理：崩溃错误态 / 重启 / 树杀（复用 cli.ts taskkill 经验）
  事件合流：watcher（文件级探针）· tpanel task-event · jira 第一方动作
  → 同一 TimelineEvent 流，按 projectRoot + taskDir 关联进当前会话
```

## 协议契约（ACP v1）

- **传输**：NDJSON——UTF-8、`\n` 分隔、消息内禁换行（规范原文 MUST/MUST NOT）。Windows 下按 `\n` 切分后剥尾部 `\r`。
- **agent 侧方法（面板调用）**：`initialize`（版本与能力协商）、`session/new`（cwd=项目根，mcpServers 留空——面板不代理 MCP）、`session/prompt`、`session/cancel`（通知）。`session/load` 不声明（loadSession 能力不开）。
- **客户端侧方法（面板必须实现）**：`session/request_permission`——映射三态权限卡（允许一次 / 本次会话允许 / 拒绝）；「本次会话允许」映射 ACP 的 always-with-remember 语义（按 sessionId 记忆），120s 超时默认拒绝。
- **客户端可选能力（MVP 不实现，协商时省略）**：`fs/read_text_file` / `fs/write_text_file` / `terminal/*` / `elicitation/*`。理由：面板哲学是不为外部 agent 开写入口（README「不通过 MCP 暴露任何写入口」同源）；codex-acp 底层 Codex CLI 自带沙箱执行。**风险**：若 codex-acp 依赖 client-side fs，能力协商后调用会失败——实现时先用 mock agent 冒烟验证适配器实际依赖面，按需最小补齐（见 implement.md 验证节）。
- **会话生命周期**：一个 ACP 会话 ↔ 一个面板 sessionId（`acp-<ts>-<rand>`）；agent 进程崩溃 → 会话置 `error` 态 + 一键重启（新进程新会话，UI 保留历史流）。

## 事件模型

```ts
interface TimelineEvent {
  id: string; ts: number
  source: 'acp' | 'trellis'
  sessionId: string; projectRoot: string; taskDir?: string
  kind: 'message' | 'tool-call' | 'thought' | 'permission'
      | 'task-status' | 'doc-created' | 'spec-injected' | 'spec-updated' | 'jira-sync'
  payload: Record<string, unknown>  // 各 kind 专属字段见 shared/types.ts
}
```

- **acp 源**：`session/update` 的 content block（text/thought）、tool_call 状态（pending/confirmed/completed）、stopReason。
- **trellis 源与既有信号的一一映射**：
  - `task-status`：watcher 探到 `task.json` change（`watcher.ts:10` 文件级探针）+ tpanel `task-event` 深链（`bridge.ts:76`）。
  - `doc-created`：`.trellis/tasks/**` 下 `prd.md|design.md|research/*` add。
  - `spec-injected`：Studio 钩子一键接线后由 `tpanel notify` 上报（MVP 补接线；传输通道现成 `bridge.ts:136`）。
  - `spec-updated`：`.trellis/spec/**` change（spec 同步同款探针）。
  - `jira-sync`：面板第一方 jira 动作（导入/流转/回写评论）发第一方事件。
- **关联键**：projectRoot 必有；taskDir 尽力（会话绑定任务时精确，未绑定时按 `.current-task` 兜底）。不做跨项目猜测。

## 工单人工审查流（R7）

不引入任何自动触发。复用既有链路：

```
AcpConsole「从 Jira 选工单」→ jira.ts 查询（我的待办/当前冲刺/JQL 复用）
  → 工单卡片列表 → 用户点选 → task:createFromJira（jiraKey 防重，既有 IPC）
  → 新任务绑定当前会话 → 用户在会话里向 agent 下达推进指令（人工审查每一步）
```

agent 侧也可走 Trellis 官方 `jira.py list`（作为工具调用在 acp 轨道可见），但面板卡片流不依赖它——两路并存，卡片信号只信面板第一方数据。

## IPC 契约（中央注册表新增 acp 域）

- invoke：`acp:agents.list` / `acp:session.new` / `acp:session.prompt` / `acp:session.cancel` / `acp:permission.respond` / `acp:agent.restart`
- 事件（runId 关联成对约定，TPD-003/004）：`ipcEvent.acpOutput`（TimelineEvent 流）/ `ipcEvent.acpPermission`（权限请求）/ `ipcEvent.acpDone`

## 兼容与回滚

- 新增域零侵入：不动 Chat 页存储（ACP 会话独立持久化 `userData/acp-sessions/`，格式沿用 FlowRunRecord 的原子写模式）。
- 设置页 ACP agent 注册表默认无启用项——功能在配置命令前不可见，天然回滚安全。
- Studio 钩子接线是可选动作（用户一键写入才有 spec-injected 事件），不接线时其余卡片不受影响。

## 主要权衡记录

1. **NDJSON 手写解析 vs 引 SDK**：ACP 无官方 TS SDK 面向客户端嵌入；协议面小（≈8 方法/通知），手写 ~200 行可控且零依赖，与 kbmcp.ts 手写 JSON-RPC 同风格。选手写。
2. **MVP 单 agent（codex-acp）起步**：注册表设计成命令模板（自然容纳 `gemini --acp`），但验收只覆盖 codex，避免多 agent 矩阵稀释首个闭环。
3. **不做 ACP 客户端 fs/terminal 能力**：与面板「无写入口」安全立场一致；用 mock 冒烟先验证 codex-acp 依赖面，把「补齐」留作有证据后的决策。

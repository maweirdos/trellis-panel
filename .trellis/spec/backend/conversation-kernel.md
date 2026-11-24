# Crux 会话内核

## 适用范围

Crux 原生会话命令、队列、快照和引擎调用由 daemon 持有。主窗口和 preload 按 `src/main/ipc/conversation.ts` 与 `src/shared/daemon-runtime.ts` 暴露显式操作。SQLite 的会话、事件、命令回执和派发尝试存于 `conversation-v2`。

## 调用契约

- `conversationApply({ cwd, command })` 提交 `ConversationThreadCommand`。桌面传稳定的 `command.commandId` UUID，daemon 校验它和外层传输的 `commandId` 一致。查此次命令用 `conversationThreadCommand({ cwd, threadId, commandId })`。
- `conversationRead(threadId, cwd)` 返回线程、近期运行和消息、待处理请求、队列暂停状态和游标。`conversationEventDelta({ cwd, threadId, cursor, limit })` 返回 `events` 或 `reset`。历史补页用 `conversationHistory({ cwd, threadId, cursor, limit })`。
- `conversationDrivers(cwd)` 读取登记。`conversationDescribeDriver({ cwd, instanceId })` 显式查询该实例的原生目录。描述包含实际模型、配置指纹、能力依据与观测时间。
- 驱动控制使用具名参数。`interruptTurn`、`steerTurn` 绑定 `nativeThreadId` 和 `turnId`。`respondToRuntimeRequest` 还绑定 daemon 查得的 `nativeRequestId`。`startTurn` 的宿主上下文带原 `requestId` 和 `assertCurrent`。

## 状态与归属

- 同一事务写有效事件、投影、回执和待派发项。派发尝试在外部输入前持久化。失去输入回执、回合结算写入失败或退出未确认时，按原命令保留待核对状态及已观察的证据。
- 只读列表、正文、历史和回执查询使用新库。在已关闭的线程或同代缓存上浏览均无需引擎调用。游标绑定 `storageId`、`threadId` 和 `sequence`。请求过期投影和增量事件在同一事务提交。
- 停止先暂停此线程队列。引擎确认提交停止之后，仍等对应回合的终态。用户可显式继续队列、启动某个排队项或提交新的普通消息来恢复派发。后台工作和其他线程独立结算。
- 运行请求按线程、回合、代次和请求种类约束。仅当前请求能收到有效审批决定或结构化回答。宿主生成的控制 ID 只用于原驱动连接，原生回合 ID 来自引擎证据。
- 驱动复用检查实例、配置指纹、实际路径和工程范围。配置变化时，原运行和原 Job 保持归属直到可确认收尾。Pi 的 worker 受理、SDK 输入、模型输出和终态使用独立证据，worker 请求键沿用原命令。

## 错误与恢复

| 条件 | 结果 |
| --- | --- |
| 原 ID 和同一载荷重查 | 原命令回执 |
| 同一 ID 改载荷 | `E_CONFLICT` |
| 回执对应另一线程 | 空回执 |
| 旧存储、错线程或无法续接的事件游标 | `reset` 和当前快照 |
| 未确认输入或终态未写入 | `pending-reconciliation` |
| 已过期请求、能力缺失 | 拒绝本次控制，保留原运行状态 |

## 操作实例

同一命令提交两次时，两次返回同一个 runId，SQLite 只有一条用户消息。原生回合已结束而 SQLite 结算失败时，界面使用原 ID 展示待核对。确认停止的 RPC 回执到达后，仍等待对应回合终态。

## 验证

使用真实桌面和已授权模型核对首条消息、续聊、重开和实际引擎输出。用隔离进程控制输入、回执、结算、读取与关闭的故障时点。核对发送次数、无效请求、游标重置、审批变更、配置切换和原进程回收。临时探针和证据保存于操作系统 TEMP。

## 恢复入口

连接中断后用 `conversationThreadCommand` 查询原 ID，再沿同代游标补齐。明确拒收后可让用户重新提交完整草稿。后台重启必须停留在原待核对记录或持久暂停队列，直至有对应的确认或用户操作。

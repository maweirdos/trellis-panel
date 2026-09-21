# Trellis Panel Access Protocol (TPAP) v1

> 状态：v1 已实现（`src/main/services/access/`）
> 传输：HTTP/JSON over TCP，仅本机环回

## Clean-room 声明

本协议为 trellis-panel 项目的**独立设计**。设计过程中仅吸收了业界对"本地服务控制面"的通用
思想分类（资源模型、游标重连、幂等变更、鉴权门槛等软件工程通用概念），**未复制任何第三方
项目的源代码、文档原文或 patch**。本项目为 MIT 许可，与任何 LGPL/GPL 项目不发生代码级接触。

## 1. 定位与边界

TPAP 是 trellis-panel 的**本地控制面**，让外部 AI 工具（编辑器插件、CLI 脚本、其他 agent）
在不打开面板的情况下：

- 感知面板当前打开的项目与任务状态（读）；
- 检索项目 spec / 任务上下文 / 网关知识（读）；
- 经 MCP 知识网关调用工具（受控写）；
- 订阅状态变更事件（游标增量拉取）。

它**不是**：远程桌面、任意 shell 服务、模型供应商代理、或公网网关。所有监听恒定绑定
`127.0.0.1`，没有任何局域网或外网暴露面（与只读 Web 看板的 `lanAccess` 开关完全独立）。

## 2. 资源模型

| 资源 | 端点 | 方法 | 语义 |
|---|---|---|---|
| host | `/tpap/v1/host` | GET | 面板身份、协议版本、当前项目、能力表 |
| session | `/tpap/v1/session` | GET | 当前项目完整快照（任务、归档、元信息） |
| events | `/tpap/v1/events?cursor=` | GET | 持久事件增量拉取（见 §4） |
| tools | `/tpap/v1/tools` | GET | 网关工具清单（名称/参数/安全规则） |
| tool call | `/tpap/v1/tools/call` | POST | 执行网关工具（**变更类**，见 §5） |
| spec | `/tpap/v1/spec/read` | POST | 读 `.trellis/spec/` 规范文档（读） |
| task | `/tpap/v1/task/read` | POST | 读任务 task.json + prd.md（读） |
| token | `/tpap/v1/token/rotate` | POST | 轮换 Bearer token（**变更类**） |

读操作的实现**复用面板内部同一套 handler**（如 spec/task 读取直接走 GatewayManager
的同一工具执行路径），不另建第二套权限或持久化逻辑——面板内看到的和外部拿到的永远一致。

## 3. 响应信封

```jsonc
// 成功
{ "ok": true, "data": ..., "cursor": { "epoch": "…", "seq": 42 } }
// 失败（HTTP 非 2xx 同构）
{ "ok": false, "error": { "code": "E_UNAUTHORIZED", "message": "缺少或无效的 Bearer token" } }
```

错误码与面板 IPC 错误码（`src/shared/ipc-errors.ts`）同一词汇表。

## 4. 事件与游标（重连语义）

每条事件形如：

```jsonc
{ "seq": 43, "epoch": "k3v9…", "ts": 1789000000000, "type": "gateway.tool_called", "payload": { … } }
```

- **seq**：进程内单调递增，永不复用。
- **epoch**：每次面板启动重新生成。客户端游标的 epoch 与当前不一致 ⇒ 一切作废。
- 拉取规则：
  - 无 cursor（首连）→ `{events: [], nextCursor: 最新, reset: true}`：客户端应全量拉一次
    `/session` 建立基线；
  - epoch 不匹配或 seq 落在被丢弃的区间（事件环上限 1000 条）→ 同样 `reset: true`；
  - 正常 → 返回 `(cursor, latest]` 的事件 + 新 cursor。
- **永远不用墙钟时间做续传依据**；ts 仅供展示与排序参考。
- 当前事件源：`snapshot.updated`（任务快照刷新，只带摘要）、`gateway.tool_called`
  （网关调用，含被拦截的）、`access.mutated`（协议自身的变更）。

## 5. 安全门槛（缺一不可）

1. **仅环回**：`server.listen(port, '127.0.0.1')` 硬编码，代码层不存在改绑 0.0.0.0 的配置项。
2. **Bearer token**：64 位 hex（32 字节随机），落盘于 `<userData>/access-token`，重启不变；
   比较采用常量时间算法。所有请求先过鉴权，失败一律 401，不区分"缺 header"与"错 token"。
3. **confirm 门槛**：变更类操作（`tools/call`、`token/rotate`）请求体必须显式
   `"confirm": true`，否则 422 `E_DENIED` 且**不产生任何副作用**。这是防"客户端误重试/
   半实现客户端"误触发变更的最后一道闸。
4. **幂等**：变更操作可携带 `requestId`（≤64 字符）；服务端以 LRU(256)+TTL(10min) 缓存
   首次结果，重复 requestId 直接返回 `{idempotentReplay: true}`——响应丢失后的重试不会
   造成二次变更。未携带时服务端生成一次性 id（等于不幂等，语义等同"发即失"）。
5. **默认关闭**：`settings.access.enabled` 默认 `false`，需在设置页显式开启。
6. **请求体上限**：1 MiB，超出直接失败，防止内存滥用。

## 6. token 生命周期

- 首次使用时懒生成并落盘（外部工具拿到一次即可长期配置）；
- 设置页可一键复制"端点 + token"、可重置；
- 重置即时生效：旧 token 立即 401，新 token 落盘生效（无需重启服务）。

## 7. 版本化

路径携带 `/tpap/v1/`。破坏性变更将启用 `/tpap/v2/` 并保留 v1 至少一个大版本周期；
`host` 端点返回 `protocol: "tpap/1"` 供客户端协商。

## 8. 快速上手

```bash
# 1. 面板设置页 → 本地接入协议（TPAP）→ 启动接入服务，复制端点与 token
# 2. 读取当前项目快照
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:39580/tpap/v1/session
# 3. 增量订阅事件
curl -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:39580/tpap/v1/events?cursor=<epoch>:<seq>"
# 4. 调用网关工具（变更类：必须 confirm，建议带 requestId 幂等）
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"toolName":"weknora_search","args":{"query":"架构规范"},"confirm":true,"requestId":"req-42"}' \
  http://127.0.0.1:39580/tpap/v1/tools/call
```

回归验证：`node scripts/smoke/tpap.mjs`（401 / 422 / 幂等重放 / 游标增量 / token 轮换全链路断言）。

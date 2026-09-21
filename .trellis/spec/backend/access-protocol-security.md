# TPAP 本地控制面安全约定

> 决策依据：TPD-007 / TPD-008。协议全貌见 `docs/access-protocol.md`；
> 实现：`src/main/services/access/`。改动前必读。

## 六条底线（改代码不得破坏任何一条）

1. **恒环回**：`server.listen(port, '127.0.0.1')` 硬编码于 `access/server.ts`。
   不得为该服务引入"绑定地址"配置项；需要局域网能力的是只读 Web 看板（httpapi.ts），
   两者永远不要合并。
2. **先鉴权后路由**：所有路由过 `verifyToken`（常量时间比较）；失败一律 401，
   不区分缺失与错误。
3. **变更必 confirm**：新操作凡有副作用（写文件、轮换凭据、触发外部系统），
   一律在路由表登记为 POST + `ensureConfirmed`：请求体缺 `"confirm": true` 时
   422 `E_DENIED`，且必须发生在任何副作用之前。
4. **幂等**：有副作用的操作必须接 `requestId` + `IdempotencyCache`（LRU256+TTL10min，
   box 包装区分"存了 null"与"未命中"）。先 `has()` 查重，副作用成功后 `put()`。
5. **默认关闭**：`settings.access.enabled` 默认 false；启停唯一入口
   `accessServer.syncFromSettings()`（boot 与 settings:set 各调一次）。
6. **单一实现**：读路径复用面板内部 handler（GatewayManager 等），不得另建平行的
   权限/持久化逻辑——面板内与外部协议看到的必须一致。

## 事件游标

- 追加事件用 `accessEventLog.append(type, payload)`，payload 只放摘要（快照全量走
  `/session`），事件环上限 1000。
- seq 进程内单调；epoch 启动即定；客户端 cursor 非法/跨 epoch/落后于丢弃区间
  → `reset:true`。判断逻辑集中在 `EventLog.since()`，调用方不得自判。

## 回归

任何改动后运行 `node scripts/smoke/tpap.mjs`（esbuild + electron mock，纯 node 可跑），
断言覆盖：401 / 422 confirm / requestId 幂等重放 / 游标增量与 reset / token 轮换失效。

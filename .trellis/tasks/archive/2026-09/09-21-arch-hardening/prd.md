# 全站架构改造：IPC 规范拆分 + 前端工程化 + 网关接入协议 + spec 决策文化

## Goal

把研讨 PI-Desktop 得到的架构思维（clean-room，仅借鉴思想，不复制任何代码/文档原文）落地到
trellis-panel，分四层改造：IPC 规范与拆分、前端工程化、网关接入协议、spec 决策文化。

## Requirements

### R1 立刻可做（纯规范 + 拆分）
- R1.1 IPC 通道建立中央注册表（`src/shared/ipc-channels.ts`），主进程 `ipcMain.handle` 与
  preload `invoke`/`send` 全部改用常量，禁止裸字符串。
- R1.2 通道命名约定成文：`<domain>:<action>`（invoke）与事件通道单列，写入 spec 并给决策编号。
- R1.3 错误码三原则：所有 `{ok:false}` 响应必须携带机器可读 `code`（`src/shared/ipc-errors.ts`），
  保留 `error` 人读文案，渲染层向后兼容（缺 code 视为 legacy）。
- R1.4 事件流约定：长任务用事件流通道推送（runId 关联），不得用单次巨型响应；成文 + cli 通道纳入注册表。
- R1.5 `src/main/index.ts`（1561 行）里的 `registerIpc()` 按域拆分到 `src/main/ipc/<domain>.ts`，
  共享状态与跨域助手收敛到 `src/main/state.ts`；index.ts 只保留窗口/托盘/快捷键/更新器/生命周期。

### R2 短期（前端工程）
- R2.1 `src/renderer/src/store.ts`（421 行单体）切片化：session/inbox/todos/toast/viewer/ui 六个
  slice，组合出口保持 `useApp` 与既有类型导出不变（页面零改动）。
- R2.2 markdown 管线消毒：`MermaidBlock` 从 `securityLevel:'loose'`+裸 innerHTML 改为 strict +
  DOMPurify(SVG profile) 消毒后再注入；`MarkdownView` 加 rehype-sanitize 兜底（防未来引入 rehype-raw）。

### R3 中期（Gateway 接入协议，RACP 思维 clean-room 重设计）
- R3.1 设计文档 `docs/access-protocol.md`：资源模型（project/session/事件/工具）、持久事件
  `{epoch,sequence}` 游标、重连语义、幂等变更（requestId 去重）、安全门槛。
- R3.2 实现 `src/main/services/access/`：仅绑 127.0.0.1 的控制面 HTTP 服务 + Bearer token（持久化
  于 userData，可重置）+ 变更类操作强制 `confirm:true` + 事件日志（带序号游标、`since` 拉取）。
- R3.3 事件源接入：任务快照刷新、网关工具调用写入事件日志；外部客户端可 `events/pull?cursor=` 增量拉取。
- R3.4 渲染层可查看 token 与端点（Settings 页），协议默认关闭、显式开启。

### R4 长期（spec 决策文化）
- R4.1 `.trellis/spec/` 新增决策登记簿（编号 TPD-xxx，含背景/决策/理由/替代案），本次改造的所有
  架构决策入册。
- R4.2 IPC 约定、前端 store 约定、接入协议安全约定分别沉淀为对应 spec 卷文档并更新索引。

## Constraints

- C1 开源协议合规：不复制 PI-Desktop 的代码、文档原文、patch；协议设计为独立重写，文档仅参考
  其"思想分类"（资源模型/游标/幂等/审批门槛等通用概念）。许可证差异（对方 LGPL-3.0 / 本项目 MIT）
  在 docs/access-protocol.md 头部注明 clean-room 声明。
- C2 不回归现有功能：所有通道名保持 `domain:action` 字面量不变（决策入册），改动是"结构化"而非"重命名"。
- C3 不触碰用户未提交的 WIP 文件（Gateway.tsx、Knowledge.tsx 当前有未提交修改），除非该文件属于
  改造必经路径且改动为追加式。
- C4 typecheck 必须通过（tsconfig.node + tsconfig.web 两套）。

## Acceptance Criteria

- [ ] AC1 主进程 `index.ts` 不再包含任何 `ipcMain.handle/on` 注册；全部集中在 `src/main/ipc/` 按域模块。
- [ ] AC2 主进程与 preload 中不再出现裸通道字符串（grep 验证），通道常量集中唯一。
- [ ] AC3 所有 `{ok:false}` 返回路径带 `code` 字段；`src/shared/ipc-errors.ts` 定义全量错误码枚举。
- [ ] AC4 store 拆为多 slice 文件；`useApp` 及类型从 `store.ts` 再导出，16 个页面无需改 import。
- [ ] AC5 mermaid 初始化为 strict 且 SVG 经 DOMPurify 消毒；MarkdownView 挂 rehype-sanitize。
- [ ] AC6 接入协议服务：默认关闭；开启后仅 127.0.0.1 可达；无 token 请求 401；变更操作缺
      `confirm:true` 被拒；`events/pull` 支持游标增量；同 requestId 重复请求不产生二次变更。
- [ ] AC7 `docs/access-protocol.md` 存在且含 clean-room 声明；`.trellis/spec` 有决策登记簿且本次
      决策全部入册、索引更新。
- [ ] AC8 `npm run typecheck` 通过。

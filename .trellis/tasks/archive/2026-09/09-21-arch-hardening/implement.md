# 执行计划

> 顺序执行；每步末尾的验证命令必须通过再进入下一步。

## Step 1 L1 契约层（纯新增，无行为变化）
- [x] 1.1 新建 `src/shared/ipc-channels.ts`（全量通道清单，invoke + event 两节，as const）
- [x] 1.2 新建 `src/shared/ipc-errors.ts`（IpcErrorCode / IpcFail / ipcFail）
- 验证：`npm run typecheck`；通道清单与 preload+index.ts grep 清单一致（一次性比对）

## Step 2 L1 主进程拆分
- [x] 2.1 新建 `src/main/state.ts`：从 index.ts 迁出项目状态与跨域助手；openProjectAt 合并双入口
- [x] 2.2 新建 `src/main/ipc/<domain>.ts` × 21 + `src/main/ipc/index.ts`（含 dev 通道断言）；
       handler 返回路径统一 ipcFail
- [x] 2.3 重写 `src/main/index.ts`：瘦身为窗口/托盘/快捷键/更新器/生命周期；调用 registerIpc()
- [x] 2.4 preload 全量改用通道常量
- 验证：`npm run typecheck`；grep 验证 index.ts 无 ipcMain、preload 无裸字符串；
       `npm run dev` 冒烟（手动可选，typecheck 为硬门槛）

## Step 3 L2 前端工程
- [x] 3.1 `npm i rehype-sanitize dompurify`
- [x] 3.2 store 切片化：`src/renderer/src/store/slices/*` + `store/index.ts`；`store.ts` 变兼容出口
- [x] 3.3 MermaidBlock strict + DOMPurify；MarkdownView 挂 rehype-sanitize
- 验证：`npm run typecheck`；grep `securityLevel` 确认 strict；grep `dangerouslySetInnerHTML`
       确认唯一且前置消毒

## Step 4 L3 接入协议
- [x] 4.1 `src/shared/types.ts` 追加 AccessSettings；`src/main/services/access/{event-log,token,idempotency,server}.ts`
- [x] 4.2 事件源接线：state.sendSnapshot → event-log；gateway executeTool → event-log
- [x] 4.3 settings 读写接入 access 节 + ipc 域模块（access:status/token/rotate/toggle）
- [x] 4.4 Settings.tsx 新增"本地接入协议"节（Gateway.tsx/Knowledge.tsx 不动）
- [x] 4.5 `docs/access-protocol.md`（含 clean-room 声明）
- 验证：`npm run typecheck`；node 脚本冒烟：开启→curl 401→带 token 读 session→无 confirm 变更 422→
       带 confirm 变更成功→重复 requestId 返回缓存→events/pull 游标增量

## Step 5 L4 spec 沉淀
- [x] 5.1 `.trellis/spec/guides/decisions.md`（TPD-001..N 登记簿：本次全部架构决策）
- [x] 5.2 `.trellis/spec/backend/ipc-conventions.md`、`frontend/store-conventions.md`、
       `backend/access-protocol-security.md` + 各 index.md 更新
- 验证：索引链接可达（人工核对）

## Step 6 质量门（trellis-check 精神）
- [x] 6.1 `npm run typecheck` 全绿
- [x] 6.2 AC1–AC8 逐条对照验收（prd.md）
- [x] 6.3 对照 C1 开源协议约束复查：无 PI-Desktop 代码/文档原文入库（含注释）

## Step 7 提交与收尾
- [x] 7.1 仅提交本任务相关文件；用户 WIP（Gateway.tsx/Knowledge.tsx）排除
- [x] 7.2 journal 记录；任务归档交由用户确认后执行

## 回滚点
- Step 1–2 同一提交粒度（契约+拆分一体）；Step 3、4、5 各自独立提交，可单独 revert。

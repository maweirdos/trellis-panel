# 技术设计

> Clean-room 声明：本设计参考 PI-Desktop 的架构思想分类（特权分离、审批持久化、游标重连、幂等
> 变更），全部结构与命名为独立设计，未复制其任何代码、文档原文或 patch。对方 LGPL-3.0，本项目 MIT，
> 两者不发生代码级接触。

## 1. 分层总览

```
src/
├── shared/                      # 三侧（main/preload/renderer）共享契约
│   ├── ipc-channels.ts          # [新] 通道中央注册表（invoke + event 两节）
│   ├── ipc-errors.ts            # [新] 机器可读错误码 + fail() 构造器
│   ├── errors.ts                # 不变
│   └── types.ts                 # 追加接入协议类型
├── main/
│   ├── index.ts                 # [瘦] 窗口/托盘/快捷键/更新器/生命周期/深链
│   ├── state.ts                 # [新] 项目状态 + 跨域助手（openProjectAt 去重双入口）
│   ├── ipc/                     # [新] 按域 handler 注册模块
│   │   ├── index.ts             #     registerIpc 总装
│   │   ├── project.ts tasks.ts files.ts git.ts todo.ts report.ts channels.ts
│   │   ├── studio.ts knowledge.ts weknora.ts gateway.ts ai.ts planning.ts
│   │   ├── kbmcp.ts settings.ts cli.ts bridge.ts jira.ts gitlab.ts
│   │   ├── httpapi.ts window.ts util.ts
│   └── services/
│       └── access/              # [新] 本地接入协议（L3）
│           ├── server.ts        #     127.0.0.1 HTTP + Bearer + confirm 门槛
│           ├── event-log.ts     #     {epoch,sequence} 持久事件日志
│           ├── token.ts         #     token 生成/持久化/重置（userData 下 0600 语义）
│           └── idempotency.ts   #     requestId 去重缓存
└── renderer/src/
    ├── store.ts                 # [薄] 兼容出口（re-export useApp/类型）
    └── store/                   # [新] slice 组合
        ├── index.ts  slices/{session,inbox,todos,toast,viewer,ui}.ts
```

## 2. L1 IPC 契约

### 2.1 通道注册表（ipc-channels.ts）

```ts
export const ipc = {
  project: { pick: 'project:pick', open: 'project:open', snapshot: 'project:snapshot', close: 'project:close' },
  // ... 22 个域，全部 as const
  event: {
    snapshotUpdated: 'project:snapshot',
    cliOutput: 'cli:output', cliDone: 'cli:done',
    toast: 'bridge:toast', bridgeTaskFocus: 'bridge:focus-task',
    inboxNew: 'inbox:new', windowMaximized: 'window:maximized'
  }
} as const
```

- 决策：保留现有 `domain:action` 字面量（TPD-002）。理由：Electron 生态惯用、零回归风险；
  原则落在"域前缀 + 中央声明 + 事件单列"，不落在斜杠格式本身。
- 主进程侧额外提供 `assertChannel`（dev 断言：注册了未声明通道立即抛错），防新增 handler 绕过注册表。

### 2.2 错误码（ipc-errors.ts）

```ts
export const IpcErrorCode = {
  NoProject: 'E_NO_PROJECT', NotFound: 'E_NOT_FOUND', Conflict: 'E_CONFLICT',
  InvalidArg: 'E_INVALID_ARG', Unauthorized: 'E_UNAUTHORIZED', Denied: 'E_DENIED',
  Timeout: 'E_TIMEOUT', Upstream: 'E_UPSTREAM', Io: 'E_IO', Unknown: 'E_UNKNOWN'
} as const
export function ipcFail(code, message, extra?) -> { ok: false, code, error: message, ...extra }
```

- 约定：`{ok:false}` 必带 `code`；渲染层只读 `error` 展示、可按 `code` 分支（缺 code = legacy 数据）。
- 拆分 handler 时统一走 `ipcFail`，天然全量覆盖（AC3 随拆分完成）。

### 2.3 事件流约定

- 长任务（cli 运行）沿用 `cli:output/cli:done` + runId 关联；新增长任务必须同构。
- 广播事件统一经 `broadcastToWindows(channel, payload)`，通道取自 `ipc.event`。
- 接入协议侧的持久事件见 §4，与 IPC 事件流分层（UI 内 vs UI 外）。

## 3. L1 拆分细节

- `state.ts` 持有：projectRoot、latestSnapshot、knownTaskDirs、watcher、pendingFocus、
  weknoraSpecSync、jiraSyncTimer；导出 openProjectAt/closeProjectAt/sendSnapshot/findTask/
  safeReadText/createTaskRecord/deleteTaskRecord/slugifyTitle/flattenSpecNames/autoSyncJira 等纯助手。
  - `openProjectAt(root)` 合并 `project:open` 与深链 `focusMainAndOpenTask` 两条重复的项目切换路径。
  - 托盘重建通过 `setSnapshotRebuilder(fn)` 回调注入，避免 state→index 反向依赖。
- `ipc/<domain>.ts` 每模块导出 `registerXxxIpc(deps)`；`deps` 仅传窗口能力（getWindow/createCapsule/
  showMain/getCapsuleState 等），项目状态一律 import state。
- `ipc/index.ts` 总装并执行 dev 期通道声明断言。
- index.ts 收缩至 ~330 行：窗口创建、托盘、快捷键、更新器、生命周期、深链分发（调 state.openProjectAt）。

## 4. L3 本地接入协议（Trellis Panel Access Protocol, TPAP）

### 4.1 资源与操作面（v1）

| 资源 | 操作 | 类型 |
|---|---|---|
| host | `GET /tpap/v1/host` | 读：版本/项目名/能力表 |
| session（=项目快照） | `GET /tpap/v1/session` | 读：快照 |
| events | `GET /tpap/v1/events?cursor=<epoch:seq>` | 读：增量持久事件 |
| tools | `GET /tpap/v1/tools`、`POST /tpap/v1/tools/call` | 读 / 变更门槛 |
| spec/task | `POST /tpap/v1/spec/read`、`/task/read` | 读 |

- 响应统一 `{ok, data|error:{code,message}, cursor?}`；非 2xx 带同构错误码（复用 IpcErrorCode 语义）。

### 4.2 安全门槛（缺一不可）
1. **仅环回**：`server.listen(port, '127.0.0.1')` 硬编码，不提供任何局域网开关（与只读看板的
   lanAccess 完全独立）。
2. **Bearer token**：crypto.randomBytes(32).hex，持久化 `<userData>/access-token`；所有请求
   `Authorization: Bearer` 校验，失败 401。`POST /tpap/v1/token/rotate` 重置（本身需旧 token）。
3. **confirm 门槛**：标记 `mutating: true` 的操作（tools/call、token/rotate）请求体必须
   `confirm: true`，否则 422 `E_DENIED`（缺确认，不是失败执行）。
4. **幂等**：请求体可带 `requestId`（≤64 字符）；服务端 LRU(256, 10min) 去重，重复 requestId
   返回首次结果副本，杜绝重复变更。
5. **默认关闭**：settings.access.enabled 默认 false，显式开启才监听。

### 4.3 事件日志（event-log.ts）
- 内存环形（上限 1000）；每条 `{seq, epoch, ts, type, payload}`；epoch = 进程每次启动自增/随机，
  防跨重启游标错乱。
- `since(cursor)`：cursor 为空 → 返回最新 seq + 空事件（首连语义）；epoch 不匹配 → 返回
  `{reset:true, cursor: 最新}`（客户端全量重拉 session）；正常 → 增量 + nextCursor。
- 事件源：`state.sendSnapshot` 发 `snapshot.updated`；Gateway `executeTool` 发 `gateway.tool_called`
  （含 blocked 结果）；接入协议自身的变更发 `access.mutated`。

### 4.4 UI
- Settings 页新增"本地接入协议"节：开关 + 端口 + token 展示/复制/重置。Gateway.tsx / Knowledge.tsx
  不动（用户 WIP 保护）。

## 5. L2 前端

### 5.1 store 切片
- zustand 惯用 slice 组合：每个 slice 文件 `(set, get, store) => StateSlice`；`store/index.ts`
  `create<AppState>()(...slices)`。
- 兼容层：`store.ts` 保留并 `export * from './store'`（useApp、Page、ToastItem、ViewerTab、
  InboxEntry、InboxState、reconcileInbox），页面零改动。
- inbox 持久化/对账逻辑（loadInbox/saveInbox/reconcileInbox）随 inbox-slice 迁移。

### 5.2 markdown 消毒
- `MermaidBlock`：`securityLevel:'strict'`（关闭 HTML 标签与 click 回调）+ 渲染产物过
  `DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_ATTR: ['style'] })`
  再注入；错误分支渲染纯文本（已安全）。
- `MarkdownView`：`rehypePlugins = [rehypeSanitize(defaultSchema 放行 code.language-*)]`。
  现无 rehype-raw，此层为纵深防御（TPD-005）。
- 新依赖：`rehype-sanitize`、`dompurify`（v3 自带类型）。

## 6. 兼容与回滚

- 通道名不变 → 渲染层/主进程一次性同步切换到常量，无灰度共存问题；单 commit 可整体 revert。
- 接入协议默认关闭 → 纯增量，回滚即关闭/删除。
- store 兼容出口保持 → 页面无感知。

## 7. 风险

| 风险 | 缓解 |
|---|---|
| 拆分时漏迁 handler | dev 断言 + grep 裸字符串双检；拆分后全量 diff 通道清单对比 |
| mermaid strict 改变既有图渲染（HTML label 被转义） | 接受：安全优先；error 分支可读性已保证 |
| DOMPurify 过滤 SVG 过宽/过窄 | USE_PROFILES svg 最小集 + ADD_ATTR 仅 style；渲染验证 |
| settings 结构变更影响旧 settings.json | access 节读取时补默认值（沿用 normalizeSettings 模式） |

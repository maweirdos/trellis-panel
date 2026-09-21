# IPC 约定（主进程 ↔ preload）

> 决策依据：TPD-001 / TPD-002 / TPD-003 / TPD-004。改动 IPC 相关代码前必读。

## 三原则

1. **命名**：通道一律 `<domain>:<action>`，且必须先在 `src/shared/ipc-channels.ts` 登记
   （`ipcInvoke` / `ipcEvent` 两节）。主进程侧只准通过 `src/main/ipc/registry.ts` 的
   `handle/on` 注册（dev 下未声明通道直接抛错）；preload 只引用常量。
2. **错误码**：失败响应必须经 `ipcFail(code, error, extra?)` 构造（`src/shared/ipc-errors.ts`），
   `{ok:false}` 无 `code` 视为缺陷。渲染层可按 `code` 分支；缺 `code` 的旧数据按 legacy 兼容。
3. **事件流**：长任务（进程输出、进度）用成对事件通道 `<domain>:output` / `<domain>:done`
   + `runId` 关联推送（参照 cli 域实现），禁止用单次巨型 invoke 响应承载流式数据。
   广播事件统一走 `broadcastToWindows(channel, payload)`，channel 取 `ipcEvent`。

## 主进程三层结构

```
src/main/index.ts      # 薄壳：窗口/托盘/快捷键/更新器/生命周期/深链（TPD-004）
src/main/state.ts      # 项目态 + 跨域助手（sendSnapshot/findTask/openProjectAt/createTaskRecord…）
src/main/ipc/
  ├── registry.ts      # handle/on 包装器（唯一允许触碰 ipcMain 的地方）
  ├── deps.ts          # WindowDeps：窗口能力注入
  ├── index.ts         # registerIpc(deps) 总装
  └── <domain>.ts      # 一域一文件：project/tasks/todo/files/git/report/channels/studio/
                       # knowledge/weknora/gateway/ai/planning/settings/cli/bridge/jira/
                       # gitlab/httpapi/window
```

新 handler 的路径：`ipc-channels.ts` 登记通道 → 建或选 `<domain>.ts` → `handle(ipcInvoke.x.y, …)`
→ 失败路径一律 `ipcFail`。禁止：在 services 里直接 `ipcMain.handle`；在域模块间互相 import
（共享逻辑下沉 state.ts 或 service）。

## 事件源（供外部协议复用）

产生"外部工具关心的状态变更"时（如快照刷新、网关调用），除 IPC 广播外同步追加一条
`accessEventLog.append(type, summaryPayload)`（`src/main/services/access/event-log.ts`）——
只发摘要不发全量，外部客户端按游标增量拉取，需要全量时再读 session。

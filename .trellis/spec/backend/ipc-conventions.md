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

### ACP history and recovery IPC

History list/session/events/retry and explicit model recovery channels are registered in `src/shared/ipc-channels.ts`, validated at the main-process boundary and exposed through preload. The renderer supplies no trusted project root; main derives it from current project state and rejects foreign roots, malformed cursors and stale connection generations with `ipcFail`.

History summaries omit transcript bodies and attachment base64. Event pages carry opaque archive cursors and coverage/persistence facts. Live permission snapshots use the existing ACP state path and are the only source of actionable request IDs; a page read must never recreate a resolver. See [ACP archive and recovery contracts](acp-runtime.md#8-conversation-history-archive-and-explicit-model-recovery).

### Local document opening IPC

`ipcInvoke.shell.openLocalDocument` (`shell:openLocalDocument`) accepts only an
untrusted href and returns `Promise<{ ok: true } | IpcFail>`. The files handler
captures the current project root in main; no renderer root is accepted.
See [local document links](local-document-links.md) for the extension/root fences,
canonical-file checks, OS dispatch and complete failure matrix. This route does
not expand `openExternal` or app-window navigation to arbitrary local documents.

## Floating task companion window actions

### 1. Scope / trigger

Use these routes for the floating task companion's main-panel and quick-note
actions. Window creation stays in `main/index.ts`; navigation reuses the existing
project-scoped `pushFocusTask` delivery rather than adding renderer navigation state.

### 2. Signatures

```ts
openMainTask(projectRoot: string, taskDir: string): Promise<{ ok: true } | IpcFail>
showQuickTodo(): Promise<void>
```

The invoke channels are `win:openTask` and `quicktodo:show`. They are registered
through the common IPC registry and exposed by preload's `window.trellis` API.

### 3. Contracts

- The renderer's root is an expected owner, not permission to switch projects.
  Main compares it with the current root and resolves an exact `dirName` from
  that root's current `snapshot.tasks`. The existing main-panel focus route does
  not support archived targets; neither archived records nor suffix matches qualify.
- Show the main window, then recheck root and project generation before queuing
  task focus. Existing cold-start pending-focus handling owns later delivery.
- Showing quick notes reuses/creates its existing window, shows and focuses it,
  and sends `quickTodoShown`. It never hides an already visible note window.
  The global shortcut retains its separate toggle behavior.
- Task materials come from real snapshot artifacts. File names/existence/mtime
  do not prove approval, numbered publication versions or successful QA. The local
  phase is not a Jira testing/publication receipt. Keep document opening on its
  existing authorized reader path.
- Card bounds are shared in `shared/floating-window.ts`: default 400x380,
  minimum 360x320. Pill bounds remain 440x64, minimum 360x64.

### 4. Validation / error matrix

| Condition | Outcome |
| --- | --- |
| No current project | `E_NO_PROJECT`; no task focus |
| Missing/non-string root or task; path separators or parent segments | `E_INVALID_ARG` |
| Expected/snapshot root differs, or generation changes while showing main | `E_CONFLICT`; no task focus |
| Removed/archived task or suffix-only match | `E_NOT_FOUND`; do not show main |
| Main-window show fails | `E_UNKNOWN` with visible error text |
| Quick-note show fails | Invoke rejects; caller presents the error |

### 5. Good / base / bad cases

Good: a task viewed in the floating window opens that exact task in main. Base:
showing notes twice leaves them visible. Bad: focusing a same-named foreign task,
switching projects implicitly, or inferring company acceptance from a local phase.

### 6. Tests required

`node scripts/smoke/floating-window-native.mjs` bundles the real window handlers,
registry and preload with isolated state/native boundaries. Assert exact ownership,
structured rejections, generation changes, note show-vs-toggle and shared bounds.
`scripts/smoke/floating-window.mjs` mounts the actual renderer for materials,
subtasks, footer alignment and theme/font geometry. Run typecheck, build and the
shared UI check. Mocked OS calls do not establish native focus or window stacking.

### 7. Wrong vs correct

Wrong: a footer invokes the global shortcut toggle or navigates using a task title.
Correct: invoke `showQuickTodo` or `openMainTask` with the current root and exact
task directory, handling real failures without claiming success in another scope.

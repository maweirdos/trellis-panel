# Implement: 按 Trellis 规范优化整个项目

## 执行顺序（有序清单）

### Step 1: 新建对话框组件 [P0 基础]

- [x] 新建 `src/renderer/src/components/Dialogs.tsx`：导出 `confirmDialog` / `promptDialog` 命令式函数 + `DialogHost` 组件（design.md D1）。
- [x] `src/renderer/src/App.tsx` 挂载 `<DialogHost />`。
- 验证：typecheck 通过。

### Step 2: 替换 Studio.tsx 调用点 [P0]

- [x] L496/498 `prompt()`（选择平台、输入名称）→ `promptDialog`；平台选择本质是选项选择，用 message 列出可选值，确认后校验合法性。
- [x] L612 `confirm()`（删除 workflow）→ `confirmDialog`（danger）。
- 验证：grep 无残留；typecheck。

### Step 3: 替换 Channels.tsx 调用点 [P0]

- [x] L117/125/127 `prompt()` → `promptDialog`（带 defaultValue）。
- [x] L119 `confirm()`（forum/chat 二选一）→ `confirmDialog`，文案明确「确定 = forum，取消 = chat」。
- [x] L245 `confirm()`（删除频道，danger）→ `confirmDialog`。
- 验证：grep 无残留；typecheck。

### Step 4: 替换 Tasks.tsx 调用点 [P0]

- [x] L591 `confirm()`（覆盖 prd.md）→ `confirmDialog`（danger）。
- 验证：grep 无残留；typecheck。

### Step 5: 消除非空断言 [P1]（回滚点：独立于 Step 1-4）

- [x] `main/index.ts:377-378`、`main.tsx:6`、`ArtifactViewer.tsx`、`Spec.tsx`、`TaskDetail.tsx`、`Tasks.tsx:136,953`、`Inbox.tsx:203`、`Settings.tsx:305`、`services/knowledge.ts:466`、`services/weknora.ts:439`（design.md D2 三类策略）。
- 验证：`grep -rnE '[a-zA-Z_\)\]]!(\.|\[|\))' src/` 归零；typecheck。

### Step 6: 消除 `any` [P1]

- [x] 桶 1 跨层：`preload/index.ts` security: any、`Gateway.tsx` ×4、`Models.tsx` ×3。
- [x] 桶 2 Electron 事件：`main/index.ts` ×18。
- [x] 桶 3 外部响应：`ai.ts` ×8、`gitlab.ts`、`bridge.ts`、`scan.ts`、`report.ts`、`jira.ts`、`httpapi.ts`、`git.ts`、`channels.ts`、`gateway/manager.ts`、`MermaidBlock.tsx`（design.md D3 分桶策略）。
- 验证：`grep -rnE ':\s*any\b' src/` 归零（或逐处注释原因）；typecheck。

### Step 7: 质量检查（trellis-check）

- [x] `npm run typecheck` 通过。
- [x] PRD 验收标准逐条 grep 核对。
- [x] 抽查 gateway / todo IPC handler 的 `{ok, error}` + try/catch 一致性。

### Step 8: 收尾

- [x] 规范沉淀评估（3.3）：如对话框模式值得沉淀 → `trellis-update-spec`。
- [x] 提交（3.4）：conventional commit，中文描述。

## 验证命令

```bash
npm run typecheck
grep -rnE '(^|[^.a-zA-Z])(window\.)?(alert|confirm|prompt)\(' src/renderer/src --include='*.tsx' --include='*.ts'
grep -rnE '[a-zA-Z_\)\]]!(\.|\[|\))' src/ --include='*.ts' --include='*.tsx'
grep -rnE ':\s*any\b' src/ --include='*.ts' --include='*.tsx'
```

## 回滚点

- Step 1-4（对话框）与 Step 5-6（类型清理）相互独立，可分别 revert。
- 全程无数据迁移、无 IPC 协议变更。

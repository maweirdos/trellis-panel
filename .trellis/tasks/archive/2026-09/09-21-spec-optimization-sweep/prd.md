# 按 Trellis 规范优化整个项目

## Goal

对照 `.trellis/spec/` 各层规范（frontend / backend / shared / guides）审计 `src/` 代码库，修复反模式与质量缺陷，保持 typecheck 通过。

## 审计发现（2026-09-21，基于 commit 70f2b61）

### P0 — 运行时 Bug：Electron 渲染进程使用了不支持的原生对话框 API

规范 `frontend/electron-browser-api-restrictions.md` 明确：`window.prompt()` 在 Electron 中直接抛错，`window.confirm()` / `window.alert()` 行为不可靠，**必须**使用应用内对话框组件替代。

当前违规位置（用户触发即报错或行为异常）：

| 文件 | 行 | 违规调用 | 功能场景 |
|------|----|---------|---------|
| `src/renderer/src/pages/Studio.tsx` | 496, 498 | `prompt()` ×2 | 选择创建平台、输入扩展名称 |
| `src/renderer/src/pages/Studio.tsx` | 612 | `confirm()` | 删除 workflow 确认 |
| `src/renderer/src/pages/Channels.tsx` | 117, 125, 127 | `prompt()` ×3 | 创建频道、worker 提供方与命名 |
| `src/renderer/src/pages/Channels.tsx` | 119 | `confirm()` | 选择 forum/chat 类型 |
| `src/renderer/src/pages/Channels.tsx` | 245 | `confirm()` | 删除频道确认 |
| `src/renderer/src/pages/Tasks.tsx` | 591 | `confirm()` | 覆盖已有 prd.md 确认 |

（`DoDModal.tsx` 中的 `confirm(...)` 是局部函数，非 window.confirm，不违规。）

### P1 — 规范禁用模式（frontend/backend `quality.md`）

1. **非空断言 `!`**（规范明确禁止）：约 17 处，集中在 `ArtifactViewer.tsx`、`Spec.tsx`、`TaskDetail.tsx`、`Tasks.tsx`、`Inbox.tsx`、`Settings.tsx`、`main/index.ts`、`services/knowledge.ts`、`services/weknora.ts`、`main.tsx`。
2. **`any` 类型**（规范要求改用具体类型或 `unknown` + 收窄）：约 50 处，大头在 `main/index.ts`(18)、`services/ai.ts`(8)、`pages/Gateway.tsx`(4)、`pages/Models.tsx`(3)、`preload/index.ts`（`gatewayUpdateSecurity: (security: any)`，跨 IPC 边界的类型漏洞）。

### P2 — 一致性

- IPC handler 统一为 `{ ok, error }` + try/catch 模式（backend 规范），新增 gateway/todo 代码抽查确认无遗漏。

## Requirements

- **R1（P0）**：新建可复用的应用内对话框组件（确认框 + 输入框），替换上表全部 `prompt` / `confirm` 调用点；对话框遵循项目现有 Modal 模式（IntakeModal / PlanningModal 的背板 + 面板结构、`z-50`、backdrop 点击关闭）。
- **R2（P1）**：消除 `src/` 中全部非空断言，改用局部变量 + 空值守卫（或可选链 / 提前返回）。
- **R3（P1）**：消除 `src/` 中 `any` 类型——跨层（preload/shared/renderer）必须用具体类型；主进程内部对外部数据可用 `unknown` + 收窄；确因 Electron/第三方类型限制无法消除的，需显式注释原因。
- **R4**：修复不改变现有功能语义；对话框流程（创建/删除/覆盖确认）行为与原意图一致。
- **R5**：`npm run typecheck` 通过。

## Acceptance Criteria

- [x] 渲染进程不再有 `window.prompt/confirm/alert` 原生调用（逐一核对，局部同名函数除外）。
- [x] `src/` 下非空断言（`identifier!` 模式）数量为 0。
- [x] `src/` 下 `: any` 数量为 0（或剩余项均在代码中注释了不可替代的原因）。
- [x] `npm run typecheck` 通过（build 亦通过）。
- [x] 新对话框组件在 Studio / Channels / Tasks 三个页面均正确接入。

## 非目标

- 不做 UI 重设计、不加新功能。
- 不引入 lint 工具链变更（项目当前无 eslint 配置，仅 typecheck 门禁）。
- 不重构 IPC 架构。

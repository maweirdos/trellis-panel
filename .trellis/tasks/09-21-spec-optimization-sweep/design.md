# Design: 按 Trellis 规范优化整个项目

## D1. 对话框组件（R1 核心）

### API 形态：Promise 风格命令式组件

原调用点是命令式同步风格（`if (!confirm(...)) return`、`const name = prompt(...)`）。为让改动最小、调用点可读，提供 Promise 风格的命令式对话框，而不是每个调用点手写 open/close state：

```tsx
// src/renderer/src/components/Dialogs.tsx
// 确认框：resolve(true) = 确认，resolve(false) = 取消
confirmDialog({ title, message?, danger?, confirmText? }): Promise<boolean>
// 输入框：确认返回字符串（trim 后），取消返回 null
promptDialog({ title, label?, placeholder?, defaultValue?, multiline?, validator? }): Promise<string | null>
```

### 挂载方式

`App.tsx` 顶层挂载一次 `<DialogHost />`；`DialogHost` 内部维护一个模块级请求队列。命令式函数往队列 push 一个带 resolver 的请求，`DialogHost` 渲染当前请求。这样任意页面无需各自挂载 modal，也无需污染 zustand store（保持 store 只放跨页状态，对话框是 UI 局部关注点）。

### 视觉规范

复用项目 Modal 既有样式语言（IntakeModal）：`absolute inset-0 z-50 grid place-items-center bg-black/50 backdrop-blur-sm` 背板 + `rounded-2xl border border-ink-600 bg-ink-850 shadow-2xl` 面板；Enter 确认 / Esc 取消；danger 操作用红色按钮语义。同时支持暗/亮主题下既有 token（`text-mist-*`、`text-amber-*` 等已在 badges/Sidebar 中验证的双主题写法）。

### 调用点改造示例

```tsx
// Before（Electron 运行时崩溃）
const name = prompt('名称：')
if (!confirm(`删除「${wf.name}」？`)) return

// After
const name = await promptDialog({ title: '新建扩展', label: '名称（字母/数字/下划线/连字符）' })
if (name === null) return
if (!(await confirmDialog({ title: `删除 workflow「${wf.name}」？`, message: '该文件不可恢复。', danger: true }))) return
```

注意：原 `confirm()` 的双分支语义（Channels.tsx:119 的 forum/chat 选择）改为两次 `confirmDialog` 的布尔结果映射，或用 message 文案明确「确定 = forum，取消 = chat」保持一致。

## D2. 非空断言消除策略（R2）

逐处判断，三类处理：

1. **已在上层条件渲染/守卫中保证非空** → 提取局部变量（`const tab = activeTab; if (!tab) return null`）或把判空提升到回调开头（quality.md 的标准 fix）。
2. **Map.get / 数组取值可能缺失** → 空值守卫 + 提前返回，或 `?? fallback`。
3. **启动期一次性断言**（`main.tsx` 的 `getElementById('root')!`）→ 显式判空并抛出可读错误：

```tsx
const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root not found')
createRoot(rootEl).render(...)
```

## D3. `any` 消除策略（R3）

按优先级分桶：

1. **跨 IPC 边界（preload/shared/renderer）— 必须具体类型**：`preload/index.ts` 的 `gatewayUpdateSecurity: (security: any)` → `GatewaySecurityConfig`（shared/types 已有）；`Gateway.tsx` / `Models.tsx` 的表单与回调 any → 页面已有具体类型。
2. **Electron 事件参数**：`(_event: any)` → `Electron.IpcMainInvokeEvent`（或不需要时直接省略参数）。
3. **外部服务响应**（ai.ts / gitlab.ts / jira.ts 等 HTTP 响应）：`unknown` + 运行时收窄（typeof / in 检查 / 局部 interface），不做重量级 schema 校验（非目标）。
4. **无法安全消除的**（如第三方库类型缺口）：`unknown` 优先；实在需要 any 时单点注释 `// eslint-disable-reason: <why>` 说明（项目暂无 eslint，用普通注释）。

## D4. 兼容性与回滚

- 全部为渲染进程/类型层改动，不触碰 IPC 协议、持久化格式、任务目录结构。
- 回滚 = revert 单个提交。
- 风险点：`await` 化会把原同步函数变成 async，需检查调用点是否在 onChange/onClick 内直接返回 Promise（React 允许，但要注意 void 运算一致性——项目惯例 `void fn()`）。

## D5. 验证门

```bash
npm run typecheck          # 唯一既有门禁，必须通过
grep 扫描三类反模式归零    # PRD 验收标准
```

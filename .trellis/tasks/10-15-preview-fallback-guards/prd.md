# PRD — 预览模式降级守卫:?my=1 全站页面可渲染

## 背景

`?my=1` 浏览器预览(app.tsx 预览分支)没有 IPC 桥(`api = window.trellis` 为 undefined)。
框架页在挂载 effect 或渲染期直接访问 `api.x()` / `settings!` 时抛错,且预览分支无
ErrorBoundary,整棵树卸载成白屏。真机 Electron 不受影响。

## Goal

预览模式下所有框架页可渲染(降级为空数据 UI),白屏消失;真机行为零变化。

## Requirements

- **R1 页面级 ErrorBoundary**:`MyApp` 的 `PageBody` 与 TaskDetail 抽屉分别包
  ErrorBoundary——单页崩溃不再拖垮外壳,显示「页面渲染出错 + 重试」卡片(真机同样受益)。
- **R2 无桥降级守卫**:`api.ts` 导出 `hasIpc` 探测;框架页挂载 effect 在 `!hasIpc`
  时早退(不发起 IPC 调用),页面渲染其空数据 UI。
- **R3 渲染期空值安全**:消除渲染期对 `settings!` 等主 store 值的非空断言依赖
  (Jira 等),空配置时渲染空态而非崩溃。
- **R4 真机零变化**:Electron 下 `hasIpc === true`,所有 effect 照常;不加任何
  新的空态文案/交互。

## Acceptance Criteria

- [ ] AC1 `npm run typecheck`、`npm run build` 通过。
- [ ] AC2 `?my=1` 预览逐页点击 14 个框架页 + TaskDetail 抽屉,无白屏;侧栏始终存活。
- [ ] AC3 真机抽查 3 个此前正常页面,行为不变。
- [ ] AC4 无新增 any/非空断言(quality.md)。

## 范围外

- 不为预览造演示数据(空态即可);不改主进程/IPC 契约。

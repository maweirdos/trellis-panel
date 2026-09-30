# 白屏修复：ErrorBoundary+派发弹窗防御

## Goal

用户点击"派 Codex 审查"白屏。根因判断：**preload 只在应用启动时加载、不热更新**——跨过 T4 preload 改动的长命 dev 会话里，`api.onDispatchPhase`/`taskDispatchReview` 不存在；DispatchModal 挂载时同步调用不存在的订阅函数 → effect 抛错 → React 整树卸载 → 白屏。

## Requirements

1. **App 级 ErrorBoundary**（components/ErrorBoundary.tsx）：子树抛错显示错误卡片（message+stack 可复制 + 重试渲染/重载应用），附"重启 npm run dev 同步 preload"提示。挂载于 MainApp 根部。
2. **派发弹窗防御**（DispatchModal/PlannerModal）：
   - 事件订阅改可选调用 `api.onDispatchPhase?.(...)`（旧 preload 缺 API 时不订阅而非崩溃）；
   - `run()` 包 try/catch；派发 API 以 `typeof !== 'function'` 显式检测，给出"preload 过期，请重启"的定向错误（展示在弹窗错误区而非崩溃）。

## Acceptance Criteria

- [x] typecheck node+web + build 通过。
- [x] 渲染崩溃不再白屏（ErrorBoundary 卡片 + 重试/重载）。
- [x] 旧 preload 会话下点击派发：弹窗内显示定向错误，不崩溃。

## 用户操作

重启 `npm run dev`（preload 同步今日全部 API）后重试派发——这是根因解除的唯一动作；ErrorBoundary 是此后所有渲染崩溃的兜底。

## Notes

- 若重启后派发仍失败，错误会以红字显示在弹窗内（含阶段定位），把文案发来即可精确排查。

# 执行计划（已执行）

1. components/ErrorBoundary.tsx：class 组件 + getDerivedStateFromError/componentDidCatch；错误卡片（message+stack、重试渲染、重载应用、preload 重启提示）。
2. App.tsx：MainApp 返回树外层挂 ErrorBoundary。
3. DispatchModal/PlannerModal：onDispatchPhase 可选调用；run() try/catch + typeof API 检测定向报错。

## 验证记录

- typecheck node+web 0 错；build 通过（1.01s）。
- 首轮脚本因 new/new2 变量笔误整体未落盘（断言退出，文件未损坏），修正后重跑全部生效。
- 根因解释写进 ErrorBoundary 卡片与 PRD，用户侧动作=重启 dev。

## 已知取舍

- ErrorBoundary 不拦截事件处理器与异步代码中的错误（React 机制边界）——异步错误已由各弹窗 try/catch 落到错误 UI。

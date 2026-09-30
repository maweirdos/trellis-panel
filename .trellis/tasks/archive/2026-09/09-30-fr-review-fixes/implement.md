# 执行计划（已执行）

1. Tasks.tsx：#1 foundIdx 空态判定；#2 切换任务先查 getReading 双匹配恢复文档；#3 定时器清理（切换 effect 头 + 卸载 effect）；#6 projectName 选择器改 meta.root。
2. App.tsx：#4 热键监听 setPage 后 useApp.getState() 重读、已存任务有效即无条件 showTask；键同步改 root。
3. ipc/tasks.ts：#5 剪贴板解析 hasSep 分流（resolve 精确匹配 vs 裸名匹配）；清理 basename 导入。
4. state.ts：#7 材料提醒到期校验 stillActive。
5. reading.ts：#6 注释键语义。

## 验证记录

- typecheck node+web 0 错误；build 通过（1.13s）。
- #5 逻辑冒烟（tsx）：裸名→命中、本项目完整路径→命中、他项目同名路径→null。
- 修复#1 的 idx 拆为 foundIdx/idx 两个变量：导航序号仍用安全 idx，选中判定用 foundIdx。

## 关联

- 来源报告：.trellis/tasks/archive/2026-09/09-30-t4-dispatch-validation/research/gate-validation-report.md
- 本任务的真机验收清单见 PRD 第 4 条验收项（用户执行后归档时勾销）。

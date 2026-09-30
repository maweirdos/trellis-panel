# 执行计划（已执行）

1. 主进程：ipc-channels 新增 materialUpdated/focusLastReading 事件与 task:resolveClipboardTask；state.ts 实现 routeMaterialNotice（按任务 8s 防抖合并、面板自写 5s 过滤、归档不提醒、closeProjectAt/stopTimers 清理）与 markPanelWrite；watcher onFile 链上同时喂 spec 同步与材料提醒；index.ts 主窗热键唤起时广播 focusLastReading；ipc/tasks.ts 剪贴板解析（Electron 44 clipboard.readText 为异步，已 await）。
2. 渲染端：Tasks.tsx——右侧阅读区加 task 空态守卫；左栏"返回看板"改"关闭任务"；工具栏去条件包装、撤"新建待办/AI 规划"、加"打开剪贴板任务"；四列看板分支整块退场；死代码清理（boardColumns/grouped/hasEpics/planSeed/expandedCols/setIntakeOpen/PlanningModal 导入）；TaskWorkspace 接入阅读位置持久化（utils/reading.ts，localStorage tp:reading:<project>）；TasksPage 增剪贴板 handler 与首帧恢复 effect。App.tsx 增 materialUpdated（读它轻提示/其他正常）与 focusLastReading（回任务页+恢复任务）监听。
3. 验证：typecheck（node+web）通过、build 通过（693ms）；残留 rg 全零；新链路符号在 preload/App/Tasks/ipc 全部在位。

## 验证记录

- Electron 44 `clipboard.readText()` 返回 Promise（对齐 W3C API），handler 已 async/await。
- 阅读位置恢复仅在"任务 dirName + 文档名"双匹配时生效，避免错位。
- 看板列 COLUMNS/matchCol 保留——主从左侧导轨的状态计数与徽标仍在使用。
- 过程中两次 Python 切片失误（TaskDetail 重复段、Tasks 工具栏缩进变换）均已当场发现修复；最终以 typecheck+build+残留扫描作准。

## 已知取舍

- 托盘通知点击直达阅读窗（"生成即读"完整闭环）延至 T1；本版为系统 toast + 热键恢复。
- Board 视图彻底移除后，`视图切换`仅存主从一种（符合 02 P0-1 单一布局决策）；如需找看板体感，左侧导轨状态筛选 + 计数即等价信息。

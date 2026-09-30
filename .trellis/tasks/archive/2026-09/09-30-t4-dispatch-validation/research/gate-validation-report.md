## 审阅结论

任务目标和范围清晰，PRD、执行记录及归档信息齐备，但缺少设计材料和运行场景验收记录。静态审阅发现多项核心交互与要求不符，当前 completed 状态的依据不足。

## 发现的风险

- 未选任务、Esc 关闭或选中任务被筛选排除时，会回退展示列表首项，无法正确进入空态；归档任务也不在阅读区的数据源内。依据：[Tasks.tsx](D:/my_demo/trellis-panel/src/renderer/src/pages/Tasks.tsx:334)。
- 阅读恢复仍默认选择 PRD，并在文档加载前覆盖已保存位置，上次文档及滚动位置可能丢失。依据：[Tasks.tsx](D:/my_demo/trellis-panel/src/renderer/src/pages/Tasks.tsx:397)。
- 滚动保存实际为停止滚动后 500ms 防抖，且定时器未在切换任务或卸载时清理，可能延迟覆盖新阅读记录。依据：[Tasks.tsx](D:/my_demo/trellis-panel/src/renderer/src/pages/Tasks.tsx:1263)。
- 热键恢复先清空选中任务，再使用旧状态判断是否重开；原本已选中保存任务时，会跳过恢复。依据：[App.tsx](D:/my_demo/trellis-panel/src/renderer/src/App.tsx:105)、[ui.ts](D:/my_demo/trellis-panel/src/renderer/src/store/slices/ui.ts:27)。
- 剪贴板解析优先匹配 basename，并接受任意路径后缀，其他项目的同名任务路径可能误命中本项目任务。依据：[tasks.ts](D:/my_demo/trellis-panel/src/main/ipc/tasks.ts:61)。
- 阅读记录以项目目录名作为键，同名 clone 或工作树会互相覆盖位置。依据：[reading.ts](D:/my_demo/trellis-panel/src/renderer/src/utils/reading.ts:13)、[scan.ts](D:/my_demo/trellis-panel/src/main/services/scan.ts:371)。
- 材料事件入队后若任务在 8 秒内归档，发送时未重新校验活跃状态，仍可能提醒已归档任务。依据：[state.ts](D:/my_demo/trellis-panel/src/main/state.ts:111)。
- “正在阅读”的轻提示仅改变标题，仍使用相同 toast 样式和持续时间，未体现提醒强度差异。依据：[App.tsx](D:/my_demo/trellis-panel/src/renderer/src/App.tsx:95)。
- 缺少 design.md；执行记录仅列编译、构建和符号扫描，未记录热键、位置恢复、剪贴板及提醒过滤的运行验收。本轮未执行构建或测试。依据：[workflow.md](D:/my_demo/trellis-panel/.trellis/workflow.md:167)、[implement.md](D:/my_demo/trellis-panel/.trellis/tasks/archive/2026-09/09-30-fr-first-release/implement.md:5)。

## 待人工确认

- 是否将任务退回待修复、待验收阶段，修复核心交互偏差并补齐运行验收后再确认 completed？
- “正在阅读的轻提示”是否接受仅改变 toast 标题，还是需要独立的低干扰提示形式？
# PRD — 周期（自然周迭代）

## Goal

给任务引入「周期」时间维度：自然周（ISO 周号）自动分期，任务可归入某周，
本周未完成一键结转下周。数据存 task.json 面板自有字段 `cycle`（CLI 字段级写回已验证保留未知字段，零流程改动）。

## Requirements

- R1 主进程：updateTask 白名单放开 `cycle`（scan.ts EDITABLE + shared TaskEditableField/TaskRecord）。
- R2 周期模型：`cycle = "YYYY-Wnn"`（ISO 周号）；周期起止由周号推导，不落盘。
- R3 分组：工作项分组维度新增「周期」，列 = 各 ISO 周（时间升序）+「无周期」；
  列头显示周号与日期区间。
- R4 拖拽：看板按周期分组时，卡片拖入某周列即写 `cycle`。
- R5 结转：按周期分组时工具栏出现「结转未完成」——当前周未完结任务批量移入下一周。
- R6 周期概览条：按周期分组时显示当前周区间、完成进度（按 completedAt 的 7 日分布迷你图）。
- R7 peek 属性栏新增「周期」行：无周期 / 本周 / 下周 三选项。
- R8 项目侧边栏新增「周期」快捷入口（切到工作项页并按周期分组）。

## Acceptance Criteria

- AC1 typecheck/build 通过。
- AC2 「周期」分组按周渲染列（演示数据跨多周）；列头含周号与日期区间。
- AC3 拖拽任务到其他周列后 cycle 字段落盘（真实 updateTask）。
- AC4 「结转未完成」仅移动当前周未完结项到下一周。
- AC5 peek 周期行三选项可用；概览条进度与实际一致。

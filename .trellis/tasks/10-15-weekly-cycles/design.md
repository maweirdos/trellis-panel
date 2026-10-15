# Design — 周期（自然周迭代）

## 数据

- task.json 新增面板自有字段 `cycle: "YYYY-Wnn"`（可选）。CLI task.py 已验证：
  字段级修改整体回写，未知字段保留 → 零流程改动。
- 主进程 scan.ts EDITABLE 白名单加 'cycle'（writeFileSync 整体写回 record，天然保留）。
- shared/types.ts：TaskEditableField 加 'cycle'；TaskRecord 加 `cycle?: string | null`。

## 工具（my/isoWeek.ts）

- isoWeekKey(date) → "YYYY-Wnn"（ISO 周：周四归属法）
- isoWeekStart(key) → 该周一 0 点；isoWeekRangeTitle(key) → "MM/DD–MM/DD"
- currentWeekKey() / nextWeekKey()

## 渲染

- Issue.cycle 映射（adapter）+ 演示数据按起始周自动归组（data.ts）。
- WorkItemsPage：GroupBy 'cycle' 分支（GroupMeta kind 'cycle'；列按周号升序、无周期殿后）；
  列头 Calendar 图标 + 区间；拖拽落列 → updateIssue({cycle})；
  工具栏「结转未完成」（仅按周期分组时显示）；概览条（区间 + 完成进度 + 7 日完成分布）。
- ProjectSidebar「周期」入口：setGroupBy('cycle') + setPage('tasks')。
- IssuePeek 周期行：无周期/本周/下周。

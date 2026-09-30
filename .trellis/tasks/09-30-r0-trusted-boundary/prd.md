# R0 可信数据与边界：停用越权写入、修会话焦点、错误态模型

## Goal

停用 autoSyncJira 后台回写与面板直写归档/状态入口；会话焦点改读 .runtime/sessions；扫描错误不静默。
背景：06 v2（docs/proposals/2026-09-28-workbench-optimization/06-触达优先与透视方案.md §4.1）把 05 R0 定为一切后续版本的前置——假数据与越权写入会让阅读与派单都在错误事实上运行。

## Requirements

1. **停用任务生命周期直写**：面板进程不再修改 task.json 的生命周期字段（status/completedAt），不再以 renameSync 冒充归档。
2. **停用 Jira 后台回写**：删除 autoSyncJira 定时器及其设置项（含 Settings UI 开关）。
3. **修会话焦点**：currentTask 不再读废弃的 `.current-task`，改读 `.trellis/.runtime/sessions/` 最新会话绑定，附 currentTaskAt；UI 措辞用"最后记录"，不虚称全局唯一焦点。
4. **错误不静默**：重扫失败保留上一份快照并 toast 告知。

**范围内**：state.ts、ipc/tasks.ts（task:archive 删除）、scan.ts（EDITABLE 去 status；焦点改 sessions）、store/types/preload/ipc-channels 清理、渲染端撤入口（Settings/Jira/TaskDetail/CapsuleView/Tasks/DoDModal 删除、Dashboard/Team/Architecture 措辞）。

**明确不动（R0 边界）**：任务创建路径保留（UI 入口去留属 FR 页面重构）；Jira 推送/进度评论/linkExisting 元数据关联保留；WeKnora spec 同步、笔记、规范编辑等独立能力不动；归档/派单新能力属 T4 另立任务；看板视图结构保留（FR 重构），仅撤写入交互。

## Acceptance Criteria

- [x] `npm run typecheck`、`npm run build` 通过。
- [x] 全仓无 autoSyncJira/taskArchive/task:archive/DoDModal 残留引用。
- [x] updateTaskRecordAt 唯一调用方为 task:update IPC，白名单不含 status。
- [x] 面板上不再存在任何能改任务状态或移动任务目录的 UI 入口。

## Notes

- TaskDetail 元数据编辑（title/description/priority/assignee/notes/branch/pr_url/subtasks/meta）保留——05 R0 明示区分生命周期写入与有独立价值的元数据编辑。
- 执行细节与验证记录见 `implement.md`。

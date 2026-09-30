# 执行计划

1. 摸清全部生命周期写入调用点（state/scan/ipc + 渲染端 5 个文件）。
2. 主进程：删 autoSyncJira 机制（state/index/settings）；删 task:archive 处理器（ipc/tasks）；EDITABLE 白名单去 status 及 completedAt 副作用；currentTask 改读 sessions（单次扫描复用）；sendSnapshot 失败 toast。
3. 共享层：types/store/preload/ipc-channels 清理（autoSync、taskArchive、archive 通道；新增 ProjectMeta.currentTaskAt）。
4. 渲染端撤入口：Settings 自动同步开关；Jira 同步按钮+syncIssue；TaskDetail status 编辑行/标记完成/syncJira；CapsuleView 状态流转；Tasks StatusDropdown→只读徽标/归档按钮/DoDModal 两处/moveTo/拖拽源与拖放目标/onMoveTask；删除 DoDModal.tsx；Dashboard/Team/Architecture 焦点措辞改"会话最后绑定"。
5. 验证：npm run typecheck + build；rg 残留检查。

## 已知取舍

- TaskDetail 编辑表单其余字段（title/description/priority/assignee/notes/branch/pr_url/subtasks/meta）保留——元数据编辑有独立价值（05 R0 明示区分）。
- 看板视图与列结构保留（FR 任务重构布局），仅撤除其写入交互。
- createTaskRecord 直写 task.json 保留，待 FR 页面重构时统一收口。

## 验证记录

- typecheck（node+web 两套 tsconfig）通过；build 通过（783ms）。
- rg 确认：autoSyncJira/restartJiraAutoSync/taskArchive/task:archive/DoDModal/dodOpen/dodTask/moveTo/onMoveTask/dragOver/text/task-dir 全部零残留。
- updateTaskRecordAt 调用方仅剩 ipc/tasks.ts task:update（白名单强制元数据）。
- 修复过一次脚本误删（TaskDetail toggleSubtask 重复段），已复核文件结构完整。

# 支撑附录：当前数据、状态与权限边界

这里描述本次静态核对的现状，并列出少量设计建议；不把旧稿的通用协作模型当作已实现数据库。当前数据流见[C03](diagrams/C03-current-data-flow.svg)，图中只绘制规划范围核心，不穷举所有后台模块；当前人与工具的工作链见[C01](diagrams/C01-current-flow.svg)。双向线表示现有请求/响应或读写关系，不代表每次读取都会写入；Jira外写仍须显式动作。

## 1 数据在哪里、谁是事实源

| 数据/对象 | 当前字段或位置 | 产生/使用关系 | 边界与建议 |
| --- | --- | --- | --- |
| 工程上下文 | snapshot.meta.root、当前projectRoot | 扫描/导航/IPC/ACP动作按root关联 | UI派生project名字不是第二个工程权威 |
| 任务记录 | .trellis/tasks/<dir>/task.json；id/name/status/assignee/parent/children/branch/commit等 | 外部Trellis流程、不同创建器；scan读取 | 生命周期归现行流程；panel只写允许元数据；未知字段保留 |
| 任务资料 | prd/design/implement.md、implement/check.jsonl和已有research/validation | 人与AI产出，阅读器/交接/ACP读取 | 清单是上下文引用，不是成功证据；资料缺失不伪造 |
| 阅读会话/修订 | documents读取与内容修订、打开基线/候选新版本 | 文件变化→候选提醒→用户选择比较/切换 | 本地文件版本不等于正式多人批准；旧确认不可冒称新版确认 |
| Jira来源/本地操作 | meta来源标识与LocalTaskService操作/来源控制记录 | 远端查询→受控创建→对账/来源草稿 | Jira自动后台覆盖任务状态已停用；旧通用创建路径仍需校准 |
| ACP配置 | userData/acp/profiles/<root-hash>.json | 可复用名字/职责/指令/runtime/default目录 | 本机配置按root分开，不是组织角色/执行授权 |
| ACP会话 | userData/acp-sessions/<sessionId>.json；projectRoot/taskDir/远端身份/turn/events/materialSnapshot | acpx事件与主进程投影，历史读取与受能力支持的恢复 | taskDir可空；本机记录不自动共享；材料快照不等于完整内容指纹或遵守证据 |
| 观测回执/活动 | 既有observability与activity服务 | Hook/文件/第一方动作→有来源记录→读模型 | assembled/emitted与模型接受/遵守分开；无记录不补成功 |
| 周期/视图偏好 | TaskRecord.cycle；按工程的本机偏好 | 工作项分组与自然周结转 | 没必要引入Crux式专项/共享视图实体才能使用当前周期 |
| Flow模板/运行 | .trellis/flows；userData/flow-runs | 定制中心显式运行模板，保存事件/结果 | 是另一工具路径，不是外部Trellis全生命周期审计 |
| Git/CLI事实 | taskGitInfo、文档基线；CliRun的id/proc与流式输出 | 读取Git或显式运行命令 | 文件脏改动未必属于当前任务；进程存活不等于就绪 |

实体关系采用当前实际对象：工程包含任务目录；任务可引用父/子任务及资料；会话可绑定任务，也可独立；一次会话可有多个turn；Jira来源引用关联本地任务。当前没有证据要求把每段文字都拆成RequirementRevision/ApprovalDecision/ImpactAssessment实体。先用真实任务文件和接续说明验证，复杂结构有需求再设计。

## 2 状态如何读

| 状态线 | 当前事实/代码 | 可以说明什么 | 不能代替什么 |
| --- | --- | --- | --- |
| 任务阶段 | task.json.status及workflow约定 | 项目记录在哪个阶段；自定义原值保留 | 不证明当次运行、检查或业务已经通过 |
| 当前任务指针 | Trellis会话运行记录；task.py start/finish | 某个会话绑定/清除当前任务 | finish不自动等于completed或archive |
| ACP会话 | starting/ready/busy/awaiting_permission/cancelling/disconnected/legacy/error/closed | 当前连接/回合/权限状态 | turn-done不批准任务、Jira或发布 |
| 工具/后台工作 | 真实tool状态、目录占用与进程事实 | 是否仍有未结束工作，谁占目录 | 未收到完成不能显示已释放/已停止 |
| Flow运行 | running/completed/error/aborted及模板步骤 | 该Flow定义的一次执行结果 | 不能称整个Trellis规范流程执行完毕 |
| 归档/Jira/发布 | 文件位置和外部独立回执 | 各自实际发生的动作 | 本地归档不自动代表Jira成功或软件已发布 |

旧稿的planned/preflight/hold_requested/unknown等是提案模型，并非当前ACP枚举。本版复用当前实现；“结果未知”可作为诊断含义，但不冒充已存在的新状态或要求立即迁移。取消与未结束工具的安全处理按现有ACP任务AC验收。

## 3 谁可以做什么

当前主要边界是本机路径访问、IPC工程/会话归属、runtime提供的权限选项和已有外部账号权限。成员名字由任务记录推导不代表登录身份；工作视图不授予权限；共享角色/指令不授予电脑执行权。

本机执行不等于模型请求一定离线。所选工具可能按已有配置把指令和选取资料发送到模型服务；本轮没有读取凭据、改变模型设置或执行请求。平台不额外镜像仓库的目标不能被写成模型永不接收代码。

新建议只补适用动作的检查与真实反馈：打开/阅读不执行；显式发起才发送资料/启动；外部写入说明目的地与结果；无人批准时不自行放大权限。没有正式跨设备协作目标时，不建一套组织RBAC/多层授权图作为前置。

## 4 最小接续说明（设计建议，优先存在原任务资料中）

| 字段 | 为什么需要 | 暂不要求 |
| --- | --- | --- |
| 原任务与本次目标 | 防止隔几个任务后重来或做错范围 | 新建第二个需求系统 |
| 原资料位置/读取时间与变化 | 知道AI/人依据哪份内容，能回看差异 | 每条义务不可变修订/完整依赖闭包 |
| 上轮实际结果/检查及未完成项 | 区分做过、失败、没测、待确认 | 每任务都绑定构建平台/正式双验收实体 |
| 下一步与需要谁回答的问题 | 接手者知道从哪里继续 | 完整通知/待办投递服务 |
| 明确动作意图 | 只核对阅读、继续规划或已授权实施分开 | 自动重放历史prompt或跨runtime进程无损迁移 |

如果真实接手验证说明这些字段已能从现有资料清楚获得，就只调整入口和文案，不新增重复表单或强迫维护第二份状态。

[当前对象关系图](diagrams/C04-current-relations.svg)只描述代码与文件关系，不是新增数据库或团队审批模型。

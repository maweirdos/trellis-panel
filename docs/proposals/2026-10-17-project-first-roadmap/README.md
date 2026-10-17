# 基于当前项目的场景化 Roadmap

v0.6 · 2026-10-17 UTC · 正式规划文档；不代表功能已实现或已授权实施。

当前已有本地任务、材料阅读、Jira与ACP基础。用户偏好让**AI会话、阅读和本机使用**靠前呈现；其他有项目依据的方向仍可独立选择，最终排期由用户以后决定。

先读[场景化Roadmap](01-main-roadmap.md)，或打开[HTML阅读版](Trellis-Project-Roadmap.html)。正文按“现在怎么做—哪里不顺—可规划什么—改后怎样用—完成标准”说明A会话/阅读、B需求/接续、C本机开发工具、D检查/交接。

| 需要查什么 | 入口 |
| --- | --- |
| 现状、代码依据和候选修正验证 | [02 项目事实基线](02-project-baseline.md) |
| 需求、完成标准及安全约束 | [03 需求与验收](03-requirements-and-acceptance.md) |
| Hifox借鉴、暂缓、不采用及旧FR去向 | [04 范围与参考取舍](04-scope-and-reference-decisions.md) |
| 当前数据、状态、对象关系与权限 | [05 数据与状态](05-data-and-state.md) |
| 可选工作项、依赖、风险与估算 | [06 实施准备](06-decisions-and-delivery.md) |
| 旧研究的性质和原始证据 | [历史参考说明](HISTORICAL-REFERENCE.md) |

[合并Markdown](Trellis-Project-Roadmap.md)与HTML正文相同。HTML正文及图表可单独阅读；证据JSON、图源与历史研究应使用完整包目录。图表保留Mermaid、SVG和PNG。

没有64项竞品功能全覆盖目标，也不继承旧48条FR、R0–R5、244+12条验收为必建清单。旧完整方案仅放历史归档，项目旧文件原样保留；当前规划只认本目录及后续由用户选定的具体任务。

本轮只改文档；没有修改产品代码、任务状态、业务记录，没有执行AI作业、提交或推送。当前实现判断来自33处静态代码/项目证据与指定历史验收。新用例均not_run，原生/公司环境/实际团队使用的未验证范围继续保留。

## 实施记录（2026-10-17，用户授权"按蓝图逐步实现，不建任务，交接基于 roadmap"）

除 ACP 会话功能（用户明确要求不动；`services/acp*`、AcpConsole、acpx 相关零改动）外，本记录对应的小包已实现并通过 `npm run typecheck`（exit 0）、`npm run build`（exit 0）与既有冒烟（navigation / task-presentation / uiux-wiring / ipc-registry 169 通道 / render-contract / reading-session / task-reader / receipt-projection / jira-local-task / hook-emitter / proxy / chat / observability / reader-wiring / light-task-metrics）。

| 包 | 状态 | 实现要点 |
| --- | --- | --- |
| A3/F01 状态入口诚实化 | 已实现 | `issueToTaskPatch` 不再发送 status；`updateTaskRecordAt` 白名单外字段以 `ignored` 如实返回并由 UI 提示；列表/表格状态下拉改为"状态 + task.py 工作流命令入口"；看板拖拽改复制对应命令；批量"设为状态"移除；新建弹窗不再提供状态选择（创建合同固定 planning）。未放开生命周期白名单（PN-01） |
| A3/F02 创建产物合同 | 已实现 | `createTaskRecord` 支持 `prdContent`（写前查重不覆盖），返回真实 `files`/`warnings`；AI 计划确认后落 task.json + prd.md（含待确认问题）；完成页按实际产物展示、不再宣称不存在的 PRD |
| A3/F03+B2 交接收敛 | 已实现 | 删除 plan.ts `handoffTexts`（越权状态指引）与 `plan:handoff` 通道；计划完成页与任务详情统一走 `task:handoffBuild`（handoff.ts 确定性交接包，默认只核对与阅读） |
| B1 资料连续性 | 已实现 | 普通创建播种"原始描述"prd.md 草稿；AI 计划落完整 PRD；Jira 沿用既有来源 PRD——三入口原始资料均落在任务目录 |
| B3 任务关联 | 已实现 | peek 添加子任务改走受控 `task.py add/remove-subtask`（新 IPC `task:linkSubtask`，实出退出码），替代刷新即丢的视图层假链接 |
| C1 只读 Git | 已实现 | 新"本机开发工具"页：分支/基线/暂存/未暂存/未跟踪分组 + 文件级差异（有界、防路径穿越）；只发读取类 git 命令，非 git 目录中性降级 |
| C2/C3 运行与日志 | 已实现 | 同页：脚本来自 package.json（不改脚本、不代跑未声明脚本）；输出有界、退出码/信号如实呈现；停止仅作用于面板自启进程树；组合按顺序逐个启动、部分失败标注具体工程；进程存活不冒充服务就绪 |
| D1 检查/接续汇总 | 已实现 | 任务详情新增"接续与交接"：生命周期命令提示 + 意图选择 + 携带 PRD + 真实阅读清单与已知读取问题；真实接手试点（需第二人）仍待用户安排，not_run |
| F04 文案校准 | 已实现 | README（Jira 双向同步→来源集成/手动流转、拖拽改状态→工作流命令、WeKnora 归档沉淀→标注停用、AI 规划产物口径）与工具侧栏文案对齐当前实现 |
| A1 工作区余项 | 原生走查通过（2026-10-17 补） | 原生外框/亮色层级已在桌面应用真机走查确认（无边框集成项目标题、窗口控件可访问标签、层级清晰）；深色主题与原生窗口拖拽/resize 逐项未测。明细见 roadmap_v2 第 1 章"真机走查与真实使用验证" |

验证边界：以上均为静态实现+构建/冒烟证据；原生中文输入、真实多工程脚本、跨人接手未验证。已知无关旧伤：TPAP 冒烟 2 项失败（tool_search 关键词检索为空），在干净 HEAD（e07cdc0）复跑同样失败，先于本轮存在，未修（不在本蓝图范围）。

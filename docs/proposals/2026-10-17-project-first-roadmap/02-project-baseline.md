# 项目事实基线与真实工作链

核对日期2026-10-17 UTC。范围是当前工作区代码、项目规范、原始用户证词与现有任务验收。没有重新运行应用、AI、Jira写入或业务服务，也没有用Hifox截图填补Trellis验证。代码行号是本次检查点，文件内容指纹见[evidence/project-evidence.json](evidence/project-evidence.json)。仓库有并发修改，因此“当前代码”只代表采集时刻。

## 1 目标证据、假设和冲突

| 判断 | 证据与性质 | 本版如何处理 |
| --- | --- | --- |
| 资料阅读是立项初衷 | E01 P01，用户一手证词整理 | 放规划范围，不被管理功能稀释 |
| 看见上下文/过程，减少黑盒 | E01 P02/P03/P06；S0真实观测设计 | 保留有界观测，不承诺证明模型遵守或步骤全执行 |
| 隔几个任务能继续旧工作 | E01 P04 | 用真实返工样本验证接续说明，不先上复杂修订图 |
| Jira是来源之一，飞书可能有细节 | E01 P05；E12/E13 | 本地创建和Jira都可用；人工选择资料先行 |
| 要在面板真正使用Agent | E01 P09；E03用户明确ACP优先 | 复用当前acpx实现，先补其未完原生验收 |
| 希望扩成团队产品 | E01 P07/P08、S0背景 | 是方向，尚不能推出实时协作/审批/身份服务为近期必需 |
| 多项目启动/日志/Git查看 | E05 prd.md:14及扩展边界 | 有项目记录支持，可独立交付；不是无依据支线，也不是已批准所有实现细节 |
| 产品/测试现在必须在面板跨设备确认 | 未找到当前实际用法与完整需求 | 标待决策；先核对资料/回复的实际位置 |
| 小队、专项、分拣、高级字段、兼容API、非研发扩张必需 | 主要来自旧竞品覆盖映射 | 从场景规划移除；有明确触发条件才再评估 |

README同时写“面板不接管/派发会话”和当前ACP/频道能力，亦保留旧归档与双向同步概述。E03/E18/E10/E11说明这些文字已非统一可靠事实源；本稿以当前实现和有边界的验收记录交叉核对，后续小交付中应校准入口文案。

## 2 从入口到归档

| 环节 | 实现判断 | 现有做法 | 尚缺什么/不能推断 | 证据 |
| --- | --- | --- | --- | --- |
| 打开工程与找到工作 | 已实现主要结构，收尾验收中 | 顶栏工程、八个并列模块、概览我负责/我创建/最近更新；真实目录驱动 | 最终原生外框/视觉仍开；菜单不等于后端权限 | E05/E06/E08/E23 |
| 已有任务与本地新建 | 已实现基本写入 | 扫描任务文件；普通create写planning任务记录 | 普通创建没有自动PRD/清单种子；不能称已有完整Trellis创建合同 | E09/E10/E11/E21 |
| Jira到本地任务 | 已实现并有历史真实链路证据 | 当前项目导入、防重、来源PRD与中断对账 | 飞书详情需人工选择；公司完整基线未闭；本轮未连Jira | E07/E12/E13 |
| 计划与用户确认 | 已有人工流程及可编辑AI计划 | Trellis规划规范；PlanningModal生成/修改计划再创建 | 没有正式团队审批；计划成功文案与实际PRD落盘不符 | E02/E14/E15/E16 |
| 执行 | 已有外部工具路径与当前ACP底座 | 外部编辑器按项目流程；ACP复用acpx，显式启动/绑定材料 | 厂商核心通过记录不是本次重跑；最终原生输入/草稿/视觉未闭 | E03/E04/E18/E19 |
| 过程与资料观察 | 已实现并有部分验收 | 阅读版本比较、assembled/emitted回执、双来源事件 | 不能证明每一步工作流都执行、规范都遵守；未知须保留 | E07/E09/E18/E31/E33 |
| 周迭代 | 已有实现、任务仍进行中 | 自然周、周期字段、结转与分组 | 不是未来从零建设；无依据增加专项/复杂迭代平台 | E20/E32 |
| 检查/归档/外部动作 | 已有手工流程与分开的动作 | 检查记录与Trellis命令；归档复制命令；Jira评论/流转API | 没有统一发布/审批/构建闭环；旧直接归档和后台改状态已停用 | E02/E10/E23/E27 |
| 运行服务、日志、只读Git | 部分复用基础+有记录的后续方向 | CLI输出/中止、任务Git状态、文档差异 | 未见完整服务组/就绪管理/全工程Diff；不是已完成 | E05/E24/E25/E33 |
| 团队实时协同 | 未证实；当前主要为本机投影 | 成员从任务作者/负责人推导，已有团队/统计展示 | 不能据此声称在线身份、评论、正式待办或多人审批 | E22 |
| Flow与频道 | 已有独立工具，完整适用性未证 | 本机Flow模板、运行事件/历史；频道另有入口 | 不是外部Trellis工作流的全程状态，更不证明通用团队自动化成熟 | E26/E08 |

## 3 当前最值得先核实的实现断点

| 断点 | 当前调用链 | 可能造成的用户结果 | 建议最小处理 |
| --- | --- | --- | --- |
| F01 状态入口与生命周期权威不一致 | WorkItemsPage StateSelect→my/store updateIssue→adapter issueToTaskPatch.status→task.update→scan白名单忽略status/completedAt，IPC仍返回ok再刷新 | 静态推断：乐观状态不等于落盘；本轮未复现界面回退 | 先在隔离任务复现；明确只读/受控工作流入口与反馈，不直接放开status写入 |
| F02 AI计划成功文案与文件不一致 | PlanningModal:283–284称PRD已写→planning.ts:createFromPlan→state.ts:createTaskRecord仅写task.json | 静态推断：用户去读PRD可能没有对应文件 | 先明确创建产物合同；确保页面承诺与真实文件相符，优先复用已有来源/材料机制 |
| F03 两套交接指引冲突 | 新handoff.ts默认只读核对；旧plan.ts handoffTexts仍提示完成后更新task.json且被planning IPC调用 | 计划出口可能给出过时的状态操作指引 | 迁移到同一确定性交接意图；不做原生会话跨工具无损迁移承诺 |
| F04 说明文档落后真实实现 | README旧归档/状态同步/被动面板叙事与E10/E11/E18不一致 | 用户不知哪些当前可用，哪些停用/待验证 | 随对应小交付修入口说明，历史记录另留 |

以上是代码审查发现，未被称作本轮产品复现或已修复。本轮不运行测试改真实任务，也不在文档任务内修产品代码。F01/F02是路线依据，不用于证明新的大平台必需。

## 4 当前流程与建议流程的区别

- 当前：已有多种入口和工具；接入、计划、交接有若干历史路径并存，界面文案有承诺错位；用户确认主要在实际项目流程/对话中。
- 建议：先让每个入口产物和反馈真实；把原资料、当前缺项、上轮结果和下一步留在同一任务；继续使用现有Agent和项目工作流。只有真实试点显示缺共享能力才单独立项。
- 保持：任务资料以仓库为准；打开/阅读/指派不启动AI；Agent回合结束不批准任务；归档、Jira和发布各自真实反馈。

## 5 逐文件证据索引

| ID/类别 | 路径与定位 | 确认的事实 | 限制 |
| --- | --- | --- | --- |
| E01 目标证据 | `docs/proposals/2026-10-11-cockpit-counter-proposal/01-user-pain-points.md` P01–P09 | 用户一手证词：阅读、注入/流程黑盒、迭代接续、Jira/飞书资料与本机Agent需求；团队沉淀仍为理想 | 用户证词整理，不等于所有方案已批准 |
| E02 流程规范 | `.trellis/workflow.md` Core Principles / Task System / Phase Index | 先计划后代码；task create/start/finish/archive；finish清指针不改任务状态，archive写completed并归档 | 规范约束，不证明每次实际执行完整 |
| E03 已确认范围 | `.trellis/tasks/10-16-acp-runtime-foundation/prd.md` Confirmed background and decisions / R1–R8 | 用户优先ACP、指定Codex+Claude，选择acpx固定版与最小补丁；本机、显式执行；远程机器/小队/组织平台不在本任务 | 已批准该任务，不自动批准本新路线全部增量 |
| E04 历史验收 | `.trellis/tasks/10-16-acp-runtime-foundation/validation.md` Executed product matrix / Remaining work | 打包产品双厂商核心对话、工具、权限、取消、恢复有通过记录；原生IME/配置/草稿与最终视觉仍待补 | 本轮读取记录，未重新运行厂商或模型作业 |
| E05 已确认范围 | `.trellis/tasks/10-16-project-workspace-uiux/prd.md` L5–14 / R1–R8 / Out of scope | 项目顶栏、并列模块、中央材料；多项目启动/日志/Git查看是有记录的后续方向；不含编辑调试 | 功能范围与视觉最终验收分开 |
| E06 历史验收 | `.trellis/tasks/10-16-project-workspace-uiux/validation.md` Acceptance evidence / Remaining boundaries | 导航、阅读版本连续性等已有证据；最终原生外框视觉仍未关闭 | 检查点提交不等于全项验收 |
| E07 历史验收 | `.trellis/tasks/10-11-cockpit-s0-glass-box/validation/ac-matrix.md` AC1–AC10 | 阅读/回执/轻任务已有局部与真实链路记录；公司Jira完整基线、上游分发、跨人试点未闭 | 不能将历史passed泛化到全部主机/团队 |
| E08 当前代码 | `src/renderer/src/my/navigation.ts` L18–76 | 工作项/需求接入/知识/ACP/迭代等路由及项目/应用/本机范围已存在 | 有菜单不等于有服务端团队能力 |
| E09 当前代码 | `src/main/services/scan.ts` L133–161 / L345 / L412–460 | 扫描真实任务；元数据写回白名单排除status/completedAt，保留未知字段与mtime冲突检测 | 文件快照不是Agent过程或审批事实 |
| E10 当前代码 | `src/main/ipc/tasks.ts` L26–29 / L86–156 / L166–174 | 旧直接归档停用；Jira统一LocalTaskService；普通create走createTaskRecord；已有确定性交接包入口 | 不同创建入口尚非完全同一实现 |
| E11 当前代码 | `src/main/state.ts` L409–463 / L500–502 | 普通/AI计划创建器当前只写task.json；Jira后台自动覆盖任务状态已停用 | README中旧双向同步叙事需校准 |
| E12 当前代码 | `src/main/services/local-task/index.ts` L39–48 / L143 / L349–418 | Jira走task.py create --no-start、来源PRD、幂等/中断对账，并保护用户已改PRD | 不等于所有普通创建均有这些保障 |
| E13 当前代码 | `src/renderer/src/pages/Jira.tsx` L211–273 / L414 | 已有Jira创建/打开本地任务入口，导入目标是当前工程 | 不自动读取飞书完整需求或认领工单 |
| E14 当前代码 | `src/renderer/src/components/PlanningModal.tsx` L57 / L103–120 / L267–294 | AI计划可人工修改后建任务，成功文案说PRD已写入并提供handoff | 实际写入需与E11交叉核验 |
| E15 当前代码 | `src/main/ipc/planning.ts` L19–53 | 计划生成与createFromPlan分开；创建调用普通createTaskRecord；旧handoffTexts仍在被调用 | 尚无正式团队审批/多人决定后端 |
| E16 当前代码 | `src/main/services/plan.ts` L60–156 / L165–172 | 知识检索辅助AI计划；旧交接文本仍指引直接更新task.json状态 | 与新的确定性交接意图不一致，需收敛 |
| E17 当前代码 | `src/main/services/handoff.ts` L22–100 | 交接包默认只核对与阅读，列真实存在材料；显式携带PRD；不自动开始/归档 | 目前不是完整的跨工具原生会话迁移 |
| E18 当前代码 | `src/main/services/acp.ts` L6–8 / L312–355 / L378–435 | 当前已复用acpx；本机目录预检、手动会话、资料快照、运行事件与权限；回合结束未改业务任务 | 资料快照列文件/时间，不等于逐文件内容哈希或遵守证明 |
| E19 当前代码 | `src/main/services/acp/metadata.ts` L14–47 / L50–69 | 配置按root散列保存在userData，历史在acp-sessions；旧活跃状态按兼容规则处理 | 本机历史不是跨设备共享存储 |
| E20 当前代码 | `src/renderer/src/my/pages/WorkItemsPage.tsx` L380–429 / L598–604 / L954–959 / L1418–1452 | 状态选择器调用updateIssue；自然周分组与结转已有实现 | 状态能持久化须看E09/E21，不能只看控件 |
| E21 当前代码 | `src/renderer/src/my/store.ts` L223–260 | 状态乐观更新经issueToTaskPatch送IPC后刷新；普通创建走createTask | UI乐观变化不是落盘成功 |
| E22 当前代码 | `src/renderer/src/my/adapter.ts` L90–128 / L180–215 | 成员由creator/assignee推导，comments/intake/notifications为空；映射status到patch | 团队页不证明真实身份、在线、评论或审批能力 |
| E23 当前代码 | `src/renderer/src/my/pages/YourWorkPage.tsx` L65–82 | 我负责/我创建/最近更新；归档入口复制task.py archive命令 | 不是直接受管归档或业务验收 |
| E24 当前代码 | `src/main/services/git.ts` L33–105 / L108–115 | 已有任务分支/提交/脏状态读取，另有创建分支动作 | 不是完整多仓库Diff界面，新只读入口应隔离写操作 |
| E25 当前代码 | `src/main/services/cli.ts` L18–66 | 已有单命令子进程、stdout/stderr与中止 | 不等于服务组依赖、就绪检测和持续进程管理 |
| E26 当前代码 | `src/main/services/flow-run.ts` L34–65 / L185–223 / L240–310 | 已有Flow模板的本机执行、事件、内容规则gate和历史 | 不是外部Trellis工作流全步骤观测，亦非持久跨人审批 |
| E27 当前代码 | `src/main/ipc/jira.ts` L28–46 | Jira流转与评论为实际外部动作，成功后才发相应事件 | 并非每任务必须回写，外部失败不自动等同本地失败 |
| E28 当前代码 | `src/shared/types.ts` L36–65 / L1677–1739 | 真实TaskRecord与ACP状态/会话身份字段 | 不是旧稿提出的通用RequirementRevision/ApprovalDecision实体 |
| E29 历史文案 | `README.md` 功能总览 / 推荐任务流 / Jira连接 | 立项为Trellis本地可视化；仍写不派发、双向同步及旧归档能力 | 部分描述落后当前代码，不能单独当实现证明 |
| E30 历史视觉记录 | `design-qa.md` Reopened after user review / final result | 旧布局已有检查，用户重新打开原生视觉验收；最后为blocked | 本轮不复用过时截图冒充最终原生UI通过 |
| E31 当前代码 | `src/main/services/documents/controller.ts` L42 / L111 | 阅读器有内容修订与受控读取 | 单文档修订不等于正式需求逐义务批准 |
| E32 已存在任务 | `.trellis/tasks/10-15-weekly-cycles/task.json` status / description | 周周期、结转在in_progress既有工作中，零CLI/工作流改动 | 不应被写成未来才从零建设的Hifox迭代系统 |
| E33 当前代码 | `src/main/services/documents/diff-service.ts` L173–215 | 会话打开基线与Git最近提交差异，失败有诊断降级 | 不是全工作区多仓库代码Diff管理器 |

## 6 验证口径

“当前代码存在”表示静态路径可追溯，不代表本轮运行通过；“有历史通过记录”指E04/E06/E07里的具体边界。用户原生输入与视觉、公司权限/完整数据、另一开发者/产品实际使用仍待验证。已有工作不重新排成远期从零建设，旧提案也不覆盖当前已批准任务的边界。

## 7 三处断点怎样验证（计划，尚未执行）

这些场景用于复核当前实现和未来修正，没有对真实业务任务操作。验证须使用隔离工程、静态输入和受控API；无需调用付费AI、Jira写回或修改生产资料。

| 场景 | 隔离准备与步骤 | 当前静态判断 | 修正后应核对的结果 | 尚未验证 |
| --- | --- | --- | --- | --- |
| VF01 状态选择与真实文件 | 准备planning任务并记录原字节；在列表/表格选择另一状态，观察task.update参数、反馈、刷新后状态与文件 | UI发status，但scan白名单忽略且IPC可返回ok；可能出现乐观显示与持久化不一致 | 不支持的生命周期动作明确只读/给流程入口；若另批准受控命令，需实际回执；不得把未落盘称成功 | 原生交互时序、提示与刷新表现；本轮未操作 |
| VF02 AI计划创建的真实产物 | 用已确认的静态TaskPlan夹具，不调用模型；从计划确认路径创建一次，核对task.json、prd.md、子任务和成功页 | createFromPlan调用普通创建器只写task.json，成功文案却说PRD已写 | 页面列出的产物实际存在且能打开；候选建议让确认计划落回既有PRD资料，按Trellis兼容合同实施；不覆盖已有用户内容 | 原生创建窗口与中断重试；本轮未创建 |
| VF03 同任务两种交接出口 | 对同一隔离任务分别从计划出口和任务详情构建交接；比较root/dir、实际材料、默认意图和状态指引 | 新服务默认只核对阅读，旧plan.handoff仍含直接更新task.json状态的指引 | 两出口语义一致；真实文件清单、缺项与用户意图明确；按项目流程继续，不自动开工/归档/重放旧prompt | 两出口完整UI接线与复制反馈；本轮未发送 |

VF01–03不是已复现缺陷或已修复证明。任何修复先确认本项目的生命周期和创建合同，不能为让演示通过而放开后端白名单或绕过Trellis。

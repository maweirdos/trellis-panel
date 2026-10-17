# 业务数据与控制模型

v0.4.1 逻辑合同。所有新增行为为 D 设计建议，未实施。此文是本稿审批、基数、状态和权限的权威定义；07/08/10/11及图表引用同一规则。现有 Trellis 文件/工作流继续管理工程任务生命周期，未来扩展不直接替换 TaskRecord 或 ACP 枚举。

## 1 权威数据与边界

本地 `.trellis` 的 task.json/PRD/设计/实施计划是工程源；共享系统只保存显式发布的不可变版本、决定、待办和成果索引。源与发布版不是两个可自由互盖的主库。Jira 原始字段由来源实例负责，本地具体需求和确认另有权威；字段回写逐项开通。runtime、Git、CI、构建与发布平台各自提供执行事实。没有回执的事实不得由界面猜测。

全局身份/连接以 scopeRef 表达；项目记录以 projectId 表达。记录通用字段为 id、schemaVersion、createdAt/By、updatedAt、rowVersion；时间为 UTC RFC3339。内容指纹是 SHA-256，mtime 仅是观测/冲突提示。未知枚举/字段原样保留。下列为逻辑实体与约束，不指定物理数据库或进程拓扑。

## 2 稳定需求、局部决定与整版聚合

### 2.1 对象与身份

Requirement 有不可复用的 requirementId（例如项目内 REQ-017）；它代表长期业务义务，不因重命名、移动段落或发布文档而变化。RequirementRevision 是该义务的不可变修订，包含 revisionId、规范化内容指纹、验收约束和来源。内容、验收或适用范围改变即生成新修订；仅排版变化可产生新文档版，但不产生需求修订，必须通过规范化差异和影响复核证明。删除用 retired 修订表达，不能抹掉历史。

ArtifactRevision 是发布包/文档版本，包含 manifest：requirementId→精确 requirementRevisionId，以及 planRevisionId、附件引用和需求依赖快照。同一不变修订可被 v1、v2 两个包引用；这是复用同一个已决定对象，不是把旧批准复制给新内容。段落锚点关联独立 Anchor，不用段落序号充当需求身份。

RequirementDependency 记录 requires/conflicts/refines/acceptance_depends_on、有向端点、版本约束与理由；需求→计划→子任务→测试用例的 CoverageLink 记录精确修订关联。依赖图必须检查环，影响评估不能只看文本有无变化。

### 2.2 影响判定与批准规则

ImpactAssessment 固定 from/to manifest、图快照和变更集合。系统建议计算“已变更/删除/新增义务＋依赖传递闭包＋相关计划/测试/运行”；**任务真人负责人**负责整理影响，**指定产品确认人**确认业务影响，技术评审人确认计划/实现影响。二者有分歧时标 undecided，不能自动当 unaffected。新增未知依赖一律加入待判定集合。每项写 affected/unaffected/undecided、理由和确认人。

ApprovalDecision 只作用于确切 RequirementRevision 和决定范围，结论为 approve/changes_requested/reject；后续撤回是追加 Withdrawal 事件，不能编辑历史。可逐项部分批准。同包中的一个决定只覆盖明确列出的修订，不能用“已看差异”当作整版批准。

包级 approvalStatus 为派生结果，不能直接手填：

1. 每个必需需求修订都有仍有效的批准；没有未解决的 required 问题、undecided 影响项或相互冲突决定。
2. 变更闭包中的项已逐项处理；被判 unaffected 的不变修订只有在原决定仍有效、授权有效且适用范围未变化时继续计入，并保留评估引用。
3. 任一项缺批准是 partial/pending；任一有效拒绝是 changes_requested；全部满足才是 approved。任一引用的批准被撤回，聚合立即重算；历史包保留原批准当时的事实，当前可执行状态改为 approval_revoked。
4. 变更的旧修订被 superseded，旧决定仍对旧修订成立但不批准新修订。批准人权限被撤销后，不自动伪造“历史从未批准”；新动作需重新鉴权，当前待执行包进入待复核，按项目政策由有权者复核/重新确认。

提交决定必须携带 expectedManifestRevision 和 rowVersion。并发期间若目标 manifest 改变，拒绝旧聚合提交并重新呈现影响；已保存的单项决定仍归原修订，不能转挂新修订。撤回/需求变化会查找受影响计划、用例、运行和交付；未开始执行阻断，进行中的处理见状态合同；已发布交付只标“后续变更/批准撤回”，不能改写过去发布事实。

### 2.3 必须验证的审批例子

| 案例 | 输入和事件 | 必须结果 | 测试 |
| --- | --- | --- | --- |
| 局部变更 | v1含A1/B1且已批；v2改A2，B1无依赖且影响被确认unaffected | B1原决定继续适用于B1；A2未批时v2=partial；批A2后才可聚合approved | AP01 |
| 依赖影响 | B1内容未改但其验收依赖A2 | B1进入affected；旧批准不自动计入v2，需复核并追加决定 | AP02 |
| 部分批准 | A2批准，B2要求修改 | 包为changes_requested，界面列覆盖集合；不能执行整个包 | AP03 |
| 并发修改 | 评审者打开v2，作者发布v3后评审者提交v2聚合批准 | expectedManifest冲突，提示v3差异；不批准v3；v2单项历史不丢 | AP04 |
| 撤回 | v2 approved后撤回A2批准，执行正在进行 | 新动作先hold；负责人处理受影响运行；聚合不再approved，旧记录保留 | AP05 |
| 范围/依赖未知 | 文本未改，但适用用户/依赖范围未判定 | undecided阻断包批准和启动；不得默认无影响 | AP06 |

## 3 权威基数与逻辑数据字典

### 3.1 必须一致的基数

- 一个 WorkItem 有 **0..N SourceRef**，字段为 sourceRefs: SourceRefId[]；一个 SourceRef 只绑定一个本地 WorkItem。连接＋稳定外部ID在本地绑定中唯一。没有来源的普通本地任务合法。一个交付可聚合多个任务，通过 DeliveryWorkItem 关联。
- 一个 Session 恰属一个 Project，可关联 **0..1 WorkItem**；一个任务可有0..N Session。独立探索会话的 workItemId=null。一个 Run 恰属一个 Session；Run.workItemId 只是不可变的可空归属快照，必须等于 Session.workItemId，禁止形成第二权威。首轮后会话不可改挂任务；探索结论通过显式新任务/新会话及来源链接交接。
- Evidence 是独立持久成果，一个证据可有 **0..1 originRunId**；手工上传/引用证据的 originRunId=null，必须有创建人、来源和指纹。Run有0..N证据；不要求所有证据来自Run。
- Acceptance 与 Evidence 是**多对多**，仅用 AcceptanceEvidence(acceptanceId,evidenceId,purpose) 关联，唯一约束二元组/用途；Evidence 不再含单值 acceptanceId。TestExecution 可引用证据，同一证据无需复制。
- RequirementRevision 与 TestCaseRevision 是多对多 CoverageLink的requirement_test子集（ER名RequirementTestCoverage）；Acceptance 固定 manifest、计划修订、实际代码/构建/环境引用、测试执行集合。手工验证也创建 TestExecution，不要求先有 Agent Run。
- AuthorizationGrant 可授权某项目/对象/动作/连接/机器，AuthorizationDecision 是一次动作校验结果。历史授权记录不等于当前有效授权，外部副作用重试前必须重新校验。

### 3.2 字段和约束

| 实体 | 关键字段类型 | 约束与权威 | 安全和历史 |
| --- | --- | --- | --- |
| Project | id:string，name，sourceRoots:ref[] | 一个业务项目可多仓库；路径在LocalBinding | 关闭项目不暗停服务 |
| Principal/Membership | principalId，kind:human/agent/service；projectId，role，validUntil?，revokedAt? | 身份不等于名字；成员资格不推出机器/连接权限 | 撤权保留历史署名并阻止新动作 |
| WorkItem | id，projectId，ownerId:string?，intakeState，trellisRef，sourceRefs:ref[] | owner可空仅限草稿/未分配接入；门槛见4；业务阶段仍由Trellis管理 | 不直接写status/completedAt |
| SourceRef | id，workItemId，connectionId，externalId，externalKey，baselineHash，observedAt | 0..N/任务；实例＋稳定ID防重，key可改名保留别名 | 外链不是授权 |
| Requirement | id，workItemId，stableKey，retiredAt? | ID永久稳定，不用文档路径/段落号替代 | 不复用已删除ID |
| RequirementRevision | id，requirementId，contentHash，rules，acceptanceConstraints，scope | 不可变；新内容/范围/验收产生新修订 | 旧决定不转挂 |
| RequirementDependency | id，fromRequirementId，toRequirementId，kind，revisionConstraints，reason | 有向关系/依赖图版本；环检查 | 不静默丢依赖 |
| Artifact/ArtifactRevision | artifactId，kind，visibility；revisionId，hash，manifest:map，storageRef | 文档版/包版与逐需求修订分开；manifest固定精确修订 | 发布写入与源文件编辑分别授权 |
| ImpactAssessment/Item | id，fromManifest，toManifest，graphRevision；requirementId，verdict，reason，assessedBy，reviewedBy | affected/unaffected/undecided；负责人＋指定评审确认 | 保存影响闭包与理由 |
| ApprovalDecision/Withdrawal | decisionId，requirementRevisionId，actorId，verdict，scope，authorizationDecisionId；withdrawalId，decisionId，reason | 不可变追加决定；撤回事件派生有效性 | 不能编辑旧批准假造历史 |
| Anchor/DiscussionRevision | anchorId，artifactRevisionId，requirementId?，quoteHash，position；threadId，bodyRevision，authorId，rowVersion | 锚点失配为stale；编辑并发比较行版本 | 原评论/原锚点仍可定位 |
| PlanRevision/PlanReview | id，workItemId，requirementManifest，hash，risks；reviewId，planRevisionId，verdict，reviewerId | 方案需明确需求覆盖、分解、检查与回退；批准只作用于该版 | 需求变更触发影响复核 |
| WorkBreakdown/CoverageLink | parentWorkItemId，childWorkItemId，planRevisionId，requirementRevisionIds；fromRef，toRef，kind | 拆解不替代依赖；需求/计划/任务/用例版本关联；kind=requirement_test时为RequirementTestCoverage(requirementRevisionId,testCaseRevisionId)，二者唯一 | 范围遗漏和环必须诊断 |
| ActionItem | id，targetHumanId，workItemId，manifestRef?，actionType，state，dueAt? | 同一逻辑事项多入口投影；ack/read不等于resolved | 版本变更可superseded |
| Session | id，projectId，workItemId?，visibility，initiatorId，runtimeBinding | 独立/任务会话0..1任务；首轮后归属冻结 | 私人转录与团队结论分开 |
| Run | id，sessionId，workItemId?，operationId，inputManifest，planRevisionId?，runtimeProfileRevision，state，generation，turnId，executionOutcome，resultDeliveryState | workItemId等于Session快照；一轮运行不是业务完成 | 过期事件/决定不可跨回合使用 |
| RunEvent | id，runId，seq，generation，turnId，sourceAt，observedAt，kind，payloadHash | run＋事件ID去重，乱序可缓冲/核对 | 晚到终态不直接复活运行 |
| RuntimeProfile/Machine/LocalBinding | profileRevision，capabilities；machineId，ownerId，lastSeen；bindingId，canonicalPath，repoRef，strategy | 能力声明需实测；在线/登录/路径/权限分开 | 本机路径默认不分享 |
| DirectoryLease | id，machineId，canonicalPath，ownerRunId，generation，leaseUntil，processRef | 共享目录写执行串行；未核实停止不释放 | worktree不是安全沙箱 |
| AuthorizationGrant | id，subjectId，scopeKind，resourceRef，actions[]，issuerId，expiresAt?，revokedAt?，policyRevision | grant不是密钥；显式人/服务身份和范围 | 撤销/过期立即对新动作生效 |
| AuthorizationDecision | id，operationId，actorId，action，resourceRefs，applicableChecks，grantRefs，policyRevision，verdict，checkedAt | 保存该动作实际适用的检查及理由；不盲目求所有权限交集 | 不包含原始凭据；重试再校验 |
| ExternalOperation | id，idempotencyKey，actorId，targetRef，expectedVersion，stepResults，receipt，state，authorizationDecisionId | planned/sent/confirmed/partial/unknown/failed；未知先核实 | 权限/范围变化重新预览 |
| TestCase/TestCaseRevision | caseId，stableKey；revisionId，steps，expected，requirementRevisionRefs | 测试身份稳定，变化新修订；requirementRevisionRefs仅由RequirementTestCoverage派生，不双写 | 不只凭标题猜覆盖 |
| TestExecution | id，caseRevisionId，manifestRef，planRef，codeRef?，buildRef?，environmentRef，executorId，verdict，originRunId?，evidenceRefs | pass/fail/blocked/not_run；允许手工执行，无构建时说明交付类别 | 版本未知不得判通过 |
| Acceptance/AcceptanceEvidence | id，kind:technical/business，manifestRef，planRef，codeRef?，buildRef?，environmentRef，reviewerId，verdict；acceptanceId，evidenceId，purpose | 技术与业务结论分开；证据多对多；批准≠验收 | 变更/撤回触发当前适用性复核 |
| Evidence | id，originRunId?，createdBy，sourceRef，storageRef，sha256，mime，bytes，visibility，retentionUntil? | 证据独立；无单值acceptanceId；手工证据合法 | 临时路径不是唯一存储地址 |
| Delivery/DeliveryWorkItem | deliveryId，manifestRefs，planRefs，artifactRefs，codeRef?，buildRef?，acceptanceRefs，knownIssues，recoveryOwnerId；deliveryId，workItemId | R1允许手工填写/上传且可复核；R4增加连接器核验 | 未发布不写已上线；回滚保留旧事实 |
| ViewDefinition/CycleMembership | query/layout/scope/owner/revision；cycleId，workItemId，joined/removed，carryoverFrom，reason | 视图不复制任务；结转保留原轮次 | 查询/计数仍鉴权 |
| AutomationRule | revision，trigger，identityRef，allowedActions，inputScope，budget，retryPolicy | 事件去重、循环抑制、人工等待持久化 | 暂停/撤权阻断后续动作 |

## 4 负责人、方案和工程任务生命周期

草稿、未分配导入/分诊项可没有owner，必须显示“未分配”；接收队列有队列维护责任人，但维护责任人不冒充每条任务owner。进入正式需求确认、方案批准、工程实施或Agent执行前必须有**当前有效的真人owner**，并通过成员资格和分配接受检查。Agent/小队仅是执行槽。独立探索会话的责任人是发起真人，转为工程任务时重新经过分配门槛。

普通本地任务创建：录入标题/目标/初始描述→选择当前项目与真人负责人或留草稿→通过既有Trellis创建适配→保存稳定标识及来源为空→进入澄清；创建不启动实施或Agent。重复提交用operationId去重。不能因面板创建成功就绕过Trellis planning/start审查门槛。

技术方案：确认需求manifest→提交不可变PlanRevision（约束、方案取舍、依赖、分解、测试、回退、覆盖表）→指定技术评审→approve/changes_requested/reject→按批准方案分解子任务并核对每条需求覆盖→通过现有Trellis实施入口。方案变更或需求影响使当前批准过时，受影响子项先hold；驳回回到方案修订，不强行回写需求。产品需求批准不能代替技术方案评审。

重开/取消只经项目已支持的Trellis命令/生命周期适配；实施前须验证其能力，未知时保留“申请重开/取消”待办与诊断，不能在面板伪造新状态。重开创建新工作轮次/新计划评审，保留原验收/交付；取消先阻止新动作，核实终止受影响运行、处理目录租约与外部已发生动作，再按权威工作流记录结论，不能以关会话代替取消。

负责人离开/停用：立即标assignment_invalid，阻断新执行和批准聚合；项目维护者指定新真人owner并记录其接受，重评当前授权、未决待办和方案。成员撤权：服务端/主进程阻止下一读取/写入/运行节点；不把旧登录/授权快照当永久通行证。已在执行的工作按下一节hold/stop处理。并发资料/评论/决定冲突均保留双方版本，由有权维护者选择合并或另发修订，不自动最后写入获胜。

## 5 执行状态与事件转移合同

逻辑状态是Run的控制模型，当前ACP starting/ready/busy/awaiting_permission/cancelling/disconnected/legacy/error/closed通过适配投影，不直接改枚举。任务业务阶段、Run状态、交接待办、环境观测、lease分别独立。

取消是操作者意图；停止是进程事实。需要暂停动作时先持久化 controlHold={reason,affectedManifest,requestedBy,at}，立即拒绝新工具/外部动作与排队启动。若runtime支持且实测可安全暂停，发pause并等待回执后标paused；如果不支持，走stop，不保留虚假的paused。无法在工具边界阻断正在发生的动作时，标出在途风险并核对副作用，不能承诺硬隔离。真人owner负责范围/需求判断，机器所有者处理本机停止与目录核验，集成授权者核对外部动作；未核实前hold/unknown保持。

| ST | 原状态→目标 | 事件和操作者 | 守卫 | 副作用、租约与恢复 |
| --- | --- | --- | --- | --- |
| ST01 | planned→preflight | 真人明确开始 | 任务owner或独立会话发起真人有效；需求/方案门槛按任务类型成立；适用授权有效 | 固定输入/operationId；未满足时返回诊断，不启动 |
| ST02 | preflight→queued | 预检发现暂时资源不足 | 不含永久拒绝；排队范围仍有效 | 显示机器/目录/额度原因；不预占写lease |
| ST03 | queued→preflight | 调度器收到资源变化 | 未取消/hold；重新鉴权和校验版本 | 重新预检，不用入队时旧批准 |
| ST04 | preflight/queued→cancelled | 有权发起人/owner取消 | 尚未发送runtime启动；取消CAS成功 | 撤队列和待发意图，无进程可停；释放仅自身临时预留 |
| ST05 | preflight→starting | 启动器获得可写lease | 输入/授权/owner仍有效；lease generation匹配 | 持久send-intent再发启动；lease绑定run |
| ST06 | preflight→failed | 确定性配置错误/权限拒绝 | 已知未启动 | 记录具体原因；释放临时预留，不自动重试 |
| ST07 | starting→running | 当前generation的启动回执 | receipt对应operationId/环境 | 固定processRef；开始事件序列，不完成任务 |
| ST08 | starting→stopping或cancelled | 有权人取消启动 | 已知未发送可cancelled；已发/是否执行未知只能stopping/unknown | 向当前请求取消；确认停止前保留lease |
| ST09 | running→waiting | runtime请求补答/权限 | 请求绑定run/turn/generation和expiresAt | 持久请求；lease按会话策略保留，不让其他写执行抢占 |
| ST10 | waiting→running | 目标真人答复/允许一次 | 未过期、同turn/generation、授权当前有效且无hold | 只提交当前请求，权限不升级为其他运行授权 |
| ST11 | waiting→stopping | 有权人取消，或拒绝/请求过期 | 请求仍pending；本稿默认拒绝/过期后停止该轮 | 请求作废并记denied/expired原因；runtime确认停止后释放lease；若runtime明确已安全终止可直接failed/cancelled并存回执 |
| ST12 | running/waiting→stopping | 有权人停止 | 对象、机器和执行控制权匹配 | 设置hold，发停止，拒绝新动作；不是已停止 |
| ST13 | running/waiting→hold_requested | 需求/批准撤回、owner失效或权限变化 | 受影响闭包/授权范围已识别 | 阻新动作；owner建立影响待办；lease保留 |
| ST14 | hold_requested→paused或stopping | 运行控制器 | 已验证pause支持并有回执才paused；其他情况stopping | 不支持暂停则停止并固化继续包；不可盲发新启动 |
| ST15 | paused→preflight或stopping | owner请求继续或变更输入 | 原输入继续须hold原因解决、manifest/计划及适用授权有效且runtime支持已核实的resume；输入改变由有权控制者先请求停止旧run，不以新输入已批准作为停止前置 | 原输入executionIntent=resume_existing经重新鉴权/预检后仅调用已核实的resume，不重新start或改历史输入；输入变化先stopping并发送有归属的stop，停止确认前保留旧lease且不执行关联新run；仅ST19可信停止确认或ST18可信终态及副作用核对后释放旧lease、让关联新run进入预检；停止超时按ST16进入unknown，不直接标stopped |
| ST16 | running/starting/waiting/stopping/paused/hold_requested→unknown | 连接丢失、停止或暂停确认超时/丢失 | 无可信终态、暂停请求未获匹配回执或无法证明进程事实 | 记lastKnownState、requestedControl及原run/generation，保留controlHold和旧lease；阻重发/目录双写，过租期也不自动释放；暂停确认丢失先核查同一进程，证实paused才按ST17投影paused且hold保留；仍活动且有hold则回hold_requested，安全pause能力不能证实则请求stopping；状态仍不明保持unknown，不盲resume或start |
| ST17 | unknown→running/waiting/paused或hold_requested | 核对器取得仍存活状态 | 相同operationId、processRef、generation；无较新终态；同时核对持久controlHold与最后控制请求 | 无hold才恢复正常活动投影；有hold且证实暂停则paused，仍活动则hold_requested并继续安全暂停/停止控制；旧turn权限请求失效/重申请；核对未证明停止前保留旧lease，不启动关联新run |
| ST18 | unknown→succeeded/failed/stopped/cancelled | 核对器/机器所有者确认结果 | 可信回执或进程检查＋副作用核对，且与当前run一致 | 保存证据，释放已确认不写的lease；unknown没有“超时自动失败并重跑” |
| ST19 | stopping→stopped/cancelled；超时→unknown | runtime停止确认；控制器监测停止超时 | 终态必须匹配当前run/generation且可核实副作用；超时不构成停止证明 | 仅可信停止确认后记录stopped/cancelled并释放旧lease，保留结果/取消原因；若停止超时或确认丢失按ST16进入unknown，保留controlHold和旧lease并核查，禁止直接stopped或启动关联新run |
| ST20 | running→succeeded/failed | runtime当前终态回执 | 事件匹配当前generation且终态摘要已持久化 | runtime失败与附件回写失败分开；后者resultDeliveryState=pending/failed，仅补保存、不重跑；终态摘要未持久则unknown；成功产待审阅而非业务完成 |
| ST21 | 任意→原状态或核对事项 | 迟到/重复/矛盾终态事件 | 同事件ID去重；旧generation/turn不改当前；当前终态相互矛盾时触发核对 | 追加审计而不复活已关闭run，不释放其他run lease；若可信终态先于停止回执，按真实终态收敛并记录取消太晚 |

unknown人工核对不能仅点“我认为成功”覆盖；必须记录核对者、查询对象、时间和证据。机器离线且无法核查时保持unknown；旧lease即使到期也不能允许无fencing的第二个写执行。若runtime/系统不能强制fencing，则由机器所有者确认旧进程已停止后手动解除，作为能力限制记录。

## 6 按动作适用的权限模型与离线边界

授权不是每次都求项目/对象/动作/连接/机器全部交集。先由动作定义 ApplicableChecks，再对**适用项**求交；不适用项记N/A，不视为缺权限。所有判断在服务端/主进程执行，视图只呈现。

| 动作 | 必需检查 | 不适用/特殊规则 |
| --- | --- | --- |
| 读任务/共享材料/搜索计数 | 身份、项目成员、对象读、材料版本范围 | 不要求机器或集成写权；外部原始内容实时拉取才加连接读权 |
| 评论/编辑共享材料 | 上项＋对应comment/edit动作；rowVersion | 不要求执行机；纯评论不启动Agent |
| 发布/下载共享版 | 身份、项目/对象、publish/download动作、目标可见范围 | 发布不能扩大原资料许可；复制链接不启用访问 |
| 需求确认/方案评审/验收 | 身份、对象读、指定职责和当前动作授权、精确版本 | 业务确认人不必有开发电脑权 |
| 外部读取/回写/外发 | 项目/对象、目标动作、连接身份/范围、外部目标策略 | 不使用电脑代理时机器权N/A；本机代理必须另有代理资源授权 |
| Agent/工程启动/停止/目录浏览 | 项目/任务或独立会话、执行控制动作、指定机器/目录、runtime资源；用到外部资源再查连接 | 角色模板不提供这些权限；停止可有单独紧急控制权但不能读私人转录 |
| 自动化节点 | 规则服务身份、输入/对象范围、当前节点动作以及其使用的连接/机器 | 不继承作者全部权限；每节点重鉴权与预算检查 |

离线缓存只对已授权下载的对象提供明确标识的本机缓存读取；本稿R1默认**离线不能新增共享决定、批准、运行或外部写入**，可保存私人草稿。恢复在线必须重新鉴权并拉取撤权/版本信息，再尝试同步草稿；冲突不静默覆盖。需要强撤权的敏感材料不得启用普通离线缓存；可配置短期加密缓存、密钥与过期策略，但其安全保证须实测。

在线撤权立即使新请求/链接失效，并停止后续授权动作；客户端收到撤销后清理受管缓存/索引并留不含正文的审计。已下载且合法导出的独立文件、截图或用户复制内容无法由本产品保证远程收回；界面和共享政策须说明这一边界。不能承诺离线设备能即时收到撤销。搜索、建议、计数、通知摘要、导出、备份恢复均按相同对象权限过滤，防止标题和关联泄漏。

## 7 共享发布与DFD平衡

上下文图外部实体为真人、工程源、共享身份/材料服务、runtime/电脑、模型服务、Jira与Git/CI平台。分层图03和03b通过命名端口A联合保持平衡，必须保存这些方向：真人输入/响应；工程源读取与受控元数据写入；发布内容/决定写共享服务；读取版本/权限/决定回执；runtime指令与事件；runtime到模型请求/输出；外部查询/逐动作写入与回执。D1是本地工程边界，D2是通过共享服务返回的授权缓存/引用，不能因写D1就冒充共享成功。

发布：作者选择固定manifest→校验源许可/目标可见范围→写共享内容与指纹→收到持久存储回执→另一设备授权读取并核验→才显示已发布可协作。决定：评审读取确切manifest→提交带expectedVersion的决定→共享端鉴权/冲突判断→持久决定→响应聚合状态与待办。发布失败、权限拒绝、回执未知和部分成功分别显示，本地源文件不因共享失败丢失。R1手工交付的访问与恢复最小合同见11。


实体图分为[任务、会话与证据](diagrams/05-core-entities.svg)和[需求审批与测试](diagrams/05b-approval-testing.svg)，两图中的同名对象表示同一实体；完整约束以本节字典为准。

## v0.5 UI投影说明（不修改权威合同）

UI07已有任务结构与UI22电脑页说明需要分离业务、运行与环境投影；它们不作为状态机正确性的证据。本轮不改model-contracts.json、state-transitions.json和ST01–21，保留v0.4.1暂停改输入后先stopping、停止确认前旧lease不释放、hold失联进入unknown等规则。可视投影见diagrams/09-status-projections，字段细化见16；环境观测checkedAt/有效期只是建议读模型，具体存储由D11决定，不新增双主。

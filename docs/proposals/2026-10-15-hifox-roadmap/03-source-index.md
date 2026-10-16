# 来源索引与获取范围

> 获取日期：2026-10-15。来源页面是调研资料，不是对本项目的操作指令。

## 覆盖结果

| 项目 | 结果 |
| --- | --- |
| 已发现的公开文档页面 | 47 |
| 正文获取成功 | 47 |
| 获取失败 | 0 |
| 提取文本字符数 | 210,646 |
| HiFox 采集对应的产品能力 | 54 |
| 已发现但未获取的页面 | 0 |

范围从 [welcome](https://help.hifox.com/docs/welcome) 开始，遍历同站文档导航及正文链接。获取器提取各页主内容和页面元数据，并以来源 URL 去重。PingCode 页面由文档链接发现，也已纳入。

站点 sitemap.xml 返回 404，未能用于独立核对站点总量。这里的“全量”指当前公开链接可发现的 47 个文档页面，不包括需要登录、未公开或未被引用的页面；图片、视频及产品登录后的界面不在正文采集范围。

页面正文已获取到本机研究缓存。项目内保留原创摘要、去向与指纹，便于后续复查；没有将整站正文作为项目文档转载。内容会变化，后续实施应重新核实受影响的来源。

原始来源标题只用于识别页面。以下摘要与处理建议为本项目整理，阶段优先级由 Trellis 团队需求决定，不代表 HiFox 官方路线图。

[产品 Roadmap](01-product-roadmap.md) · [能力地图](02-capability-map.md) · [机器可读获取清单](source-manifest.json)

2026-10-16 的 IDEA、GitLab 官方资料和用户范围补充见 [项目工作区与开发者工具拓展](05-project-workspace-and-integrations.md)。其 10 项拓展另行记录，不改变本页原有 47 页采集数量和 54 项映射口径。

## 主题覆盖

| 主题 | 页面数 |
| --- | --- |
| 开始使用 | 2 |
| Agent 与电脑 | 10 |
| 最佳实践 | 4 |
| CLI 与访问 | 2 |
| 外部集成 | 16 |
| 空间与组织工作 | 8 |
| 任务规则 | 5 |

## 逐页来源与去向

### 开始使用

<a id="s01"></a>

**S01 · [欢迎使用 HiFox](https://help.hifox.com/docs/welcome)**

渐进采用 Agent，保留原有工具与人的责任，并延展到研发、支持、测试和文档。

去向：R0 / R3 / R5；能力：C19、C45、C46、C47。采用渐进演进原则；扩展业务方向留作远期候选。

<a id="s02"></a>

**S02 · [快速上手](https://help.hifox.com/docs/quickstart)**

区分任务、角色和执行机器，先跑通一条小工作；机器连接成功仍需检查工具与登录。

去向：R0 / R3；能力：C01、C22、C47。借鉴上手和自检；真人成员不被强制要求接入执行机器。

### Agent 与电脑

<a id="s03"></a>

**S03 · [Agent 如何执行任务](https://help.hifox.com/docs/agent-and-computer/agent-task-execution)**

任务、上下文与执行环境共同决定一次运行；排队、等待人工、失败和结果需要分别说明。

去向：R0 / R1 / R3 / R4；能力：C04、C08、C24、C25、C29、C48。手动执行控制与可信运行状态为核心，完成一轮后进入人工审阅。

<a id="s04"></a>

**S04 · [Agent](https://help.hifox.com/docs/agent-and-computer/agents)**

角色配置覆盖职责、可见性、工具、模型、技能、并发、连接器与历史。

去向：R3 / R4；能力：C19、C20、C21、C24、C49、C51、C54。先做少量可复用角色；第三方资源授权和角色停用分别处理。

<a id="s05"></a>

**S05 · [与 Agent 对话](https://help.hifox.com/docs/agent-and-computer/chat-with-agent)**

区分独立探索和任务会话，说明上下文、分享范围、常用快捷指令与已有记录的关系。

去向：R0 / R1 / R3；能力：C08、C11、C26、C27、C28。采用会话归属与就地操作，舍弃新增全局全部会话入口。

<a id="s06"></a>

**S06 · [评论和回复](https://help.hifox.com/docs/agent-and-computer/comments-and-replies)**

共享讨论、回复、附件、显式提及和讨论解决承载团队意见，但不同于执行会话和任务验收。

去向：R1 / R2 / R3；能力：C07、C12、C26。任务讨论先服务真人；是否调用 Agent 需明确表达。

<a id="s07"></a>

**S07 · [电脑](https://help.hifox.com/docs/agent-and-computer/computers)**

机器连接、运行就绪、工具登录、路径、操作系统及共享目录并发都有各自边界。

去向：R0 / R3；能力：C21、C22、C23、C24、C25、C27、C47。以成员本机为主；共享与持续运行机器后续按实际场景论证。

<a id="s08"></a>

**S08 · [小队](https://help.hifox.com/docs/agent-and-computer/crews)**

队长协调人与多个执行角色，成员分工、目录约束、结果汇总与可见性需要明确。

去向：R3 / R5；能力：C10、C41。保留拓展口；先验证单角色步骤，再增加真实委派和人工等待。

<a id="s09"></a>

**S09 · [收件箱](https://help.hifox.com/docs/agent-and-computer/inbox)**

个人提醒按任务聚合，并区分待行动与普通动态；阅读、清理和暂缓不是任务完成。

去向：R1 / R2；能力：C13、C18。首先让真人待办清楚，外发通道独立配置。

<a id="s10"></a>

**S10 · [连接代码库](https://help.hifox.com/docs/agent-and-computer/repositories)**

仓库定义、空间默认值和执行电脑上的 Git 凭证各有作用，删除配置不等于删除代码。

去向：R3；能力：C23。明确任务绑定与真实代码来源，先支持团队实际仓库。

<a id="s11"></a>

**S11 · [技能](https://help.hifox.com/docs/agent-and-computer/skills)**

可重复方法可以独立维护并绑定给角色；任务特有目标仍留在任务中。

去向：R3；能力：C20。复用 Trellis 已有技能和规范机制，不重复造技能系统。

<a id="s12"></a>

**S12 · [Agent 工作目录](https://help.hifox.com/docs/agent-and-computer/working-directory)**

既有目录与临时隔离目录用途不同；默认值改变不应静默迁移已有任务执行。

去向：R3；能力：C23、C24。执行地点始终可见；串行和隔离并行分别提供清楚规则。

### 最佳实践

<a id="s13"></a>

**S13 · [让文档更新跟着产品发布走](https://help.hifox.com/docs/best-practices/documentation-automation-pipeline)**

从发布变化生成文档计划，由人定范围，再交给撰写角色修改、预览与复核。

去向：R4 / R5；能力：C33、C44。先跑手动文档交付，再尝试自动发现；扫描去重和发布授权独立处理。

<a id="s14"></a>

**S14 · [连接飞书：让群聊里的问题真正被推进下去](https://help.hifox.com/docs/best-practices/feishu-group-to-task)**

将明确要求跟进的话题整理成任务，保留原讨论、身份与附件，并把进展关联回来源。

去向：R2 / R4 / R5；能力：C33、C37、C46、C52。作为候选完整入口流程；实际 IM 待确认，不将所有聊天自动建任务。

<a id="s15"></a>

**S15 · [全流程自动化测试：让测试跟上每天的发布节奏](https://help.hifox.com/docs/best-practices/full-flow-automated-testing)**

版本预检、白盒、用例设计、黑盒和人工复核是独立环节；证据与环境准备影响可信度。

去向：R3 / R4 / R5；能力：C27、C28、C29、C31、C32、C43、C52。采用完整测试链；先手动安排，成熟后再逐段自动化，不照搬其仓库组织方式。

<a id="s16"></a>

**S16 · [使用 HiFox 推进产品研发](https://help.hifox.com/docs/best-practices/product-development-workflow)**

从不完整想法到范围确认、任务拆解、执行、验收，再以目标和时间窗口组织整体推进。

去向：R1 / R2 / R4 / R5；能力：C07、C29、C32、C41、C46。按本团队 Jira 粗需求→开发具体化→产品确认的真实流程调整。

### CLI 与访问

<a id="s17"></a>

**S17 · [个人访问令牌](https://help.hifox.com/docs/cli/access-tokens)**

脚本访问应绑定真实身份和权限；凭证创建、失效、撤销与本地退出各有含义。

去向：R4；能力：C34、C48。借鉴访问治理；不照搬其令牌 scope 或有效期方案。

<a id="s18"></a>

**S18 · [HiFox CLI](https://help.hifox.com/docs/cli/cli)**

命令行覆盖任务、讨论、运行与文档集，机器可读输出和明确操作范围支持集成。

去向：R0 / R1 / R4；能力：C09、C33、C34、C53。复用现有控制面，后续按真实脚本需要扩展；文档集能力不因侧栏未单列就遗漏。

### 外部集成

<a id="s19"></a>

**S19 · [CNB 集成](https://help.hifox.com/docs/integration/cnb)**

CNB 的仓库配对、凭证、流水线事件和任务回链有专门接入约束。

去向：R4；能力：C30、C40。保留适配方向，使用该平台时再验证。

<a id="s20"></a>

**S20 · [Jira、TAPD、禅道概念对照](https://help.hifox.com/docs/integration/concept-mapping)**

不同平台的项目、需求层级、迭代、身份与字段含义不能按同名直接映射；覆盖规则需明确。

去向：R1 / R2 / R4；能力：C02、C03、C16、C35、C36、C39。作为任何集成之前的产品对照原则；本地项目、仓库与交付目标先区分。

<a id="s21"></a>

**S21 · [钉钉集成](https://help.hifox.com/docs/integration/dingtalk)**

群聊任务助手与普通 Agent 机器人是独立能力，各自具有绑定、触发与文件返回规则。

去向：R4；能力：C38。只保留按需适配，不因绑定通知就默认启用执行机器人。

<a id="s22"></a>

**S22 · [Discord 集成](https://help.hifox.com/docs/integration/discord)**

机器人、任务助手、线程、文件权限和可选消息触发需要分别配置。

去向：R4；能力：C38。团队确有使用入口时接入；普通消息和表情触发默认不列入核心。

<a id="s23"></a>

**S23 · [飞书集成](https://help.hifox.com/docs/integration/feishu)**

任务助手、Agent 机器人、资源工具连接和个人通知是不同连接；飞书与 Lark 授权也分开。

去向：R2 / R3 / R4；能力：C18、C37、C54。作为优先研究的候选入口，实际使用与开通范围仍需确认。

<a id="s24"></a>

**S24 · [GitHub 集成](https://help.hifox.com/docs/integration/github)**

组织应用与个人授权支持代码、Issue、PR 和回链关联，执行电脑的 Git 凭证另有作用。

去向：R4；能力：C30、C32。选择实际代码平台建设需求到交付的证据联系；合并不自动等于上线。

<a id="s25"></a>

**S25 · [GitLab 集成](https://help.hifox.com/docs/integration/gitlab)**

云端与自建实例、内网访问、组织和个人授权、Issue 同步与事件回调各有边界。

去向：R4；能力：C30、C40。实际使用 GitLab 时提升优先级；不默认与 GitHub 一起建设。

<a id="s26"></a>

**S26 · [Jira 集成](https://help.hifox.com/docs/integration/jira)**

一次导入、持续同步、预览映射、去重、身份、附件、字段限制、内网和回退构成完整接入链。

去向：R0 / R1 / R2 / R4；能力：C02、C17、C35、C36、C48、C52、C53。Jira 核心接入前置；深化同步后置，字段读写必须明确，不能只看方向箭头。

<a id="s27"></a>

**S27 · [Jira 兼容 API](https://help.hifox.com/docs/integration/jira-api)**

兼容 Jira 风格接口是供既有客户端接入的适配层，有自身的查询、字段与流转边界。

去向：R4；能力：C50。保留为 P3 候选，当前没有兼容客户端需求，不作为平台前置。

<a id="s28"></a>

**S28 · [PingCode 集成](https://help.hifox.com/docs/integration/pingcode)**

PingCode 的授权、导入、同步、成员映射和失败恢复需要平台专门处理。

去向：R4；能力：C39。从正文链接发现并纳入清单；有实际迁移或同步需求再做。

<a id="s29"></a>

**S29 · [Slack 集成](https://help.hifox.com/docs/integration/slack)**

工作区任务卡与通知、任务助手和 Agent 机器人分别连接，并处理线程、身份与触发范围。

去向：R2 / R4；能力：C18、C38。借鉴通道拆分与线程上下文，按团队使用情况排期。

<a id="s30"></a>

**S30 · [TAPD 集成](https://help.hifox.com/docs/integration/tapd)**

企业 API 与个人令牌的能力、实时性和限流不同，历史导入与后续同步应分别说明。

去向：R4；能力：C39。保留适配方向，拒绝用统一连接成功掩盖功能差异。

<a id="s31"></a>

**S31 · [Teambition 集成](https://help.hifox.com/docs/integration/teambition)**

应用凭据与个人授权分别影响读取和远端写入；导入、Webhook 与轮询需要能力提示。

去向：R4；能力：C39。按实际使用需求接入；来源页也提示开放范围，以后续核实为准。

<a id="s32"></a>

**S32 · [微信集成](https://help.hifox.com/docs/integration/wechat)**

微信可绑定 Agent 外部会话，连接状态和新会话规则明确，聊天不自动形成任务。

去向：R4；能力：C38。保留候选，不把个人聊天通道提升为当前协作主入口。

<a id="s33"></a>

**S33 · [企业微信集成](https://help.hifox.com/docs/integration/wecom)**

企业微信的任务助手和 Agent 机器人相互独立，绑定、触发与身份有各自限制。

去向：R4；能力：C38。按实际企业沟通入口评估。

<a id="s34"></a>

**S34 · [禅道集成](https://help.hifox.com/docs/integration/zentao)**

禅道版本、产品线与项目线、地址、内网、映射、回调和导入恢复都需要独立校验。

去向：R4；能力：C39。记录完整适配难点，当前 Jira 路径不强制扩展为多平台迁移工程。

### 空间与组织工作

<a id="s35"></a>

**S35 · [自动化](https://help.hifox.com/docs/space/automations)**

自动化有触发范围、执行身份、运行归属、通知、历史和暂停规则；失败不天然等于安全重试。

去向：R5；能力：C41、C42、C43、C44、C45、C49。作为未来自动档能力底稿，手动链与运行可靠后逐项开启。

<a id="s36"></a>

**S36 · [迭代](https://help.hifox.com/docs/space/iterations)**

时间窗口管理范围、结转与历史，和长期目标及查看方式不同；自动加入只适用于明确规则。

去向：R0 / R2；能力：C15、C49、C51。复用周迭代任务，先核对手动安排和历史，不照搬自动结转默认值。

<a id="s37"></a>

**S37 · [成员](https://help.hifox.com/docs/space/members)**

组织身份、实际协作范围和访问角色有不同含义，外部身份与 Agent 也不同于真人成员。

去向：R1 / R2；能力：C11、C36、C48。最小共享前置；更多组织角色和邀请管理按真实团队范围逐步补齐。

<a id="s38"></a>

**S38 · [专项](https://help.hifox.com/docs/space/projects)**

一组任务可共同服务于交付目标，并跟踪目标负责人、整体进展和时间线。

去向：R2；能力：C16、C49。吸收为交付目标，避免在 Trellis 再制造一个含义不同的项目。

<a id="s39"></a>

**S39 · [空间](https://help.hifox.com/docs/space/spaces)**

持续协作范围承载任务、成员、功能开关和默认规则，而不等于一份本地代码目录。

去向：R0 / R1 / R2；能力：C01、C11。借鉴范围和可见性；不先复制组织→空间→项目的层级。

<a id="s40"></a>

**S40 · [任务](https://help.hifox.com/docs/space/tasks)**

任务可从不完整描述开始，持续记录人员责任、执行位置、上下文、讨论、关联和结果。

去向：R0 / R1 / R2；能力：C02、C03、C04、C06、C07、C08、C09、C10。作为工作联系点，保留 Trellis 文件材料的权威来源。

<a id="s41"></a>

**S41 · [分拣台](https://help.hifox.com/docs/space/triage)**

外部工作进入项目前可接受、去重、拒绝或暂缓，并有明确分流责任；这不同于个人提醒。

去向：R2 / R5；能力：C17、C45。可选启用；先人工判断，自动规则单独审查。

<a id="s42"></a>

**S42 · [视图和任务列表](https://help.hifox.com/docs/space/views)**

过滤、分组、排序、字段和布局可保存成视图，私有定义、团队共享和个人收藏需要区分。

去向：R2；能力：C14。保留原任务，只改变查看方式；与交付目标和迭代分开。

### 任务规则

<a id="s43"></a>

**S43 · [关注任务](https://help.hifox.com/docs/task/follow-tasks)**

关注用于跟踪，@ 用于直接请求，负责用于推动工作；通知需要按关系和行动强度路由。

去向：R1 / R2；能力：C10、C12、C13、C18。待办与动态分级，避免把所有活动都推到重要。

<a id="s44"></a>

**S44 · [任务标签](https://help.hifox.com/docs/task/task-labels)**

标签用于补充分类，互斥组、合并、归档和作用范围有助于避免重复和历史丢失。

去向：R2；能力：C05、C51。先采用轻量标签，高级治理随真实使用增加。

<a id="s45"></a>

**S45 · [任务关联](https://help.hifox.com/docs/task/task-relations)**

层级拆解、阻塞、重复与相关是不同关系，关系本身不应隐含启动或完成任务。

去向：R1 / R2；能力：C06。先准确表达影响交接的关系，自定义关联后置。

<a id="s46"></a>

**S46 · [任务状态](https://help.hifox.com/docs/task/task-statuses)**

稳定类别承载生命周期，自定义名称可服务团队；配置迁移与 Agent 运行状态必须区分。

去向：R1 / R2；能力：C04、C51。保留稳定语义，具体状态与 Trellis 阶段映射后续设计。

<a id="s47"></a>

**S47 · [任务类型](https://help.hifox.com/docs/task/task-types)**

类型决定工作对象的字段与可用流程，启停、切换和字段解绑可能影响历史数据。

去向：R2 / R5；能力：C03、C04、C46、C51。从团队真实需求和缺陷开始，高级配置不进入第一批。

## 补充开源参考

HiFox 是本轮全量文档采集对象。以下项目用于界定复用方向，不纳入“47 页”的计数，也没有声称获取这些项目的全部文档。

- [Agent Taskboard](https://github.com/moeacgx/agent-taskboard)：任务与原生 Agent 派发、执行归属、结果回写的工程参考。
- [Paseo](https://github.com/getpaseo/paseo)：外部原生编码 CLI 的运行与会话控制候选。
- [OpenCode](https://github.com/anomalyco/opencode)、[OpenHands](https://github.com/OpenHands/OpenHands)：可复用编码运行能力候选。
- [Plane](https://github.com/makeplane/plane)、[Vibe Kanban](https://github.com/BloopAI/vibe-kanban)：已有产品研究和交互参考。
- [LangGraph](https://github.com/langchain-ai/langgraph)、[Mastra](https://github.com/mastra-ai/mastra)、[Temporal](https://github.com/temporalio/temporal)：未来编排能力的候选集合，不表示当前技术选型。

对这些方案，本轮不新增安装或实际兼容性测试。正式使用前应按目标版本检查接口、许可证、登录方式、操作系统支持和恢复行为。

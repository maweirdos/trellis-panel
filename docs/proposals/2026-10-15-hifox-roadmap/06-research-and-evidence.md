# Trellis Panel 深入调研与证据边界

版本 v0.5.1。当前网页实测见15/16及本章第5节；第2节和第9/10节保留v0.4.1以前的工具/登录历史。核对时间 2026-10-16 UTC；Windows 本地日期可能为 10 月 17 日。面向产品、开发、测试与实施评审者。建议继续既有 R0–R5 顺序，但把 R1 的版本确认和跨人共享作为产品闭环的硬出口，把运行控制及自动化放在各自依赖成立之后。

## 1 范围与研究方法

本次读取真实项目、适用 AGENTS、Trellis 工作流与 brainstorm/before-dev 技能、相关源码和当前任务记录；按 Product Design audit 技能核查截图能力。进行文件读取、官方资料核对以及登录网页的低风险导航和截图；没有提交业务写入或运行Agent，没有执行 AI 作业、Jira 写回、邀请、令牌创建、删除、付款或发布。

证据标签统一为 **L 本地文件核对**、**H 官方文档声明**、**WEB 帮助站界面截图**、**U 本机应用实测**、**D 设计建议**、**P 待验证命题**。L 证明该检查点的代码或记录存在，不证明界面可用；H 证明公开说明，不证明当前客户端行为；D 不表示实施授权。v0.5已有19张经目检网页截图、25条观察记录；U01–U22各有部分观察或结构记录，仍未完成全路径验证。原生桌面专属行为没有实测。

历史 `source-manifest.json` 的 47 页和 S01–S47 编号保持原样，是前次研究元数据，不冒充本次重新抓取。新 H01–H14 为本轮实际打开的关键官方页面；H14 的 scope 结论由已物化父研究 PH46 补充核实。未进行目标用户访谈，画像和需求价值是基于已有团队流程的假设，需在试点验证。

## 2 本机与工具预检

项目位于 `D:\my_demo\trellis-panel`；现有 roadmap 位于本目录，工程历史位于 `docs/roadmap.md`。HiFox 进程可见，安装入口 `D:\my_soft_install\HiFox\HiFox.exe`。进程存在不能证明窗口、版本、登录或组织权限可用。

| 工具 | 实际结果 | 对研究的影响 |
| --- | --- | --- |
| PowerShell 文件和进程读取 | 可用；`rg` 不存在，改用原生检索 | 完成静态基线，不做 UI 自动化 |
| CUA inventory | apps=[]；有 Chrome 扩展及帮助站标签页 | 可以观察帮助站；没有返回可选的本机 Hifox 窗口 |
| CUA 原生控制 | 工具说明明确 native APIs disabled | 不调用原生鼠标/键盘、截图或 launch 绕过限制 |
| Windows Computer Use 技能 | 要求 node_repl + @oai/sky；当前工具集无 node_repl | 不以 shell、私有协议或自制自动化替代 |
| 工作区依赖加载 | 返回 only supported for local threads | DOCX 专用托管构建/渲染环境未取得；交付原生 Markdown、HTML 和可编辑图源 |
| 父任务普通消息接口 | 两次返回 thread not found | 阶段发现以正常进度输出供父任务读取 |

Product Design user-context 预检结果为 missing，无保存偏好可引用。没有读取凭据、用户业务数据库、Hifox 静态包或私人聊天。仓库有大量 staged/unstaged 改动；本轮仅在既有文档目录增补，不改产品代码、任务状态、索引或提交。

## 3 本地证据索引

| ID | 文件与定位 | 本轮确认 | 不可推断 |
| --- | --- | --- | --- |
| L01 | `src/shared/types.ts:36` TaskRecord | 有状态、负责人、分支、材料等字段；无正式版本审批实体 | 不能把负责人文本视为登录身份 |
| L02 | `src/main/services/scan.ts:107`、`:443` | 解析失败返回诊断；面板元数据编辑白名单排除 status/completedAt | 面板不能绕过 Trellis 生命周期权威 |
| L03 | `src/main/services/handoff.ts:29` | 确定性材料索引，列真实文件与已知缺失 | 交接包被复制不证明 Agent 已读取或遵守 |
| L04 | `src/main/services/acp.ts:137`、`:163`、`:211` | 会话按 root 过滤；恢复依赖能力声明；权限关联 generation/turn | 不保证所有 runtime 无损恢复或跨机迁移 |
| L05 | `src/shared/types.ts:1677` | ACP 有 starting/ready/busy/awaiting_permission 等运行状态 | 不是业务任务状态机 |
| L06 | `src/renderer/src/my/navigation.ts:17`、`:60` | 八个并列模块，区分项目/应用/本机/混合范围 | 导航标签不等于权限隔离 |
| L07 | `src/renderer/src/my/adapter.ts:118`、`:127` | comments 为空，成员从 creator/assignee 派生 | 不是正式团队讨论、成员授权或在线状态 |
| L08 | `src/main/services/flow-run.ts:40` | 本地流程记录通过临时文件更名保存 | 不证明跨机等待、重启续跑与外部补偿成熟 |
| L09 | `.trellis/tasks/10-11-cockpit-s0-glass-box/validation/ac-matrix.md` | 历史 AC9 blocked_external，AC10 not_run | 本轮未重跑，不能关闭旧缺口 |
| L10 | `.trellis/tasks/10-16-project-workspace-uiux/prd.md` | 项目窗口、窄模块栏、中央材料工作区正在推进 | 不能宣称视觉或原生窗口验收通过 |
| L11 | `.trellis/tasks/10-16-acp-runtime-foundation/task.json` | 最新记录有打包验证报告，原生输入/草稿/视觉项仍待补 | 旧版“只有 mock”的描述需更新；本轮未复现报告 |
| L12 | `src/renderer/src/my/my.css:1` | 现有绿色强调、Inter/微软雅黑回退、4/6/8/12 圆角和语义令牌 | 不允许仅为竞品对齐重做风格 |

精确基线指纹与采集文件清单见 `checks/baseline-hashes.json` 和 `checks/local-evidence.json`。行号是研究检查点，后续代码变化应以内容符号重新定位。

## 4 官方资料索引

以下为原创概括；引用点保持可追溯，不把整站正文复制入仓库。

| ID | 来源 | 本轮用途 |
| --- | --- | --- |
| H01 | [产品定位与渐进式采用](https://help.hifox.com/docs/welcome) | 编排既有编码工具；团队流程和任务上下文连续。 |
| H02 | [执行与任务](https://help.hifox.com/docs/agent-and-computer/agent-task-execution) | 运行、排队与业务状态需要分开阅读。 |
| H03 | [电脑](https://help.hifox.com/docs/agent-and-computer/computers) | 连接与 runtime 就绪是不同条件。 |
| H04 | [工作目录](https://help.hifox.com/docs/agent-and-computer/working-directory) | 并行 worktree 与共享目录串行是不同策略。 |
| H05 | [任务](https://help.hifox.com/docs/space/tasks) | 任务承载业务内容、负责人及协作关联。 |
| H06 | [收件箱](https://help.hifox.com/docs/agent-and-computer/inbox) | 通知聚合、已读和处理分开；新文档把对话交接移至对话模块。 |
| H07 | [Agent 对话](https://help.hifox.com/docs/agent-and-computer/chat-with-agent) | 独立与任务对话分开；任务会话归属、发起人和交接对象需明确。 |
| H08 | [Jira](https://help.hifox.com/docs/integration/jira) | 导入和同步不同；方向标签不能证明严格只读。 |
| H09 | [自动化](https://help.hifox.com/docs/space/automations) | 触发、执行身份、范围和运行记录是独立配置。 |
| H10 | [成员](https://help.hifox.com/docs/space/members) | 组织角色、空间成员和空间角色不能混为一项权限。 |
| H11 | [视图](https://help.hifox.com/docs/space/views) | 个人呈现、共享定义和任务本体分离。 |
| H12 | [迭代](https://help.hifox.com/docs/space/iterations) | 时间窗口和未完成范围需要明确处理。 |
| H13 | [分拣](https://help.hifox.com/docs/space/triage) | 外部反馈可先判断接收与重复，不能代替个人待办。 |
| H14 | [个人访问令牌](https://help.hifox.com/docs/cli/access-tokens) | 父任务提示细粒度 scope 缺口；不能据此接受无范围授权。 |

## 5 Hifox 应用覆盖矩阵（v0.5当前）

现有登录网页可访问，来源是Chrome extension、配置「维」、已有标签754833790；不是原生窗口。19张实际截图均已目检；25条记录中6条仅结构。完整步骤/图片和局限见[15实测审查](15-hifox-uiux-audit.md)，设计与验收见[16增补合同](16-ui-derived-design-contracts.md)。没有一行被标为全路径通过。

| 编号 | 页面 | 核查范围 | 结论与边界 | 证据 |
| --- | --- | --- | --- | --- |
| U01 | 启动、登录后首页、组织/空间切换 | 版本、身份范围、无空间、离线 | 已登录网页首屏；未测登录、组织切换、无空间、离线和原生启动版本。 | UI01-inbox-empty, UI19-document-library-empty |
| U02 | 全部任务/空间列表 | 列表、看板、搜索、筛选、零结果 | 仅示例看板与类型过滤入口；列表模式、复杂筛选、大数据量未验证。 | UI09-task-board |
| U03 | 已有任务详情 | 标题、人员、状态、材料、历史、返回位置 | 仅已有示例任务结构和历史失败；材料返回位置、完整视觉未验证。 | UI07-existing-run-failure, UI08-task-discussion-structure |
| U04 | 新建任务表单 | 必填提示、取消、未保存草稿 | 空标题禁用、类型菜单、关闭已观察；未提交，不证明服务端幂等与保存。 | UI10-new-workitem-form, UI11-workitem-type-menu |
| U05 | 类型、标签、关系 | 菜单分类、循环依赖/重复解释 | 类型入口与属性结构已观察；标签编辑、循环依赖与重复合并未验证。 | UI08-task-discussion-structure, UI09-task-board, UI10-new-workitem-form, UI11-workitem-type-menu |
| U06 | 任务评论与回复 | 锚点、已解决、@ 真人/Agent 语义 | 评论/回复结构已观察；未发送，不证明通知、锚点、解决和@语义。 | UI08-task-discussion-structure |
| U07 | 对话模块 | 发起者归属、等你/等人、行定位、未读 | 独立会话控件已观察；等你/等人、未读、发起者、并发未验证。 | UI06-conversation-controls |
| U08 | 任务对话 | 历史、多会话、布局和返回 | structure_only：仅任务对话结构和历史执行观察，没有可交付的任务对话截图。UI06仅为独立Agent会话入口参考，不计任务对话视觉覆盖；新运行、继续、取消、真实交接和布局恢复未验证。 | UI07-existing-run-failure, UI08-task-discussion-structure |
| U09 | 收件箱 | 聚合、重要、已读/稍后与对话分工 | 个人通知空态；无真实通知，不证明聚合、已读或稍后副作用。 | UI01-inbox-empty, UI16-triage-empty |
| U10 | Agent 列表与详情 | 无 Agent、禁用、职责、runtime | 列表、搜索零结果实测；创建表单结构观察；禁用/详情/保存未验证。 | UI02-agents-overview, UI03-agent-search-empty, UI04-narrow-search-expanded, UI05-agent-create-form, UI25-agent-settings-form |
| U11 | 电脑与 runtime | 在线/离线、连接/安装/登录区分 | 电脑页本地桥接提示已观察；私有可用徽标仅结构观察；安装、认证、真正执行未验证。 | UI05-agent-create-form, UI06-conversation-controls, UI07-existing-run-failure, UI22-computer-local-bridge-unavailable |
| U12 | 工作目录/仓库 | 目录来源、锁、worktree 策略和权限 | 只看到会话目录入口与创建表单Git工作方式；未打开目录选择、锁和worktree策略。 | UI05-agent-create-form, UI06-conversation-controls |
| U13 | 技能与小队 | 依赖、空态、队长与成员职责 | 技能空态与Agent/小队Tab入口已观察；小队详情、依赖、队长、执行均未验证。 | UI02-agents-overview, UI18-skills-empty, UI19-document-library-empty |
| U14 | 成员与空间权限 | 可见、无权、角色范围和邀请副作用 | 组织成员角色/空间列结构可见；只有所有者，普通成员、访客和拒绝场景未验证。 | UI23-members-role-scope, UI25-agent-settings-form |
| U15 | 专项/交付目标 | 范围、负责人、进度和空态 | 专项解释与空态；无实际目标，负责人、进度、结束路径未验证。 | UI14-task-navigation-more, UI15-delivery-goals-empty |
| U16 | 保存视图 | 私有/共享、临时更改、重置、窄屏 | 保存视图空态；未创建、保存、共享或重置，权限未知。 | UI09-task-board, UI13-saved-views-empty |
| U17 | 迭代 | 当前/历史/无迭代、结转语义 | 迭代空态与过滤入口；无历史，不验证结束和结转。 | UI12-iterations-empty |
| U18 | 分拣台 | 接受/重复/拒绝/暂缓菜单及空态 | 分拣入口与空态；未分拣、配置或接收外部记录。 | UI14-task-navigation-more, UI16-triage-empty |
| U19 | 自动化 | 触发、范围、历史、失败原因 | 自动化空态与用途说明；未启用、运行、检查历史或补偿。 | UI17-automation-empty |
| U20 | Jira/Git/IM 集成 | 只读连接状态、字段方向、失效授权 | 目录分类和UI文案；没有连接、同步、回写或失效授权测试。 | UI20-integration-directory, UI21-git-and-collaboration-integrations |
| U21 | 设置/CLI/PAT | 能力说明、掩码、撤销提示 | 设置导航、成员/集成/快捷键说明；未打开PAT、CLI、账号绑定或凭据页。 | UI20-integration-directory, UI23-members-role-scope, UI24-keyboard-preferences |
| U22 | 键盘/缩放/主题/窄屏 | 焦点、读序、状态非色彩表达 | 1000×900与1440×900网页视口、搜索展开和Esc关闭菜单；无原生/读屏/完整键盘/主题测试。 | UI03-agent-search-empty, UI04-narrow-search-expanded, UI24-keyboard-preferences |

## 6 竞品分析与设计含义

| 产品层面 | HiFox 官方说明 H | Trellis 现状 L | 可借鉴建议 D |
| --- | --- | --- | --- |
| 核心工作对象 | 任务承载人和 Agent 的协作 | 真正任务来源是 `.trellis` 和 Jira 绑定 | 同一个任务串联需求、版本、执行、证据，避免新造任务库 |
| 入口 | 任务与对话同时可达，文档描述仍在演化 | 模块已并列，API 问答另有本机范围 | 一个会话多个入口，打开精确任务和会话，不生成副本 |
| 交接 | 对话显示等你/等人，通知另聚合 | 正式审批与多人权限尚未成立 | 以 ActionItem 记录谁对哪个版本做什么；界面是投影 |
| 执行信任 | 机器、runtime、目录、队列分开 | ACP root、generation、turn 已有基础 | 分别显示业务/执行/交接/环境状态，不用一个绿点概括 |
| 计划 | 视图、专项、迭代用途不同 | 周迭代在推进，业务“项目”已明确 | 交付目标避免再叫项目；共享视图不复制数据或提升权限 |
| 集成 | 多任务系统、Git 和 IM | 已有 Jira/GitLab 服务，持续同步未全面证明 | 先满足实际 Jira 实例、逐字段授权，不复制全部厂商清单 |
| 自动化 | 事件、计划、小队等组合 | 本地 flow 基础存在 | 先手动闭环与持久证据，后小范围自动化；保留人工节点 |

本轮未实测 Plane、IDEA、Paseo 等产品；沿用前版“候选参考”而非新增竞品事实或最终选型。它们的版本、许可和可用性需另做技术试验。

视觉与交互可借鉴的模式是明确当前对象、可收起辅助信息、同一任务的就地会话、区分待办对象和通知、渐进展示环境配置。本轮只对已保存网页截图作定性布局观察，不测绘竞品像素值；Trellis 继续现有绿色强调与语义令牌。帮助站的三栏导航不作为桌面产品布局依据。

## 7 矛盾与风险登记

| ID | 问题 | 本轮处理与验证方式 |
| --- | --- | --- |
| P01 | 同一 Agent 并行会话的旧新说法不同 | 不推断并发保证；R3 对选定 runtime 的会话、目录与并发限制分别测 |
| P02 | 旧评论/关注页指向 Inbox，新对话专页移至 Conversations | U07控件与U09空态部分观察，真实交接未验证；Trellis 采用一份 ActionItem 多入口投影，入口名称待 UI 补证 |
| P03 | Jira → HiFox 标签不保证零写回 | 只读研究不触发；FR-038 要求逐字段与动作预览 |
| P04 | 任务对话标记完成可能联动任务完成 H07 | 不照搬；Trellis 生命周期仍归既有工作流，关闭会话不完成任务 |
| P05 | PAT scopes、worktree 与安全边界 | 不复制无细粒度授权；worktree 不阻挡进程访问其他文件/网络 |
| P06 | 复制邀请链接可能隐含开启邀请 H10 | 不执行；Trellis 复制与开放访问必须是两个显式动作 |

v0.5已补网页UI事实；权限、写入、真实执行与原生能力仍需后续受控补证。本文仍可作为可执行需求建议稿，但**不是最终产品验收通过的证明**。


## 8 父任务官方全量研究合并

父任务补充文件通过Library `libfile_2f5d6feeb3388191aa1552c17c710809` 的签名下载物化到本机，大小33164字节，SHA256为7732a92652ae8ee461b2f47ee664320bb2b44919fcc9ec434961da5044cfcec3；已实际读取。文件保存在 `research/parent-official-research.md`，为父任务本轮原创英文研究。其H01–H47在本稿引用时记为 **PH01–PH47**，与本地关键页面H01–H14不是同一编号。该文件报告47项功能能力及对应来源，另涉及服务/隐私说明，不计为客户端实测。

合并结论：运行发起身份与Agent所有者权限之间存在边界；外部/系统触发更需单独建模。仓库平台授权不等于执行机clone凭据；内部评论与外部回复是不同目的地；公开快照为显式导出；导入不等于持续同步，停用/回滚/删除各自独立。以上落实到FR-010/016/025–030/036–042和NFR-06–09/13。PH46支持PAT当前无创建时细粒度scope的声明；本稿把它作为参考风险而不复制该限制。

父研究同时引用ISO/IEC/IEEE 29148官方简介和NASA需求工程材料，用于“需求应可验证、可追溯、区分假设”的写作原则。本文没有执行认证评估，也不宣称符合该标准。精确来源与研究歧义见原研究末节；当时U01–U22未验证；v0.5的当前覆盖以第5节和15为准。


## 9 历史：v0.4.1之前网页端登录门槛

官方[快速上手](https://help.hifox.com/docs/quickstart)明确存在网页端。公开官方搜索结果提供 `https://app.hifox.com/` 入口；当前Chrome原有标签中没有已登录的HiFox业务网页。打开该入口后重定向至 `https://app.hifox.com/login`，可见邮箱登录、微信扫码和协议链接，未见业务导航。没有输入邮箱、扫码、提交认证、接受协议或创建账号。

`evidence/WEB-02-login-gate.png` 保存登录阻塞的裁剪截图，仅含标题、空邮箱框与继续按钮，主动排除二维码区域，不含凭据。它证明本次网页端登录门槛，不证明桌面登录状态，也不证明两端所有功能等价。已保存并打开核验。U01–U22的业务页面正常/空态/异常检查继续保持未实测，新增阻塞原因是网页端没有现成登录会话。此阻塞已在v0.5通过用户提供的现成登录Chrome会话解除；WEB-02保留为历史，不代表当前登录状态。


## 10 历史：v0.4修订边界

本版根据独立内容审查校正内部合同；没有新增Hifox业务UI实测证据。Chrome官方登录页保留供用户完成已有账号登录，尚未收到“已登录”确认，未输入认证数据。v0.4的48条FR、逐义务测试与模型定义是可审查建议，不能以结构检查分数宣称已实现。可编辑线框仍只作布局概念。

## 11 v0.5新增的事实边界

网页研究不替代原生验收，不证明登录/组织切换、双账号权限、跨设备材料、runtime执行、目录租约、Jira同步或自动化可靠性。已观察的本地桥接提示只适用于当前浏览器上下文；历史失败记录不证明服务目前仍失败。两个Agent创建入口可见性差异仅为结构观察，必须复核而非宣布漏洞。244条既有产品用例和12条UX增补均not_run。

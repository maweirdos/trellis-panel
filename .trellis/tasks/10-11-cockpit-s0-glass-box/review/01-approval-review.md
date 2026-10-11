# 审批发现与修改清单

审查日期：2026-10-11。结论：**changes requested**。优先级 P1 表示会导致核心能力错误、漏做或无法可靠交付；P2 表示应在设计定稿时补清的交互与验收问题。它们是方案审查结果，不是声称这些新功能已运行并出现故障。

## R01 · P1 · 上下文清单不是运行时间线

**原稿**：[prd.md:23](D:/my_demo/trellis-panel/.trellis/tasks/10-11-cockpit-s0-glass-box/review/baseline-v1/prd.md:23)、[design.md:41](D:/my_demo/trellis-panel/.trellis/tasks/10-11-cockpit-s0-glass-box/review/baseline-v1/design.md:41)。

`implement.jsonl`、`check.jsonl` 的真实条目是 `{file, reason}`，可带 `type: directory`；并不包含执行时间或执行结果。来源见 [task_context.py:110](D:/my_demo/trellis-panel/.trellis/scripts/common/task_context.py:110) 和 [注入读取器:399](D:/my_demo/trellis-panel/.codex/hooks/inject-subagent-context.py:399)。

**用户影响**：用户会误以为某条规范已经在某时刻被使用，实际只是文件被列入计划。

**通过条件**：改为 `ContextManifestView`，展示材料、理由、顺序、可读性和原文；运行事件单独展示。禁止从排列或 mtime 推导每条执行时间。坏行保留真实行号，包括空行带来的位置；未知字段不丢。现有 ArtifactViewer 的逐行显示可以复用，但须修正过滤空行后的行号偏移。

## R02 · P1 · 输出前不能宣告“已交付”

**原稿**：[design.md:137](D:/my_demo/trellis-panel/.trellis/tasks/10-11-cockpit-s0-glass-box/review/baseline-v1/design.md:137)、[149](D:/my_demo/trellis-panel/.trellis/tasks/10-11-cockpit-s0-glass-box/review/baseline-v1/design.md:149)。实际输出点见 [subagent hook:971](D:/my_demo/trellis-panel/.codex/hooks/inject-subagent-context.py:971)、[1211](D:/my_demo/trellis-panel/.codex/hooks/inject-subagent-context.py:1211)、[workflow hook:483](D:/my_demo/trellis-panel/.codex/hooks/inject-workflow-state.py:483)。

**用户影响**：如果输出管道断开，界面仍然可能显示成功。输出成功本身也不代表宿主已解析，更不代表模型遵守了规范。

**通过条件**：序列化完成 → 写 stdout 并 flush 成功 → 尝试记录 `context.emitted`。对用户最多表述“已输出至宿主通道”。输出后落账失败属于缺证据，不能提前记成功来规避。宿主确认是另一个有明确协议来源的事实，S0 不做。

测试必须包含序列化错误、BrokenPipe、输出后记录失败，且不得重复发送 hook 输出。

## R03 · P1 · task.status 不足以还原六个执行阶段

**原稿**：[design.md:86](D:/my_demo/trellis-panel/.trellis/tasks/10-11-cockpit-s0-glass-box/review/baseline-v1/design.md:86)。

本地流程中实施、检查、收尾可以持续保持 `in_progress`，见 [workflow.md:127](D:/my_demo/trellis-panel/.trellis/workflow.md:127)、[228](D:/my_demo/trellis-panel/.trellis/workflow.md:228)。归档是写 completed 后移动目录，见 [task_store.py:1351](D:/my_demo/trellis-panel/.trellis/scripts/common/task_store.py:1351)、[1433](D:/my_demo/trellis-panel/.trellis/scripts/common/task_store.py:1433)。

**通过条件**：拆开“任务记录状态”“最近观察到的活动”“归档位置”。没有显式阶段开始/结束证据时，不显示阶段停留时长、全部前置步骤完成或检查已通过。自定义状态保留原值；不同 workflow 的阶段表不能硬编码为全局事实。

## R04 · P1 · 回执契约不足以区分同一会话中的多个执行

**原稿**：[design.md:156](D:/my_demo/trellis-panel/.trellis/tasks/10-11-cockpit-s0-glass-box/review/baseline-v1/design.md:156)。

只有 `eventId` 与可选 `sessionId/taskId`，组装与输出事件不能可靠配对。Codex hook 的 session_id 在相关入口表示父会话，见 [hook:913](D:/my_demo/trellis-panel/.codex/hooks/inject-subagent-context.py:913)。同一父会话可并行启动多个相同类型子 Agent。

`hash8/bytes/truncated` 也没有定义“源文件”还是“实际输出”。真实 hook 有缺失、不可读、二进制索引、预算不足、截断等不同结果，见 [hook:328](D:/my_demo/trellis-panel/.codex/hooks/inject-subagent-context.py:328)、[344](D:/my_demo/trellis-panel/.codex/hooks/inject-subagent-context.py:344)。

**通过条件**：强制 schemaVersion；一次注入共享 injectionId；区分 project、worktree、task、run、parent/child session，未知字段明确为未知。记录完整 digest，UI 才缩写；区分 sourceBytes/includedBytes、源摘要/输出摘要及每项纳入结果。由材料化代码直接返回元数据，不再重新读文件推断。Python 生产者与 TS 校验使用同一组协议夹具。

## R05 · P1 · 追加后删除片段，没有定义完整恢复协议

**原稿**：[design.md:138](D:/my_demo/trellis-panel/.trellis/tasks/10-11-cockpit-s0-glass-box/review/baseline-v1/design.md:138)。

追加成功后、删除前崩溃会重复回收；追加半行会污染后续日志。设计没有持久去重、尾部恢复、配额、迁移和损坏处理契约。被引用的 [access/event-log.ts:35](D:/my_demo/trellis-panel/src/main/services/access/event-log.ts:35) 是内存日志，不提供磁盘恢复能力。

**通过条件**：落实 [架构建议 §3](02-architecture-direction.md) 的事务存储，或提供同等可验证的文件恢复方案。畸形数据不能只“丢弃并计数”；要保存有界诊断、错误原因与来源，且默认不保留敏感原始上下文。覆盖进程被杀、写失败、重复 eventId、旧版本记录、恢复后分页和容量耗尽。

现有 [app.requestSingleInstanceLock:384](D:/my_demo/trellis-panel/src/main/index.ts:384) 确实存在。本审查没有认定“无单实例保护”；它不能代替数据幂等和崩溃恢复。

## R06 · P1 · hook 源码位置与团队分发路径错误

**原稿**：[design.md:196](D:/my_demo/trellis-panel/.trellis/tasks/10-11-cockpit-s0-glass-box/review/baseline-v1/design.md:196)、[implement.md:21](D:/my_demo/trellis-panel/.trellis/tasks/10-11-cockpit-s0-glass-box/review/baseline-v1/implement.md:21)。

本项目 `.codex/hooks/` 是 Trellis 生成的平台目录，不是已确认的上游模板仓库。见 [generated-files.md:38](D:/my_demo/trellis-panel/.agents/skills/trellis-meta/references/local-architecture/generated-files.md:38)、[.template-hashes.json:54](D:/my_demo/trellis-panel/.trellis/.template-hashes.json:54)。

**用户影响**：在当前电脑跑通以后，其他开发的仓库未必具备能力，Trellis 更新还可能覆盖或触发冲突。

**通过条件**：首选上游模板改动，写清真实源仓库、版本与发布/升级步骤；上游尚不可用时把它列为待验证依赖。若改为 Panel 管理安装器，须正式调整设计，补版本探测、备份、冲突、禁用和卸载恢复。不得将修改本地副本描述为团队分发完成。

## R07 · P1 · 改错 UI 入口，并会被回执刷新打断阅读

**原稿**：[design.md:11](D:/my_demo/trellis-panel/.trellis/tasks/10-11-cockpit-s0-glass-box/review/baseline-v1/design.md:11)、[175](D:/my_demo/trellis-panel/.trellis/tasks/10-11-cockpit-s0-glass-box/review/baseline-v1/design.md:175)。

当前 [App.tsx:178](D:/my_demo/trellis-panel/src/renderer/src/App.tsx:178) 只在概览/归档/待办打开 TaskDetail；主任务页有独立 [TaskWorkspace:297](D:/my_demo/trellis-panel/src/renderer/src/pages/Tasks.tsx:297)，另有 [ArtifactViewer:169](D:/my_demo/trellis-panel/src/renderer/src/components/ArtifactViewer.tsx:169)。

普通 [watcher.ts:19](D:/my_demo/trellis-panel/src/main/services/watcher.ts:19) 监听整个 `.trellis`，触发 [state.ts:205](D:/my_demo/trellis-panel/src/main/state.ts:205) 全扫描与广播。阅读加载又依赖整个 task 对象，[Tasks.tsx:462](D:/my_demo/trellis-panel/src/renderer/src/pages/Tasks.tsx:462)。回执落盘可能因此引发文档反复 loading。

**通过条件**：共享文档读取控制器与阅读组件，三个入口复用；逐个列入实施清单。遥测路径独立于普通扫描/活动/知识索引通道；文档按路径与内容 revision 定向失效。项目切换丢弃旧异步结果；订阅游标回补防止快照与增量之间漏事件。

## R08 · P1 · Jira 基线与轻任务路径缺少真实接口支撑

**原稿**：[design.md:93](D:/my_demo/trellis-panel/.trellis/tasks/10-11-cockpit-s0-glass-box/review/baseline-v1/design.md:93)、[184](D:/my_demo/trellis-panel/.trellis/tasks/10-11-cockpit-s0-glass-box/review/baseline-v1/design.md:184)。

[jira.ts:114](D:/my_demo/trellis-panel/src/main/services/jira.ts:114) 固定最多 50 条且不翻页；它有 issueType/fixVersions，问题是完整性与稳定标识。现界面 [Jira.tsx:113](D:/my_demo/trellis-panel/src/renderer/src/pages/Jira.tsx:113) 按第一项版本分组，不足以统计多版本工单。

[IntakeModal:56](D:/my_demo/trellis-panel/src/renderer/src/components/IntakeModal.tsx:56) 保存手填待办，不是选择仓库/携带 Jira seed/创建 PRD 的工作流。已有 [task:createFromJira:84](D:/my_demo/trellis-panel/src/main/ipc/tasks.ts:84) 对应 [state.ts:392](D:/my_demo/trellis-panel/src/main/state.ts:392) 也只创建 task.json，不能直接算完成轻任务。`task.py --no-start` 本地确实存在，但它不能证明以上入口已经接通。

**通过条件**：统一 Jira→本地任务创建服务，保留 issue ID/key、来源版本和关联映射，重复点击可恢复且不重复建任务；默认当前项目，显式切仓。区分“打开我的工单”和修改 Jira assignee 的“认领”。分页统计必须附 JQL、版本范围、取回数/总数、完整性、多版本计数规则；不全就标样本。公司环境没权限时标未完成外部验收，不能填模拟数字冒充基线。

## R09 · P2 · 文档差异并不是现有 DiffModal 的能力

**原稿**：[design.md:31](D:/my_demo/trellis-panel/.trellis/tasks/10-11-cockpit-s0-glass-box/review/baseline-v1/design.md:31)。[DiffModal.tsx:18](D:/my_demo/trellis-panel/src/renderer/src/pages/DiffModal.tsx:18) 是任务字段旧值/新值展示，不是文本 diff。

**通过条件**：新增独立的只读文本对比能力，来源分别命名“本次打开版本 / 最近提交 / 两个提交”。没有提交历史的 PRD 仍应能比较本次阅读期间的未提交修改。S0 使用会话内快照；跨重启草稿历史另列范围，不能把 Git 历史写成它的替代品。不承诺没有实现的段落语义对齐。

## R10 · P2 · 三栏、专注模式和证据视觉缺交互契约

**原稿**：[design.md:25](D:/my_demo/trellis-panel/.trellis/tasks/10-11-cockpit-s0-glass-box/review/baseline-v1/design.md:25)。TaskDetail 默认只有 `min(920, windowWidth*0.62)` 宽，见 [TaskDetail:281](D:/my_demo/trellis-panel/src/renderer/src/pages/TaskDetail.tsx:281)。不能再同时塞入 760px 正文与两侧栏。

**通过条件**：采用 [UI 方向](03-ui-ux-direction.md) 的“快速预览 / 展开阅读”，宽度是最大宽度偏好；1280/1440/1920 CSS 像素都有明确折叠规则。Esc 按顶层弹层→专注→任务预览顺序处理，不让现有多个全局监听同时退出。无回执默认“未观察到”；只有明确诊断才标故障。不能以没数据推导仪器故障，也不靠颜色单独表达状态。

## R11 · P2 · 性能与容量写成了承诺，却没有测量依据

**原稿**：[design.md:138](D:/my_demo/trellis-panel/.trellis/tasks/10-11-cockpit-s0-glass-box/review/baseline-v1/design.md:138)、[207](D:/my_demo/trellis-panel/.trellis/tasks/10-11-cockpit-s0-glass-box/review/baseline-v1/design.md:207)。

包含文件列表的片段不保证小于 2KB；周期扫描空目录也有 IO；不能预先写“微秒级、可忽略”。

**通过条件**：把数值写为待测目标，明确超限怎么退让。20 次可用于探索，不能独自支撑稳定的尾延迟结论。验证包含 hook 开关差值、锁冲突、面板关闭、长期运行、冷启动回放和普通项目扫描次数；候选发布预算见架构文档，测不达就改实现或收窄能力，不能只交一张统计表即通过。

## R12 · P2 · 实施顺序和检查命令不能照抄执行

**原稿**：[implement.md:5](D:/my_demo/trellis-panel/.trellis/tasks/10-11-cockpit-s0-glass-box/review/baseline-v1/implement.md:5)、[47](D:/my_demo/trellis-panel/.trellis/tasks/10-11-cockpit-s0-glass-box/review/baseline-v1/implement.md:47)。

最先验证“安装 zod 能构建”没有覆盖最大风险。当前 `package.json` 没有 Vitest 或 test 脚本，有 `typecheck/build` 与 `scripts/smoke/`；本次执行 `trellis --help` 没有 `check` 子命令。Trellis check 是技能流程，不能伪装为已存在的 CLI。

**通过条件**：先验证真实宿主证据、打包运行时存储、升级路径，再铺 UI。使用现有 smoke 约定或明确新增测试工具及范围；列实际可执行命令。补 `store-conventions.md`、生成文件规范与修订后的协议文档到上下文清单，开工前完成；不要等实现结束才把关键约束加入清单。修正 PRD 对 06 章第 5 节“S0 阻断项”的错误定位。

## 审查完成与未完成项

- 已完成：原稿/源码对照、生成目录核实、当前 CLI 帮助检查、安装版 Electron 与 Python 的 SQLite 能力探测、官方开源文档调研、用户截图视觉基线审查。
- 未完成：新功能实现、产品 typecheck/build、真实 hook 注入试验、SQLite 跨进程/打包/故障试验、公司 Jira 全量取数、键盘/屏幕阅读器实测。没有把这些项目写成已通过。
- 本次未修改 `task.json` 的状态，也未开始该任务。

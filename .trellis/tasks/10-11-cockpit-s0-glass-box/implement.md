# 实施计划 · 驾驶舱 S0 v2

状态：规划；下面所有实施/发布检查尚未执行。对应 [PRD](prd.md) 与 [design](design.md)。本文件写执行顺序，不替代 implement.jsonl/check.jsonl 上下文清单。

## 1. 开工与阶段规则

- 本次用户授权是完善规划文件；本轮不执行 task.py start、不改产品代码、不修改 Hook/依赖。
- 实施应针对本版规划审阅后开展，不能使用原 v1 审查记录作为批准。
- 不新建任务树。本任务按下述阶段内部推进；将来确需独立交付/归档时再决定是否拆子任务，不能以目录树代替依赖关系。
- 每阶段结果写入 research/ 或 validation/ 的对应报告，不把计划中的测试命令写成已通过。
- G1 的 Hook 分发若被外部发布条件阻塞，G2 统一阅读可以独立推进；完整 S0 发布不能绕过 AC9。
- 同一轮不要同时修改上游模板、所有 UI 入口、Jira 和存储而没有中间检查点。

## 2. G0 · 建立可执行基线与依赖

进入：本版规划完成审阅，任务准备进入实施。输出：实际源码/运行时/公司条件清单，不是新功能。

- [ ] 核对本版 PRD/design、R01–R12 修订映射及上下文清单，记录代码基线与工作区已有修改；不回退其他任务的修改。
- [ ] 按 Trellis 当前步骤激活此既有任务；确认会话身份与任务指针，不新建重复任务。
- [ ] 验证现有 typecheck/build 和相关 smoke 的可运行环境，记录既有失败与新增失败，不能用已有问题掩盖新回归。
- [ ] 查明 Trellis 真正源仓库、模板源路径、生成/升级命令及发布权限，在 research/host-distribution.md 记录版本、路径和证据；.codex/hooks 只作为生成副本参考。
- [ ] 确定唯一首发认证组合：真实 Codex 版本、SubagentStart 入口、subagent-context Hook 版本；其他宿主标未认证。
- [ ] 记录 Electron/Node/Python/SQLite 版本，查 lockfile 与打包行为；内存探测结果仅作起点。
- [ ] 落实文档差异库 jsdiff 和必要时分栏库的兼容版本；Zod 版本按当前 TS/React 构建验证，不执行最新版 UI 生成器覆盖主题。
- [ ] 记录公司 Jira 类型/版本、实际分页端点、字段权限、目标两个版本和可访问性；暂不可得写待验证及负责落实的人。
- [ ] 将 D-SQLITE 与现有 database.md 的适用差异写入执行报告；只在选型验证通过后更新相应规范。
- [ ] 明确试点参与者和维护时间记录方式；人选未定不阻塞 G1/G2，但阻塞 AC10。

通过条件：没有遗漏的上下文入口；技术未知有对应验证步骤；不把上游和公司条件写成已获得。无法确定模板源时不得把本项目副本当生产分发目标。

## 3. G1 · 优先验证最大技术风险（AC3/AC4/AC9 的前置）

### G1-A 契约与真实输出

- [ ] 定稿 shared/observability v1 schema、身份、事件关联、材料字节/digest/结果与完整性口径。
- [ ] 事件、数据库、IPC 统一 Unix 毫秒；检查秒/毫秒、非法日期和外部 ISO 解析，避免不同来源时间错位。
- [ ] 建 Python/TS 共用黄金夹具：完整、裁剪、二进制索引、读失败、材料过多、父会话并行、未知字段/版本。
- [ ] 在隔离 fixture 验证一次真实宿主的 stdout 序列化/write/flush 边界；证明 emitted 在成功输出后记录。
- [ ] 注入序列化错误、BrokenPipe、assembled 写失败和 emitted 写失败；验证不重复 stdout、不吞原有输出错误、不凭缺记录判故障。
- [ ] 记录真实输入能取得哪些 session/task 字段；取不到就按 null/unresolved 处理，不编造能力。

### G1-B SQLite 与打包能力

- [ ] 在专用 worker 使用内置 node:sqlite，Python 写已存在库；验证中文/空格路径、缺库、只读库、版本不兼容。
- [ ] 在打包目录运行同样契约；包含 worker 文件路径与 Electron fuses/资源布局，不用 Node CLI 成功代替打包验证。
- [ ] 验证两个生产者并发、锁等待预算、重复 ID 同内容/异内容、commit 前后强制退出、提交失败。
- [ ] 验证迁移备份/失败恢复、库损坏、面板关闭配额暂停、物理体积保护、重新开启后的清理恢复。
- [ ] 分别验证观测库与控制库生命周期：清理/损坏观测不丢任务操作；控制库提交失败阻止创建副作用；控制恢复无法确认的目录进入恢复预览。
- [ ] 先采集正常/大材料开销样本；不达预算先调整记录范围/实现，不随意关闭同步保证或改成 stdout 前记成功。
- [ ] 输出 research/runtime-spike.md：真实版本、命令、输入、结果、未通过项、SQLite 采用/修订结论。

通过条件：驱动、契约和故障行为可实现。若内置驱动失败，可比较封装后的其他成熟驱动或不可变事件文件备选；更换方案必须回改 design 和上下文清单，不并行维护两份权威日志。

### G1-C 分发路径验证

- [ ] 在确认的上游模板源修改协议产出，记录对应提交/包版本；非本仓库改动列入交付依赖。
- [ ] 用干净 fixture 和有用户 Hook 修改的 fixture 验证安装/升级冲突/禁用/回退。
- [ ] 验证 Panel 能探测实际版本与能力，不因文件名存在就显示已支持。
- [ ] 不具备上游发布条件时记录 blocked_external；阅读模块继续，回执只能作为实验验证，不能完成 AC9。
- [ ] 若选 Panel 安装器替代，先完成安装/备份/冲突/卸载的单独设计修订，再开展该路径。

## 4. G2 · 统一阅读并隔离刷新（AC1/AC2/AC8）

主要影响：Tasks.tsx、TaskDetail.tsx、ArtifactViewer.tsx、MarkdownView/JsonTree/原文组件、store、文档 IPC、watcher/state。先抽共享能力，再逐入口接入，不一次重写所有页面。

- [ ] DocumentController：canonicalPath/revision、限额、坏文件/半写有限重试、旧版保留、按文档定向失效。
- [ ] ArtifactReader：Markdown、task 元信息、ContextManifestView、原文、目录；JSONL 保留实际行号与未知字段。
- [ ] 三入口使用相同加载/错误/版本契约；TaskDetail 展开后及返回时保留任务列表位置。
- [ ] 文档会话保留首次与当前展示版本，外部变化仅提示；用户确认后应用新版，按标题锚点/偏移恢复。
- [ ] jsdiff worker：会话草稿和最近提交比较，统一/并列视图、文本转义、耗时/大小上限；无 Git 有明确降级。
- [ ] 保留现有 tokens/Lucide；宽度按 max-width，观察按需展开；不硬塞三栏。
- [ ] 聚合 Esc/焦点归还逻辑，支持键盘、正文选择、表格横向滚动。
- [ ] runtime 路径从普通项目 watcher、活动和知识索引排除；回执文件变化不导致全量快照/正文 loading。
- [ ] 截图与走查：1280 阅读、1440 diff、1920 观察面板、预览展开、新版提示、缺文件/坏行/未知态；同时测试高缩放。
- [ ] 输出 validation/reader.md，列三入口、连续保存、无 Git、长文档、选区和键盘结果。

回退点：可关闭新 reader 开关回到已有容器；不得因 UI 回退删除用户文件。既有入口仍完整可用后再继续。

## 5. G3 · 观测查询、身份与活动（AC3/AC4/AC5/AC8/AC9）

依赖：G1-A/B 通过；UI 连接依赖 G2。真实发布依赖 G1-C。

- [ ] 绑定身份、任务别名和未归属区；覆盖多 worktree、同名任务、重复 ID、归档、项目复制/移动。
- [ ] 用仓库外 installationId 验证另一台机器相同路径的复制、安装 ID 缺失/重置；停止采集与迁移确认不删除旧数据。
- [ ] 实现 ObservationStore 的事务、配额、保留、迁移、诊断与显式清理；观测库与 control.sqlite 独立，清理事件不删除关联/操作；观测禁用不影响 LocalTaskService。
- [ ] ReceiptProjection 用 injectionId 关联，支持只有 emitted 的完整证据、清单 partial、当时摘要与当前文件不一致。
- [ ] ActivityProjection 保留来源：任务原始状态、文件变化、ACP 事件、归档分别显示；不把 Hook 回执升级为阶段完成。
- [ ] IPC 全链注册、分页上限、storeEpoch/cursor、快照后回补、eventId 去重、resetRequired。
- [ ] store 注册与项目切换取消/generation 防串线；无界事件不存 localStorage。
- [ ] 独立轮询可见/后台降频，关闭工作区停读；证据更新只刷新关联区域。
- [ ] 回执卡复用到任务工作区和 AcpConsole；配置页展示真实支持/启用/不兼容/存储异常，未知不标失败。
- [ ] 验证输出失败、观测失败、库锁冲突/满/损坏、中止恢复、配额、游标过期、订阅竞态。
- [ ] 输出 validation/observability.md 和 validation/host-distribution.md，明确实验 fixture 与真实员工环境的区别。

回退点：禁用采集，保留库；恢复兼容 Hook 版本时保护用户修改；UI 显示未启用。任务资料和 Agent 原有使用不依赖观测继续可用。

## 6. G4 · Jira 轻路径与可相信的统计（AC6/AC7/AC8）

- [ ] 扩充 Jira 字段和实际分页适配；fixture 覆盖超过 50 条、多版本、权限不足、取消、页失败/重试、数据变化。
- [ ] 报告包含 JQL、版本 ID/name、采集时间、取回数/服务端总数、完整性与去重规则；样本和全量分别标示。
- [ ] LocalTaskService 统一 task:createFromJira 等实际任务创建入口；IntakeModal 只复用适用字段，不把待办写入冒充任务创建。
- [ ] 建 operationId/预备目标与幂等关联，通过现有 --meta 在首次 task.json 写入时保存恢复标识；禁止 --force。验证 --no-start 的会话指针行为，失败可恢复且不覆盖用户修改。
- [ ] 验证跨午夜重试、task.json 已写/PRD 未写就中止、同名不同 operationId：先对账，已有骨架只续写，未创建跨日则更新预备目标，核实最终实际路径。
- [ ] PRD 草稿含工单来源/updatedAt/说明，不声称技术分析已完成；一单多任务是显式操作。
- [ ] 验证完整 Jira 描述到 PRD、富文本规范化、缺权限/裁剪提示；--meta 的扁平字符串只承载恢复标识，不将全文放命令行。
- [ ] 本地归档与手动 Jira transition 分开；超时后查询确认，权限/状态变化有可操作反馈，不盲目重复 comment。
- [ ] 用真实工单录制轻任务流程和新增动作计量；公司条件不足只运行 fixture，外部项保持未完成。
- [ ] 正常/大材料分别至少 200 次 on/off 测量，故障单列，记录 p50/p95/p99/max、运行环境、锁预算、回放/清理/扫描次数。
- [ ] 输出 validation/jira-baseline.md、validation/light-task.md、validation/performance.md，逐一声明真实/模拟/未完成。

回退点：关闭新 Jira 本地入口、保留已创建任务与关联；回退不能撤销已成功的 Jira 状态或删除员工资料。远端未知结果继续可见，不能强制归为失败后自动重试。

## 7. G5 · 跨人试点与发布（AC1–AC10）

- [ ] 2 名开发（至少 1 名非建设者）＋1 名需求协作者确认同一任务材料的阅读与交接；静态导出带版本/时间，不叫实时。
- [ ] 记录适配问题、重复操作、维护者用时；未达试点负担目标时写原因与调整结论。
- [ ] 执行所有适用基础检查、新增契约检查、真实宿主、打包、公司 Jira 与 UI 走查。
- [ ] 逐项填写 AC1–AC10：passed/failed/not_run/blocked_external、证据路径与条件。不得用“本地通过”代替公司环境与分发。
- [ ] 更新已实施的规范和使用说明，明确证据边界、存储保留、禁用/升级/回退方式；完成依赖许可清单。
- [ ] 经过 trellis-check 审查流程，修正实际失败；遵循当前 git/finish-work 规范收尾。只有目标实现与必需验收完成，才可归档本任务。

## 8. 检查命令与新增入口

以下是已存在的基础入口；按改动相关性执行并确认 Node/依赖环境，命令列出不表示本轮运行过：

```text
npm run typecheck
npm run build
node scripts/smoke/ipc-registry.mjs
node scripts/smoke/render-contract.mjs
node scripts/smoke/acp.mjs
npm run dist:dir
```

新增测试入口是**待实现**的计划，不是当前可运行能力：

| 计划入口 | 覆盖内容 | 实现阶段 |
| --- | --- | --- |
| node scripts/smoke/observability-contract.mjs | v1 schema、Python 黄金样例、语义及配对 | G1/G3 |
| node scripts/smoke/observability-store.mjs | 并发、失败恢复、去重、配额、迁移、游标 | G1/G3 |
| node scripts/smoke/task-reader.mjs | 解析、真实行号、revision/会话快照、路径边界 | G2 |
| node scripts/smoke/jira-local-task.mjs | 分页完整性、创建恢复、重复/远端未知状态 | G4 |

沿用当前 smoke 的 node:assert/fixture/esbuild 约定；如选择新的测试工具，先记录选择及必要依赖，不能写“项目有 Vitest”假定已配置。UI 截图/键盘、真正的 BrokenPipe/杀进程、公司 API 和打包 worker 仍需要对应集成验证，不能被纯函数 smoke 替代。

当前 CLI 帮助没有 trellis check 子命令；trellis-check 指技能/审查流程。不要将不存在的命令作为通过证据。

## 9. 待验证项与决策归属

| 项目 | 本轮状态 | 何时必须有答案 |
| --- | --- | --- |
| 上游模板源/发布版本与可升级性 | 未核实；不能私改生成副本冒充分发 | G0 定位，G1-C 证明，AC9 发布 |
| 内置 SQLite 打包/跨进程及不同 Python 版本 | 仅现机内存探测已通过 | G1-B |
| 公司 Jira 类型/权限/版本范围 | 待公司环境验证 | G0 记录，G4 实测 |
| 试点人选与维护投入 | 团队人数/推动范围已知，具体投入未确认 | G5 前 |
| 性能、文件大小和容量预算 | design 给出试验初值，非已有结果 | G1 初测，G4 定稿 |
| 视觉与产品边界 | 依本轮用户上下文确定，沿用现有 UI/本机开发 | 本版规划审阅；改边界须重新记录 |

这些项不妨碍交付可审阅的规划，也不构成已经通过实施/发布的证明。

# 参考项目 honsky-governance 的 Trellis 流程自定义调研

> 调研对象：`D:\my_demo\honsky-governance\.trellis`（只读，未做任何修改）
> 调研日期：2026-09-29
> 写给：trellis-panel 可视化面板优化提案

## 0. 这个项目是什么结构

honsky-governance 是一个「治理仓 + 两个业务子仓」的多仓工作区：

- 治理仓根目录（`.trellis`、`scripts/`、`docs/`、`CODEOWNERS`、`ci/` 所在地）
- `honsky-ultra/` —— 后端业务仓，独立 Git 仓库（Java/Maven），SQL 交付也在这里
- `his-workbench-frontend/` —— 前端业务仓，独立 Git 仓库（pnpm 微前端）

代码提交发生在业务子仓，Trellis 的任务/规范/日志归档在治理仓。这个「双仓」事实催生了后面一大半的自定义。

## 1. 怎么判断「自定义了什么」（方法说明，结论可复核）

- 两个项目都是 Trellis **0.6.17**（`D:\my_demo\honsky-governance\.trellis\.version` 和 `D:\my_demo\trellis-panel\.trellis\.version` 内容均为 `0.6.17`）。
- 用 `diff` 对比了两边 `.trellis/workflow.md`（700 行 vs 721 行）、`.trellis/config.yaml`、`.trellis/scripts/common/task_store.py`。
- 用 `.trellis/.template-hashes.json`（trellis 官方模板哈希清单）逐文件校验：`task.py` 与模板一致；`task_store.py`、`workflow.md`、`config.yaml`、`agents/implement.md`、`agents/check.md` 均为「本地已修改」；`run_package_command.py` 不在模板清单里（纯本地新增）。
- 用 `git log --oneline` 看了关键文件的演进（`8be339996 升级 0.6.17 并优化双仓执行流程`、`b90dfa34a 接入 Jira 工作流与个人凭据`、`58331584b 恢复归档前数据库交付门`、`8ed74eceb spec 准入分轨改造` 等）。

所以下面的每一条，都是「标准模板没有、这个项目加的」，不是猜的。

---

## 2. 自定义点清单

### 2.1 【团队约定（Honsky）】—— 写死在 workflow.md 里的团队规则层

**是什么**：标准三阶段流程（规划→执行→收尾）原样保留，但在 21 处关键步骤插入了以 `【团队约定（Honsky）】` 开头的段落（`grep -c` 统计为 21 处）。内容都是本地团队的实际做法，例如：

- 请求分类（workflow.md:151-152）：简单对话直接答；低风险小任务直接做，**不问「要不要建任务」**——比标准模板更宽松的入口。
- no_task 状态提示（workflow.md:180-182）：用户问「我的版本任务」→ 先查 Jira 不建任务；遗留 in_progress 任务要先提醒收尾。
- 2.1/2.2（workflow.md:509-511、570-572）：实现只做最小验证并**记录命令、退出码、范围**；检查阶段可**引用未失效的旧回执，不重复跑测试**。
- 3.3（workflow.md:633-635）：规范更新分两轨准入（见 2.6）。
- 3.4（workflow.md:643-644）：业务代码在子仓各自提交；提交标题带真实工单号，没有就 `[HONSKY-1111]`。

**怎么触发**：这些规则跟着 workflow.md 一起被读；部分还复制进了 `[workflow-state:*]` 逐轮提示块，即每轮对话由平台 hook 自动注入给 AI（契约注释在 workflow.md:102-137）。

**沉淀在哪**：workflow.md 本体（中文重写版）。

**对面板的借鉴**：面板可以把「团队约定」做成一等公民——按阶段/步骤挂载可编辑的约定片段，可视化展示「这一步有哪些本地规则」，而不是让用户去读 700 行文档。也可以校验 workflow-state 块和 `[required]` 步骤的对应关系（workflow.md:113-117 自己就记录了「曾经因为漏了提示被静默跳过」的事故）。

### 2.2 workflow.md / 技能的完整中文化 + 翻译保真检查

**是什么**：整个 workflow.md 是官方英文模板的中文重写（diff 逐段对应），`.agents/skills/` 下的技能也本地化。仓库根目录有两个维护脚本：

- `scripts/check_trellis_translation_fidelity.py`（159 行）——校验翻译保真
- `scripts/sync_trellis_skill_localizations.py`（54 行）——同步技能翻译

另外有 `scripts/fix_zcode_hooks.py`（82 行）修平台 hook。

**怎么触发**：手动/CI 运行；`trellis update` 升级时靠 `.trellis/.template-hashes.json` 按块保留本地修改（0.4.0→0.6.14→0.6.17 升过两次没丢定制，见 git 历史）。

**沉淀在哪**：workflow.md、`.agents/skills/*/SKILL.md`。

**对面板的借鉴**：「升级模板不丢定制」是面板用户的大痛点。面板可以读取 `.template-hashes.json`，把「哪些文件被本地改过、哪些还是模板原样」直接列出来（我这次就是这么校验的，说明数据是够的）。

### 2.3 中文任务命名（连 slug 生成代码都改了）

**是什么**：任务目录名强制 `MM-DD-{中文标题}`，标题内部不许用 `-`（会和日期前缀的分隔符混淆）。配套 `.trellis/spec/guides/task-naming-guide.md`。标准模板的 slug 函数只保留 ASCII（`re.sub(r"[^a-z0-9]", "-", ...)`），中文标题会变成全横线——所以他们**改了 `task_store.py` 的 slug 函数**支持 Unicode（diff 实锤，docstring 写明 "Honsky tasks use Chinese titles"）。

**怎么触发**：`task.py create "<中文标题>"` 自动生成；不需要传 slug。

**沉淀在哪**：任务目录名、`task.json` 的 `name`/`id`。

**对面板的借鉴**：面板的任务列表要按中文目录名解析和展示；「标题内禁用 `-`」这类约束可以在面板建任务时直接校验。

### 2.4 Jira 双向桥（最大的一块自定义）

**是什么**：`scripts/jira/`（cli.py 329 行、bridge.py 430 行、client.py、credentials.py、README.md）实现 Jira Software Server 8.1.0 与 Trellis 任务的关联和状态同步。

**怎么触发**（三类入口）：

1. **对话式**：「查看我的版本任务」→ `python -m scripts.jira.cli mine`；「做 HONSKY-1234」→ `show` 核对 → `import HONSKY-1234 --title "中文标题"`（import 视为同意建任务，不再问一次；已有别的活动任务要 `--switch`）。这些入口话术写在 workflow.md:338。
2. **生命周期钩子**：`.trellis/config.yaml` 里 `after_start` 和 `after_archive` 都挂 `python -m scripts.jira.cli __hook`——任务启动后自动把工单流转到「开发中」（从「待办,重新打开」），归档后流转到「开发完成」（从「开发中」）。可用起点在 config.yaml 的 `jira:` 段配置。
3. **对账**：`sync <任务>` 重试单个、`reconcile` 全量核对重试。

**关键设计**：
- 凭据放 **Windows 凭据管理器**（每个开发者身份一个凭据目标），不落任何文件；`login` 必须在 Codex 外的可见终端跑（内网 HTTP 无 TLS，明说风险）。
- 关联信息写进 `task.json.meta`：实样见 `09-28-药库麻醉药品用药目的维护/task.json`——`ticket: HONSKY-536, jiraIssueId, jiraVersionId, releaseVersion: V3.0.0B00015, jiraUrl, jiraUpdatedAt`。
- 同步失败**不阻断本地流程**，回执记「待同步/冲突」，留 `.trellis/.runtime/jira-sync/<hash>.json`（实样：`{issueId, checkedAt, result: synced, target: 开发完成, action: transitioned, task: <task.json 绝对路径>}`）。
- `mine` 按**状态类别**过滤而不是 resolution 字段（他们工作流会把中间值写进 resolution，标准过滤会漏单——commit `22f6d7f25` 就是修这个的）。

**沉淀在哪**：`task.json.meta`（入库）+ `.trellis/.runtime/jira-sync/*.json`（本机回执）。

**对面板的借鉴**：这是「外部工单系统 ↔ 本地任务」的一个完整参考实现。面板可以直接读 `task.json.meta` 显示工单号/版本/链接，读 jira-sync 回执显示同步状态（synced/待同步/冲突）；甚至可以把 mine/show/import 做成面板按钮。

### 2.5 数据库交付门（blocking before_archive 钩子）——标准 Trellis 没有的能力

**是什么**：`scripts/database_delivery_gate.py`（348 行）。后端 SQL 只能存在 `honsky-ultra/sql/oceanbase/<版本>/<schema>/<日期>_<中文说明>_<任务号>.sql`，收尾时要用 `tools/script-center/script_center.py submit` 上传到共享脚本中心，**归档前由这个门校验**：

1. 从 `TASK_JSON_PATH` 环境变量拿到 task.json，取 `meta.ticket`（没有就用兜底号 `HONSKY-1111`）；
2. 扫任务目录全部 `*.md` 里引用的 `sql/oceanbase/...` 路径（没有引用直接过）；
3. 逐条查：文件真实存在于 honsky-ultra、路径层级对、文件名单号和 meta.ticket 一致、文件名出现处±3 行内有「ID/id + 数字」的上传回执；
4. 任一 FAIL → 退出码 1 → **归档被阻断**，任务目录原地不动；
5. 附加警告网：同单号下存在但没在文档登记的 SQL 只 WARN 不拦；`--verify-online`/`--strict-online` 可选连共享中心比对脚本正文。

**怎么触发**：`task.py archive` 时自动跑（config.yaml `hooks.before_archive`）；也可手动 `python scripts/database_delivery_gate.py --task-json <path>`。

**重要发现——这个门需要改 Trellis 本体**：标准 0.6.17 只有 `after_create/after_start/after_finish/after_archive` 四个**非阻断**钩子（面板的 config.yaml 注释写明 "Hook failures print a warning but do not block"；面板的 task_store.py 里 grep 不到任何 `before_archive`）。honsky 给 `task_store.py` 打了补丁（task_store.py:1313-1321）：配置了 before_archive 就以 blocking 模式跑，失败返回 1 并打印 "Not archived: ... because before_archive failed"。

**沉淀在哪**：SQL 在后端仓；上传回执（脚本 ID）写在任务的 `implement.md` 里（门就从这里读）；门的输出直接打在归档命令里。

**对面板的借鉴**：「归档前门禁 + 阻断 + 补救指引」是面板最值得抄的交互——门失败时每条 FAIL 都带补救命令（SUBMIT_HINT），面板可以做成归档按钮的预检（dry-run 门），红绿灯 + 一键复制补救命令。另注意：若面板项目想用同款门，需要先给 scripts 打 before_archive 补丁（或等官方支持）。

### 2.6 规范双轨制：rules/ 严准入 + business/ 登记制（+ 机械校验门）

**是什么**：标准 Trellis 的 spec 只是「按包分层的规范目录」；honsky 把它改成了**两轨准入 + 一层思维指南**（定义在 `.trellis/spec/backend/index.md:48-58`）：

| 目录 | 定位 | 准入方式 |
|---|---|---|
| `rules/` | 全局编码契约，每次编码基线注入 | **严准入**：五项回执 + 驳回测试 + 用户对回执的独立确认（不得混进提交计划被「继续」级联批准） |
| `business/<模块>/`（phs/esb/bas/emr/fms/system） | 业务域知识库（契约、状态机、号段表） | **登记制**：触发场景 + 依据可核查 + 索引路由登记，frontmatter 必填 `status: verified\|pending`；owner 每月清账（删过期、改漂移、并重复） |
| `guides/` | 思维方法 | 不做硬检查 |

判别口诀：「换一个模块这条还成立吗？成立→rules，不成立→business」。

**配套机制**：
- `scripts/validate_spec.py`（136 行）机械门禁：frontmatter 必填字段、`> 版本：`/`> 更新时间：` 文件头、business 文件必须有触发场景章节、index 相对链接可达；还有**增长预警**——rules/ 近 30 天变更超过 5 个文件就警告「严准入在失效」。
- `CODEOWNERS` 把 `rules/`、`guides/`、各级 `index.md` 圈给 owner 审批，`business/` 任务内可直接提交。
- workflow.md 1.3（配上下文）有**业务路由规则**：JSONL 里基线规范必配，改动命中某业务域触发场景时必须配对应 `business/<模块>/` 文件，未命中要写明「业务域无命中」，不许只挂一个 index 糊弄。
- 实际体量：backend rules 9 篇 + business/phs 2 篇 + business/esb 8 篇；frontend rules 11 篇 + business/esb 5 篇 + business/phs 4 篇。

**怎么触发**：3.3 规范评估时按轨道走；validate_spec.py 在提交前检查跑（git 历史显示分轨改造是 `8ed74eceb` 一次性完成的，还补齐了存量登记）。

**沉淀在哪**：`.trellis/spec/{backend,frontend}/{rules,business}` + frontmatter 元数据。

**对面板的借鉴**：规范不再是平铺目录，而是有「准入轨道、状态、增长健康度」的资产。面板可以做：spec 资产页（按 track/status 分组，pending 的黄色标记）、rules 增长曲线（严准入是否失效的信号）、business 每月清账的待办提醒、以及「这次改动命中了哪些业务域规范」的路由预览。

### 2.7 双仓执行：包配置 + 安全命令转发 + 边界校验

**是什么**：三个互相配合的东西：

1. config.yaml `packages:` 声明 `backend → honsky-ultra`、`frontend → his-workbench-frontend`（都 `git: true`）。
2. **本地新增脚本** `.trellis/scripts/run_package_command.py`（207 行，不在官方模板清单里）：从治理仓根把命令**安全地转发到对应子仓执行**——按配置解析工作目录、校验 package.json/pom.xml 清单存在、不用 shell 拼接（防工作目录漂移到治理仓）；`--package` 缺省时按工具名唯一推断，歧义就报错要求显式指定。用法：`python ./.trellis/scripts/run_package_command.py --package frontend -- pnpm build`。
3. `scripts/validate_workspace_boundary.py`（67 行）：治理仓不得 track 子仓路径、子仓必须有 `.git`，并打印每个子仓的 branch/head/dirty 状态。

**怎么触发**：workflow.md:509 的团队约定要求 AI 优先用 run_package_command（或 pnpm -C / mvn -f）跑包命令；边界校验手动/CI 跑。

**沉淀在哪**：config.yaml；命令输出（stdout 直接展示）。

**对面板的借鉴**：面板若做「任务里跑命令」的功能，这个脚本就是现成的安全层——按包路由、清单校验、歧义失败。面板还可以直接展示多仓状态（branch/head/dirty per 仓），他们的边界脚本已经在打这个信息了。

### 2.8 需求风险分级 L0–L3 与审查分级联动

**是什么**：`.trellis/spec/guides/requirement-risk-grading.md`——从公司《企业迭代升级规范》迁来的分级：L0 紧急生产故障 / L1 核心业务变更 / L2 常规迭代 / L3 重构。复杂任务在 **prd.md 附录标注级别**（缺省 L2），级别决定两件事：交付必须带什么（L0 要回滚方案，L1 要最小相关测试+影响评估）和**谁审**（review-checklist.md §5：L0/L1 核心路径 CODEOWNERS 终审人必审约 15 分钟；L2/L3 AI 报告 + CI 绿直接合，零人工；小任务 CI 绿即可）。

**怎么触发**：规划时 AI 建议分级+说理由，用户可改；检查时按级别出报告章节。

**沉淀在哪**：prd.md 附录的级别标注；check 报告的「测试覆盖/影响评估」两节。

**对面板的借鉴**：给任务卡片加风险级别徽章，面板按级别聚合「哪些 L1 等着人工终审」——这是给管理者看的天然视图。

### 2.9 审查清单与「回执」文化（review-checklist.md）

**是什么**：`.trellis/spec/guides/review-checklist.md` 定义检查的硬格式：

- **规则加载映射**：按 diff 文件类型选 spec（`*.java` → java.md+code-quality+commenting；`*.vue` → component+micro-frontend……）。
- **范围纪律**：默认只审当前任务 diff，不全仓扫。
- **逐条回执**：每条已加载规则给「已查（通过/发现问题）」，**未查的必须显式标「未查」**，不许笼统写「符合规范」。
- **验证回执**：每项实际跑的验证记「命令、退出码、覆盖范围」；实现阶段已有等价回执且代码没变 → 检查阶段**引用不重跑**。
- **自修边界**：check 代理只能修机械性小问题（lint、命名、缺注释），业务逻辑/接口契约/数据格式**只报告不代改**。

实样见 `09-28-药库麻醉药品用药目的维护/check-report.md`：标题带工单号，逐表格回执，每个检查点都有依据（`xxx.java:161-167` 这种行号引用），阻断项单独拎出来。research/ 下五个调研文档全是中文名（`前端现有代码调研.md`、`研判-用药目的固定项.md`……）。

**怎么触发**：2.2 质量检查派发 `trellis-check` 子代理时，check 代理定义（`.trellis/agents/check.md:74`）明确指向这份清单，「不在代理模板里再复制一套规则」。

**沉淀在哪**：任务目录的 `check-report.md`（随任务归档）。

**对面板的借鉴**：**回执是这个项目最值得面板化的概念**。check-report.md 是结构化的（规则→结论→依据），面板可以解析并展示「本任务查了哪几条规范、几条通过、几条未查、跑了哪些命令退出码多少」；「有效回执可复用」可以做成回执的新鲜度追踪（代码变了回执自动失效）。

### 2.10 自定义技能：prd-writer + 周报/月报家族

**是什么**：对比两边 `.agents/skills/`，honsky 多了 6 个：`prd-writer`、`weekly-report`、`monthly-report`、`project-weekly-report`、`project-monthly-report`、`code-explain`。

- **prd-writer**：把产品 PRD/项目 docs/口述需求转成 **AI 可执行的 Trellis 任务 PRD**，强制区分「源事实、代码事实、用户决策、AI 推断、待确认」五类信息，不许把面向用户的 PRD 原文直接复制进任务。workflow.md:166 要求源自 PRD/路线图的任务必须走它。
- **weekly-report**（设计很讲究）：只从三类可核实来源生成——个人 journal、归档任务的 task.json（assignee 精确匹配 + completedAt 时区换算）、**明确记录的提交哈希**（在三个仓分别 `git show` 核实）。「不推断工时、不把计划写成成果、核不实的注明未核实」。

**怎么触发**：用户说「写周报/整理 PRD」时按技能 description 匹配。

**沉淀在哪**：报告输出给用户（不落盘）；它消费的数据是 journal + 归档 + git。

**对面板的借鉴**：面板天然适合做这种「证据链报告」——周报视图可以直接按同样规则从 journal/归档/提交聚合，而且比 AI 手工统计更稳定。「prd-writer 的五类信息区分」也可以在面板的 PRD 编辑器里做成字段化标注。

### 2.11 channel 运行时代理的本地化改造

**是什么**：`.trellis/agents/implement.md` 和 `check.md` 是 channel 运行时（`trellis channel spawn --agent implement/check`）的代理定义，标准 Trellis 也有这两个文件；honsky 在里面插了团队约定（模板哈希校验为「本地已修改」）：

- implement.md:43,53——只做最小验证并记录命令/退出码/范围；测试围绕可观察业务行为；**包命令在所属子仓执行，不从治理仓盲目跑**。
- check.md:72-74——新增「团队审查规则」一节，指向 review-checklist.md，不复制规则。

**怎么触发**：`trellis channel spawn --agent <name>`；收件箱收一行 `Active task: <path>` 定位任务产物，按 implement.jsonl/check.jsonl → prd → design → implement 的顺序读上下文。

**沉淀在哪**：代理的报告回到 channel（由主会话汇总）。

**对面板的借鉴**：面板做 channel 可视化时，注意「派发提示只写增量信息、上下文靠注入」这个约定——面板的派发界面可以只让用户填增量字段（改动范围/风险/验证许可），模板自动带 Active task 头。

### 2.12 config.yaml 的其他本地调整

- `codex.dispatch_mode: inline`——Codex 主会话内联做实现和检查，不派子代理；workflow.md 为此专门有 `planning-inline`/`in_progress-inline` 两个变体提示块（workflow.md:211-221、242-249），内联模式跳过 JSONL 整理、靠 `trellis-before-dev` 读上下文、`task.py start --allow-empty-context`。
- `channel.worker_guard: idle_timeout 5m / max_live_workers 6`——channel 工人的 OOM 防护（这两个键是标准能力，值是本地设的）。
- `hooks:` 段激活（见 2.4/2.5）。
- 注释里保留了标准的 `context_injection`（注入字节上限）和 `prompt_injection.skip_keyword`（"no-trellis" 跳过一轮注入）逃生口，未启用。

### 2.13 归档自动提交带工单号（适配远端 GitLab 钩子）

**是什么**：`task_store.py` 本地补丁加了 `_archive_commit_ticket()`：归档时的自动提交标题从 `chore(task): archive <name>` 变成 `[HONSKY-<号>] chore(task): archive <name>`，号取 `meta.ticket`，取不到回退 `HONSKY-1111`。原因写在 docstring 里：**远端 GitLab pre-receive 钩子强制提交标题以 `[HONSKY-<号>]` 开头**（commit `aaac1fa3b`）。同一批补丁还放宽了分支元数据校验：package 任务（backend/frontend）或没有 pr_url 的任务不查分支元数据，因为「业务子仓有独立分支」（标准版会拒绝缺 branch 的 PR 型任务）。

**怎么触发**：`task.py archive` 自动提交时。

**沉淀在哪**：治理仓的 git 提交历史（实测最近提交全是 `[HONSKY-1342] chore(task): archive ...` 格式）。

**对面板的借鉴**：面板做「归档」按钮时要意识到归档是**三段式提交**（工作改动 → 归档 → 会话日志，workflow.md:687），且标题有本地格式要求——面板可以从 task.json.meta 预生成提交标题。

### 2.14 ai-spec 运行时（前端页面生成的门禁回执）

**是什么**：`.trellis/.runtime/ai-spec/` 下有 `context/` 和 `receipts/` 两堆 JSON。这是他们前端「AI 页面规范」产品（见 `spec/frontend/rules/ai-spec.md`）的运行时沉淀：receipt 实样（`09-28-药库麻醉用药目的维护-药库前端.json`）记录 requestId、contextHash、目标 workspace/intent、changedFiles、**gateResults 数组**（eslint passed "exit 0"、targeted-tests "12 files / 74 tests passed"、vite-build、ai-spec-gate L2 passed）。按任务名命名。

**怎么触发**：页面生成/修改流程内部跑门禁时写。

**沉淀在哪**：`.trellis/.runtime/ai-spec/receipts/<任务名>.json`（本机，不入库）。

**对面板的借鉴**：这是「门禁结果结构化落盘」的又一实例——和 jira-sync 回执一样放在 `.runtime/` 下按需查询。面板可以把 `.runtime/` 下各类回执（jira-sync、ai-spec、sessions）统一做成「运行时状态」页。

---

## 3. 数据沉淀地图（面板可直接读的位置汇总）

| 数据 | 位置 | 备注 |
|---|---|---|
| 任务元数据（状态、分支、meta.ticket 等） | `.trellis/tasks/{MM-DD-中文}/task.json` | meta 段是 Jira 关联的入库位置 |
| 任务产物 | 同目录 `prd.md / design.md / implement.md / implement.jsonl / check.jsonl` | jsonl 每行 `{file, reason}` |
| 调研 | 同目录 `research/*.md` | 中文文件名+中文一级标题，强制 |
| 检查报告 | 同目录 `check-report.md` | 结构化回执：规则→结论→依据 |
| 归档 | `.trellis/tasks/archive/YYYY-MM/<任务>/` | 实有 2026-09，含大量中文任务 |
| 会话日志 | `.trellis/workspace/<dev>/journal-N.md`（2000 行滚动）+ `index.md` | frontmatter 带 `trellis-session: v=2 fp=<指纹>` |
| 活动任务指针 | `.trellis/.runtime/sessions/*.json` | 按平台会话隔离（claude_*、codex_* 文件实存） |
| Jira 同步回执 | `.trellis/.runtime/jira-sync/<hash>.json` | synced/pending/conflict |
| ai-spec 门禁回执 | `.trellis/.runtime/ai-spec/receipts/<任务名>.json` | gateResults 数组 |
| 规范资产 | `.trellis/spec/{backend,frontend}/{rules,business/<模块>}/+guides/` | frontmatter 带 type/module/status |
| 平台 hook / 插件 | `.claude/ .codex/ .cursor/ .zcode/ .opencode/` 等目录 | 逐轮 workflow-state 注入在这层 |
| todos | `.trellis/todos/` | 存在但为空，未见使用 |

## 4. 和标准 Trellis 的差异一句话版

标准 Trellis 给的是：三阶段流程、任务目录、JSONL 上下文注入、逐轮 workflow-state 提示、channel 多代理、生命周期钩子（仅 after_*、不阻断）。

honsky 在上面加的：**中文全面本地化**、**21 处团队约定**、**Jira 双向同步（钩子驱动+凭据管理器+回执对账）**、**阻断式归档门禁（打了 task_store.py 补丁）**、**SQL 交付全链路约定**、**规范双轨准入+机械校验+CODEOWNERS**、**双仓命令转发与边界校验**、**L0–L3 风险分级路由审查强度**、**回执文化（验证可复用、检查逐条回执）**、**6 个自定义技能（prd-writer/周报家族）**、**归档提交带工单号适配远端钩子**。

其中**改了 Trellis 本体代码**的只有一处半：`task_store.py` 的补丁（中文 slug、阻断 before_archive、工单号提交标题、分支校验放宽），以及 `.trellis/scripts/` 下新增的 `run_package_command.py`。其余全部是通过 workflow.md/config.yaml/规范文档/技能这些**声明层**完成的——这个「能用文档解决就不改代码」的分寸感本身也值得面板学习。

## 5. 没看到 / 不确定的东西（如实记录）

- `.trellis/.backup-2026-09-17T15-17-09/`：升级前的备份目录，未逐文件核对内容。
- `scripts/jira/client.py`、`credentials.py` 未逐行读（凭据管理器交互细节以 README 和 bridge.py 头部为准）。
- channel 机制本身（`trellis channel spawn` 的完整用法）是标准 Trellis 能力，本次只看了项目侧的代理定义文件，没有实测 channel 运行。
- `.trellis/todos/` 为空目录，用途未查明（标准 trellis 亦有此目录）。
- 所有「标准 Trellis 行为」的对照基准是本仓 `D:\my_demo\trellis-panel\.trellis`（同版本 0.6.17）；若官方 0.6.17 存在多种发行配置，对照结论可能受本仓安装形态影响——不过 template-hashes 校验独立佐证了「本地已修改」的判定，这个风险不大。

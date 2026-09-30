# 参考项目功能调研：honsky-governance 的领域功能与数据形态

> 调研对象：`D:\my_demo\honsky-governance`（治理基座仓，Trellis 管理的医疗 HIS 多仓项目：后端 `honsky-ultra` + 前端 `his-workbench-frontend`）。
> 调研时间：2026-09-29。方法：直接读 `.trellis/` 与仓库根 `scripts/` 下的真实文件（workflow.md、config.yaml、task.json、jsonl、spec、jira-sync 回执、脚本源码），全部结论均出自下列「证据」标注的路径。
> 四个功能块：Jira 集成、共享中心（共享 SQL 脚本库）、spec 规范库、tasks/todos 组织。

---

## 一、Jira 集成（Trellis 任务 ↔ Jira 工单双向桥）

### 1.1 是什么

Trellis 任务和公司内网 Jira（Jira Software Server 8.1.0，项目键 HONSKY，REST API v2，无 PAT）做**单向推状态 + 双向查关联**的桥接：

- 开发者在对话里说「查看我的版本任务」→ 只查 Jira 不建任务；说「做 HONSKY-1234」→ 按工单恢复或创建 Trellis 规划任务（workflow.md:180、workflow.md:338）。
- Trellis 生命周期驱动 Jira 状态：`task.py start` 成功 → 工单流转「待办/重新打开 → 开发中」；任务归档 → 「开发中 → 开发完成」。`task.py finish` 不动 Jira（workflow.md:480、workflow.md:698）。
- Jira 失败**不阻断**本地任务，只留「待同步/冲突」回执，靠 `reconcile` 补偿。

代码不在 Trellis 上游里，而是项目自有脚本：仓库根 `scripts/jira/`（`cli.py`、`bridge.py`、`client.py`、`credentials.py`、`README.md`），复用 `.trellis/scripts/common/` 的配置/任务工具（bridge.py:24-31）。

### 1.2 数据长什么样

**① 配置——`.trellis/config.yaml`（非敏感部分）**（config.yaml:39-53）：

```yaml
jira:
  base_url: "http://192.168.1.202:8083"
  project_key: HONSKY
  in_progress_status: "开发中"        # start 后的目标状态
  in_progress_from: "待办,重新打开"    # 允许自动流转的起点（逗号分隔）
  completed_status: "开发完成"        # 归档后的目标状态
  completed_from: "开发中"

hooks:
  after_start:   ["python -m scripts.jira.cli __hook"]
  after_archive: ["python -m scripts.jira.cli __hook"]
```

钩子命令通过环境变量 `TASK_JSON_PATH` 拿到任务路径，校验必须在 `.trellis/tasks` 下才执行（cli.py:226-238）。

**② 凭据——操作系统级，一人一份，仓库零口令**：

- Windows 凭据管理器「通用凭据」，目标名 `Honsky:Trellis:Jira:{sha256(base_url)[:16]}:{developer}`（credentials.py:24-26）。用 ctypes 直调 `CredWriteW/CredReadW/CredDeleteW`，不用 keyring 包（credentials.py:94-209）；非 Windows 走 `keyring`。
- 用户名（非口令）另存本机 profile：`%LOCALAPPDATA%/Honsky/Trellis/jira-profiles.json`，按开发者记 `{username, base_url}`（credentials.py:17-21）。
- 首配两条路：Codex 外可见 PowerShell 跑 `login --username`（getpass 隐藏输入 + 真实登录验证后写凭据），或 `credential-target` 打印目标名让用户在控制面板图形界面录入（README.md:9-17）。**明确禁止在 AI 的不可见终端里输口令**（workflow.md:338）。
- HTTP 无 TLS 这件事在 login/credential-target 输出里反复明示（cli.py:53-54、cli.py:115-116）。

**③ 关联信息——`task.json.meta`（扁平字符串）**（bridge.py:187-195，真实例子 tasks/09-28-药库麻醉药品用药目的维护/task.json）：

```json
"meta": {
  "ticket": "HONSKY-536",            // 工单 key，提交与 SQL 命名用
  "jiraIssueId": "11328",            // 数字 ID，用于去重（一工单一主任务）
  "jiraVersionId": "10404",          // Fix Version ID，稳定识别
  "releaseVersion": "V3.0.0B00015",  // 版本名，直接用作 SQL 目录
  "jiraUrl": "http://192.168.1.202:8083/browse/HONSKY-536",
  "jiraUpdatedAt": "2026-09-16T10:35:11.118+0800"
}
```

写回前有防覆盖守卫：工单已关联别的任务、任务已关联别的工单/版号、ticket 不是 `HONSKY-1111`（兜底号）也不是本工单 → 一律拒绝（bridge.py:198-228）。

**④ 同步回执——`.trellis/.runtime/jira-sync/{sha256(issueId)[:24]}.json`**（bridge.py:297-326，目录里有 3 个真实文件）：

```json
{
  "issueId": "11328",
  "checkedAt": "2026-09-28T13:17:55.990033+00:00",
  "result": "synced",        // synced | pending | conflict
  "target": "开发中",
  "action": "transitioned",  // transitioned | already
  "task": "D:\\...\\task.json"
}
```

每工单一个文件，先写 `pending` 再尝试，成功改 `synced`，BridgeError/JiraConflict 写 `conflict`+reason（bridge.py:370-420）。回执是**本机视角**（换机器就没了），所以 reconcile 对「归档任务无本机回执」只报冲突不自动补（bridge.py:357-369）。

**⑤ CLI 命令面**（scripts/jira/README.md:27-52，cli.py:266-313）：

- `mine [--release V...] [--include-resolved] [--json]` — 本人负责、未关闭工单，按 Fix Version 分组，行尾标 `[已关联 Trellis]`。JQL 用 `statusCategory != Done` 而非 resolution（本项目把中间态写进 resolution，标准过滤会漏单）（client.py:106-113）。
- `show HONSKY-xxx` — 工单详情（标题/状态/版本/负责人/描述/链接）。
- `import HONSKY-xxx --title "中文标题" [--release] [--allow-other-assignee] [--switch]` — 已有关联则恢复（校验版号一致），没有则调 `task.py create --meta k=v...` 建规划任务，并在 prd.md 追加「Jira 来源」小节（bridge.py:231-294）。标题必须含中文、不许自动抄 Jira 摘要（bridge.py:262-266）。
- `link <任务目录> HONSKY-xxx` — 给现有任务补关联。
- `status <任务>` / `sync <任务>`（人工核对后手动重试）/ `reconcile`（扫全部关联任务，重试待同步）/ `login` / `logout` / `doctor` / `credential-target`。

**⑥ 同步守卫（不猜、不倒退、不覆盖人工）**（bridge.py:329-420、client.py:161-186）：

- 未关联任务直接跳过；Trellis 状态无 Jira 映射跳过；`completed` 但目录未进 archive 跳过。
- 工单 key 变了 / Fix Version 列表不再含登记版号 → 冲突。
- 远端状态不在「允许起点」白名单 → 冲突（防止把「待测试」倒退成「开发中」）。
- 上次已 synced 但远端又不是目标态（说明有人手工动过）→ 冲突，不覆盖。
- transition 必须在可用流转里**唯一匹配**目标态才执行，执行后回读确认；同名流转/无直接流转/流转后状态不符都抛 JiraConflict（client.py:161-186）。

### 1.3 谁在什么场景用

- 开发者早晨开工：「我的版本任务」→ mine 列表 → 选一单 → import → 正常走 Trellis 规划。
- 规划期：Fix Version 与工单号成为提交前缀、SQL 路径/命名的**唯一可信来源**（workflow.md:363、workflow.md:644：`task.json.meta.ticket` 为准，不因分支名覆盖）。
- start/归档时：钩子自动推状态；AI 不在每个中间步骤推送 Jira（workflow.md:480）。
- 出问题时：`status` 看回执 → `sync`/`reconcile` 补；Jira 挂了也不挡本地开发。

### 1.4 值得面板借鉴什么

1. **关联即元数据**：外部系统关联不要另起库，塞进 `task.json.meta` 扁平字段随任务走、随 git 提交，面板任务卡片直接读 meta 就能显示工单号/版本/链接/最后核对时间。
2. **回执文件驱动的同步状态机**：`pending/synced/conflict` 三态 + 每单一个 JSON 回执，天然适合面板做「同步状态」列（绿=synceed、黄=待同步、红=冲突+原因），一键 `sync/reconcile` 就是调同一个 CLI。
3. **守卫规则显式化**：允许起点白名单、唯一 transition 匹配、不倒退、不覆盖人工改动——这些规则写在配置和代码里，面板照抄成「同步前预检」面板（先展示远端当前态和将执行的流转，再执行）。
4. **凭据安全模式**：仓库/任务文件零口令，口令进 OS 凭据管理器，面板可复刻「每开发者独立凭据目标名」和 doctor 体检入口。
5. **失败不阻断 + 补偿命令**：钩子失败不挡本地生命周期，靠 reconcile 收敛——面板的「健康巡检」可以直接调 reconcile 展示结果。

---

## 二、共享中心（共享 SQL 脚本库 script_center）

### 2.1 是什么

团队级 **SQL 脚本共享库**：数据库结构/种子数据变更的 SQL 定稿后统一上传到这里存档、查看、修订，**只存文本、绝不连 HIS 业务库执行**（schema.sql:61 注释：「一期仅保存和查看脚本，不负责在业务数据库执行」）。workflow.md 里叫「共享中心」（workflow.md:694）。

- 服务端：运维平台的 PostgreSQL，schema `script_center`，两张表（`schema.sql`）。
- 客户端：后端仓自带 CLI `honsky-ultra/tools/script-center/script_center.py`（README.md）。
- 它是「SQL 唯一保存在后端仓版本目录 → 上传共享中心 → 归档门校验回执」这条交付链的中枢。

### 2.2 数据长什么样

**① 存储模型**（honsky-ultra/tools/script-center/schema.sql:4-58）：

- `script_record`（脚本主表）：`id`（自增=对外的「脚本 ID」）、`service_code`（如 honsky-bas）、`schema_code`（如 bas）、`planned_release`（版本）、`task_key`（如 HONSKY-1406）、`title`、`sql_text`（正文 text）、`content_sha256`、`status`（CHECK 约束：`DRAFT | READY | LEGACY_ARCHIVED | CONFLICT`）、`revision_no`（乐观锁修订号，默认 1）、旧档字段（`original_bytes`/`legacy_kind`/`source_commit`/`source_path`）、created_by/updated_by。
- `script_revision`（修订历史）：`(script_id, revision_no)` 唯一，每版存 `sql_text + content_sha256 + change_note`。
- 生命周期：submit 产生 DRAFT → revise 必须带 `--expected-revision`（队友先改则失败）→ `ready` 锁正文（READY 后只能新建脚本，不能改）。
- 旧脚本迁移：`import-legacy` 从固定 Git 提交归档 152 个历史 SQL（状态 LEGACY_ARCHIVED，同 schema+版本不同内容标 CONFLICT），`verify-legacy` 逐条核对（README.md:3-6）。

**② 接入配置（每人一次）**：本机用户环境变量 `SCRIPT_CENTER_DSN` 存共享 PostgreSQL 连接串，`configure-connection.ps1` 隐藏输入密码并 URL 编码后写入（README.md:13-25）。连接串不进仓库/Jenkins。一期接受「创建人只记共享账号 postgres」的限制。

**③ CLI**（README.md:27-35）：`list / submit（返回脚本 ID）/ show <id> / history <id> / diff <id> --from-revision x --to-revision y / revise / ready`。

**④ 交付门 `scripts/database_delivery_gate.py`（仓库根，before_archive 阻断钩子）**（database_delivery_gate.py:1-27、config.yaml:47-49）：

- 离线主路径：读 `task.json.meta.ticket` → 扫任务目录 `*.md` 里引用的 `sql/oceanbase/...` 路径 → 逐条校验：文件真实存在、路径形状 `<版本>/<schema>/<文件名>.sql`、文件名 `YYYYMMDD_中文说明_HONSKY-数字` 且单号与 meta.ticket（未关联用兜底 HONSKY-1111）一致、文件名出现处前后 3 行内有「ID/id + 数字」上传回执。
- 任一 FAIL → 退出码 1 → **归档被阻断**；无 SQL 引用的任务零打扰直接过（盘上存在但未登记的同号 SQL 只 WARN）。
- 可选 `--verify-online` 调共享中心 `show` 比对正文，默认离线；`--strict-online` 把不一致升级为 FAIL。

**⑤ SQL 唯一保存约定**（spec/backend/rules/database.md:157-162「共享脚本库交付」）：

```
honsky-ultra/sql/oceanbase/<版本>/<schema>/<日期>_<中文说明>_<任务号>.sql
例：sql/oceanbase/V3.0.0B00015/phs/20260928_麻醉用药目的维护_HONSKY-536.sql
```

不在 Trellis 任务目录另存副本；真实例子见 tasks/09-28-药库麻醉药品用药目的维护/implement.md:5 与 check-report.md（check 子代理还逐项核对了路径命名/库名前缀/幂等）。

**⑥ 历史包袱与演进**（两个治理任务的 prd 佐证）：

- 旧模型（09-22-治理仓共享脚本库交付门接入/prd.md）：SQL 副本存任务目录 `database/` + `database-delivery.json` 登记（`status: required|not_required` + deliveries[] 含 script_id/revision/verified_at——归档里 09-16 任务仍能看到）。
- 09-27 门被误删，两单脚本漏上传靠用户追问才发现 → 09-28-恢复共享脚本库交付门/prd.md 按新模型重写：不再兼容 `database-delivery.json`，回执直接认 implement.md 里的「脚本ID 数字」文本，默认离线。这个「归档靠 AI 记得、漏了靠用户追问」的教训就是门存在的理由。

### 2.3 谁在什么场景用

- **开发者/AI（收尾 3.5）**：业务仓提交后、Trellis 归档前，从版本目录挑本任务 SQL → `script_center.py submit` → 拿到脚本 ID 记进 implement.md（workflow.md:694）。
- **归档动作**：`task.py archive` 触发 before_archive 门，校验不过就归档失败，错误信息带补救命令提示（SUBMIT_HINT 常量）。
- **队友/运维**：list/show/diff 查某个版本某个 schema 有哪些脚本；发布平台侧据此人工执行（共享库记录 ≠ 已执行）。
- **发布边界**：Jenkins 上含 DB 变更的发布暂停；无 DB 变更须显式 `DB_CHANGE_DECLARATION=NO_DB_CHANGE`（README.md:37-40）。

### 2.4 值得面板借鉴什么

1. **「唯一正本 + 共享登记 + 机器门禁」三件套**是这套的核心：正本唯一路径、登记有回执 ID、归档门用正则机器校验回执。面板做任何「交付物管理」（SQL、文档、迁移、发布单）都可套这个模式。
2. **门禁的容错设计**：无交付物零打扰、未登记只 WARN、登记错误才 FAIL、在线校验可选不依赖网络——面板的「任务完成度检查」应该同款分层。
3. **脚本库浏览界面空白区**：list/show/history/diff/revise 全是 CLI，面板天然适合做「共享中心浏览器」（按版本/schema 分组、revision diff 视图、READY 锁定状态展示）。
4. **失败案例驱动的产品迭代**：09-28 恢复门的 PRD 把「误删后两单漏交」写成现状证据——面板可以把这类「门禁命中/漏过」做成统计，反过来证明工具价值。

---

## 三、spec 规范库（.trellis/spec/）

### 3.1 是什么

按「包（backend/frontend）× 层（rules/business/guides）」组织的项目规范知识库，是 Trellis「规范靠注入不靠记忆」原则的载体。目录实况：

```
spec/
├── backend/
│   ├── index.md                 # 入口：开发前检查清单 + 规范选择路由表 + 质量检查 + 编写格式
│   ├── rules/                   # 全局编码契约（9 个：database/error-handling/java/logging/git-commit…）
│   └── business/{bas,emr,esb,fms,phs}/   # 业务域契约（esb 8 个、phs 2 个，bas/emr/fms 预留空目录）
├── frontend/
│   ├── index.md
│   ├── rules/（8 个：ai-spec/component/micro-frontend/state-management…）
│   └── business/{esb,phs}/
└── guides/                      # 跨包思维指南（7 个 + index.md）
```

**三类目录的判别问句**（backend/index.md:48-58）：「换一个模块这条还成立吗？成立→rules（严准入）；不成立→business/<模块>（登记制）；经验/教训→guides」。

### 3.2 数据长什么样

**① front matter（business 文件五字段，rules/guides 四字段）**（backend/index.md:109-116，真实例子 business/phs/drug-apply-status-granularity.md:1-7）：

```markdown
---
type: business          # rules | business | guides
module: backend         # backend | frontend | cross
business: phs           # 仅 business/ 文件加
status: verified        # 仅 business/ 文件加：verified | pending（登记制准入门）
title: 药品请领状态判定粒度契约
---
```

**② 文件骨架**：`# 标题` → `> 版本：v1.0.0` / `> 更新时间：YYYY-MM-DD` 两行元信息 → 每条规则 `## 标题` 用 `---` 分隔 → ✅/❌ 正反代码块 → 结尾必有「应做/不应做」总结。单条规则控制 1-2 屏（backend/index.md:156-168）。

**③ business 文件的正文结构**（drug-apply-status-granularity.md 全文结构）：适用范围与触发条件 → 必须保持的规则 → 依据与现状（含工单号、修复日期、全部消费方类名清单）→ 反例与后果 → 验证要点 → 应做与不应做。本质是「**触发器 + 不变量 + 证据**」格式的登记卡。

**④ index.md 是路由器不是目录页**：两张关键表——「开发前检查（Pre-Development Checklist）」勾选清单 + 「规范选择规则」两层加载路由表（backend/index.md:18-30）：

> 基线层——`rules/` 中与本任务工作类型相关的行，每个编码任务必读；路由层——`business/` 仅当改动命中下表对应业务域触发场景时必读，未命中不加载。

路由表按「改动类型 → 必读规范文件」映射，如「单号/单据引用 → bill-number.md + business/phs/bill-no-prefix.md」。

**⑤ guides 的定位**（guides/index.md）：跨模块「什么时候要想到、要问什么」，如跨层思维、代码复用、任务命名、Trellis 升级保护、审查清单；明确 Guide ≠ Code-Spec（Guide 放怎么想，Code-Spec 放具体怎么实现）。

### 3.3 怎么被流程消费（这是设计精髓：消费点全在 workflow 里）

1. **规划期 1.3 配置上下文**：AI 把 spec 文件路径写进任务目录 `implement.jsonl` / `check.jsonl`（每行 `{"file": "<path>", "reason": "<why>"}`），基线规范（index + 相关 rules）必配、business 命中必配、未命中要在 reason 里写「业务域无命中」（workflow.md:407-455）。真实例子见 tasks/09-28-药库麻醉药品用药目的维护/implement.jsonl：14 行，每行一条 spec + 一句为什么。子代理平台 hook 会把这些文件**注入**子代理首提示（workflow.md:522-526）；内联平台由 `trellis-before-dev` 技能现场读（workflow.md:558-566）。
2. **执行期 2.2 质量检查**：「先按本次改动读取受影响包的 spec 索引和适用规则、业务契约，再逐项核对」；检查报告逐条回执（workflow.md:570）。
3. **收尾期 3.3 规范评估（分轨准入）**：`rules/` 严准入——五项回执 + 驳回测试 + **用户独立确认**，不得混进提交计划被「继续」级联批准；`business/` 登记制——触发场景 + 依据可核查 + front matter 必填 status，随任务提交走，**owner 每月清账一次**（删过期、改漂移、并重复）（workflow.md:633-635、backend/index.md:44）。
4. **机械门禁 `scripts/validate_spec.py`（仓库根）**：front matter 必填字段、文件头两行元信息、business 必须有触发场景章节、index 相对链接可达——硬失败退出码 1；另有软提示「rules/ 近 30 天新增>5 个文件说明严准入在失效」（validate_spec.py:1-15）。
5. **get_context.py --mode packages** 列出包和规范层供 AI 选路（workflow.md:35-36）。

### 3.4 谁在什么场景用

- **AI 编码前**：按 index 路由表两层加载，避免整库灌入。
- **AI 检查时**：对照 rules + business 逐条回执（check-report.md 里真实呈现：每个检查点注明依据哪条 spec）。
- **任务收尾**：评估是否有长期约束要沉淀，按分轨准入写入。
- **人（owner）**：每月清账 business 登记项；审阅 rules 准入（用户独立确认是 rules 的硬门）。

### 3.5 值得面板借鉴什么

1. **两级加载（基线必读 + 命中路由）是上下文经济学**：面板做「任务→规范」自动推荐时照此分层，未命中也要显式记录「无命中」防糊弄。
2. **front matter 的 `status: verified|pending` + 每月清账**：给知识条目加生命周期，面板可做「规范库体检」视图（pending 超期、30 天 rules 增长告警——validate_spec.py 已有这个算法，搬过来即可）。
3. **`{"file","reason"}` 的 jsonl 上下文清单**：面板展示任务时可直接解析出「这个任务读过哪些规范、为什么」，是很好的任务上下文透出物。
4. **机械门禁（validate_spec）+ 流程门禁（用户独立确认）分层**：格式问题机器拦，价值判断人来拦。
5. **index 即路由表**：规范库 UI 不要做成平铺文件树，按「改动类型→必读清单」组织入口。

---

## 四、tasks / todos 的组织方式

### 4.1 tasks：一任务一目录，生命周期清晰

**目录形态**：`.trellis/tasks/{MM-DD-中文标题}/`（命名强制中文、标题内禁用连字符，workflow.md:44），内含：

| 文件 | 作用 | 实例 |
| --- | --- | --- |
| `task.json` | 任务主记录（见下） | 所有任务 |
| `prd.md` | 需求/约束/验收（复杂任务另加 design.md 技术设计、implement.md 有序执行清单） | 所有任务 |
| `implement.jsonl` / `check.jsonl` | 子代理上下文清单（`{"file","reason"}`/行） | 支持子代理的平台 |
| `research/*.md` | 调研产物，一主题一中文文件名 | 09-28 任务有 6 个 |
| `check-report.md` | 检查子代理的验收报告（较新实践） | 09-28 任务 |
| `database/` + `database-delivery.json` | 旧交付模型的 SQL 副本与登记（新模型已废弃） | 09-16 归档任务 |

**task.json 字段**（09-24 Jira 任务真实内容）：`id/name/title/description`（中文）、`status`（planning → in_progress → completed，由 create/start/archive 迁移）、`priority`（P2）、`creator/assignee`、`createdAt/completedAt`、`branch/base_branch`、`commit/pr_url`、`subtasks/children/parent`（父子任务树）、`relatedFiles`、`notes`、`meta`（Jira 关联等自由键值，`--meta k=v` 传入）。

**运行态与归档**：

- 活动任务指针按**会话**隔离存 `.trellis/.runtime/sessions/`（多人/多会话不互踩；workflow.md:79）。
- 归档进 `tasks/archive/{yyyy-MM}/` 月度桶（当前 2026-09 有 33 个归档任务），archive 同时置 completed、移目录、清运行时指针、触发 after_archive 钩子。
- 父子任务：一请求多交付物时建父任务（源需求+任务地图+集成审查），子任务独立验收；父子≠依赖，顺序写进子任务文档（workflow.md:169-174）。
- 轻量任务只写 PRD；复杂任务 start 前三件套齐+jsonl 就绪才放行（workflow.md:161、451）。

### 4.2 todos：空目录，实际未用

`.trellis/todos/` 存在（2026-09-24 创建）但**没有任何文件**；`.trellis/scripts/` 下也没有任何脚本引用 "todos"（grep 无命中）。结论：该项目的待办管理全部走 tasks（轻量任务直接处理不留痕，常规任务建目录），todos 是 Trellis 模板带的空壳，本项目未启用。如实记录，没有发现别的用法。

### 4.3 值得面板借鉴什么

1. **task.json 的 meta 是扩展锚点**：Jira 集成没改 Trellis 核心，全靠 `--meta` 塞关联字段 + 钩子读 meta——面板接外部系统时同样应该「不改核心、只扩 meta」。
2. **会话级活动任务指针**（runtime/sessions）让多个 AI 会话并行不冲突，面板做「当前任务」展示时要按会话取，不是全局单例。
3. **月度归档桶 + 中文任务名**：目录名即「日期+人话标题」，面板任务列表的展示/检索/归档分组可以直接按这个结构镜像。
4. **jsonl 上下文清单**（file+reason）是「任务需要读什么」的显式契约，面板可做只读校验（清单里的文件是否还存在、reason 是否写了无命中）。

---

## 五、顺带观察（与面板相关的其他形态）

- **workspace 日志**：`workspace/<developer>/journal-N.md`（每文件 2000 行自动轮转）+ 个人 index.md；每节 Session 由 `add_session.py` 自动生成，带指纹注释 `<!-- trellis-session: v=2 fp=... -->` 防重放；Session 结构 = 标题/日期/任务/分支/一段话 Summary/提交表格/状态/遗留（workspace/index.md 模板 + journal-1.md 实例）。会话日志是「AI 干了什么」的审计流，面板的时间线视图可对齐这个结构。
- **config.yaml 是团队约定的物理落点**：jira 段、三个钩子、packages 双仓声明（backend=honsky-ultra、frontend=his-workbench-frontend）、channel worker 限额都在这一个文件；面板的项目设置页可以以它为投影。
- **`.trellis/.runtime/` 全是机器态**：sessions（会话任务指针）、jira-sync（同步回执）、shell-tickets、backups、ai-spec——git 不跟踪、可随时重建，和 tasks/spec（人看的、进 git）分得很清楚。面板缓存层可参考这个「人件/机件」分离。
- **tests 就近放**：`scripts/tests/test_jira_bridge.py`、`test_jira_http.py`、`test_database_delivery_gate.py` 用假 HTTP/凭据提供者覆盖登录失败/分页/多版本/去重/幂等/冲突分支（design.md:34「不拿真实口令入库」）。

## 附：主要证据清单

- `.trellis/config.yaml:39-53`（jira 段 + hooks）
- `.trellis/workflow.md:180,338,363,480,644,694,698`（Jira/共享中心在流程中的挂点）；`workflow.md:42-79`（任务系统）、`407-455`（jsonl 上下文）、`633-635`（spec 分轨准入）
- `scripts/jira/{README.md,bridge.py,cli.py,client.py,credentials.py}`（全部 Jira 实现）
- `.trellis/.runtime/jira-sync/*.json`（3 个真实回执）
- `.trellis/tasks/09-24-治理基座Jira任务接入与状态同步/{prd.md,design.md,task.json}`、`09-24-治理基座trellis工作流与技能统一整改/`、`09-28-药库麻醉药品用药目的维护/{task.json,implement.jsonl,implement.md,check-report.md}`
- `honsky-ultra/tools/script-center/{README.md,schema.sql}`、`scripts/database_delivery_gate.py`、`scripts/validate_spec.py`、`scripts/validate_workspace_boundary.py`
- `.trellis/spec/backend/index.md`、`frontend/index.md`、`guides/index.md`、`backend/rules/database.md:157-162`、`backend/business/phs/drug-apply-status-granularity.md`
- 归档：`tasks/archive/2026-09/09-22-治理仓共享脚本库交付门接入/prd.md`、`09-28-恢复共享脚本库交付门/prd.md`、`09-16-拆零台账管理页与盘点校准/{database-delivery.json,implement.md}`
- `workspace/index.md`、`workspace/maweirdos/journal-1.md`
- `.trellis/todos/`（空目录，find 无文件；scripts grep "todos" 无命中）

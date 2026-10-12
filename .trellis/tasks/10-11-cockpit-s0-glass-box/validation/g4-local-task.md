# G4 第一片 · Jira 数据层与 LocalTaskService 验证（g4-local-task）

日期：2026-10-12。范围：implement.md G4 第一片（Jira 查询扩充 + LocalTaskService + 归档/回写服务契约 + 冒烟 + 基线骨架）。**不含 UI 入口（第二片）、不含真实公司 Jira 实测（blocked_external，见 validation/jira-baseline.md §3）**。执行环境：本机 Windows 11，Node 24.12.0，Python 3.10.11（真实 task.py CLI），esbuild 打包冒烟（与既有 smoke 约定一致）。

## 1. 文件清单

新增：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `src/main/services/local-task/types.ts` | 135 | 输入 zod 契约、阶段机（registered→…→ready/failed/conflict/missing）、--meta 扁平键常量 |
| `src/main/services/local-task/operations.ts` | 190 | 纯函数：operationId 派生、磁盘对账扫描（panel_operation_id/panel_jira_issue_key/旧 meta.jiraKey 三索引）、slug 派生、CLI 默认 PRD 模板 TS 移植 |
| `src/main/services/local-task/control-store.ts` | 246 | 控制库独立连接（control.sqlite；复用 G3 CTRL_SCHEMA_V1_DDL；local_operations/source_links/task_aliases） |
| `src/main/services/local-task/cli-runner.ts` | 138 | task.py 执行器：参数数组、固定 cwd、退出码检查、超时杀进程树、输出有界收集 + ANSI 剥离 |
| `src/main/services/local-task/prd.ts` | 122 | 最小 PRD 来源草稿渲染（加长围栏原文呈现、截断显式标注）、同目录临时文件原子替换 |
| `src/main/services/local-task/index.ts` | 522 | 编排：创建/打开/恢复全链、同键并发互斥、archiveLocalTask |
| `src/main/services/jira-instance.ts` | 10 | Jira 实例稳定 ID（electron-free，避免 local-task 打包边界拖入 safeStorage） |
| `scripts/smoke/jira-local-task.mjs` | 659 | 冒烟（§3） |
| `validation/jira-baseline.md` | — | 基线报告字段框架 + blocked_external 登记（骨架） |

修改（均为增量，不破坏既有调用）：

| 文件 | 行数 | 变更 |
| --- | --- | --- |
| `src/main/services/jira.ts` | 603 | jiraFetch 支持传输注入/取消信号/超时分类（timedOut/aborted）；新增 jiraSearchPaged（分页自适应 startAt/total 与 nextPageToken、去重、重试上限、最大页数标样本、取消）、jiraFixVersionTypeDistribution、jiraGetIssueStatus、jiraTransitionVerified；jiraTransitions 增 toStatusName；parseJiraIsoMs 显式校验 |
| `src/main/services/observability/store-core.ts` | 1229 | 导出 CONTROL_SCHEMA_V1_DDL（单一建表权威）；抽出 readTaskAliasRecord/upsertTaskAliasRecord 独立函数供双连接复用；recordTaskAlias 改为委托（语义不变） |
| `src/main/ipc/tasks.ts` | 275 | task:createFromJira 改为委托 LocalTaskService（响应超集：+created/already；旧入参全兼容） |
| `src/shared/types.ts` | 1636 | JiraIssueDetail/JiraFixVersionRef/JiraPagedSearchMeta/JiraDistributionResult 等类型；JiraTransition 增 toStatusName |

## 2. 控制库通道选择（dispatch 要求二选一说明理由）

**选择：独立连接（主进程 LocalControlStore 直开 control.sqlite，node:sqlite + journal=DELETE + synchronous=FULL + busy_timeout=2000，短事务）**。理由：

1. **观测禁用不得影响 LocalTaskService**（G3 铁律）：observation worker 只在已绑定项目打开时存在；经 worker 通道会让任务创建依赖观测绑定，或在未绑定项目经 worker init 顺带创建 observations.sqlite（违反「无绑定不创建观测文件」）。
2. 为 worker 增加 control-only 引导模式需扩展 G3 协议（init 不开观测库的分支），改动面大于收益。
3. 控制库操作是用户显式动作触发的单行短事务（fsync 毫秒级、低频），不构成 G1-B 关注的主进程长事务；busy_timeout=2000 与 worker 的控制库连接共存（G1-B 双连接锁预算口径）。
4. schema 复用 store-core 导出的 CTRL_SCHEMA_V1_DDL + upsertTaskAliasRecord：建表与别名语义单一权威，未来版本高于本程序时只读拒绝（与 G3 口径一致）。

已知边界：主进程同步 SQLite 写在极端慢盘上可能造成毫秒级主线程停顿；频度为用户显式创建/归档动作，接受。若后续出现高频控制库操作，再评估移入 worker。

## 3. 冒烟（scripts/smoke/jira-local-task.mjs，77 项断言全部通过）

- **A 组 · 分页完整性（23 项，注入传输层夹具）**：120 条跨 3 页全量收集、字段映射（issueId/issueTypeId/fixVersionId/description/updatedAtMs）、跨页 issueId 去重、nextPageToken 协议自适应（serverTotal 不可验证如实 null）、页失败重试上限（1+2 次）后恢复、重试耗尽保留部分+标样本、首页 400 快失败不重试、达最大页数标样本、取消保留部分（cancelled ≠ sample）、total 漂移记录、多版本分别计数+跨版本去重。
- **B 组 · transition 契约（8 项，夹具）**：成功后重读核实（POST+GET）、timeout 未达目标 → uncertain 不自动重试（POST 恰一次）、timeout 后查证已达目标 → already_applied、403 → permission、离线分类。
- **C 组 · LocalTaskService（46 项，真实 python + 真实 task.py 副本于 fixture 仓库）**：
  - C0 直接驱动 CLI：退出码 0、"Created task" 解析、--no-start 不设会话指针（输出明示 + 无 .current-task）、--meta 扁平键原样落 task.json、**CLI 默认 PRD 模板与 TS 移植逐字节一致**（用户改动判定基线成立）。
  - C1 正常创建：ready、目录在 .trellis/tasks、全部 panel_* meta（时间值显式校验写入）、PRD 来源标识+「待结合本机代码确认」+描述围栏原文、状态保持 planning、控制库 finalDir 记录。
  - C2 重复点击 → already 打开（不新建目录）。
  - C3 显式一单多任务 → 序号 2 目录（派生 slug 自动追加 -2 避同日同名）；两任务并存后默认点击 → 冲突可见。
  - C4 同键并发互斥：Promise.all 两调用同结果、单目录。
  - C5 跨午夜：预备目录 01-01-* 原子更新为今日前缀后 create，控制库 prepDir 同步更新。
  - C6 CLI 后中断（task.json 已写/PRD 未写）→ 如实 interrupted；恢复不重复 create（目录数不变）、补写来源草稿、ready。
  - C6b 中断后用户已改 PRD → 保留不覆盖，结果带可见说明。
  - C7 同名不同 operationId → 冲突可见，原任务内容与 mtime 不变。
  - C8 控制库损坏（独立仓库）→ control_store 错误、CLI 零调用、零任务目录。
  - C9 CLI 失败（注入退出码 1）→ 无半成品目录；同 op 续跑重试成功。
  - C10/C10b/C10c：缺 updatedAtMs → 整键省略（PRD 标注未知）；描述缺失 → PRD 显式标注（不静默摘要替代）；含反引号描述 → 加长围栏原文完整。
  - C11 本地归档（真实 task.py archive）：fs 核实移动 + 归档区校验 + task_aliases currentDir/priorDirs 更新；Jira 403 失败独立反馈，归档不回滚。
  - C12 指令样描述仅原文呈现（业务数据不是指令）。

## 4. 检查命令结果（本轮实际执行）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck`（node+web） | 通过 |
| `npm run build` | 通过（out/renderer + worker 打包正常） |
| `node scripts/smoke/jira-local-task.mjs` | **PASS（77 断言，0 失败，0 跳过）** |
| node scripts/smoke/ipc-registry.mjs / render-contract / acp / observability-contract / observability-store / task-reader / reader-wiring / reading-session / receipt-projection / proxy | 全部 PASS |
| node scripts/smoke/chat.mjs | **FAIL（既有失败）**：已在干净 HEAD（git stash 隔离）复现同样失败（流式增量等待超时），非本片回归 |
| node scripts/smoke/tpap.mjs | **FAIL（既有失败）**：干净 HEAD 同样失败（tool_search 关键词检索空 + 1 项），非本片回归 |

既有失败未掩盖亦未顺手修改（超出本片范围，留给对应维护者）。

## 5. 与 design/implement 的偏差说明

无实质偏差。两点边界澄清（非偏差，登记备查）：

1. **「统一所有本地任务创建入口」本片落点**：Jira 入口（task:createFromJira）已改造为委托 LocalTaskService；**panel 手动 task:create（IntakeModal 手填待办）未改造**——dispatch 明确「IntakeModal 是手填待办，不是本片范围」，且其直写 task.json 的待办语义与 CLI 任务创建不同，强行委托会改待办语义。第二片接 UI 时再定夺手动入口是否收编。
2. **新增 IPC 通道**：无（归档/transition 服务函数留给第二片接 UI 时挂通道；本片服务层契约先行，符合「不改 UI」约束）。jira.search 既有 IPC 仍走旧单页 jiraSearch（不破坏现有调用）；分页查询经服务函数供第二片接线。

## 6. 未覆盖项（如实）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 真实公司 Jira（类型/版本/分页端点/字段权限/两版本分布） | blocked_external | 全部 Jira 断言为注入传输层夹具；登记见 validation/jira-baseline.md §3 |
| 真实 CLI 交互 | **已测（真实）** | C0–C12 走真实 python + .trellis/scripts 副本（fixture 仓库）；**未测**：打包（asar）环境内 spawn python 的路径解析——与 dist:dir 相关，留 G5 打包走查 |
| task.py archive 的记账 git 提交 | 部分（fixture git init 环境跑通归档+提交路径） | 真实仓库的归档分支校验/after_archive hook 组合未逐项验证 |
| 强杀 python（taskkill）留下的空目录窗口 | 未注入 | CLI 的自清理 + 服务侧「未知目录不采纳」已覆盖策略面；进程级 kill 竞态留集成验证 |
| UI 交互（Jira 行入口、恢复预览展示、transition 选择） | 未实现（第二片） | 服务层契约与返回 notes/冲突码已备齐 |
| Electron 主进程内运行（本片冒烟为纯 node 直驱 bundle） | 未运行打包面板实测 | store-core 同为 node:sqlite 直用先例（G1-B/G3 已在 Electron 44 验证 node:sqlite）；LocalControlStore 同驱动路径，风险低但如实登记 |

## 7. 语义红线自查

- 未创建≠失败：CLI 未执行/失败均如实返回，控制库记录保留可恢复（C8/C9）。
- 超时≠成功：CLI/transition 超时按失败/不确定处理，transition 先查证再决定（B2/B3）。
- Unix 毫秒：updatedAtMs/fetchedAtMs/createdAtMs 全程毫秒；panel_source_updated_at_ms 写入前显式校验（C10）。
- 无绝对路径入共享面：CLI stderr/错误文本经 stripAbsPaths/redactText 后才进入返回值（C9 文案核验）。
- Jira 描述是业务数据：PRD 围栏原文呈现，不解释为指令（C12）；截断显式标注，不静默摘要替代（C10b/prd.ts 限额）。
- 控制库操作失败停止创建副作用（C8）；本地归档成功不因 Jira 失败回滚（C11）。
- 禁止 --force（代码路径不构造该参数；同名冲突走可见冲突，C7）；不设会话指针（--no-start，C0/C1 planning 状态核验）。

# G4 第二片 · Jira 页轻任务入口 UI（g4-jira-entry）

日期：2026-10-12。范围：implement/dispatch「G4 第二片」——Jira 页工单行轻任务入口 + 分页查询接线 + 计量脚手架 + 验证报告。**不含**：真实公司 Jira 实测（blocked_external）、IntakeModal 手动待办收编（见偏差 §4）、UI 自动化测试。执行环境：本机 Windows 11，Node 24.12.0，Python 3.10.11（真实 task.py CLI）。

## 1. 文件清单

新增：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `scripts/smoke/light-task-metrics.mjs` | 271 | 轻任务计量脚手架：fixture 工单走主链（创建→重复点击→归档→流转分离），服务侧事件计数输出「重复录入/同范围重复确认/新增管理动作」；含灵敏度 counter-example |
| `validation/light-task.md` | — | fixture 计量结果 + 真实走查清单（待用户） |

修改（均为超集增量，不破坏既有调用）：

| 文件 | 变更 |
| --- | --- |
| `src/shared/ipc-channels.ts` | 中央注册表新增 `jira.searchPaged`（149 个 invoke 通道全注册断言通过） |
| `src/shared/types.ts` | TrellisApi：`createTaskFromJira` 入参/响应升为 G4 超集（issueId/fullDescription/updatedAtMs/allowAdditional；created/already/archived/notes/serviceCode）；新增 `jiraSearchPaged`（JiraIssueDetail[] + JiraPagedSearchMeta 完整性口径） |
| `src/main/ipc/jira.ts` | 注册 `jira:searchPaged` handler（委托 jiraSearchPaged；样本≠失败，meta 如实带回） |
| `src/main/ipc/tasks.ts` | `task:createFromJira` 响应透传服务超集：+archived/notes；失败附 `serviceCode` 供 UI 分级（控制库/CLI/冲突/中断） |
| `src/preload/index.ts` | 暴露 `jiraSearchPaged`（唯一 preload 变更点，经注册表常量） |
| `src/renderer/src/pages/Jira.tsx` | ① 行内轻任务入口（详见 §2）；② 查询切 `jiraSearchPaged`（完整字段 + 样本标注 chip）；③ 关联索引扩 `panel_jira_issue_key` 双索引；④ 错误分级 `describeCreateFailure` |

未动（红线遵守）：`.codex/hooks`、`src/main/services/local-task/**`（服务语义零改动，仅消费）、旧 `jira:search` 通道（AcpConsole 等既有调用方零回归）、`task:create` 手动待办入口。

## 2. 入口语义（design §7.2 / prd FR4-AC6 落点）

- **同一按钮切换文案**：无已知本地任务 → `在当前项目创建任务`（btn-primary）；已知定位（快照 meta.jiraKey / panel_jira_issue_key 或服务已返回）→ `打开本地任务`（btn-outline）；in-flight → `创建中…`。不出现「认领」字样（无 Jira assignee 认领 API）。
- **行为**：已知定位直接 `setPage('tasks') + showTask`（无新 IPC）；否则携完整字段（issueId/summary/fullDescription/updatedAtMs/priority/assignee）调 `task:createFromJira` → `created` 先 `refresh()` 再跳转；`already` 直接跳转并 toast 说明；归档任务不跳空列表，toast 提示去「归档」页。
- **并发防抖**：`creatingKey` 单飞（in-flight 期间全部入口禁用）+ 服务侧同键互斥兜底；重复点击在已知定位分支零服务调用。
- **当前项目边界**：入口 disabled 判 `!snapshot`，tooltip 注明「只在当前已打开的项目中创建任务」；换仓库必须显式重新打开项目。
- **一单多任务**：UI 不提供快捷入口（服务 `allowAdditional` 保持显式后置，本片登记不接线）。
- **失败分级**：`serviceCode` → control_store（任务未被创建，可安全重试）/ cli_failed（同上，附脱敏详情）/ conflict（不自动选择、不 --force，人工确认）/ interrupted（目录已保留，重试续写不重复建）/ E_NO_PROJECT（先打开项目）。未创建≠失败口径写进文案。
- **样本标注**：`meta.sample` 时头栏显示「样本 · 原因」chip（未取全 ≠ 查询失败）。
- **红线自查**：无绝对路径入 UI（dirName 为相对目录名；服务错误文本已由服务侧 stripAbsPaths 脱敏）；updatedAtMs 全程 Unix 毫秒（服务端 parseJiraIsoMs 显式解析，UI 不自行折算）；超时≠成功（沿用 B 组契约文案）。

## 3. 检查命令结果（本轮实际执行）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck`（node+web） | 通过 |
| `npm run build` | 通过 |
| `node scripts/smoke/light-task-metrics.mjs`（新增） | **PASS（18 断言，0 失败，0 跳过）**：主链 12（创建/重复点击/归档/流转核实/超时查证/权限分离/不回滚）+ 灵敏度 4 + 指标达标 2 |
| `node scripts/smoke/ipc-registry.mjs` | PASS（149 invoke 通道全注册——含新增 jira:searchPaged） |
| `node scripts/smoke/jira-local-task.mjs` | PASS（77 断言，第一片矩阵无回归） |
| render-contract / acp / observability-contract / observability-store / task-reader / reader-wiring / reading-session / receipt-projection / proxy | 全部 PASS |
| `node scripts/smoke/chat.mjs` | **FAIL（既有失败）**：干净 HEAD（git stash 隔离本轮全部改动复跑）同样失败，非本片回归 |
| `node scripts/smoke/tpap.mjs` | **FAIL（既有失败）**：干净 HEAD 同样失败（tools/call db_list_tables + tool_search 空，签名一致），非本片回归 |

## 4. 与 design/implement 的偏差说明

无实质偏差。三点边界澄清（登记备查）：

1. **新增 IPC 通道 1 个**（`jira:searchPaged`）：Jira 页需要完整字段（issueId/description/updatedAtMs）供创建消费，旧 `jira:search` 单页契约无这些字段且 AcpConsole 仍在用——按中央注册表补链而非改旧通道，零回归。「打开已有任务的定位」未新增通道：renderer 侧 `setPage('tasks')+showTask` 即可（App/Tasks 既有能力），仅把服务返回的 `archived/notes` 经既有 `task:createFromJira` 响应透传。
2. **panel 手动 task:create（IntakeModal）未收编**：延续第一片结论（待办≠任务语义），本片范围明确排除。
3. **UI 层验证为静态**（typecheck/build + 服务链冒烟），无渲染自动化测试：项目无 UI 测试设施，真实点击走查列入 light-task.md §3 待用户执行。

## 5. 待人工走查清单

见 [light-task.md](light-task.md) §3（8 项：真实查询/创建/重复点击/中断恢复/冲突/归档流转分离/真实计数计时/当前项目边界）。本片不将「本地 UI 已实现」表述为 AC6 通过——AC6 需真实工单证据。

# G4 · Jira 基线报告骨架（jira-baseline）

状态：**骨架（字段框架 + blocked_external 登记）**。两版本类型分布的真实采集尚未执行——公司 Jira 类型/版本/权限未验证（见 §3）；本文件定义真实采集时必须逐字段填写的口径，防止届时漏记完整性证据。对应 PRD FR5/AC7、design §7.1、implement.md G4。

## 1. 报告字段框架（真实采集时逐项填写）

### 1.1 查询定义

| 字段 | 说明 | 待填 |
| --- | --- | --- |
| Jira 类型（Cloud / Server / DC）与版本 | 实测响应推断（分页信号、字段行为），不凭猜测 | ___ |
| 实例 baseUrl（脱敏 host）与认证方式 | 当前实现为 Basic（jira.ts） | ___ |
| 每版本 JQL | `fixVersion = "<versionId>"`（+ 可选 assignee 限制）；记录是否用 id 或 name | ___ |
| 版本 ID 与 name 对照 | 两版本各自的 fixVersion id + 显示名（FR5 指定两版本） | ___ |
| pageSize / maxPages / retryLimit | 用户配置与实际值 | ___ |

### 1.2 完整性口径（design §7.1：不能把 total==抓取数当一致性唯一证明）

| 字段 | 说明 | 待填 |
| --- | --- | --- |
| 采集开始时间 / 结束时间 | Unix 毫秒（服务返回 meta.startedAtMs/endedAtMs） | ___ |
| 分页协议实际信号 | startAt/total 或 nextPageToken（jiraSearchPaged meta.paginationKind） | ___ |
| 每版本取回数（去重后）/ 服务端总数 | meta.retrievedCount / meta.serverTotal；token 协议 serverTotal 为 null | ___ |
| 跨页重复数 | meta.duplicateCount（issueId 优先去重，缺失回退 key） | ___ |
| 样本 / 全量标示 | meta.sample=false → 全量；true → 样本（incompleteReason：max_pages / page_failed） | ___ |
| 采集期间数据变化 | meta.changedDuringCollection（startAt 协议可观测；token 协议不可验证为 null，如实呈现） | ___ |
| 页失败与重试 | 每版本页失败次数、重试是否耗尽、最终是否完整 | ___ |
| 多版本计数规则 | 每版本独立计数（工单多版本分别计入各自分布）；跨版本汇总按 issueId/key 去重（crossVersionUniqueCount） | ___ |

### 1.3 分布结果

| 字段 | 待填 |
| --- | --- |
| 版本 1 类型分布（issueTypeId/name → count） | ___ |
| 版本 2 类型分布 | ___ |
| 跨版本汇总分布（去重口径） | ___ |
| 与上一期基线的差分（如有） | ___ |

数据来源字段：`jiraFixVersionTypeDistribution()`（src/main/services/jira.ts）返回的 JiraDistributionResult。

## 2. 已实现的采集能力（本片，夹具验证）

- 分页查询 `jiraSearchPaged`：逐页收集、issueId/key 去重、可取消（AbortSignal）、单页重试有上限（默认 2）、达用户配置最大页数（默认 20）标样本；startAt/total 与 nextPageToken 两种信号按实际返回适配，不假设 Cloud/Server 一致。
- 字段扩充：issueId（数字稳定 ID）、issueTypeId/name、fixVersionId/name、description、updatedAt（显式解析为 Unix 毫秒，非法/缺失为 null）。
- 冒烟证据：`node scripts/smoke/jira-local-task.mjs` A 组 23 项断言（>50 跨页、重复去重、token 协议、重试、样本、取消、total 漂移、多版本分布）全部通过——**均为注入传输层夹具，非真实服务**。

## 3. blocked_external 登记表

| 项 | 状态 | 阻塞原因 | 何时解除 |
| --- | --- | --- | --- |
| 公司 Jira 类型/版本确认 | blocked_external | 无公司环境访问条件；G0 记录的「待公司环境验证」仍待落实 | G4 实测（需公司账号与网络） |
| 真实分页端点行为（Cloud enhanced search 是否在用、POST /rest/api/2/search 可用性） | blocked_external | 同上；当前实现按返回信号自适应，但未在真实服务验证 | G4 实测 |
| 字段权限（description 是否对账号开放、脱敏策略） | blocked_external | 同上 | G4 实测 |
| 目标两个 fixVersion 的 id/name 与实际工单量 | blocked_external | 需求方未提供版本 ID；FR5「两个指定 Jira 版本」的具体对象未定 | G4 实测前由需求方给定 |
| 两版本真实分布数字 | blocked_external | 依赖以上各项 | G4 实测 |

## 4. 结论

本片交付了采集与完整性口径的实现及夹具验证；AC7 的「两版本 Jira 报告有完整性」在真实环境证据补齐前保持未完成，不得以夹具数字冒充真实基线。

# 05 · 来源、原型与下一轮评审

## 1. 本轮实际做过什么

已读取 GLM 初始反方案、`02-glm-review.md` 与 `03-glm-feasibility-audit.md`，完成 Codex 第一轮及本轮回应。用户要求通过文档交流；现在已有真实往返，主要方向一致，新增实现细化与可行性假设仍见 A1–A4。

这里的“统一”表示把两份文档中的相容部分组织成同一个可评审入口，不代表双边最终同意。原始 GLM 证词与反方案保持不变。

可行性审计中的“单人在职业余产能”“没有测试”“推送覆盖80%”未由用户/测量确认；本轮采用单维护者预算作假设，保留团队目标，不把这些推断升级为事实。

## 2. 本地代码证据

| 位置 | 观察 | 影响 |
| --- | --- | --- |
| [task.py](../../../.trellis/scripts/task.py) `cmd_start`，约 171 行起 | 上下文清单门槛、任务绑定、状态更新；没有批准文档修订的核验 | 新确认门要补契约，不能直接宣称原生已强制 |
| [native context hook](../../../.codex/hooks/inject-subagent-context.py) 约 964 / 1190 行 | 输出 additionalContext / updatedInput；有文件和总字节裁剪 | 可打点组装/输出，但接收与遵守需另证 |
| [hooks.json](../../../.codex/hooks.json) | UserPromptSubmit / SubagentStart 注册 | 外部宿主并非只有 watcher 能提供信号 |
| [acp.ts](../../../src/main/services/acp.ts) 约 202 行起 | 项目事件追加到同项目活跃会话，taskDir 可缺失 | 需要更精确的 task/run/session 关联 |
| [gitlab.ts](../../../src/main/services/gitlab.ts) 约 204 行起 | opened MR 与分支最新 pipeline 查询、创建 MR 已有 | 补 merged 与 SHA 对齐，复用而非重做 |
| [channel-dispatch.ts](../../../src/main/services/channel-dispatch.ts) | 显式文件上下文、worker 派发与只读评审路径 | 可用于受管交互，不等同所有内部子 Agent 可见 |
| [handoff.ts](../../../src/main/services/handoff.ts) | 根据真实存在文件和用户意图构建交接 | 可扩为带血缘/版本的前情包 |

行号来自 2026-10-11 当前工作区，只读核查。本轮未改这些实现，未执行真实编码 Agent 或公司连接。

## 3. 一手外部来源

- [ACP Session Setup](https://agentclientprotocol.com/protocol/v1/session-setup)：能力协商、MCP 配置、恢复能力边界。
- [ACP Tool Calls](https://agentclientprotocol.com/protocol/v1/tool-calls)：对外工具事件面；不据此承诺所有内部 Agent 活动。
- [GitLab MR API](https://docs.gitlab.com/api/merge_requests/) 与 [Pipeline API](https://docs.gitlab.com/api/pipelines/)：读取稳定对象、状态与提交关联的依据。
- [GitLab Pages 访问控制](https://docs.gitlab.com/user/project/pages/pages_access_control/)：私有文档站可复用的访问模式；是否在公司部署启用仍需核实。
- [飞书开放平台](https://open.feishu.cn/)：应在公司应用权限和代表样本文档上验证。此次工具未能完整读取目标文档块 API 页面，因此没有将精确接口形态、支持块类型或抓取成功率列为已验证。
- [飞书群机器人说明](https://www.feishu.cn/hc/zh-CN/articles/360024984973-在群组中使用机器人)：支持自定义机器人 webhook 出站推送，并有群管理员相关权限设置；不据此保证公司环境零审批。
- [知识库成员与应用权限](https://www.feishu.cn/hc/zh-CN/articles/530997871518-设置当前知识库管理员和成员)：机器人读取知识库还涉及 API 与页面授权，不能由能发群消息推导。
- [飞书官方更新记录](https://open.feishu.cn/changelog?abilityType=Tool&lang=zh-CN)：有长连接接收事件能力；特定 SDK/卡片事件、公司环境未测试，不一概要求公网回调，也不保证无维护成本。

开源模块的许可证、候选与商业边界沿用[上一版技术比较](../2026-10-11-local-team-platform/05-technology-decisions.md)中的证据；本轮调整的是引入次序和产品边界，不重复把每个候选当成必装组件。

## 4. 原型走查

[打开驾驶舱原型](prototype/index.html)。静态 HTML/JS，无依赖安装，无真实外部调用。直接文件打开取决于浏览器策略；可在本目录运行 `python -m http.server 47833 --bind 127.0.0.1` 后打开 `/prototype/`。不使用公开托管。

页面上方的视角与观测来源选择器只服务于评审，不是正式权限切换工具。数字、提交号、工单号、文档内容与回执均为样例。

原型保留完整目标形态，包含 S1–S3 的后续交互。v0.3 仅更新范围提示，不把演示菜单全部纳入首发。历史截图来自 v0.2 的完整概念，交互含义不代表对应能力已经实施。

建议依次检查：

1. 阅读：PRD/design、原文与排版、专注阅读、任务信息和上下文清单。
2. 上下文：钉业务规范后只显示待检查点，触发示例检查点后才有提交回执；依然不称为规范遵守。
3. 执行：缺检查证据可处理；切到外部 hooks/仅文件模式，不把不存在的能力补出来。
4. 来源：选飞书章节，模拟无权限后人工导入；保留来源类型，不伪造远端修订。
5. 迭代：查看前序决定、组装前情、生成后续草稿；旧完成状态不沿用。
6. 交付：旧提交的 CI 成功不能当成当前交付通过；确认当前计划、检查、当前提交 CI 后才能演示合并和归档包。
7. 团队：本机更新在策略允许且在线时自动变快照；离线后团队保留旧版本与提示；团队视角没有本地执行动作。

## 5. 检查记录

2026-10-11 已执行：

- JavaScript 语法与[本地链接/资源检查](checks/verify-artifacts.py)通过，[机器结果](checks/results.json)已保存。
- 浏览器验证钉入后为“待下一检查点”，触发示例检查点后才出现提交回执，未变成“规范已遵守”。
- 切换外部 hooks 能看到宿主提交信号；仅文件模式显示执行未知，不画出已确认子 Agent 行为。
- 旧 SHA 的 CI 虽为 success，合并回执示例入口仍不可用；当前计划确认、检查与提交级 CI 条件具备后才能进入合并/归档演示。
- 飞书章节选择与人工导入可操作；人工输入保留，标记未取得远端修订号。
- 前情提要和后续草稿可操作；保留 follow-up 关系，不继承完成状态。
- 本机离线后文档更新到 v4，团队仍显示 v3 与离线提示；恢复后收到 v4。团队没有本机编辑/补检查按钮。
- task.json 的原文视图保留原始状态与未知字段。
- 桌面 1440px 与窄屏 390px 检查，页面无水平溢出；表格在局部滚动。浏览器未记录 warn/error。

以上只验证原型交互。真实接口、回执可信度、宿主兼容、公司权限与同步可靠性仍需未来接入测试；没有运行产品构建或改动产品代码。

保存的原型图：

| 图 | 内容 |
| --- | --- |
| [阅读工作台](prototype/screenshots/01-reading.jpg) | 文档成为主区域，结构化材料与待处理问题同屏 |
| [上下文回执](prototype/screenshots/02-context.jpg) | 来源、实际内容范围、不同证据级别 |
| [交付关联](prototype/screenshots/03-delivery.jpg) | 旧提交 CI 不能满足当前交付 |
| [任务血缘](prototype/screenshots/04-lineage.jpg) | 隔期接续与后续任务草稿 |
| [窄屏阅读](prototype/screenshots/05-mobile.jpg) | 核对响应式可读性 |

## 6. 给 GLM 的下一轮输入

请先读 [Codex 本轮回应](debate/04-codex-feasibility-response.md)、[决定记录](01-decision-ledger.md) 和 [可行性与试点卡](06-feasibility-and-pilot.md)。仅回应 A1–A4，回复可新增为 `debate/05-glm-final-check.md`，保留已有双方原文，不改产品代码。

检查：单维护者假设与团队目标是否分开；身份/上传/回复是否分权；有界遥测是否可靠；轻路径是否按新增负担衡量；飞书是否按能力分别验证。反对时给出具体替代，不重开已一致方向，也不再补一轮完整功能清单。

若无新增阻断，下一步应整理供用户决策的范围，而不是继续增加辩论轮次。真实公司环境仍未验证，双方技术一致不等于用户已裁决或可以生产上线。

## 7. 后续仍需真实环境补证

Jira Cloud/Data Center 与版本字段；飞书应用与文档授权；基座仓库的文档提交制度与读者范围；首个实际宿主/Agent 组合；原生回执和 MCP 轨迹支持；现有 GitLab 合并/CI API 行为；公司是否已有授权文档站和消息机器人；真实维护资源与参与角色。

这些影响实现细节和试点范围，不妨碍当前通过文档讨论产品主线。用户已确认的本地执行和模型使用边界继续有效。

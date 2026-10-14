# 08 · 证据、假设与待决策项

核查日期：2026-10-11。上游主干会变化；生产接入前必须固定版本并复查许可、接口和目标环境。下面是阅读证据，不代表这些项目已在公司环境实测。

## 1. 本项目证据

| 证据 | 观察 | 对方案的影响 |
| --- | --- | --- |
| [package.json](../../../package.json)、[构建配置](../../../electron-builder.yml) | Electron/React/TS 桌面项目 | 优先抽能力，不先整体换语言 |
| [scan.ts](../../../src/main/services/scan.ts) | 任务解析、文件读写、规范引用统计 | 可抽取 Trellis 文件能力 |
| [watcher.ts](../../../src/main/services/watcher.ts) | 监听 `.trellis` 文件，新增/修改回调 | 可作为原始观察源，不能推断全部工作流事实 |
| [handoff.ts](../../../src/main/services/handoff.ts) | 明确工作区、真实文件清单、用户意图 | 已有可复用的确定性交接思路 |
| [acp.ts](../../../src/main/services/acp.ts) | 本机子进程、v1 握手、事件轨；MCP 下发为空数组 | 有基础，但任务上下文和能力兼容需完善 |
| [access/server.ts](../../../src/main/services/access/server.ts) | 环回、token、幂等和游标约定 | 本地接口经验可用，不能直接暴露为团队服务 |
| [jira.ts](../../../src/main/services/jira.ts) | v2 API、单页搜索、状态映射 | Cloud/DC、分页和可靠同步需独立建设 |
| [Team.tsx](../../../src/renderer/src/pages/Team.tsx) | 本地项目快照汇总 | 现有团队页面不等于服务端成员权限系统 |
| [WeKnora 设计](../../weknora-integration.md) | 本地/公司知识与自动沉淀 | 重用连接；共享边界需按新产品重新约束 |

工作区检查时已有未提交 ACP 等改动。本方案依据当前可见快照，不把所有代码视为已发布和经端到端测试的稳定功能；本轮不改动这些已有文件。

## 2. 开源与官方来源

| 编号 | 来源 | 本轮用于支持的事实 | 尚未验证 |
| --- | --- | --- | --- |
| S01 | [Paperclip 产品定义](https://github.com/paperclipai/paperclip/blob/master/doc/PRODUCT.md) | 核心为自主 Agent 组织协调，支持多类执行适配 | 适配本产品全部角色边界的总成本 |
| S02 | [Paperclip 插件](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_AUTHORING_GUIDE.md) | 已有 UI/worker 扩展面，标为 alpha | 升级兼容性、实际二开工作量 |
| S03 | [Paperclip 文档批注](https://docs.paperclip.ing/guides/day-to-day/artifacts/) | 段落评论、版本变化时锚点处理 | 能否直接复用而不依赖其领域对象 |
| S04 | [Paperclip Jira](https://docs.paperclip.ing/connectors/jira/) | 官方该连接面向 Atlassian Cloud MCP | Data Center 接入及可靠双向同步 |
| S05 | [OpenHands](https://github.com/OpenHands/OpenHands) | Agent Canvas 支持本地/远程等执行环境 | 团队部署权限是否满足本项目 |
| S06 | [Vibe Kanban 公告](https://www.vibekanban.com/blog/shutdown) | 公司关闭、远程服务退场，项目声明转社区维护 | 社区后续维护承诺与质量 |
| S07 | [参考](https://github.com/make参考/参考) | 任务、周期、文档；仓库 AGPL-3.0 | 各企业功能在目标版本的可用性 |
| S08 | [Happy](https://github.com/slopus/happy) | 本地编码工具与跨设备交互方向；MIT | 不作为本产品远程控制能力承诺 |
| S09 | [ACP TS SDK](https://github.com/agentclientprotocol/typescript-sdk) | 官方 SDK、Apache-2.0，v2 为实验入口 | 员工实际 Agent/版本矩阵 |
| S10 | [ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup) | 会话携带 cwd/MCP 配置，能力有边界 | 所选 Agent 对传输和恢复的支持 |
| S11 | [Bifrost](https://github.com/maximhq/bifrost) / [虚拟密钥](https://github.com/maximhq/bifrost/blob/dev/docs/features/governance/virtual-keys.mdx) | 网关、模型访问与预算配置；Apache-2.0 | 所需模型/工具流兼容、EE 边界 |
| S12 | [LiteLLM 企业版](https://docs.litellm.ai/docs/enterprise) | 部分治理能力存在版本/商业边界 | 公司现有部署是否已经提供 |
| S13 | [WeKnora MCP](https://github.com/Tencent/WeKnora/blob/main/website-docs/03-features/08-mcp.md) / [LICENSE](https://github.com/Tencent/WeKnora/blob/main/LICENSE) | 端点范围；主项目 MIT、含第三方许可声明 | 公司当前版本与权限实际行为 |
| S14 | [Better Auth](https://github.com/better-auth/better-auth) / [Organization](https://better-auth.com/docs/plugins/organization) | 身份/组织组件、MIT | 公司 IdP 与业务授权整合 |
| S15 | [pg-boss](https://github.com/timgit/pg-boss) | PostgreSQL 任务队列，MIT | 目标负载与重启演练 |
| S16 | [Fastify](https://github.com/fastify/fastify) | Node 框架与插件边界，MIT | 锁定版本与 Node 基线 |
| S17 | [Milkdown](https://github.com/Milkdown/milkdown) / [React Flow](https://github.com/xyflow/xyflow) | Markdown 编辑与流程 UI 组件 | Markdown 往返、无障碍与项目样式适配 |
| S18 | [Jira 搜索](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/) / [webhook](https://developer.atlassian.com/cloud/jira/platform/webhooks/) | Cloud 接口迁移与事件重试事实 | 公司版本与网络接收条件 |
| S19 | [Tauri Windows 分发](https://v2.tauri.app/distribute/windows-installer/) | WebView2 与安装配置关系 | 所有依赖计入后的真实包体积 |
| S20 | [ContextForge](https://github.com/IBM/mcp-context-forge) / [安全说明](https://github.com/IBM/mcp-context-forge/security) | MCP 聚合候选；管理面部署有明确限制 | 生产可用配置、目标身份透传 |

没有以 star 数量代替维护性判断。GitHub 仓库未归档、有近期提交，只证明活动信号，不证明生产质量。现存包体积来自本机 release 文件，未重建，见第 05 章。

## 3. 已确认补充与待决策项

**Q01 已解决（2026-10-11，用户回复）**：允许现有模型使用方式，平台不额外上传仓库。已记为产品边界 D06。员工可按公司既有规则继续使用云模型及必要上下文；平台不新增仓库上传、镜像或集中代码索引，也不强制切换内网模型或新增统一网关。

本轮可以先完成文档与静态原型；以下不是阻止产出初版的理由，但在正式接入对应能力前需要确定。

| 问题 | 初版采用的建议/展示 | 会影响哪里 |
| --- | --- | --- |
| Q02 Jira Cloud 还是 Data Center、具体版本 | 不猜测，接口分适配 | 认证、搜索、用户ID、webhook |
| Q03 哪些项目产物可自动共享 | 阶段摘要可按开发授权模板同步；正文先发布预览 | Publication 与本机 outbox |
| Q04 谁负责业务验收，完成是否要求上线 | 原型使用指定验收人+开发合并确认示例 | 门槛与 Jira 状态映射 |
| Q05 团队规模与常用 Agent/操作系统 | 先一项目、两种真实 Agent；不承诺全平台 | 适配测试与运维投入 |
| Q06 是否已有公司统一登录、模型网关和知识权限 | 优先接已有，避免新增重复服务 | 组件最终名单 |

## 4. 术语对照

- 需求简报：产品希望实现什么，以及哪些事项还要开发确认。
- 工程绑定：把一个业务需求与某位员工本机的项目/Trellis 任务关联。
- 发布副本：开发选择给团队看的特定版本材料，不是本地文件的远程编辑入口。
- 回执：实际操作发生后的可追溯记录；与 AI 自述区分。
- 本地伴随程序：运行在开发电脑、连接本机工具并同步允许内容的小服务。
- BYOK：使用公司或本人提供的模型 API 凭据；不等同订阅账户的统一计费。

## 5. 修订记录

- v0.1：落实用户本轮纠正；分离业务与工程阶段，取消产品侧编码调度；重新比较整体底座，初选模块化扩展当前项目；加入本地数据发布、状态分离与可逆路径。
- 更正上一轮表述：Vibe Kanban 不应概括为“项目完全停止维护”；准确表述为公司/远程服务退场、项目声明由社区维护。
- v0.1 补充：根据用户后续回复解决 Q01，新增 D06，统一总览、产品边界与模型接入章节的表述。

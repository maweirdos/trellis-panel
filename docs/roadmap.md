# Trellis 团队研发平台 Roadmap

当前正式方案：**[完整产品蓝图与Roadmap v2.0](proposals/2026-10-19-team-workflow-platform/roadmap.md)** · [HTML阅读版](proposals/2026-10-19-team-workflow-platform/roadmap.html) · [主文与附录目录](proposals/2026-10-19-team-workflow-platform/README.md)。2026-10-19。

本版整合全角色流程、会话节点交互、ZCode/DSH复用、插件与UI产物、个人共享、上下文与恢复、阶段交付和验收。它是当前产品与技术规划入口，不表示整套功能已实现，不自动更改既有任务的完成状态或启动实施。

**完整 Trellis 任务已建立（2026-10-20）**：[父任务与 28 个子任务](../.trellis/tasks/10-20-team-workflow-platform/README.md) · [依赖顺序](../.trellis/tasks/10-20-team-workflow-platform/task-map.md) · [规则与验收覆盖](../.trellis/tasks/10-20-team-workflow-platform/traceability.md)。覆盖 R0—R7；用户随后回复“继续”，R0-01 已进入实施，其余子任务保持 planning。

以下保留上一轮规划与实施记录，供追溯；与新方案冲突的产品假设以v2.0为准。

上一轮入口：[场景化规划](proposals/2026-10-17-project-first-roadmap/01-main-roadmap.md) · [完整目录](proposals/2026-10-17-project-first-roadmap/README.md) · [HTML阅读版](proposals/2026-10-17-project-first-roadmap/Trellis-Project-Roadmap.html)。v0.6，2026-10-17。

**实施记录（2026-10-17）**：A3（F01–F03 一致性）、B1/B2/B3、C1/C2/C3（新「本机开发工具」页）、D1、F04 已按蓝图实现并通过 typecheck/build/冒烟；同日完成桌面原生走查与真实使用验证（原生外框/亮色层级、只读 Git 实测一致、typecheck 真实运行退出码 0、状态工作流入口与接续交接端到端复制核对）；第二轮对照蓝图逐条复核补齐：接续说明补"本次变化（Git）/检查记录与未完成项/待确认问题"三块、peek 新增"资料引入（添加项目资料）"、PF-01 切工程 A→B→A 原生验证通过（含失败路径如实报错）；ACP 会话功能按要求未动。明细见 [roadmap_v2 第 1 章](roadmap_v2.md)。

当前已经具备本地任务、材料阅读、Jira接入与ACP基础。按用户偏好，AI会话、阅读和本机使用靠前呈现；粗需求/旧任务接续、本机Git/运行/日志、检查与交接仍可按真实需要独立选择。文档说明各项收益、依赖、边界和完成标准，不锁定唯一主线、最终排期或实施授权。

旧Crux研究留作证据参考；64项能力覆盖、旧48条FR、R0–R5及旧验收目录不再是现行必须完成的目标。见[范围取舍](proposals/2026-10-17-project-first-roadmap/04-scope-and-reference-decisions.md)。当前静态断点仅列候选修正及验证方法；本轮未修改产品代码或任务状态。

<details>
<summary>历史路线和工程记录（原文保留；旧入口与阶段承诺已由v0.6取舍替代）</summary>

> **v0.4.1 需求合同修订：** [审查修复对照](proposals/2026-10-15-crux-roadmap/14-review-resolution.md)统一逐需求审批、基数、状态、R1手工/R4集成和测试门槛；业务UI仍待实测，未批准实施。

## 2026-10-17：v0.5.1独立复核修正

修正UI03视口元数据、区分视口/裁切后图片尺寸；U08任务对话仅结构，独立会话截图不作其视觉覆盖；UXAC按子断言分阶段，完整UXAC01在R3/R4核验，不被R0静态夹具提前关闭。未新增调研或改动产品代码。见[复核记录](proposals/2026-10-15-crux-roadmap/14-review-resolution.md)与[阶段适用](proposals/2026-10-15-crux-roadmap/16-ui-derived-design-contracts.md)。


## 2026-10-17：Crux登录网页实测与需求评审稿v0.5

保留既有路线图、v0.4.1可靠执行合同及R0–R5；新增19张经目检网页截图、25条观察和U01–U22部分覆盖矩阵。完整48条FR、15项NFR、数据流/ER/状态/权限、22个工作包与估算依赖保留；补12条UX验收和2张逻辑图、1张线框，总计15张可编辑图。

当前入口：[评审目录](proposals/2026-10-15-crux-roadmap/README.md)、[实测审查](proposals/2026-10-15-crux-roadmap/15-crux-uiux-audit.md)、[UI设计与验收](proposals/2026-10-15-crux-roadmap/16-ui-derived-design-contracts.md)。研究仅低风险浏览；原生、双账号权限、跨设备、runtime执行和集成写入仍未验证。244条既有用例与12条UX增补均not_run。本轮仅文档更新，不实施代码或提交/推送。


> **深入需求增补（2026-10-16）：[Trellis 完整需求与数据控制模型](proposals/2026-10-15-crux-roadmap/07-product-requirements.md)。** 沿用R0–R5，含48条需求、追溯/验收、可编辑流程图/DFD/ER及补证限制；未实施产品代码，Crux原生应用实测尚缺。

# 产品化 Roadmap（持续检索沉淀）

> **当前产品路线图入口（2026-10-15）：[基于 Crux 全量公开文档的 Trellis Roadmap](proposals/2026-10-15-crux-roadmap/README.md)。** 新稿按真人协作、手动 Agent、受控自动化分阶段，含能力地图、来源覆盖和现状边界；具体实现留待讨论。下文继续保留历史工程实现记录及冻结事项，不因新稿改变其状态。

> **布局建议稿（2026-10-16）：[团队工作台完整布局方案](proposals/2026-10-16-workbench-layout/README.md)。** 将工作范围、项目模块、主工作区与辅助材料分开，覆盖团队交接、知识引用、设置范围和三种视觉状态；处于产品审查阶段，未替换当前界面实现。

> **项目与拓展修订（2026-10-16）：[项目工作区与开发者工具](proposals/2026-10-15-crux-roadmap/05-project-workspace-and-integrations.md)。** 项目提升到窗口根；保留 Jira/GitLab 等外部应用拓展口；未来开发者工具优先多项目启动、基础日志、只读 Git 查看。当前只规划，不实施，不扩展代码编辑与调试。

> **本版 UI/UX 实施（2026-10-16）：[项目工作区任务](../.trellis/tasks/10-16-project-workspace-uiux/prd.md)。** 已批准实施窗口顶层项目入口、固定模块栏＋可收起上下文栏、中央任务工作区，以及知识/概览/团队页面整理；沿用当前风格并加强亮色层级。外部集成平台、多项目启动、日志和只读 Git 仍是后续能力，本版不接入。完成状态以任务验收记录为准。

> 持续研讨的增补点清单：已实现项标注 ✅，其余按性价比排序，作为后续任务输入。
> 来源：PI-Desktop 架构研讨（clean-room，见 TPD-009）+ 业界通用实践检索。

## 已实现

- ✅ IPC 通道中央注册表 / 错误码信封 / 事件流约定（TPD-001..004）
- ✅ **ACP Agent 控制台**（2026-10-09，10-09-acp-agent-console）：`services/acp.ts` NDJSON
  JSON-RPC 客户端（任意 ACP agent 子进程，预置 codex-acp / gemini --acp / 内置 mock）+
  AcpConsole 页双轨混排（agent 回复流/工具卡/权限三态卡 + trellis 卡片：任务流转/文档/
  spec/jira）+ 工单人工审查流 + 会话记录落盘。冒烟：`node scripts/smoke/acp-mock-agent.mjs`
  （协议序列 9 项）与 `node scripts/smoke/acp.mjs`（真实服务 × mock 子进程 19 项）。
- ✅ store 切片化 + mermaid/markdown 渲染消毒（TPD-005/006）
- ✅ TPAP 本地控制面（环回 + token + confirm + 幂等 + 游标事件）（TPD-007/008）
- ✅ SSE 流式对话（openai/anthropic/ollama/response 四形态）+ 会话持久化 + 队列/中止 + 标题总结
- ✅ 对话页（Entry 管道 + 滚动状态机 + 窗口化 + 每会话模型绑定 + 导出 Markdown）
- ✅ 模型发现优先 + models.dev 富化（缓存 24h 离线回退）（TPD-012）
- ✅ 路径围栏修复三处目录穿越（TPD-010）+ 工具输出截断契约（TPD-011）

## 高价值待办（下一批候选）

1. ✅ **Thinking 流独立展示**（2026-09-22）：reasoning_content / thinking_delta 解析、
   chat:output 独立 reasoning 字段、落库、折叠条目渲染、per-会话思考档位（TPD-014）。
   冒烟：mock reasoning 流 + anthropic thinking_delta 探针 + 档位请求体断言。
2. ✅ **消息级操作**（2026-09-22）：会话存储升级 v2 树（nodes+activeLeaf，v1 自动迁移，
   TPD-016）；编辑已发消息并重发、regenerate 分支保留、‹i/n› 分支切换器全部落地。
   分支切换已支持下潜到最深叶（局部视图语义，TPD-023）；停止点并排多分支视图冻结为观察项。
3. ✅ **对话内权限卡**（2026-09-22）：agent 工具循环落地（openai tool_calls 工具轮 + 流式
   回答轮，复用 GatewayManager/fence/截断），转录区内联权限卡 allow-once / allow-session /
   deny 三态 + 120s 超时默认拒绝，allow-session 随会话持久化（TPD-020）。
4. ✅ **Steer（运行中引导）**（2026-09-22）：运行中 Alt+Enter 注入，文本立即上屏并在下一个
   工具轮边界并入请求上下文；残留 steer 在轮末自动转排队（TPD-021）。
5. **会话分支 / 置顶 / 归档**：会话列表管理能力，存储结构升级后顺带。
6. ✅ **按需工具加载（ToolSearch）**（2026-09-22）：`GET /tools?mode=deferred` 仅暴露
   tool_search 元工具，`POST /tool_search` 按名/描述/upstreamId 检索（TPD-018）；面板内部
   全量路径不变。✅ 每轮按会话 activeTools 恢复有成功执行证据的工具 schema（TPD-024）。
7. ✅ **多模态输入**（2026-09-22）：composer 文件选择/粘贴图片（≤4 张、单张 ≤3MB 前端门槛 +
   4MB 主进程硬门槛），dataURL→ChatImage 持久化，openai/anthropic/ollama 图像分片升维，
   用户气泡缩略图（TPD-019）。✅ response 格式 input_image 分片与面板截图一键问 AI 已实现（TPD-022）。
8. ✅ **TPAP 对话只读面**（2026-09-22）：`GET /tpap/v1/chat/sessions` 与 `/chat/session?id=`
   已实现——读路径复用 chat-store 单一实现，恒只读、过 Bearer 鉴权，tpap 冒烟 16 项覆盖。
9. ✅ **E2E 对话渲染契约**（2026-09-22）：`reuseEntries` 引用复用 + `useChatEntries` +
   `scripts/smoke/render-contract.mjs` 身份契约断言（恒等/流式/追加/分支四场景，TPD-017）。
   纯 node 断言管道契约，React.memo 链路依赖该身份复用。
10. ✅ **代理设置统一**（2026-09-22）：settings.proxy（http/socks5）→ Node 侧 proxiedFetch
    （同实例 undici ProxyAgent，TPD-015）覆盖 AI/模型目录/models.dev；Chromium 侧
    session.setProxy 覆盖 WeKnora。冒烟：本地转发代理验证经代理/直连两路径。

## 冻结（低优先级 / 观察项，待用户确认解锁后才启动）

> 以下为有意冻结的范围（2026-09-22）：均无当前用户需求信号，启动前需用户明确确认。

- 语音输入（speech-to-text）— 冻结
- 图片生成展示（transcript 内嵌 GeneratedImages）— 冻结
- 全站 i18n（当前中文单语，无需求不启动）— 冻结
- 命令面板插件化 / 自定义命令 — 冻结
- 停止点并排多分支视图（当前整段下潜切换已覆盖核心需求）— 冻结


</details>

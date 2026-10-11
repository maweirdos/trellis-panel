# 产品化 Roadmap（持续检索沉淀）

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

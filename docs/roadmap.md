# 产品化 Roadmap（持续检索沉淀）

> 持续研讨的增补点清单：已实现项标注 ✅，其余按性价比排序，作为后续任务输入。
> 来源：PI-Desktop 架构研讨（clean-room，见 TPD-009）+ 业界通用实践检索。

## 已实现

- ✅ IPC 通道中央注册表 / 错误码信封 / 事件流约定（TPD-001..004）
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
   剩余：停止点局部分支视图（当前切分支即整段切换）。
3. **对话内权限卡**：当面板具备"AI 直接执行工具"能力时，allow-once / allow-session(按工具) /
   deny 三态卡 + 120s 超时默认 deny。TPAP 的 confirm 门槛是其协议层对应物，UI 卡待 agent
   循环落地时一并做。
4. **Steer（运行中引导）**：目前运行中发送=排队；steer 语义需要 turn 内注入（中断当前流并
   携带补充指令重入），依赖 agent 循环，与权限卡同一批。
5. **会话分支 / 置顶 / 归档**：会话列表管理能力，存储结构升级后顺带。
6. **按需工具加载（ToolSearch）**：工具 schema 不全量推送，先给 catalog、按名激活。接入
   多于 ~15 个工具时再做，避免上下文浪费。
7. ✅ **多模态输入**（2026-09-22）：composer 文件选择/粘贴图片（≤4 张、单张 ≤3MB 前端门槛 +
   4MB 主进程硬门槛），dataURL→ChatImage 持久化，openai/anthropic/ollama 图像分片升维，
   用户气泡缩略图（TPD-019）。剩余：response 格式分片、面板截图一键问 AI。
8. ✅ **TPAP 对话只读面**（2026-09-22）：`GET /tpap/v1/chat/sessions` 与 `/chat/session?id=`
   已实现——读路径复用 chat-store 单一实现，恒只读、过 Bearer 鉴权，tpap 冒烟 16 项覆盖。
9. ✅ **E2E 对话渲染契约**（2026-09-22）：`reuseEntries` 引用复用 + `useChatEntries` +
   `scripts/smoke/render-contract.mjs` 身份契约断言（恒等/流式/追加/分支四场景，TPD-017）。
   纯 node 断言管道契约，React.memo 链路依赖该身份复用。
10. ✅ **代理设置统一**（2026-09-22）：settings.proxy（http/socks5）→ Node 侧 proxiedFetch
    （同实例 undici ProxyAgent，TPD-015）覆盖 AI/模型目录/models.dev；Chromium 侧
    session.setProxy 覆盖 WeKnora。冒烟：本地转发代理验证经代理/直连两路径。

## 低优先级 / 观察项

- 语音输入（speech-to-text）
- 图片生成展示（transcript 内嵌 GeneratedImages）
- 全站 i18n（当前中文单语，无需求不启动）
- 命令面板插件化 / 自定义命令

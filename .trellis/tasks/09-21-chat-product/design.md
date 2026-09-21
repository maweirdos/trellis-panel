# 技术设计

## 1. 事件与契约

- 通道（进中央注册表）：`chat:list/open/new/delete/rename/send/abort` + `ai:discover-models`；
  事件 `chat:output` / `chat:done`（runId 关联成对，对齐 cli:output/cli:done 先例）。
- `chat:send` 返回 `{ok:true, runId, queued}`；队列由主进程 chat 服务持有（每会话 FIFO）。
- 错误码：NoProject 不适用；InvalidArg/NotFound/Upstream/Timeout/Denied 覆盖。

## 2. 主进程

```
services/ai.ts         # +aiChatStream(cfg, messages, {onDelta, signal}, opts)
                       #   openai: SSE data: {choices[0].delta.content}
                       #   anthropic: SSE content_block_delta.text_delta.text
services/chat-store.ts # userData/chat-sessions/<id>.json 原子写（tmp+rename）
                       #   ChatSession {id,title,createdAt,providerId,modelId,messages[]}
services/chat.ts       # ChatRuns：runId→AbortController；每会话队列；done 后落库+冲队列
services/providers.ts  # discoverModels：openai GET {base}/models | anthropic GET {base}/v1/models
                       #   + models.dev 富化（缓存 userData/models-dev.json，TTL 24h，离线回退）
services/fence.ts      # insideRoot(root, p): resolve 后前缀校验；拒绝越界
ipc/chat.ts            # 上述通道注册；广播经 ipcEvent
```

标题总结：首轮 assistant 完成后，若 ai.enabled，取前 2 消息截断发一次小请求（best-effort，
失败静默保留首行截断标题）。

## 3. 渲染层

```
src/renderer/src/chat/
  entries.ts           # buildEntries(messages): UserMsg | AssistantTurn(文本+工具占位) | Error
  useTranscriptScroll.ts # atBottom ref + stick 逻辑 + 新消息 pill + 窗口上限(60 entries, 加载更早)
pages/Chat.tsx        # 左会话列表(页内) / 中转录 / 下 Composer(provider+model picker)
store/slices/chat.ts  # sessions/activeId/messages/runningRunId/queueLen + 动作
```

- 流式组装：`chat:output` 按 runId 追加到 active session 的流式草稿，`chat:done` 固化为消息。
- Markdown 渲染复用 MarkdownView（已含 sanitize 管线）。
- Page 类型加 'chat'；App.tsx 路由（overflow-hidden 组）；CommandPalette 页面组加 'AI 对话'。

## 4. 安全

- fence 修复三处穿越：`trellis_get_spec`（name 可 `../`）、`syncSpecFromRemote`（fileName 可 `../`）、
  `trellis_get_task`（taskDir 可 `../`）。越界返回 E_INVALID_ARG。
- executeTool 截断：`{ok:true, result, truncated?, totalChars?}`。

## 5. 冒烟（scripts/smoke/chat.mjs）

mock OpenAI 服务（http server：`POST /v1/chat/completions` 流式 SSE + `GET /v1/models`）：
1. discover-models 返回探测列表；2. chat:send → 依序收到 delta → done 落库；3. 忙碌期二次发送
→ queued，首轮 done 后自动发送；4. abort 中止；5. fence 穿越被拒；6. 截断契约字段存在。

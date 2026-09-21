# 技术设计（TPD-020/021）

## 工具循环（TPD-020）
- ai.ts 增 aiChatTools(target, messages, tools)：非流式 /chat/completions 携带 tools（function schema），返回 {ok, content?, toolCalls?:[{id,name,argsJson}]}。
- GatewayManager.toOpenAiTools()：GatewayToolDef→OpenAI function schema。
- chat.ts startTurn agent 分支（session.agent && provider.apiFormat==='openai'）：
  round≤6：aiChatTools → 无 toolCalls → 作为最终回答（done）；有 → 逐个 permission broker → executeTool → 追加 tool 结果消息 → 下一轮；最后一轮若仍有 toolCalls 视为错误。
  回答轮：aiChatStream（不带 tools）流式输出。

## 权限卡（TPD-020）
- chat:permission 事件 {runId,sessionId,permId,toolName,argsSummary}；chat:permission-resolve 调用 {permId,decision}；
- broker：120s（chatService.configure 可调）超时 deny；allow-session → session.allowedTools.push(toolName)（持久化）；deny → 工具结果为"用户拒绝…"回灌。

## Steer（TPD-021）
- chat:steer 事件 {runId,sessionId,content} 立即上屏；run.steers[] 在每个循环边界并入请求（role:user）；
  finish 时残留 steers 逐个转为排队发送（语义：不丢字）。

## 渲染
- assistant entry 增 toolOps?: {toolName,argsSummary,status,elapsedMs}[] → ToolOpsBlock 折叠；
- pending permission 卡内联于转录底部（三按钮 + 倒计时）；composer Agent 开关 + 运行中 Alt+Enter steer。

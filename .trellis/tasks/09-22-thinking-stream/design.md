# 技术设计

## 契约
- ChatOutputEvent 增 `reasoning?: string`；ChatMessage 增 `reasoning?: string`；
- ThinkingLevel = 'off'|'low'|'medium'|'high'；ChatSession(Meta)/send input 增 thinkingLevel。
- 新通道 `chat:regenerate`；事件复用 chat:output/chat:done。
- aiChatStream 回调增 `onReasoning?`；StreamTarget 增 thinkingLevel。

## 协议映射（TPD-014）
- anthropic：thinking={type:'enabled', budget_tokens: 4096|8192|16384}，max_tokens=max(budget+1024)；off 不发。
- openai：reasoning_effort='low'|'medium'|'high'（off 不发；不支持的网关可能忽略或 400，属供应商差异，文档注明）。
- ollama/response：v1 不发参数（reasoning_content 仍被动解析）。

## 渲染
- entries.ts：assistant entry 增 reasoning；Chat.tsx 新增 ThinkingBlock（<details> 语义的自实现折叠，默认收起，流式时自动展开至滚动跟随）；流式态 streamingThinking 单独累积。

## 服务
- chat.ts startRun：累积 reasoning；done 落库 assistant{content,reasoning?}；regenerate：openSession → 末条为 assistant 则截断 → 以剩余历史重跑（runId 新分配）。

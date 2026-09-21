# 思考流展示 + 重新生成

## Goal
roadmap 高价值待办 #1 全量 + #2 的低成本子集（重新生成）。

## Requirements
- R1 aiChatStream：解析 openai 兼容 `choices[0].delta.reasoning_content` 与 anthropic `thinking_delta`，经 `onReasoning` 回调独立于正文下发。
- R2 事件契约：chat:output 增加可选 `reasoning` 字段（正文 delta 仍走 `delta`），runId 关联不变。
- R3 持久化：ChatMessage 增加可选 `reasoning`；assistant 完成时连同正文落库。
- R4 per-会话 thinking 档位：off/low/medium/high，随 chat:send 绑定持久化；协议映射——anthropic: thinking.budget_tokens（4096/8192/16384，off 不发）；openai: reasoning_effort（仅非 off 发送）；其余格式 v1 不发参数（文档注明）。
- R5 转录区：思考流为独立折叠条目（默认收起），流式中显示实时增长 + "思考中"态；完成后可展开回看。
- R6 重新生成：`chat:regenerate` 截断末条 assistant 并以原历史重跑；转录区最后一条回答提供"重新生成"按钮。
- R7 冒烟：mock 流先发 reasoning_content 再发正文；覆盖事件 reasoning 字段、落库 reasoning、anthropic thinking_delta 探针、regenerate；全量回归。

## Acceptance Criteria
- [ ] AC1 openai 形态 reasoning_content 逐段到达渲染事件且落库（冒烟断言）。
- [ ] AC2 anthropic thinking_delta 探针解析成功。
- [ ] AC3 thinking 档位随会话持久化；anthropic off 不携带 thinking 字段（冒烟断言请求体）。
- [ ] AC4 转录区思考流折叠条目渲染（typecheck + 页面结构）。
- [ ] AC5 regenerate 后消息数回落并重新流式（冒烟断言）。
- [ ] AC6 typecheck 全绿 + chat 冒烟全过 + 三套回归。

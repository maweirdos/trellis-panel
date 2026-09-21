# Agent 工具循环 + 权限卡 + Steer（roadmap #3+#4）

## Requirements
- R1 工具循环：agent 会话（session.agent 开启）的 turn 采用多轮——工具轮（非流式，openai tool_calls 协议，≤6 轮）+ 回答轮（流式，无 tools）；工具执行复用 GatewayManager.executeTool（fence/截断/审计继承）。
- R2 权限卡：每次工具调用先发 chat:permission 事件（permId/toolName/args），三态 allow-once/allow-session/deny；allow-session 按工具名随会话持久化（allowedTools）；120s（可配置）超时默认 deny；deny/超时以拒绝文案作为工具结果回灌模型。
- R3 steer：运行中 chat:steer 注入当前 turn——文本立即上屏（chat:steer 事件），在下一个循环边界并入请求上下文；turn 结束仍有残留则自动转为排队发送。
- R4 转录区：assistant 条目渲染工具行折叠块（工具名/参数摘要/状态/耗时）；权限卡内联渲染三按钮 + 剩余时间；composer 增加 Agent 开关与运行中 Alt+Enter steer。
- R5 冒烟：mock tool_calls 两轮（工具轮→回答轮）；权限 allow-once/allow-session 复用/deny 回灌/超时拒绝四路径；steer 注入断言；既有回归全过。

## Acceptance Criteria
- [ ] AC1 agent 会话工具调用全链路：permission 事件→allow-once→工具执行→最终回答流式落库，assistant 节点携带 toolOps（冒烟）。
- [ ] AC2 allow-session 后同名工具不再发 permission 事件（冒烟）。
- [ ] AC3 deny 后模型收到拒绝文案并继续完成回答（冒烟）。
- [ ] AC4 超时默认拒绝（可配置短超时，冒烟）。
- [ ] AC5 steer 在工具轮边界注入下一请求上下文（冒烟）。
- [ ] AC6 typecheck 全绿 + 六套冒烟全过。

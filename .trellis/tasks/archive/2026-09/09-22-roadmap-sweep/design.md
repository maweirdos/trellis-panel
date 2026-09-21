# 技术设计
- ai.ts response 分支：含图 user 消息 content 升维 input parts；其余保持字符串。
- chat:screenshot 通道：webContents.capturePage() → toDataURL(png)；WindowDeps 增 captureMain()。
- chat-store: deepestLeaf(session, id)：反复取最后子节点；chat.branch 后下潜。
- ChatSessionTree 增 activeTools?: string[]；executeTool 成功后 addActiveTool；agent 循环 tools = 全量过滤 activeTools（无记录→全量）。
- 观察项冻结：docs/roadmap.md 低优先级节改"冻结（待用户确认解锁）"。

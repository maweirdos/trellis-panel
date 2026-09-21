# 技术设计（TPD-016）

- v2 节点：ChatNode = ChatMessage & {id, parent: string|null}；session.nodes: Record<id, ChatNode>；activeLeaf。
- path(leaf)：回溯至根 reverse；siblings(id)：同 parent 节点按创建序。
- openSession 返回 ChatSessionView：meta + messages=活跃路径视图（每个带 id/siblingCount/siblingIndex）。
- 服务：editAndResend（user 节点兄弟化 + startTurn）、branchTo（setLeaf）、regenerate（同父新 assistant + startTurn）。
- startTurn(leafId)：history = path(leafId)（不含将要生成的 assistant）；完成落 assistant 子节点并置 activeLeaf。
- 渲染：ChatMessageView 驱动；用户消息内联编辑（铅笔→textarea→Enter 提交 editAndResend）；分支切换器 ‹i/n›。

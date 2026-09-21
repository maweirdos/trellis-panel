# 会话树结构升级：消息编辑重发与分支切换（roadmap #2）

## Requirements
- R1 存储升级：会话 JSON v2 = `{version:2, nodes:{id→ChatNode}, activeLeaf}`，节点含 id/role/content/reasoning/parent；打开 v1（线性 messages 数组）自动迁移为链；新写入一律 v2。
- R2 活跃路径：activeLeaf 向上回溯到根即当前对话；messageCount = 活跃路径长度。
- R3 编辑重发：chat:edit(sessionId, messageId, newContent)——user 节点生成兄弟分支重跑，activeLeaf 切到新分支。
- R4 分支切换：chat:branch(sessionId, messageId)——activeLeaf 置为该消息（对话视图截至该处）。
- R5 regenerate 升级：不再 pop 旧回答，而是生成兄弟 assistant 节点并切换——旧回答保留可切回。
- R6 渲染层：转录区消息带分支切换器（‹i/n›）；用户消息悬停出现编辑按钮，内联编辑保存即重发；切片与事件流兼容 v2 视图。
- R7 冒烟：v1 迁移、编辑生成兄弟且旧分支可切回、regenerate 分支保留、branch 切换路径正确。

## Acceptance Criteria
- [ ] AC1 v1 会话文件打开自动迁移为 v2 且活跃路径等价（冒烟）。
- [ ] AC2 edit 生成兄弟分支并重跑；旧分支仍可经 chat:branch 切回（冒烟）。
- [ ] AC3 regenerate 后同父下有 2 个 assistant 兄弟，活跃为新的（冒烟）。
- [ ] AC4 typecheck 全绿 + 四套冒烟回归全过。

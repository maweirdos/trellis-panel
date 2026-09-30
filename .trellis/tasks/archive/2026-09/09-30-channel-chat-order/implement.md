# 执行计划（已执行）

1. Channels.tsx 对话流：chrono = [...events].reverse()（对冲后端 newest-first）；连续同 by 的 progress 合并为 Row{count, last, warn}；系统行渲染 count 徽标 + ⚠ 警告摘要（title 全文）+ by 悬停身份说明；气泡 by 亦加悬停。
2. 类型收窄：rows 联合类型用 'sys' in row 判别。

## 验证记录

- typecheck node+web 0 错；build 通过（970ms）。
- 真跑：tp-chat-demo 补第二轮——echo 已被 idle-timeout 清理，重发标记 undeliverable；spawn echo2 接棒回复"我是编程助手，帮你解决技术问题。"。演示频道现含三段剧情（完整往返/undeliverable/多 worker 接棒），正序+分组+身份悬停供面板目验。

## 身份速查（写回给用户的解释）

- panel / panel-ui / main = 我方（面板或 CLI 操作者，main 为 CLI 默认身份）
- 其他名字（echo/echo2/reviewer/planner）= worker（spawn 时 --as 命名）
- supervisor:xxx = 该 worker 的守护进程（supervisor_warning/killed 等系统守护事件的发出者）

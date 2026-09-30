# 执行计划（已执行）

1. channel-dispatch.ts：去 --ephemeral（2 处 create）、删全部 rm 行（9 处，行级过滤）、审阅名加 stamp、标签改"留存频道"、头注更新。
2. DispatchModal/PlannerModal：cleanup 阶段标签与底部文案改为"留存/可回看"。
3. Channels.tsx：事件流重构为对话视图（message 气泡左右分侧 + MarkdownView + 6000 字符截断；系统事件紧凑单行）；引入 MarkdownView。

## 验证记录

- typecheck node+web 0 错；build 通过（815ms）。
- 真跑：tp-chat-demo 持久频道完整往返——panel 气泡（右）/echo 回复气泡（左）/系统事件紧凑行，频道保留。
- 踩坑备忘（CLI 用法，写回服务代码注释）：`channel send` 无 --message/--message-file，正文为位置参数或 --text-file/--stdin；requireRunningWorker 在 worker 未就绪时报错（spawn 后需短暂缓冲）；worker 闲置 5 分钟被 worker_guard 清理（idle-timeout）。

## 遗留演示物

- tp-chat-demo 频道保留，供用户在面板"AI 频道"页验收气泡视图；看完可点删除或 `trellis channel rm tp-chat-demo`。

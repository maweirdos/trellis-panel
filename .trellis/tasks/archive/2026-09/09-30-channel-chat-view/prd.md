# AI 频道对话化：持久频道+消息气泡视图

## Goal

用户指出 AI 频道 tab"没有任何文字交流，只有状态展示"——根因有二：① 面板派发用 `--ephemeral` 用完即焚，成功的对话根本留不下来；② 事件流里系统事件与文本消息等权展示，对话被淹没。本任务让"回看完整对话"成为频道页的核心体验。

## Requirements

1. **派发持久化**（channel-dispatch.ts）：审阅与起草的频道去掉 `--ephemeral`；成功与失败都**不再 rm**（失败现场保留供检查）；审阅频道名加时间戳防重跑撞名；头部注释与 UI 阶段标签同步（"清理临时频道"→"留存频道"）。
2. **对话视图**（Channels.tsx 事件流重构）：
   - `message` 事件 → 聊天气泡：panel/panel-ui/main（我方）右对齐绿色泡，worker 左对齐灰泡；正文用 MarkdownView 渲染（审阅报告的标题/列表正常排版），超 6000 字符截断保护；
   - 其余系统事件（create/spawned/progress/turn_*/error/killed/supervisor_warning）→ 紧凑单行（小徽章+by+时间），不再与文本等权。
3. forum 线程条、发送框、轮询、中断/删除按钮不变。

## Acceptance Criteria

- [x] typecheck node+web + build 通过。
- [x] 真跑验证：持久频道 `tp-chat-demo` 完整往返（panel 指令气泡右 / echo 回复"我是Codex，你的编程助手。"气泡左 / 系统事件小灰行），频道保留可回看。演示频道**故意保留**供用户在面板验收。
- [x] 派发器零 `channel rm` 残留（rg 验证）；频道名时间戳防撞。

## 明确不做 / 后续

- 频道积累后的清理（面板内 prune 入口 / `--idle` 定期清理）随使用观察再加。
- progress 事件的展开/折叠（当前紧凑单行已够用）。

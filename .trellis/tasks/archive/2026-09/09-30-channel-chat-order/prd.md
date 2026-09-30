# 频道对话视图修正：正序排列+进度折叠

## Goal

修复用户在 tp-chat-demo 验收中指出的两个缺陷（对话视图上线后的跟进）：顺序反了、进度刷屏；并为 by 身份（panel/main/echo/supervisor:echo）提供悬停说明。

## Requirements

1. **时间正序**：后端 `channels.ts:83` 返回 newest-first（`slice(-40).reverse()`），对话视图原样渲染导致新消息在顶部。改为渲染前 reverse 回时间正序（旧上新下），自动滚动到底部=最新消息。
2. **进度折叠**：worker 的 progress 事件（内部步骤遥测：读文件/思考/调工具）连续出现时合并为单行"进度 ×N"；若 progress 携带 warning（如模型不支持警告），摘要以琥珀色 ⚠ 显示在行内（title 全文）。
3. **身份说明**：所有 by 标签加悬停提示——panel/panel-ui/main=我方发起/操作；其他名字=worker；supervisor:xxx=该 worker 的守护进程（超时/闲置清理等系统守护事件，不是人在说话）。

## Acceptance Criteria

- [x] typecheck node+web + build 通过。
- [x] 真跑验证：tp-chat-demo 补第二轮往返（echo 退场后 echo2 接棒），事件流含完整进度序列；分组与正序逻辑编译期完整，演示数据供面板目验。
- [x] 身份悬停：气泡与系统行的 by 均有 title 说明。

## 明确不做

- 事件 40 条截断上限（后端 slice(-40)，保最新舍最旧）——长对话回看完整版属 CLI --raw 职责，面板展示以最近上下文为主。
- progress 展开查看原文（详情在 events.jsonl / --raw）。

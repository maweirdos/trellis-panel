# 频道页产品化打磨：人话系统事件+实时打字+分析显式化

## Goal

用户验收指出两处产品化欠账：① "进度 ×11"“supervisor:echo2”这类内部命名直接暴露在 UI；② 思考链不可见的替代方案要落地。本任务三件套：系统事件全部人话化、output 增量拼实时打字气泡、worker 档案要求报告显式列出分析过程。

## 背景：思考链的数据事实（2026-09-30 实测）

codex 会话存档中 reasoning 条目为 `encrypted_content`（OpenAI 加密）+ 空 summary——思考链本体任何工具都解不开。可行替代：① worker 档案要求"分析过程"写进报告（已落地）；② 事件流里的 output 增量（明文）拼实时打字效果（已落地）。

## Requirements

1. **系统事件人话化**（Channels.tsx 对话视图 v3 重写）：
   - create → "频道已创建"；spawned → "已启动 worker「X」"；turn_finished(done) → "「X」完成（N 步）"；turn_finished(error) → "「X」处理失败：…"（红）；killed → "worker「X」已清理（闲置超时或手动终止）"（若被清理时 output 有半截文本，则以"未完成的输出"气泡留档）；undeliverable → "消息未送达：目标 worker 已退出——重新启动 worker 后可重发"（琥珀）。
   - turn_started/supervisor_warning/done 不再单行展示（折叠进回合状态）。
   - by 中文化：气泡署名"面板/操作者"，worker 署名"worker「名字」"；不再出现 panel/main/supervisor:xxx 原文。
   - 旧 KIND_STYLE 徽章体系整体退役。
2. **实时打字气泡**：turn 开始后未收尾时，把该 worker 的 output text_delta 拼接为"worker「X」正在回复…（N 步）"的实时气泡（3 秒轮询自动刷新，尾部光标动画）；message 到达后由完整气泡取代。
3. **分析显式化**：planner.md 报告格式首段加"## 分析过程"（2-4 条：阅读顺序/方案取舍）；check.md 加同等的 always-include 要求。
4. type Alias MsgEvent = ChannelEvent & { text: string }（message 无文本直接跳过）。

## Acceptance Criteria

- [x] typecheck node+web + build 通过。
- [x] 派发器零 rm、持久频道（上一任务回归不变）。
- [x] 真跑端到端：重新派发只读审阅（持久频道 + 新档案），报告首段即为"## 分析过程"（3 条明文推理），样本存 analysis-sample.md；频道留存供面板目验人话系统行与回合折叠。
- [x] UI 无裸内部命名（panel/main/supervisor:xxx/进度×N 全部消除）。

## 明确不做

- progress 明细展开查看（events.jsonl / CLI --raw 兜底）。
- reasoning 解密尝试（厂商加密，无解）。

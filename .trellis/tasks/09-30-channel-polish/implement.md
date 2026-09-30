# 执行计划（已执行）

1. Channels.tsx 对话视图 v3 整段重写：ChatItem 三型（msg/status/live）；build 循环逐事件转译（create/spawned/turn_finished/killed/undeliverable → 人话 status；progress 增量入 turn 状态；done/supervisor_warning 吸收）；trailing open turns → live 打字气泡；by 中文化（who()）；KIND_STYLE/kindStyle 与无用图标退役。
2. .trellis/agents/planner.md：报告格式首段"## 分析过程"；check.md：always-include 分析过程要求。
3. 端到端真跑：重派 09-30-planner-dispatch-demo 只读审阅（持久频道）→ 报告 332 字、首段分析过程 3 条明文 → 样本存 analysis-sample.md。

## 验证记录

- typecheck node+web 0 错；build 通过（1.26s）。
- 踩坑：正则清理 KIND_STYLE 时误删空态行收尾 `}`（已补）；killed 分支 fake event 类型改用 MsgEvent 别名满足 text 非空约束。

## 已知取舍

- live 气泡 text 显示最近 2000 字符（轮询增量拼接尾部）；回合结束后由完整 message 气泡取代。
- 频道事件 40 条上限不变（保最新）。

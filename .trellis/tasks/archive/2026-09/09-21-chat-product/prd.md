# 对话产品化：流式多轮对话 + 多模型目录 + 工具安全规范

## Goal

落地研讨结论：1) ai.ts SSE 流式（openai/anthropic 双格式）；2) 新建对话页（Entry 纯函数管道 +
滚动状态机 + Composer + 每会话模型 + 队列/中止）；3) 会话持久化与标题自动总结；4) Models 页
发现优先探测 + models.dev 富化 + binding；5) 路径围栏统一函数修 gateway 目录穿越；工具输出
截断契约；6) 持续检索增补有价值点。

## Requirements

- R1 流式对话：SSE 双格式；事件成对 runId（chat:output/chat:done）；会话持久化 userData；
  忙碌发送进队列自动续发；支持中止。
- R2 对话页：Entry 纯函数管道；滚动状态机（sticky-bottom/新消息提示/窗口化）；Composer 快捷键
  （Enter/Shift+Enter/Esc/Ctrl+.）；每会话绑定 provider+model；入口走命令面板（不碰 Sidebar WIP）。
- R3 多模型目录：发现优先探测 /models；models.dev 富化带缓存与离线回退；Models 页探测多选。
- R4 工具安全：fence.ts 路径围栏修三处目录穿越；截断契约字段；标题自动总结。
- R5 持续检索：models.dev 结构按实适配；增补低成本高价值点（复制/导出）；记录 roadmap。

## Acceptance Criteria

- [ ] AC1 对话页可新建会话、流式收 delta、完成落库；重启后会话仍在。
- [ ] AC2 忙碌时发送进队列并在轮末自动发送；可中止当前轮。
- [ ] AC3 discover-models 对 openai 形态探测成功（mock 冒烟）；models.dev 离线回退缓存不报错。
- [ ] AC4 gateway spec/task/remote-sync 对 `../` 穿越拒绝（冒烟断言）。
- [ ] AC5 截断响应带 truncated/totalChars（冒烟断言）。
- [ ] AC6 typecheck 全绿；`node scripts/smoke/chat.mjs` 全过。

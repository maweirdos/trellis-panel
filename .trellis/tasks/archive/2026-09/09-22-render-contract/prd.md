# 渲染契约：Entry 管道引用复用（roadmap #9）

## Requirements
- R1 entries.ts 增 `reuseEntries(prev, next)`：位置/key/内容/分支信息全等的条目复用 prev 对象引用；
- R2 `useChatEntries(messages)` hook：内部持 prev 引用，组件侧 React.memo 链路因此可跳过未变条目的重渲染；
- R3 Chat 页切换到该 hook；
- R4 冒烟 scripts/smoke/render-contract.mjs：①恒等输入→恒等引用数组 ②流式增长→仅尾条目新引用 ③追加新消息→前缀保持 ④分支内容变化→仅该条目新引用。

## Acceptance Criteria
- [ ] AC1 四项身份契约断言全过（node 冒烟，无需 Chromium）。
- [ ] AC2 typecheck 全绿 + 既有冒烟回归。

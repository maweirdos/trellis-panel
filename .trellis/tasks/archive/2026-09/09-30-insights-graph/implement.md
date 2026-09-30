# 执行计划（已执行）

1. TaskInsightsModal.tsx 整体重写：PHASES 五阶段定义（match/block/statuses/arts/inject 人话）+ extractSections 小节提取 + SVG 管线（连线箭头/状态点亮/产物圆点/点击选中）+ 详情抽屉（注入预期 tab / workflow.md 原文 tab + 面包屑折叠 + jsonl 表）+ 文件事实紧凑条。
2. 冒烟：五小节全命中；planning 点亮 artifacts+p1。

## 验证记录

- typecheck node+web 0 错；build 通过（771ms）。
- 冒烟输出：triage 442 字 / artifacts 643 / p1 2029 / p2 2695 / p3 907——各阶段原文充实。
- 旧版"每轮提示词按钮列表"退役：面包屑原文收进各阶段节点详情（折叠），与"这个阶段被喂了什么"语义对齐。

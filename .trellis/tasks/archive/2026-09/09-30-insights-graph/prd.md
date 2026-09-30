# 任务透视 v2：工作流管线图（架构图形态）

## Goal

用户反馈 v1（文字 chip 列表）鸡肋、看不懂有什么用，并指出原始诉求是"结合架构图形态设计"（Dify 式：图上看到任务在哪、点节点看注入了什么）。本任务把任务透视重做为 SVG 工作流管线图，视觉语言复用架构图页（arch-* 类），数据纪律不变（只报事实与预期，不推断执行位置）。

## 用户原话

"任务透视感觉现在还很鸡肋，作为一个用户，甚至我作为一个开发者都看不懂有什么用，我前面不是说结合架构图部分来设计吗？"

## Requirements

1. **SVG 工作流管线**：五个阶段节点（请求分诊 → 规划素材 → Phase 1 规划 → Phase 2 执行 → Phase 3 收尾）横向管线，连线箭头，复用 arch-node-state/arch-edge-path 类；任务状态点亮所处阶段（planning→素材+P1，in_progress→P2+P3，绿点+绿连线）；节点右上产物圆点（齐/部分/缺→绿/琥珀/灰）。
2. **点节点看两件事**（抽屉 tab）：①"这一阶段注入了什么"——人话列表（面包屑块/技能/jsonl 注入）+ 本任务产物事实 chip + jsonl 预期表（P2=implement、P3=check）+ 面包屑块原文折叠；②"workflow.md 原文"——该阶段小节 Markdown 渲染。
3. **阶段链去噪**：只匹配五个规范小节（Request Triage/Planning Artifacts/Phase 1/2/3），Rules/Guardrails/Loading Step Detail 等非阶段标题不再混入。
4. 文件事实保留为底部紧凑条；面包屑状态按钮列表退役（原文收进对应节点）。

## Acceptance Criteria

- [x] typecheck node+web + build 通过。
- [x] 真数据冒烟：五阶段小节全部命中（Phase 1/2/3 正文 907-2695 字可看）；planning 状态点亮 素材+P1。
- [x] UI 无裸内部命名；不推断执行位置；规则预览零执行。

## 明确不做

- 执行位置推断（v1 撤回原因仍成立：status 不区分执行/检查）。
- cytoscape 重图引擎（五节点线性管线，SVG 手绘更轻且与架构图页同语言）。

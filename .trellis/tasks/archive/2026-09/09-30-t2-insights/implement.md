# 执行计划（已执行）

1. IPC task.contextExpect（ipc/tasks.ts）：jsonl 逐行解析（file/reason/statSync size），累计预算判定四档 verdict；返回 implement/check 两组 + caps。
2. TaskInsightsModal.tsx：文件事实徽标；parseWorkflowView（行级块解析 + Phase Index 阶段提取）→ 阶段条 + 状态块选块预览；JsonlTable（verdict 徽标 + 累计百分比 + 措辞脚注）。
3. Tasks.tsx 工作台头部 ScanSearch 按钮接入。

## 验证记录

- typecheck node+web 通过；build 通过（678ms）。
- 解析器冒烟（真 workflow.md）：正则全局匹配会误吃文档开头状态映射表引用——改为行级整行匹配（与 Studio 校验器同口径）后 8 块全对；no_task 首行与真实面包屑注入原文一致；Phase Index 提取出 Request Triage → … → Phase 1/2/3 → … 阶段条。
- 踩坑记录：bash heredoc 内多级转义两次损坏正则字面量（\\\r 沦为真实换行），已改用 Edit 工具与 chr(92) 拼接修复；最终以 typecheck 为准。

## 已知取舍

- Phase Index 提取包含其中全部 ### 小节（Rules/Guardrails 等非阶段小节也会进阶段条）——按原文目录呈现，不做语义过滤。
- verdict 按默认上限硬编码估算（config.yaml 覆盖读取列为后续）。

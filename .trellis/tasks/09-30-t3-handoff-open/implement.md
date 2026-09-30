# 执行计划（已执行）

1. services/handoff.ts：buildHandoffPackage（存在性清单 + issues 申报 + 05 §5.2 模板 + 防重复尾行）与 readPrdContent；DEFAULT_INTENT 只核对与阅读。
2. IPC：task.handoffBuild（dirName, intent, includePrd）→ channels/ipc/tasks.ts/preload/types 全链。
3. HandoffModal.tsx：意图四选（自定义防抖 400ms、seq 防竞态）、可编辑 textarea、附加 PRD 显式勾选（内容进预览）、离开本机提示、已知问题琥珀条。
4. Tasks.tsx 工作台头部：SquareCode"在编辑器打开" + ClipboardCopy"交接包"按钮；弹窗挂载。

## 验证记录

- typecheck node+web 通过；build 通过（827ms）。
- 真数据冒烟（tsx + scanProject + 归档 r0 任务）：files 六项全为实存路径、issues 空、模板文本完整；工作目录在 IPC 路径下为 resolve 后的绝对路径。
- 交接包不含任何 token/密钥字段；意图"继续实施"自带范围变化确认措辞。

## 已知取舍

- 弹窗内编辑不持久（意图切换会重建文本）——复制前的临时删减场景已覆盖，持久化编辑无明确需求。
- 冒烟里 design.md 缺失被如实略过（该任务无设计文档），符合"存在时"语义。

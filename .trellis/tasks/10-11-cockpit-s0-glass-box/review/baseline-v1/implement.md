# 实施 · 驾驶舱 S0：玻璃盒

执行顺序与验证点，细节以 `design.md` 为准。每步完成即在 `[ ]` 打勾并附提交说明；发现设计偏差先回改 design.md 再继续（防走样）。

## Step 1 · Spike（半天）

- [ ] zod 接入：安装、构建通过、`shared/receipts.ts` 事件 schema 定稿（v1）
- [ ] `.trellis/.panel/` 目录约定落地 + 忽略规则（git 与归档白名单排除）
- [ ] 验证：type-check / build 全绿

## Step 2 · 主进程地基

- [ ] `services/taskgraph.ts`：`resolveTaskId(path)`、血缘读取；吸收 acp.ts/watcher 中的路径解析
- [ ] `services/eventlog.ts`：片段回收、按日合并、崩溃残留回收、退出前有界 flush
- [ ] `services/receipts.ts`：聚合 → 视图模型；畸形片段丢弃并计数
- [ ] 修复 `emitTrellisTimeline` taskDir 关联（无任务事件标 projectId-only）
- [ ] 单测：合并顺序/去重/回收/路径解析（含中文、空格、嵌套）
- [ ] 验证：单测绿；夹具任务目录集成（坏 JSON、写入中、外部修改）

## Step 3 · hooks 落账

- [ ] `inject-workflow-state.py` / `inject-subagent-context.py` 增加片段写（assembled / delivered 两时机）
- [ ] `TRELLIS_RECEIPTS=off` 旁路开关
- [ ] 片段写失败仅 stderr，不影响 hook 输出（手动验证注入仍生效）
- [ ] 验证：真实宿主跑一次子代理，pending→log 合并可见

## Step 4 · 渲染层

- [ ] `EvidenceBadge`（L0–L2 色板，contracts 措辞）
- [ ] `ReceiptCard`（清单/汇总/截断/缺失/仪器故障灰卡）
- [ ] `PhasePipeline`（阶段管道，原值 status 透传）
- [ ] `JsonlTimeline`（implement/check.jsonl 时间线，坏行占位）
- [ ] `TaskMetaCards`（task.json 卡片化 + 原始 JSON 入口）
- [ ] 阅读区：宽度切换/专注模式/文档内目录/版本差异（git 来源，降级注明）
- [ ] 更新不抢焦点：滚动保持 + 非模态更新提示
- [ ] Jira 页"本地起任务"轻任务入口（IntakeModal 复用）
- [ ] 验证：AC1/AC2/AC5 走查

## Step 5 · 测量与验证

- [ ] Jira 两版本 issue 分布基线报告（样本与查询条件入脚注）
- [ ] hook 开销基线（on/off × 20 次，p50/p95/max）
- [ ] 轻任务操作脚本演示 + 计量表（口径：新增动作/重复录入/重复确认）
- [ ] 全量验收：AC1–AC8 逐条核对；`trellis check` 通过

## Step 6 · 收尾

- [ ] 更新 implement.jsonl / check.jsonl 清单
- [ ] 文档：S0 使用说明（一段）+ 已知边界（未知≠未执行的措辞说明）
- [ ] 提交（遵循 git-conventions），准备试点（等 08 决策第 2 项人选）

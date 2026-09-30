# T4 扩展：AI 起草任务（planner worker 派单）

## Goal

任务页一句话需求 → planner worker（codex + workspace-write，官方 `.trellis/agents/planner.md` 扩展点）在项目内走 `task.py create` 官方流程建任务写 PRD → 面板渲染报告并一键直达新任务。取代 FR 中撤下的"AI 规划"直写入口：面板自身不再建任务，写入全部由有工作流身份的 worker 完成（06 v2 支柱三 T4 第 2 步）。

## Requirements

1. **planner 员工档案**（.trellis/agents/planner.md，仓库工件而非面板运行时写入）：角色规则=官方脚本建任务（禁手写 task.json）/仅写 prd.md（≤120 行，含用户原话与开放问题）/不实施/不动其他文件/固定格式报告（任务目录/标题/PRD 路径/要点/待确认）。
2. **派发序列**（runPlannerDispatch）：create ephemeral → spawn `--agent planner --provider codex --sandbox workspace-write` → send（--text-file 承载需求）→ wait turn_finished → collect 报告 → rm；失败即停+树杀；复用 dispatchPhase 事件与 abortDispatch。
3. **IPC/UI**：task.dispatchPlan；任务页工具栏"AI 起草任务"按钮 → PlannerModal（标题+需求输入 → 六阶段进度 → 报告 Markdown 渲染 → 从报告解析任务目录名一键"查看新任务"）；成功后主动 sendSnapshot。
4. 边界：planner.md 属官方 `--agent` 扩展点，不在 AGENTS.md/workflow.md/spec/skills 托管文件清单内。

## 验证（2026-09-30 全部通过，真实派发）

- [x] typecheck node+web + build 通过。
- [x] **端到端真跑**：派发"演示：planner 派单验证"需求 → worker 约 4 分钟完成 → `09-30-planner-dispatch-demo` 任务真实创建：
  - task.json 为官方脚本产物（全 schema 字段 + creator 取自 .developer + seed 的 implement/check.jsonl）——worker 未手写；
  - prd.md 严格按档案模板（背景/需求含原话引用/验收标准/开放问题）；
  - 报告精确三段格式，"任务目录："行可被解析直达；
  - git 边界：worker 仅写新任务目录，零越界（workspace-write 下 prompt 约束成立）。
- [ ] 用户验收：面板任务列表看到演示任务 → 打开阅读 PRD →（演示任务 PRD 自带的验收项）→ 审阅后自行归档。

## Notes

- 演示任务保留为活跃状态供用户走完"PRD 待审"审阅流；归档由用户执行（task.py archive 或面板外）。
- 后续（未含）：起草前查重（同名/相似任务提示）、planner 模型设置共用 dispatch.codexModel。

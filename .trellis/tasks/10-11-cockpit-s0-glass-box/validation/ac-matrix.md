# AC1–AC10 验收矩阵（如实填写）

日期：2026-10-12。口径：`passed`=机器验证通过且有证据路径；`not_run`=需要人工走查/真实环境，尚未执行；`blocked_external`=依赖公司环境/上游/他人，本任务内无法关闭。**不存在"文档定稿即通过"。**

| AC | 需求 | 状态 | 证据 / 缺口 |
| --- | --- | --- | --- |
| AC1 | FR1 三入口一致；JSON 原值可见；清单真实行号 | **passed（夹具级 + 自动化走查）/ 部分留用户（项目外文件真人操作、高缩放真机目检）** | task-reader 57 项 + reader-wiring 41 项；walkthrough-report.md §reader（预览/展开/Esc 层级/视图切换/宽度偏好实测，截图 02/03）；**2026-10-13 补**：1280/1920/1920@2x 截图（walkthrough 04/05/06，CDP 视口仿真 + 视觉核验，无破损/横滚） |
| AC2 | FR1 连续保存不重置；会话草稿+最近提交比较；坏文件/无 Git 降级 | **passed（夹具级 + 自动化走查核心项）** | reading-session 59 项；walkthrough-report.md：外部改盘→「当前阅读任务有更新」提示出现且正文未跳→阅读新版干净切换（真实应用实测） |
| AC3 | FR2 认证宿主 assembled/emitted 可配对；输出失败无 emitted；观测失败不改 stdout | **passed（直调 + 真实 TUI 宿主进程内，2026-10-13）** | hook-emitter 117 项 + walkthrough-report.md 三轮调查 + **host-verification.md**：真实交互式 Codex TUI（0.159.2）内原生 spawn_agent 派发 trellis-research → SubagentStart 触发（codex TRACE hook/started + 钩子 armed 双证）→ 注入真实生效（子代理 rollout 含标记）→ assembled+emitted 对落库（injectionId 0327c767、producer.host=codex、parentId=真实主会话）。`codex exec` 不触发 SubagentStart 的上游结论维持（4478dc7）；TUI 内 `task.py start` 降级缺口已根因登记（known-issues 环境类） |
| AC4 | FR2 并发/重复/锁/容量/旧 schema/禁用恢复 | **passed** | observability-store 82 项（真实 worker 线程+node:sqlite）；跨进程语义另证于 g1b 探针 |
| AC5 | FR3 多任务/项目/归档不串线；状态/活动/归档独立；不伪造阶段 | **passed** | receipt-projection 41 项 + task-identity/archive 冒烟；真实多 worktree 场景待走查（边缘） |
| AC6 | FR4 重复点击/中断恢复可恢复；PRD 来源真实；归档与流转分离 | **passed（夹具级 + 真实工单全链）** | jira-local-task 77 项 + light-task-metrics 18 项；**真实闭环（2026-10-13）**：真实工单 HONSKY-984 点击「在当前项目创建任务」→ 本地任务创建（panel_* 溯源 meta 全链：issueKey/issueId/operationId/updatedAtMs）→ PRD 草稿含来源链接与「待结合本机代码确认」→ 重复点击防重（该行变「打开本地任务」，68→67）→ task.py archive 归档完成。真实计量：新增管理动作 1（一次点击）、重复录入 0、重复确认 0（目标 0/0/≤2 达成） |
| AC7 | FR5 两版本 Jira 基线 + hook 性能报告 | **部分：性能 passed（夹具口径见 performance.md）；Jira blocked_external** | 性能采样 200 对×2 档（直调口径，非真实宿主）；公司 Jira 权限未验证（jira-baseline.md §3 登记） |
| AC8 | 全部：typecheck/build/既有测试/无回归/三档尺寸/焦点 Esc | **passed（机器 + Esc/宽度走查 + 三档宽度截图）/ 高缩放真机目检留用户** | typecheck+build+15 套冒烟全绿；chat/tpap 既有失败经干净树复现隔离（known-issues）；Esc 逐层退出实测通过（walkthrough-report.md §5）；1440 收起规则实证（innerWidth=1360 时右栏默认收起）；1280/1920/1920@2x 截图补齐（walkthrough 04/05/06） |
| AC9 | FR2 干净/用户修改项目的安装/升级/禁用/回退；另一开发可接入 | **blocked_external** | 上游 `mindfold-ai/trellis` PR 未发起；本地实验完成（host-distribution.md §6）；按 implement.md 规则 AC9 不得由本地实验关闭。**2026-10-13 备件就绪**：英文 PR 草稿两份（research/upstream-pr-draft.md，本地未推送）——用户选"发"则过目后按检查单提交，选"不发"则作废走本地维护 |
| AC10 | FR5 2 开发+1 协作者试点；新增负担与维护时间记录 | **not_run（人选未定）** | 08 决策第 2 项待用户指定；走查清单已备（light-task.md/reader.md/observability.md §4）。**2026-10-13 备件就绪**：安装包 `release/TrellisPanel-Setup-0.1.0.exe`（140MB NSIS，gitignored）+ 试点速览一页纸（pilot-quickstart.md）——用户回复名单即可转发启动 |

## 结论

- **可机器验证的部分全部通过**：15 套冒烟（约 700+ 断言）、typecheck/build、打包探针、性能采样。
- **宿主进程内验证（AC3）已通过**（host-verification.md，2026-10-13 真实 TUI 全链）。
- **不可由建造者单方关闭的部分如实保持未完成**：真实环境走查（AC1/2/6/8 的走查半边残余项）、公司 Jira（AC7）、上游分发（AC9）、跨人试点（AC10）。
- 按 implement.md G5 规则：**本任务不归档**，待用户完成走查与试点后按证据关闭剩余项。

## 建议的用户动作（按优先级）

> 2026-10-13 更新：第 1、2 步的自动化部分已由走查完成（walkthrough-report.md）；剩余为需要人眼/真实环境的部分。

1. ~~`npm run dev` 走查~~ → **已自动化完成主体**；剩：1280/1920 窗口截图、高缩放、项目外文件、AcpConsole compact 目检（可选，低风险）。
2. ~~启用观测绑定跑真实会话~~ → **已完成（含宿主半边）**：绑定与真实回执闭环通过（面板点过绑定、真实 hook 落 assembled+emitted）；**2026-10-13 宿主进程内验证通过（host-verification.md）**：真实 Codex TUI 内派发子代理，钩子注入与回执全链生效。附带回执：TUI 内触发需先有会话指针——TUI 起始时在外部跑一次 `TRELLIS_CONTEXT_ID=codex_<会话id> python .trellis/scripts/task.py start <task>` 即可（缺口详情见 known-issues 环境类）。
3. ~~Jira 页用真实工单点一次"在当前项目创建任务"~~ → **已完成（2026-10-13，应用内代执行）**：真实工单 HONSKY-984 全链通过并归档，计量 1/0/0 达标（见 AC6 行）。
4. 指定试点人选（08 决策第 2 项）→ G5 试点。**2026-10-13 已通过结构化提问正式征询用户（试点人选/上游 PR/AC3 宿主动作三问），用户未作答**——AC10 维持 not_run 如实登记，不虚构人选。
5. 决定是否发起上游 PR（关闭 AC9 的唯一路径）。同上征询未获回复，AC9 维持 blocked_external。若用户后续选择"发"：先把观测 emitter 改造整理为上游模板补丁草稿＋PR 描述（仅本地准备不推送，用户过目后定）。

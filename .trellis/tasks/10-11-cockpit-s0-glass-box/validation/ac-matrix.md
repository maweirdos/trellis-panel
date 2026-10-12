# AC1–AC10 验收矩阵（如实填写）

日期：2026-10-12。口径：`passed`=机器验证通过且有证据路径；`not_run`=需要人工走查/真实环境，尚未执行；`blocked_external`=依赖公司环境/上游/他人，本任务内无法关闭。**不存在"文档定稿即通过"。**

| AC | 需求 | 状态 | 证据 / 缺口 |
| --- | --- | --- | --- |
| AC1 | FR1 三入口一致；JSON 原值可见；清单真实行号 | **passed（夹具级）/ not_run（真实走查）** | task-reader 57 项 + reader-wiring 41 项（三入口同契约）；`validation/reader.md` §4 人工清单未走 |
| AC2 | FR1 连续保存不重置；会话草稿+最近提交比较；坏文件/无 Git 降级 | **passed（夹具级）/ not_run（真实走查）** | reading-session 59 项（状态机/diff worker/git 基线夹具）；连续保存的视觉体验待走查 |
| AC3 | FR2 认证宿主 assembled/emitted 可配对；输出失败无 emitted；观测失败不改 stdout | **passed（直调级）/ not_run（真实会话端到端）** | hook-emitter 117 项（真实 hook 脚本+真实 python+真实 SQLite，与 git HEAD 逐字节一致）；真实 Codex 会话闭环待用户绑定观测后走查 |
| AC4 | FR2 并发/重复/锁/容量/旧 schema/禁用恢复 | **passed** | observability-store 82 项（真实 worker 线程+node:sqlite）；跨进程语义另证于 g1b 探针 |
| AC5 | FR3 多任务/项目/归档不串线；状态/活动/归档独立；不伪造阶段 | **passed** | receipt-projection 41 项 + task-identity/archive 冒烟；真实多 worktree 场景待走查（边缘） |
| AC6 | FR4 重复点击/中断恢复可恢复；PRD 来源真实；归档与流转分离 | **passed（夹具级，真实 CLI）/ not_run（真实 Jira）** | jira-local-task 77 项（恢复矩阵真实 python+task.py）+ light-task-metrics 18 项；真实工单点击待用户 |
| AC7 | FR5 两版本 Jira 基线 + hook 性能报告 | **部分：性能 passed（夹具口径见 performance.md）；Jira blocked_external** | 性能采样 200 对×2 档（直调口径，非真实宿主）；公司 Jira 权限未验证（jira-baseline.md §3 登记） |
| AC8 | 全部：typecheck/build/既有测试/无回归/三档尺寸/焦点 Esc | **passed（机器）/ not_run（视觉走查）** | typecheck+build+14 套冒烟全绿；chat/tpap 既有失败经干净树复现隔离（known-issues）；1280/1440/1920 截图与 Esc 实感待走查 |
| AC9 | FR2 干净/用户修改项目的安装/升级/禁用/回退；另一开发可接入 | **blocked_external** | 上游 `mindfold-ai/trellis` PR 未发起；本地实验完成（host-distribution.md §6）；按 implement.md 规则 AC9 不得由本地实验关闭 |
| AC10 | FR5 2 开发+1 协作者试点；新增负担与维护时间记录 | **not_run（人选未定）** | 08 决策第 2 项待用户指定；走查清单已备（light-task.md/reader.md/observability.md §4） |

## 结论

- **可机器验证的部分全部通过**：15 套冒烟（约 700+ 断言）、typecheck/build、打包探针、性能采样。
- **不可由建造者单方关闭的部分如实保持未完成**：真实环境走查（AC1/2/3/6/8 的走查半边）、公司 Jira（AC7）、上游分发（AC9）、跨人试点（AC10）。
- 按 implement.md G5 规则：**本任务不归档**，待用户完成走查与试点后按证据关闭剩余项。

## 建议的用户动作（按优先级）

1. `npm run dev` 走查 validation/reader.md §4 + observability.md §4（约 30 分钟）。
2. 设置页启用观测绑定（生成 binding.json）→ 跑一次真实 Codex 子代理任务 → 看 AcpConsole/Tasks 观察面板出现真实回执（AC3 真实半边）。
3. Jira 页用真实工单点一次"在当前项目创建任务"（AC6 真实半边 + 轻任务计量录制）。
4. 指定试点人选（08 决策第 2 项）→ G5 试点。
5. 决定是否发起上游 PR（关闭 AC9 的唯一路径）。

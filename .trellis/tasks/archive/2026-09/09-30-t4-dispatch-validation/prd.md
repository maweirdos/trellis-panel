# T4 派单能力验证：Codex 只读审阅一键派发

## Goal

按 06 v2 §2 支柱三的 T4 纪律交付**能力验证切片**（不是控制台）：一键派 codex + `--sandbox read-only` worker 对指定任务做只读审阅，固定三段报告（审阅结论/发现的风险/待人工确认）在面板渲染。planner、修复型 check、归档三段式、元数据代跑均以本验证通过为前提，另立任务。

## Requirements

1. **派发序列**（services/channel-dispatch.ts）：channel create（ephemeral，--task 挂任务）→ spawn（provider codex、--sandbox read-only、--as reviewer、--cwd 项目根、--file 仅任务材料 prd/design/implement 实存者、--timeout 20m）→ send（--message-file 临时文件承载多行 prompt，避免 shell 重解释；--delivery-mode requireRunningWorker）→ wait（turn_finished）→ messages --raw 提取报告 → rm 清理。每步失败即停并报告所在阶段 + 树杀清理。
2. **铁律落地**：trellis 子进程 cwd = 目标项目根（频道项目桶与 worker cwd 一次对齐）；只投喂任务材料（worker 不自动获得全仓）；报告仅展示不落盘；--sandbox 仅 codex 有效（provider 钉死 codex，注释说明 claude 适配器 bypassPermissions 不可用于只读）。
3. **中止**：关闭弹窗/中止按钮 → taskkill /T 树杀整条 cmd→trellis.cmd→node 链。
4. **UI**：工作台 ShieldCheck 按钮 → DispatchModal：六阶段进度（dispatchPhase 事件驱动）、报告 MarkdownView 渲染、错误红条、重跑；底部常驻"关闭即中止；报告不写任务目录"。
5. **prompt 固定格式**：三段结构 + "无则写无"，确保可解析。

## 验收（代码侧已验 / 运行侧待用户执行）

- [x] typecheck（node+web）+ build 通过。
- [x] 命令拼装干跑：六步参数序列正确（引号/相对路径/文件清单）。
- [x] 服务代码经 Write 直写未被 shell 转义污染（正则/换行字面量复核）。
- [x] **运行侧验证（2026-09-30 已通过，codex 0.159.2）**：对 09-30-fr-first-release 真实派发——六步全通（create/spawn read-only/send --text-file/wait turn_finished/collect/rm）；报告 1563 字符严格三段格式、含 9 条 file:line 依据（见 research/gate-validation-report.md）；`git status` 零写入（read-only 沙箱成立）；待确认问题两条可读。**门禁通过，planner/归档三段式解锁。**

## Notes

- codex CLI 未安装/未登录时在 spawn 阶段给出定向错误提示。
- 执行与验证记录见 implement.md。

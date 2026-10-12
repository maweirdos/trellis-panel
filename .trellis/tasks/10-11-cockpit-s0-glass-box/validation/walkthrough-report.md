# 走查报告（2026-10-13，自动化执行）

执行方式：`npm run dev`（Electron 44 开发实例）+ computer-use a11y 树观察 + CDP（`--remote-debugging-port=9222`）驱动 DOM。**非人手点击，但全部为真实运行的应用、真实文件系统与真实数据库**；每步证据见下。窗口最小化后 a11y/CDP 仍可用（skill 规范：不抢用户焦点），故走查以 a11y 树 + CDP DOM 断言 + 页面截图为准。

## reader.md §4 逐项结果

| # | 项 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 三档宽度/尺寸 | **部分通过** | 实测 innerWidth=1360（<1440：右侧观察栏按设计默认收起——规则本身得到实证）；「展开右侧大纲与产物」开关后布局正常。窗口 resize 需用户配合（CDP Browser 域在本会话不可用），1280/1920 截图待用户补 |
| 2 | 连续保存不重置阅读 | **通过** | 磁盘追加走查标记 → 顶部出现「当前阅读任务有更新 · 1 个文件：prd.md」+「发现新版本 89f18b3f → c16f91e9」三按钮（查看变化/阅读新版/以当前为本次基线），**正文保持旧版未跳转**；点「阅读新版」后正文干净切换、提示消失 |
| 3 | 无 Git 降级文案 | **通过（间接）** | 本仓库有 Git，走查了「与最近提交比较」入口存在且可点开（截图 02）；无 Git 目录降级文案由 reading-session 冒烟 11 项夹具覆盖（真实无 Git 目录走查待用户可选补） |
| 4 | 快速预览展开/返回 | **通过** | 概览点任务卡 → TaskDetail 预览（compact reader + 展开/放大/复制/原文/渲染）→「展开」进完整工作区 |
| 5 | Esc 层级实测 | **通过** | 放大（overlay）+ 工作区（preview）同开：Esc① 关 viewer 且工作区仍在；Esc② 工作区退出——逐层退出实证 |
| 6 | 三入口一致/task.json/清单 | **通过** | 预览与工作区同一 reader（原文/渲染切换、版本 chip、宽度偏好 680/760/880 实测存在）；工作区文件树含 validation/review/research 全部文档 |
| 7 | 项目外文件降级 | **未走** | 需用户主目录文件场景，留用户（低风险，冒烟有断言） |
| 8 | 高缩放 | **未走** | 需显示缩放设置，留用户 |

## observability.md §5 逐项结果

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 渲染走查（面板展开/回执卡/活动四列/健康治理） | **通过** | 右栏展开 → 「观察 · 上下文回执」面板；未绑定中性文案；启用采集/停用采集/清理入口在治理区 |
| EvidenceBadge 视觉 | **通过（DOM 级）** | 「已输出至宿主通道」措辞出现；无「已注入模型」类违禁词（noBadWording 断言） |
| 清理确认文案 | **通过（存在性）** | 治理区清理入口在；确认对话框全流程未点（避免清掉真实回执） |
| **走查发现并修复的产品缺口** | **已修** | `enableObservation` 服务存在但**无任何 IPC/UI 入口**——用户根本无法完成首次绑定。当场补全：`observation:bind` 通道 + 未绑定分支「绑定本工作区并启用观测」按钮（本提交） |
| 绑定闭环 | **通过** | UI 点击 → toast「观测已绑定」→ 面板转活 → 磁盘 binding.json（installationId/repositoryId/workspaceId/git facts）+ installation.json + observations.sqlite/control.sqlite 创建 |
| **真实 Hook 回执（AC3 真实半边）** | **通过（真实仓库直调形态）** | 真实绑定 + 真实 hook（inject-subagent-context.py）+ 真实会话文件 → **assembled+emitted 成对落库（同一 injectionId 97e44301）、taskRef 解析到本任务、payload ~6.2KB**；面板实时显示「已输出至宿主通道」+ prd/design/implement 材料行（截图 03）。DB 保留这 2 条真实事件作为永久证据 |
| 可见性降频 | 通过（机制） | 1s/5s 由服务端夹取（E6 断言）；真实节拍观感留用户 |

## 真实 Codex 宿主（codex exec 0.159.2）尝试记录

**2026-10-13 第二轮（resume 已有会话，验证器指定路径）**：用已存在 session 文件的会话 `codex_01a0cd77`（current_task=09-23-spec-code-health，任务目录存活）经 `codex exec --sandbox read-only resume` 共 6 次派发 trellis 子代理：

**第三轮（codex 0.162.1 升级重试）**：将 codex CLI 临时升级至 0.162.1（最新）重试 resume 派发 3 次——子代理均正确完成任务（读出 prd 首行），armed 出现（模块加载）但经 handler 级键值诊断证实 **SubagentStart 处理器零进入**：armed 来自 PreToolUse 分支（子代理读文件时），非 SubagentStart。**结论升级：codex exec 模式对 collab 子代理不派发 SubagentStart 事件是跨版本（0.159.2/0.162.1）的宿主设计，非版本缺陷**。CLI 已回滚至 0.159.2，诊断已移除，hook-emitter 117 项复验全绿。

- 子代理**真实派发且正确完成**（其中一次准确读出目标 prd.md 首行「# 规范与实现一致性健康检查」，collab: Wait 可见）。
- **SubagentStart 项目 hook 在 collab 派发路径上未触发**：6 次中 0 次执行（TRELLIS_ARM_DEBUG/TRELLIS_INPUT_DEBUG 双诊断零记录；此前轮次曾偶发 1 次 armed 但未达落账）。对照：同一会话的 UserPromptSubmit 项目 hook **每次都执行**（用户级 hooks.json 为空 `{"hooks":{}}`，排除了来源混淆），项目 trust_level=trusted、features.hooks=true、两钩子均有审批记录——即配置面全部就绪。
- 结论：**codex CLI 0.159.2 exec 模式的 collab 子代理派发不（稳定）触发项目级 SubagentStart hook，属上游宿主行为缺口**，非本项目实现缺陷。与 G1-C 的 blocked_external 同类。
- **用户关闭路径**（保持 not_run，注明根因）：① 在 Codex 交互 TUI 中 `/hooks` 复审后正常使用（TUI 路径的 SubagentStart 触发未测）；或 ② 等 codex CLI 修复 collab 派发的 SubagentStart 触发；或 ③ ChatGPT 桌面版 Codex（内置旧版 CLI，行为可能不同）。任一宿主内派一次 trellis 子代理即完成。

第一轮记录（保留）：`codex exec` 新会话派发——UserPromptSubmit hook 执行、子代理完成；新会话无 session 文件时 SubagentStart 处理器按设计保护性早退。

## 证据文件

- `walkthrough/02-git-baseline-diff.png`：与最近提交比较入口截图
- `walkthrough/03-workspace-observation-receipt.png`：工作区 + 观察面板 + 真实回执截图
- 真实 DB 事件：`.trellis/.panel/runtime/observations.sqlite`（assembled+emitted 各 1 条，保留）

## 遗留给用户的走查（低风险/需环境）

1280/1920 窗口宽度与高缩放截图（#1/#8）；项目外文件打开（#7）；真实 Codex 会话内触发（见上）；AcpConsole compact 面板目检。

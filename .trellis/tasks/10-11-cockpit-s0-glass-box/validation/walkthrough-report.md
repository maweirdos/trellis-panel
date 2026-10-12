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

- `codex exec --sandbox read-only` 派发 trellis-research：**UserPromptSubmit hook 真实执行**（宿主日志可见），子代理真实完成；但未落回执。
- 根因（已定位）：新 codex 会话无 `.trellis/.runtime/sessions/codex_<id>.json`（current_task 未绑定）→ SubagentStart 处理器 `require_existing=True` 保护性早退；且该次 collab 派发未见 SubagentStart 触发日志。**arm 与绑定均正常**（TRELLIS_ARM_DEBUG 诊断输出 `armed`）。
- **用户复现路径**：面板里把任务设为当前（会话绑定后 UserPromptSubmit 会写 session 文件）→ 在 Codex 里让主代理派 trellis 子代理 → 回执自然落库。
- 结论：AC3「真实宿主进程内触发」仍标 not_run（诚实）；「真实仓库+真实绑定+真实 hook 的注入回执闭环」**已通过**（直调形态）。

## 证据文件

- `walkthrough/02-git-baseline-diff.png`：与最近提交比较入口截图
- `walkthrough/03-workspace-observation-receipt.png`：工作区 + 观察面板 + 真实回执截图
- 真实 DB 事件：`.trellis/.panel/runtime/observations.sqlite`（assembled+emitted 各 1 条，保留）

## 遗留给用户的走查（低风险/需环境）

1280/1920 窗口宽度与高缩放截图（#1/#8）；项目外文件打开（#7）；真实 Codex 会话内触发（见上）；AcpConsole compact 面板目检。

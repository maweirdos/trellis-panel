<!-- TRELLIS:START -->
# Trellis Instructions

These instructions are for AI assistants working in this project.

This project is managed by Trellis. The working knowledge you need lives under `.trellis/`:

- `.trellis/workflow.md` — development phases, when to create tasks, skill routing
- `.trellis/spec/` — package- and layer-scoped coding guidelines (read before writing code in a given layer)
- `.trellis/workspace/` — per-developer journals and session traces
- `.trellis/tasks/` — active and archived tasks (PRDs, research, jsonl context)

If a Trellis command is available on your platform (e.g. `/trellis:finish-work`, `/trellis:continue`), prefer it over manual steps. Not every platform exposes every command.

If you're using Codex or another agent-capable tool, additional project-scoped helpers may live in:
- `.agents/skills/` — reusable Trellis skills
- `.codex/agents/` — optional custom subagents

Managed by Trellis. Edits outside this block are preserved; edits inside may be overwritten by a future `trellis update`.

<!-- TRELLIS:END -->

## 文字输出
与用户交流使用大白话并结合场景来解释说明

# 本地验证规范 (Local verification)

- 保持项目自有的测试代码、测试固件（fixtures）、模拟数据（mocks）、快照及验证报告仅在本地保留，不得暂存（stage）、提交（commit）或强制添加至代码库。
- 将临时验证脚本及产物统一放置在操作系统 TEMP 临时目录下，严禁引入被跟踪的测试运行器、CI 测试作业或仅供测试的依赖项。
- 完整保留生产检查与生命周期保护规则：`check:acpx`、`check:ui`、`typecheck`、`build`、`postinstall` 以及现有的开发/构建/类型检查/打包保护，执行适用的生产检查并汇报结果。
- 禁止修改全局 Git 配置或 Git hooks 来强制推行这些规则。
- 涉及注册表写入或卸载清理的真实安装验收必须在隔离 Windows 用户或虚拟机中执行；TEMP 安装目录不隔离 HKCU。不得对日常 Windows 用户的注册表执行测试清理或递归删除。
- PowerShell 验证脚本不得将 `$Matches`、`$PID`、`$HOME` 等自动变量用作业务变量；正则匹配会覆盖大小写不敏感的 `$Matches`。删除或移动前必须校验非空的规范绝对路径和目标归属，任何校验错误立即终止脚本，不得继续清理。

# UI/UX 设计标准与执行红线 (UI design standard)

- **强制遵守全局设计规范**：所有页面设计与前端修改**必须无条件严格遵守根目录下的 [DESIGN.md](file:///d:/my_demo/trellis-panel/DESIGN.md) 设计系统**。在设计或编写任何 UI 代码前，必须完整阅读 `PRODUCT.md` 明确用户定位与约束，再研读 `DESIGN.md` 与 `.trellis/spec/frontend/css-design.md`，最大化复用共享组件与设计令牌（Design Tokens）。
- **必须严格贯彻四大核心质感支柱**：
  1. **多层表面与微光阴影 (Surfaces & Depth)**：杜绝单一灰白平涂，构建 `bg-shell` -> `bg-canvas` -> `bg-panel` -> `bg-elevated` 清晰物理表面阶梯，卡片配合环境微阴影与半透明微内描边。
  2. **微排版与字体灰度阶梯 (Micro-typography)**：严格落实主要文字（90%~95%）、次要文字（65%~75%）、辅助说明（40%~50%）的对比阶梯；指标数字必须具有展示级字号与字重张力；线性图标与文字光学垂直居中严格统一。
  3. **紧致的信息组织与微组件 (Micro-widgets)**：严禁空旷漂浮，主内容区必须设置合理的上限宽度（默认 1120px）；遵循“外疏内紧”格式塔节奏，避免三四层深缩进的传统树形菜单，引入高保真微型进度、状态标签与用户卡片。
  4. **克制的 5% 点睛质感 (Strategic Accent Glow)**：全界面保持 95% 精致克制的中性黑白灰，仅在 5% 关键操作、高亮状态与品牌微标处注入点睛色彩，禁止大面积滥用高饱和色彩。
- 以当前设置（Settings）界面为全局视觉基线，页面根据任务选用居中或铺满布局。
- 对标 Linear 与 Apple Notes 顶级生产力标准进行极简与纯粹设计：单一明确目标、极简架构、克制设计与直接高效实现。
- 杜绝口号标语、次级辅助文本与冗余的状态/计数徽标。完全由布局结构与空间物理关系传达功能意图。如果某个视图需要堆砌解释性标签才能被看懂，重构布局，严禁追加文字说明补丁。
- 每一处界面设计与交互决策，必须在不破坏既有行为、无障碍访问（a11y）与类型安全的前提下，同时提升用户体验（UX）、开发体验（DX）与智能体协作体验（AX）。
- 输入框与工具栏操作控件（如发送、停止）直接展示无边框图标，严禁外加粗重轮廓描边、实心填充底色框或包装盒；选择器直接展示目标项本身，严禁附加厂商或提供商前缀。
- 普通矩形表面与控件强制使用 `--my-radius-base: 10px`，三档密度预设均不改变圆角。严禁私自声明局部圆角或由间距推导圆角偏移；功能圆环、轨道保留 `full`/`round`，拼接内侧与全屏贴边使用 0。
- 普通条目名称使用 `my-item-title`，辅助描述使用 `my-item-description`。页面标题、正文阅读内容、数值指标和状态信息使用各自独立的排印角色，严禁标题样式污染至可编辑内容或输入控件。
- 必须在浅色（Light）、深色（Dark）双主题及三档界面密度（Small / Standard / Large）下自检实际渲染效果，确保键盘焦点清晰、图标悬停克制及低动态偏好正常响应。

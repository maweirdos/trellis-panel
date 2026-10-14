# PRD — 全应用换壳为 参考 UI/UX（范围修订 v2）

> v1（已完成，commit ab6ca81）把 参考 做成了内嵌演示页，与用户意图不符。
> 本版修订：参考 外壳成为整个 trellis-panel 的唯一应用壳，现有功能全部迁入。

## Goal

trellis-panel 的整个界面复刻 参考仓库 的 UI/UX：参考 的工作区侧边栏 +
项目侧边栏 + 顶栏是唯一外壳；旧 Sidebar/页面路由退役；现有页面作为壳内内容保留；
内容使用真实 Trellis 数据（snapshot），不复刻 参考 的内容。

## Requirements

- R1 壳替换：TitleBar（保留窗口控制，按 参考 视觉重绘）+ MyApp 唯一外壳；
  旧 Sidebar 退役；路由以主 store `page` 为唯一事实（IPC 事件联动不受影响）。
- R2 真实数据：任务→工作项（planning/in_progress/review/completed→
  规划中/进行中/评审中/已完成 五状态；P0-P3→urgent/high/medium/low），
  五布局（列表/看板/表格/甘特/日历）+ Filters/Display 全部吃真实 snapshot；
  Your work/分析 用真实统计；无 snapshot 时（浏览器 ?my=1 预览）回退演示数据。
- R3 导航映射：Your work←概览；Analytics←真实统计；项目=当前 Trellis 项目；
  项目侧边栏：Work items / 文档（知识库/规范文档/归档）/ 待办池（Intake）；
  工作区侧边栏协作组：AI 频道/Agent 会话/团队协作/Jira 任务；
  系统组：架构图/定制中心/模型管理/MCP 网关/设置。
- R4 旧页面保留并 参考 化重绘：统一 52px 顶栏（面包屑/标题/操作）、p.* 令牌、
  统一控件；功能逻辑不动。任务深度详情仍用现有 TaskDetail（参考 化抽屉框），
  my peek 提供「打开任务详情」入口。
- R5 主题跟随面板 settings.theme；命令面板（Ctrl+K）为全局唯一，含真实页面/任务搜索。
- R6 代码不留痕迹：注释描述功能而非来源，无「克隆/演示」类注释与 UI 文案；
  演示数据仅存在于无 snapshot 的预览回退路径。

## Acceptance Criteria

- AC1 typecheck + build 通过。
- AC2 启动即 参考 壳：无旧面板侧边栏；IPC 事件（收件箱新条目/桥接聚焦/任务更新）
  仍能正确切换页面。
- AC3 工作项页五布局渲染真实任务；筛选/分组/排序可用；行点击开 peek，
  peek 可跳真实 TaskDetail。
- AC4 Your work/分析 渲染真实统计；待办池/知识库/规范文档/归档功能可用且外壳 参考 化。
- AC5 协作/系统组页面功能可用且外壳 参考 化。
- AC6 命令面板可搜真实任务与页面；深/浅主题全壳生效。
- AC7 真机截图/a11y 验证：启动即 参考 壳，核心页视觉一致。

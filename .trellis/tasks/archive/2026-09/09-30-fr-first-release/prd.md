# FR 首个可交付版本：主从阅读+热键唤起+记住位置+合并提醒

## Goal

按 06 v2 §4.1 交付首个可交付版本（FR）：可信读取已在 R0 落地，本任务补齐——单项目主从阅读与材料直读（看板退场）、稳定任务地址（选中任务持久恢复）、热键唤起恢复上次阅读位置、显式打开剪贴板任务路径、按任务合并的材料更新提醒。

## Requirements

1. **主从常驻**：任务页始终为"左侧任务导轨 + 右侧阅读区"；未选任务时右侧显示空态（j/k、Esc、Ctrl+K 提示）；四列看板及其工具栏条件显隐、拖拽交互全部退场。
2. **撤下死胡同入口**：任务页工具栏移除"新建待办""AI 规划"按钮（02 P0-5 决策），新增"打开剪贴板任务"（显式动作，不自动跳转；接受任务路径或裸目录名，活跃/归档均可解析）。
3. **稳定地址**：进入任务页时恢复上次阅读的任务（仅首次，存在性校验）；工具栏常驻（搜索/负责人/优先级/计数不再随选中状态消失）。
4. **记住阅读位置**：每项目持久化 {任务, 文档, 滚动位置}（localStorage，面板本地偏好，不写任务权威字段）；文档加载完成后恢复滚动（任务+文档都匹配才恢复）；滚动 500ms 节流落库。
5. **热键唤起**：主窗口切换热键（默认 Alt+Shift+T，设置可改）唤起时广播 focusLastReading → 渲染端回任务页并恢复上次阅读任务；不新开、不自动跳最新文件。
6. **材料更新提醒（唯一触达项）**：watcher 文件事件按任务 8 秒防抖合并 → materialUpdated 事件（带 dirName/title/count/files）→ 渲染端区分"正在阅读的任务（轻提示）"与"其他任务（正常提醒）"。合同：只报文件事实；首扫不通知（chokidar ignoreInitial）；面板自身写入 5 秒内不通知（markPanelWrite）；归档任务变化不提醒。
7. Esc 关闭当前任务回空态；j/k 与 ↑↓ 键盘导航保持。

## Acceptance Criteria

- [x] `npm run typecheck` / `npm run build` 通过。
- [x] 全仓无 taskArchive/autoSync/DoDModal 残留；Tasks.tsx 无 boardColumns/groupOn/hasEpics/planSeed/intakeOpen 残留。
- [x] 任务页任何状态下均为主从布局；未选任务不报错（空态渲染）。
- [x] 材料提醒链路（watcher → routeMaterialNotice → materialUpdated → toast）编译期完整；提醒含面板自写过滤。
- [x] 阅读位置只落 localStorage（`tp:reading:<project>`），不写 .trellis 任何文件。

## Notes

- "生成即读"闭环的另一半（托盘点击直达、通知点击定位）依赖托盘交互改造，随 T1 触达扩展收敛；本版先以系统 toast + 热键恢复覆盖主路径。
- 沉浸模式/mermaid/jsonl 表格化等阅读增强属后续迭代（06 v2 支柱二），本版不动 ArtifactViewer 主体。
- 执行与验证记录见 `implement.md`。

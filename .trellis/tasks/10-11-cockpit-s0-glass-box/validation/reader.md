# G2 第三片（三入口接入）验证记录 · reader

状态：本片代码已完成；机器验证（typecheck / build / 冒烟）已执行并通过；
**标注「待人工走查」的项尚未执行**，不视为通过。对应 PRD FR1 / AC1 / AC2 / AC8，design §6.1–§6.4。

## 1. 机器验证（已执行）

| 项 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 类型检查 | `npm run typecheck` | 通过 | node + web 两套 tsconfig |
| 构建 | `npm run build` | 通过 | renderer 分包产物正常 |
| IPC 注册表冒烟 | `node scripts/smoke/ipc-registry.mjs` | 通过 | 新增 document:watch/unwatch 已登记且注册（双向断言） |
| 渲染契约冒烟 | `node scripts/smoke/render-contract.mjs` | 通过 | 与本片无冲突 |
| ACP 冒烟 | `node scripts/smoke/acp.mjs` / `acp-mock-agent.mjs` | 通过 | AC8 相关回归面 |
| 观测契约冒烟 | `node scripts/smoke/observability-contract.mjs` | 通过 | |
| 代理冒烟 | `node scripts/smoke/proxy.mjs` | 通过 | |
| 阅读会话冒烟 | `node scripts/smoke/reading-session.mjs` | 通过 | 第二片地基未回归 |
| 任务读取冒烟 | `node scripts/smoke/task-reader.mjs` | 通过 | DocumentController 未回归 |
| **三入口接线冒烟（新）** | `node scripts/smoke/reader-wiring.mjs` | **通过（40 断言）** | 覆盖见 §2 |
| chat 冒烟 | `node scripts/smoke/chat.mjs` | **失败（基线既有）** | 在未改动基线（git stash 后）同样失败：`等待超时: 流式增量`，与本片无关，如实登记 |
| tpap 冒烟 | `node scripts/smoke/tpap.mjs` | **失败（基线既有）** | 基线同样失败：`tool_search 按关键词检索到 sql 工具` 空结果，与本片无关 |

> chat/tpap 两个失败已用 `git stash` 在无本片改动的基线上复现同样失败，判定为既有问题；
> 本片不修改这两个域（chat/tpap 源文件零改动），留待对应任务处理。

## 2. reader-wiring 冒烟覆盖（40 项断言，全部通过）

1. **变更信号桥定向性**（change-bridge，真实临时夹具）：
   - 无关文档变化零通知（只有已注册 canonicalPath 收到事件）；
   - knownRevision 竞态闭合：注册时磁盘版 ≠ 调用方已知版 → 立即补发一条；
   - settle 合并：连续两次写入只通知一次，携带最终内容 sha256 前 16 hex；
   - 引用计数：同路径两会话解除一个仍通知，全部解除后停发；重复 unwatch 幂等；
   - 文件被删除 → 通知 revision=null（不伪装成版本）；
   - `clearReaderDocuments()` 清空（项目切换收口）；
   - scope 非法 / `..` 越界 / 空 relativePath → E_INVALID_ARG（请求级失败口径与 documentRead 一致）。
2. **reader 切片**（真实 zustand 组合）：会话建立 / 外部变化只标记 latest /
   阅读新版不改基线 / `readerCloseSession` 移除键（快照丢弃）/ 对不存在键 no-op /
   `readerClearAllSessions` 清空。
3. **会话集线器**：按 canonicalPath 定向分发（同路径两会话都收到、其他路径零分发）、
   注销幂等、全部注销后注册表清空。
4. **Esc 层级**：三层（modal > overlay > preview）逐层退出——一次 Esc 只关最上层；
   焦点归还在触发元素仍挂载时生效、已卸载时安全跳过；无层时不消费。
5. **锚点恢复纯核心**：锚点存活（原锚点+原段内偏移，不提示）/ 锚点消失回退最近存活
   前驱章节（提示）/ 无前驱取后继 / 无任何存活锚点按旧 scrollTop 截断 / 捕获时不在
   任何章节直接按 scrollTop 恢复。
6. **相对路径折算**：根内（反斜杠归一）/ 根外返回 null（降级信号）/ 空根。

## 3. 实现要点（与本片范围的对应）

- 主进程：`src/main/services/documents/change-bridge.ts`（watch 注册表 + settle +
  digest + 事件订阅）；IPC `document:watch` / `document:unwatch`（中央注册表登记，
  ipc-registry 冒烟双向断言）；事件 `document:changed` 经 `broadcastToWindows` 广播；
  watcher onFile 回调追加 `routeReaderDocumentChange`（不触发全项目重扫）。
- 渲染端：`reader/use-document-reader.ts` 为三入口唯一加载/错误/版本契约；
  `reader/document-session-hub.ts` 按 canonicalPath 分发到会话；会话状态全部经
  reading-session 纯函数（reader slice 只做登记）。
- 三入口：TaskWorkspace（主入口 full 形态）、TaskDetail DocPane（compact 形态 +
  「展开」入口）、ArtifactViewer（同 hook + ReaderVersionBar + DocumentDiffPanel，
  保留 JsonTree/JsonlView/固定/复制/源码视图专项渲染）。
- 收口：文档切换/卸载 `readerCloseSession` + `documentUnwatch`；项目切换/关闭
  `readerClearAllSessions`（主进程同步 `clearReaderDocuments()`）。
- Esc 聚合：`utils/esc-layer.ts` + App 顶层唯一 window 监听；Dialogs/CommandPalette/
  ArtifactViewer/TaskDetail/Tasks 全部迁移为层登记，消除叠罗汉。
- AI 保存 PRD 草稿后：面板自写内容经同一状态机（externalChange → readNewVersion）
  直接进入展示版，不另写一套状态。

## 4. 待人工走查清单（未执行，不视为通过）

以下需要真实窗口/真实文件变化，纯函数冒烟无法替代（design §6.3 / review/03 §7）：

1. [ ] **1280 / 1440 / 1920 三档截图**：1280 收起列表正文优先、1440 默认布局
   （观察栏默认收起已按 <1440 初始化）、1920 可三区；正文宽度偏好 680/760/880 三档实际效果。
2. [ ] **连续保存不重置阅读/选区**：外部编辑器（或 Agent）连续保存正在阅读的文档，
   正文与选中文本保持不动，只出现「发现新版本」提示；「查看变化」单列红绿边线呈现；
   「阅读新版」后定位到原章节（含锚点消失时的回退提示）。
3. [ ] **无 Git 降级文案**：在非 Git 目录的项目打开「与最近提交比较」，确认中性降级
   说明如实显示（git_no_repo 等），不显示为错误。
4. [ ] **快速预览展开/返回**：TaskDetail 预览「展开」进入完整工作区，Esc 返回预览抽屉
   且来源页面滚动位置恢复（AC1）。
5. [ ] **Esc 层级实测**：查看器 + 预览同开时 Esc 逐层退出；对比面板打开时 Esc 先关对比；
   焦点归还触发按钮（含已卸载场景静默跳过）。
6. [ ] **task.json 卡片 / 清单视图在三入口一致**：常见字段 + 未知字段 + 原文切换；
   jsonl 坏行真实行号；ArtifactViewer 中 jsonl 仍可切换回记录流卡片（源码视图）。
7. [ ] **项目外文件降级**：查看器打开项目外文件（如用户主目录待办），显示「普通读取打开，
   不提供版本比较」提示且可正常阅读。
8. [ ] **高缩放（Windows 150%/200%）**：单列正文、表格自身横向滚动、工具条不溢出。

## 5. 已知取舍与偏差登记

- **ArtifactViewer 专项渲染保留**（AC8 包裹/共存策略）：json 树、jsonl 记录流卡片、
  固定/预览标签、源码视图切换原样保留；装载/错误/版本契约统一改走 useDocumentReader。
  md / task.json / 上下文清单的图形视图切换为共享 ArtifactReader（隐藏其内置
  渲染/原文切换，避免与查看器头部按钮双开关）。
- **TaskDetail「放大」与「展开」并存**：「放大」保持原有 ArtifactViewer 固定标签行为
  （零回归），新增「展开」进入完整任务工作区（AC1 要求的入口）。
- **面板自写文档的版本提示**：AI 保存 PRD 草稿已走同状态机直接应用；其他面板写入
  （如 Spec 编辑器）不在本片范围。
- **CommandPalette Esc 行为微调**：原先仅焦点在面板输入框时 Esc 可关，现按层级登记后
  面板打开期间任意 Esc 先关面板（与 design §6.3「菜单/模态最上层」一致）。
- **变更信号仅覆盖 watcher 监看的 `.trellis` 树**：项目根内但 `.trellis` 之外的文件
  打开时无定向信号（documentRead 装载仍正常）；三入口实际阅读的文档均在 `.trellis` 下。

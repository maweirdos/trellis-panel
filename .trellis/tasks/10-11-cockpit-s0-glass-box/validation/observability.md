# G3 · 观测查询、投影与观测 UI 验证（observability）

日期：2026-10-12。对应 implement.md G3 第二片（观测 UI 与投影）。执行环境：本机 Windows 11，Node 24.12.0，esbuild 打包冒烟（与既有 smoke 约定一致）。

## 1. 实验口径（如实声明）

- **全部为本地实验/夹具验证**：观测事件由冒烟脚本按 shared/observability v1 契约构造（`scripts/smoke/observability-store.mjs` 的 `makeEvent` / `scripts/smoke/receipt-projection.mjs` 的 `mkItem`），经真实 worker 线程 + `node:sqlite` 落库后读回，或直接驱动纯投影函数。
- **真实 Hook 生产者不存在**：`blocked_external`——上游模板改造与发布未开始（G1-C，见 research/host-distribution.md §4）。因此「已输出至宿主通道」的端到端证据链当前只能到「Panel 侧存储/投影正确消费 v1 事件」，不能宣称真实 Codex 宿主回执已验证。AC3 的真实宿主部分保持未关闭。
- 渲染组件（ObservationPanel / EvidenceBadge / 健康治理交互）为 React DOM 契约，纯 node 冒烟不覆盖，列入 §5 人工走查。

## 2. ReceiptProjection（scripts/smoke/receipt-projection.mjs，22 项断言）

| 场景 | 断言 | 结果 |
| --- | --- | --- |
| assembled+emitted 配对 | level=emitted、paired=true、汇总取 emitted 口径（stdoutUtf8Bytes/outputDigest） | 通过 |
| 仅 emitted | 完整证据：assembled 丢失不使其消失（assembledAtMs=null 仍 emitted） | 通过 |
| 仅 assembled | level=assembled，emittedAtMs=null | 通过 |
| 两者皆无 | unobserved=true；措辞中性（L0） | 通过 |
| output_failed | 仅失败 → 输出失败事实；assembled+output_failed 并存仍按失败呈现 | 通过 |
| 清单不完整 | partial + omittedEntries 透出 manifestIncomplete | 通过 |
| 材料核对 | 前缀一致→same（16hex revision vs 64hex digest 可比前缀）；不一致→changed；当时无摘要或当前读不到→unverifiable（无法核对）；未提供核对表→not_checked | 通过 |
| 去重/排序 | 重复 eventId 去重（同 ID 取大 seq）；按 injectionId 分组、occurredAtMs 降序 | 通过 |
| 编码预算删减 | emitted 明细空时回退 assembled 明细；仅删减事件→明细空但遗漏数在汇总 | 通过 |
| 措辞红线 | 含「已输出至宿主通道」；不出现「已注入」「已遵守」；emitted 补充说明含「尚无宿主接收确认」；材料五态文案齐备 | 通过 |

## 3. ActivityProjection（同冒烟，10 项断言）

- 四列分列（task-record / files / timeline / archive），同 id 跨来源不合并为同一事实（`file:x` 与 `timeline:x` 两条独立条目）。
- 任务原始状态原值显示（自定义状态 `custom_review_x` 原样）；不生成阶段完成链/耗时；状态缺失如实「未知」。
- 任务视图过滤：未归属事件不进任务列（不借当前选中任务补全）；其他任务事件不串线；会话/项目视图保留未归属条目并标记。
- 归档位置从输入如实显示（活跃/归档目录，仓库相对路径）；列内时间倒序、上限 30 条（有界）。

## 4. 健康映射与服务链（observability-store 冒烟 E 系列 + receipt-projection 健康节）

- `observationHealthView`：active→ok；paused(collection_disabled/安装身份类)→中性；quota/physical→提示级；corrupted→错误；future_version→提示；not_initialized/closed→中性。未知 ≠ 故障：不标红（6 项断言通过）。
- 服务链（真实 worker 线程，E0–E6 通过）：正确身份重初始化 bound/active；**P3-c** 跨工作区 query/subscribe 拒绝 E_INVALID_ARG；**P3-d** redactText 剥离盘符/根路径形态；observationStatus 透出绑定 workspaceId；set-enabled 禁用→paused/collection_disabled（读取照常）→重启用→active；clearObservationEvents 换 epoch 且旧 cursor resetRequired、清空只作用观测库；订阅携带 pollMs 建立正常。
- 冒烟总数：observability-store 现 82 项（含新增 E 系列 14 项）；receipt-projection 40 项（全部通过，退出码 0）。

## 5. 未覆盖 / 待人工走查（如实）

1. **渲染走查**（需运行应用，纯 node 冒烟不可替代）：
   - Tasks 工作区右侧辅助栏：观察面板按需展开（<1440 默认收起）、回执卡（证据徽标/材料行/字节/截断/遗漏数/摘要核对文案）、历史折叠、活动四列、健康与治理折叠区。
   - AcpConsole 右侧 compact 形态复用同组件。
   - EvidenceBadge 三档视觉（L0 灰圈 / L1 灰描边 / L2 实心蓝；未知中性、故障红）需目检颜色与文字双通道。
   - 清理确认对话框文案（「清理观测 ≠ 归档任务」）与范围预览数字。
   - 回执更新不触发正文 reload / loading（定向失效纪律）需在真实面板目检。
2. **真实 Hook 生产者**：blocked_external（G1-C）。本片所有事件均为契约夹具。
3. **可见性降频的实际间隔**：pollMs 夹取逻辑在服务端实现并有 E6 建立性断言；1s/5s 的实际节拍与窗口隐藏切换的续订无丢增量，需人工在运行态观察（冒烟用 150ms 加速轮询验证过推送路径本身）。
4. Settings 页未加入口（按任务书「设置页或观测面板内」二选一，本片落在观测面板内）。

## 6. 结论

- 纯投影与服务链契约按上述口径通过；观测 UI 组件完成接线（Tasks 工作区 + AcpConsole），DOM 契约待人工走查。
- AC3/AC4 中依赖真实宿主/真实分布的部分维持 blocked_external；本地投影/存储/治理链路达到「实验验证」级别，不冒充真实回执已验证。

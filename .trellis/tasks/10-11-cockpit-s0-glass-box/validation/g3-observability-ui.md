# G3 第二片产出报告：观测 UI 与投影（g3-observability-ui）

日期：2026-10-12。执行代理：trellis-implement（GLM）。对应 implement.md G3 第二片范围。验证明细见同目录 [observability.md](observability.md)。

## 1. 文件清单

### 新增（1529 行，含冒烟与验证文档）

| 文件 | 行数 | 内容 |
| --- | --- | --- |
| `src/shared/observability/receipt.ts` | 248 | ReceiptProjection 纯函数（injectionId 分组、配对/仅 emitted/仅 assembled/output_failed、清单遗漏透出、材料 currency 四态、措辞与文案映射） |
| `src/shared/observability/activity.ts` | 138 | ActivityProjection 纯函数（四列分列、来源不合并、任务原值状态、归档位置、任务/会话两级过滤） |
| `src/renderer/src/observation/ObservationPanel.tsx` | 457 | 回执卡（材料清单/字节/截断/缺失/摘要核对）+ 历史折叠 + 活动四列 + 健康与治理（状态/开关/清理/磁盘占用） |
| `src/renderer/src/observation/EvidenceBadge.tsx` | 51 | L0 灰圈 / L1 灰描边 / L2 实心蓝 / 失败红；文字+图形双通道 |
| `src/renderer/src/observation/use-observation-scope.ts` | 246 | 订阅编排 hook：health 解析绑定 workspaceId、快照回补（最近 100 条）、可见 1s/后台 5s/卸载停读、reset 全量重拉、显式重试；useMaterialCurrency 有界材料核对 |
| `src/renderer/src/store/slices/observation.ts` | 95 | 观测切片：scope 级内存缓冲（eventId 去重、400 条上限、不进 localStorage）、健康状态、reset/清场 |
| `scripts/smoke/receipt-projection.mjs` | 240 | 新冒烟入口（40 项断言） |
| `validation/observability.md` | 54 | 本片验证报告（实验口径/结果/未覆盖） |

### 修改（+426/-37）

- `src/main/services/observability/service.ts`：P3-c 归属校验（query/subscribe）；P3-d redact（query/cleanup/clearAll/set-enabled catch）；`observationStatus()`/`clearObservationEvents()`；订阅 pollMs 夹取 [1000,5000]（env 覆盖优先，兼容既有冒烟）。
- `src/main/services/observability/store-core.ts`：`redactText` 导出（原私有）。
- `src/main/ipc/observability.ts` + `src/shared/ipc-channels.ts` + `src/preload/index.ts` + `src/shared/types.ts`：`observation:health` / `observation:set-enabled` / `observation:cleanup`（mode=retention|all）全链注册（ipc-registry 冒烟双向断言通过）。
- `src/shared/observability/store.ts`：ObservationBindingStatus/ObservationStatusResult 类型、pollMs 订阅选项、`observationHealthView`（未知≠故障映射）。
- `src/renderer/src/pages/Tasks.tsx`：任务工作区右侧辅助栏挂 ObservationPanel（taskRef=`task:<id>`/`dir:<repo-relative>`；文件变化来源=onMaterialUpdated 有界缓冲 30 条）。
- `src/renderer/src/pages/AcpConsole.tsx`：会话侧 compact 复用（工作区级 scope；时间线事件按 kind 归列 file/timeline，对话内容不进活动列；无项目时不挂载）。
- `src/renderer/src/store/slices/session.ts` + `store/index.ts` + `store/types.ts`：observation 切片登记（双登记 store/types.ts + index.ts）；项目切换/关闭清空 scope 与健康状态。
- `scripts/smoke/observability-store.mjs`：新增 E 系列 14 项（P3-c/P3-d/健康治理/清空/订阅 pollMs）；C 系 install 目录名固定为 TrellisPanel 以走生产默认解析。
- `research/host-distribution.md`：§5 G3 时点状态（仍 blocked_external，AC9 不关闭）；`research/known-issues.md`：P3-c/d 标记已偿还。

## 2. 冒烟与验证

- **typecheck**（node+web 两配置）：通过。**build**（electron-vite 三段）：通过，`out/main/observation-worker.js` 正常产出。
- **冒烟**：ipc-registry / render-contract / acp / observability-contract / observability-store / reader-wiring / reading-session / task-reader / **receipt-projection（新增）** 全部通过。
- 断言数：receipt-projection **40**；observability-store **82**（含新增 E 系列 14）。
- 既有环境失败（与本片无关，清洁树复现一致）：tpap 2 项（tool_search/db_list_tables，依赖工具目录环境）、chat.mjs（真实模型端点流式，known-issues 环境类登记项）。

## 3. P3 偿还说明（known-issues G3 一片 #3）

- **P3-c**：`queryObservations`/`subscribeObservations` 在 zod 校验后增加绑定归属校验——已绑定（workerBinding 非 null）且 `scope.workspaceId !== workerBinding.workspaceId` → `E_INVALID_ARG`；未绑定仍走「未初始化≠错误」哨兵空集。冒烟 E1。
- **P3-d**：store-core `redactText` 导出；query / cleanupObservationRetention / clearObservationEvents / setObservationCollectionEnabled 的 catch 文案统一 redact（剥盘符/根路径/控制字符）。冒烟 E2（redactText 行为）+ 代码路径审查；未构造出「SQLite 报错带绝对路径」的真实注入（如实登记，非伪装覆盖）。

## 4. 待人工走查清单（纯 node 冒烟不可替代）

1. Tasks 工作区右侧：观察面板随辅助栏按需展开（<1440 默认收起）；回执卡视觉（徽标三档、材料行、字节、截断/缺失/遗漏、摘要核对文案「与当前文件一致/不同/无法核对」）；历史折叠。
2. AcpConsole 右侧 compact 形态；工作区级回执的任务归属行。
3. 健康与治理：状态点颜色（未知中性）、停用/启用开关、磁盘占用数字、两个清理入口与「清理观测 ≠ 归档任务」确认文案及范围预览。
4. 回执增量到达只刷新面板区域，不触发正文 reload/loading（定向失效纪律）。
5. 窗口隐藏/恢复时订阅续订无丢增量、无重复条目（eventId 去重兜底）。
6. EvidenceBadge 颜色三档在高缩放下的可辨识度（文字+圆点双通道已有）。

## 5. 偏差与如实登记

- **「DocumentReader 观察位」的解释**：观察面板挂在 Tasks 工作区右侧辅助栏（design §6.3 的「正文＋观察」位）与 AcpConsole 会话侧，未在 DocumentReader 组件内部逐文档挂载——逐文档挂载会使同一任务多文档时重复订阅。组件经 props 复用，后续若要逐文档粒度可直接复用。
- **1280 档「观察/目录按需切换」**：现观察与目录同在右侧辅助栏（整体随 rightAsideOpen 切换，<1440 默认收起），未做观察/目录二选一的独立切换。列入走查项，不阻塞本片。
- **Settings 页未加入口**：任务书允许「设置页或观测面板内」二选一，本片落在观测面板内（未动 Settings.tsx，控制改动面）。
- **真实 Hook 生产者**：blocked_external（G1-C，host-distribution §4/§5）；本片全部事件为契约夹具，AC3 真实宿主部分与 AC9 保持未关闭。
- **首绑入口未做 UI**：未绑定时面板如实显示「未绑定（未观察到 ≠ 故障）」；首次显式绑定（enableObservation 创建文件）仍无 UI 入口——这是用户显式动作，留待 G1-C 能力握手一并设计，不在本片私加。
- 哨兵 `'store-unavailable'` 字面重复（P3 #5 登记项）本片未上移 shared——现状：service 侧用导出常量、store-core 内 2 处字面（均为既有代码，本片未新增）。

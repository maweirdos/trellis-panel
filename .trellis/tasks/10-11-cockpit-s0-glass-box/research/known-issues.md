# 已知问题与登记项（滚动更新）

## 环境类

- **chat.mjs 冒烟超时**（2026-10-11，G2 二片检查时发现）：`等待超时： 流式增量`，两次复现；依赖真实模型端点流式响应，与本任务改动无关（chat 域文件未动）。不在 implement.md §8 检查清单内。待单独排查（疑似端点/网络环境变化）。

## 登记不阻塞（P3，来源：G2 二片 trellis-check）

1. `git-baseline.ts:141`：项目根为 repo 子目录时判 no-repo（文案中性但不够准确）；`git show commit:path` 的 path 语义相对 repo 根。S0 只开 repo 根不触发；放开子目录/worktree 时（G3）必须重审。
2. `git-baseline.ts:120`：`validRepoRelative` 不拒 `:`，理论上 pathspec magic 可影响 not-in-commit/untracked 的分类（两者均为中性降级，无越界风险）。Windows 文件名天然无冒号。
3. asar 打包环境 diff-worker 加载未验证——G1-B 既有待办，不新增。
4. `readingSessions` 无条目上限：下一片页面接线时必须保证文档关闭调用 `readerCloseSession`（store 契约已写明）。
5. diff"最大编辑量可配置"（maxEditLength）未实现：2MiB/侧 + 1s 超时已覆盖失控场景；需要时再加。

## 登记不阻塞（P3，来源：G2 三片 trellis-check）

1. 焦点归还目前仅 diff 面板接线（diffTriggerRef）；viewer/dialog/palette/drawer 的 Esc 焦点归还未实现（旧代码同样没有，非回归）。design §6.3 完整覆盖留后续。
2. 复制语义不一致：TaskDetail 复制"展示版"，ArtifactViewer 复制走 readTextFile 读"磁盘最新"——displayed/latest 分离后可能复制到用户未见的新版。与 AC1 三入口一致性有张力，S0 内择机统一为"复制展示版"。
3. 同文档双入口（如预览+查看器）共用 sessionKey：一方卸载 closeSession 会清另一方 base/pending（displayed 有本地 rawText 兜底不空白）。边缘场景，G3 观测接线时一并考虑会话共享计数。
4. `change-bridge.ts:112-118`："读取完成→注册 watch"窗口内新建文件且 watcher add 先于注册处理的毫秒级补发缺口，需等下一次事件。

## 登记不阻塞（P3，来源：G3 一片 trellis-check）

1. **G1-C 前必须修**：database.md §7 Correct 示例只插 6 列，与落地 events 表非空列（repositoryId/workspaceId/receivedAtMs 等）不兼容——Python 生产者设计前先同步 spec 示例。
2. **G1-C 设计输入**：Python 侧若用 INSERT OR IGNORE 无法区分同 eventId 异 digest 冲突（Panel 侧是事务内 SELECT-then-INSERT，行为等价可区分）；stableStringify 的 digest 跨语言一致性（键排序/转义）必须用黄金夹具证明。
3. ~~第二片接线时补：observation query/subscribe 校验 scope.workspaceId 与当前绑定归属；queryObservations 的 catch 在 IPC 边界套 redact（防 fs/SQLite 原始 message 带绝对路径）~~ **已偿还（G3 二片，2026-10-12）**：service.ts query/subscribe 双入口校验绑定归属（E_INVALID_ARG）；query/cleanup/clearAll/set-enabled 的 catch 统一走 store-core 导出的 redactText。冒烟：observability-store E1/E2。
4. observability-store 冒烟实为 67 项（实施申报 70，数量不实内容无恙）；physical_limit 软保护路径与 query 的 before 游标参数无断言，可补。
5. 杂项：哨兵字符串 'store-unavailable' 在 service/store-core 三处字面重复（建议上移 shared）；sameRoot 非 Windows 平台为严格相等（符号链接差异会误报 rebind_required，Windows 首发可接受）；实施代理的报告未持久化到 validation/（流程改进：后续片报告落盘）。

## 已处置

- G2 二片 check 的 5 个 P3 中：`\r` 剥离、present 措辞"存在"、useMemo 常量三处已当场修复（随本片提交）；其余见上。
- G2 三片 check 的 P2（输入焦点时 Esc 误注销层）已修：`deferWhenInputFocused` 在派发前守卫；两处弱断言收紧、DocumentReader 死分支文案改为如实描述。
- G3 一片 check 的 P2（切到无绑定项目时旧订阅不取消）已修：initObservationForRoot 顶部先清场（generation++/清订阅/关旧连接）再走 not_bound 早退。

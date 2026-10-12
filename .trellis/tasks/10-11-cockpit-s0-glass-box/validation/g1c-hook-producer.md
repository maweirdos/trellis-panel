# G1-A/C · Hook 观测生产者（本地实验路径）验证报告

日期：2026-10-13。对应 implement.md G1-A（契约与真实输出）与 G1-C（分发路径验证·本地实验片）。design §3/§4.2/§8；PRD FR2/AC3。**本报告只证明本地实验副本的行为，不构成团队分发（AC9 维持 blocked_external，见 [../research/host-distribution.md](../research/host-distribution.md) §6）。**

环境：Windows 11 · Python 3.10.11（sqlite3 3.40.1）· Node v24.12.0（node:sqlite 3.50.4）· git HEAD 基线 7b6b7d3。

## 1. 交付物

| 文件 | 说明 |
| --- | --- |
| `.codex/hooks/observability_emit.py`（新增，782 行） | 独立 emitter 模块：身份校验、材料采集（透传包装）、ContextEventV1 构造、stableStringify 跨语言 digest、D-SQLITE 写库、64KiB 编码预算删减、`TRELLIS_RECEIPTS=off` 旁路与一次 stat 快速短路 |
| `.codex/hooks/inject-subagent-context.py`（修改，+77/−2 行） | 仅 import + 两个输出路径各三个时机点调用（见 §2） |
| `scripts/smoke/hook-emitter.mjs`（新增） | 字节一致性 + 故障矩阵冒烟（117 项断言） |
| `scripts/fixtures/observability/python-produced-{assembled,emitted}.json`（新增） | 真实 emitter 产出的 Python 黄金夹具（捕获方式：`node scripts/smoke/hook-emitter.mjs --dump-fixtures scripts/fixtures/observability`） |
| `scripts/smoke/observability-contract.mjs`（扩展） | +11 项跨语言 digest 断言（共 25 项） |
| `.trellis/spec/backend/database.md` | P3-a 偿还：Correct 示例修正（见 §6） |

## 2. inject-subagent-context.py 精确改动（行级）

对活体副本的全部改动为**一处 import 块 + 两个输出点各三段调用**，`print(json.dumps(output, ensure_ascii=False))` 语句本身逐字符保留（仅被 try 包裹）：

1. **import 块（原 1089 行后，新 1124-1131 行，`def main():` 之前）**：`try: import observability_emit as _observability_emit / except Exception: _observability_emit = None`。import 失败（如文件被单独拷走）时一切调用点退化为 no-op。
2. **SubagentStart 输出点（`_handle_codex_subagent_start` 内，原 971 行 `print(...)` 处，新 971-1006 行）**：
   - `note_assembled(repo_root, task_dir, subagent_type, context, output, parent_session_id, "codex")`（组装完成，try/except pass）
   - `print(...)` 包 try：异常 → `note_output_failed("write", exc)` 后**原样 `raise`**（与原版传播语义一致，main 的既有 except 捕获 → exit 0）
   - 新增 `sys.stdout.flush()` 包 try：失败 → `note_output_failed("flush", exc)` 后**吞掉**（原版无显式 flush、失败延迟到解释器关闭且同样不改退出码；缓冲区内容未变，关闭期行为与原版相同）→ 成功才 `note_emitted(output)`
3. **PreToolUse 输出点（`main()` 末尾，原 1211 行 `print(...)` 处，新 1253-1286 行）**：同构三段；`note_assembled` 传 `_string_value(input_data.get("session_id")) or None` 与 `_detect_platform(input_data) or "unknown"`。

为什么是"每路径三处"而不是全局"各一处"：文件存在两个独立 print 点（SubagentStart handler 与 main），认证组合要求两条路径都能配对（AC3），故 import 1 + 调用 6 处是覆盖两个输出路径的最小集合。

## 3. 字节一致性证明（stdout 与 git HEAD 逐字节一致）

方法：`git show HEAD:.codex/hooks/inject-subagent-context.py` 落盘为基线副本，与改造副本在**同一 sandbox 仓库、同一 stdin 夹具、同一 env**下各自运行，`sha256(stdout)` 对比（冒烟每组都打印哈希值）：

| 夹具 | head sha256 = mod sha256 | 字节 |
| --- | --- | --- |
| SubagentStart（codex） | `6c80747542927316837acf4acd986d84e9ad2fc0a3bf23ca4777797dd16dca37` | 7701 |
| PreToolUse（Task/claude 格式） | `106e6547ffaa9b988e659a64db429d9658835d9de2c29af9596384a117874c10` | 24478 |
| 其余 12 组（旁路/故障矩阵） | 全部一致 | — |

同时断言：退出码一致、快乐路径 stderr 与 HEAD 完全一致（观测零额外输出）。注意 stdout 以 CRLF 结尾（Python 文本模式 `print` 的换行翻译），`stdoutUtf8Bytes` 按实际写出宽度计（`len(json)+len(os.linesep)`）。

## 4. 故障矩阵结果（scripts/smoke/hook-emitter.mjs，117 项全绿）

| 类别 | 用例 | 结果 |
| --- | --- | --- |
| 正常路径 | SubagentStart / PreToolUse：stdout 逐字节一致；assembled+emitted 成对、共用 injectionId、seq/时间有序；scope/taskRef/trellisTaskId/taskPath/session.parentId/producer 正确；usage 同事务 +2 | ✓ |
| 旁路 | binding.json 缺失（一次 stat 短路，零写入零观测 stderr）、`TRELLIS_RECEIPTS=off`、`collectionEnabled=false`、installationId 不符、canonical root 不符、installation.json 缺失（不建安装文件） | ✓ 全部不采集且 stdout 不变 |
| 存储故障 | 库只读属性、库损坏（垃圾字节，**原文件字节保持不变**）、`<db>-journal` 路径被目录占据（模拟 runtime 目录不可写）、库文件缺失（Hook 不建库） | ✓ stderr ≤1 行（每进程限一次）、不含绝对路径、stdout/退出码不变 |
| 输出故障 | stdout 管道被父端提前关闭（大上下文）：15s 内退出、**无 emitted**、有 `output_failed`（诊断码 stdout_write/flush_failed） | ✓ |
| 输出故障 | 序列化异常注入（`TRELLIS_OBS_TEST_FAIL=serialize`：emitter 在 arm 时改写 `json.dumps` 抛错；emitter 自身序列化用模块加载时捕获的 `_json_dumps` 私有引用，不受注入影响——这是注入机制的说明）：stdout 空、无 emitted、assembled 已落、`output_failed(serialization_failed)` 落库、codex 路径退出码 0（原失败语义被既有 except 捕获） | ✓ |
| 跨语言 | 每条落库事件 `payloadDigest` 与 TS `stableStringify` 重算一致；`sourceDigest` 与源文件 Node crypto SHA-256 一致（hashlib==crypto 实文件核对） | ✓ |

材料结果在真实组装中覆盖：included / truncated（源 3528B → 纳入 2999B，notice 不计入纳入片段）/ index_only（binary，纳入字节为 null 非 0）/ missing（not_found，源字节 null）/ 目录展开（extra/a.md、extra/b.md 以相对路径登记）/ 缺失 artifact（implement.md）。`expectedEntries=null`（目录展开使精确预期不可得，按契约不计算缺失率）；`budgetBytes=131072` 来自 config.yaml。

## 5. 跨语言 digest 证明（known-issues P3-b 偿还）

- Python `stable_stringify`：递归键排序按 **UTF-16 码元序**（`key.encode('utf-16-be','surrogatepass')` 排序，等价 JS `Array.prototype.sort` 默认序）、`ensure_ascii=False`、紧凑分隔符、整数十进制——与 store-core `stableStringify` 口径对齐。
- 证明路径 1（落库行）：hook-emitter 冒烟对每条 Python 写入行断言 `payloadDigest === sha256(stableStringify(事件))`（TS 侧重算）。
- 证明路径 2（黄金夹具）：`python-produced-*.json` 由真实 emitter 运行捕获（`TRELLIS_OBS_DUMP_DIR`），`observability-contract.mjs` 断言：两事件通过 `parseContextEvent`、`payloadDigest` 与 TS 重算一致、共用 injectionId、`outputDigest === sha256(contextText)`（TS 侧对 emitter 捕获的实际上下文字段重算）。

## 6. spec 示例修正（known-issues P3-a 偿还）

`.trellis/spec/backend/database.md` §7：原 Correct 示例只插 6 列，与 store-core `OBS_SCHEMA_V1` 的 events 表不兼容（`repositoryId/workspaceId/receivedAtMs/payloadBytes/payload` 均 NOT NULL）。已改为：全 11 列 INSERT + 事件与 `store_usage` 同事务 UPDATE + 事务内 SELECT 先判重复（注明不用 `INSERT OR IGNORE` 的原因：无法区分同 eventId 同 digest 幂等与异 digest 冲突）+ `store_usage` 缺行时放弃。Wrong 示例同步标注"只插 6 列"为反例。§6 Tests Required 登记 hook-emitter 冒烟。G1-B 的 `g1b_write.py` 探针历史脚本保留原样（当时是针对探针自建表验证锁语义，属研究证据不改写）。

## 7. 检查命令结果

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck`（node+web） | 通过 |
| `node scripts/smoke/hook-emitter.mjs` | 117 项全绿 |
| `node scripts/smoke/observability-contract.mjs` | 25 项全绿（14 既有 + 11 新增） |
| 既有冒烟：ipc-registry / render-contract / acp / acp-mock-agent / proxy / reader-wiring / reading-session / receipt-projection / task-reader / observability-store / jira-local-task / mock-electron | 全部通过 |
| `chat.mjs` | 超时失败——**既有已登记问题**（known-issues.md 环境类：真实模型端点流式响应），与本片无关（chat 域文件未动） |
| `tpap.mjs` | 2 项失败——**既有环境问题**：经 `git stash` 在干净工作树复现相同失败（外部 db 工具未注册），非本片回归 |

## 8. 未覆盖项（如实登记）

1. **真实 Codex 会话端到端**：本片全部证据来自直接调用 hook 脚本的 sandbox（不碰活体会话）。真实宿主（Codex 原生 SubagentStart）下发 stdin、会话生命周期与面板轮询的闭环**待用户走查**：当前仓库无 `.trellis/.panel/runtime/binding.json`，活体 hook 处于快速短路态（零额外开销、零写入）；用户在 Panel 完成绑定后下一次子代理派发即产生真实回执。
2. 上游模板改动/PR/发版（AC9）、`trellis update` 升级冲突实测（改动会被识别为用户修改并留 `.new` sidecar——已在 host-distribution.md §6 提醒用户）。
3. `inject-workflow-state.py` 后置不改（本片未触碰）；真实 Hook 并发锁竞争实测沿用 G1-B 探针结论（5ms 预算耗尽即失败，本片 emitter 同约定）。
4. 性能采样（p95 ≤50ms 目标）属 G4 正式预算；本片仅保证旁路路径为 1-2 次 stat。
5. 目录只读以"`<db>-journal` 被目录占据"模拟（Windows 目录只读属性不阻止子文件写入）；真实 ACL 拒写未测。

## 9. 实现期间发现并修复的问题

- `note_assembled` 首版有一处 `trellus_task_id` 绑定拼写错误（`trellus`），被冒烟的"零事件落库"断言暴露，已修复——验证了"事件必须真实落库"类断言的价值。
- Windows 8.3 短路径（`MAWEIR~1`）vs Python `Path.resolve()` 长路径会导致假性 root_mismatch：冒烟 sandbox 的 binding.canonicalRoot 用 `realpathSync.native` 取最终形态。真实 Panel 绑定（identity.ts `realpathSync`）与 Python 侧的同型问题已由 `sameRoot` 的盘符大小写归一覆盖，但**短/长路径形态差异**在 Panel 侧 `sameRoot` 中同样存在（登记：若真实绑定遇到 8.3 路径需复核，G3 known-issues 第 5 条同域）。

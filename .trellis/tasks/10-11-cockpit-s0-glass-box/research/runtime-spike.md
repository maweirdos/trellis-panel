# G1 · 运行时探针报告（runtime-spike）

日期：2026-10-11。对应 implement.md G1-A（契约）与 G1-B（存储）的首轮验证。**全部为开发机验证，未覆盖打包环境。**

## 1. 契约（G1-A 首片）✓

- 落地：`src/shared/observability/schema.ts`（zod v1：ContextEventV1 / MaterialResult / parseContextEvent；Unix 毫秒；完整 SHA-256 口径；未知字段 passthrough；主版本不认识 → unsupported_schema_version）。
- 夹具：`scripts/fixtures/observability/`（assembled-ok / emitted-ok / bad-schema-version / bad-digest），设计为 Python 侧复用的黄金样例。
- 冒烟：`scripts/smoke/observability-contract.mjs` —— 14 项断言全绿，含五类材料结果、null≠0 字节口径、injectionId 配对、unresolved 合法性、output_failed 诊断码。
- typecheck：新增代码后 node+web 全绿。

## 2. 存储（G1-B 开发机探针）✓

脚本：`research/spike/g1b-cross-process.mjs`（可重跑）+ `g1b_crash.py` / `g1b_write.py`。12 项断言全绿，验证 design §4 的五个承诺：

| 承诺 | 结果 |
| --- | --- |
| Panel 是唯一建库/迁移方；Python `mode=rw` 不建库 | ✓ |
| commit 前硬杀（os._exit）无脏行；journal 残留可恢复 | ✓ |
| Python 写入对 Node 立即可见（跨进程读一致） | ✓ |
| 锁预算 5ms 耗尽即失败退出（不循环重试、无幽灵行） | ✓ |
| eventId 同 digest 幂等 / 异 digest 被拒且可诊断；seq 单调不复用 | ✓ |

环境：系统 Node v24.12.0（node:sqlite 3.50.4）× Python 3.10.11（sqlite3 3.40.1），journal=DELETE、synchronous=FULL。

## 3. 结论

SQLite 双生产者方案在开发机语义成立，**继续采用**；不切换到不可变事件文件备选。

## 4. 未覆盖（后续验证登记）

- [x] **打包（dist:dir）验证已完成（G1-B，2026-10-12）**：随包 Electron 44.4.3（Node 24.21.0 / sqlite 3.53.4）内 node:sqlite 可用；`app.asar.unpacked/out/main/observation-worker.js` 经 worker_threads 真实加载并跑通 init/insert/query/health 全协议（探针 `g1b-packaged-probe.mjs`，5/5 通过）。修复随验证落地：asarUnpack `out/main/*-worker.js` + `services/worker-path.ts` asar 路径重写（worker_threads 不能从 asar 内加载）+ 排除散落的 `out/worker-only`。
- [ ] 真实宿主 stdout 序列化/write/flush 边界 + BrokenPipe/序列化错误注入（G1-A 剩余项，需 Hook 改造后进行）。
- [ ] 真实 Hook 并发与开销采样（≥200 次 on/off，G4 定稿）。
- [ ] 迁移备份/库损坏/容量与保留策略实现后的故障矩阵（G3 一片冒烟已覆盖 82 项，Electron 进程内长跑待走查）。

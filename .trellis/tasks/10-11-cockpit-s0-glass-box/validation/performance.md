# 观测开销性能报告（performance）

日期：2026-10-12。**口径：直接调用 hook 脚本的 sandbox 配对采样（on/off 交错、差值消漂移），每档 200 对 + 预热 10 对丢弃；不是真实 Codex 宿主端到端**（后者待用户走查，见 validation/reader.md）。

环境：Python 3.10.11 / Node v24.12.0 / Windows；材料构成（spec×3 含截断与二进制、任务产物 prd/design、implement.md 缺失）见 research/spike/perf-sample.mjs。

| 档位 | 关（off） | 开（on） | 观测开销 Δ=on−off |
| --- | --- | --- | --- |
| 正常材料 | p50=62.6ms p95=67.1ms p99=71.7ms max=75.3ms | p50=62.9ms p95=68.2ms p99=72.5ms max=526.8ms | p50=0.4ms p95=5.0ms p99=9.9ms max=462.8ms |
| 大材料 | p50=62.8ms p95=71.0ms p99=80.8ms max=90.6ms | p50=63.4ms p95=73.0ms p99=85.9ms max=108.5ms | p50=0.1ms p95=6.7ms p99=17.5ms max=35.2ms |

结论要点（2026-10-12 人工 finalize）：

- **设计试验预算（p95≤50ms / p99≤150ms）达成**：正常材料 Δp95=5.0ms / Δp99=9.9ms；大材料 Δp95=6.7ms / Δp99=17.5ms——两档均有一个数量级的余量。
- **孤离最大值说明**：正常档 Δmax=462.8ms 为 400 组配对中的单次离群（对应 on 模式 max=526.8ms；大材料档无此现象，max=35.2ms）。怀疑为首次 SQLite journal 创建或杀软扫描的一次性开销；p99 已排除该离群。若真实环境复现持续离群，按 implement.md 预警规则处理（先诊断原因，两周内给结论）。
- on 模式每次注入产生 assembled+emitted 两条事件（含 sha256 摘要与 SQLite 短事务）；off 模式只余快速短路路径。
- **未覆盖（如实）**：真实宿主调用形态（Codex 进程内执行差异）、长会话累计写入、并发子代理锁竞争、打包版运行时。这些待 AC3 真实走查与 G5 试点补充。

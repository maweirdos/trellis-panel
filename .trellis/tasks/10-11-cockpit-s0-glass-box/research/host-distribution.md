# G0 · Hook 分发路径调查（host-distribution）

日期：2026-10-11。对应 implement.md G0 第 4 项与 G1-C 前置。只读调查，未修改任何 Hook。

## 1. 上游真实源（已核实）

| 项 | 值 | 证据 |
| --- | --- | --- |
| 上游仓库 | `github.com/mindfold-ai/trellis` | `npm view @mindfoldhq/trellis repository.url` |
| 发布形态 | npm 包 `@mindfoldhq/trellis` 与 `@mindfoldhq/trellis-core`，同版本同 git tag | trellis-meta SKILL.md:20 |
| 本地版本 | 0.6.17（`.trellis/.version`），等于 dist-tags.latest | `trellis --version` 与 npm view 一致 |
| CLI 安装位置 | 全局安装，不在本项目 node_modules | `npm ls trellis` 为空 |
| 模板源头 | 上游 `packages/cli/src/templates/`（含平台目录与 `common/bundled-skills/`） | trellis-meta SKILL.md:73 |

## 2. 本项目 Hook 的身份

`.codex/hooks/*.py` 是 `trellis init` / `trellis update` 写入的**生成副本**，由 `.trellis/.template-hashes.json`（v2 格式）登记内容哈希。`trellis update` 按三态处理：未改→自动更新；已改→识别为用户修改（`.new` sidecar，不覆盖）；不再是模板→按迁移规则处理。

推论：直接改 `.codex/hooks/` 副本可以被本地验证（会被 update 视为用户修改），但**不构成团队分发**——其他员工的仓库不会获得改动，且随版本演进会与本地面板产生漂移。与 design §8/R06 一致。

## 3. 修改 Hook 的正确路径（G1-C 计划）

1. 在上游 `packages/cli/src/templates/` 对应平台模板中实现观测落账（emit assembled/emitted 片段）。
2. 通过 PR / 发版进入 `@mindfoldhq/trellis` 正式版本。
3. 员工项目执行 `trellis update` 获得更新；面板按能力握手探测实际版本启用。

## 4. 待验证（G1-C / blocked_external 风险登记）

- [ ] 上游模板中 codex 平台 Hook 的**确切文件路径**（`packages/cli/src/templates/` 下的目录名未逐一核实）。
- [ ] 上游对 PR 的接受度与发布节奏（未接触）。
- [ ] 干净项目与带用户修改项目的 `trellis update` 升级试验。
- [ ] 面板侧能力握手（协议版本/producer 版本探测）。

**风险**：若上游发布条件不可得，AC9 无法关闭；按 implement.md 规则，G2（阅读）不受阻塞照常推进，回执仅作实验性验证。

# G0 · 开工基线报告（g0-baseline）

日期：2026-10-11。对应 implement.md G0 全部条目。本报告只记录事实与登记待验证项，不构成任何验收通过声明。

## 1. 任务激活

- `task.py start 10-11-cockpit-s0-glass-box`：planning → in_progress，分支记录 `codex/trellis-team-refactor`，会话 `claude_sess_6bd1c5e7-387f-425f-be68-f3a1f4aa9424`。
- 决策记录：用户 2026-10-11 批准开始实施，同时认可场景三取舍（S0 不做六阶段进度条，交付"记录状态 + 可信活动 + 归档位置"三分显示；进度条待显式阶段事件，S1+）。
- 工作区既有改动（不回退）：`docs/proposals/` 三套方案目录（未跟踪）、`nul`（未跟踪）、`.trellis/tasks/10-11-*`（本任务）、`package.json` / `package-lock.json`（本次新增依赖）。

## 2. 基线验证（全部通过，exit 0）

| 检查 | 结果 | 备注 |
| --- | --- | --- |
| `npm run typecheck`（node+web） | ✓ | 无错误 |
| `npm run build` | ✓ | electron-vite，约 1s |
| `node scripts/smoke/ipc-registry.mjs` | ✓ | 既有现象：因 package.json 无 `"type":"module"` 产生 ESM 重解析警告，非本次引入 |
| `node scripts/smoke/render-contract.mjs` | ✓ | 同上 |
| `node scripts/smoke/acp.mjs` | ✓ | ACP 服务冒烟全部通过 |

## 3. 版本矩阵

| 运行时 | 版本 | SQLite | 来源 |
| --- | --- | --- | --- |
| Electron（安装版） | 44.4.3 | 内嵌 node 24.21.0 / sqlite 3.53.4（内存探测可用） | approval.json 探针 |
| 系统 Node | v24.12.0 | node:sqlite 3.50.4（ExperimentalWarning 确认） | 本次实测 |
| Python | 3.10.11 | sqlite3 3.40.1 | 本次实测 |
| React / TypeScript | 18.3.1 / 5.9.3 | — | node_modules |

**三套 SQLite 版本差（3.40.1–3.53.4）**：本任务只用 UNIQUE 约束、事务、参数绑定等基础特性，三版本均支持；不使用 3.40 之后的新特性。打包环境（asar + worker 文件布局）的 node:sqlite 行为是 G1-B 核心风险，`npm run dist:dir` 尚未执行。

## 4. 依赖

- **既有 peer 冲突（登记 D-PEER-VITE，非本次引入）**：`electron-vite@5.0.0` 声明 peer `vite ^5||^6||^7`，项目已装 `vite@8.3.0`；既有 lockfile 即按此状态解析。新增依赖须 `--legacy-peer-deps`（与既有安装方式一致）。不在本任务修此冲突。
- **新增**：`zod ^4.6.5`、`diff ^9.0.0`（自带类型 `libcjs/index.d.ts`，无需 @types/diff）。安装后 typecheck/build 复验通过。
- **暂缓**：`react-resizable-panels`（design §6.3：仅在确需重做分栏时验证兼容版本，S0 不引入）。

## 5. D-SQLITE 差异登记（对 backend/database.md）

现有规范的 Drizzle + better-sqlite3 + WAL 指导与实际依赖不符（package.json 无这些包）。本任务按 design §1 采用：内置 `node:sqlite`（Electron worker）+ Python 标准库 `sqlite3`、参数化 SQL、`journal_mode=DELETE` + `synchronous=FULL`、双库分离（observations / control）。继承规范中的事务/迁移/约束原则。选型经 G1-B 验证通过后，再同步修订规范适用范围。

## 6. 首发认证组合

Codex 宿主 × SubagentStart 入口 × `inject-subagent-context.py`（trellis 0.6.17 生成副本）。`inject-workflow-state.py` 后置（输出契约与预算不同）。其他宿主（zcode 等）标未认证。上游模板确切路径见 [host-distribution.md](host-distribution.md) 待验证项。

## 7. 待验证项登记（责任/时点）

| 项 | 状态 | 责任 | 时点 |
| --- | --- | --- | --- |
| 上游模板路径与发布条件 | 未接触上游 | 建造者（PR） | G1-C |
| node:sqlite 打包/跨进程/故障矩阵 | 未测 | 建造者 | G1-B |
| 公司 Jira 类型/版本/权限/分页端点 | 未验证 | 用户（提供环境） | G4 前 |
| 试点人选（2 开发 + 1 协作者）与维护耗时记录方式 | 未定（08 决策第 2/4 项） | 用户 | G5 前，不阻塞 G1/G2 |
| 飞书 Tier 2 spike 责任人 | 未定 | 用户 | S2 前，与本任务无涉 |

## 8. G0 通过自评

implement.md G0 通过条件：上下文入口无遗漏（implement.jsonl 14 条 / check.jsonl 11 条，`task.py validate` 通过）；技术未知均有对应验证步骤（G1-A/B/C）；上游与公司条件未写成已获得（本报告第 7 节）。**G0 关闭，进入 G1。**

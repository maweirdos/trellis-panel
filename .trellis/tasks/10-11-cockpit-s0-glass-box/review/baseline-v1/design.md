# 设计 · 驾驶舱 S0：玻璃盒

对应 PRD：本任务 `prd.md`。设计深度：S0 全量；S1–S3 骨架见第 8 节（到点再细化，防复杂度通胀）。

---

## 1. UI/UX 设计

### 1.1 信息架构：不动骨架，深化内容

S0 **不重组导航、不新增顶级页面**。现有导航（Tasks/TaskDetail、AcpConsole、Jira、Spec、Knowledge…）保持不变，全部 S0 价值落在 **TaskDetail 页的深化** 上。理由：导航重组属于"加法"，会稀释 S0 验收焦点（三问）；且 TaskDetail 已是任务上下文的自然入口。

```
TaskDetail（S0 改造后）
├── 顶部：阶段管道（新）＋任务标题/状态/分支（现有）
├── 左栏：文档目录（现有 Tasks 列表保留，此处为任务内文件树）
├── 中栏：阅读区（深化：宽度/专注/差异/jsonl 时间线）
└── 右栏：观测面板（新：注入回执卡＋最近阶段事件）
```

### 1.2 阅读中枢（FR1）

**布局与排版**

- 三级阅读宽度切换：紧凑 680 / 标准 760 / 宽松 880 px，默认标准；持久化到本地设置。
- 专注模式：隐藏左右栏、居中阅读、目录收缩为悬浮大纲；`Esc` 退出。解决"AI 编辑器右侧 md 阅读器看着不舒服"的原始痛点（P01）。
- 文档内目录：从 markdown 标题自动生成，滚动高亮当前节。

**差异视图（版本对比）**

- 来源：git 历史（`git log --follow -- <doc>` + `git show`），无 git 历史时降级为"仅当前版本"并注明。
- 呈现：左右分栏 diff（复用现有 diff 能力/DiffModal 模式），按段落对齐；新增"与上一版"快捷入口。
- 原则：差异视图是只读观察，不提供编辑（编辑仍在编辑器完成）。

**task.json 结构化卡片**

- 卡片化字段：status、phase（若存在）、priority、branch/base_branch、parent/subtasks、assignee、createdAt/completedAt。
- 未知字段：归入"其他字段"折叠区，键值原样展示——**未知字段不隐藏、不猜测语义**。
- 原始 JSON：始终保留"查看原始 JSON"入口（复用 JsonTree）；结构化视图与原值可互切（AC1"原值不丢"）。

**implement.jsonl / check.jsonl 时间线**

- 每行 JSON 渲染为时间轴卡片：时间、类型徽章、摘要行（reason/file 字段截断展示）。
- 按类型筛选；点击卡片展开完整 JSON（JsonTree）。
- 坏行处理：解析失败的行显示"无法解析（第 N 行）"占位卡，不阻断整个时间线（AC2）。

**更新不抢焦点**

- watcher 触发文档刷新时：保持滚动位置（记录 scrollTop 恢复）；顶部出现非模态提示"文档已更新 · 查看"，点击才滚到变更处。
- 用户正在选中文本/滚动中（近 2s 内有交互）时延迟自动刷新。

### 1.3 注入回执卡（FR2）

**位置**：TaskDetail 右栏观测面板置顶；AcpConsole 会话侧边同步展示（同组件）。

**卡片结构**

```
┌ 上下文回执 · 本次会话 ──────────────── [证据等级: 已交付至宿主] ┐
│ 规范/上下文清单                          字节     截断          │
│ ● spec/frontend/components.md   a1b2c3d4  12.4K   —           │
│ ● spec/backend/api-patterns.md  e5f6a7b8   8.1K    已裁剪↑40%  │
│ ● workflow/phase-2.md           ...        ...     ...        │
│ 汇总：6 条 · 总计 41.2K / 预算 60K · 裁剪 2 · 缺失 0            │
│ 目标：task 10-11-cockpit-s0 · 会话 #a3f · 2026-10-11 16:02     │
└──────────────────────────────────────────────────────────────┘
```

- 缺失行（预算内未注入的预期文件）：灰显"未出现在本次清单"。
- 仪器故障：整卡变灰，标题改"回执缺失（仪器故障）"，附最后成功回执时间与诊断入口（AC4）。

### 1.4 证据等级视觉词汇（全局统一，contracts 层定义）

| 等级 | 含义 | 视觉 | 措辞上限 |
| --- | --- | --- | --- |
| L0 无证据 | 未观察到任何事件 | 空心灰圈 | "未知/未观察到" |
| L1 已组装 | hook 完成上下文组装 | 灰色描边圆 | "已组装" |
| L2 已交付至宿主 | 已写入宿主注入通道（additionalContext/updatedInput） | 实心蓝 | "已交付至宿主" |
| L3 宿主确认 | 宿主协议回执确认（S0 不做，预留） | 实心绿 | "宿主已确认接收" |
| L4 检查关联 | 检查结果对照（S1 检查页，不在本卡） | — | — |

规则：**禁止红色表示未知**（未知≠错误，收敛结论）；红色仅用于仪器故障与数据损坏。S0 只实现 L0–L2。

### 1.5 阶段管道（FR3）

- 位置：TaskDetail 顶部，横向管道：`未开始 → 规划 → 实施 → 检查 → 完成 → 归档`。
- 数据源：task.json `status` 字段为主；阶段推进时间取事件日志中该任务最近一次状态事件。
- 当前阶段高亮 + 停留时长；已过阶段可点击，跳转对应 jsonl 时间线锚点。
- 项目自定义状态：原值直接显示（不映射、不改写——A08 原则），映射表留 S1。

### 1.6 轻任务入口（FR4 的 UI 部分）

- Jira 页"我的工单"行内新增"本地起任务"按钮：弹 IntakeModal（复用现有）→ 选仓库 → `task.py create --no-start` 轻量任务（PRD-only）→ 回填关联。S0 不做自动状态回写编排，归档回写走现有 Jira 流转手动触发。

### 1.7 视觉语言

- 沿用现有浅色工作台 + 蓝绿强调；不引入新组件库（lucide-react 图标 + 现有 badges/CapsuleView 风格）。
- 新增唯一全局语义：上述证据等级色板，组件层面落在 `badges.tsx` 旁新增 `EvidenceBadge`。

---

## 2. 后端 / 本地架构

### 2.1 模块边界（S0 不做 monorepo 拆分）

`src/main/services/` 新增三个模块，窄接口、可独立测试：

```
services/
├── taskgraph.ts     任务身份解析：path → {projectId, taskId}；血缘读取
├── receipts.ts      回执领域：读取/聚合 .panel 日志 → 前端视图模型
└── eventlog.ts      逻辑日志出口：片段回收、按日合并、查询游标
```

- `taskgraph.ts` 吸收现散落在 acp.ts/watcher 回调里的路径正则（`taskMatch` 逻辑），统一 `resolveTaskId(path)`；`emitTrellisTimeline` 的 `spec-updated` 等无任务事件标 projectId-only，不再混入任务轨道（AC5 串线修复）。
- 参考既有 `access/event-log.ts` 的追加/游标模式，但独立实现（access 面向环回 API，本模块面向面板内部）。

### 2.2 `.panel` 命名空间

```
<repo>/.trellis/.panel/
├── events/
│   ├── pending/          # hook 片段（原子小文件，收集后删除）
│   │   └── <uuid>.json
│   └── log-2026-10-11.jsonl   # 按日合并日志（追加式）
└── cache/                # 回执内存索引落盘（可选）
```

- 整个 `.panel/` 加入 `.trellis` 既有的忽略规则（不进 git；归档打包时排除——T7"共享与归档分离"）。
- 放 `.trellis/` 下的理由：S1 的 approvals.jsonl 需要"任务内可携带"（T4 批准记录），命名空间先立好。

### 2.3 hook 落账管道（核心新增）

```
inject-subagent-context.py / inject-workflow-state.py
  ├─ 组装完成 → 写片段 events/pending/<uuid>.json   (kind: context.assembled)
  └─ 写入 hookSpecificOutput 前 → 写片段             (kind: context.delivered)
        ↓ 片段 = 单次原子写小文件（<2KB，写耗时可忽略）
eventlog.ts 收集器（主进程）
  ├─ 周期扫描 pending（2s）+ 应用退出前 flush
  ├─ 按序合并追加到当日 JSONL → 删除片段
  └─ 启动时回收残留片段（崩溃恢复）
```

**设计约束（收敛结论的落地）**

- hook 内**不做**：网络、重型扫描、锁等待；片段写失败仅 stderr 一行警告，**绝不影响 hook 返回**（遥测失败 ≠ 上下文交付失败）。
- 多生产者不直写同一文件：hook 之间只通过 pending 目录的独立文件通信（A3 有界记录）。
- `context.assembled` 与 `context.delivered` 分开记：后者仅在写 `additionalContext`/`updatedInput` 的同一代码点前触发，作为 L2 证据。
- 截断信息来自 hook 既有的每文件/产物/总字节上限变量，随事件透出，不二次扫描。

### 2.4 事件 schema（zod，主进程与渲染端共享类型）

```ts
// shared/receipts.ts（新增，contracts 雏形）
ReceiptEvent = {
  eventId: uuid
  kind: 'context.assembled' | 'context.delivered'
  occurredAt: ISO8601
  projectId, taskId?, taskDir?      // taskgraph 解析；解析失败记 path
  sessionId?, subagentType?
  host: 'codex' | 'zcode' | ...     // hook 自报
  files: Array<{ path, hash8, bytes, truncated?: ratio }>
  totals: { bytes, budgetBytes, droppedCount }
}
```

- zod 为 S0 唯一新增依赖；schema 同时用于：片段校验（丢弃畸形片段并计数）、IPC 边界类型、渲染端视图模型推导。
- 版本字段 `v: 1` 预留；schema 演进只增不删（向前兼容旧日志）。

### 2.5 IPC 与渲染端

```
ipc: receipts:get(taskId, {limit}) → ReceiptSummary[]     // 聚合视图模型
ipc: receipts:subscribe(taskId) → 增量推送（watcher 监听 .panel 日志）
ipc: taskgraph:phases(taskId) → 阶段管道视图模型
```

- 渲染端 store：zustand 现有模式；新增 `receiptsSlice`、`phaseSlice`（遵循 `store-conventions.md`）。
- 组件：`EvidenceBadge`、`ReceiptCard`、`PhasePipeline`、`JsonlTimeline`、`TaskMetaCards`——均为展示组件，数据经 IPC 注入。

### 2.6 测量管道（FR5）

- Jira 分布：复用 `jira.ts` 的 search，按 `fixVersion` 分组统计 `issuetype`；导出 CSV + 页面内摘要表。样本与查询条件写入报告脚注。
- hook 开销：`TRELLIS_RECEIPTS=off` 环境变量旁路片段写；对同一操作序列（固定脚本）各跑 20 次，报告 p50/p95/max 与基线差。**不预设阈值**，报告只给分布。

---

## 3. 技术选型汇总

| 项 | 决定 | 理由 |
| --- | --- | --- |
| 新依赖 | `zod`（唯一） | schema 三端共享；收敛"最小新增" |
| 其余 | 全复用现有栈（React/TS/Vite/Electron/chokidar/zustand/react-markdown） | S0 无新运行时 |
| 数据存储 | 文件（JSONL + 片段），无 SQLite | 量级：每任务每天几十条事件；S1 若超量再议 |
| hooks 修改 | 走 `.codex/hooks/` 模板本体（trellis-meta 升级路径） | 不在各项目散落副本 |
| 测试 | vitest（若项目未配则按现有测试约定）单测 eventlog/taskgraph；夹具任务目录做集成 | 对应 06 验证卡 |

## 4. 测试与验收映射

- 单测：片段合并顺序与去重（eventId）、崩溃残留回收、taskgraph 路径解析（含中文/空格/嵌套）、坏 JSON 行容错。
- 集成（夹具任务目录）：外部修改、写入中文件、未知 status 原值透传、多任务事件不串线。
- 手动验证卡：AC3/AC4 用真实宿主（codex hook 组合）跑一次完整任务；AC6 轻任务脚本演示；AC7 两份基线报告。

## 5. 性能与预算

- hook 片段写目标：微秒级文件写，不计入 hook 超时预算（15s）显著份额；实际分布由 FR5 基线给出。
- 收集器：2s 周期批量、pending 目录为空时零 IO；退出前 flush 有界（最多处理 N=500 片段，超出则留存下次启动回收，不阻塞退出）。
- 渲染：回执卡默认只加载最近一次会话摘要，历史折叠。

## 6. 风险与对策

| 风险 | 对策 |
| --- | --- |
| hook 被宿主安全策略限制写文件 | 片段写失败降级为 stderr；面板显示 L0；验证卡必测"收集器不可用" |
| `.panel` 误入归档提交 | 归档打包白名单排除 `.panel/`（T7 落地点） |
| 现有 TaskDetail 改造引发回归 | AC8 回归清单 + 分支保护；新组件全部新增而非改旧组件内部 |
| zod 引入与现有构建冲突 | 先行 spike（构建通过 + 类型导出）列入 implement 第一步 |

## 7. 实施切分建议（供 implement.md 细化）

1. Spike：zod 接入 + `.panel` 目录约定 + 事件 schema 定稿。
2. 主进程：taskgraph → eventlog（收集器/回收）→ receipts 聚合 → IPC。
3. hooks：两处注入点落账（模板路径）+ 旁路开关。
4. 渲染：EvidenceBadge/ReceiptCard → PhasePipeline → JsonlTimeline/TaskMetaCards → 阅读区（宽度/专注/diff）。
5. 测量：Jira 分布报告 → hook 开销基线。
6. 验证：单测/夹具集成 → 真实任务走查（AC1–AC8）。

## 8. S1–S3 骨架（到点再细化）

- **S1 驾驶舱交互**：ACP 权限卡（复用 acp.ts 权限事件）；受管确认门（`.panel/approvals.jsonl`，绑定材料 hash，外部启动报"未观察到批准"）；钉规范（经 handoff.ts 传递 + delivered 事件验证）；前情提要包（taskgraph 血缘 + 归档产物 + 澄清卡确定性汇编）；知识轨迹准备期（implement.jsonl research 条目固化）。
- **S2 外循环**：Jira 版本看板（fixVersion 分组/认领/回写走 SyncIntent 意图+回执）；GitLab 对齐（稳定 MR ID、merged 查询、当前 SHA 流水线）；飞书三档（Tier1 群 webhook 推送先行）。
- **S3 团队增强（条件门控）**：最小服务（Fastify + 单存储，能力上限=06 章 §5）；基座 CI 静态文档站；迭代知识反链。

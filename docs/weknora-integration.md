# Trellis Panel × WeKnora 联动设计

> 目标：让面板从".trellis 的可视化浏览器"升级为**本地编排中枢**——项目内知识留在本地（毫秒级、离线、随仓库走），
> 公司级知识接入 WeKnora（跨项目、语义检索、团队共享），双向流动，喂饱 AI 规划与 AI 编码工具。
>
> **实现状态（2026-09）**：L1–L5 已落地（本文档 §3 对应小节标注 ✅）；L6–L9 暂缓。
> 关键事实更新：WeKnora 已**内置 MCP Server**（设置 → 发布与集成，Streamable HTTP `/mcp/<endpoint_id>`，
> 按端点发 token），旧 `mcp-server/` Python 包已弃用——L3 按内置端点实现，本地零依赖 MCP 脚本保持纯净。

## 0. 现状盘点（面板已有资产）

| 资产 | 位置 | 现状 |
| --- | --- | --- |
| 四库知识索引 | `src/main/services/knowledge.ts` | requirements / spec / wiki / archive，纯本地倒排索引（CJK 二元 + TF-IDF），单查询 30~50ms |
| 知识库 MCP | `src/main/services/kbmcp.ts` | 零依赖 stdio 脚本写入 userData，一键注册 Claude Code / Codex / ZCode；工具 kb_search / kb_read / kb_context / kb_overview |
| AI 规划管线 | `src/main/services/plan.ts` | `aiPlanTask`：本地 kbSearch → 摘录 → 应用内 AI 产出结构化 TaskPlan |
| 应用内 AI | `src/main/services/ai.ts` | OpenAI 兼容客户端，Key 经 DPAPI 加密 |
| 文件监听 | `src/main/services/watcher.ts` | chokidar 监听 `.trellis/**`，300ms 防抖 |
| 设置持久化 | `src/main/services/store.ts` | jira / gitlab / ai / httpApi / desktop 分节合并模式 |
| 归档 / 周报 / 站会 | `index.ts` 的 `task:archive` / `report:*` | 产物目前只留在本地 |

## 1. 定位判断：联邦，而非替换

"写死的知识库接入 WeKnora" 的正确形态是**加一路远程来源**，而不是把本地索引迁到 WeKnora：

- 本地索引是面板的性能卖点（30~50ms、无网络、无 embedding），且随仓库可携带——任何人 clone 仓库，MCP 脚本即开即用；
- WeKnora 补的是本地拿不到的东西：**跨项目规范、历史项目归档、其他团队的接口文档、工作站数据流转约定**；
- 冷热分层：本地 = 热（本项目、当前、随 git 版本化），WeKnora = 冷/共享（公司级、历史、跨团队）。

```
┌─ 本地四库（requirements/spec/wiki/archive）── 毫秒级，随仓库走
│
├─ WeKnora 公司库（跨项目规范/历史归档/接口文档）── 语义检索，团队共享
│
└─ 面板 = 编排中枢：检索联邦化 · 规划喂料 · 双向同步 · AI 工具注册
```

## 2. 联动方案总览

| # | 方向 | 效果 | 阶段 | 状态 |
| --- | --- | --- | --- | --- |
| L1 | 读 | 知识库页联邦检索（本地即时 + 公司库异步追加） | P1 | ✅ |
| L2 | 读 | AI 规划管线纳入公司库（Jira → 计划 更全面） | P1 | ✅ |
| L3 | 读 | 注册 WeKnora 内置 MCP 端点给 AI 编码工具 | P2 | ✅（端点测试 + 复制注册片段） |
| L4 | 写 | 任务归档自动沉淀公司库（闭环飞轮） | P3 | ✅ |
| L5 | 写 | spec 目录单向同步（repo → WeKnora） | P3 | ✅ |
| L6 | 写 | 周报 / 站会存入公司库 | P3 | ⏸ 暂缓 |
| L7 | 读 | 公司规范"引入本地"（冷 → 热，落 `.trellis/spec/company/`） | P3 | ⏸ 暂缓 |
| L8 | 读 | Jira 导入查重（以前做过没有？） | P4 | ⏸ 暂缓 |
| L9 | 交互 | 知识文档一键发到 AI 频道（喂上下文给 AI worker） | P4 | ⏸ 暂缓 |

## 3. 分项设计

### L1 知识库页联邦检索（读）✅

**交互效果**（已实现）：知识库页第五个库 tab `公司库`（WeKnora）+ `全部` 检索态异步追加公司库命中段落。
本地命中立即渲染（现状不变）；公司库命中异步追加，卡片带「公司」标记与分数，点击直接在右侧阅读器打开远程正文（preview API）。
公司库不可用时显示降级角标，本地检索完全不受影响。AI 问答上下文同样纳入公司库命中（来源 chips 可点回阅读器）。

**实现落点**：

- `shared/types.ts`：`WeknoraConfig` / `WeknoraHit` / `WeknoraDocSummary` / `WeknoraReadResult` 等结果类型
- `main/services/weknora.ts`：REST 客户端（见 §8 API 速查），8s 超时、`{data,success}` 信封、失败静默降级
- `index.ts`：`kb:search` 保持纯本地；新增 `weknora:test / search / listDocs / read / testMcp` IPC——**渲染层并行调用、本地结果先上屏**
- `renderer/pages/Knowledge.tsx`：公司库 tab（检索态搜索 + 浏览态列库内文档）、`全部` 态追加区块、远程阅读器分支

### L2 AI 规划管线接入公司库（读，价值最高）✅

**交互效果**（已实现）："AI 规划"（Jira issue / 需求描述 → 结构化任务计划）的素材从"本项目四库"扩展为"本项目 + 公司库"。
规划结果的来源列表出现 `library: 'company'`（path 为 `weknora://<knowledge_id>`）的命中；`questions` 能提出"公司规范 XX 与本需求冲突"这类跨项目问题。
**这是用户核心诉求的直接落点**：长流程任务、跨工作站数据流转的约定文档都在公司库里，规划时必须能看到。

**实现**（`plan.ts` 的 `aiPlanTask`，签名增加第 4 参 `weknoraCfg`）：

1. 本地 `kbSearch`（现状，取 6 条）；
2. 并行调 `weknoraSearch(keywords, 4)`，摘录取命中分块（每篇 ≤3000 字符，公司库摘录总量封顶 12000 字符——远程素材只做增量，不喧宾夺主）；
3. 摘录合并进 prompt，来源标记 `[company-kb]`；
4. 总上下文字符数封顶（如 24000），超出按相关度截断。

同样思路反哺 `hasOpenTaskFor`（L8）：Jira 导入前查公司库，提示"历史项目 X 做过类似需求（附链接）"。

### L3 kbmcp 扩展：AI 编码工具侧（读）✅

**落地形态**（依据新事实——WeKnora 内置 MCP Server）：

设置页 WeKnora 卡片"MCP 端点"小节：

1. 填入 WeKnora「设置 → 发布与集成 → MCP Server」创建的端点 URL 与令牌（令牌 DPAPI 加密）；
2. **测试端点**：面板发一帧 `initialize` JSON-RPC 握手探测 Streamable HTTP 连通性；
3. 一键复制注册片段：Claude `.mcp.json`（`type: http` + Bearer 头）、Codex `config.toml`、ZCode 命令——
   注册条目放各工具的**用户级配置**，不写入随仓库共享的 `.mcp.json`（避免端点令牌进 git）。

本地 `tpanel-kb-mcp`（零依赖 stdio，毫秒级）保持纯净不动——AI 工具同时拥有两个知识源：
本地库（本项目）+ WeKnora 端点（公司库），由工具描述引导按场景选用。

~~备选 B：本地 MCP 网关聚合（company_search/company_read 内嵌）~~——内置端点覆盖了该需求，不再需要。

**安全注意**：公司 API Key 与端点令牌均走 DPAPI 加密；建议 WeKnora 侧使用 scoped API key（限定库写 + 检索）。

### L4 任务归档自动沉淀公司库（写，闭环飞轮）✅

**交互效果**（已实现）：设置页 `归档任务时自动沉淀到公司库` 开关（默认开，作为"记住的选择"）。
归档时把该任务沉淀为 WeKnora 手工知识：

- 标题：`[<项目名>] <任务标题>`；正文：需求（PRD 全文，无则退回描述字段）+ 交付信息（分支 / PR / 子任务勾选态 / git 交付提交前 10 条）+ 备注；头部带完成日期与 Jira 关联
- `channel: 'trellis-panel'`，`status: published` 触发解析
- 落库：`POST /knowledge-bases/:id/knowledge/manual`；归档动作本身不等网络——推送异步执行，结果走 toast 通知
- 实现纪要 v1 用本地事实（task.json + git log）构建，不依赖应用内 AI；后续可选用 AI 摘要增强

**这就是飞轮**：

```
Jira 需求 → AI 规划（本地库 + 公司库检索）→ Trellis 任务
→ AI 编码（本地 MCP 查本项目规范 + WeKnora MCP 查跨项目文档）
→ 归档 → 自动沉淀公司库 → 成为下一个相似需求的规划素材 ↺
```

每个交付的任务都变成公司可检索资产，越用越准。

### L5 spec 目录单向同步（写）✅

**交互效果**（已实现）：设置页开关"规范同步到公司库"。开启后 `.trellis/spec/**` 的 `.md/.markdown/.txt` 变更进队列，
**静默 10 分钟**无新变更后批量推送，`fileName` 传 `<项目名>/spec/<相对路径>`——WeKnora 库内还原目录树且多项目不串。

**更新语义**：文件型知识没有内容更新接口（PUT 只改标题/标签），因此采用 **删除旧条目（按 `file_name` 精确匹配）+ 重推**；
同内容重复推送由服务端 `file_hash` 去重（409 吞掉）。删除本地文件不反向删除远端（unlink 不入队）。

**实现**：`watcher.ts` 增加通用文件事件探针（`start(root, onChange, onFile?)`，不防抖直通 add/change）；
`index.ts` 过滤 spec 路径后交给 `WeknoraSpecSyncer`（weknora.ts 内置防抖队列，项目开关/设置变更/退出时重配置与停止）。

### L6 周报 / 站会沉淀（写）

团队页 `report:generate` / `report:standup` 产物（Markdown）增加"存入公司知识库"按钮：
按周/日期建标题（如 `周报 2026-W38 · <项目>`），走 `/knowledge/manual`，`channel: 'trellis-panel'`。
管理侧检索"这个团队上周做了什么"直接命中。

### L7 公司规范引入本地（读 → 写本地，冷转热）

**交互效果**：知识库页的公司库命中卡片提供"引入本地"动作——把文档正文写入
`.trellis/spec/company/<分类>/<名称>.md`（走既有 `fs:writeSpec` 白名单写入，冲突检测复用 expectedMtime 机制）。
引入后：本地 MCP 可毫秒检索它、AI 会话离线也能用、随仓库版本化。适合"本项目强依赖的公司规范"（如工作站接口约定）一次性落本地。

### L8 Jira 导入查重（读）

`hasOpenTaskFor` 只查本地 requirements。导入 Jira issue 时同步查 WeKnora（标题关键词），
命中历史归档则在导入确认界面提示"公司库有相似历史需求：<标题>（链接）"，附"查看当时怎么做的"入口。避免重复造轮子。

### L9 知识一键发到 AI 频道（交互彩蛋）

知识库页（本地或公司库命中）增加"发到 AI 频道"：复用 `channel:send`，把摘录（≤2000 字符 + 来源路径/链接）
以 `as panel-ui` 发进当前项目频道——AI worker 立即获得该上下文，不用人肉复制粘贴。
适用场景：讨论中需要引用某规范条文，一键投喂。

## 4. 架构哲学核对

面板既有原则："只做被动通知与可视化，不通过 MCP 暴露任何写入口"。本方案不破坏它：

- 所有**写 WeKnora** 的动作都是面板主动外呼 REST（归档/同步/沉淀），不新增任何 MCP 写入口；
- 对仓库的写入（L7 引入本地）走既有白名单写入器与冲突检测；
- AI 编码工具拿到的仍是只读检索能力（本地 + 公司库）。

## 5. 设置与安全

`store.ts` 新增 `weknora` 节（沿用 jira/ai 模式，实际实现形态）：

```ts
weknora: {
  enabled: false,
  baseUrl: '',            // http://weknora.internal:8080（带不带 /api/v1 均可，自动归一化）
  apiKey: '',             // X-API-Key，DPAPI 加密
  apiKeyEncrypted: false,
  searchKbIds: [],        // 联邦检索 / AI 规划的公司库范围（可多选，设置页测试连接后勾选）
  specKbId: '',           // L5 spec 同步目标库
  archiveKbId: '',        // L4 归档沉淀目标库
  autoPushArchive: true,  // L4 默认开（作为"记住的选择"）
  syncSpec: false,        // L5 开关（默认关）
  mcpUrl: '',             // WeKnora 内置 MCP 端点（Streamable HTTP）
  mcpToken: '',           // 端点令牌，DPAPI 加密
  mcpTokenEncrypted: false
}
```

- API Key 与端点令牌均经 safeStorage（DPAPI）加密，`settings:set` 里与 jira/gitlab/ai 同一加密管线；
  已保存密钥测试连接时无需重输（主进程合并已存值）；
- 建议 WeKnora 侧使用 **scoped API key**（capability 级授权 + 限定知识库）：面板只申请"指定库写 + 检索"；
- 设置页 WeKnora 卡片：连接测试（`GET /knowledge-bases`，顺带拉库列表做映射下拉）、库映射、同步开关、MCP 端点测试与注册片段复制。

- API Key 用 **scoped API key**（WeKnora 支持 capability 级授权 + 限定知识库），面板侧只申请：指定库的写 + 全局检索，不用管理员 Key；
- 设置页 WeKnora 卡片：连接测试（`GET /knowledge-bases` ping）、四库映射选择器（拉库列表下拉）、同步状态与最近错误；
- 超时与降级：所有 WeKnora 调用 8s 超时，失败静默降级本地，UI 角标提示。

## 6. 延迟护栏（呼应既有痛点）

| 场景 | 护栏 |
| --- | --- |
| 知识库页搜索 | 本地先行上屏，公司库异步追加，绝不阻塞 |
| MCP 工具 | 本地工具名保持"快"语义；公司库独立工具名（company_search），由 agent 显式选择 |
| AI 规划 | 本地 + 公司库并行检索；摘录总量封顶 |
| 禁用项 | **不接 WeKnora 的 `weknora_ask`/chat 类工具**——内部再跑一层 LLM，会在链路里叠加秒级延迟（ima MCP 慢的老问题） |

## 7. 落地路线

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P1 | 设置卡片 + weknora.ts 客户端 + L1 联邦检索 + L2 规划接入 | ✅ 已完成（typecheck/构建/逻辑自测通过） |
| P2 | L3 注册 WeKnora 内置 MCP 端点 | ✅ 已完成（端点握手测试 + 三平台注册片段复制） |
| P3 | L4 归档沉淀 + L5 spec 同步（L6 周报沉淀 / L7 引入本地暂缓） | ✅ L4/L5 已完成 |
| P4 | L8 Jira 查重 + L9 发到频道 | ⏸ 暂缓 |

## 8. 代码落点清单（实际落地）

```
src/shared/types.ts            + WeknoraConfig / WeknoraKbSummary / WeknoraHit / WeknoraDocSummary /
                                 WeknoraReadResult / WeknoraPushResult；Settings.weknora；TrellisApi 五个方法
src/main/services/weknora.ts   新增（~470 行）：REST 客户端（test/search/listDocs/readDoc/pushManual/
                                 pushFile/testMcp，DPAPI 密钥保护）+ buildArchiveDoc + WeknoraSpecSyncer
src/main/services/store.ts     + weknora 设置节（defaults + 深合并）
src/main/services/watcher.ts   + 文件事件探针 onFile（add/change 直通，不防抖）
src/main/services/plan.ts      aiPlanTask 增加 weknoraCfg 参数，公司库摘录并行补充（封顶 12k 字符）
src/main/index.ts              + weknora:test/search/listDocs/read/testMcp 五个 IPC；
                                 settings:set 密钥加密与同步器重配置；task:archive 归档沉淀；
                                 watcher 接线 routeSpecFileSync；before-quit 停止同步器
src/preload/index.ts           + 五个 weknora API 桥接
src/renderer/src/pages/Knowledge.tsx   公司库第五 tab / 全部态异步追加 / 远程阅读器 / AI 问答纳入公司库
src/renderer/src/pages/Settings.tsx    WeKnora 连接卡片（测试/库映射/L4·L5 开关/MCP 端点与注册片段）
```

## 9. WeKnora API 速查（本方案用到的）

| 用途 | 接口 |
| --- | --- |
| 连接测试 / 库列表 | `GET /api/v1/knowledge-bases`（`X-API-Key`） |
| 跨库检索 | `POST /api/v1/knowledge-search`（query + knowledge_base_ids） |
| 库内文档列表 | `GET /api/v1/knowledge-bases/:id/knowledge?page&page_size` |
| 推 Markdown 知识 | `POST /api/v1/knowledge-bases/:id/knowledge/manual`（title/content/status/channel） |
| 推文件（含目录树） | `POST /api/v1/knowledge-bases/:id/knowledge/file`（multipart，fileName 相对路径；重复 409） |
| 删除单条知识 | `DELETE /api/v1/knowledge/:id`（spec 更新的"删旧推新"用） |
| 知识详情 / 正文 | `GET /api/v1/knowledge/:id`、`GET /api/v1/knowledge/:id/preview` |
| MCP 端点握手 | `POST /mcp/<endpoint_id>`（Streamable HTTP，initialize JSON-RPC） |


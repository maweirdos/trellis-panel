# Journal - maweirdos (Part 1)

> AI development session journal
> Started: 2026-09-21

---



## Session 1: 按 Trellis 规范优化整个项目
<!-- trellis-session: v=2 fp=ac13f6e84b12ad40 -->

**Date**: 2026-09-21
**Task**: 按 Trellis 规范优化整个项目
**Branch**: `main`

### Summary

先提交遗留改动（feat(gateway) MCP网关/待办池/胶囊双形态）；随后按 .trellis/spec 全站审计并修复：新建 Dialogs.tsx 标准对话框组件替换 12 处 Electron 不支持的 window.prompt/confirm；清零 15 处非空断言与 58 处 any（preload 跨层类型、Electron 事件、外部响应 unknown 收窄，新增 shared/errors.ts）；trellis-check 复核修复对话框队列悬挂与 jira 错误文案回归；规范沉淀对话框约定与 window. 前缀审计教训。typecheck/build 通过，验收 grep 全部归零。

### Git Commits

| Hash | Message |
|------|---------|
| `70f2b61` | feat(gateway): 新增 MCP 网关、待办池重构与胶囊模式双形态改造 |
| `7dbf7b4` | fix(spec): 按 Trellis 规范优化全站——消除 Electron 不支持的原生对话框与非安全类型模式 |

### Status

[OK] **Completed**

---

**Date**: 2026-09-21
**Task**: 全站架构改造（09-21-arch-hardening）
**Branch**: `main`

### Summary

参考 PI-Desktop（clean-room，见 TPD-009）完成四层改造：
L1 主进程拆分——index.ts 1561→约 400 行薄壳，项目态收敛 state.ts，93 个 IPC handler 按域拆到 ipc/<domain>.ts（registry 包装器 dev 断言未声明通道）；新增 shared/ipc-channels.ts 中央注册表 + shared/ipc-errors.ts 错误码信封（TPD-001/002/003/004）。
L2 前端——store.ts 单体切片化为 store/ 六域切片（组合出口 useApp 不变，页面零改动；注意 store.ts 与 store/ 同名会自引用成环）；MermaidBlock loose→strict + DOMPurify(SVG) 消毒，MarkdownView 挂 rehype-sanitize（TPD-005/006）。
L3 网关接入——新建 TPAP 本地控制面 services/access/（恒环回 + Bearer token + confirm 门槛 + requestId 幂等 + {epoch,seq} 游标事件），Settings 页可开关/复制/重置，设计文档 docs/access-protocol.md（TPD-007/008）。
L4 spec 文化——新增 .trellis/spec/guides/decisions.md 决策登记簿（TPD-001..009）+ IPC/store/协议安全三份约定，更新三处索引。

验证：typecheck 双配置全绿；node scripts/smoke/tpap.mjs 13 项断言全过（401/422/幂等重放/游标增量/token 轮换）；node scripts/smoke/ipc-registry.mjs 双向断言（93 通道全注册、零未声明）。用户 WIP（Gateway.tsx/Knowledge.tsx）未触碰。

### Status

[OK] **Completed**

---

**Date**: 2026-09-21
**Task**: 对话产品化（09-21-chat-product）
**Branch**: `main`

### Summary

落地对话/多模型/工具安全三块：ai.ts 新增 aiChatStream（openai SSE / anthropic SSE / ollama NDJSON / response 四形态，signal 中断）；新建 chat-store（userData 原子持久化）与 chat 服务（每会话串行 + FIFO 队列自动续发 + abort + 首轮标题自动总结）；事件 chat:output/chat:done 成对 runId。渲染层新增 Chat 页（Entry 纯函数管道 + 滚动状态机 + 40 条窗口化 + 每会话 provider/model 绑定 + 导出 Markdown），入口走命令面板与 Ctrl+.，未触碰用户 WIP（Sidebar/TitleBar/Gateway/Knowledge）。Models 页经既有 ai:fetch-models 通道获得 models.dev 富化（24h 缓存离线回退，字段结构经真实 api.json 核实）。安全：fence.ts 路径围栏修复三处 ../ 目录穿越（TPD-010），截断契约 truncated/totalChars（TPD-011），决策 TPD-010..013 入册，docs/roadmap.md 沉淀持续检索增补点。

### 验证

typecheck 双配置全绿；scripts/smoke/chat.mjs 13 项全过（mock OpenAI SSE 端到端：探测/流式/队列/中止/标题/围栏/截断）；ipc-registry 100 通道双向断言；tpap 13 项回归。调试教训：①SSE 解析对 choices 数组误用 asRecord 取 .delta（恒 undefined）→ 流式空转；②冒烟 mock 每个内联 bundle 会重置全局事件数组 → 幂等初始化；③Node http req 'close' 在请求体读完即触发，服务端流清理必须挂 res 'close'。

### Status

[OK] **Completed**

---

**Date**: 2026-09-22
**Task**: 思考流展示 + 重新生成（09-22-thinking-stream）
**Branch**: `main`

### Summary

roadmap #1 全量 + #2 子集：aiChatStream 解析 openai reasoning_content 与 anthropic thinking_delta（onReasoning 独立回调）；chat:output 增 reasoning 字段与 delta 互斥；ChatMessage 持久化 reasoning；思考档位 off/low/medium/high 随会话持久化并按协议映射（anthropic thinking.budget_tokens 4096/8192/16384 且 max_tokens>budget，openai reasoning_effort，off 不发参数）；转录区 ThinkingBlock 折叠条目（默认收起、流式展开、字数统计）；chat:regenerate 截断末条 assistant 重跑（popLastAssistant + startRun appendUser:false），转录区末条回答悬停出现重新生成按钮。TPD-014 入册，roadmap #1 标记完成。

### 验证

typecheck 双配置全绿；chat 冒烟扩至 21 项全过（新增：reasoning 事件与落库、reasoning_effort 请求体断言、anthropic off 不带 thinking 字段、thinking_delta 解析、budget_tokens=4096、regenerate 三态）；ipc-registry 101 通道回归、tpap 13 项回归。教训：python str.replace 批量改码会静默 no-op，多行匹配受换行符干扰——关键替换后必须 grep 验证。

### Status

[OK] **Completed**

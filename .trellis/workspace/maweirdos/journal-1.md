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

---

**Date**: 2026-09-22
**Task**: TPAP 对话只读面（roadmap #8 增量）
**Branch**: `main`

### Summary

access server 新增 GET /tpap/v1/chat/sessions 与 /chat/session?id= 只读端点——复用 chat-store 单一实现（TPD-007 第六条），过 Bearer 鉴权，host 能力表增 chat.read。tpap 冒烟扩至 16 项（新增列表/单读/404 三断言）。教训累积：heredoc 内多层转义（bash→python→JS regex）极易错一层，修复字符串应用 chr(92) 显式构造并对替换结果立即 grep 验证。

### Status

[OK] **Completed**

---

**Date**: 2026-09-22
**Task**: 统一代理设置（09-22-unified-proxy，roadmap #10）
**Branch**: `main`

### Summary

settings.proxy（enabled+url，http/socks5）一处配置覆盖三条出网路径：services/proxy.ts 的 proxiedFetch（启用时 npm undici 同实例 fetch+ProxyAgent，禁用回退全局 fetch 直连）覆盖 aiChat/aiChatStream/模型探测/models.dev；applyChromiumProxy（session.setProxy fixed_servers，socks5 前缀转换）覆盖 WeKnora net.fetch，boot 与 settings:set 后应用。Settings 页新增"网络代理"节。TPD-015 入册，roadmap #10 完成。

### 验证与教训

proxy 冒烟 5 项全过（本地转发代理 absolute-form + 目标服务：启用时请求经代理且流式成功、禁用时直连零代理请求、探测路径经代理）；chat 21/tpap 16/registry 101 回归全过；typecheck 全绿。关键教训：**Node 内置 fetch 与 npm undici 是两个实例**，跨实例传 dispatcher 报 `invalid onRequestStart method`——必须用同一 undici 包的 fetch 配套 ProxyAgent。

### Status

[OK] **Completed**

---

**Date**: 2026-09-22
**Task**: 会话树结构升级（09-22-chat-tree，roadmap #2）
**Branch**: `main`

### Summary

会话存储 v2 树结构（nodes map + activeLeaf，TPD-016）：活跃对话 = activeLeaf 回溯路径；v1 线性会话打开自动迁移为链。编辑重发（chat:edit，user 兄弟分支重跑）、chat:branch 分支切换、regenerate 升级为分支保留（旧回答不丢弃）；chatOpen 返回活跃路径视图（id/siblingCount/siblingIndex/siblingIds）；渲染层 ‹i/n› 分支切换器 + 用户消息内联编辑（铅笔→textarea→保存重发）。chat 冒烟扩至 30 项（新增 v1 迁移/编辑兄弟/分支切换/regenerate 保留），四套冒烟 + typecheck 全绿。

### Status

[OK] **Completed**

---

**Date**: 2026-09-22
**Task**: 渲染契约（09-22-render-contract，roadmap #9）+ ToolSearch（09-22-toolsearch，roadmap #6）
**Branch**: `main`

### Summary

#9：entries.ts 增 reuseEntries（key/content/reasoning/兄弟三元组全等即复用 prev 引用），useChatEntries 持 prev 链；render-contract 冒烟 9 项断言身份契约（恒等/流式/追加/分支/稳定）。修复过程发现此前批量替换静默失败导致 buildEntries 未透传 id/sibling 字段——渲染层分支切换器与编辑按钮将永远不可见，正是契约冒烟逼出的真 bug。#6：网关 getToolSearchDef/getDeferredCatalog/searchTools + TPAP GET /tools?mode=deferred 与 POST /tool_search（只读，不进 confirm 门槛），默认全量路径不变。TPD-017/018 入册，roadmap #9/#6 标记完成。

### 验证

render-contract 冒烟 9 项全过；tpap 扩至 19 项；chat 30/registry 103/proxy 5 回归全过；typecheck 全绿。教训：python 批量替换必须 assert + 替换后 grep 验证（本轮第三次被静默 no-op 咬到）。

### Status

[OK] **Completed**

---

**Date**: 2026-09-22
**Task**: 多模态图片输入（09-22-multimodal，roadmap #7）
**Branch**: `main`

### Summary

ChatMessage 增 images（{mediaType,dataBase64}）；渲染层 composer 文件选择+粘贴（≤4 张、前端 3MB、主进程 4MB 硬门槛），预览 chip 可移除；chat:send 经 parseImages 校验后随节点持久化（队列项亦携带）；aiChatStream 按协议升维 user content 为分片数组（openai image_url / anthropic image.source.base64 / ollama images 裸 base64），历史消息剥离节点元数据（id/parent）只传协议字段；用户气泡渲染缩略图。TPD-019 入册，roadmap #7 完成。

### 验证与教训

typecheck 全绿；chat 冒烟扩至 36 项全过（图像分片断言改为定位"含数组 content 的请求"，避免误匹配标题总结请求）；五套回归全过。教训：对同一代码块的多次 python 批量替换会互相覆盖（reasoning_effort 编辑覆盖了图像升维），关键块改动后必须重读确认。

### Status

[OK] **Completed**

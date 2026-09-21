# 架构决策登记簿（TPD）

> **Purpose**: 所有关键架构决策的单一登记处。编号一经分配永不复用；修改决策 = 新增一条并标记
> 取代旧编号。
>
> **When to Use**: 做出影响跨文件结构、协议形状、安全边界、依赖选型的决策时，先在此登记编号，
> 再在代码与文档中引用编号。讨论参考物为外部开源项目时，必须遵守 TPD-009。

| 编号 | 标题 | 状态 | 日期 |
|---|---|---|---|
| [TPD-001](#tpd-001) | IPC 通道中央注册表 | 已采纳 | 2026-09-21 |
| [TPD-002](#tpd-002) | 通道命名保持 `domain:action` | 已采纳 | 2026-09-21 |
| [TPD-003](#tpd-003) | IPC 失败信封必带机器可读错误码 | 已采纳 | 2026-09-21 |
| [TPD-004](#tpd-004) | 主进程薄壳：index.ts / state.ts / ipc 域模块三层 | 已采纳 | 2026-09-21 |
| [TPD-005](#tpd-005) | markdown/mermaid 渲染管线强制消毒 | 已采纳 | 2026-09-21 |
| [TPD-006](#tpd-006) | zustand store 按域切片 | 已采纳 | 2026-09-21 |
| [TPD-007](#tpd-007) | TPAP 本地控制面安全底线 | 已采纳 | 2026-09-21 |
| [TPD-008](#tpd-008) | 事件重连凭 `{epoch, seq}` 游标，不依赖墙钟 | 已采纳 | 2026-09-21 |
| [TPD-009](#tpd-009) | 外部项目引用一律 clean-room | 已采纳 | 2026-09-21 |
| [TPD-010](#tpd-010) | 工作区路径围栏统一函数 | 已采纳 | 2026-09-21 |
| [TPD-011](#tpd-011) | 工具输出截断必须显式契约化 | 已采纳 | 2026-09-21 |
| [TPD-012](#tpd-012) | 模型目录发现优先 + models.dev 富化 | 已采纳 | 2026-09-21 |
| [TPD-013](#tpd-013) | 对话转录 Entry 管道 + 滚动状态机 | 已采纳 | 2026-09-21 |
| [TPD-014](#tpd-014) | 思考流独立契约与档位映射 | 已采纳 | 2026-09-22 |
| [TPD-015](#tpd-015) | 出网代理统一走同实例 undici dispatcher | 已采纳 | 2026-09-22 |
| [TPD-016](#tpd-016) | 会话存储树结构：编辑/重新生成都生成兄弟分支 | 已采纳 | 2026-09-22 |
| [TPD-017](#tpd-017) | 转录区渲染契约：Entry 引用复用 | 已采纳 | 2026-09-22 |
| [TPD-018](#tpd-018) | 网关工具默认全量、deferred 模式按需检索 | 已采纳 | 2026-09-22 |

---

## TPD-001: IPC 通道中央注册表

- **决策**: 全部 IPC 通道（invoke 与事件）集中在 `src/shared/ipc-channels.ts` 以常量声明；
  主进程侧所有注册经 `src/main/ipc/registry.ts` 的 `handle/on` 包装器进行，dev 下注册未声明
  通道立即抛错；preload 只引用常量。
- **理由**: 通道字符串散落 25+ 处时，"拼写错一个字符静默失效"是最常见回归源；中央注册表使
  通道清单可审计、可 grep、可断言。
- **替代案**: preload 用 `typeof api` 反推类型 —— 不约束主进程侧命名，放弃。

## TPD-002: 通道命名保持 `domain:action`

- **决策**: 新通道沿用 `<domain>:<action>` 字面量；事件通道集中在 `ipcEvent` 节与 invoke 通道
  分节管理；不改为斜杠分隔的 URI 风格。
- **理由**: Electron 生态惯例即冒号风格；改名属纯 churn（120+ 通道 × 两侧），零功能收益、
  纯回归风险。"命名原则"的实质是"域前缀 + 中央声明 + 事件单列"，与分隔符无关。
- **替代案**: 全量改为 `tpanel/<domain>/<action>` —— 否决，理由如上。

## TPD-003: IPC 失败信封必带机器可读错误码

- **决策**: 所有 `{ok:false}` 响应必须携带 `code`（`src/shared/ipc-errors.ts` 的
  `IpcErrorCode` 枚举），经 `ipcFail(code, error, extra?)` 构造；`error` 仍是人读文案；
  渲染层缺 `code` 视为 legacy 数据，不得在新代码中产生无码失败。
- **理由**: 文案面向人不面向分支；没有码，渲染层无法区分"未打开项目"与"网络失败"这类
  需要不同 UI 反应的状态。
- **替代案**: 抛 Error 让 invoke reject —— Electron 的 reject 序列化信息弱且无法承载结构化
  附加字段（如 conflict），放弃。

## TPD-004: 主进程薄壳：index.ts / state.ts / ipc 域模块三层

- **决策**: `src/main/index.ts` 只保留窗口/托盘/快捷键/更新器/生命周期/深链；项目态与跨域
  助手收敛 `src/main/state.ts`；全部 `ipcMain.handle/on` 注册按域放 `src/main/ipc/<domain>.ts`，
  唯一入口 `ipc/index.ts` 的 `registerIpc(deps)`；窗口能力经 `WindowDeps` 注入，域模块不直接
  持有窗口引用。项目切换统一走 `state.openProjectAt`（面板与深链双入口合一）。
- **理由**: 1561 行的 index.ts 让"改一个域要读懂全 app"；三层后改动半径 = 单个域文件。
- **替代案**: 依赖注入容器 —— 对当前规模过度设计，模块级单例足够。

## TPD-005: markdown/mermaid 渲染管线强制消毒

- **决策**: mermaid 初始化 `securityLevel:'strict'`（禁 HTML 标签与 click 回调），渲染产物经
  DOMPurify（SVG profile，禁 foreignObject/script）后才允许 `dangerouslySetInnerHTML`；
  MarkdownView 挂 `rehype-sanitize`（default schema）作纵深防御。
- **理由**: 渲染内容来自外部（任务文档、Jira 导入、AI 输出、WeKnora 远端文档），mermaid
  `loose` 模式 + 裸 innerHTML 是真实 XSS 注入点（Electron renderer 即使有 contextIsolation，
  注入脚本仍可调用 preload 暴露的全部 IPC 能力）。
- **替代案**: 仅依赖 contextIsolation —— 否决，preload 桥即能力面，renderer 失守等于失守。

## TPD-006: zustand store 按域切片

- **决策**: store 按 session/ui/toast/viewer/todos/inbox 六域切片（`store/slices/`），
  `store/index.ts` 组合并统一导出；类型集中在 `store/types.ts`（`AppSlice<T>` 构造器类型）。
  **注意：实现目录为 `store/`，不得再有同名 `store.ts` 与其并存**（模块解析自引用成环，
  类型退化为 any）。
- **理由**: 单体 store 让无关域的状态更新互相触发渲染；切片让域内聚、测试可按域构造。
- **替代案**: 多 store 实例 —— 页面跨域组合选择器更繁琐，放弃。

## TPD-007: TPAP 本地控制面安全底线

- **决策**: 见 `docs/access-protocol.md` §5 与 `backend/access-protocol-security.md`：
  恒环回绑定（无配置面）、Bearer token 常量时间比较、变更类操作必须 `confirm:true`
  （422 拒绝且零副作用）、requestId 幂等缓存、默认关闭、请求体 1MiB 上限、
  读路径复用面板内部同一实现。
- **理由**: 本地控制面是"renderer 之外的第二个能力面"；每一道门槛都对应一类真实攻击
  （DNS rebinding/恶意网页探测 → 恒环回+token；重试风暴 → 幂等；半实现客户端 → confirm）。
- **替代案**: 校验 Origin/Host 头 —— 对非浏览器客户端无意义，token 更通用。

## TPD-008: 事件重连凭 `{epoch, seq}` 游标，不依赖墙钟

- **决策**: 持久事件带进程内单调 seq；epoch 每次启动重新生成，跨重启必变；客户端 cursor
  的 epoch 不匹配或 seq 落在已丢弃区间 → 返回 `reset:true` 强制全量重拉。
- **理由**: 墙钟在休眠/回拨/双实例场景不可靠；epoch 使"续传合法性"成为 O(1) 判断。
- **替代案**: 时间戳游标 / 全量轮询 —— 均否决。

## TPD-009: 外部项目引用一律 clean-room

- **决策**: 参考其他开源项目时：只吸收"思想分类"（架构分层、协议语义、安全门槛等通用工程
  概念），不复制其源代码、文档原文、patch；实现与文档独立撰写；产出物头部注明 clean-room
  声明；引入其 npm 依赖前先核对该依赖自身许可证（依赖方协议不传染上游，但 patch 过的
  依赖属于依赖方代码）。
- **理由**: 版权保护"表达"不保护"思想"——合规的参考路径是读文档→做笔记→关掉源码→
  自己写；直接拷代码会把对方 copyleft（如 LGPL）传染进本项目 MIT。
- **替代案**: 直接拷代码并遵守对方协议开源 —— 与本项目 MIT 目标冲突，仅在愿意整体换协议
  时作为选项。

## TPD-010: 工作区路径围栏统一函数

- **决策**: 所有接受"项目内相对路径/文件名"参数的代码必须经 `src/main/services/fence.ts`
  的 `insideRoot` / `insideRootAbs` 校验；越界一律失败（网关工具内 throw，走 `ok:false` 信封）。
- **理由**: gateway 的 `trellis_get_spec`/`trellis_get_task`/`syncSpecFromRemote` 曾可用
  `../` 读到项目外任意文件——外部可触达的读接口即能力面。
- **替代案**: 逐处手写 startsWith 校验 —— 已发生过漏（本决策前的真实漏洞），必须统一。

## TPD-011: 工具输出截断必须显式契约化

- **决策**: 网关工具输出超限时响应携带 `truncated: true` 与 `totalChars`（截断前总长），
  `preview` 字段承载截断文本；消费方据此可提示"结果被截断"。
- **理由**: 静默截断让调用方（人或模型）误以为拿到了完整数据；截断是降级不是正常路径，
  必须可被感知。
- **替代案**: 不截断 —— 上下文/UI 双爆炸，否决。

## TPD-012: 模型目录发现优先 + models.dev 富化

- **决策**: 模型列表以供应商自有 `/models` 端点为权威（无 key 也允许探测本地网关）；
  models.dev `api.json`（`{provider: {models: {modelId: {context_window, max_output_tokens}}}}`）
  仅做元数据富化，缓存于 userData（TTL 24h），离线/超时静默回退过期缓存或跳过。
- **理由**: 供应商才是"部署了哪些模型"的事实源；models.dev 补的是上下文窗口等静态参数；
  两者都不该硬编码进面板。
- **替代案**: 维护本地模型矩阵 —— 立即过时，否决。

## TPD-013: 对话转录 Entry 管道 + 滚动状态机

- **决策**: 对话页渲染走 `buildEntries(messages)` 纯函数（连续 assistant 消息合并为回合）；
  滚动行为收敛于 `useTranscriptScroll`（仅当用户本在底部 ±48px 才跟随，否则显示"回到底部"）
  与 `useTranscriptWindow`（默认只渲染尾部 40 条，向上翻页扩窗）。流式增量不属于落库消息，
  由 store 的 streaming 态单独渲染。
- **理由**: 消息→条目的纯函数分离让工具卡/折叠等后续能力只改一个函数；滚动是聊天 UX 的
  第一差评来源，必须集中管控。
- **替代案**: 消息数组直接 map 渲染 + 全量 DOM —— 长会话卡顿，否决。

## TPD-014: 思考流独立契约与档位映射

- **决策**: reasoning（思考流）与正文在任何层面都分离：aiChatStream 以 onReasoning 独立回调；
  chat:output 事件以 `reasoning` 字段与 `delta` 互斥下发；ChatMessage 持久化可选 `reasoning`；
  转录区以独立折叠条目渲染（默认收起、流式时展开）。思考档位（off/low/medium/high）随会话
  持久化，按协议映射：anthropic→thinking.budget_tokens（4096/8192/16384，且 max_tokens>budget）；
  openai 兼容→reasoning_effort；off 一律不携带任何思考参数；ollama/response v1 不发参数
  （被动解析仍然生效）。
- **理由**: 思考流混入正文会污染 Markdown 渲染与历史上下文；档位是请求参数而非 UI 装饰，
  必须落在请求体契约上并有冒烟断言。
- **替代案**: 把 reasoning 拼进 content —— 无法区分展示、无法独立折叠，否决。

## TPD-015: 出网代理统一走同实例 undici dispatcher

- **决策**: Node 侧出网（AI 四形态/模型探测/models.dev）统一经 `services/proxy.ts` 的
  `proxiedFetch`——启用代理时用 **npm undici 自带的 fetch + ProxyAgent**（同实例），禁用时
  回退全局 fetch 直连；Chromium 侧（weknora net.fetch）经 `session.setProxy(fixed_servers)`。
  禁止把 npm undici 的 ProxyAgent 塞进 Node 全局 fetch 的 init.dispatcher。
- **理由**: Node 内置 fetch 与 npm undici 是两个实例，Handler 协议版本不兼容
  （实测报 `invalid onRequestStart method`）；跨实例 dispatcher 必然失败。
- **替代案**: setGlobalDispatcher —— 只影响 npm undici 实例，对全局 fetch 无效，否决。

## TPD-016: 会话存储树结构：编辑/重新生成都生成兄弟分支

- **决策**: 会话 JSON v2 = `{version:2, nodes:{id→ChatNode}, activeLeaf}`；活跃对话 = activeLeaf
  回溯路径。编辑重发（user 兄弟）、regenerate（assistant 兄弟）都生成新兄弟节点并切换
  activeLeaf，旧分支永久保留可切回；禁止物理删除旧回答。v1 线性格式打开时自动迁移为链。
- **理由**: 线性数组迫使 regenerate 丢弃旧回答；树结构让"换一个回答/改一个问题"成为
  可逆操作，成本仅是节点引用。
- **替代案**: 线性数组 + 备份文件 —— 状态分裂，否决。

## TPD-017: 转录区渲染契约：Entry 引用复用

- **决策**: `reuseEntries(prev, next)`——同位置 key/内容/思考流/兄弟三元组全等的条目复用
  prev 对象引用；Chat 页经 `useChatEntries` 持有 prev 链。契约由
  `scripts/smoke/render-contract.mjs` 断言（恒等输入恒等引用/流式增长仅尾条新引用/前缀保持/
  连续恒等构建引用稳定）。
- **理由**: 流式每 delta 重建全条目会让 React.memo 全部失效、整列表重渲染；身份复用是
  零成本跳过重渲染的前提。
- **替代案**: 上虚拟滚动库 —— 不解决对象身份问题，且引入布局约束，否决。

## TPD-018: 网关工具默认全量、deferred 模式按需检索

- **决策**: `/tpap/v1/tools` 默认返回全量目录（面板内消费不变）；`?mode=deferred` 仅返回
  `tool_search` 元工具；`POST /tool_search`（只读）按名称/描述/upstreamId 检索返回匹配定义。
  面板内部调用路径不受影响。
- **理由**: 工具数量增长后全量目录浪费外部客户端上下文；deferred 是纯增量模式，不破坏
  既有消费者。
- **替代案**: 服务端强制所有客户端 deferred —— 破坏兼容，否决。

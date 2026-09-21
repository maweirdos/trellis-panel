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

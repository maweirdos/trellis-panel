# 执行计划：ACP Agent 控制台

## 有序实施清单

1. **契约层**：`src/shared/types.ts` 增 `TimelineEvent` / `AcpAgentConfig` / `AcpSessionState` / `AcpPermissionRequest`；`src/shared/ipc-channels.ts` 登记 `ipcInvoke.acp.*` 与 `ipcEvent.acpOutput|acpPermission|acpDone`（中央注册表，禁散落字面量）。
2. **协议核心**（`src/main/services/acp.ts`）：NDJSON 帧（按 `\n` 切、剥 `\r`、拼跨行缓冲）；`initialize` → `session/new`（cwd=项目根）→ `session/prompt` → `session/cancel`；`session/update` 归一 TimelineEvent 广播。**先写 mock agent 冒烟脚本（`scripts/smoke/acp-mock-agent.mjs`：NDJSON 假 agent，回放对话+工具调用+权限请求）驱动协议栈**，再接真 codex-acp。
3. **权限桥**：`request_permission` 挂起队列 → `acpPermission` 事件 → 渲染层三态卡 → `acp:permission.respond` 回写；120s 超时默认拒绝；「本次会话允许」按 sessionId 记忆。
4. **进程治理**：spawn node 适配器（`shell:false` 优先，Windows 失败回退 `shell:true`）；崩溃 → 会话 error 态 + `acp:agent.restart`；退出树杀（参照 `cli.ts` 进程树终止）。
5. **trellis 轨道接入**：在既有 watcher 文件级探针 / tpanel task-event / jira 第一方动作处挂 TimelineEvent 发射（`task-status` / `doc-created` / `spec-updated` / `jira-sync`），按 projectRoot+taskDir 路由进活跃会话流。
6. **AcpConsole 页**（`src/renderer/src/pages/AcpConsole.tsx`）：会话列表 + 会话流（复用 Chat 页 Entry 管道/滚动状态机/思考折叠组件模式）+ composer + 头部任务徽标；工具调用卡与 trellis 卡片混排渲染，卡片点击跳任务详情/产物查看器/规范页。
7. **工单选择器**（R7 人工流）：「从 Jira 选工单」入口 → 复用 jira 查询 → 卡片列表 → `task:createFromJira` → 绑定会话。
8. **spec 注入接线**：Studio 钩子编辑页提供一键给 SessionStart/每轮注入命令追加 `tpanel notify` 上报（通道 `bridge.ts:136` 现成），产出 `spec-injected` 卡片。
9. **设置页 ACP agent 注册表**：命令模板 + 显示名 + 启用开关；预置 `codex-acp`（默认启用）与 `gemini --acp`（默认停用）。
10. **收尾**：README 功能表补一行；`docs/roadmap.md` 增补记录。

## 验证命令

```bash
npm run typecheck          # node + web
npm run build
node scripts/smoke/acp-mock-agent.mjs   # 自测模式：mock agent 自行回放场景断言
# 端到端（真机）：设置页配置 codex-acp 命令 → AcpConsole 建会话 → PRD 验收场景逐条走
```

## 风险文件与回滚点

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| `shared/types.ts` | IPC 契约扩散，牵动 preload | 契约先行（步骤 1 单独提交，typecheck 门禁） |
| `shared/ipc-channels.ts` | 注册表是唯一事实源 | 只新增 `acp` 域分节，零改动既有键 |
| watcher/bridge 挂点 | trellis 轨道挂到既有探针上，误伤看板刷新 | 挂点只增发事件不改原回调签名；看板回归手测 |
| codex-acp 客户端能力依赖 | 若适配器要求 client-side fs/terminal，能力协商后会调用失败 | mock 冒烟先行；若确认依赖，最小补 `fs/read_text_file`（只读）并升级权限卡文案 |
| Chat 页组件复用 | 抽取共享组件可能动到对话页 | 只抽不改：新组件包装既有实现，对话页引用不迁移 |

## start 前检查

- [ ] codex-acp 适配器本机可用性确认（`npx codex-acp --help` 或等价；Windows Node 版本）
- [ ] ACP v1 schema 落地引用（`agentclientprotocol.com/protocol/v1/schema`）作为 acp.ts 注释锚
- [ ] implement.jsonl / check.jsonl 按派发模式策展（若本任务走子代理派发；内联模式跳过）

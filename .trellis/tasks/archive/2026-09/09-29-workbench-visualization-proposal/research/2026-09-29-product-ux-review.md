# 产品、交互与跨编辑器接入评审证据

日期：2026-09-29。范围：既有任务的独立评审，不激活任务、不修改应用代码。

## 交付物

完整评审与 Roadmap：[`05-产品评审与跨编辑器Roadmap.md`](../../../../docs/proposals/2026-09-28-workbench-optimization/05-产品评审与跨编辑器Roadmap.md)。

文档状态为待确认建议，不覆盖 00–04 的已记录决策，也不代表用户授权开始实施。

## 核心判断

- 保留外部 Trellis 拥有任务生命周期的边界。
- 首版价值应覆盖可信读取、任务材料阅读、跨工具交接，不止打开目录。
- 跨编辑器接续同一任务、恢复某个平台的特定会话、跨平台迁移聊天是三种不同能力。
- R0 先修会话级当前任务兼容性和外部请求工作区绑定；R1 复用已有 TaskWorkspace、ArtifactViewer、handoffTexts；R2 验证明确的工具/宿主组合；R3 再扩展只读 bridge 与真实会话事件。

## 关键静态证据

- `.trellis/.version`：0.6.17。
- `src/main/services/scan.ts:282-302` 已读会话；`:357-362` 的全局 currentTask 仍读 `.current-task`。
- `src/main/services/scan.ts:72-85` 已有文件时间；`:133-156` 的任务 updatedAt 取目录时间。
- `src/main/services/watcher.ts:18-45` 已有具体文件变化事件。
- `src/main/state.ts:109-126` 重扫失败未提供完整 UI 错误/过期合同。
- `src/main/state.ts:378-411` 的 Jira 定时器可直接写任务状态。
- `src/main/services/plan.ts:165-173` 已有多平台交接文本；目前硬编码命令及直接更新状态指引应改造。
- `src/renderer/src/pages/Tasks.tsx:362、1690-1701` 已有 TaskWorkspace；不必从零重写。
- `src/main/services/access/server.ts:126-141` 请求使用 UI 当前 snapshot root，需防跨项目漂移。
- `src/main/services/kbmcp.ts:36-58、82-99` 安装会写项目与用户级配置，需 diff、确认、冲突与回滚设计。
- `src/main/services/bridge.ts`、`kbmcp.ts`、`access/server.ts`、`gateway/manager.ts` 分别承担不同桥接职责，不能统称已具备完整外部会话接入。

完整文件与行号表见报告 §9.1。

## 开源一手来源

- Trellis 多平台：https://docs.trytrellis.app/advanced/multi-platform.md
- Trellis README：https://github.com/mindfold-ai/Trellis/blob/main/README.md
- Trellis CLI 文件原文：https://raw.githubusercontent.com/mindfold-ai/Trellis/main/packages/cli/package.json
- ACP 初始化：https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/initialization.mdx
- ACP 会话：https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/session-setup.mdx
- MCP 架构：https://modelcontextprotocol.io/docs/learn/architecture
- Vibe Kanban README 原文：https://raw.githubusercontent.com/BloopAI/vibe-kanban/main/README.md
- Continue README 原文：https://raw.githubusercontent.com/continuedev/continue/main/README.md

Trellis/ACP 文档支持能力式适配；MCP 支持上下文交换而非普遍的宿主会话控制。

Vibe Kanban 原句：“Vibe Kanban is sunsetting.”
Continue 原句：“The `continuedev/continue` repository is no longer actively maintained and is read-only for all users.” 另有最终 2.0.0 发布声明。
这些是检索时 README 自述，不是已核验 GitHub archived 字段或停运日期。停止维护不等于许可证失效；建议借模式，不作为必须持续跟随的运行时依赖。

## 研究与验证边界

- 原方案五份现行主文档、任务 PRD/design/implement、GLM 历史路线图和 OSS 调研已用于对照。
- 本地实现经过静态核对，未启动桌面应用、未运行编辑器或集成测试。
- 外部研究使用直接 HTTPS 原文和 Context7；WebFetch/WebSearch 摘要调用失败，未将失败结果计作验证。
- 路线图工期、可用性时间指标均为建议估算/目标，不是已经测量的结果。

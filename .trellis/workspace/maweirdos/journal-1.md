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

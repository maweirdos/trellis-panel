# 升级 Electron（解锁 Node ≥22 / undici）

## Requirements
- R1 Electron 升至当前稳定版（内置 Node ≥22），配套 electron-vite / electron-builder / vite / @vitejs/plugin-react / @types/node 升级兼容。
- R2 typecheck + 六套冒烟（chat/tpap/proxy/render-contract/ipc-registry）+ electron-vite build 全过。
- R3 真实 Electron 无头加载 3s 无崩溃（主进程+preload 全链路）。
- R4 undici 解锁评估：Electron 就绪后升 undici v8 → 真实加载验证 + proxy 冒烟；若内置 Node 无 markAsUncloneable 则回退 6.28 并在 TPD-015 记录版本矩阵。
- R5 TPD-015 修订 + journal + 提交。

## Acceptance Criteria
- [ ] AC1 process.versions 实测 Electron 内置 Node ≥22。
- [ ] AC2 六套冒烟 + typecheck + build 全绿。
- [ ] AC3 真实 Electron 启动无崩溃。
- [ ] AC4 undici 最终版本有真实加载验证背书（v8 或 6.28+记录）。

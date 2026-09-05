# Trellis Panel 技术方案

> 目标：为 Trellis（AI coding 工作流框架）做一个 Windows 11 优先的本地可视化面板，
> 要求性能高、稳定流畅、UI 效果好。

## 1. 客户端技术选型

| 候选 | 优势 | 劣势 | 结论 |
| --- | --- | --- | --- |
| **Electron + React + TS** | 生态最成熟（VS Code 同栈）；Chromium 渲染 UI 表现力最强；纯 Node 工具链即可开发打包 | 内存占用高于原生（对本类工具可接受） | ✅ 选用 |
| Tauri 2 (Rust) | 体积/内存最优 | 需要 Rust + MSVC 工具链（数 GB 安装、构建慢、环境风险高） | 备选（未来可迁移） |
| WinUI 3 / WPF | 原生性能 | 富 UI 开发效率低、跨版本兼容坑多 | 不选 |
| Flutter | 性能好 | 桌面生态一般、Markdown/文件工具链弱 | 不选 |

选型结论：**Electron 33 + React 18 + TypeScript 5 + electron-vite (Vite 5) + Tailwind CSS 3 + zustand**。
在目标机器（Windows 11 / Node 24）上从零到打包全程验证通过。

## 2. 数据模型（对齐官方实现）

通过安装的 `@mindfoldhq/trellis` CLI v0.6.14 与 `@mindfoldhq/trellis-core` 反编译类型、
以及本机 5 个真实 Trellis 项目（resumedit / honsky 等）实地验证：

- **task.json 24 字段标准 Schema**（`TrellisTaskRecord`）：id/title/status/priority/assignee/branch/subtasks/parent/children/…；
- **状态 → 阶段**：`planning→plan`、`in_progress→implement`、`review→review`、`completed|done→completed`；
- **目录约定**：
  - `.trellis/tasks/MM-DD-slug/{task.json, prd.md, research/, *.jsonl}`
  - 归档两种布局：新 `.trellis/archive/<task>/`，旧 `.trellis/tasks/archive/<YYYY-MM>/<task>/`
  - `.trellis/spec/**/*.md`、`.trellis/workspace/<dev>/journal-N.md`、`.trellis/.runtime/sessions/*.json`
  - `.version` / `.developer` / `.current-task` / `config.yaml` / `workflow.md`
- **平台检测**：`.claude` `.cursor` `.opencode` 等 21 种平台标记目录。

## 3. 架构设计

```
┌─ 渲染进程 React 18（零 Node 访问，contextIsolation）
│   页面：概览 / 看板 / 详情抽屉 / 规范 / 工作区 / 归档 / CLI / 设置
│   状态：zustand；Markdown：react-markdown + remark-gfm
│        ▲ IPC（contextBridge 类型化 API）
├─ preload（唯一桥接层）
│        ▲ invoke / event push
└─ 主进程 Node
    ├─ scan.ts     扫描器：任务/归档(双布局)/规范树/工作区/会话；task.json 白名单写回
    ├─ watcher.ts  chokidar 监听 .trellis/，忽略 .backup-*，300ms 防抖 → 全量快照推送
    ├─ cli.ts      trellis CLI 子进程：流式输出事件、taskkill /T /F 进程树终止
    └─ store.ts    设置持久化（最近项目/主题/CLI 命令）
```

### 性能设计
- 所有文件 I/O 在主进程；扫描并发 `Promise.all`，快照一次序列化推送（全量 < 100KB 量级）；
- 文件监听防抖 300ms；渲染端输出缓冲 10fps 刷新（CLI 长输出不卡帧）；
- 读取保护：扩展名白名单 + 路径包含校验 + 5MB 上限；写回保留未知字段。

### 稳定性设计
- 渲染进程无 Node 权限（`contextIsolation: true, nodeIntegration: false`）；
- 单实例锁；窗口最大化状态双向同步；无边框窗口自绘标题栏 + 三枚窗口控制按钮；
- CLI 交互式命令挂起风险：预设命令均带非交互参数，输出区给出提示，支持一键中止；
- 所有解析（task.json / session / config.yaml）单文件 try/catch，坏文件标记而不崩溃。

## 4. UI 设计

- Linear 风格暗色主题为默认，CSS 变量驱动深/浅双主题（Tailwind `<alpha-value>` 通道）；
- 自定义配色：ink（背景层）/ mist（文字层）/ leaf（品牌绿，呼应 Trellis）；
- 看板列按状态着色（蓝/琥珀/紫/绿），优先级徽章 P0-P3 分级配色；
- 中文界面，Segoe UI Variable + Microsoft YaHei UI 字体栈，Cascadia Code 等宽字体。

## 5. 实现与验证记录

- ✅ `npm run typecheck`（主进程 + 渲染端）零错误；
- ✅ 真实项目（resumedit：16 任务 / 56 归档 / 33 规范 / 34 会话）全页面视觉验证通过；
- ✅ 打开项目（原生目录选择）→ 概览统计 → 看板 → 详情/产物 Markdown → 规范树 → 工作区日志 → 归档 全链路可用；
- ✅ CLI 集成：`trellis platforms --json` 实跑输出正确、退出码 0；
- ✅ 状态写回：详情抽屉改 status → task.json 落盘 → 监听器自动刷新看板（planning→review→planning 往返验证）；
- ✅ 主题切换（深/浅）即时生效；
- ✅ 打包：`release/win-unpacked/Trellis Panel.exe`（便携版）与 `release/TrellisPanel-Setup-0.1.0.exe`（NSIS，84.5MB）构建成功，打包版启动验证通过。

### 过程中发现并修复的问题
1. 旧版 Trellis 把归档放在 `tasks/archive/YYYY-MM/` 下，扫描器误将其计为任务且解析失败 → 实现双布局归档扫描；
2. 下拉选择状态后点"保存"会被 select 的 blur 先行取消 → 改为选择即保存；
3. electron-builder winCodeSign 解压需要符号链接权限 → 预填充缓存目录绕过（开发者模式缺失环境）。

## 6. 后续路线

- 任务创建/归档操作（封装 `task.py create/archive`）；
- `trellis mem` 会话搜索结果可视化；
- 看板泳道按 assignee 分组、批量操作；
- 多窗口/多项目同时打开；i18n 英文语言包；
- 迁移 Tauri 2 评估（复用同一 React 渲染端与 IPC 契约）。

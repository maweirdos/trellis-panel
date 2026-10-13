# 参考 UI 克隆模块约定（src/renderer/src/my/）

> 来源：任务 10-14-my-ui-shell。改动该模块或新增 `p.*` 色板消费前必读。

## 模块边界

- 整个模块自包含在 `src/renderer/src/my/`：类型(`types.ts`)、演示数据(`data.ts`)、
  自治 zustand store(`store.ts`)、图标(`icons.tsx`)、基础件(`ui.tsx`)、
  令牌与样式(`my-tokens.css` / `my.css`)、外壳(`layout/`)、界面(`pages/`)。
- 与主站唯一集成点：`store/types.ts` 的 `Page` 联合类型含 `'my'` +
  `Sidebar.tsx` 入口 + `App.tsx` lazy 路由。**禁止在模块内 import 主 store（useApp）或 window.api。**
- 开发验证入口：dev 渲染层 URL 加 `?my=1` 直渲染模块（无 IPC 依赖，可用浏览器截图；
  打包后 file: 协议自然失效）。

## 设计令牌（p.* 色板）

- `my-tokens.css` 由 `上游设计令牌包 0.9.7` 令牌脚本解析生成
  （oklch→hex，浅/深两组挂在 `[data-my-theme='light'|'dark']`），**勿手改色值**。
- Tailwind 侧 `colors.p.*`（tailwind.config.js）映射到 `var(--my-…)`，**不支持 alpha 修饰符**。
- 常用类：`bg-my-canvas`、`bg-my-layer-1(-hover/-active/-selected)`、`bg-my-layer-2/3`、
  `bg-my-surface-1/2`、`text-my-primary/-secondary/-tertiary/-placeholder`、
  `text-my-accent-text`、`bg-my-accent(-hover)`、`border-my-line(-1/-strong/-accent)`、
  `text-my-icon-*`、`text-my-danger-text/-warning-text/-success-text/-info-text`、
  `text-my-urgent/high/medium/low/none`（优先级色）、
  `bg-my-label-<fam>` / `text-my-label-<fam>-text` 等（fam: indigo emerald grey crimson yellow orange pink purple）。

## 主题机制

- 主题 = 模块根节点 `data-my-theme` 属性（不是主站的 `dark` 类）；初始值取持久化偏好，
  键 `tpanel.my.ui`（localStorage，遵循 `tpanel.` 前缀约定），存 theme/layout/groupBy/orderBy/customAccent。
- 自定义强调色通过根节点内联覆盖 `--my-bg-accent-primary` 实现。

## 视觉签名组件（icons.tsx，SVG 取自 参考 开源仓库）

- `StateGroupIcon`（backlog 虚线环 / unstarted 空环 / started 进度环+内圈 / completed 实心勾 / cancelled 实心叉）
- `PriorityIcon`（urgent 方块感叹号 / high·medium·low 三阶竖条 / none 横杠）
- `LayoutIcon`（list/board/spreadsheet/gantt/calendar）、`NavIcon`、`WorkspaceMark`。
- 默认状态色：Backlog #A3A3A3 / Todo #3A3A3A / In Progress #F59E0B / Done #16A34A / Cancelled #EF4444。

## 交互约定

- 控制高度体系：`my-control`（28px）/`my-control-sm`（24px）/`my-control-lg`（32px）。
- 弹层动画类：`my-pop`（下拉）、`my-fade`、`my-peek-in`（peek 浮层）；滚动容器用 `my-scrollbar`。
- 下拉统一用 `ui.tsx` 的 `Dropdown`（fixed 定位 + 外点/Esc/滚动关闭）；
  已知测试陷阱：截图工具会触发 resize 导致弹层关闭——自动化验证时用「打开后立即
  evaluate 读取 `.my-pop` 内容或坐标点击」而非截图中间态。
- 字体：Inter Variable（`@fontsource-variable/inter`，注意本仓库 npm install 需 `--legacy-peer-deps`）。

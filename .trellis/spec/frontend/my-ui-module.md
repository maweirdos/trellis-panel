# 外壳 UI 约定（src/renderer/src/my/）

> 外壳 UI 约定。改动该模块或新增 `my.*` 色板消费前必读。

## 模块边界

- 整个模块自包含在 `src/renderer/src/my/`：类型(`types.ts`)、演示数据(`data.ts`)、
  自治 zustand store(`store.ts`)、图标(`icons.tsx`)、基础件(`ui.tsx`)、
  令牌与样式(`my-tokens.css` / `my.css`)、外壳(`layout/`)、界面(`pages/`)。
- 集成点：`App.tsx` 直接渲染 `my/layout/MyApp`（唯一应用壳，路由以主 store `page` 为事实）。
  **禁止在模块内 import 主 store 之外的跨域逻辑；window.api 仅经 `my/store.ts` 的动作桥接使用。**
- 开发验证入口：dev 渲染层 URL 加 `?my=1` 直渲染模块（无 IPC 依赖，可用浏览器截图；
  打包后 file: 协议自然失效）。

## 设计令牌（p.* 色板）

- `my-tokens.css` 为外壳自有设计令牌（浅/深两组挂在 `[data-my-theme='light'|'dark']`），**勿手改色值**。
- Tailwind 侧 `colors.my.*`（tailwind.config.js）映射到 `var(--my-…)`，**不支持 alpha 修饰符**。
- **品牌强调色 = 面板 leaf 绿**：`--my-bg-accent-*` / `--my-border-accent-*` / `--my-txt-accent-*`
  在 my.css 中覆写为 `rgb(var(--leaf-*-rgb))` 引用（非硬编码），自动随面板深浅主题切换；
  改品牌色只动 styles.css 的 leaf 变量。
- **排版/圆角令牌**：`--my-text-2xs..xl`（10/11/12/13/14/16px）与 `--my-radius-sm..xl`（4/6/8/12px）
  定义在 my.css，Tailwind 侧对应 `text-my-2xs..my-xl`、`rounded-my-sm..my-xl`。
  外壳与页面**禁止写死字号/圆角**（text-[13px]/rounded-md 等），一律用令牌类。
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

## 视觉签名组件（icons.tsx，自绘 SVG）

- `StateGroupIcon`（backlog 虚线环 / unstarted 空环 / started 进度环+内圈 / completed 实心勾 / cancelled 实心叉）
- `PriorityIcon`（urgent 方块感叹号 / high·medium·low 三阶竖条 / none 横杠）
- `LayoutIcon`：List/Columns3/Table2/ChartGantt/Calendar；`NavIcon`：LayoutDashboard/Inbox/
  ChartColumn/ListTodo/RotateCw/Box/Eye/FileText/CircleAlert；`WorkspaceMark` 为自拟色块标记。
- 默认状态色：Backlog #A3A3A3 / Todo #3A3A3A / In Progress #F59E0B / Done #16A34A / Cancelled #EF4444。

## 交互约定

- 控制高度体系：`my-control`（28px）/`my-control-sm`（24px）/`my-control-lg`（32px）。
- 弹层动画类：`my-pop`（下拉）、`my-fade`、`my-peek-in`（peek 浮层）；滚动容器用 `my-scrollbar`。
- 下拉统一用 `my/ui.tsx` 的 `Dropdown`（fixed 定位 + 外点/Esc/滚动关闭；开箱后按菜单实测高度定位，
  下方空间不足贴上缘，水平收进视口——不要回退成估算高度）；
  已知测试陷阱：截图工具会触发 resize 导致弹层关闭——自动化验证时用「打开后立即
  evaluate 读取 `.my-pop` 内容或坐标点击」而非截图中间态。
- 字体：Inter Variable（`@fontsource-variable/inter`，注意本仓库 npm install 需 `--legacy-peer-deps`）。

## 旧体系禁用与迁移映射（2026-10 全量统一后生效）

旧面板样式体系（`styles.css` 的 ink/mist/leaf 色板与 `.card/.btn*/.field/.chip` 组件类）已清除，
壳内**禁止再引入**。等价对照：

- 亮/中/暗文本：`text-my-primary / secondary / tertiary / placeholder`；表面：`bg-my-canvas`（页底）、
  `bg-my-layer-1/2/3`（凹→凸）、`bg-my-surface-1/2`（输入/嵌入面）、`border-my-line(-strong)`。
- 品牌强调（原 leaf 系）：`bg-my-accent(-hover)`、`bg-my-accent-subtle(-hover)`、`text-my-accent-text`、
  `border-my-line-accent(-subtle)`。语义彩色一律成对：`bg-my-<sem>-subtle + text-my-<sem>-text`
  （sem: success/warning/danger/info），描边用 `border-my-line-<sem>`。
- 徽标基类 `my-chip`（my.css，20px 高）+ 语义色类；彩色标签用 label 族
  `bg-my-label-<fam> / text-my-label-<fam>-text / border-my-label-<fam>-border`。
- **`my.*` 色板不支持 alpha 修饰符**（禁写 `bg-my-accent/20`），半透明场景用 subtle/hover 令牌。
- 字号/圆角只用令牌类（`text-my-2xs..my-xl`、`rounded-my-sm..my-xl`），禁写死 px 与裸 tailwind 档位；
  按钮统一 `my/ui.tsx` 的 `Button`，输入用 SearchInput 同款工具类。
- styles.css 现仅存：leaf 变量（品牌色桥）、全局基础、令牌化的 `.md` 排版块、
  `[data-my-theme='dark']` 祖先选择器的 `.arch-*`、透明窗阴影类（`.capsule-*`）。
- 令牌作用域在 `.my-root`：CapsuleView/QuickTodoView 等独立窗口的根节点必须带
  `my-root` + `data-my-theme`（App.tsx 已处理，新增窗体时照做）。
- 类有效性自查：TSX 用到的 `my-*` 类必须能在构建产物 CSS 中找到（脚本
  `.trellis/tasks/10-15-unify-plane-uiux/check_my_classes.py`，可复用为门禁）。

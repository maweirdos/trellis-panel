---
name: ui-interaction-craft
description: Design, implement, or review platform-aware UI interactions and microinteractions for desktop apps, responsive web, mobile apps, and mini programs. Use when refining motion, feedback, loading, overlays, focus, or navigation within an existing design system.
---

# UI Interaction Craft

## 确定运行环境

- 先读取项目的 AGENTS.md、设计令牌和组件规范。存在 `.trellis/spec/frontend/design-principles.md`、`css-design.md`、`components.md` 时按项目入口要求读取，路径相对项目根目录解析。
- 从代码、发布目标和组件库识别运行环境：桌面应用、浏览器网页、移动 App 或小程序；再确认系统、渲染层、输入方式与可用空间。
- Flutter、React Native、uni-app、Taro 等框架名不代表发布端；依据实际构建目标与渲染层选路。
- 窄桌面窗口仍使用桌面的键盘和窗口契约；触屏电脑、平板与外接键盘按实际输入能力适配。断点决定布局，不决定运行环境。
- 运行环境不明确且会改变交互选择时，只询问缺失的目标平台或宿主，不自行把原生 App、小程序当成移动网页。
- 未列出的系统或宿主先核对其官方控件、导航与能力契约，不按相近平台猜测 API 和默认行为。

## 按场景读取

先读 [通用交互规则](references/foundation.md)，再读取目标平台与相关主题；不一次加载所有平台文件。

| 目标 | 读取规则 |
| --- | --- |
| 桌面客户端、多窗口工作台 | [桌面端](references/platforms/desktop.md)；Electron、Tauri 等 DOM 界面同时读取网页中的焦点和滚动要求 |
| 桌面网页、移动 H5、PWA | [网页端](references/platforms/web.md)，分别核对鼠标键盘与触控输入 |
| iOS、Android App，包括其 React Native / Flutter 实现 | [移动 App](references/platforms/mobile-app.md)，按系统和实际渲染层选择实现 |
| 微信、支付宝、抖音等小程序 | [小程序](references/platforms/mini-program.md)，先确认宿主、基础库与渲染能力 |
| App 内 WebView、小程序 web-view 等混合页面 | 同时读取网页规则和实际宿主规则，明确键盘、返回、权限、原生弹层的归属 |
| 打字、计时器、展开、拖拽、加载或主题 | [动效与阅读](references/motion-and-reading.md) |
| 字段错误、警示、提示、菜单或模态任务 | [反馈与弹层](references/feedback-and-overlays.md) |
| 实施完成或检查交互 | [验收](references/validation.md)，只覆盖目标平台与实际输入方式 |

## 实施

1. 确定当前任务、状态来源、影响范围，以及是否必须由用户作决定；再选择反馈形式和展示位置。
2. 区分通用行为与平台实现：跨端共享反馈职责、真实状态、稳定阅读和可中断性；弹层形态、焦点、返回与单位服从目标平台。
3. 复用既有组件、令牌和原生行为。系统控件已有按压、涟漪或触觉反馈时，不叠加另一套自绘反馈。
4. 确认重复操作、取消、恢复、异步响应归属和生命周期清理，再实现动效。业务完成不等待装饰动画。
5. 自绘动效使用当前渲染层适合的属性与动画机制；DOM/CSS 配方只用于支持它们的环境，原生和小程序使用对应布局能力。
6. 新建验证示例时明确数据来源；交付验证结论时区分隔离组件、浏览器、模拟器、真机与实际宿主，不扩大证据范围。

项目令牌决定视觉，平台能力与交互语义决定实现；通用动效基准不能覆盖系统行为。遇到无法同时满足的约束，说明具体冲突与可行取舍，不擅自改动业务语义。

## 约束

- 交互改动围绕实际功能，不为统一外观更换框架、组件库或重写无关页面。
- 短成功反馈可以轻弹；结构性弹层快速收束，拖动直接跟手。按压反馈不改变控件布局，按钮图标与真实状态同步。
- 动效、加载提示和播报有停止条件；取消、替换、离开或卸载后清理局部活动，界面隐藏不等于后台任务已取消。
- 原生对话框和宿主权限能力使用各自 API；自绘确认不代替真实权限授权。
- 必要说明和恢复动作可直接发现，不依赖悬停、长按、拖拽或短暂提示才能完成关键任务。
- 文档直接写场景、行为、参数、边界和验收条件；删除格式声明、整理背景、会话记录和采纳状态。

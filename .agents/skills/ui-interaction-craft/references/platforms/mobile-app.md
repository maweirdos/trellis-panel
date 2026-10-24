# 移动 App

## 系统与渲染层

- 区分 iOS、Android，以及原生、React Native、Flutter 和 WebView 的实际渲染层。
- 使用已有系统或框架控件的语义、触控反馈和可访问能力，不把 DOM 的 Portal、ARIA、CSS Grid 或字体属性直接套入原生视图树。
- WebView 内容同时遵守网页规则；宿主负责的键盘、返回、权限和原生呈现由宿主接管，避免重复处理。
- 平板、折叠屏、横屏和外接键盘按可用空间与输入能力适配，不因 App 身份固定成单手竖屏布局。

## 触控与文本

- iOS / iPadOS 可从 `44 × 44pt` 的默认控件尺寸起调，紧凑控件仍需满足平台可访问性和间距要求；不要把 iOS 数值套到 macOS。
- Android 交互命中范围按至少 `48dp` 检查，保留系统组件的有效触控区域；视觉图标不必扩大到同样尺寸。
- 使用平台单位、动态字号和安全区。大字号下主要操作可达，正文不被固定卡片高度裁掉。
- 原生按钮已有高亮、涟漪或触觉反馈时保持一致，不为每次点击叠加一套回弹与震动。
- 重要说明直接可见或可点击获取；长按只作平台允许的补充，并避免与文本选择、系统菜单和拖动冲突。

## 任务与弹层

| 任务 | iOS / iPadOS | Android |
| --- | --- | --- |
| 重要警示与二选一确认 | 系统 Alert 和正确的取消、危险动作角色 | 现有 AlertDialog / 对话框组件，区分确认与关闭回调 |
| 用户主动动作的多项选择 | 系统动作菜单或 confirmation dialog | 合适的菜单、动作选择组件或底部选择面板 |
| 当前上下文中的短任务 | 合适的系统模态呈现，保留取消和完成 | 现有上下文任务容器，返回与关闭明确 |
| 复杂表单或多步流程 | 独立导航页面，或需要完整空间的任务呈现 | 独立页面或清楚的任务流程 |

- 系统对话框的按钮角色、顺序和默认行为遵循平台规范，不手工统一成网页左右排列。
- Apple 系统取消角色与默认按钮不是网页初始焦点的直接映射；需要防止误确认时按平台方式处理默认动作，不机械设置取消为系统默认按钮。
- 单纯告知普通状态不反复使用系统 Alert，失败和字段问题优先留在受影响内容旁。
- 对于有草稿的交互式关闭，明确保留、放弃和继续编辑；只有明确选择才能丢弃数据。
- 系统动作选择面板只承载合适数量的选项，不替代长详情和多步表单。

## 返回、手势与键盘

- 保留系统返回、边缘手势和允许的交互式关闭，不用网页 Escape 模型代替系统导航。
- Android 使用当前导航栈支持的 Back / Predictive Back 机制；手势开始只预览，完成后才提交返回，取消时恢复原状态。
- 输入法、系统临时界面和应用导航的返回处理由对应层级拥有，避免一次返回既收键盘又误退出任务。
- iOS 交互式关闭与返回遇到未保存内容时，按平台能力保留草稿并处理必要选择，不把所有视图都禁止手势关闭。
- 键盘升起后字段、错误和提交动作可见；安全区、输入法区域与框架补偿不重复叠加。
- 外接键盘和 VoiceOver / TalkBack 可到达所有关键动作；模态退出后恢复合理焦点，不使用 DOM 属性替代原生可访问语义。

## 生命周期

- 前后台切换、系统回收、方向和窗口模式变化不丢失必要草稿或误报任务结果。
- 局部等待与动画随页面状态停止或恢复，后台任务是否取消依据真实能力判断。
- 完成量、计时和流式内容按真实状态恢复，不靠重新播放一遍动画重建业务状态。
- 在实际支持的系统版本和物理设备上验证键盘、系统呈现、手势取消、减少动效与辅助技术。

## API 参考

- [Apple Alerts](https://developer.apple.com/design/human-interface-guidelines/alerts)、[Action Sheets](https://developer.apple.com/design/human-interface-guidelines/action-sheets)、[Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets)
- [Apple Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
- [Android Dialog](https://developer.android.com/develop/ui/compose/components/dialog)、[Accessibility Defaults](https://developer.android.com/develop/ui/compose/accessibility/api-defaults)
- [Android Predictive Back](https://developer.android.com/guide/navigation/custom-back/predictive-back-gesture)

# T1 触达扩展：通知点击直达+托盘回读+右键菜单+任务分享链接

## Goal

补全 06 v2 §2 支柱一的"生成即读"闭环与触达面：材料更新在面板隐藏时也有系统通知且点击直达该任务；托盘一键回到上次阅读；资源管理器右键直达阅读；任务级深链可复制分享。

## Requirements

1. **系统通知直达**：材料更新合并事件在主窗隐藏/失焦时补发系统通知，点击 → showMain + pushFocusTask（复用既有 bridgeTaskFocus 聚焦链，含跨项目切换）；窗口可见且聚焦时不重复弹系统通知（应用内 toast 已足够）。
2. **托盘回读**：托盘菜单新增"回到上次阅读"，与全局热键同路径（showMain + focusLastReading 广播）。
3. **右键菜单**：设置新增"资源管理器右键'用 Trellis Panel 阅读'"开关——仅打包版 Windows（开发态禁用防劫持 electron.exe）；写 HKCU\Software\Classes\Directory\shell（幂等 /f，关闭即删）；命令走 trellis-panel://open-task?dir=%V 深链，由既有 second-instance/冷启动链路接手（含上溯找 .trellis）。
4. **任务分享链接**：工作台头部新增"复制任务链接"按钮；URL 为 trellis-panel://open-task?dir=<任务绝对路径>&t=<token>，token 仅在主进程拼装（渲染层不接触）；本机任意输入处粘贴运行可直达该任务。
5. 标题/文件级锚点深链与链接分级（只读导航/分享/操作）属后续迭代，本版先落任务级。

## Acceptance Criteria

- [x] typecheck（node+web）与 build 通过。
- [x] 通知链路编译期完整：material settle → 窗口隐藏判定 → toastFocusTask → showMain+pushFocusTask。
- [x] 右键集成：非打包/非 Windows 返回 supported:false 且设置开关提示原因；开关状态持久化（desktop.explorerContextMenu）。
- [x] 分享链接：token 不出现在渲染层代码；encodeURIComponent 编码路径。
- [x] 无越权写入：HKCU 注册表为唯一系统级写入，且由用户显式开关控制。

## Notes

- 托盘双击仍为打开面板（不改动既有习惯）。
- 执行与验证记录见 implement.md。

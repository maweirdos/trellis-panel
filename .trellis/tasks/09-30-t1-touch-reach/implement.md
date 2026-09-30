# 执行计划（已执行）

1. state.ts：新增 toastFocusTask（点击 → showMain + pushFocusTask）；material settle 处按主窗可见且聚焦判定，隐藏/失焦时补发系统通知（visibleFocused 判定用 getMainWindow）。
2. index.ts：托盘菜单第二项"回到上次阅读"（showMain + focusLastReading 广播）。
3. services/explorer-menu.ts：reg add/delete（execFile 传参，无 shell 拼接）；explorerMenuSupported = win32 && app.isPackaged；命令 `"exe" "trellis-panel://open-task?dir=%V&t=<token>"`。
4. ipc-channels：task.buildTaskLink + desktop.setExplorerMenu；ipc/tasks.ts buildTaskLink（token 主进程拼装、路径 encodeURIComponent）；ipc/settings.ts setExplorerMenu（supported 判定 + 注册表操作 + 设置持久化）。
5. preload/types：taskBuildTaskLink、desktopSetExplorerMenu 暴露。
6. 渲染端：Settings 桌面区新增右键集成开关（失败 toast 提示原因）；任务工作台头部新增 Link2"复制任务链接"按钮 + copyTaskLink handler。

## 验证记录

- typecheck node+web 通过；build 通过（651ms）。
- 注册表路径仅 HKCU\Software\Classes\Directory\shell\TrellisPanelOpen；删除用 /f；失败不阻塞设置流程（reason 回传）。
- 深链接手链路复用：argv[1]（second-instance）/冷启动 parseDeepLink → handleDeepLink 上溯 .trellis → openProjectAt → pushFocusTask（FR 已验证该链）。

## 已知取舍

- 目录右键仅注册 Directory（具体文件夹）；Directory\Background（空白处右键）未注册，避免误触发，需要再加一行。
- 系统通知与应用内 toast 在"窗口可见但失焦"时会同时出现一次——保留：点击任一均可直达，噪声可接受。

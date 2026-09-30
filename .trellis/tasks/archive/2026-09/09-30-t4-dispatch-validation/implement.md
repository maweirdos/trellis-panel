# 执行计划（已执行）

1. services/channel-dispatch.ts：step()（shell+quoteArg+超时树杀，沿用 services/cli.ts 模式）；runReadonlyReview 六步序列；buildPrompt 三段固定格式；extractReport（--raw JSON 行倒序取 payload.text）；abortDispatch 树杀。
2. IPC：task.dispatchReview / task.dispatchAbort + ipcEvent.dispatchPhase；channels/preload/types 全链（含 DispatchPhase 类型）。
3. DispatchModal.tsx：阶段进度（done/active/pending）、报告 MarkdownView、错误条、重跑、关闭即中止。
4. Tasks.tsx 工作台头部 ShieldCheck（紫色）按钮接入。

## 验证记录

- typecheck node+web 通过；build 通过（667ms）。
- 命令拼装干跑六步正确；发现并修复：多行 prompt 不能走 --message（cmd.exe 换行会碎）→ 改 --message-file 临时文件（tmpdir，finally 清理）。
- 冒烟脚本的路径显示烂掉是 heredoc 转义层问题，服务代码经 Write 直写不受影响（正则/字面量复核 + typecheck 双绿）。

## 已知取舍 / 后续

- provider 钉死 codex（read-only 沙箱仅 codex 有效）；claude 审阅待官方沙箱能力或另行评估。
- 运行侧门禁（真实拉起 worker 一次）由用户执行——本切片不代替该验证，通过前不开 planner/三段式归档。
- worker guard 仪表（F38）与频道列表视图未包含，随验证通过后的派单台扩展。

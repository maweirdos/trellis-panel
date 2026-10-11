# v2 规划一致性检查

日期：2026-10-11。**结论：规划一致性复核通过，任务保持 planning。**

## 检查范围

本次检查 PRD、design、implement、task.json、两份上下文清单和 R01–R12 修订映射。采用文档/现有源码对照与只读复核，没有开始产品实现。

原审查中的 12 项问题已落实到当前规划。二次复核额外发现并修正了五处契约缺口：

1. 观测数据库与本地任务控制记录分开；清理/损坏观测不删除恢复记录，控制写失败先停止创建副作用。
2. 事件、数据库、IPC 按项目规范统一 Unix 毫秒。
3. 创建任务按现有 CLI 的日期与扁平 --meta 语义执行；跨午夜、中止和重复点击先按 operationId 对账。
4. 绑定增加仓库外 installationId，检测另一机器同路径的仓库复制。
5. PRD 保留完整可取得的 Jira 规范化描述；摘要、缺失和裁剪有各自用途及提示。

限定复核未再发现未闭合的文字矛盾。具体位置见 [修订映射](04-revision-resolution.md)。

## 本轮验证

- `task.py validate .trellis/tasks/10-11-cockpit-s0-glass-box`：通过；implement 14 条、check 11 条有效上下文引用。
- 当前规划及审查文档的本地链接、JSON/JSONL、Markdown 围栏、FR1–FR5/AC1–AC10 覆盖：通过。
- v1 六份快照与原 approval.json 的 SHA-256：一致；保留原稿及审查锚点。
- 产品代码未修改，未启动任务，任务状态保持 planning。

## 结论的边界

本次没有运行产品 typecheck/build、SQLite 跨进程/打包测试、真实 Hook、公司 Jira 或 UI 实测；文档校验不代替这些验收。G0–G5 给出了对应进入条件、实施步骤、回退点和证据要求。

当前版本摘要及文件 hash 见 [revision-v2.json](revision-v2.json)。本记录只证明规划检查完成，不是实施授权或发布批准。

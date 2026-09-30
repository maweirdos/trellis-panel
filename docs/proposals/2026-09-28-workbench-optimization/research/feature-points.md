# 功能点清单（F 编号唯一来源）

> 日期：2026-09-30。来源：2026-09-29/09-30 两轮 Trellis 官方文档研读会话（stable 版 15 页：architecture、dynamic-spec-loading、custom-workflow、custom-agents、custom-hooks、custom-skills、spec-template-marketplace、configuration、multi-platform、appendix-a/b/c/d/f、channel）。
> 用途：`06` 等方案文档中引用的 F 编号以此文件为准；未收录于此的编号视为废弃。
> 诚实声明：第 6–15 课的 F27–F38 在会话中逐条明确编号，此处完整收录；第 1–5 课的 26 点（L1:7 / L2:5 / L3:5 / L4:5 / L5:4）当时未逐条落盘原文，本文件按主题归并重建，仅个别编号（#1、F24）有会话原文依据，其余以主题组呈现、不再保证原编号对应关系。

## 一、第 6–15 课（F27–F38，逐条收录）

| 编号 | 功能点 | 来源课程（官方文档） | 当前归属 |
| --- | --- | --- | --- |
| F27 | 技能透视：扫描 `.agents/skills/` 与平台技能目录的 SKILL.md frontmatter，展示已装自动化行为与声明的触发条件；双目录漂移告警 | custom-skills | T2（技能与平台视图） |
| F28 | spec 模板库接入：`--registry` 初始化模板选择器（读 index.json）；已有项目与模板仓库的 spec 对账 diff（只读+建议，不自动同步） | custom-spec-template-marketplace | T5 |
| F29 | 配置设置页：解析 config.yaml 做"生效值 vs 内置默认值"对照；hooks 区块可视化编辑（F24 合并）；hook 命令含疑似 token/绝对路径时红色警告 | configuration | T5 |
| F30 | 平台能力体检：检测已 init 的平台目录并对照能力矩阵（启动注入/子代理注入/命令形态），给补救提示（如 Codex `features.hooks`） | multi-platform / appendix-a | T2 |
| F31 | 团队成员视图：读 `.trellis/workspace/*/index.md` 与 journal 摘要，展示成员、最近会话、活跃任务 | appendix-a / FAQ | T5 |
| F32 | 文件地图：附录 A 路径速查做成可点击导航 + 存在性检查（缺失标红），点击打开文件/目录 | appendix-a | T2（并入 F30 视图） |
| F33 | 命令中心：task.py 子命令与 get_context.py 表单化（填参数生成可复制命令或代跑）；优先 set-branch/add-subtask/add-context；归档动作代跑官方脚本（随 T4 三段式落地） | appendix-b | T3（代跑按字段权限）；归档部分 T4 |
| F34 | 任务详情全字段 + 父子任务树：按 schema 五组展示全字段；列表增加 parent/children 树视图；占位字段（worktree_path/commit/pr_url）引导写入 meta | appendix-c | T5 |
| F35 | 上下文引用清单编辑器：jsonl 结构化行编辑（file/type/reason），校验官方内容准则（代码文件不进清单；目录条目 .md≤20）——v2 已并入"上下文预期诊断"（06 §3.2） | appendix-d | T2 |
| F36 | 升级向导：读 `.trellis/.version` 对比 npm latest/beta；两步升级引导；`--dry-run` 输出解析 + `.template-hashes.json`"你改过哪些模板文件"预览 | appendix-f / FAQ | T5 |
| F37 | channel 运行时对接：枚举官方项目桶（`~/.trellis/channels/`），渲染运行事件流/worker 状态/启动上下文快照；interrupt/kill 按钮（带确认）——注意 v2 口径：非逐轮回执 | channel | T4/T5（图3） |
| F38 | worker guard 仪表：活 worker 数 vs `max_live_workers`、闲置倒计时 vs `idle_timeout` 展示 | channel / configuration | T4 |

## 二、第 1–5 课（26 点，按主题归并重建）

以下为主题组重建（原逐条编号未落盘，不与新编号混用）：

1. **会话×任务绑定展示**（原 #1，有会话原文依据）：读 `.trellis/.runtime/sessions/*.json` 展示"哪个平台会话绑了哪个任务、最后记录时间"——已被 05/06 吸收（侧栏活跃会话、"最后记录"措辞纪律）。
2. **hooks 可视化配置**（原 F24，有会话原文依据）：config.yaml hooks 区块编辑 + 员工档案提示——已并入 F29/T5。
3. **workflow 健康检查**（L3，custom-workflow）：标签块完整性 INVARIANT 校验、面包屑注入链路检查——已演化为 06 §3.2"规则预览 + 会话诊断"（T2）。
4. **Jira 归档闭环 hook**（L5，custom-hooks）：仿 linear_sync.py 的 after_archive 同步设计——已被 05"不做清单"（双向自动流转）与 P0-5 对账化取代，**废弃**。
5. **其余早期想法**（L1 架构 / L2 动态 spec / L4 子代理目录透视等主题）：spec 索引导航、版本显示、代理档案展示等，未被后续文档吸收的视为候选池，进 T5 按使用证据挑选。

## 三、编号使用规则

- 方案文档引用 F 编号时必须能在本文件找到对应行；找不到即删除引用。
- 功能点被吸收进 FR/T1–T5 后标注归属；被否决的标"废弃"并注明原因（如 F4 组）。
- 本文件随方案演进更新，是唯一增删处。

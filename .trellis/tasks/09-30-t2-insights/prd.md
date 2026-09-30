# T2 透视中心切片：任务透视弹窗（文件事实+流程参考+上下文预期诊断）

## Goal

落地 06 v2 §三透视中心的首个切片：每任务"任务透视"弹窗，合并文件事实、流程参考（规则预览）与上下文预期诊断三视图。不重造 Studio 已有的 workflow 编辑/技能清单。

## Requirements

1. **文件事实**：prd/design/implement/jsonl/research 存在性徽标（已找到/未找到/无法读取），task.json 解析错误红色申报；归档位置标注。不做任何执行位置推断。
2. **流程参考（规则预览，零执行）**：workflow.md 行级解析（定界行整行精确匹配，与 Studio 校验器同口径）——① 正文 Phase Index 下的阶段小节投影为阶段条；② [workflow-state] 面包屑块按状态选块预览"AI 在该状态每轮收到的规则文本"。解析失败降级为提示，不自动套固定节点。**纯静态渲染，不运行任何脚本**。
3. **上下文预期诊断**：解析任务 implement.jsonl / check.jsonl，按 hook 链默认上限（单文件 32768B 截断但保留路径；累计 131072B 超出降级为索引行）给出四档预期：完整内联/预期截断/降级为索引行/文件缺失；累计用量百分比；脚注声明"预期注入行为 ≠ 模型实际读取或遵守；channel 链另一套上限不在本表"。
4. 入口：任务工作台头部 ScanSearch 按钮。

## 明确移出（记录）

- 会话诊断视图（真实会话绑定/配置展示）→ sessions 数据已在 Dashboard 展示，细化随 T5。
- 技能声明条件视图 → Studio 技能 tab 已有清单，触发条件列随 Studio 迭代。
- context_injection 配置覆盖读取（现按默认上限估算）→ 后续接 config.yaml 解析。

## Acceptance Criteria

- [x] typecheck（node+web）+ build 通过。
- [x] 真数据冒烟：行级解析出 8 个状态块（含 task_error 与 inline 变体）；no_task 块首行与真实面包屑注入一致；Phase Index 阶段条正确提取。
- [x] 规则预览零脚本执行（纯 markdown 行解析）。
- [x] 预期诊断措辞合规（"预期"限定语常驻；不做"AI 已读"暗示）。

## Notes

- 发现记录：[workflow-state] 块是每轮面包屑提示词（1-4 行），阶段文档在正文 Phase Index——两者都进视图，正好构成"流程参考 + 规则预览"。
- 执行与验证记录见 implement.md。

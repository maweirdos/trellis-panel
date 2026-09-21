# roadmap 清扫（残留子项）

## Requirements
- R1 response 格式图像分片：user 消息含图时 input 升维为 [{type:'input_text'},{type:'input_image',image_url}]。
- R2 截图一键问 AI：chat:screenshot 通道 capturePage 当前窗口 → PNG dataURL 作为附件进 composer 流程。
- R3 分支局部视图：chat:branch 切换后自动下潜到该分支最深后代叶（切回旧分支=看到完整旧问答而非截断在提问处）。
- R4 激活工具恢复：会话记录 activeTools（成功执行过的工具）；agent 循环请求仅携带 activeTools 的 schema（无记录则全量），上下文经济性落地。
- R5 观察项冻结：语音/i18n/图片生成/面板插件化标注"冻结待用户确认"。
- R6 冒烟：response 图像分片请求体断言；activeTools 恢复后 tools 数组仅含激活项断言；分支下潜断言。

## Acceptance Criteria
- [ ] AC1 response 格式带图请求体含 input_image 分片（冒烟）。
- [ ] AC2 agent 会话第二轮请求 tools 仅含成功执行过的工具（冒烟）。
- [ ] AC3 branch 切换后 activeLeaf 自动下潜至最深后代（冒烟）。
- [ ] AC4 typecheck 全绿 + 六套冒烟回归全过。

# 多模态图片输入（roadmap #7）

## Requirements
- R1 ChatMessage 增可选 `images: [{mediaType, dataBase64}]`；随节点持久化、活跃路径透传、TPAP chat/session 只读面自动可见。
- R2 aiChatStream 按协议构造图像分片：openai→content 数组含 image_url(dataURL)；anthropic→content 数组含 image(source.base64)；ollama→message.images=[base64]；response 格式 v1 不支持（文档注明）。
- R3 composer：文件选择（多选，≤4 张，单张 ≤4MB dataURL）+ textarea 粘贴图片；预览 chip 可移除；超限 toast 拒绝。
- R4 用户气泡渲染图片缩略图。
- R5 冒烟：chat.mjs 断言请求体 user 消息 content 数组含 image_url 分片（base64 非空）且业务流程不回归。

## Acceptance Criteria
- [ ] AC1 带图发送：请求体含图像分片、回复流式正常、落库消息含 images（冒烟）。
- [ ] AC2 超限图片被拒（冒烟或代码路径断言）。
- [ ] AC3 typecheck 全绿 + 五套冒烟回归全过。

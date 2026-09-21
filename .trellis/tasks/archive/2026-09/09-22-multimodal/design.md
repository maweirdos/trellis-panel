# 技术设计（TPD-019）

- ChatImage = { mediaType: string; dataBase64: string }；ChatMessage.images?: ChatImage[]。
- 渲染层以 dataURL 传输（FileReader.readAsDataURL）；chat 服务解析 dataURL 前缀还原 mediaType/base64。
- 协议分片（仅 user 消息且 images 非空时把 content 升维为数组）：
  openai: [{type:'text',text},{type:'image_url',image_url:{url:`data:${mediaType};base64,${b64}`}}]
  anthropic: [{type:'image',source:{type:'base64',media_type,data}},{type:'text',text}]
  ollama: message.images=[b64]
- 门槛：单张 dataURL ≤ 4MB、每消息 ≤ 4 张；超限在 send 入口过滤并在结果报错。

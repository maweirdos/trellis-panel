import type { JSX } from 'react'

export function describeConnectionError(message: string): { title: string; hint: string } {
  if (/session is in use by another|already in use|session.*locked/i.test(message)) return {
    title: '原会话正被其他客户端占用', hint: '请在占用它的 Codex 窗口、终端或 IDE 中关闭该会话，再重试连接。草稿和历史已保留。'
  }
  if (/OpenCode.*free tier|OpenCode Zen Free/i.test(message) && /403|Forbidden|only.*within OpenCode/i.test(message)) return {
    title: '模型服务拒绝了当前请求', hint: '此免费服务仅允许在 OpenCode 内使用。请切换可用于当前执行引擎的模型或服务配置。'
  }
  if (/authentication required|AUTH_REQUIRED|not authenticated|not logged in|\b401\b/i.test(message)) return {
    title: '执行引擎需要登录或有效凭据', hint: '请检查本机执行引擎的登录与服务配置，完成后重试连接。'
  }
  return { title: '请求未完成', hint: message.length <= 180 ? message : '详细原因见下方。草稿和历史已保留。' }
}

export function ConnectionNotice({ message }: { message: string }): JSX.Element {
  const { title, hint } = describeConnectionError(message)
  return <div role="alert" className="acp-connection-notice">
    <strong>{title}</strong><p>{hint}</p>
    <details><summary>错误详情</summary><pre>{message}</pre></details>
  </div>
}

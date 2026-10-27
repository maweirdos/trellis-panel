export function modelErrorSummary(message: string, fallback = '模型测试失败'): string {
  const status = message.match(/\bHTTP\s+(\d{3})/i)?.[1]
  let code = ''
  try {
    const start = message.indexOf('{')
    const value: unknown = JSON.parse(start >= 0 ? message.slice(start) : message)
    if (value && typeof value === 'object') {
      const root = value as Record<string, unknown>
      const error = root.error && typeof root.error === 'object' ? root.error as Record<string, unknown> : root
      code = typeof error.code === 'string' ? error.code : typeof error.type === 'string' ? error.type : ''
    }
  } catch { /* A plain-text or bounded response still remains available in details. */ }
  const suffix = code ? `（${code.slice(0, 80)}）` : status ? `（HTTP ${status}）` : ''
  if (/model_price_error|cpa_key_billing_error/i.test(message)) return `模型计费配置错误${suffix}`
  if (status === '401' || status === '403') return `认证失败，请检查密钥或访问权限${suffix}`
  if (status === '429') return `请求受限，请检查额度或稍后重试${suffix}`
  if (status === '404') return `接口或模型不存在${suffix}`
  if (status && Number(status) >= 500) return `上游服务暂不可用${suffix}`
  if (suffix) return `${fallback}${suffix}`
  return message.trim().split('\n')[0]?.slice(0, 140) || fallback
}

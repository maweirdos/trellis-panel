// 保守的错误文案提取：主进程与渲染进程共用（替代 catch 块里带 any 标注的 `e?.message` 取值）。
// 只识别带 string message 的对象（Error / DOMException / 普通 { message } 对象），
// 其余形态返回 undefined，由调用方决定 fallback —— 与旧的 `e?.message ?? fallback` 语义对齐。

export function errorMessage(e: unknown): string | undefined {
  if (typeof e === 'object' && e !== null && 'message' in e) {
    const msg = (e as { message?: unknown }).message
    if (typeof msg === 'string') return msg
  }
  return undefined
}

export function errorText(e: unknown, fallback: string): string {
  return errorMessage(e) ?? fallback
}

/** fetch abort 抛出的 AbortError（DOMException / Error 均带 name 字段） */
export function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'name' in e && (e as { name?: unknown }).name === 'AbortError'
}

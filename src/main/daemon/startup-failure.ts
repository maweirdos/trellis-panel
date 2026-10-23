import { nativeDiagnosticSchema } from './native-diagnostic'

/** Startup diagnostics must never serialize arbitrary exceptions or settings. */
export function daemonStartupFailure(error: unknown, stage: 'load' | 'run'): string {
  const value = error && typeof error === 'object' ? error : null
  const code = value && 'code' in value && typeof value.code === 'string' && /^(?:E_[A-Z_]+|ERR_[A-Z_]+|MODULE_NOT_FOUND|ENOENT|EACCES|EPERM)$/.test(value.code) ? value.code : 'UNKNOWN'
  const name = error instanceof Error && ['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'ZodError'].includes(error.name) ? error.name : 'Error'
  const missing = error instanceof Error && code === 'MODULE_NOT_FOUND' ? /^Cannot find module '([@\w./\\:-]{1,180})'/.exec(error.message)?.[1] : undefined
  const frame = error instanceof Error ? error.stack?.split('\n').find(line => /^\s+at /.test(line) && /:\d+:\d+\)?$/.test(line))?.trim().slice(0, 300) : undefined
  const native = value && 'nativeDiagnostic' in value ? nativeDiagnosticSchema.safeParse(value.nativeDiagnostic) : null
  const detail = native?.success ? `; native ${native.data.operation}/${native.data.exception}/${native.data.hresult}${native.data.command ? `/${native.data.command}` : ''}${native.data.line ? `/line ${native.data.line}` : ''}` : ''
  return `Daemon startup ${stage} failed [${code}/${name}]${detail}${missing ? `; missing module: ${missing}` : ''}${frame ? `; ${frame}` : ''}. Preserve the original owner/state.\n`
}

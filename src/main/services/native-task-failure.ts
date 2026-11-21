import { z } from 'zod'
import { nativeTaskFailureSchema, teamTransportFailureSchema, type NativeTaskFailure } from '../../shared/native-task-failure'
import { DesktopTeamError } from './team-platform/types'

/** Preserve a typed local cause across ACP without retaining arbitrary error text. */
export function nativeTaskFailure(error: unknown, phase: string): NativeTaskFailure {
  const inherited = nativeTaskFailureSchema.safeParse(error && typeof error === 'object' && 'taskFailure' in error ? error.taskFailure : undefined)
  if (inherited.success) return inherited.data
  const transport = teamTransportFailureSchema.safeParse(error instanceof DesktopTeamError ? error.transport : undefined)
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'NATIVE_FAILURE'
  const message = error instanceof Error ? error.message : ''
  const reason: NativeTaskFailure['reason'] = transport.success ? 'transport' : error instanceof z.ZodError ? 'validation'
    : /embeddedContext|context capability|context transport/i.test(message) ? 'context-capability'
      : /budget|oversize|exceeds.*bytes|too large/i.test(message) ? 'context-budget'
        : /fixed.*(?:input|source|digest)|platform (?:input|aggregate)|captured.*(?:input|bytes)/i.test(message) ? 'context-mismatch' : 'native-failure'
  return { phase, code: /^[A-Z0-9_:-]{1,100}$/.test(code) ? code : 'NATIVE_FAILURE', reason,
    ...(transport.success ? { transport: transport.data } : {}) }
}

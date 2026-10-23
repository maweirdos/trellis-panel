import type { DaemonFailure } from '../../shared/daemon'

export class DaemonError extends Error {
  constructor(readonly code: DaemonFailure['code'], message: string, readonly outcome: DaemonFailure['outcome'] = 'not-admitted') { super(message) }
}
export function daemonFailure(error: unknown, commandId?: string): DaemonFailure {
  return {
    ok: false, code: error instanceof DaemonError ? error.code : 'E_IO',
    error: error instanceof DaemonError ? error.message : 'Daemon operation failed; inspect native state before retrying.',
    outcome: error instanceof DaemonError ? error.outcome : 'unknown', ...(commandId ? { commandId } : {})
  }
}

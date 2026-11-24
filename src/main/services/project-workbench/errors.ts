import type { IpcErrorCode } from '../../../shared/ipc-errors'

export class WorkbenchError extends Error {
  constructor(readonly code: IpcErrorCode, message: string, readonly outcome?: 'unknown') { super(message) }
}

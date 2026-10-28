import type { AcpSessionRecord, AcpSessionStatus } from '../../../shared/types'
import type { TaskProgressNativeInput } from '../../../shared/hifox-task-progress-native'

type Summary = Extract<TaskProgressNativeInput, { operation: 'report' }>['summary']
type Owner = Pick<AcpSessionRecord, 'sessionId' | 'projectRoot' | 'cwd' | 'connectionGeneration' | 'backendSessionId'>
export interface TaskProgressEvents {
  state(owner: Owner, status: AcpSessionStatus, outcome?: 'completed' | 'cancelled' | 'failed'): void
  report(owner: Owner, summary: unknown): Promise<{ queued: true; acknowledged: false }>
  context(owner: Owner): { id: string; version: string; title: string; body: string } | undefined
}
let sink: TaskProgressEvents | undefined
export function installTaskProgressEvents(value: TaskProgressEvents): () => void {
  if (sink) throw new Error('Task progress already has a daemon owner')
  sink = value
  return () => { if (sink === value) sink = undefined }
}
/** Only lifecycle state reaches the progress store, never tool output or transcript events. */
export function observeTaskProgressState(owner: Owner, status: AcpSessionStatus, outcome?: 'completed' | 'cancelled' | 'failed'): void {
  try { sink?.state(owner, status, outcome) }
  catch { process.emitWarning('Task progress could not be persisted; remote delivery is unconfirmed.', { code: 'TRELLIS_TASK_PROGRESS' }) }
}
export function reportTaskProgress(owner: Owner, summary: Summary | unknown): Promise<{ queued: true; acknowledged: false }> {
  if (!sink) return Promise.reject(new Error('Task progress is unavailable in this native session'))
  return sink.report(owner, summary)
}
export function taskProgressContext(owner: Owner) { return sink?.context(owner) }

import type { AcpSessionRecord, AcpSessionStatus } from '../../../shared/types'
import type { TaskProgressNativeInput } from '../../../shared/crux-task-progress-native'

type Summary = Extract<TaskProgressNativeInput, { operation: 'report' }>['summary']
type Owner = Pick<AcpSessionRecord, 'sessionId' | 'projectRoot' | 'cwd' | 'connectionGeneration' | 'backendSessionId'>
export interface TaskProgressEvents {
  state(owner: Owner, status: AcpSessionStatus, outcome?: 'completed' | 'cancelled' | 'failed'): void
  report(owner: Owner, summary: unknown): Promise<{ queued: true; acknowledged: false }>
  context(owner: Owner): { id: string; version: string; title: string; body: string } | undefined
  assertCurrent(owner: AcpSessionRecord): Promise<() => void>
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
export async function assertTaskProgressCurrent(owner: AcpSessionRecord): Promise<() => void> {
  const original = sink
  if (!original) throw new Error('原任务执行所有者不可用，不能发送原生任务命令')
  const assertCurrent = await original.assertCurrent(owner)
  if (sink !== original) throw new Error('原任务执行所有者已变化，不能发送原生任务命令')
  return () => {
    if (sink !== original) throw new Error('原任务执行所有者已变化，不能发送原生任务命令')
    assertCurrent()
  }
}

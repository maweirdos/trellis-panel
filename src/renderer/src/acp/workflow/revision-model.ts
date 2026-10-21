import { z } from 'zod'
import { runRefSchema, type RunRef } from '../../../../shared/workflow'
import type { WorkflowRevisionState, WorkflowRevisionStatus } from '../../../../shared/workflow-revisions'
import { projectRootKey } from '../../my/navigation'

const pendingSchema = z.object({ version: z.literal(1), root: z.string().min(1).max(8192), taskDir: z.string().min(1).max(200), run: runRefSchema, previewId: z.string().min(1).max(200), commandId: z.string().uuid() }).strict()
export type PendingRevision = z.infer<typeof pendingSchema>
const storage = 'tpanel.workflow.revision-commands.v1'
export const revisionOwnerKey = (root: string, task: string): string => JSON.stringify([projectRootKey(root), task])
export const sameRun = (left: RunRef | null | undefined, right: RunRef | null | undefined): boolean => Boolean(left && right && left.runId === right.runId && left.revision === right.revision)
export function readPendingRevision(root: string, taskDir: string): PendingRevision | null {
  try {
    const result = pendingSchema.safeParse(JSON.parse(localStorage.getItem(storage) ?? '{}')[revisionOwnerKey(root, taskDir)])
    return result.success && projectRootKey(result.data.root) === projectRootKey(root) && result.data.taskDir === taskDir ? result.data : null
  } catch { return null }
}
/** Preserve only a lookup identity; never serialize material bodies or grant scope. */
export function savePendingRevision(root: string, taskDir: string, value: PendingRevision | null, expectedCommandId?: string): void {
  const key = revisionOwnerKey(root, taskDir)
  let all: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storage) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('Invalid retained command index')
    all = parsed as Record<string, unknown>
  } catch { throw Error('本地修订接纳标识无法核实，已保留原记录；请先检查保留的运行，暂不发送新的采用请求。') }
  const next = value ? pendingSchema.parse(value) : null
  if (next && (projectRootKey(next.root) !== projectRootKey(root) || next.taskDir !== taskDir)) throw Error('修订标识不属于当前项目和任务，未改写保留记录。')
  const present = Object.hasOwn(all, key)
  const previous = present ? pendingSchema.safeParse(all[key]) : null
  if (present && (!previous?.success || projectRootKey(previous.data.root) !== projectRootKey(root) || previous.data.taskDir !== taskDir)) throw Error('当前任务的修订接纳标识损坏或归属无法核实，已保留原记录，未发送新的采用请求。')
  if (previous?.success) {
    if (next && (previous.data.commandId !== next.commandId || previous.data.previewId !== next.previewId || !sameRun(previous.data.run, next.run))) throw Error('当前任务已有另一份修订接纳标识，请关闭并重新打开以核对原命令，不能用新的采用请求覆盖它。')
    if (!next && previous.data.commandId !== expectedCommandId) throw Error('待关闭的原命令已改变，已保留另一份接纳标识；请重新核对。')
  } else if (!next && expectedCommandId) throw Error('原命令标识已被其他窗口移除，未改写保留记录。')
  const retained = Object.entries(all).filter(([id]) => id !== key)
  if (value && retained.length >= 64) throw Error('本地保留的修订接纳记录已达上限；请先核对并关闭已解决记录，不能自动丢弃未确认命令。')
  const entries = Object.fromEntries(retained)
  if (next) entries[key] = next
  localStorage.setItem(storage, JSON.stringify(entries))
  if (value && readPendingRevision(root, taskDir)?.commandId !== value.commandId) throw Error('修订接纳标识未能保存，未发送采用请求。')
}
export const revisionStateLabel = (state: WorkflowRevisionState): string => ({ saved: '预览已保存', 'waiting-boundary': '等待当前阶段结束', stopping: '正在停止原执行', 'stop-unconfirmed': '原执行停止尚未确认', stopped: '原执行已停止', 'successor-starting': '后继正在启动', running: '后继已开始执行', adopted: '修订已接续', failed: '接续失败', cancelled: '修订已取消', 'recovery-required': '需要核对恢复记录' })[state]
export function revisionNeedsReconciliation(status: WorkflowRevisionStatus | null): boolean {
  return !status || status.recoveryRequired || !['running', 'adopted', 'failed', 'cancelled'].includes(status.state)
}

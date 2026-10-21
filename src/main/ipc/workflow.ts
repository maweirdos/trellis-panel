/** Main-authorized workflow commands and bounded, sender-owned projection leases. */
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { z } from 'zod'
import { ipcInvoke, ipcEvent } from '../../shared/ipc-channels'
import { ipcFail, IpcErrorCode, type IpcFail } from '../../shared/ipc-errors'
import { workflowPreviewInputSchema, workflowStartInputSchema, workflowSnapshotInputSchema, workflowEventsInputSchema, workflowStopInputSchema, workflowArtifactInputSchema, type WorkflowEventsInput } from '../../shared/workflow-application'
import type { WorkflowDesktopUpdate } from '../../shared/workflow-desktop'
import { workflowRevisionPreviewInputSchema, workflowRevisionAcceptInputSchema, workflowRevisionStatusInputSchema } from '../../shared/workflow-revisions'
import { workflowWorkspaceRecoveryInputSchema, workflowRecoveryArtifactInputSchema } from '../../shared/workflow-recovery'
import { getProjectRoot, getProjectGeneration } from '../state'
import { getWorkflowApplication, workflowDesktopTemplates, isWorkflowAdmissionClosed, withManagedWorkflowAdmission } from '../services/workflow-desktop'
import { getDocumentViews } from '../services/document-views'
import { broadcastToWindows } from '../services/bridge'
import { handle } from './registry'

type Lease = { id: string; sender: Electron.WebContents; root: string; generation: number; input: WorkflowEventsInput; timer: ReturnType<typeof setTimeout> | null; digest: string | null }
const leases = new Map<string, Lease>()
const watchedSenders = new Set<number>()
const sameRoot = (a: string, b: string): boolean => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)
const failure = (error: unknown): IpcFail => {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  const mapped = code === 'E_CONFLICT' ? IpcErrorCode.Conflict : code === 'NO_PROJECT' ? IpcErrorCode.NoProject
    : error instanceof z.ZodError || code === 'INVALID_INPUT' ? IpcErrorCode.InvalidArg
    : code === 'NOT_FOUND' ? IpcErrorCode.NotFound
      : ['SCOPE_CHANGED', 'STALE_PREVIEW', 'REVISION_CONFLICT', 'COMMAND_PAYLOAD_CONFLICT', 'MATERIAL_CHANGED'].includes(code) ? IpcErrorCode.Conflict
        : code === 'CAPABILITY_UNAVAILABLE' ? IpcErrorCode.Denied : IpcErrorCode.Io
  return ipcFail(mapped, error instanceof Error ? error.message : '工作流操作失败')
}
function capture(expectedRoot: unknown): { root: string; generation: number } {
  const root = getProjectRoot()
  if (!root) throw Object.assign(new Error('未打开项目'), { code: 'NO_PROJECT' })
  if (typeof expectedRoot !== 'string' || !expectedRoot || expectedRoot.length > 8192 || !sameRoot(root, expectedRoot)) throw Object.assign(new Error('项目已切换，请回到来源项目重试'), { code: 'SCOPE_CHANGED' })
  return { root, generation: getProjectGeneration() }
}
function current(context: { root: string; generation: number }): boolean { return getProjectRoot() === context.root && getProjectGeneration() === context.generation }
function release(id: string): void { const lease = leases.get(id); if (lease?.timer) clearTimeout(lease.timer); leases.delete(id) }
export function stopWorkflowSubscriptions(): void { for (const id of leases.keys()) release(id) }
async function poll(lease: Lease): Promise<void> {
  if (!leases.has(lease.id) || lease.sender.isDestroyed() || !current(lease)) { release(lease.id); return }
  try {
    const app = await getWorkflowApplication(lease.root)
    const page = await app.events(lease.input)
    const snapshot = await app.snapshot({ taskDir: lease.input.taskDir, ...(lease.input.run ? { run: lease.input.run } : {}) })
    if (!leases.has(lease.id) || lease.sender.isDestroyed() || !current(lease)) { release(lease.id); return }
    const digest = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
    const update: WorkflowDesktopUpdate = { leaseId: lease.id, projectRoot: lease.root, projectGeneration: lease.generation, taskDir: lease.input.taskDir, snapshot, page }
    if (digest !== lease.digest || page.items.length || page.resetRequired) broadcastToWindows(ipcEvent.workflowOutput, update)
    lease.digest = digest
    lease.input = { ...lease.input, cursor: page.cursor }
    if (snapshot.snapshot && snapshot.composer.target === 'ordinary' && ['verified', 'failed', 'stopped', 'cancelled'].includes(snapshot.snapshot.run.state) && !page.hasMore) {
      broadcastToWindows(ipcEvent.workflowDone, update); release(lease.id); return
    }
    lease.timer = setTimeout(() => { void poll(lease) }, page.hasMore ? 0 : 500)
    lease.timer.unref()
  } catch (error) {
    if (leases.has(lease.id) && current(lease) && !lease.sender.isDestroyed()) broadcastToWindows(ipcEvent.workflowDone, { leaseId: lease.id, projectRoot: lease.root, projectGeneration: lease.generation, taskDir: lease.input.taskDir, error: failure(error) } satisfies WorkflowDesktopUpdate)
    release(lease.id)
  }
}

export function registerWorkflowIpc(): void {
  const scoped = <T>(schema: z.ZodType<T>, action: (root: string, input: T) => Promise<unknown>, admitting = false) => async (_event: Electron.IpcMainInvokeEvent, expectedRoot: unknown, raw: unknown) => {
    try {
      const context = capture(expectedRoot)
      if (admitting && isWorkflowAdmissionClosed()) return ipcFail(IpcErrorCode.Conflict, '应用正在退出，暂不接纳新的工作流')
      const input = schema.parse(raw)
      const value = await action(context.root, input)
      // A commit may already have happened: a stale response never means rollback.
      if (!current(context)) return ipcFail(IpcErrorCode.Conflict, '项目在操作期间已切换；已接纳的操作请回到来源项目核对')
      return { ok: true as const, value }
    } catch (error) { return failure(error) }
  }
  handle(ipcInvoke.workflow.templates, scoped(z.unknown(), async (root) => workflowDesktopTemplates(root)))
  handle(ipcInvoke.workflow.preview, scoped(workflowPreviewInputSchema, async (root, input) => {
    const preview = await (await getWorkflowApplication(root)).preview(input)
    return { ...preview, limitations: [...(preview.limitations ?? []), '工作流执行会话首次创建时使用原生默认模型与模式，后续阶段可能复用该会话；原会话临时选择的模型、模式和推理选项不会自动沿用，实际配置在阶段就绪记录中核对。'] }
  }, true))
  handle(ipcInvoke.workflow.start, scoped(workflowStartInputSchema, async (root, input) => withManagedWorkflowAdmission(root, async () => (await getWorkflowApplication(root)).start(input), input), true))
  handle(ipcInvoke.workflow.snapshot, scoped(workflowSnapshotInputSchema, async (root, input) => (await getWorkflowApplication(root)).snapshot(input)))
  handle(ipcInvoke.workflow.events, scoped(workflowEventsInputSchema, async (root, input) => (await getWorkflowApplication(root)).events(input)))
  handle(ipcInvoke.workflow.stop, scoped(workflowStopInputSchema, async (root, input) => (await getWorkflowApplication(root)).stop(input)))
  handle(ipcInvoke.workflow.previewRevision, scoped(workflowRevisionPreviewInputSchema, async (root, input) => (await getWorkflowApplication(root)).previewRevision(input), true))
  // Adoption retains its existing durable owner while draining the old stage.
  // A fresh-start admission token would incorrectly reject that very stage.
  handle(ipcInvoke.workflow.acceptRevision, scoped(workflowRevisionAcceptInputSchema, async (root, input) => (await getWorkflowApplication(root)).acceptRevision(input), true))
  handle(ipcInvoke.workflow.cancelRevision, scoped(workflowRevisionStatusInputSchema, async (root, input) => (await getWorkflowApplication(root)).cancelRevision(input)))
  handle(ipcInvoke.workflow.revisionStatus, scoped(workflowRevisionStatusInputSchema, async (root, input) => (await getWorkflowApplication(root)).revisionStatus(input)))
  handle(ipcInvoke.workflow.inspectRecovery, scoped(workflowWorkspaceRecoveryInputSchema, async (root, input) => (await getWorkflowApplication(root)).inspectWorkspaceRecovery(input)))
  handle(ipcInvoke.workflow.recoveryArtifact, scoped(workflowRecoveryArtifactInputSchema, async (root, input) => {
    const stored = await (await getWorkflowApplication(root)).readRecoveryArtifact(input)
    const reader = getDocumentViews()
    if (!reader) throw new Error('文档阅读服务尚未就绪')
    return reader.registerMaterial(root, stored)
  }))
  handle(ipcInvoke.workflow.artifact, scoped(workflowArtifactInputSchema, async (root, input) => {
    const app = await getWorkflowApplication(root)
    const stored = await app.readArtifact(input)
    const reader = getDocumentViews()
    if (!reader) throw new Error('文档阅读服务尚未就绪')
    return reader.registerMaterial(root, stored)
  }))
  handle(ipcInvoke.workflow.subscribe, async (event, expectedRoot: unknown, raw: unknown) => {
    try {
      const context = capture(expectedRoot); const input = workflowEventsInputSchema.parse(raw)
      if (leases.size >= 64 || [...leases.values()].filter((lease) => lease.sender.id === event.sender.id).length >= 8) return ipcFail(IpcErrorCode.Denied, '工作流订阅数量已达上限，请关闭旧视图')
      const id = randomUUID()
      const lease: Lease = { id, sender: event.sender, ...context, input, timer: null, digest: null }
      leases.set(id, lease)
      if (!watchedSenders.has(event.sender.id)) {
        watchedSenders.add(event.sender.id)
        event.sender.once('destroyed', () => {
          watchedSenders.delete(event.sender.id)
          for (const [key, entry] of leases) if (entry.sender.id === event.sender.id) release(key)
        })
      }
      lease.timer = setTimeout(() => { void poll(lease) }, 0)
      lease.timer.unref()
      return { ok: true as const, value: { leaseId: id } }
    } catch (error) { return failure(error) }
  })
  handle(ipcInvoke.workflow.unsubscribe, (event, id: unknown) => { if (typeof id === 'string' && leases.get(id)?.sender.id === event.sender.id) release(id) })
}

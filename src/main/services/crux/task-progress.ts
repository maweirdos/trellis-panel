import { app } from 'electron'
import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
import { cruxProgressQuerySchema, cruxProgressReportSchema, cruxProgressStartSchema, cruxProgressSendSchema, cruxProgressRespondSchema, cruxProgressEventsSchema, type CruxProgressQuery, type CruxProgressResult, type CruxProgressValue, type CruxProgressApi } from '../../../shared/crux-task-progress'
import { taskProgressPinSchema, type TaskProgressNativeInput, type TaskProgressPin } from '../../../shared/crux-task-progress-native'
import type { CruxWorkspaceContext } from '../../../shared/crux-remote'
import type { DesktopTeamConnection } from '../../../shared/team-desktop'
import { IpcErrorCode, ipcFail } from '../../../shared/ipc-errors'
import { clipUtf8 } from '../../../shared/material-budget'
import { withDesktopTeamService } from '../team-desktop'
import { DesktopTeamError } from '../team-platform'
import { runtimeCall } from '../daemon-client/runtime'
import { cruxWorkspaceGeneration, cruxWorkspaceSnapshot, cruxWorkspaceStatus } from './connection-service'
import type { TaskProgressNativeView } from './task-progress-runtime'
import { readCruxWorkSource, type CruxWorkWorkspaceView } from './task-workspace-source'
import type { CruxWorkResourceBinding, CruxDevelopmentContext } from '../../../shared/crux-work'
import type { CruxTaskWorkspaceService } from './task-workspace'

export const taskProgressNativeCall = <T>(input: TaskProgressNativeInput): Promise<T> => runtimeCall<T, 'runtime.cruxProgress'>('', 'runtime.cruxProgress', input)
const codeOf = (error: unknown): string => error && typeof error === 'object' && 'code' in error ? String(error.code) : 'STORE_UNAVAILABLE'
const transient = (error: unknown): boolean => ['NETWORK_UNAVAILABLE', 'ACKNOWLEDGEMENT_UNKNOWN', 'E_UNAVAILABLE', 'E_TIMEOUT'].includes(codeOf(error))
const uncertain = (error: unknown): boolean => Boolean(error && typeof error === 'object' && (
  'outcomeUnknown' in error && error.outcomeUnknown || 'outcome' in error && error.outcome === 'unknown' || codeOf(error) === 'E_UNKNOWN'
))
const pinned = (c: DesktopTeamConnection, pin: TaskProgressPin): boolean => c.connectionId === pin.connectionId && c.origin === pin.origin && c.pairingId === pin.pairingId && c.ownerId === pin.ownerId && c.deviceId === pin.deviceId && c.projectId === pin.projectId && c.state === 'active' && !c.accessLocked

/** GUI admission facade. Independent daemon owns queue, sessions and fixed-purpose protected HTTP sender. */
export class CruxTaskProgressService {
  private readonly serial = new Map<string, Promise<unknown>>()
  private readonly admissions = new AsyncLocalStorage<{ generation: number; admitted: boolean }>()
  constructor(private readonly workspace: CruxTaskWorkspaceService) {}
  private assertSelection(): void {
    const admission = this.admissions.getStore()
    if (admission && admission.generation !== cruxWorkspaceGeneration()) throw new DesktopTeamError('BINDING_CHANGED', '原任务来源已切换，请回原任务核对结果；返回原空间不会恢复旧操作权', admission.admitted)
  }
  private async nativeCall<T>(input: TaskProgressNativeInput): Promise<T> {
    this.assertSelection()
    const admission = this.admissions.getStore()
    if (admission && !['catalog', 'read', 'conversation', 'events', 'official'].includes(input.operation)) admission.admitted = true
    const result = await taskProgressNativeCall<T>(input)
    this.assertSelection()
    return result
  }
  /** Main-only enrollment capture; the pin never enters a renderer reply. */
  async captureOriginalPin(raw: unknown): Promise<{ pin: TaskProgressPin; assertCurrent(): Promise<void> }> {
    const query = cruxProgressQuerySchema.parse(raw), generation = cruxWorkspaceGeneration()
    const { pin } = await this.capture(query), context = await this.current(query)
    const fingerprint = (value: CruxWorkspaceContext): string => JSON.stringify([value.key, value.connectionId, value.origin, value.actorId, value.projectId, value.instanceId, value.epoch, value.authorizationRevision, value.state])
    const original = fingerprint(context)
    const assertCurrent = async (): Promise<void> => {
      if (generation !== cruxWorkspaceGeneration()) throw new DesktopTeamError('BINDING_CHANGED', '原任务来源已切换，请重新核对产物操作')
      const current = await this.current(query)
      if (current.state !== 'connected' || fingerprint(current) !== original) throw new DesktopTeamError('BINDING_CHANGED', '原任务的人员、授权或服务世代已变化')
      await this.connection(pin)
      const after = await this.current(query)
      if (generation !== cruxWorkspaceGeneration() || fingerprint(after) !== original) throw new DesktopTeamError('BINDING_CHANGED', '原任务的账号、设备或授权世代已变化')
    }
    await assertCurrent()
    await withDesktopTeamService(service => service.authorizeTaskProgress(pin.connectionId))
    await assertCurrent()
    return { pin, assertCurrent }
  }
  private async locked<T>(query: CruxProgressQuery, action: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([query.workspaceKey, query.taskId]), before = this.serial.get(key) ?? Promise.resolve()
    const work = before.catch(() => {}).then(action)
    this.serial.set(key, work)
    try { return await work } finally { if (this.serial.get(key) === work) this.serial.delete(key) }
  }
  private async current(query: CruxProgressQuery): Promise<CruxWorkspaceContext> {
    this.assertSelection()
    const context = await cruxWorkspaceStatus()
    this.assertSelection()
    if (context.key !== query.workspaceKey || !context.connectionId || !context.actorId || !context.projectId || !context.epoch || !context.instanceId) throw new DesktopTeamError('BINDING_CHANGED', '请在原团队登录与任务空间核对进度')
    if (context.state === 'access-revoked') throw new DesktopTeamError('ACCESS_LOCKED', '原协作权限已失效，旧报告已停止')
    return context
  }
  private async connection(pin: TaskProgressPin): Promise<void> {
    const found = await withDesktopTeamService(async service => (await service.connections()).find(c => c.connectionId === pin.connectionId))
    if (!found || !pinned(found, pin)) throw new DesktopTeamError('BINDING_CHANGED', '原协作设备、账号或项目已变化；不会重定向旧报告')
  }
  private async capture(query: CruxProgressQuery): Promise<{ pin: TaskProgressPin; view: CruxWorkWorkspaceView }> {
    const before = await this.current(query), view = await cruxWorkspaceSnapshot(), after = await this.current(query)
    if (view.context.state !== 'connected' || before.key !== after.key || before.actorId !== after.actorId || before.epoch !== after.epoch || before.instanceId !== after.instanceId
      || view.context.epoch !== after.epoch || view.context.actorId !== after.actorId) throw new DesktopTeamError('NETWORK_UNAVAILABLE', '当前正式任务身份尚未得到服务器确认')
    const c = await withDesktopTeamService(async service => (await service.connections()).find(entry => entry.connectionId === after.connectionId))
    if (!c) throw new DesktopTeamError('ACCESS_LOCKED', '原设备连接不可用')
    const task = view.snapshot.tasks.find(task => task.id === query.taskId)
    if (!task) throw new DesktopTeamError('TASK_PROGRESS_UNAVAILABLE', '当前任务不可读取')
    const pin = taskProgressPinSchema.parse({ workspaceKey: query.workspaceKey, taskId: query.taskId, spaceId: task.spaceId, connectionId: c.connectionId,
      origin: c.origin, pairingId: c.pairingId, ownerId: c.ownerId, deviceId: c.deviceId, projectId: c.projectId,
      instanceId: after.instanceId, epoch: after.epoch, handlerId: task.workflow?.handlerId ?? task.assigneeIds[0] })
    await this.connection(pin)
    if (pin.ownerId !== after.actorId || pin.projectId !== after.projectId || pin.origin !== after.origin) throw new DesktopTeamError('BINDING_CHANGED', '任务与当前登录身份不一致')
    return { pin, view }
  }
  private async remoteView(pin: TaskProgressPin): Promise<CruxWorkWorkspaceView> {
    await this.connection(pin)
    const remote = await withDesktopTeamService(service => service.cruxSnapshot(pin.connectionId, { expectedInstanceId: pin.instanceId }))
    if (remote.epoch !== pin.epoch || remote.actor.id !== pin.ownerId || remote.projectId !== pin.projectId) throw new DesktopTeamError('WORKSPACE_EPOCH_CHANGED', '原任务服务世代或人员身份已改变')
    const task = remote.snapshot.tasks.find(item => item.id === pin.taskId)
    if (!task || task.spaceId !== pin.spaceId || (task.workflow?.handlerId ?? task.assigneeIds[0]) !== pin.handlerId || pin.handlerId !== pin.ownerId) throw new DesktopTeamError('TASK_PROGRESS_FORBIDDEN', '任务已转交或已失去当前处理人权限')
    await this.connection(pin)
    return { snapshot: remote.snapshot, context: { key: pin.workspaceKey, connectionId: pin.connectionId, origin: pin.origin, projectId: pin.projectId,
      projectName: null, actorId: pin.ownerId, canManage: remote.canManage, revision: remote.revision, state: 'connected', pendingCount: 0,
      epoch: remote.epoch, instanceId: remote.instanceId, authorizationRevision: remote.authorizationRevision } }
  }
  private async flush(query: CruxProgressQuery): Promise<void> {
    const row = await this.nativeCall<TaskProgressNativeView>({ operation: 'sync', query })
    if (row.value.local?.state === 'stopped') throw new DesktopTeamError(row.value.local.errorCode ?? 'TASK_PROGRESS_BINDING_CONFLICT', '原任务上报已停止，请核对中心状态；冲突命令不会补发')
  }
  private async result(query: CruxProgressQuery, freshness: CruxProgressValue['freshness']): Promise<CruxProgressResult> {
    const row = await this.nativeCall<TaskProgressNativeView | null>({ operation: 'read', query })
    await this.current(query)
    if (!row) return { ok: true, value: { ...query, server: null, local: null, freshness } }
    return { ok: true, value: { ...row.value, freshness: row.value.local?.pendingCount ? 'pending' : freshness } }
  }
  private async guarded(raw: unknown, action: (query: CruxProgressQuery) => Promise<CruxProgressResult>): Promise<CruxProgressResult> {
    return this.admissions.run({ generation: cruxWorkspaceGeneration(), admitted: false }, () => this.guardedCurrent(raw, action))
  }
  private async guardedCurrent(raw: unknown, action: (query: CruxProgressQuery) => Promise<CruxProgressResult>): Promise<CruxProgressResult> {
    let query: CruxProgressQuery | undefined
    try { query = cruxProgressQuerySchema.parse(raw); await this.current(query); const owned = query; return await this.locked(owned, () => action(owned)) }
    catch (error) {
      const network = transient(error), code = codeOf(error)
      let value: CruxProgressValue | undefined
      if (network && query) { try { const last = await this.result(query, 'cached-offline'); if (last.ok) value = last.value } catch { /* A different selected identity gets no cached task body. */ } }
      return ipcFail(error instanceof z.ZodError ? IpcErrorCode.InvalidArg : network ? IpcErrorCode.Unavailable : ['ACCESS_LOCKED', 'BINDING_CHANGED', 'TASK_PROGRESS_FORBIDDEN'].includes(code) ? IpcErrorCode.Denied : IpcErrorCode.Conflict,
        error instanceof DesktopTeamError || error instanceof Error && code.startsWith('E_') ? error.message : error instanceof z.ZodError ? '任务进度参数无效' : '任务进度尚未确认，请核对原绑定与会话后重试', { ...(value ? { value } : {}), outcomeUnknown: uncertain(error) || Boolean(value?.local?.outcomeUnknown), progressCode: code })
    }
  }
  status(raw: unknown): Promise<CruxProgressResult> {
    return this.guarded(raw, async query => {
      let row = await this.nativeCall<TaskProgressNativeView | null>({ operation: 'read', query })
      const scope = row ?? await this.capture(query)
      const pin = scope.pin
      const context = await this.current(query)
      if (context.connectionId !== pin.connectionId || context.epoch !== pin.epoch || context.actorId !== pin.ownerId) throw new DesktopTeamError('BINDING_CHANGED', '原绑定与当前登录身份不一致')
      await this.connection(pin)
      const server = await withDesktopTeamService(service => service.cruxTaskProgress(pin.connectionId, pin.taskId, pin.instanceId))
      if (row) { await this.nativeCall({ operation: 'observe', query, server }); row = await this.nativeCall({ operation: 'read', query }) }
      await this.current(query)
      return { ok: true, value: row ? { ...row.value, server, freshness: 'remote' } : { ...query, server, local: null, freshness: 'remote' } }
    })
  }
  start(raw: unknown): Promise<CruxProgressResult> {
    const parsed = cruxProgressStartSchema.safeParse(raw)
    if (!parsed.success) return Promise.resolve(ipcFail(IpcErrorCode.InvalidArg, '任务启动参数无效'))
    const { engine, agentId, takeover, ...query } = parsed.data
    return this.guarded(query, async () => {
      const { pin, view } = await this.capture(query)
      const source = await readCruxWorkSource({ workspaceStatus: async () => view.context, workspaceSnapshot: async () => view }, query)
      const existing = await this.nativeCall<TaskProgressNativeView | null>({ operation: 'read', query })
      if (existing && existing.value.local?.state !== 'detached' && !takeover) {
        if (JSON.stringify(existing.pin) !== JSON.stringify(pin)) throw new DesktopTeamError('BINDING_CHANGED', '原任务执行属于另一身份或世代')
        await this.flush(query); await this.nativeCall({ operation: 'run', query })
        return this.result(query, 'remote')
      }
      let root = app.getPath('userData'), taskDir: string | undefined, inputVersion = source.revision
      let resourceBinding: CruxWorkResourceBinding | undefined
      let development: CruxDevelopmentContext | undefined
      if (source.material.workKind === 'code') {
        const task = view.snapshot.tasks.find(item => item.id === pin.taskId)
        if (task?.workflow && !['planning', 'developing'].includes(task.workflow.stage)) throw new DesktopTeamError('TASK_PROGRESS_FORBIDDEN', '请先通过团队任务的开发与方案流程进入可执行阶段')
        const work = await this.workspace.status(query)
        if (!work.ok) return work
        if (!work.prepared || !work.local || work.reviewRequired) return ipcFail(IpcErrorCode.Conflict, '代码任务尚未确认本机材料，请先核对准备结果')
        root = work.local.projectRoot; taskDir = work.local.taskDir; inputVersion = work.preparedRevision
        resourceBinding = work.local.resourceBinding
        development = work.local.development
        if (!resourceBinding) throw new DesktopTeamError('TASK_RESOURCE_REVIEW_REQUIRED', '请重新核对团队任务的代码资源与本机副本后启动')
        if (!development) throw new DesktopTeamError('TASK_WORKCOPY_CHANGED', '本机开发上下文尚未固定，请重新核对后启动')
      }
      const server = await withDesktopTeamService(service => service.cruxTaskProgress(pin.connectionId, pin.taskId, pin.instanceId))
      if (takeover && (server.generation !== takeover.expectedGeneration || (server.binding?.bindingId ?? null) !== takeover.expectedBindingId)) throw new DesktopTeamError('TASK_PROGRESS_BINDING_CONFLICT', '接管确认期间上报绑定已变化，请重新核对')
      await withDesktopTeamService(service => service.authorizeTaskProgress(pin.connectionId))
      await this.current(query)
      const prompt = [`Work on the original team task: ${source.material.title}`, `Task ${pin.taskId}; complete material SHA-256: ${inputVersion}.`,
        taskDir ? `Read .trellis/tasks/${taskDir}/prd.md and references/source-materials.json for the full frozen input. Use the entire prepared base project; do not split front/back into independent tasks.`
          : 'Read task-input.json in this app-managed working directory before working. It contains the complete frozen requirements, acceptance criteria and artifacts. This prompt is an index, not the full input. The working directory is not an OS sandbox.',
        'Report short steps/blockers with report_progress when available. Task business transitions require the team service actions; do not complete the business task from a turn result.'
      ].join('\n\n')
      await this.nativeCall({ operation: 'prepare', pin, server, takeover: Boolean(takeover), plan: { root, taskDir, inputVersion, sourceVersion: source.revision,
        material: source.material.workKind !== 'code' ? source.material : undefined, prompt, managedDirectory: source.material.workKind !== 'code', engine, agentId, resourceBinding, development } })
      await this.flush(query)
      await this.nativeCall({ operation: 'run', query })
      return this.result(query, 'remote')
    })
  }
  report(raw: unknown): Promise<CruxProgressResult> {
    const parsed = cruxProgressReportSchema.safeParse(raw)
    if (!parsed.success) return Promise.resolve(ipcFail(IpcErrorCode.InvalidArg, '只允许单行步骤、阻塞与运行状态'))
    const { activity, step, blocker, takeover, ...query } = parsed.data
    return this.guarded(query, async () => {
      const old = await this.nativeCall<TaskProgressNativeView | null>({ operation: 'read', query })
      if (!old || old.value.local?.state === 'detached' || takeover) {
        const { pin } = await this.capture(query)
        if (pin.handlerId !== pin.ownerId) throw new DesktopTeamError('TASK_PROGRESS_FORBIDDEN', '只有当前任务处理人可以上报进度')
        const server = await withDesktopTeamService(service => service.cruxTaskProgress(pin.connectionId, pin.taskId, pin.instanceId))
        if (takeover && (server.generation !== takeover.expectedGeneration || (server.binding?.bindingId ?? null) !== takeover.expectedBindingId)) throw new DesktopTeamError('TASK_PROGRESS_BINDING_CONFLICT', '接管确认期间上报绑定已变化，请重新核对')
        await withDesktopTeamService(service => service.authorizeTaskProgress(pin.connectionId))
        await this.nativeCall({ operation: 'prepare', pin, server, plan: null, takeover: Boolean(takeover) })
        await this.flush(query)
      }
      await this.nativeCall({ operation: 'report', query, summary: { activity, step, blocker } })
      await this.flush(query)
      return this.result(query, 'remote')
    })
  }
  retry(raw: unknown): Promise<CruxProgressResult> {
    return this.guarded(raw, async query => {
      const owned = await this.nativeCall<TaskProgressNativeView | null>({ operation: 'read', query })
      if (!owned) return ipcFail(IpcErrorCode.NotFound, '没有待核对的原进度命令')
      const context = await this.current(query)
      if (context.connectionId !== owned.pin.connectionId || context.epoch !== owned.pin.epoch || context.actorId !== owned.pin.ownerId) throw new DesktopTeamError('BINDING_CHANGED', '原进度身份不能由当前来源接管')
      await this.connection(owned.pin)
      if (owned.value.local?.state === 'preparing') {
        const reconciled = await this.nativeCall<TaskProgressNativeView>({ operation: 'sync', query })
        if (reconciled.value.local?.state === 'stopped') return this.result(query, 'remote')
      }
      await this.flush(query)
      const latest = await this.nativeCall<TaskProgressNativeView>({ operation: 'read', query })
      if (latest.value.local?.dispatch === 'not_sent' && latest.value.local.state === 'active') await this.nativeCall({ operation: 'run', query })
      return this.result(query, 'remote')
    })
  }
  detach(raw: unknown): Promise<CruxProgressResult> {
    return this.guarded(raw, async query => {
      await this.nativeCall({ operation: 'detach', query })
      await this.flush(query)
      return this.result(query, 'remote')
    })
  }
  private conversationAction(raw: unknown, operation: 'conversation' | 'events' | 'send' | 'respond' | 'cancel' | 'resume'): Promise<unknown> {
    return this.admissions.run({ generation: cruxWorkspaceGeneration(), admitted: false }, () => this.conversationOwned(raw, operation))
  }
  private async conversationOwned(raw: unknown, operation: 'conversation' | 'events' | 'send' | 'respond' | 'cancel' | 'resume'): Promise<unknown> {
    try {
      const schema = operation === 'send' ? cruxProgressSendSchema : operation === 'respond' ? cruxProgressRespondSchema : operation === 'events' ? cruxProgressEventsSchema : cruxProgressQuerySchema
      const input = schema.parse(raw), query = { workspaceKey: input.workspaceKey, taskId: input.taskId }
      const context = await this.current(query)
      const owned = await this.nativeCall<TaskProgressNativeView | null>({ operation: 'read', query })
      if (!owned?.value.local?.session || context.actorId !== owned.pin.ownerId || context.connectionId !== owned.pin.connectionId || context.epoch !== owned.pin.epoch) return ipcFail(IpcErrorCode.Denied, '原任务会话不属于当前身份或服务世代')
      await this.connection(owned.pin)
      if (['send', 'respond', 'resume'].includes(operation)) {
        const server = await withDesktopTeamService(service => service.cruxTaskProgress(owned.pin.connectionId, owned.pin.taskId, owned.pin.instanceId))
        await this.nativeCall({ operation: 'observe', query, server })
        await this.remoteView(owned.pin)
      }
      switch (operation) {
        case 'send': return this.nativeCall({ operation, input: cruxProgressSendSchema.parse(input) })
        case 'respond': return this.nativeCall({ operation, input: cruxProgressRespondSchema.parse(input) })
        case 'events': return this.nativeCall({ operation, input: cruxProgressEventsSchema.parse(input) })
        default: return this.nativeCall({ operation, query })
      }
    } catch (error) { return ipcFail(error instanceof z.ZodError ? IpcErrorCode.InvalidArg : IpcErrorCode.Conflict, error instanceof DesktopTeamError ? error.message : '原任务会话操作未确认，请核对原绑定', { outcomeUnknown: uncertain(error) }) }
  }
  conversation: NonNullable<CruxProgressApi['conversation']> = input => this.conversationAction(input, 'conversation') as ReturnType<NonNullable<CruxProgressApi['conversation']>>
  events: NonNullable<CruxProgressApi['events']> = input => this.conversationAction(input, 'events') as ReturnType<NonNullable<CruxProgressApi['events']>>
  send: NonNullable<CruxProgressApi['send']> = input => this.conversationAction(input, 'send') as ReturnType<NonNullable<CruxProgressApi['send']>>
  respond: NonNullable<CruxProgressApi['respond']> = input => this.conversationAction(input, 'respond') as ReturnType<NonNullable<CruxProgressApi['respond']>>
  cancel: NonNullable<CruxProgressApi['cancel']> = input => this.conversationAction(input, 'cancel') as ReturnType<NonNullable<CruxProgressApi['cancel']>>
  resumeSession: NonNullable<CruxProgressApi['resume']> = input => this.conversationAction(input, 'resume') as ReturnType<NonNullable<CruxProgressApi['resume']>>
}

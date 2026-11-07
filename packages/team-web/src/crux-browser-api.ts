import type { CruxApi, CruxFailure, CruxPendingCommand, CruxSnapshot } from '../../../src/shared/crux'
import { cruxRemoteCommandSchema, cruxRemoteSnapshotSchema, type CruxRemoteCommand, type CruxRemoteSnapshot, type CruxWorkspaceContext } from '../../../src/shared/crux-remote'
import { cruxMutationInputSchemas, type CruxMutationName } from '../../../src/shared/crux-domain/commands'
import { triageQueue } from '../../../src/shared/crux-domain/planning'
import type { TrellisApi } from '../../../src/shared/types'
import type { TeamProject, TeamSession } from './contracts'
import { ApiError, archiveCommand, authEvents, canRetry, isClientSession, pendingCommands, prepareCommand, reconcileCommand, request, sendCommand, type PendingCommand, type PreparedCommand } from './client'
import { BrowserCreationApi } from './creation-browser-api'
import type { CreationApi } from '../../../src/shared/creation-api'
import { BrowserTaskProgress } from './task-progress-browser-api'
import type { CruxProgressApi } from '../../../src/shared/crux-task-progress'
import { BrowserCodeResources } from './code-resource-browser-api'
import type { CruxCodeResourceApi } from '../../../src/shared/crux-code-resources'
import { BrowserTaskMaterials } from './task-materials-browser-api'
import type { CruxTaskMaterialsApi } from '../../../src/shared/crux-task-materials'
import { BrowserGovernance } from './governance-browser-api'
import { BrowserTeamContent } from './content-browser-api'
import type { TeamContentApi } from '../../../src/shared/team-content-api'
import type { TeamGovernanceApi } from '../../../src/shared/team-governance'

type SnapshotReply = { ok: true; data: CruxSnapshot; context: CruxWorkspaceContext; taskId?: string }
type Pending = { entry: PendingCommand; prepared?: PreparedCommand<CruxRemoteSnapshot>; command?: CruxRemoteCommand; instanceId: string | null; createdAt: number; outcomeUnknown: boolean; errorCode: string | null }
// Keep exact unsatisfied commands across navigation in this page, scoped to their owner.
// Bodies are never written to local/session storage or reconstructed after reload.
const retained = new Map<string, Pending>()
const pinnedInstances = new Map<string, string>()
export type BrowserWorkspaceOptions = { project: TeamProject; session: TeamSession; origin?: string }

/** One authenticated browser lease. No local desktop data or credentials are stored. */
export class BrowserCruxWorkspace {
  private live = true
  private locked = false
  private instanceChanged = false
  private instanceId: string | null
  private epochGeneration = 0
  private readonly retiredEpochs = new Set<string>()
  private snapshotValue: CruxRemoteSnapshot | null = null
  private pending: Pending | null = null
  private journalError: unknown = null
  private preparing = false
  private referenceCount = 0
  private sending = false
  private readonly lifetime = new AbortController()
  private readonly listeners = new Set<(context: CruxWorkspaceContext) => void>()
  private polling: Promise<void> | null = null
  private lastError: string | undefined
  private lastPublished = ''
  private state: CruxWorkspaceContext['state'] = 'offline'
  readonly key: string
  readonly crux: CruxApi
  readonly creations: BrowserCreationApi
  readonly progress: BrowserTaskProgress
  readonly resources: BrowserCodeResources
  readonly materials: BrowserTaskMaterials
  readonly governance: BrowserGovernance
  readonly teamContent: BrowserTeamContent

  constructor(private readonly options: BrowserWorkspaceOptions) {
    this.key = JSON.stringify([options.origin ?? location.origin, options.session.person.userId, options.project.projectId])
    this.teamContent = new BrowserTeamContent({ session: options.session, projectId: options.project.projectId, teamId: options.project.teamId, context: () => this.context(), isCurrent: () => this.current() })
    for (const key of retained.keys()) { const [origin, userId] = JSON.parse(key) as string[]; if (origin !== location.origin || userId !== options.session.person.userId) retained.delete(key) }
    for (const key of pinnedInstances.keys()) { const [origin, userId] = JSON.parse(key) as string[]; if (origin !== location.origin || userId !== options.session.person.userId) pinnedInstances.delete(key) }
    this.syncReferences()
    this.instanceId = pinnedInstances.get(this.key) ?? this.pending?.instanceId ?? null
    this.crux = {
      workspaceStatus: async () => this.canInspect() ? { ok: true, context: this.context() } : this.failure(new ApiError('OWNER_CHANGED', '工作区的登录身份已改变')),
      workspacePending: async () => { if (!this.canInspect()) return this.failure(new ApiError('OWNER_CHANGED', '工作区的登录身份已改变')); this.syncReferences(); return this.journalError ? this.failure(this.journalError) : { ok: true, data: this.pendingList() } },
      discardWorkspaceCommand: async ({ commandId }) => {
        if (!this.canInspect()) return this.failure(new ApiError('OWNER_CHANGED', '工作区的登录身份已改变'))
        if (this.sending) return this.failure(new ApiError('IN_FLIGHT', '请等待当前操作核对结束'))
        this.syncReferences(commandId)
        if (this.journalError) return this.failure(this.journalError)
        if (this.pending?.entry.commandId !== commandId) return this.failure(new ApiError('NOT_FOUND', '原操作已不存在'))
        if (this.pending.outcomeUnknown && !this.pendingRetired(this.pending)) return this.failure(new ApiError('OUTCOME_UNKNOWN', '原操作结果未确认，请先核对原回执'))
        try { archiveCommand(this.pending.entry, this.pending.outcomeUnknown) } catch (error) { return this.failure(error) }
        this.pending = null; retained.delete(this.key); this.syncReferences(); this.publish()
        return { ok: true, context: this.context() }
      },
      selectWorkspace: async () => this.failure(new ApiError('UNSUPPORTED_WEB_ACTION', '请使用网页版左侧工作区选择器切换工作区')),
      retryWorkspaceCommand: async ({ commandId }) => {
        this.syncReferences(commandId)
        if (this.journalError) return this.failure(this.journalError)
        if (this.pending?.entry.commandId !== commandId) return this.failure(new ApiError('NOT_FOUND', '原操作已不存在'))
        try {
          if (!this.current()) return this.failure(new ApiError('OWNER_CHANGED', '原工作区当前不可写'))
          if (!this.snapshotValue) { const read = await this.read(); if (!read.ok) return read }
          if (this.pendingRetired(this.pending)) return this.failure(new ApiError('WORKSPACE_EPOCH_CHANGED', '原操作已属于先前作用域，请明确归档引用', 409))
          const pending = this.pending
          if (await this.reconcile(pending) === 'committed') return this.read()
          if (!pending.prepared || !canRetry(pending.entry)) return this.failure(new ApiError('PAYLOAD_UNAVAILABLE', '重载后只保留原操作标识和摘要，回执仍未确认；没有原载荷，不能构造重试'))
          return this.send(pending)
        } catch (error) {
          if (error instanceof ApiError && ['OPERATION_FORBIDDEN', 'SPACE_ACCESS_DENIED', 'MANAGEMENT_REQUIRED'].includes(error.code)) await this.read()
          return this.failure(error)
        }
      },
      onWorkspaceChanged: (listener) => { this.listeners.add(listener); this.startPolling(); return () => this.listeners.delete(listener) },
      snapshot: () => this.read(),
      triageQueue: async (spaceId) => {
        const reply = await this.read()
        if (!reply.ok) return reply
        try { return { ok: true, data: triageQueue(reply.data, spaceId) } } catch (error) { return this.failure(error) }
      },
      createSpace: (input) => this.mutate('createSpace', input), updateSpace: (input) => this.mutate('updateSpace', input),
      joinSpace: (input) => this.mutate('joinSpace', input),
      inviteMember: async () => this.rosterUnsupported(), updateMember: async () => this.rosterUnsupported(), removeMember: async () => this.rosterUnsupported(),
      setSpaceMembers: (input) => this.mutate('setSpaceMembers', input),
      createTaskType: (input) => this.mutate('createTaskType', input), updateTaskType: (input) => this.mutate('updateTaskType', input), removeTaskType: (input) => this.mutate('removeTaskType', input),
      createTaskStatus: (input) => this.mutate('createTaskStatus', input), removeTaskStatus: (input) => this.mutate('removeTaskStatus', input), createLabel: (input) => this.mutate('createLabel', input), archiveLabel: (input) => this.mutate('archiveLabel', input),
      createTask: async (input) => {
        const reply = await this.mutate('createTask', input)
        return reply.ok && reply.taskId ? { ...reply, taskId: reply.taskId } : reply.ok ? this.failure(new ApiError('COMMITTED_NOT_VISIBLE', '原操作已提交；新任务目前不在授权可见范围，请先核对结果再创建新操作')) : reply
      },
      updateTask: (input) => this.mutate('updateTask', input), transitionTask: (input) => this.mutate('transitionTask', input), recordVersionDelivery: (input) => this.mutate('recordVersionDelivery', input), removeTask: (input) => this.mutate('removeTask', input), addRelation: (input) => this.mutate('addRelation', input), removeRelation: (input) => this.mutate('removeRelation', input),
      recordTaskDelivery: (input) => this.mutate('recordTaskDelivery', input),
      saveMilestone: (input) => this.mutate('saveMilestone', input),
      completeMilestone: (input) => this.mutate('completeMilestone', input),
      removeMilestone: (input) => this.mutate('removeMilestone', input),
      addComment: (input) => this.mutate('addComment', input), resolveComment: (input) => this.mutate('resolveComment', input),
      createProject: (input) => this.mutate('createProject', input), updateProject: (input) => this.mutate('updateProject', input),
      createIteration: (input) => this.mutate('createIteration', input), updateIteration: (input) => this.mutate('updateIteration', input), completeIteration: (input) => this.mutate('completeIteration', input),
      saveView: (input) => this.mutate('saveView', input), removeView: (input) => this.mutate('removeView', input), triage: (input) => this.mutate('triage', input),
      saveAutomation: (input) => this.mutate('saveAutomation', input), toggleAutomation: (input) => this.mutate('toggleAutomation', input), removeAutomation: (input) => this.mutate('removeAutomation', input), runAutomation: (input) => this.mutate('runAutomation', input),
      markInboxRead: (input) => this.mutate('markInboxRead', input), snoozeInbox: (input) => this.mutate('snoozeInbox', input), clearInbox: (input) => this.mutate('clearInbox', input), restoreInbox: (input) => this.mutate('restoreInbox', input),
      saveAgent: (input) => this.mutate('saveAgent', input), removeAgent: (input) => this.mutate('removeAgent', input), saveSkill: (input) => this.mutate('saveSkill', input), removeSkill: (input) => this.mutate('removeSkill', input), saveCrew: (input) => this.mutate('saveCrew', input), removeCrew: (input) => this.mutate('removeCrew', input),
      resetDemo: async () => this.failure(new ApiError('UNSUPPORTED_WEB_ACTION', '共享工作区不支持重置为本机演示数据'))
    }
    this.creations = new BrowserCreationApi({ projectId: options.project.projectId, session: options.session, context: () => this.context(), isCurrent: this.current, subscribe: (callback) => this.crux.onWorkspaceChanged(callback) })
    this.progress = new BrowserTaskProgress({ projectId: options.project.projectId, session: options.session, context: () => this.context(), isCurrent: this.current })
    this.resources = new BrowserCodeResources({ projectId: options.project.projectId, session: options.session, context: () => this.context(), isCurrent: this.current })
    this.materials = new BrowserTaskMaterials({ projectId: options.project.projectId, session: options.session, context: () => this.context(), isCurrent: this.current, subscribe: callback => this.crux.onWorkspaceChanged(callback) })
    this.governance = new BrowserGovernance({ projectId: options.project.projectId, session: options.session, context: () => this.context(), isCurrent: this.current, subscribe: callback => this.crux.onWorkspaceChanged(callback) })
    authEvents.addEventListener('denied', this.denied)
  }

  context(): CruxWorkspaceContext {
    return { key: this.key, origin: this.options.origin ?? location.origin, connectionId: null, projectId: this.options.project.projectId, projectName: this.options.project.name, actorId: this.snapshotValue?.actor.id ?? null, canManage: this.snapshotValue?.canManage ?? false, revision: this.snapshotValue?.revision ?? 0, state: this.state, pendingCount: this.referenceCount, ...(this.instanceId ? { instanceId: this.instanceId } : {}), ...(this.snapshotValue ? { epoch: this.snapshotValue.epoch, authorizationRevision: this.snapshotValue.authorizationRevision } : {}), ...(this.lastError ? { error: this.lastError } : {}) }
  }

  private owns = (): boolean => this.live && isClientSession(this.options.session) && (this.options.origin ?? location.origin) === location.origin
  private current = (): boolean => this.owns() && !this.locked
  private canInspect(): boolean { return this.owns() && (!this.locked || this.instanceChanged) }
  isCurrent(): boolean { return this.current() }
  private denied = (): void => { if (this.live) this.revoke('此工作区的访问权限已失效，请重新核对登录与工作区权限') }
  private publish(): void {
    const context = this.context(), signature = JSON.stringify([context, this.sending, this.pending?.errorCode, this.pending?.outcomeUnknown])
    if (signature === this.lastPublished) return
    this.lastPublished = signature
    for (const listener of this.listeners) listener(context)
  }
  private revoke(message: string): void {
    this.locked = true; this.state = 'access-revoked'; this.lastError = message
    this.snapshotValue = null; this.pending = null; this.referenceCount = 0; retained.delete(this.key); this.lifetime.abort(); this.publish()
  }
  dispose(): void {
    this.teamContent.dispose()
    this.governance.dispose()
    this.materials.dispose()
    this.resources.dispose()
    this.progress.dispose()
    this.creations.dispose()
    this.live = false; this.lifetime.abort(); authEvents.removeEventListener('denied', this.denied)
    if (this.pending && isClientSession(this.options.session) && (!this.locked || this.instanceChanged)) {
      if (this.sending) this.pending.outcomeUnknown = true
      retained.set(this.key, this.pending)
    } else retained.delete(this.key)
    this.snapshotValue = null; this.pending = null; this.listeners.clear()
  }
  private references(): PendingCommand[] { return pendingCommands(this.options.session.person.userId).filter((entry) => entry.projectId === this.options.project.projectId && entry.path === this.path('commands') && (!entry.workspace || entry.workspace.origin === (this.options.origin ?? location.origin))) }
  private fromReference(entry: PendingCommand): Pending {
    const volatile = retained.get(this.key)
    if (volatile?.entry.commandId === entry.commandId && volatile.entry.digest === entry.digest) { volatile.entry = entry; volatile.outcomeUnknown ||= entry.state === 'unknown'; return volatile }
    return { entry, instanceId: entry.workspace?.instanceId ?? null, createdAt: entry.createdAt, outcomeUnknown: true, errorCode: null }
  }
  private syncReferences(commandId?: string): void {
    try {
      const entries = this.references(); this.referenceCount = entries.length
      const entry = entries.find((item) => item.commandId === (commandId ?? this.pending?.entry.commandId)) ?? entries[0]
      this.pending = entry ? this.fromReference(entry) : null; this.journalError = null
    } catch (error) { this.journalError = error }
  }
  private pendingList(): CruxPendingCommand[] {
    return this.references().map((entry) => {
      const pending = this.pending?.entry.commandId === entry.commandId ? this.pending : this.fromReference(entry)
      return { commandId: entry.commandId, digest: entry.digest, operation: entry.workspace?.operation ?? pending.command?.operation ?? 'cruxCommand', state: this.sending && pending === this.pending ? 'sending' : this.pendingRetired(pending) ? 'retired' : pending.errorCode === 'REVISION_CONFLICT' ? 'conflict' : !pending.prepared ? 'reference-only' : 'pending', outcomeUnknown: pending.outcomeUnknown, errorCode: pending.errorCode, createdAt: entry.createdAt }
    })
  }
  private pendingRetired(pending: Pending): boolean { return this.instanceChanged || Boolean(this.snapshotValue && pending.entry.workspace && (pending.entry.workspace.instanceId !== this.snapshotValue.instanceId || pending.entry.workspace.epoch !== this.snapshotValue.epoch)) }
  private async reconcile(pending: Pending): Promise<'committed' | 'absent'> {
    const result = await reconcileCommand(pending.entry, { notifyDenied: false, signal: this.lifetime.signal, isCurrent: this.current, validateResult: (raw) => {
      this.validateReceipt(raw, pending)
    } })
    if (result === 'committed') { retained.delete(this.key); this.pending = null; this.syncReferences(); this.publish() }
    return result
  }
  private validateReceipt(raw: unknown, pending: Pending): CruxRemoteSnapshot {
    const parsed = cruxRemoteSnapshotSchema.safeParse(raw), scope = pending.entry.workspace
    if (!parsed.success) throw new ApiError('INVALID_RESPONSE', '无法核对原操作回执', 0, true)
    const value = parsed.data
    if (value.projectId !== this.options.project.projectId || value.actor.id !== this.options.session.person.userId || pending.instanceId && value.instanceId !== pending.instanceId || scope && (value.epoch !== scope.epoch || value.revision !== scope.expectedRevision + 1)) throw new ApiError('INVALID_RESPONSE', '原操作回执的账号、工作区、实例、代次或修订不匹配', 0, true)
    return value
  }
  private rosterUnsupported(): CruxFailure { return this.failure(new ApiError('UNSUPPORTED_WEB_ACTION', '请在“团队与成员”中管理真实账号、邀请和工作区授权')) }
  private failure(error: unknown, scopeRead = false): CruxFailure {
    const apiError = error instanceof ApiError ? error : new ApiError('WORKSPACE_ERROR', error instanceof Error ? error.message : '工作区操作失败')
    const businessDenied = ['OPERATION_FORBIDDEN', 'SPACE_ACCESS_DENIED', 'MANAGEMENT_REQUIRED'].includes(apiError.code)
    if (this.live && !this.locked && (apiError.status === 401 || apiError.status === 403 && (scopeRead || !businessDenied) || !isClientSession(this.options.session))) this.revoke(apiError.message)
    else if (this.live && !this.locked && ['NETWORK_UNAVAILABLE', 'INVALID_RESPONSE'].includes(apiError.code)) { this.state = 'offline'; this.lastError = apiError.message; this.publish() }
    return { ok: false, error: apiError.message, code: apiError.code, context: this.context() }
  }
  private cachedReply(): SnapshotReply {
    if (!this.snapshotValue) throw new ApiError('WORKSPACE_UNAVAILABLE', '请先加载当前工作区')
    return { ok: true, data: this.snapshotValue.snapshot, context: this.context() }
  }
  private accept(value: CruxRemoteSnapshot, generation: number): SnapshotReply {
    if (!this.current()) throw new ApiError('OWNER_CHANGED', '工作区的登录身份已改变')
    if (value.projectId !== this.options.project.projectId || value.actor.id !== this.options.session.person.userId) throw new ApiError('INVALID_RESPONSE', '工作区回执的工作区或账号不匹配', 0, true)
    if (this.instanceId && this.instanceId !== value.instanceId) {
      this.instanceChanged = true; this.locked = true; this.state = 'access-revoked'; this.snapshotValue = null
      this.lastError = '团队服务实例已改变，原工作区已锁定；原操作只能明确归档，不能迁移重放'
      if (this.pending) this.pending.errorCode = 'WORKSPACE_INSTANCE_CHANGED'
      this.lifetime.abort(); this.publish()
      throw new ApiError('WORKSPACE_INSTANCE_CHANGED', this.lastError, 409)
    }
    this.instanceId = value.instanceId; pinnedInstances.set(this.key, value.instanceId)
    const cached = this.snapshotValue
    if (cached && cached.epoch !== value.epoch) {
      // A read begun before an accepted epoch transition cannot roll it back.
      if (generation !== this.epochGeneration || this.retiredEpochs.has(value.epoch)) {
        return this.cachedReply()
      }
      this.retiredEpochs.add(cached.epoch); this.epochGeneration++
      this.snapshotValue = value
    } else if (!cached) { this.snapshotValue = value; this.epochGeneration++ }
    else if (value.revision >= cached.revision && value.authorizationRevision >= cached.authorizationRevision) this.snapshotValue = value
    if (this.pending && this.pendingRetired(this.pending)) this.pending.errorCode = 'WORKSPACE_EPOCH_CHANGED'
    this.state = 'connected'; this.lastError = undefined; this.publish()
    return this.cachedReply()
  }
  private path(suffix: string): string { return `/api/projects/${encodeURIComponent(this.options.project.projectId)}/crux/${suffix}` }
  private async read(afterRevision?: number): Promise<SnapshotReply | CruxFailure> {
    if (!this.current()) return this.failure(new ApiError('OWNER_CHANGED', '工作区的登录身份已改变'))
    try {
      const generation = this.epochGeneration
      const query = afterRevision === undefined ? '' : `?afterRevision=${afterRevision}&waitMs=10000`
      return this.accept(await request(this.path('snapshot') + query, cruxRemoteSnapshotSchema, { signal: this.lifetime.signal, isCurrent: this.current }), generation)
    } catch (error) { return this.failure(error, true) }
  }
  private async mutate(operation: CruxMutationName, input: unknown): Promise<SnapshotReply | CruxFailure> {
    if (!this.current()) return this.failure(new ApiError('OWNER_CHANGED', '工作区的登录身份已改变'))
    if (this.preparing || this.sending) return this.failure(new ApiError('IN_FLIGHT', '原操作正在准备或核对'))
    this.preparing = true
    try {
      this.syncReferences()
      if (this.journalError) return this.failure(this.journalError)
      const parsed = cruxMutationInputSchemas[operation].parse(input)
      if (this.pending) {
        if (this.pendingRetired(this.pending)) return this.failure(new ApiError('WORKSPACE_EPOCH_CHANGED', '原操作属于先前工作区代次，请明确归档；编辑草稿保留，未创建新操作', 409))
        const pending = this.pending
        if (await this.reconcile(pending) === 'committed') { await this.read(); return this.failure(new ApiError('ORIGINAL_COMMAND_RECONCILED', '原操作已提交，请先核对当前结果；本次没有创建新操作')) }
        if (pending.command?.operation === operation && JSON.stringify(pending.command.input) === JSON.stringify(parsed)) return this.send(pending)
        if (!pending.prepared) return this.failure(new ApiError('PAYLOAD_UNAVAILABLE', '原回执仍未确认；重载后没有原载荷，不能猜测重试或另建相同意图'))
        return this.failure(new ApiError('PENDING_COMMAND', '请先核对或放弃原操作；当前编辑内容仍保留在表单中'))
      }
      if (!this.snapshotValue) return this.failure(new ApiError('WORKSPACE_UNAVAILABLE', '请先加载已授权的工作区'))
      const head = this.snapshotValue, generation = this.epochGeneration
      const prepared = await prepareCommand(this.path('commands'), { expectedEpoch: head.epoch, expectedRevision: head.revision, operation, input: structuredClone(parsed) }, cruxRemoteSnapshotSchema, this.options.project.projectId, { origin: this.options.origin ?? location.origin, instanceId: head.instanceId, epoch: head.epoch, operation, expectedRevision: head.revision })
      this.pending = { entry: prepared.entry, prepared, command: cruxRemoteCommandSchema.parse(prepared.body), instanceId: head.instanceId, createdAt: prepared.entry.createdAt, outcomeUnknown: false, errorCode: null }
      retained.set(this.key, this.pending)
      this.referenceCount++
      this.publish()
      if (!this.current() || generation !== this.epochGeneration) return this.failure(new ApiError('OWNER_CHANGED', '准备原操作期间工作区来源已改变，未发送'))
      return this.send(this.pending)
    } catch (error) { return this.failure(error) }
    finally { this.preparing = false }
  }
  private async send(pending: Pending): Promise<SnapshotReply | CruxFailure> {
    if (!this.current()) return this.failure(new ApiError('OWNER_CHANGED', '工作区的登录身份已改变'))
    if (!this.snapshotValue) { const reply = await this.read(); if (!reply.ok) return reply }
    if (!this.current() || this.pending !== pending) return this.failure(new ApiError('OWNER_CHANGED', '原工作区或操作已改变，未发送'))
    if (this.pendingRetired(pending)) { pending.errorCode = 'WORKSPACE_EPOCH_CHANGED'; this.publish(); return this.failure(new ApiError('WORKSPACE_EPOCH_CHANGED', '原操作属于先前工作区代次，不能改写 expectedEpoch 后重放；请明确归档原操作', 409)) }
    if (this.sending) return this.failure(new ApiError('IN_FLIGHT', '原操作正在核对'))
    if (!pending.prepared || !pending.command || !canRetry(pending.entry)) return this.failure(new ApiError('PAYLOAD_UNAVAILABLE', '只保留原操作引用，没有可重试的原载荷'))
    const prepared = pending.prepared, command = pending.command, generation = this.epochGeneration
    this.sending = true; this.publish()
    try {
      const reply = await sendCommand(prepared, { notifyDenied: false, signal: this.lifetime.signal, isCurrent: () => this.current() && generation === this.epochGeneration && this.pending?.entry.commandId === pending.entry.commandId && !this.pendingRetired(pending), retainRejected: (error) => error.status === 409 || error.code === 'OWNER_CHANGED', validateResult: (raw) => { this.validateReceipt(raw, pending) } })
      if (reply.commandId !== command.commandId) throw new ApiError('INVALID_RESPONSE', '服务端没有返回匹配的操作回执', 0, true)
      this.pending = null; retained.delete(this.key); this.syncReferences(); this.publish()
      // Historical proof establishes the old command's outcome, never the current cache.
      const result = await this.read()
      if (!result.ok) return this.failure(new ApiError('COMMITTED_REFRESH_UNAVAILABLE', '原操作已提交；当前工作区暂时无法重新核对，请勿重复创建'))
      return { ...result, ...(reply.result.taskId && result.data.tasks.some((task) => task.id === reply.result.taskId) ? { taskId: reply.result.taskId } : {}) }
    } catch (error) {
      if (this.current() && this.pending === pending) {
        pending.errorCode = error instanceof ApiError ? error.code : 'WORKSPACE_ERROR'
        pending.outcomeUnknown ||= !(error instanceof ApiError) || error.uncertain
        // The common client retains unknown references even when a later retry is denied.
        // Only a definitive rejection of a previously known intent removes its journal entry.
        try { if (!this.references().some((entry) => entry.commandId === pending.entry.commandId)) { this.pending = null; retained.delete(this.key); this.syncReferences() } else retained.set(this.key, pending) } catch (journalError) { this.journalError = journalError }
        if (error instanceof ApiError && error.code === 'WORKSPACE_EPOCH_CHANGED') await this.read()
        if (error instanceof ApiError && ['OPERATION_FORBIDDEN', 'SPACE_ACCESS_DENIED', 'MANAGEMENT_REQUIRED'].includes(error.code)) await this.read()
      }
      return this.failure(error)
    } finally { this.sending = false; if (this.live) this.publish() }
  }
  private startPolling(): void {
    if (this.polling || !this.current()) return
    this.polling = (async () => {
      while (this.current() && this.listeners.size) {
        const before = Date.now()
        await this.read(this.snapshotValue?.revision)
        if (!this.current() || !this.listeners.size) break
        // Bound retries after a transport error; abort immediately on owner change.
        const delay = this.state === 'offline' ? 3000 : Math.max(0, 250 - (Date.now() - before))
        if (delay) await new Promise<void>((resolve) => {
          const finish = (): void => { clearTimeout(timer); this.lifetime.signal.removeEventListener('abort', finish); resolve() }
          const timer = setTimeout(finish, delay); this.lifetime.signal.addEventListener('abort', finish, { once: true })
        })
      }
    })().finally(() => { this.polling = null })
  }
}

let active: BrowserCruxWorkspace | null = null
export function bindBrowserCrux(workspace: BrowserCruxWorkspace): () => void {
  active?.dispose(); active = workspace
  return () => { workspace.dispose(); if (active === workspace) active = null }
}

/** Shared renderer imports are redirected here by Vite; never install window.trellis. */
const crux = new Proxy({} as CruxApi, { get: (_target, property) => {
  if (property === 'onWorkspaceChanged') return (callback: (context: CruxWorkspaceContext) => void) => active?.crux.onWorkspaceChanged(callback) ?? (() => {})
  return (...args: unknown[]) => {
    if (!active) return Promise.resolve({ ok: false, error: '浏览器工作区尚未连接', code: 'WORKSPACE_UNAVAILABLE' })
    const method = Reflect.get(active.crux, property)
    if (typeof method !== 'function') return Promise.reject(new ApiError('UNSUPPORTED_WEB_ACTION', `浏览器不支持 Crux.${String(property)}`))
    return Reflect.apply(method, active.crux, args)
  }
} })
const creations = new Proxy({} as CreationApi, { get: (_target, property) => {
  if (property === 'onChanged') return (callback: Parameters<CreationApi['onChanged']>[0]) => active?.creations.onChanged(callback) ?? (() => {})
  return (...args: unknown[]) => {
    if (!active) return Promise.resolve({ ok: false, code: 'WORKSPACE_UNAVAILABLE', error: '浏览器工作区尚未连接' })
    const method = Reflect.get(active.creations, property)
    return typeof method === 'function' ? Reflect.apply(method, active.creations, args) : Promise.resolve({ ok: false, code: 'UNSUPPORTED_WEB_ACTION', error: `浏览器不支持 creations.${String(property)}` })
  }
} })
function unsupportedNative(path: string): unknown {
  return new Proxy(() => Promise.reject(new ApiError('UNSUPPORTED_WEB_ACTION', `网页版不支持桌面能力：${path}`)), {
    get: (_target, property) => property === 'then' ? undefined : unsupportedNative(`${path}.${String(property)}`)
  })
}
// TrellisApi is the shared renderer's type boundary. Support Crux, creations and the trusted
// team-management route; every desktop action rejects explicitly.
const cruxProgress = new Proxy({} as CruxProgressApi, { get: (_target, property) => (...args: unknown[]) => {
  const method = active && Reflect.get(active.progress.api, property)
  return typeof method === 'function' ? Reflect.apply(method, active?.progress.api, args) : Promise.resolve({ ok: false, code: 'E_UNAVAILABLE', error: '浏览器工作区不支持此进度操作。' })
} })
const cruxResources = new Proxy({} as CruxCodeResourceApi, { get: (_target, property) => (...args: unknown[]) => {
  const method = active && Reflect.get(active.resources.api, property)
  return typeof method === 'function' ? Reflect.apply(method, active?.resources.api, args) : Promise.resolve({ ok: false, code: 'WORKSPACE_UNAVAILABLE', error: '浏览器工作区尚未连接' })
} })
const cruxMaterials = new Proxy({} as CruxTaskMaterialsApi, { get: (_target, property) => (...args: unknown[]) => {
  const method = active && Reflect.get(active.materials.api, property)
  return typeof method === 'function' ? Reflect.apply(method, active?.materials.api, args) : Promise.resolve({ ok: false, code: 'WORKSPACE_UNAVAILABLE', error: '浏览器材料工作区尚未连接' })
} })
const cruxGovernance = new Proxy({} as TeamGovernanceApi, { get: (_target, property) => (...args: unknown[]) => {
  const method = active && Reflect.get(active.governance.api, property)
  return typeof method === 'function' ? Reflect.apply(method, active?.governance.api, args) : Promise.resolve({ ok: false, code: 'WORKSPACE_UNAVAILABLE', error: '团队规则与输入尚未连接' })
} })
const teamContent = new Proxy({} as TeamContentApi, { get: (_target, property) => (...args: unknown[]) => {
  const method = active && Reflect.get(active.teamContent.api, property)
  return typeof method === 'function' ? Reflect.apply(method, active?.teamContent.api, args) : Promise.resolve({ ok: false, code: 'WORKSPACE_UNAVAILABLE', error: '团队内容工作区尚未连接' })
} })
export const api = new Proxy({ crux, creations, cruxProgress, cruxResources, cruxMaterials, cruxGovernance, teamContent, openExternal: async (url: string): Promise<void> => {
  const target = new URL(url, location.origin)
  if (target.origin !== location.origin || target.pathname !== '/' || target.search || target.hash !== '#people') throw new ApiError('UNSUPPORTED_WEB_ACTION', '网页版仅支持前往当前服务的团队与邀请页面')
  location.hash = '#people'
} }, { get: (target, property) => property in target ? Reflect.get(target, property) : unsupportedNative(String(property)) }) as unknown as TrellisApi
/** A compatible Crux bridge is present; this does not claim native IPC availability. */
export const hasIpc = true

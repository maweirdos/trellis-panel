import { z } from 'zod'
import {
  cruxMaterialScopeSchema, cruxMaterialListSchema, cruxMaterialReadSchema,
  cruxMaterialHistorySchema, cruxMaterialCommandSchema, cruxMaterialRecoverySchema,
  type CruxTaskMaterialsApi, type CruxMaterialScope, type CruxMaterialReply
} from '../../../src/shared/crux-task-materials'
import {
  teamTaskMaterialListSchema, teamTaskMaterialViewSchema, teamTaskMaterialHistorySchema,
  teamTaskMaterialSubmissionsSchema, teamTaskMaterialReceiptSchema,
  type TeamTaskMaterialCommand, type TeamTaskMaterialMetadata, type TeamTaskMaterialReceipt,
  type TeamTaskMaterialCommandReply
} from '../../../src/shared/team-task-materials'
import type { CruxWorkspaceContext } from '../../../src/shared/crux-remote'
import { TEAM_MAX_DOCUMENT_BYTES, type TeamSession } from './contracts'
import {
  ApiError, authEvents, digest, isClientSession, pendingCommands, prepareCommand, request, requireBrowserCrypto,
  sendCommand, settleCommandReference, verifyDocument, type PendingCommand, type PreparedCommand
} from './client'
import { materialReferences, rememberMaterialReference, type MaterialCommandReference } from './task-materials-browser-journal'

export type BrowserTaskMaterialsOptions = {
  projectId: string
  session: TeamSession
  context(): CruxWorkspaceContext
  isCurrent(): boolean
  subscribe(callback: (context: CruxWorkspaceContext) => void): () => void
}
type Owner = {
  scope: CruxMaterialScope
  instanceId: string
  epoch: string
  authorizationRevision: number
  generation: number
  current(): boolean
}
type Identity = Pick<TeamTaskMaterialReceipt, 'instanceId' | 'epoch' | 'authorizationRevision'>
type TaskIdentity = Pick<TeamTaskMaterialReceipt, 'projectId' | 'taskId' | 'spaceId' | 'taskCreatedAt'>

/** One browser workspace lease; recovery never rebuilds a command from a live editor. */
export class BrowserTaskMaterials {
  readonly api: CruxTaskMaterialsApi
  private live = true
  private generation = 0
  private source: string
  private scopeKey: string | null = null
  private writing = false
  private readonly lifetime = new AbortController()
  private readonly retained = new Map<string, PreparedCommand<TeamTaskMaterialReceipt>>()
  private readonly unsubscribe: () => void

  constructor(private readonly options: BrowserTaskMaterialsOptions) {
    this.source = this.signature(options.context())
    this.unsubscribe = options.subscribe((context) => this.observe(context))
    authEvents.addEventListener('denied', this.invalidate)
    authEvents.addEventListener('session-changed', this.invalidate)
    this.api = {
      list: (input) => this.run(async () => {
        const parsed = cruxMaterialListSchema.parse(input), owner = this.owner(parsed)
        const value = await request(this.url(owner.scope, '', parsed), teamTaskMaterialListSchema, this.readOptions(owner))
        this.identity(value, owner); this.task(value, owner)
        for (const document of value.page.items) this.document(document, owner)
        return value
      }),
      read: (input) => this.run(async () => {
        const parsed = cruxMaterialReadSchema.parse(input), owner = this.owner(parsed)
        const value = await request(this.url(owner.scope, `/${encodeURIComponent(parsed.documentId)}`, parsed), teamTaskMaterialViewSchema, this.readOptions(owner))
        this.identity(value, owner); this.document(value.document, owner, parsed.documentId)
        if (value.selected.documentId !== parsed.documentId || value.selected.versionId !== (parsed.versionId ?? value.document.draft.versionId)) this.invalid('材料正文的文档或固定版本不匹配')
        if (value.selected.versionId === value.document.draft.versionId && JSON.stringify(value.selected) !== JSON.stringify(value.document.draft)) this.invalid('材料正文与草稿版本元信息不匹配')
        await verifyDocument(value.text, value.selected.bodyDigest, value.selected.byteLength)
        this.assertCurrent(owner)
        return value
      }),
      versions: (input) => this.run(async () => {
        const parsed = cruxMaterialHistorySchema.parse(input), owner = this.owner(parsed)
        const value = await request(this.url(owner.scope, `/${encodeURIComponent(parsed.documentId)}/versions`, parsed), teamTaskMaterialHistorySchema, this.readOptions(owner))
        this.identity(value, owner)
        if (value.page.items.some((item) => item.documentId !== parsed.documentId)) this.invalid('材料版本历史的文档归属不匹配')
        return value
      }),
      submissions: (input) => this.run(async () => {
        const parsed = cruxMaterialHistorySchema.parse(input), owner = this.owner(parsed)
        const value = await request(this.url(owner.scope, `/${encodeURIComponent(parsed.documentId)}/submissions`, parsed), teamTaskMaterialSubmissionsSchema, this.readOptions(owner))
        this.identity(value, owner)
        if (value.page.items.some((item) => item.documentId !== parsed.documentId)) this.invalid('材料提交历史的文档归属不匹配')
        return value
      }),
      pending: (input) => this.run(async () => {
        const owner = this.owner(cruxMaterialScopeSchema.parse(input))
        const common = pendingCommands(options.session.person.userId)
        return materialReferences().filter((item) => item.state !== 'committed' && this.sameScope(item, owner.scope)).map((item) => {
          const entry = common.find((candidate) => candidate.commandId === item.commandId)
          const missingBody = !this.retained.has(item.commandId)
          const unknown = item.state === 'unknown' || entry?.state === 'unknown' || item.state === 'pending' && missingBody
          return { commandId: item.commandId, action: item.action, documentId: item.documentId,
            state: unknown ? 'unknown' as const : item.state === 'rejected' ? 'rejected' as const : 'pending' as const,
            createdAt: item.createdAt, errorCode: item.errorCode ?? (missingBody ? 'PAYLOAD_UNAVAILABLE' : null),
            error: missingBody ? '仅保留原操作元信息，没有原始正文，不能重发；请核对原回执' : item.errorCode ? '原材料操作尚未确认，请核对原回执' : null,
            outcomeUnknown: unknown }
        })
      }),
      command: (input) => this.run(() => this.exclusive(async () => {
        const parsed = cruxMaterialCommandSchema.parse(input), owner = this.owner(parsed), command = parsed.command
        if (command.spaceId !== owner.scope.spaceId || command.taskCreatedAt !== owner.scope.taskCreatedAt) throw new ApiError('SCOPE_MISMATCH', '材料命令与原任务实例不匹配')
        if (command.expectedEpoch !== owner.epoch) throw new ApiError('WORKSPACE_EPOCH_CHANGED', '材料来源代次已改变，请重新读取')
        requireBrowserCrypto()
        if (command.action === 'create' || command.action === 'saveDraft') {
          const bytes = new TextEncoder().encode(command.text).byteLength
          if (bytes > TEAM_MAX_DOCUMENT_BYTES) throw new ApiError('CAPACITY_EXCEEDED', '材料正文超过一 MiB 上限')
          await verifyDocument(command.text, command.expectedDigest, bytes)
          this.assertCurrent(owner)
        }
        const hash = await digest(JSON.stringify(command))
        this.assertCurrent(owner)
        const existing = materialReferences().find((item) => item.commandId === command.commandId)
        if (existing) {
          this.referenceOwner(existing, owner)
          if (existing.digest !== hash) throw new ApiError('COMMAND_CONFLICT', '原材料操作的正文或参数已改变，不能沿用原标识')
          if (existing.state !== 'committed') throw new ApiError('PENDING_COMMAND', '原材料操作已保留，请先核对，再显式重试', 0, existing.state !== 'rejected')
          const receipt = await this.reconcile(existing, owner)
          if (!receipt) throw new ApiError('OUTCOME_UNKNOWN', '已确认的原材料回执暂不可见，请继续核对', 0, true)
          return { status: 'duplicate', commandId: command.commandId, result: receipt }
        }
        const reference = this.newReference(owner, command, hash)
        // Retain the original identity before any HTTP, including recovery preflight.
        rememberMaterialReference(reference)
        const prepared = await prepareCommand(this.path(owner.scope) + '/commands', command, teamTaskMaterialReceiptSchema, options.projectId,
          { origin: location.origin, instanceId: owner.instanceId, epoch: owner.epoch, operation: `task-material:${command.action}`, expectedRevision: reference.expectedRevision ?? reference.expectedDraftRevision ?? 0 }, command.commandId)
        this.assertCurrent(owner)
        this.validateEntry(prepared.entry, reference, owner)
        this.retained.set(command.commandId, prepared)
        // An evicted settled UUID must never authorize a new payload with that UUID.
        const historical = await this.reconcile(reference, owner)
        if (historical) throw new ApiError('COMMAND_ALREADY_COMMITTED', '原标识已有历史回执；请核对原操作，不要将它用于新正文')
        return this.send(prepared, reference, owner)
      })),
      reconcile: (input) => this.run(() => this.exclusive(async () => {
        const parsed = cruxMaterialRecoverySchema.parse(input), owner = this.owner(parsed)
        const reference = this.reference(parsed.commandId, owner)
        return this.withOriginalOutcome(reference, () => this.reconcile(reference, owner))
      })),
      retry: (input) => this.run(() => this.exclusive(async () => {
        const parsed = cruxMaterialRecoverySchema.parse(input), owner = this.owner(parsed)
        const reference = this.reference(parsed.commandId, owner)
        return this.withOriginalOutcome(reference, async (): Promise<TeamTaskMaterialCommandReply> => {
          const receipt = await this.reconcile(reference, owner)
          if (receipt) return { status: 'duplicate', commandId: parsed.commandId, result: receipt }
          if (reference.state === 'committed') throw new ApiError('OUTCOME_UNKNOWN', '已提交材料的回执暂不可见，不能重新发送', 0, true)
          const prepared = this.retained.get(parsed.commandId)
          if (!prepared) throw new ApiError('PAYLOAD_UNAVAILABLE', '重载或来源切换后仅保留原操作元信息；没有原始正文，不能重建重试，请继续核对回执', 0, true)
          this.validateEntry(prepared.entry, reference, owner)
          return this.send(prepared, reference, owner)
        })
      }))
    }
  }

  dispose(): void {
    if (!this.live) return
    this.live = false; this.invalidate(); this.lifetime.abort(); this.unsubscribe()
    authEvents.removeEventListener('denied', this.invalidate)
    authEvents.removeEventListener('session-changed', this.invalidate)
  }

  private signature(context: CruxWorkspaceContext): string {
    return JSON.stringify([context.key, context.origin, context.projectId, context.actorId, context.instanceId, context.epoch, context.authorizationRevision, context.state === 'access-revoked', context.state === 'local'])
  }
  private invalidate = (): void => { this.generation++; this.retained.clear() }
  private observe(context: CruxWorkspaceContext): void {
    const source = this.signature(context)
    if (source !== this.source) { this.source = source; this.invalidate() }
  }
  private owner(input: CruxMaterialScope): Owner {
    const scope = cruxMaterialScopeSchema.parse({ workspaceKey: input.workspaceKey, taskId: input.taskId, spaceId: input.spaceId, taskCreatedAt: input.taskCreatedAt })
    const context = this.options.context()
    this.observe(context)
    const key = JSON.stringify(scope)
    if (this.scopeKey !== key) { this.scopeKey = key; this.invalidate() }
    if (context.state === 'local') throw new ApiError('MATERIALS_UNSUPPORTED', '任务材料仅适用于团队工作区')
    if (!this.live || !this.options.isCurrent() || !isClientSession(this.options.session) || context.state === 'access-revoked'
      || context.key !== scope.workspaceKey || context.projectId !== this.options.projectId || context.actorId !== this.options.session.person.userId
      || context.origin !== undefined && context.origin !== location.origin) {
      this.invalidate()
      throw new ApiError('OWNER_CHANGED', '材料工作区的账号、来源或权限已改变')
    }
    if (!context.instanceId || !context.epoch) throw new ApiError('WORKSPACE_UNAVAILABLE', '请先连接并核对当前团队工作区')
    const generation = this.generation
    return { scope, instanceId: context.instanceId, epoch: context.epoch, authorizationRevision: context.authorizationRevision ?? 0, generation,
      current: () => {
        this.observe(this.options.context())
        if (!this.options.isCurrent() || !isClientSession(this.options.session)) this.invalidate()
        return this.live && generation === this.generation && !this.lifetime.signal.aborted
      } }
  }
  private assertCurrent(owner: Owner): void {
    if (!owner.current()) throw new ApiError('OWNER_CHANGED', '材料来源已改变，未采用原请求结果')
  }
  private readOptions(owner: Owner) { return { signal: this.lifetime.signal, notifyDenied: false, isCurrent: owner.current } }
  private path(scope: CruxMaterialScope): string {
    return `/api/projects/${encodeURIComponent(this.options.projectId)}/crux/tasks/${encodeURIComponent(scope.taskId)}/materials`
  }
  private url(scope: CruxMaterialScope, suffix = '', query: { cursor?: string; limit?: number; versionId?: string } = {}): string {
    const search = new URLSearchParams({ spaceId: scope.spaceId, taskCreatedAt: scope.taskCreatedAt })
    for (const key of ['cursor', 'limit', 'versionId'] as const) if (query[key] !== undefined) search.set(key, String(query[key]))
    return `${this.path(scope)}${suffix}?${search}`
  }
  private invalid(message: string): never { throw new ApiError('INVALID_RESPONSE', message) }
  private identity(value: Identity, owner: Owner, historical = false): void {
    this.assertCurrent(owner)
    if (value.instanceId !== owner.instanceId || value.epoch !== owner.epoch || !historical && value.authorizationRevision < owner.authorizationRevision) throw new ApiError('WORKSPACE_EPOCH_CHANGED', '材料响应的来源或权限代次不匹配')
  }
  private task(value: TaskIdentity, owner: Owner): void {
    if (value.projectId !== this.options.projectId || value.taskId !== owner.scope.taskId || value.spaceId !== owner.scope.spaceId || value.taskCreatedAt !== owner.scope.taskCreatedAt) this.invalid('材料响应不属于原任务实例')
  }
  private document(value: TeamTaskMaterialMetadata, owner: Owner, documentId = value.documentId): void {
    this.task(value, owner)
    if (value.documentId !== documentId || value.draft.documentId !== documentId || value.template.templateId !== value.kind
      || value.draft.disposition !== 'draft' || value.approved && (value.approved.documentId !== documentId || value.approved.status !== 'approved')
      || value.latestSubmission && value.latestSubmission.documentId !== documentId) this.invalid('材料元信息的文档、模板或版本归属不匹配')
  }
  private sameScope(reference: MaterialCommandReference, scope: CruxMaterialScope): boolean {
    return reference.origin === location.origin && reference.accountId === this.options.session.person.userId && reference.projectId === this.options.projectId
      && reference.scope.workspaceKey === scope.workspaceKey && reference.scope.taskId === scope.taskId
      && reference.scope.spaceId === scope.spaceId && reference.scope.taskCreatedAt === scope.taskCreatedAt
  }
  private referenceOwner(reference: MaterialCommandReference, owner: Owner): void {
    this.assertCurrent(owner)
    if (!this.sameScope(reference, owner.scope)) throw new ApiError('OWNER_CHANGED', '原材料操作不属于当前账号和任务实例')
    if (reference.instanceId !== owner.instanceId || reference.epoch !== owner.epoch) throw new ApiError('WORKSPACE_EPOCH_CHANGED', '原材料操作属于先前服务实例或代次，不能迁移重试', 0, reference.state !== 'committed')
  }
  private reference(commandId: string, owner: Owner): MaterialCommandReference {
    const reference = materialReferences().find((item) => item.commandId === commandId)
    if (!reference) throw new ApiError('NOT_FOUND', '没有此原材料操作引用，请刷新材料和待核对操作')
    this.referenceOwner(reference, owner)
    return reference
  }
  private validateEntry(entry: PendingCommand, reference: MaterialCommandReference, owner: Owner): void {
    this.referenceOwner(reference, owner)
    if (entry.commandId !== reference.commandId || entry.digest !== reference.digest || entry.accountId !== reference.accountId || entry.projectId !== reference.projectId
      || entry.path !== this.path(owner.scope) + '/commands' || entry.workspace?.origin !== reference.origin || entry.workspace.instanceId !== reference.instanceId
      || entry.workspace.epoch !== reference.epoch || entry.workspace.operation !== `task-material:${reference.action}`) throw new ApiError('COMMAND_CONFLICT', '原材料命令引用的身份或摘要不匹配')
  }
  private newReference(owner: Owner, command: TeamTaskMaterialCommand, hash: string): MaterialCommandReference {
    return { scope: owner.scope, origin: location.origin, accountId: this.options.session.person.userId, projectId: this.options.projectId,
      instanceId: owner.instanceId, epoch: owner.epoch, commandId: command.commandId, digest: hash, action: command.action,
      documentId: 'documentId' in command ? command.documentId : null, versionId: 'versionId' in command ? command.versionId : null,
      submissionId: 'submissionId' in command ? command.submissionId : null,
      expectedRevision: 'expectedRevision' in command ? command.expectedRevision : null,
      expectedDraftRevision: 'expectedDraftRevision' in command ? command.expectedDraftRevision : null,
      createdAt: Date.now(), state: 'pending', errorCode: null }
  }
  private receipt(raw: unknown, reference: MaterialCommandReference, owner: Owner): TeamTaskMaterialReceipt {
    this.referenceOwner(reference, owner)
    const value = teamTaskMaterialReceiptSchema.parse(raw)
    this.identity(value, owner, true); this.task(value, owner)
    if (value.commandId !== reference.commandId || value.action !== reference.action || value.actorId !== reference.accountId || value.deviceId !== null
      || reference.documentId !== null && value.documentId !== reference.documentId
      || reference.versionId !== null && value.versionId !== reference.versionId
      || reference.submissionId !== null && value.submissionId !== reference.submissionId
      || reference.expectedRevision !== null && value.revision !== reference.expectedRevision + 1
      || value.outcome === 'conflict-preserved' && value.action !== 'saveDraft') this.invalid('原材料回执的命令、作者、文档或固定版本不匹配')
    if (value.action === 'create' && (value.revision !== 1 || value.draftRevision !== 1)
      || value.action === 'saveDraft' && reference.expectedDraftRevision !== null && (value.outcome === 'applied' ? value.draftRevision !== reference.expectedDraftRevision + 1 : value.draftRevision <= reference.expectedDraftRevision)
      || value.action === 'submit' && value.draftRevision !== reference.expectedDraftRevision
      || value.action === 'setAccess' && (value.versionId !== null || value.submissionId !== null)
      || value.action !== 'setAccess' && value.versionId === null
      || ['submit', 'approve', 'reject'].includes(value.action) && value.submissionId === null
      || ['create', 'saveDraft'].includes(value.action) && value.submissionId !== null) this.invalid('原材料回执的修订或提交状态不匹配')
    return value
  }
  private async receiptRequest(reference: MaterialCommandReference, owner: Owner): Promise<TeamTaskMaterialReceipt | null> {
    this.referenceOwner(reference, owner)
    // This scoped route rechecks current task and source-reference ACL, even when absent.
    const value = await request(this.url(owner.scope, `/commands/${encodeURIComponent(reference.commandId)}`), teamTaskMaterialReceiptSchema.nullable(), this.readOptions(owner))
    this.assertCurrent(owner)
    return value === null ? null : this.receipt(value, reference, owner)
  }
  private async reconcile(reference: MaterialCommandReference, owner: Owner): Promise<TeamTaskMaterialReceipt | null> {
    const receipt = await this.receiptRequest(reference, owner)
    if (!receipt) return null
    const entry = pendingCommands(this.options.session.person.userId).find((item) => item.commandId === reference.commandId)
    if (entry) { this.validateEntry(entry, reference, owner); settleCommandReference(entry) }
    this.retained.delete(reference.commandId)
    rememberMaterialReference({ ...reference, state: 'committed', errorCode: null })
    return receipt
  }
  private async send(prepared: PreparedCommand<TeamTaskMaterialReceipt>, reference: MaterialCommandReference, owner: Owner): Promise<TeamTaskMaterialCommandReply> {
    this.validateEntry(prepared.entry, reference, owner)
    let attempted = false
    try {
      attempted = true
      const reply = await sendCommand(prepared, { ...this.readOptions(owner), retainRejected: () => true,
        validateResult: (raw) => {
          try { this.receipt(raw, reference, owner) }
          catch (error) { throw new ApiError('INVALID_RESPONSE', error instanceof Error ? error.message : '材料回执无法核对', 0, true) }
        } })
      this.assertCurrent(owner)
      this.retained.delete(reference.commandId)
      rememberMaterialReference({ ...reference, state: 'committed', errorCode: null })
      return reply
    } catch (cause) {
      const error = cause instanceof ApiError ? cause : new ApiError('MATERIALS_UNAVAILABLE', '材料原操作结果尚未确认', 0, attempted)
      const unknown = error.uncertain || reference.state === 'unknown' || error.code === 'OWNER_CHANGED' || error.code === 'JOURNAL_UNAVAILABLE'
      try { rememberMaterialReference({ ...reference, state: unknown ? 'unknown' : 'rejected', errorCode: error.code }) }
      catch { throw new ApiError('LOCAL_RECEIPT_UNAVAILABLE', '浏览器未能保存核对结果；请保留原操作标识继续核对', 0, true) }
      if (unknown && !error.uncertain) throw new ApiError(error.code, error.message, error.status, true)
      throw error
    }
  }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.writing) throw new ApiError('IN_FLIGHT', '材料原操作正在准备或核对')
    this.writing = true
    try { return await action() } finally { this.writing = false }
  }
  private async withOriginalOutcome<T>(reference: MaterialCommandReference, action: () => Promise<T>): Promise<T> {
    try { return await action() }
    catch (cause) {
      // A later denial cannot establish that an earlier unacknowledged write failed.
      if (reference.state !== 'rejected' && !(cause instanceof ApiError && cause.uncertain)) {
        const error = cause instanceof ApiError ? cause : new ApiError('MATERIALS_UNAVAILABLE', '原材料操作结果尚未核对')
        throw new ApiError(error.code, error.message, error.status, true)
      }
      throw cause
    }
  }
  private async run<T>(action: () => Promise<T>): Promise<CruxMaterialReply<T>> {
    try { return { ok: true, value: await action() } }
    catch (cause) {
      const error = cause instanceof ApiError ? cause : cause instanceof z.ZodError
        ? new ApiError('INVALID_INPUT', '材料请求或原操作引用与接口合同不符')
        : new ApiError('MATERIALS_UNAVAILABLE', '任务材料暂不可用，请重新核对')
      if (error.status === 401 || error.status === 403) this.invalidate()
      return { ok: false, code: error.code, error: error.message, ...(error.uncertain ? { outcomeUnknown: true } : {}) }
    }
  }
}

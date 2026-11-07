import { z } from 'zod'
import {
  governanceCommandInputSchema, governanceCommandReplySchema, governanceCommandSchema, governanceListInputSchema, governanceListSchema,
  governanceReadInputSchema, governanceReceiptSchema, governanceRecoveryInputSchema, governanceRecoveryScopeSchema, governanceViewSchema,
  type GovernanceCommand, type GovernanceReceipt, type GovernanceRecoveryScope, type GovernanceReply, type TeamGovernanceApi
} from '../../../src/shared/team-governance'
import {
  taskInputAdoptInputSchema, taskInputBundleSchema, taskInputCandidatesSchema, taskInputCommandReplySchema, taskInputCommandSchema,
  taskInputReadSchema, taskInputReceiptSchema, taskInputRevisionInputSchema, taskInputScopeSchema, taskInputBundleDigestText, taskInputCanonical, taskInputDocumentViewSchema,
  type TaskInputCommand, type TaskInputReceipt, type TaskInputScope
} from '../../../src/shared/team-task-inputs'
import { taskMaterialInputReferenceSchema } from '../../../src/shared/task-material-inputs'
import { teamIdSchema, type TeamSession } from './contracts'
import type { CruxWorkspaceContext } from '../../../src/shared/crux-remote'
import { ApiError, authEvents, digest, isClientSession, request, requireBrowserCrypto, verifyDocument } from './client'

export type BrowserGovernanceOptions = { projectId: string; session: TeamSession; context(): CruxWorkspaceContext; isCurrent(): boolean; subscribe(callback: (context: CruxWorkspaceContext) => void): () => void }
const referenceSchema = z.object({ scope: governanceRecoveryScopeSchema, origin: z.string().url(), projectId: teamIdSchema, accountId: teamIdSchema, instanceId: teamIdSchema, epoch: teamIdSchema, commandId: teamIdSchema, digest: z.string().regex(/^[a-f0-9]{64}$/), action: z.string().max(50), state: z.enum(['pending', 'unknown', 'rejected', 'committed']), createdAt: z.number().int().nonnegative(), error: z.string().max(2000).nullable() }).strict()
type Reference = z.infer<typeof referenceSchema>
type Owner = { scope: GovernanceRecoveryScope; instanceId: string; epoch: string; accountId: string; generation: number }
const STORAGE = 'trellis-team-governance-command-refs-v1'
const scopeKey = (scope: GovernanceRecoveryScope): string => JSON.stringify(governanceRecoveryScopeSchema.parse(scope))
const taskScope = (scope: Extract<GovernanceRecoveryScope, { lane: 'inputs' }>): TaskInputScope => ({ workspaceKey: scope.workspaceKey, spaceId: scope.spaceId, taskId: scope.taskId, taskCreatedAt: scope.taskCreatedAt })

/** Bodies stay in memory; a reloaded browser can reconcile the exact UUID without reconstructing an editor submission. */
export class BrowserGovernance {
  readonly api: TeamGovernanceApi
  private live = true
  private generation = 0
  private source: string
  private writing = false
  private readonly lifetime = new AbortController()
  private readonly retained = new Map<string, { command: GovernanceCommand | TaskInputCommand; generation: number }>()
  private readonly unsubscribe: () => void
  constructor(private readonly options: BrowserGovernanceOptions) {
    this.source = this.signature(options.context())
    this.unsubscribe = options.subscribe(context => {
      const next = this.signature(context)
      if (next !== this.source) { this.source = next; this.generation++; this.retained.clear() }
    })
    authEvents.addEventListener('denied', this.invalidate)
    authEvents.addEventListener('session-changed', this.invalidate)
    this.api = {
      readDocument: raw => this.run(async () => {
        const input = taskInputScopeSchema.extend({ reference: taskMaterialInputReferenceSchema }).strict().parse(raw)
        const scope = { workspaceKey: input.workspaceKey, spaceId: input.spaceId, taskId: input.taskId, taskCreatedAt: input.taskCreatedAt, lane: 'inputs' as const }
        const owner = this.owner(scope), reference = input.reference
        const value = await this.get(owner, `${this.base(scope)}/documents/${reference.documentId}/versions/${reference.versionId}?${this.query(scope)}`, taskInputDocumentViewSchema)
        this.identity(owner, value); this.taskIdentity(owner, value)
        if (taskInputCanonical(value.reference) !== taskInputCanonical(reference)) this.invalid()
        await verifyDocument(value.text, reference.bodyDigest, reference.byteLength); this.current(owner)
        return value
      }),
      list: raw => this.run(async () => {
        const input = governanceListInputSchema.parse(raw), owner = this.owner({ workspaceKey: input.workspaceKey, spaceId: input.spaceId, lane: 'governance' })
        const query = new URLSearchParams()
        if (input.cursor) query.set('cursor', input.cursor)
        query.set('limit', String(input.limit))
        const value = await this.get(owner, this.base(owner.scope) + '?' + query, governanceListSchema)
        this.identity(owner, value)
        if (value.projectId !== options.projectId || value.spaceId !== input.spaceId || value.page.items.some(pkg => pkg.spaceId !== input.spaceId || pkg.projectId !== options.projectId)) this.invalid()
        return value
      }),
      read: raw => this.run(async () => {
        const input = governanceReadInputSchema.parse(raw), owner = this.owner({ workspaceKey: input.workspaceKey, spaceId: input.spaceId, lane: 'governance' })
        const value = await this.get(owner, `${this.base(owner.scope)}/${input.packageId}${input.versionId ? '?versionId=' + input.versionId : ''}`, governanceViewSchema)
        this.identity(owner, value)
        if (value.package.projectId !== options.projectId || value.package.spaceId !== input.spaceId || value.package.packageId !== input.packageId || value.selected.packageId !== input.packageId || value.selected.versionId !== (input.versionId ?? value.package.draft.versionId) || value.selected.settings.kind !== value.package.kind) this.invalid()
        await verifyDocument(value.text, value.selected.bodyDigest, value.selected.byteLength); this.current(owner)
        return value
      }),
      inputs: raw => this.run(async () => {
        const input = taskInputScopeSchema.parse(raw), owner = this.owner({ ...input, lane: 'inputs' })
        const value = await this.get(owner, `${this.base(owner.scope)}?${this.query(owner.scope)}`, taskInputReadSchema)
        this.identity(owner, value); this.taskIdentity(owner, value)
        if (value.current) { this.taskIdentity(owner, value.current); if (await digest(taskInputBundleDigestText(value.current)) !== value.current.digest) this.invalid(); this.current(owner) }
        return value
      }),
      candidates: raw => this.run(async () => {
        const input = taskInputScopeSchema.parse(raw), owner = this.owner({ ...input, lane: 'inputs' })
        const value = await this.get(owner, `${this.base(owner.scope)}/candidates?${this.query(owner.scope)}`, taskInputCandidatesSchema)
        this.identity(owner, value); this.taskIdentity(owner, value)
        if (value.documents.some(doc => doc.spaceId !== input.spaceId || doc.taskCreatedAt !== input.taskCreatedAt)) this.invalid()
        return value
      }),
      inputRevision: raw => this.run(async () => {
        const input = taskInputRevisionInputSchema.parse(raw), owner = this.owner({ workspaceKey: input.workspaceKey, spaceId: input.spaceId, taskId: input.taskId, taskCreatedAt: input.taskCreatedAt, lane: 'inputs' })
        const value = await this.get(owner, `${this.base(owner.scope)}/revisions/${input.revision}?${this.query(owner.scope)}`, taskInputBundleSchema)
        this.taskIdentity(owner, value)
        if (value.revision !== input.revision || await digest(taskInputBundleDigestText(value)) !== value.digest) this.invalid()
        this.current(owner)
        return value
      }),
      command: raw => this.run(() => this.exclusive(async () => {
        const input = governanceCommandInputSchema.parse(raw), owner = this.owner({ workspaceKey: input.workspaceKey, spaceId: input.spaceId, lane: 'governance' })
        const reply = await this.submit(owner, input.command)
        return { ...reply, result: governanceReceiptSchema.parse(reply.result) }
      })),
      adopt: raw => this.run(() => this.exclusive(async () => {
        const input = taskInputAdoptInputSchema.parse(raw), owner = this.owner({ workspaceKey: input.workspaceKey, spaceId: input.spaceId, taskId: input.taskId, taskCreatedAt: input.taskCreatedAt, lane: 'inputs' })
        const reply = await this.submit(owner, input.command)
        return { ...reply, result: taskInputReceiptSchema.parse(reply.result) }
      })),
      pending: raw => this.run(async () => {
        const owner = this.owner(governanceRecoveryScopeSchema.parse(raw))
        return this.references().filter(ref => ref.state !== 'committed' && ref.accountId === owner.accountId && ref.projectId === options.projectId && ref.origin === location.origin && scopeKey(ref.scope) === scopeKey(owner.scope)).map(ref => ({ commandId: ref.commandId, action: ref.action, state: ref.state === 'committed' ? 'unknown' as const : ref.state, createdAt: ref.createdAt, error: ref.error ?? (!this.retained.has(ref.commandId) ? '仅保留原操作引用，可核对回执；原正文不在本页，不能重发。' : null), canRetry: this.retained.get(ref.commandId)?.generation === owner.generation && ref.epoch === owner.epoch && ref.instanceId === owner.instanceId, outcomeUnknown: ref.state !== 'rejected' }))
      }),
      reconcile: raw => this.run(() => this.exclusive(async () => {
        const input = governanceRecoveryInputSchema.parse(raw), owner = this.owner(this.recoveryScope(input))
        return this.reconcile(owner, this.reference(owner, input.commandId))
      })),
      retry: raw => this.run(() => this.exclusive(async () => {
        const input = governanceRecoveryInputSchema.parse(raw), owner = this.owner(this.recoveryScope(input)), ref = this.reference(owner, input.commandId)
        const receipt = await this.reconcile(owner, ref)
        if (receipt) return { status: 'duplicate', commandId: ref.commandId, result: receipt }
        const retained = this.retained.get(ref.commandId)
        if (!retained || retained.generation !== owner.generation) throw new ApiError('PAYLOAD_UNAVAILABLE', '原正文不在当前登录会话中，只能核对原回执。', 0, ref.state !== 'rejected')
        return this.send(owner, ref, retained.command)
      }))
    }
  }
  dispose(): void { this.invalidate(); this.unsubscribe(); authEvents.removeEventListener('denied', this.invalidate); authEvents.removeEventListener('session-changed', this.invalidate) }
  private readonly invalidate = (): void => { this.live = false; this.generation++; this.retained.clear(); this.lifetime.abort() }
  private signature(ctx: CruxWorkspaceContext): string { return JSON.stringify([ctx.key, ctx.actorId, ctx.projectId, ctx.instanceId, ctx.epoch, ctx.state]) }
  private owner(scope: GovernanceRecoveryScope): Owner {
    const ctx = this.options.context()
    if (!this.live || !this.options.isCurrent() || !isClientSession(this.options.session) || ctx.state !== 'connected' || ctx.key !== scope.workspaceKey || ctx.projectId !== this.options.projectId || ctx.actorId !== this.options.session.person.userId || !ctx.instanceId || !ctx.epoch) throw new ApiError('OWNER_CHANGED', '原工作区或登录身份不可用，请恢复后核对。')
    return { scope: governanceRecoveryScopeSchema.parse(scope), instanceId: ctx.instanceId, epoch: ctx.epoch, accountId: ctx.actorId, generation: this.generation }
  }
  private current(owner: Owner): void {
    const now = this.owner(owner.scope)
    if (owner.generation !== now.generation || owner.instanceId !== now.instanceId || owner.epoch !== now.epoch || owner.accountId !== now.accountId) throw new ApiError('OWNER_CHANGED', '请求期间原工作区发生变化。')
  }
  private invalid(write = false): never { throw new ApiError('INVALID_RESPONSE', '规则或输入回执与原对象不一致，请核对。', 0, write) }
  private identity(owner: Owner, value: { instanceId: string; epoch: string }, write = false): void { this.current(owner); if (value.instanceId !== owner.instanceId || value.epoch !== owner.epoch) this.invalid(write) }
  private taskIdentity(owner: Owner, value: { projectId: string; taskId: string; spaceId: string; taskCreatedAt: string }): void {
    if (owner.scope.lane !== 'inputs' || value.projectId !== this.options.projectId || value.taskId !== owner.scope.taskId || value.spaceId !== owner.scope.spaceId || value.taskCreatedAt !== owner.scope.taskCreatedAt) this.invalid()
  }
  private base(scope: GovernanceRecoveryScope): string { return `/api/projects/${this.options.projectId}/crux/` + (scope.lane === 'inputs' ? `tasks/${encodeURIComponent(scope.taskId)}/inputs` : `spaces/${encodeURIComponent(scope.spaceId)}/governance`) }
  private query(scope: GovernanceRecoveryScope): string { return scope.lane === 'inputs' ? new URLSearchParams({ spaceId: scope.spaceId, taskCreatedAt: scope.taskCreatedAt }).toString() : '' }
  private async get<T>(owner: Owner, path: string, schema: z.ZodType<T>): Promise<T> { this.current(owner); const value = await request(path, schema, { signal: this.lifetime.signal, notifyDenied: false, isCurrent: () => { try { this.current(owner); return true } catch { return false } } }); this.current(owner); return value }
  private recoveryScope(input: z.infer<typeof governanceRecoveryInputSchema>): GovernanceRecoveryScope { return input.lane === 'inputs' ? { workspaceKey: input.workspaceKey, spaceId: input.spaceId, taskId: input.taskId, taskCreatedAt: input.taskCreatedAt, lane: input.lane } : { workspaceKey: input.workspaceKey, spaceId: input.spaceId, lane: input.lane } }
  private references(): Reference[] {
    try { return z.array(referenceSchema).max(256).parse(JSON.parse(sessionStorage.getItem(STORAGE) ?? '[]')) }
    catch { throw new ApiError('JOURNAL_UNAVAILABLE', '浏览器原操作引用无法读取，原数据已保留。') }
  }
  private save(ref: Reference): void {
    const all = this.references(), index = all.findIndex(item => item.commandId === ref.commandId)
    if (index >= 0) all[index] = referenceSchema.parse(ref)
    else { if (all.length >= 256) throw new ApiError('CAPACITY_EXCEEDED', '浏览器原操作记录已达上限，请先核对。'); all.push(referenceSchema.parse(ref)) }
    try { sessionStorage.setItem(STORAGE, JSON.stringify(all)) } catch { throw new ApiError('JOURNAL_UNAVAILABLE', '浏览器无法保留原操作引用，当前不能发送。') }
  }
  private reference(owner: Owner, commandId: string): Reference {
    const ref = this.references().find(item => item.commandId === commandId)
    if (!ref || ref.origin !== location.origin || ref.projectId !== this.options.projectId || ref.accountId !== owner.accountId || ref.instanceId !== owner.instanceId || ref.epoch !== owner.epoch || scopeKey(ref.scope) !== scopeKey(owner.scope)) throw new ApiError('OWNER_CHANGED', '原操作不属于当前账号、服务世代和任务。')
    return ref
  }
  private receipt(owner: Owner, ref: Reference, raw: unknown): GovernanceReceipt | TaskInputReceipt {
    const value = owner.scope.lane === 'inputs' ? taskInputReceiptSchema.parse(raw) : governanceReceiptSchema.parse(raw)
    this.identity(owner, value, true)
    if (value.projectId !== this.options.projectId || value.spaceId !== owner.scope.spaceId || value.commandId !== ref.commandId || value.action !== ref.action || value.actorId !== owner.accountId || value.deviceId !== null) this.invalid(true)
    if ('taskId' in value) this.taskIdentity(owner, value)
    const retained = this.retained.get(ref.commandId)?.command
    if (retained && ('expectedRevision' in retained && value.revision !== retained.expectedRevision + 1 || retained.action === 'create' && value.revision !== 1 || 'packageId' in retained && 'packageId' in value && value.packageId !== retained.packageId || 'versionId' in retained && 'versionId' in value && value.versionId !== retained.versionId)) this.invalid(true)
    return value
  }
  private async reconcile(owner: Owner, ref: Reference): Promise<GovernanceReceipt | TaskInputReceipt | null> {
    try {
    this.reference(owner, ref.commandId)
    const schema = owner.scope.lane === 'inputs' ? taskInputReceiptSchema.nullable() : governanceReceiptSchema.nullable()
    const raw = await this.get<GovernanceReceipt | TaskInputReceipt | null>(owner, `${this.base(owner.scope)}/commands/${ref.commandId}?${this.query(owner.scope)}`, schema)
    if (!raw) return null
    const receipt = this.receipt(owner, ref, raw)
    this.save({ ...ref, state: 'committed', error: null }); this.retained.delete(ref.commandId)
    return receipt
    } catch (error) {
      if (ref.state !== 'rejected' && !(error instanceof ApiError && error.uncertain)) throw new ApiError(error instanceof ApiError ? error.code : 'GOVERNANCE_UNAVAILABLE', '原操作结果尚未核对，请保留原编号。', error instanceof ApiError ? error.status : 0, true)
      throw error
    }
  }
  private async submit(owner: Owner, raw: GovernanceCommand | TaskInputCommand): Promise<{ status: 'committed' | 'duplicate'; commandId: string; result: GovernanceReceipt | TaskInputReceipt }> {
    requireBrowserCrypto(); this.current(owner)
    const command = owner.scope.lane === 'inputs' ? taskInputCommandSchema.parse(raw) : governanceCommandSchema.parse(raw)
    if (command.expectedEpoch !== owner.epoch || command.spaceId !== owner.scope.spaceId || 'taskCreatedAt' in command && owner.scope.lane === 'inputs' && command.taskCreatedAt !== owner.scope.taskCreatedAt) throw new ApiError('SCOPE_MISMATCH', '命令与原服务或任务身份不一致。')
    if ('text' in command && new TextEncoder().encode(command.text).byteLength > 1024 * 1024) throw new ApiError('CAPACITY_EXCEEDED', '规则正文超过一 MiB。')
    const hash = await digest(JSON.stringify(command)); this.current(owner)
    const previous = this.references().find(ref => ref.commandId === command.commandId)
    if (previous) {
      const ref = this.reference(owner, command.commandId)
      if (ref.digest !== hash) throw new ApiError('COMMAND_CONFLICT', '原操作编号不能替换参数或正文。')
      const receipt = await this.reconcile(owner, ref)
      if (receipt) return { status: 'duplicate', commandId: ref.commandId, result: receipt }
      throw new ApiError('RECONCILE_REQUIRED', '请明确重试保留的原操作。', 0, ref.state !== 'rejected')
    }
    const ref: Reference = { scope: owner.scope, origin: location.origin, projectId: this.options.projectId, accountId: owner.accountId, instanceId: owner.instanceId, epoch: owner.epoch, commandId: command.commandId, digest: hash, action: command.action, state: 'pending', createdAt: Date.now(), error: null }
    this.save(ref); this.retained.set(ref.commandId, { command: structuredClone(command), generation: owner.generation })
    // Recheck even settled/evicted command UUIDs before any new POST.
    const historical = await this.reconcile(owner, ref)
    if (historical) throw new ApiError('COMMAND_ALREADY_COMMITTED', '原编号已有回执，请核对原操作。')
    return this.send(owner, ref, command)
  }
  private async send(owner: Owner, ref: Reference, command: GovernanceCommand | TaskInputCommand): Promise<{ status: 'committed' | 'duplicate'; commandId: string; result: GovernanceReceipt | TaskInputReceipt }> {
    this.current(owner)
    if (await digest(JSON.stringify(command)) !== ref.digest) throw new ApiError('COMMAND_CONFLICT', '原操作正文摘要不一致。')
    this.current(owner)
    try {
      this.save({ ...ref, state: 'unknown', error: null })
      const schema = owner.scope.lane === 'inputs' ? taskInputCommandReplySchema : governanceCommandReplySchema
      const value = await request<{ status: 'committed' | 'duplicate'; commandId: string; result: GovernanceReceipt | TaskInputReceipt }>(this.base(owner.scope) + '/commands', schema, { body: command, csrfToken: this.options.session.csrfToken ?? undefined, signal: this.lifetime.signal, notifyDenied: false, isCurrent: () => { try { this.current(owner); return true } catch { return false } } })
      if (value.commandId !== ref.commandId) this.invalid(true)
      const receipt = this.receipt(owner, ref, value.result)
      this.save({ ...ref, state: 'committed', error: null }); this.retained.delete(ref.commandId)
      return { ...value, result: receipt }
    } catch (cause) {
      const error = cause instanceof ApiError ? cause : new ApiError('INVALID_RESPONSE', '原操作结果无法核对。', 0, true)
      const unknown = error.uncertain || ref.state === 'unknown' || ref.state === 'pending' && error.code === 'OWNER_CHANGED'
      try { this.save({ ...ref, state: unknown ? 'unknown' : 'rejected', error: error.message.slice(0, 2000) }) }
      catch { throw new ApiError('JOURNAL_UNAVAILABLE', '原操作可能已提交，浏览器保存回执失败，请核对原编号。', 0, true) }
      if (unknown && !error.uncertain) throw new ApiError(error.code, error.message, error.status, true)
      throw error
    }
  }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> { if (this.writing) throw new ApiError('IN_FLIGHT', '原操作正在准备或核对。'); this.writing = true; try { return await action() } finally { this.writing = false } }
  private async run<T>(action: () => Promise<T>): Promise<GovernanceReply<T>> {
    try { return { ok: true, value: await action() } }
    catch (cause) { const error = cause instanceof ApiError ? cause : new ApiError(cause instanceof z.ZodError ? 'INVALID_INPUT' : 'GOVERNANCE_UNAVAILABLE', '规则或任务输入暂不可用，请核对原操作。'); if (error.status === 401 || error.status === 403) this.invalidate(); return { ok: false, code: error.code, error: error.message, ...(error.uncertain ? { outcomeUnknown: true } : {}) } }
  }
}

import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { CreationApi, CreationGenerationPlan } from '../../../shared/creation-api'
import { creationClientListSchema, creationClientGetSchema, creationClientCommandSchema, creationGenerateSchema, creationCancelSchema, creationRecoverSchema } from '../../../shared/creation-api'
import { creationCommandSchema, creationCommandResultSchema, creationListSchema, type CreationActorContext, type CreationCommand, type CreationCommandReply, type CreationComment, type CreationView } from '../../../shared/creations'
import { authorizeCreationCommand, canReadCreation, executeCreationCommand, summarizeCreation, viewCreation, CreationError } from '../../../shared/creations-domain'
import { applyCreationPatch, buildCreationAiContext, CREATION_AI_INPUT_BYTES } from '../../../shared/creation-ai'
import type { HifoxSnapshot } from '../../../shared/hifox'
import type { HifoxWorkspaceContext } from '../../../shared/hifox-remote'
import type { AiConfig, AiChatResult, ChatMessage } from '../../../shared/types'
import { CreationLocalStore, sameCreationCommand, type PendingCreation } from './store'
import type { DesktopTeamService } from '../team-platform/service'

type Workspace = { snapshot: HifoxSnapshot; context: HifoxWorkspaceContext }
type Remote = Pick<DesktopTeamService, 'creationHead' | 'creationsList' | 'creationGet' | 'creationCommand' | 'creationReceipt'>
type Source = Workspace & { actor: CreationActorContext; proof: string }
type GenerateInput = z.output<typeof creationGenerateSchema>
type Generation = { source: Source; commandId: string; controller: AbortController; cancelled: boolean; saving: boolean }
export type CreationServiceDependencies = {
  dataDir: string
  workspace(): Promise<Workspace>
  status(): Promise<HifoxWorkspaceContext>
  remote<T>(action: (service: Remote) => Promise<T>): Promise<T>
  model(): AiConfig
  chat(config: AiConfig, messages: ChatMessage[], options: { maxTokens: number; signal: AbortSignal }): Promise<AiChatResult>
  changed(workspaceKey: string, creationId: string | null): void
}
const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
const sourceProof = (context: HifoxWorkspaceContext): string => JSON.stringify([context.key, context.connectionId, context.actorId, context.projectId, context.origin, context.instanceId, context.epoch, context.authorizationRevision])
function fail(code: string, message: string, status = 409): never { throw new CreationError(code, message, status) }

/** Native/local transport only; domain and server remain the authority for shared work. */
export class CreationMainService {
  private readonly store: CreationLocalStore
  private readonly tails = new Map<string, Promise<unknown>>()
  private readonly generations = new Map<string, Generation>()
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private polling = false
  private pollDelay = 8000
  private head: { proof: string; fingerprint: string } | null = null
  private closed = false
  constructor(private readonly deps: CreationServiceDependencies) { this.store = new CreationLocalStore(deps.dataDir) }

  private async source(key: string): Promise<Source> {
    if (this.closed) fail('SERVICE_CLOSED', '创作服务正在退出')
    this.schedulePoll()
    const before = await this.deps.status()
    const workspace = await this.deps.workspace(), context = workspace.context
    if (before.key !== key || context.key !== key || !context.actorId || !['local', 'connected'].includes(before.state) || !['local', 'connected'].includes(context.state) || sourceProof(before) !== sourceProof(context) || (context.connectionId && !context.projectId)) fail('SOURCE_CHANGED', '请重新核对当前创作来源和团队连接')
    const actorId = context.actorId
    const actor: CreationActorContext = {
      projectId: context.projectId ?? 'local', actorId, now: Date.now(), epoch: context.epoch,
      activeMemberIds: workspace.snapshot.members.map((member) => member.id),
      spaces: workspace.snapshot.spaces.map((space) => ({ id: space.id, archived: Boolean(space.archived), canRead: space.visibility !== 'private' || space.memberIds.includes(actorId), canWrite: space.memberIds.includes(actorId), memberIds: space.memberIds })),
      tasks: workspace.snapshot.tasks.map((task) => ({ id: task.id, spaceId: task.spaceId })), digestBody: hash
    }
    const source = { ...workspace, actor, proof: sourceProof(context) }
    await this.current(source)
    return source
  }
  private async current(source: Source): Promise<void> {
    if (this.closed) fail('SERVICE_CLOSED', '创作服务正在退出，原保存结果需核对')
    const context = await this.deps.status()
    if (this.closed) fail('SERVICE_CLOSED', '创作服务正在退出，原保存结果需核对')
    if (sourceProof(context) !== source.proof || !['local', 'connected'].includes(context.state)) fail('SOURCE_CHANGED', '来源已变化，原创作操作需要在原账号和团队中核对')
  }
  private schedulePoll(): void {
    if (this.closed || this.pollTimer || this.polling) return
    this.pollTimer = setTimeout(() => { this.pollTimer = null; void this.pollHead() }, this.pollDelay)
    this.pollTimer.unref()
  }
  private async pollHead(): Promise<void> {
    if (this.closed) return
    this.polling = true
    try {
      const before = await this.deps.status()
      if (this.closed) return
      if (before.state !== 'connected' || !before.connectionId || !before.actorId || !before.projectId || !before.epoch) {
        this.head = null; this.pollDelay = 8000
        return
      }
      const proof = sourceProof(before)
      const head = await this.deps.remote((service) => service.creationHead(before.connectionId ?? ''))
      const after = await this.deps.status()
      if (this.closed) return
      if (after.state !== 'connected' || sourceProof(after) !== proof || head.projectId !== before.projectId || head.epoch !== before.epoch) {
        this.head = null; this.pollDelay = 8000
        return
      }
      const previous = this.head
      this.head = { proof, fingerprint: head.fingerprint }
      this.pollDelay = 8000
      // The first observation invalidates once: the initial list may predate this head.
      // Own writes never reset this baseline and cannot mask a later remote revision.
      if (!previous || previous.proof !== proof || previous.fingerprint !== head.fingerprint) this.deps.changed(before.key, null)
    } catch {
      this.pollDelay = Math.min(this.pollDelay * 2, 32000)
    } finally {
      this.polling = false
      this.schedulePoll()
    }
  }
  private serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(work)
    this.tails.set(key, next)
    void next.finally(() => { if (this.tails.get(key) === next) this.tails.delete(key) }).catch(() => {})
    return next
  }
  private assertPendingSource(pending: PendingCreation, source: Source): void {
    if (pending.connectionId !== source.context.connectionId || pending.projectId !== source.context.projectId || pending.epoch !== source.context.epoch || pending.instanceId !== source.context.instanceId || pending.origin !== source.context.origin) fail('SOURCE_CHANGED', '原保存属于另一账号、团队或服务世代，请保留记录并核对')
  }
  private assertPendingReply(pending: PendingCreation, reply: CreationCommandReply): void {
    if (reply.commandId !== pending.command.commandId || reply.result.creationId !== pending.command.creationId || reply.result.action !== pending.command.action || reply.result.projectId !== pending.projectId || (pending.command.expectedEpoch !== undefined && reply.result.epoch !== pending.command.expectedEpoch)) throw pendingFailure(new CreationError('RECEIPT_MISMATCH', '保存回执不属于原作品、操作或服务世代，请保留原记录并核对'))
  }
  async list(raw: z.input<typeof creationClientListSchema>): Promise<z.output<typeof creationListSchema>> {
    const input = creationClientListSchema.parse(raw), source = await this.source(input.workspaceKey)
    const { workspaceKey: _key, ...query } = input
    if (source.context.connectionId) {
      const result = await this.deps.remote((service) => service.creationsList(source.context.connectionId ?? '', query))
      await this.current(source)
      return result
    }
    if (query.spaceId && !source.actor.spaces.some((space) => space.id === query.spaceId && space.canRead)) fail('CREATION_FORBIDDEN', '无权读取所选空间', 403)
    let records = (await this.store.list()).filter((record) => canReadCreation(record, source.actor))
    records = records.filter((record) => query.scope === 'personal' ? record.home === 'personal' && record.ownerId === source.actor.actorId : record.spaceId !== null)
    records = records.filter((record) => (!query.spaceId || record.spaceId === query.spaceId) && (!query.taskId || record.adoptions.some((adoption) => adoption.taskId === query.taskId)))
    records.sort((left, right) => left.creationId.localeCompare(right.creationId))
    if (query.cursor) records = records.filter((record) => record.creationId > (query.cursor ?? ''))
    const selected = records.slice(0, query.limit)
    const result = creationListSchema.parse({ items: selected.map((record) => summarizeCreation(record, source.actor, { taskId: query.taskId })), hasMore: records.length > query.limit, nextCursor: records.length > query.limit ? selected.at(-1)?.creationId ?? null : null })
    await this.current(source)
    return result
  }
  async get(raw: z.input<typeof creationClientGetSchema>): Promise<CreationView> {
    const input = creationClientGetSchema.parse(raw), source = await this.source(input.workspaceKey)
    const { workspaceKey: _key, creationId, ...query } = input
    let result: CreationView
    if (source.context.connectionId) result = await this.deps.remote((service) => service.creationGet(source.context.connectionId ?? '', creationId, query))
    else {
      const record = await this.store.get(creationId)
      if (!record) fail('NOT_FOUND', '作品不存在', 404)
      result = viewCreation(record, source.actor, query)
    }
    await this.current(source)
    return result
  }
  async command(raw: z.input<typeof creationClientCommandSchema>): Promise<CreationCommandReply> {
    const input = creationClientCommandSchema.parse(raw), original = await this.source(input.workspaceKey)
    return this.serial(`${input.workspaceKey}:${input.command.creationId}`, async () => {
      const source = await this.source(input.workspaceKey)
      if (source.proof !== original.proof) fail('SOURCE_CHANGED', '排队期间创作来源已变化，请核对原操作')
      const generation = this.generations.get(input.command.commandId)
      if (generation && (generation.cancelled || generation.source.proof !== source.proof)) fail('SOURCE_CHANGED', '生成期间创作来源已变化，候选未写入')
      const command = creationCommandSchema.parse({ ...input.command, ...(source.context.epoch ? { expectedEpoch: input.command.expectedEpoch ?? source.context.epoch } : {}) })
      let reply: CreationCommandReply
      if (source.context.connectionId) {
        const existing = await this.store.pending(source.context.key, source.actor.actorId, command.creationId)
        if (existing) this.assertPendingSource(existing, source)
        if (existing && !sameCreationCommand(existing.command, command)) fail('PENDING_OPERATION', '有原保存结果待核对，请先点击“核对原操作”')
        const pending: PendingCreation = existing ?? { workspaceKey: source.context.key, connectionId: source.context.connectionId, actorId: source.actor.actorId, projectId: source.actor.projectId, epoch: source.context.epoch, instanceId: source.context.instanceId, origin: source.context.origin, command, recordedAt: Date.now() }
        await this.store.reserve(pending)
        try {
          await this.current(source)
          reply = await this.deps.remote((service) => service.creationCommand(pending.connectionId, pending.command))
          this.assertPendingReply(pending, reply)
          await this.current(source)
          await this.store.settle(pending)
          await this.current(source)
        } catch (error) {
          // An old unknown write stays unknown even when a later retry is rejected.
          const code = errorCode(error)
          const definite = (error instanceof CreationError && !['SOURCE_CHANGED', 'SERVICE_CLOSED'].includes(code)) || ['REVISION_CONFLICT', 'CREATION_FORBIDDEN', 'INVALID_INPUT', 'EPOCH_CONFLICT', 'SPACE_ARCHIVED'].includes(code)
          if (!existing && definite && !hasUnknownOutcome(error)) { await this.store.settle(pending); throw error }
          throw pendingFailure(error)
        }
      } else {
        const before = await this.store.get(command.creationId)
        authorizeCreationCommand(before, command, source.actor)
        const previous = await this.store.receipt(command)
        if (previous) { await this.current(source); return previous }
        const after = executeCreationCommand(before, command, source.actor)
        const result = creationCommandResultSchema.parse({
          projectId: after.projectId, creationId: after.creationId, revision: after.revision, action: command.action,
          scopeSpaceIds: [...new Set([before?.spaceId, after.spaceId].filter((id): id is string => Boolean(id)))],
          scopeTaskIds: command.action === 'adoptForTask' ? [command.taskId] : [],
          private: ['create', 'saveDraft', 'candidateSave', 'candidateAdopt', 'candidateDiscard'].includes(command.action),
          ...(command.action === 'publish' ? { revisionId: after.revisions.at(-1)?.revisionId } : {}),
          ...(command.action === 'annotate' ? { commentId: after.comments.at(-1)?.commentId } : {}),
          ...(command.action === 'candidateSave' ? { candidateId: after.candidate?.candidateId } : {}),
          ...(command.action === 'adoptForTask' ? { adoptionId: after.adoptions.at(-1)?.adoptionId } : {})
        })
        reply = { status: 'committed', commandId: command.commandId, result }
        await this.current(source)
        await this.store.save(after, command, reply)
        await this.current(source)
      }
      this.deps.changed(source.context.key, command.creationId)
      return reply
    })
  }
  async recover(raw: z.input<typeof creationRecoverSchema>): Promise<CreationCommandReply | null> {
    const input = creationRecoverSchema.parse(raw)
    return this.serial(`${input.workspaceKey}:${input.creationId}`, async () => {
      const source = await this.source(input.workspaceKey)
      const pending = await this.store.pending(input.workspaceKey, source.actor.actorId, input.creationId)
      await this.current(source)
      if (!pending) return null
      this.assertPendingSource(pending, source)
      let reply = await this.deps.remote((service) => service.creationReceipt(pending.connectionId, pending.command.commandId))
      await this.current(source)
      // Explicit recovery retries exactly the same operation; an absent receipt never generates a new identity.
      if (!reply) reply = await this.deps.remote((service) => service.creationCommand(pending.connectionId, pending.command))
      await this.current(source)
      this.assertPendingReply(pending, reply)
      await this.store.settle(pending)
      await this.current(source)
      this.deps.changed(source.context.key, input.creationId)
      return reply
    })
  }
  private async candidateInput(raw: GenerateInput): Promise<{ source: Source; view: CreationView; context: ReturnType<typeof buildCreationAiContext> }> {
    const source = await this.source(raw.workspaceKey)
    const initial = await this.get({ workspaceKey: raw.workspaceKey, creationId: raw.creationId })
    if (initial.summary.revision !== raw.expectedRevision || !initial.draft) fail('REVISION_CONFLICT', '作品已变化，请先核对当前草稿')
    const view = initial.selected.revisionId === initial.draft.revisionId ? initial : await this.get({ workspaceKey: raw.workspaceKey, creationId: raw.creationId, revisionId: initial.draft.revisionId })
    const found = new Map<string, CreationComment>()
    const revisionIds = [...new Set([view.draft?.revisionId, ...[...view.revisions].reverse().map((revision) => revision.revisionId)].filter((id): id is string => Boolean(id)))]
    for (const revisionId of revisionIds) {
      let commentOffset: number | undefined = 0
      do {
        const selected = await this.get({ workspaceKey: raw.workspaceKey, creationId: raw.creationId, revisionId, commentOffset })
        if (selected.summary.revision !== raw.expectedRevision) fail('REVISION_CONFLICT', '评审意见已变化，请重新选择')
        for (const comment of selected.comments) if (raw.commentIds.includes(comment.commentId)) found.set(comment.commentId, comment)
        commentOffset = selected.nextCommentOffset ?? undefined
      } while (commentOffset !== undefined && found.size < raw.commentIds.length)
      if (found.size === raw.commentIds.length) break
    }
    if (found.size !== new Set(raw.commentIds).size) fail('COMMENT_NOT_FOUND', '所选意见已失效或无权读取')
    await this.current(source)
    return { source, view, context: buildCreationAiContext(view, raw.commentIds.map((id) => found.get(id)).filter((item): item is CreationComment => Boolean(item)), raw.instruction) }
  }
  async planCandidate(raw: z.input<typeof creationGenerateSchema>): Promise<CreationGenerationPlan> {
    const input = creationGenerateSchema.parse(raw), { context } = await this.candidateInput(input)
    const model = this.deps.model()
    return { inputBytes: context.inputBytes, estimatedTokens: context.estimatedTokens, fragmentCount: context.fragments.length, selectedCount: context.selectedCount, maxInputBytes: CREATION_AI_INPUT_BYTES, model: model.model || null, available: Boolean(model.enabled && model.model && model.baseUrl) }
  }
  async generateCandidate(raw: z.input<typeof creationGenerateSchema>): Promise<CreationCommandReply> {
    const input = creationGenerateSchema.parse(raw)
    if (this.generations.has(input.commandId)) fail('IN_FLIGHT', '该候选正在生成')
    const { source, view, context } = await this.candidateInput(input)
    if ([...this.generations.values()].some((job) => job.source.proof === source.proof)) fail('IN_FLIGHT', '当前来源已有候选正在生成，请等待或取消')
    const generation: Generation = { source, commandId: input.commandId, controller: new AbortController(), cancelled: false, saving: false }
    this.generations.set(input.commandId, generation)
    try {
      const response = await this.deps.chat(this.deps.model(), [{ role: 'system', content: context.system }, { role: 'user', content: context.prompt }], { maxTokens: 3000, signal: generation.controller.signal })
      if (generation.cancelled) fail('CANCELLED', '已取消候选，原稿保持不变')
      await this.current(source)
      if (!response.ok) fail('MODEL_UNAVAILABLE', response.error ?? '模型没有返回可用内容', 503)
      const body = applyCreationPatch(view.selected.body, context.fragments, response.content ?? '')
      const latest = await this.get({ workspaceKey: input.workspaceKey, creationId: input.creationId })
      if (latest.summary.revision !== input.expectedRevision || latest.draft?.serial !== view.draft?.serial) fail('REVISION_CONFLICT', '生成期间草稿已变化，候选未写入')
      if (generation.cancelled) fail('CANCELLED', '已取消候选，原稿保持不变')
      generation.saving = true
      return await this.command({ workspaceKey: input.workspaceKey, command: { action: 'candidateSave', commandId: input.commandId, creationId: input.creationId, expectedRevision: input.expectedRevision, body, baseDraftRevision: view.draft?.serial ?? 0, selectedCommentIds: input.commentIds } })
    } finally { this.generations.delete(input.commandId) }
  }
  async cancelCandidate(raw: z.input<typeof creationCancelSchema>): Promise<{ cancelled: boolean }> {
    const input = creationCancelSchema.parse(raw), source = await this.source(input.workspaceKey), generation = this.generations.get(input.commandId)
    if (!generation || generation.saving || generation.source.proof !== source.proof) return { cancelled: false }
    generation.cancelled = true; generation.controller.abort()
    return { cancelled: true }
  }
  close(): void {
    this.closed = true
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
    for (const job of this.generations.values()) { job.cancelled = true; job.controller.abort() }
  }
}

export function errorCode(error: unknown): string { return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'CREATION_ERROR' }
function hasUnknownOutcome(error: unknown): boolean { return typeof error === 'object' && error !== null && 'outcomeUnknown' in error && error.outcomeUnknown === true }
function pendingFailure(error: unknown): Error { return Object.assign(error instanceof Error ? error : new Error('原保存结果尚未核实，请保留原操作记录'), { outcomeUnknown: true }) }
export function creationFailure(error: unknown): Awaited<ReturnType<CreationApi['get']>> & { ok: false } {
  const code = errorCode(error)
  const uncertain = hasUnknownOutcome(error)
  return { ok: false, code, error: error instanceof z.ZodError ? error.issues[0]?.message ?? '创作参数无效' : error instanceof Error ? error.message : '创作操作未完成', ...(uncertain || code === 'PENDING_OPERATION' ? { outcomeUnknown: true } : {}) }
}

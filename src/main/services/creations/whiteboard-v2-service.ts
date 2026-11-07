import { createHash } from 'node:crypto'
import { z } from 'zod'
import { CreationError } from '../../../shared/creations-domain'
import type { CreationCommandReply } from '../../../shared/creations'
import { WHITEBOARD_V2_CAPABILITIES, whiteboardV2CommandSchema, whiteboardV2ListInputSchema, whiteboardV2ViewInputSchema, type WhiteboardV2Capabilities, type WhiteboardV2Command, type WhiteboardV2List, type WhiteboardV2View } from '../../../shared/creation-whiteboard-v2'
import { whiteboardV2CapabilityInputSchema } from '../../../shared/whiteboard-v2-api'
import type { CruxSnapshot } from '../../../shared/crux'
import type { CruxWorkspaceContext } from '../../../shared/crux-remote'
import { WhiteboardV2WorkerClient } from './whiteboard-v2-worker-client'
import type { PendingWhiteboardV2 } from './whiteboard-v2-store'
import type { WhiteboardWorkerActor, WhiteboardWorkerSource, WhiteboardWorkerWrite } from './whiteboard-v2-worker-protocol'

const key = z.string().min(1).max(8192)
const commandInputSchema = z.object({ workspaceKey: key, command: whiteboardV2CommandSchema }).strict().superRefine((value, context) => {
  if (value.command.expectedEpoch !== undefined || (value.command.action === 'create' && value.command.privateSource !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Source and epoch must be derived by the trusted adapter' })
  }
})
const listInputSchema = whiteboardV2ListInputSchema.extend({ workspaceKey: key }).strict()
const getInputSchema = whiteboardV2ViewInputSchema.extend({ workspaceKey: key, creationId: z.string().uuid() }).strict()
const recoverIdsSchema = z.object({ workspaceKey: key, creationId: z.string().uuid(), commandId: z.string().uuid() }).strict()
const recoverInputSchema = z.union([commandInputSchema, recoverIdsSchema])
type Workspace = { context: CruxWorkspaceContext; snapshot: CruxSnapshot }
type Source = { proof: string; actor: WhiteboardWorkerActor; binding: WhiteboardWorkerSource }
export type WhiteboardV2ServiceDependencies = {
  status(): Promise<CruxWorkspaceContext>
  workspace(): Promise<Workspace>
  generation(): number
  store: WhiteboardV2WorkerClient
  now?(): number
}
function fail(code: string, message: string, status = 409): never { throw new CreationError(code, message, status) }
function contextProof(context: CruxWorkspaceContext): string {
  return JSON.stringify([context.key, context.connectionId, context.actorId, context.projectId, context.origin, context.instanceId, context.epoch, context.authorizationRevision, context.state])
}
function uncertain(error: unknown): Error {
  return Object.assign(error instanceof Error ? error : new Error('Original whiteboard operation needs reconciliation'), { outcomeUnknown: true })
}

/** Authority and source are derived and rechecked in the main process. */
export class WhiteboardV2Service {
  private readonly operations = new Set<Promise<unknown>>()
  private readonly tails = new Map<string, Promise<unknown>>()
  private closed = false
  private closing: Promise<void> | null = null
  constructor(private readonly deps: WhiteboardV2ServiceDependencies) {}

  private async source(workspaceKey: string): Promise<Source> {
    if (this.closed) fail('SERVICE_CLOSED', 'Whiteboard service is closing')
    const generation = this.deps.generation()
    const before = await this.deps.status(), workspace = await this.deps.workspace(), after = await this.deps.status(), context = workspace.context
    if (this.closed) fail('SERVICE_CLOSED', 'Whiteboard service is closing')
    if (context.key !== workspaceKey || before.key !== workspaceKey || after.key !== workspaceKey || context.state !== 'local' || before.state !== 'local' || after.state !== 'local' ||
      context.connectionId !== null || (context.projectId !== null && context.projectId !== 'local') || !context.actorId ||
      contextProof(before) !== contextProof(context) || contextProof(after) !== contextProof(context) || !Number.isSafeInteger(generation) || generation !== this.deps.generation()) fail('SOURCE_CHANGED', 'Recheck the original local whiteboard source')
    const actorId = context.actorId
    const actor: WhiteboardWorkerActor = {
      projectId: 'local', actorId, now: (this.deps.now ?? Date.now)(), ...(context.epoch ? { epoch: context.epoch } : {}),
      activeMemberIds: workspace.snapshot.members.map((member) => member.id),
      spaces: workspace.snapshot.spaces.map((space) => ({ id: space.id, archived: Boolean(space.archived), canRead: space.visibility !== 'private' || space.memberIds.includes(actorId), canWrite: space.memberIds.includes(actorId), memberIds: space.memberIds })),
      tasks: workspace.snapshot.tasks.map((task) => ({ id: task.id, spaceId: task.spaceId }))
    }
    if (!actor.activeMemberIds.includes(actorId)) fail('CREATION_FORBIDDEN', 'Current person is no longer an active member', 403)
    const sourceIdentity = createHash('sha256').update(JSON.stringify([context.key, context.connectionId, context.projectId, actorId, context.origin, context.instanceId, context.epoch])).digest('hex')
    const binding: WhiteboardWorkerSource = { workspaceKey, actorId, projectId: 'local', ...(context.epoch ? { epoch: context.epoch } : {}), sourceIdentity }
    return { actor, binding, proof: JSON.stringify([contextProof(context), generation, actor.activeMemberIds, actor.spaces, actor.tasks]) }
  }
  private async current(original: Source): Promise<Source> {
    const current = await this.source(original.binding.workspaceKey)
    if (current.proof !== original.proof) fail('SOURCE_CHANGED', 'Original whiteboard source or authorization changed')
    return current
  }
  private track<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new CreationError('SERVICE_CLOSED', 'Whiteboard service is closing'))
    const result = Promise.resolve().then(work)
    this.operations.add(result)
    void result.finally(() => this.operations.delete(result)).catch(() => {})
    return result
  }
  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const key = id.toLowerCase(), previous = this.tails.get(key) ?? Promise.resolve()
    const result = previous.catch(() => {}).then(work)
    this.tails.set(key, result)
    void result.finally(() => { if (this.tails.get(key) === result) this.tails.delete(key) }).catch(() => {})
    return result
  }
  private bind(command: WhiteboardV2Command, source: Source): WhiteboardV2Command {
    return whiteboardV2CommandSchema.parse({ ...command, ...(source.binding.epoch ? { expectedEpoch: source.binding.epoch } : {}) })
  }
  private assertPending(pending: PendingWhiteboardV2, command: WhiteboardV2Command, source: Source): void {
    if (JSON.stringify(pending.source) !== JSON.stringify(source.binding)) fail('SOURCE_CHANGED', 'Original whiteboard operation belongs to another source')
    if (JSON.stringify(pending.command) !== JSON.stringify(command)) fail('PENDING_OPERATION', 'Reconcile the original whiteboard command and payload')
  }
  private async finish(pending: PendingWhiteboardV2, source: Source): Promise<CreationCommandReply> {
    try {
      this.assertActionCapability(pending.command.action)
      let current = await this.current(source)
      const reply = await this.deps.store.command(pending.command, current.actor, current.binding)
      current = await this.current(source)
      await this.deps.store.settle(pending, current.actor)
      await this.current(source)
      return reply
    } catch (error) { throw uncertain(error) }
  }
  private assertCapability(capability: 'read' | 'create' | 'save' | 'publish' | 'review' | 'recover'): void {
    if (!WHITEBOARD_V2_CAPABILITIES[capability]) fail('WHITEBOARD_V2_UNAVAILABLE', 'Whiteboard operation is unavailable', 403)
  }
  private assertActionCapability(action: string): void {
    switch (action) {
      case 'create': this.assertCapability('create'); return
      case 'saveDraft': this.assertCapability('save'); return
      case 'publish': this.assertCapability('publish'); return
      case 'annotate': case 'reply': case 'disposition': this.assertCapability('review'); return
      default: fail('WHITEBOARD_V2_UNAVAILABLE', 'Whiteboard operation is unavailable', 403)
    }
  }
  capabilities(raw: z.input<typeof whiteboardV2CapabilityInputSchema>): Promise<WhiteboardV2Capabilities> {
    return this.track(async () => {
      const input = whiteboardV2CapabilityInputSchema.parse(raw), source = await this.source(input.workspaceKey)
      await this.current(source)
      return WHITEBOARD_V2_CAPABILITIES
    })
  }
  list(raw: z.input<typeof listInputSchema>): Promise<WhiteboardV2List> {
    return this.track(async () => {
      this.assertCapability('read')
      const input = listInputSchema.parse(raw), source = await this.source(input.workspaceKey)
      const { workspaceKey: _workspaceKey, ...query } = input
      const result = await this.deps.store.list(query, source.actor, source.binding)
      await this.current(source)
      return result
    })
  }
  get(raw: z.input<typeof getInputSchema>): Promise<WhiteboardV2View | null> {
    return this.track(async () => {
      this.assertCapability('read')
      const input = getInputSchema.parse(raw), source = await this.source(input.workspaceKey)
      const { workspaceKey: _workspaceKey, creationId, ...selection } = input
      const result = await this.deps.store.view(creationId, selection, source.actor)
      await this.current(source)
      return result
    })
  }
  command(raw: z.input<typeof commandInputSchema>): Promise<CreationCommandReply> {
    return this.track(async () => {
      const input = commandInputSchema.parse(raw), original = await this.source(input.workspaceKey)
      this.assertActionCapability(input.command.action)
      return this.serial(input.command.creationId, async () => {
        const source = await this.current(original), command = this.bind(input.command, source)
        const existing = await this.deps.store.pending(source.binding, command.creationId, source.actor)
        try { await this.current(source) } catch (error) { if (existing) throw uncertain(error); throw error }
        if (existing) this.assertPending(existing, command, source)
        const hasUnknown = Boolean(existing) || this.deps.store.unknownWrites().some((entry) => (entry.op === 'command' ? entry.command.creationId : entry.pending.command.creationId) === command.creationId)
        try {
          const current = await this.current(source)
          await this.deps.store.reconcileRetained(command.creationId, command.commandId, current.actor, current.binding, async () => { await this.current(source) }, command)
          await this.current(source)
        } catch (error) { if (hasUnknown) throw uncertain(error); throw error }
        const pending: PendingWhiteboardV2 = existing ?? { source: source.binding, command, recordedAt: (this.deps.now ?? Date.now)() }
        try {
          await this.deps.store.reserve(pending, source.actor)
        } catch (error) {
          if (typeof error === 'object' && error !== null && 'outcomeUnknown' in error && error.outcomeUnknown === true) throw uncertain(error)
          throw error
        }
        return this.finish(pending, source)
      })
    })
  }
  /** A null result is only absence at this read point, never proof of failure. */
  recover(raw: z.input<typeof recoverInputSchema>): Promise<CreationCommandReply | null> {
    return this.track(async () => {
      this.assertCapability('recover')
      const input = recoverInputSchema.parse(raw), original = await this.source(input.workspaceKey)
      if ('command' in input) this.assertActionCapability(input.command.action)
      const creationId = 'command' in input ? input.command.creationId : input.creationId
      const commandId = 'command' in input ? input.command.commandId : input.commandId
      return this.serial(creationId, async () => {
        const source = await this.current(original)
        const pending = await this.deps.store.pending(source.binding, creationId, source.actor)
        let current: Source
        try { current = await this.current(source) } catch (error) { if (pending) throw uncertain(error); throw error }
        if (pending) {
          if (pending.command.commandId !== commandId) fail('PENDING_OPERATION', 'Reconcile the original whiteboard command identity')
          if (pending.command.expectedEpoch !== source.binding.epoch) fail('SOURCE_CHANGED', 'Original whiteboard command epoch cannot be verified')
          this.assertPending(pending, 'command' in input ? this.bind(input.command, source) : pending.command, source)
          try {
            await this.deps.store.reconcileRetained(creationId, commandId, current.actor, current.binding, async () => { await this.current(source) }, 'command' in input ? this.bind(input.command, source) : undefined)
            await this.current(source)
            return await this.finish(pending, source)
          } catch (error) { throw uncertain(error) }
        }
        const reply = 'command' in input
          ? await this.deps.store.receipt(this.bind(input.command, source), current.actor, current.binding)
          : await this.deps.store.receiptById(creationId, commandId, current.actor, current.binding)
        if (reply) this.assertActionCapability(reply.result.action)
        try {
          current = await this.current(source)
          if (reply) {
            await this.deps.store.reconcileRetained(creationId, commandId, current.actor, current.binding, async () => { await this.current(source) }, 'command' in input ? this.bind(input.command, source) : undefined)
            await this.current(source)
          }
        } catch (error) { if (reply) throw uncertain(error); throw error }
        return reply
      })
    })
  }
  /** Main-only cleanup evidence; never expose the original payload through IPC. */
  retainedWrites(): WhiteboardWorkerWrite[] { return this.deps.store.unknownWrites() }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    const work = (async () => {
      await Promise.allSettled([...this.operations])
      await this.deps.store.close()
    })()
    this.closing = work
    void work.catch(() => { if (this.closing === work) this.closing = null })
    return work
  }
}

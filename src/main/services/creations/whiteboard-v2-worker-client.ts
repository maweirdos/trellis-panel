import { Worker } from 'node:worker_threads'
import { resolve } from 'node:path'
import { creationCommandReplySchema, type CreationCommandReply } from '../../../shared/creations'
import { whiteboardV2ListInputSchema, whiteboardV2ListSchema, whiteboardV2ViewInputSchema, whiteboardV2ViewSchema, type WhiteboardV2Command, type WhiteboardV2List, type WhiteboardV2View } from '../../../shared/creation-whiteboard-v2'
import type { z } from 'zod'
import { neighborWorkerFile } from '../worker-path'
import type { PendingWhiteboardV2 } from './whiteboard-v2-store'
import { WHITEBOARD_WORKER_MAX_MESSAGE_BYTES, WHITEBOARD_WORKER_MAX_PENDING_BYTES, WHITEBOARD_WORKER_MAX_PENDING_COUNT,
  isWhiteboardWrite, whiteboardWorkerOperationSchema, whiteboardWorkerPendingSchema, whiteboardWorkerResponseSchema, whiteboardWriteId,
  type WhiteboardWorkerActor, type WhiteboardWorkerOperation, type WhiteboardWorkerSource, type WhiteboardWorkerWrite } from './whiteboard-v2-worker-protocol'

type Pending = { operation: WhiteboardWorkerOperation; bytes: number; timer: NodeJS.Timeout; timedOut: boolean; resolve(value: unknown): void; reject(error: Error): void }
type Retained = { operation: WhiteboardWorkerWrite; bytes: number }
export class WhiteboardWorkerError extends Error {
  constructor(readonly code: string, message: string, readonly outcomeUnknown = false, readonly originalOperation?: WhiteboardWorkerWrite) {
    super(message); this.name = 'WhiteboardWorkerError'
  }
}

/** Trusted main-process client only; callers must derive and revalidate actor/source authority. */
export class WhiteboardV2WorkerClient {
  private worker: Worker | null = null
  private readonly pendingRequests = new Map<number, Pending>()
  private readonly retained = new Map<number, Retained>()
  private pendingBytes = 0
  private retainedBytes = 0
  private nextId = 0
  private closing: Promise<void> | null = null
  private closed = false
  private closeAttempted = false
  private constructor(private readonly timeoutMs: number, private readonly root: string, private readonly workerFile: string) {}

  static async open(input: { root: string; workerFile?: string; requestTimeoutMs?: number }): Promise<WhiteboardV2WorkerClient> {
    const timeout = input.requestTimeoutMs ?? 15000
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000) throw new WhiteboardWorkerError('INVALID_INPUT', 'Invalid whiteboard worker timeout')
    const root = resolve(input.root), workerFile = input.workerFile ?? neighborWorkerFile('whiteboard-v2-worker.js', 'TRELLIS_WHITEBOARD_V2_WORKER_FILE')
    const client = new WhiteboardV2WorkerClient(timeout, root, workerFile)
    const worker = new Worker(workerFile)
    client.worker = worker
    worker.on('message', (raw: unknown) => client.receive(worker, raw))
    worker.on('error', () => client.lost(worker))
    worker.on('exit', () => client.lost(worker))
    try { await client.request({ op: 'init', root }); return client }
    catch (error) { if (client.worker === worker) client.lost(worker); await worker.terminate(); throw error }
  }
  private error(code: string, message: string, unknown: boolean, operation: WhiteboardWorkerOperation): WhiteboardWorkerError {
    return new WhiteboardWorkerError(code, message, unknown, isWhiteboardWrite(operation) ? structuredClone(operation) : undefined)
  }
  private retain(id: number, pending: Pending): void {
    if (isWhiteboardWrite(pending.operation) && !this.retained.has(id)) {
      this.retained.set(id, { operation: structuredClone(pending.operation), bytes: pending.bytes }); this.retainedBytes += pending.bytes
    }
  }
  private lost(worker: Worker): void {
    if (this.worker !== worker) return
    this.worker = null
    for (const [id, entry] of this.pendingRequests) {
      clearTimeout(entry.timer)
      const write = isWhiteboardWrite(entry.operation)
      if (write) this.retain(id, entry)
      entry.reject(this.error(write ? 'ACKNOWLEDGEMENT_UNKNOWN' : 'STORE_UNAVAILABLE', 'Whiteboard worker stopped before acknowledgement', write, entry.operation))
    }
    this.pendingRequests.clear(); this.pendingBytes = 0
  }
  private validateResult(operation: WhiteboardWorkerOperation, value: unknown): unknown {
    switch (operation.op) {
      case 'init': case 'close': case 'reserve': case 'settle': if (value !== null) throw new Error('Unexpected worker response'); return null
      case 'list': {
        const result = whiteboardV2ListSchema.parse(value)
        if (result.items.some((item) => item.ownerId !== operation.actor.actorId || item.projectId !== operation.actor.projectId)) throw new Error('List owner mismatch')
        return result
      }
      case 'view': {
        if (value === null) return null
        const result = whiteboardV2ViewSchema.parse(value)
        if (result.summary.creationId !== operation.id || result.summary.ownerId !== operation.actor.actorId || result.summary.projectId !== operation.actor.projectId || result.selected.revisionId !== operation.selection.revisionId) throw new Error('View identity mismatch')
        return result
      }
      case 'pending': {
        if (value === null) return null
        const pending = whiteboardWorkerPendingSchema.parse(value)
        if (pending.command.creationId !== operation.id || JSON.stringify(pending.source) !== JSON.stringify(operation.source)) throw new Error('Pending source mismatch')
        return pending
      }
      case 'receipt-by-id': {
        if (value === null) return null
        const reply = creationCommandReplySchema.parse(value)
        if (reply.status !== 'committed' || reply.commandId !== operation.commandId || reply.result.creationId !== operation.creationId ||
          reply.result.projectId !== operation.source.projectId || reply.result.epoch !== operation.source.epoch ||
          !['create', 'saveDraft', 'publish', 'annotate', 'reply', 'disposition'].includes(reply.result.action) || !reply.result.revisionId ||
          (['create', 'saveDraft', 'publish'].includes(reply.result.action) && (reply.result.revisionId !== operation.commandId || reply.result.commentId !== undefined)) ||
          (reply.result.action === 'annotate' && reply.result.commentId !== operation.commandId) ||
          (['reply', 'disposition'].includes(reply.result.action) && !reply.result.commentId) ||
          (reply.result.action !== 'disposition' && reply.result.reviewRevisionId !== undefined) ||
          !reply.result.private || reply.result.scopeSpaceIds.length !== 0 || reply.result.scopeTaskIds.length !== 0 ||
          reply.result.scopePersonIds.length !== 1 || reply.result.scopePersonIds[0] !== operation.actor.actorId ||
          reply.result.candidateId !== undefined || reply.result.adoptionId !== undefined) throw new Error('Receipt identity mismatch')
        return reply
      }
      case 'command': case 'receipt': {
        if (operation.op === 'receipt' && value === null) return null
        const reply = creationCommandReplySchema.parse(value)
        if (reply.commandId !== operation.command.commandId || reply.result.creationId !== operation.command.creationId || reply.result.action !== operation.command.action ||
          reply.result.projectId !== operation.source.projectId || reply.result.epoch !== operation.source.epoch ||
          reply.result.revision !== (operation.command.expectedRevision ?? 0) + 1 || !reply.result.revisionId ||
          (['create', 'saveDraft', 'publish'].includes(operation.command.action) && (reply.result.revisionId !== operation.command.commandId || reply.result.commentId !== undefined)) ||
          (operation.command.action === 'annotate' && (reply.result.revisionId !== operation.command.revisionId || reply.result.commentId !== operation.command.commandId)) ||
          ((operation.command.action === 'reply' || operation.command.action === 'disposition') && reply.result.commentId !== operation.command.commentId) ||
          (operation.command.action !== 'disposition' && reply.result.reviewRevisionId !== undefined) ||
          (operation.command.action === 'disposition' && operation.command.reviewRevisionId !== undefined && reply.result.reviewRevisionId !== operation.command.reviewRevisionId) ||
          !reply.result.private || reply.result.scopeSpaceIds.length !== 0 || reply.result.scopeTaskIds.length !== 0 ||
          reply.result.scopePersonIds.length !== 1 || reply.result.scopePersonIds[0] !== operation.actor.actorId || reply.result.candidateId !== undefined || reply.result.adoptionId !== undefined) throw new Error('Receipt identity mismatch')
        return reply
      }
    }
  }
  private receive(worker: Worker, raw: unknown): void {
    if (this.worker !== worker) return
    const parsed = whiteboardWorkerResponseSchema.safeParse(raw)
    if (!parsed.success) { this.lost(worker); void worker.terminate(); return }
    const response = parsed.data, entry = this.pendingRequests.get(response.requestId)
    if (!entry) return
    this.pendingRequests.delete(response.requestId); this.pendingBytes -= entry.bytes; clearTimeout(entry.timer)
    if (entry.timedOut) { this.retain(response.requestId, entry); if (!this.pendingRequests.size) worker.unref(); return }
    if (!response.ok) {
      const unknown = isWhiteboardWrite(entry.operation) && response.outcomeUnknown
      if (unknown) this.retain(response.requestId, entry)
      entry.reject(this.error(response.code, response.message, unknown, entry.operation))
    } else {
      try { entry.resolve(this.validateResult(entry.operation, response.value)) }
      catch {
        const unknown = isWhiteboardWrite(entry.operation)
        if (unknown) this.retain(response.requestId, entry)
        entry.reject(this.error(unknown ? 'ACKNOWLEDGEMENT_UNKNOWN' : 'STORE_UNAVAILABLE', 'Whiteboard worker response could not be verified', unknown, entry.operation))
      }
    }
    if (!this.pendingRequests.size) worker.unref()
  }
  private request<T>(input: WhiteboardWorkerOperation, allowClosing = false): Promise<T> {
    const operation = whiteboardWorkerOperationSchema.parse(input), worker = this.worker
    if (!worker || (this.closed && !allowClosing)) return Promise.reject(this.error('STORE_UNAVAILABLE', 'Whiteboard worker is unavailable', false, operation))
    const bytes = Buffer.byteLength(JSON.stringify(operation))
    if (isWhiteboardWrite(operation)) {
      const id = whiteboardWriteId(operation).toLowerCase()
      if ([...this.pendingRequests.values()].some((entry) => isWhiteboardWrite(entry.operation) && whiteboardWriteId(entry.operation).toLowerCase() === id) ||
        [...this.retained.values()].some((entry) => whiteboardWriteId(entry.operation).toLowerCase() === id)) {
        return Promise.reject(this.error('PENDING_OPERATION', 'Reconcile the original whiteboard operation first', false, operation))
      }
    }
    if (bytes > WHITEBOARD_WORKER_MAX_MESSAGE_BYTES || (!allowClosing && (this.pendingRequests.size + this.retained.size >= WHITEBOARD_WORKER_MAX_PENDING_COUNT || this.pendingBytes + this.retainedBytes + bytes > WHITEBOARD_WORKER_MAX_PENDING_BYTES))) {
      return Promise.reject(this.error('CAPACITY_EXCEEDED', 'Whiteboard worker queue is full', false, operation))
    }
    const requestId = ++this.nextId
    return new Promise<T>((resolveResult, reject) => {
      const entry: Pending = { operation, bytes, timedOut: false, resolve: (value) => resolveResult(value as T), reject,
        timer: setTimeout(() => {
          entry.timedOut = true
          const unknown = isWhiteboardWrite(operation)
          reject(this.error(unknown ? 'ACKNOWLEDGEMENT_UNKNOWN' : 'STORE_UNAVAILABLE', 'Whiteboard worker acknowledgement timed out', unknown, operation))
        }, this.timeoutMs) }
      this.pendingRequests.set(requestId, entry); this.pendingBytes += bytes; worker.ref()
      try { worker.postMessage({ requestId, operation }) }
      catch {
        this.pendingRequests.delete(requestId); this.pendingBytes -= bytes; clearTimeout(entry.timer)
        if (!this.pendingRequests.size) worker.unref()
        reject(this.error('STORE_UNAVAILABLE', 'Whiteboard worker request was not dispatched', false, operation))
      }
    })
  }
  /** Unknown writes remain bound to their exact source and payload even after close. */
  unknownWrites(): WhiteboardWorkerWrite[] {
    const waiting = [...this.pendingRequests.values()].filter((entry) => entry.timedOut && isWhiteboardWrite(entry.operation)).map((entry) => entry.operation as WhiteboardWorkerWrite)
    return structuredClone([...this.retained.values()].map((entry) => entry.operation).concat(waiting))
  }
  list(query: z.input<typeof whiteboardV2ListInputSchema>, actor: WhiteboardWorkerActor, source: WhiteboardWorkerSource): Promise<WhiteboardV2List> { return this.request({ op: 'list', query: whiteboardV2ListInputSchema.parse(query), actor, source }) }
  view(id: string, selection: z.input<typeof whiteboardV2ViewInputSchema>, actor: WhiteboardWorkerActor): Promise<WhiteboardV2View | null> { return this.request({ op: 'view', id, selection: whiteboardV2ViewInputSchema.parse(selection), actor }) }
  command(command: WhiteboardV2Command, actor: WhiteboardWorkerActor, source: WhiteboardWorkerSource): Promise<CreationCommandReply> { return this.request({ op: 'command', command, actor, source }) }
  receipt(command: WhiteboardV2Command, actor: WhiteboardWorkerActor, source: WhiteboardWorkerSource): Promise<CreationCommandReply | null> { return this.request({ op: 'receipt', command, actor, source }) }
  receiptById(creationId: string, commandId: string, actor: WhiteboardWorkerActor, source: WhiteboardWorkerSource): Promise<CreationCommandReply | null> { return this.request({ op: 'receipt-by-id', creationId, commandId, actor, source }) }
  pending(source: WhiteboardWorkerSource, id: string, actor: WhiteboardWorkerActor): Promise<PendingWhiteboardV2 | null> { return this.request({ op: 'pending', source, id, actor }) }
  reserve(pending: PendingWhiteboardV2, actor: WhiteboardWorkerActor): Promise<void> { return this.request({ op: 'reserve', pending, actor }) }
  settle(pending: PendingWhiteboardV2, actor: WhiteboardWorkerActor): Promise<void> { return this.request({ op: 'settle', pending, actor }) }
  /** Release only the exact original operation after authenticated durable reconciliation. */
  async reconcileRetained(creationId: string, commandId: string, actor: WhiteboardWorkerActor, source: WhiteboardWorkerSource, assertCurrent: () => Promise<void>, expectedCommand?: WhiteboardV2Command): Promise<void> {
    if (this.closed || !this.worker) throw new WhiteboardWorkerError('STORE_UNAVAILABLE', 'Whiteboard worker is unavailable')
    const id = creationId.toLowerCase()
    if ([...this.pendingRequests.values()].some((entry) => isWhiteboardWrite(entry.operation) && whiteboardWriteId(entry.operation).toLowerCase() === id)) {
      throw new WhiteboardWorkerError('PENDING_OPERATION', 'Original whiteboard operation is still awaiting its reply', true)
    }
    const entries = [...this.retained.entries()].filter(([, entry]) => whiteboardWriteId(entry.operation).toLowerCase() === id)
    if (!entries.length) return
    for (const [, entry] of entries) {
      const original = entry.operation, originalSource = original.op === 'command' ? original.source : original.pending.source
      const originalCommand = original.op === 'command' ? original.command : original.pending.command
      if (!source.sourceIdentity || originalCommand.creationId !== creationId || originalCommand.commandId !== commandId ||
        (expectedCommand !== undefined && JSON.stringify(originalCommand) !== JSON.stringify(expectedCommand)) ||
        JSON.stringify(originalSource) !== JSON.stringify(source) || original.actor.actorId !== actor.actorId || original.actor.projectId !== actor.projectId ||
        original.actor.epoch !== actor.epoch || source.actorId !== actor.actorId || source.projectId !== actor.projectId || source.epoch !== actor.epoch || originalCommand.expectedEpoch !== source.epoch) {
        throw new WhiteboardWorkerError('PENDING_OPERATION', 'Original whiteboard identity or source does not match', true)
      }
      const pending = await this.pending(source, creationId, actor)
      if (pending && (JSON.stringify(pending.source) !== JSON.stringify(originalSource) || JSON.stringify(pending.command) !== JSON.stringify(originalCommand) ||
        (original.op !== 'command' && JSON.stringify(pending) !== JSON.stringify(original.pending)))) {
        throw new WhiteboardWorkerError('PENDING_OPERATION', 'Original whiteboard payload does not match', true)
      }
      // Receipt lookup reauthorizes the exact operation even when a pending record already proves its payload.
      const receipt = await this.receipt(originalCommand, actor, source)
      if (!pending && !receipt) throw new WhiteboardWorkerError('PENDING_OPERATION', 'Original whiteboard outcome remains unknown', true)
    }
    await assertCurrent()
    if (this.closed || !this.worker) throw new WhiteboardWorkerError('STORE_UNAVAILABLE', 'Whiteboard worker stopped during reconciliation', true)
    for (const [requestId, entry] of entries) {
      if (this.retained.get(requestId) !== entry) throw new WhiteboardWorkerError('PENDING_OPERATION', 'Original whiteboard operation changed during reconciliation', true)
    }
    for (const [requestId, entry] of entries) { this.retained.delete(requestId); this.retainedBytes -= entry.bytes }
  }
  private async preserveRetained(): Promise<void> {
    const original = [...this.retained.values()].map((entry) => structuredClone(entry.operation))
    if (!original.length) return
    const verifier = await WhiteboardV2WorkerClient.open({ root: this.root, workerFile: this.workerFile, requestTimeoutMs: this.timeoutMs })
    let completed = false
    try {
      for (const operation of original) {
        const source = operation.op === 'command' ? operation.source : operation.pending.source
        const command = operation.op === 'command' ? operation.command : operation.pending.command
        const actor = operation.actor
        if (!source.sourceIdentity || source.projectId !== 'local' || actor.projectId !== 'local' || source.actorId !== actor.actorId || source.epoch !== actor.epoch || command.expectedEpoch !== source.epoch) {
          throw new WhiteboardWorkerError('SOURCE_CHANGED', 'Original whiteboard source cannot be verified for cleanup', true, operation)
        }
        let pending = await verifier.pending(source, command.creationId, actor)
        if (pending && (JSON.stringify(pending.source) !== JSON.stringify(source) || JSON.stringify(pending.command) !== JSON.stringify(command) ||
          (operation.op !== 'command' && JSON.stringify(pending) !== JSON.stringify(operation.pending)))) {
          throw new WhiteboardWorkerError('PENDING_OPERATION', 'Original whiteboard pending operation differs', true, operation)
        }
        if (!pending && operation.op === 'reserve') {
          // Only preserve the admitted local intent. Never replay a business command during shutdown.
          await verifier.reserve(operation.pending, actor)
          pending = await verifier.pending(source, command.creationId, actor)
          if (!pending || JSON.stringify(pending) !== JSON.stringify(operation.pending)) throw new WhiteboardWorkerError('ACKNOWLEDGEMENT_UNKNOWN', 'Original whiteboard intent could not be preserved', true, operation)
        } else if (!pending) {
          const receipt = await verifier.receipt(command, actor, source)
          if (!receipt) throw new WhiteboardWorkerError('ACKNOWLEDGEMENT_UNKNOWN', 'Original whiteboard result remains unknown', true, operation)
        }
      }
      completed = true
    } finally {
      // A failed verifier write remains represented by the original retained operation.
      await verifier.close()
    }
    if (completed) { this.retained.clear(); this.retainedBytes = 0 }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    const retry = this.closeAttempted
    this.closeAttempted = true
    const work = (async () => {
      if (retry && this.retained.size) {
        try { await this.preserveRetained() }
        catch (error) {
          const original = error instanceof WhiteboardWorkerError && error.originalOperation ? error.originalOperation : this.retained.values().next().value?.operation
          throw new WhiteboardWorkerError(error instanceof WhiteboardWorkerError ? error.code : 'ACKNOWLEDGEMENT_UNKNOWN', 'Original whiteboard cleanup is not yet verified', true, original ? structuredClone(original) : undefined)
        }
        return
      }
      const worker = this.worker
      if (!worker) {
        if (this.retained.size) throw new WhiteboardWorkerError('ACKNOWLEDGEMENT_UNKNOWN', 'Whiteboard worker stopped with operations requiring reconciliation', true)
        return
      }
      try {
        await this.request({ op: 'close' }, true)
        if (this.pendingRequests.size || this.retained.size) throw new WhiteboardWorkerError('ACKNOWLEDGEMENT_UNKNOWN', 'Whiteboard operations still need reconciliation', true)
      } finally {
        if (this.worker === worker) this.lost(worker)
        await worker.terminate()
      }
    })()
    this.closing = work
    void work.catch(() => { if (this.closing === work) this.closing = null })
    return work
  }
}

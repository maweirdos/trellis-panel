import { createHash } from 'node:crypto'
import { parentPort } from 'node:worker_threads'
import { z } from 'zod'
import { CreationError } from '../../../shared/creations-domain'
import { WhiteboardV2LocalStore } from './whiteboard-v2-store'
import { WHITEBOARD_WORKER_MAX_MESSAGE_BYTES, isWhiteboardWrite, whiteboardWorkerRequestSchema, type WhiteboardWorkerActor, type WhiteboardWorkerOperation } from './whiteboard-v2-worker-protocol'

const port = parentPort
if (!port) throw new Error('Whiteboard storage requires its worker port')
let store: WhiteboardV2LocalStore | null = null
let tail: Promise<void> = Promise.resolve()
const actorContext = (actor: WhiteboardWorkerActor): WhiteboardWorkerActor & { digestBody(body: string): string } => ({
  ...actor, digestBody: (body) => createHash('sha256').update(body, 'utf8').digest('hex')
})
async function dispatch(operation: WhiteboardWorkerOperation): Promise<unknown> {
  if (operation.op === 'init') {
    if (store) throw new CreationError('STORE_CONFLICT', 'Whiteboard worker is already initialized')
    store = new WhiteboardV2LocalStore(operation.root)
    return null
  }
  if (operation.op === 'close') { store = null; return null }
  if (!store) throw new CreationError('STORE_UNAVAILABLE', 'Whiteboard worker is not initialized')
  switch (operation.op) {
    case 'list': return store.list(operation.query, actorContext(operation.actor), operation.source)
    case 'view': return store.view(operation.id, operation.selection, actorContext(operation.actor))
    case 'command': return store.command(operation.command, actorContext(operation.actor), operation.source)
    case 'receipt': return store.receipt(operation.command, actorContext(operation.actor), operation.source)
    case 'receipt-by-id': return store.receiptById(operation.creationId, operation.commandId, actorContext(operation.actor), operation.source)
    case 'pending': return store.pending(operation.source, operation.id, actorContext(operation.actor))
    case 'reserve': await store.reserve(operation.pending, actorContext(operation.actor)); return null
    case 'settle': await store.settle(operation.pending, actorContext(operation.actor)); return null
  }
}
port.on('message', (raw: unknown) => {
  tail = tail.then(async () => {
    let requestId = 0, operation: WhiteboardWorkerOperation | undefined
    try {
      if (Buffer.byteLength(JSON.stringify(raw)) > WHITEBOARD_WORKER_MAX_MESSAGE_BYTES) throw new CreationError('CAPACITY_EXCEEDED', 'Whiteboard worker request exceeds its limit')
      const request = whiteboardWorkerRequestSchema.parse(raw)
      requestId = request.requestId; operation = request.operation
      const value = await dispatch(operation)
      if (Buffer.byteLength(JSON.stringify(value)) > WHITEBOARD_WORKER_MAX_MESSAGE_BYTES) throw new Error('Response exceeds its limit')
      port.postMessage({ requestId, ok: true, value })
    } catch (error) {
      if (!requestId && typeof raw === 'object' && raw !== null && 'requestId' in raw && Number.isSafeInteger(raw.requestId) && Number(raw.requestId) > 0) requestId = Number(raw.requestId)
      if (!requestId) return
      const known = error instanceof CreationError || error instanceof z.ZodError
      port.postMessage({ requestId, ok: false, code: error instanceof CreationError ? error.code : error instanceof z.ZodError ? 'INVALID_INPUT' : 'STORE_UNAVAILABLE',
        message: error instanceof CreationError ? error.message : error instanceof z.ZodError ? 'Whiteboard worker input is invalid' : 'Whiteboard storage failed; preserve the original operation',
        outcomeUnknown: Boolean(operation && isWhiteboardWrite(operation) && !known) })
    }
  }).catch(() => { port.close() })
})

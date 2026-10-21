/** Clean-room serialized SQLite worker; no model/native or network action occurs here. */
import { parentPort } from 'node:worker_threads'
import { z } from 'zod'
import { WorkflowControlCore } from './core'
import { MAX_CONTROL_REQUEST_BYTES, WorkflowControlError, type WorkflowControlOperation, type WorkflowControlRequest, type WorkflowControlResponse } from './types'
import { redactText } from '../observability/store-core'

const port = parentPort
if (!port) throw new Error('Workflow control requires an owned worker thread')
let core: WorkflowControlCore | undefined
let queue: Promise<void> = Promise.resolve()

async function execute(message: WorkflowControlOperation): Promise<unknown> {
  if (message.op === 'init') {
    if (core) throw new WorkflowControlError('ALREADY_OPEN', 'Workflow control already initialized')
    core = new WorkflowControlCore(z.string().min(1).parse(message.runtimeDir))
    return core.open()
  }
  const store = core
  if (!store) throw new WorkflowControlError('STORE_UNAVAILABLE', 'Workflow control is not initialized')
  switch (message.op) {
    case 'claim': return store.claimWorkspace(message.input)
    case 'workspace-owner': return store.workspaceOwner(message.input)
    case 'renew': return store.renewWorkspace(message.input, message.owner)
    case 'release': return store.releaseWorkspace(message.scope, message.owner)
    case 'recover-process': return store.recoverProcessOwner(message.scope, message.expectedOwner)
    case 'reserve': return store.reserveCommand(message.command, message.owner)
    case 'cancel-command': return store.cancelReservedCommand(message.scope, message.commandId, message.owner, message.evidenceRefs)
    case 'commit': return store.commitWithManifests(message.input)
    case 'load': return store.load(message.scope, message.run)
    case 'head': return store.head(message.scope)
    case 'events': return store.events(message.input)
    case 'append': return store.append(message.report as Parameters<WorkflowControlCore['append']>[0])
    case 'command': return store.getCommand(message.scope, message.commandId)
    case 'operation': return store.getOperation(message.scope, message.operationId)
    case 'pending': return store.pendingOperations(message.scope, message.owner, message.limit)
    case 'dispatch': return store.claimOperation(message.input)
    case 'settle': return store.settleOperation(message.input)
    case 'reconcile': return store.reconcileOperation(message.input)
    case 'step': return store.recordStep(message.record)
    case 'steps': return store.steps(message.scope, message.run)
    case 'sync-page': return store.syncPage(message.scope, message.limit)
    case 'sync-confirm': return store.confirmSync(message.scope, message.deliveryIds)
    case 'alias-read': return store.getAlias(message.taskRef)
    case 'alias-upsert': return store.upsertAlias(message.taskRef, message.trellisTaskId, message.dir)
    case 'health': return store.health()
    case 'close': store.close(); core = undefined; return null
  }
}

port.on('message', (raw: unknown) => {
  const envelope = z.object({ requestId: z.number().int().positive().safe(), op: z.string().min(1) }).passthrough().safeParse(raw)
  if (!envelope.success) return
  const requestId = envelope.data.requestId
  queue = queue.then(async () => {
    let response: WorkflowControlResponse
    try {
      if (Buffer.byteLength(JSON.stringify(raw)) > MAX_CONTROL_REQUEST_BYTES) throw new WorkflowControlError('REQUEST_TOO_LARGE', 'Workflow control request is too large')
      const message = raw as WorkflowControlRequest
      const known = ['init', 'claim', 'workspace-owner', 'renew', 'release', 'recover-process', 'reserve', 'cancel-command', 'commit', 'load', 'head', 'events', 'append', 'command', 'operation', 'pending', 'dispatch', 'settle', 'reconcile', 'step', 'steps', 'sync-page', 'sync-confirm', 'alias-read', 'alias-upsert', 'health', 'close']
      if (!known.includes(message.op)) throw new WorkflowControlError('INVALID_OPERATION', 'Unknown workflow control operation')
      response = { requestId, ok: true, value: await execute(message) }
    } catch (error) {
      response = { requestId, ok: false, code: error instanceof WorkflowControlError ? error.code : 'STORE_OPERATION_FAILED', error: redactText(error instanceof Error ? error.message : String(error)), outcomeUnknown: error instanceof WorkflowControlError && error.outcomeUnknown }
    }
    port.postMessage(response)
  }).catch((error: unknown) => {
    const response: WorkflowControlResponse = { requestId, ok: false, code: 'WORKER_FAILURE', error: redactText(error instanceof Error ? error.message : String(error)), outcomeUnknown: true }
    port.postMessage(response)
  })
})

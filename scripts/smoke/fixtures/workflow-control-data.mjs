/** Deterministic business inputs; exercised against the real exported control APIs. */
import { createHash } from 'node:crypto'

export const scope = { projectId: 'project-a', repositoryId: 'repo-a', workspaceId: 'workspace-a', taskRef: 'task:example' }
export const digest = (text) => createHash('sha256').update(text).digest('hex')
export const asset = (assetId = 'schema') => ({ assetId, version: 'v1', digest: digest(assetId) })

export function event(api, run = { runId: 'run-a', revision: 1 }, id = 'event-a', overrides = {}) {
  return { contractVersion: 1, eventId: id, source: 'platform', type: 'workflow.stage-evidence', attribution: { kind: 'assigned', scope, run, step: null, sessionId: null, turnId: null, historySeq: null }, occurredAt: 10, receivedAt: 11, epoch: 'source-epoch', sequence: 1, payload: { evidence: 'actual deterministic fixture' }, ...overrides }
}
export function manifest(run = { runId: 'run-a', revision: 1 }, definition = { definitionId: 'definition-a', revision: 1 }) {
  return { contractVersion: 1, scope, run, definition, roles: [], executors: [], extensions: [], context: { scope, instruction: 'Control persistence fixture; no engine action.', inputs: {}, materials: [], engineeringBaseline: asset('baseline'), outputContract: asset('output'), budgetBytes: 1024, complete: true }, inputFingerprint: digest('effective input'), recordedAt: 10 }
}
export function command(api, id = 'command-a', kind = 'start', run = { runId: 'run-a', revision: 1 }, payload = { purpose: 'control fixture' }) {
  return { contractVersion: 1, commandId: id, scope, runId: run.runId, expectedRevision: run.revision, kind, payloadDigest: digest(api.canonicalWorkflowJson(payload)), payload, requestedAt: 10 }
}
export function startInput(api, owner, options = {}) {
  const run = { runId: options.runId ?? 'run-a', revision: 1 }
  const record = { contractVersion: 1, scope, run, definition: { definitionId: 'definition-a', revision: 1 }, state: options.state ?? 'planned', predecessor: null, createdAt: 10 }
  const cmd = command(api, options.commandId ?? 'command-a', 'start', run)
  return { journal: { command: cmd, owner, expectedCurrent: null, runChanges: [record], events: [event(api, run, options.eventId ?? 'event-a')], outbox: options.noOperation ? [] : [{ operationId: options.operationId ?? 'operation-a', commandId: cmd.commandId, scope, run, state: 'pending', ownerId: owner.ownerId, fencingToken: owner.fencingToken, result: null }] }, manifests: [manifest(run)] }
}
export function adoptionInput(api, owner, id = 'adopt-a') {
  const predecessor = { runId: 'run-a', revision: 1 }; const successor = { runId: id + '-run', revision: 2 }
  const cmd = command(api, id, 'adopt-revision', predecessor, { previewId: id })
  const record = { contractVersion: 1, scope, run: successor, definition: { definitionId: 'definition-a', revision: 2 }, state: 'queued', predecessor, createdAt: 12 }
  return { journal: { command: cmd, owner, expectedCurrent: predecessor, runChanges: [record], events: [event(api, successor, id + '-event')], outbox: [{ operationId: id + '-operation', commandId: id, scope, run: successor, state: 'pending', ownerId: owner.ownerId, fencingToken: owner.fencingToken, result: null }] }, manifests: [manifest(successor, record.definition)] }
}

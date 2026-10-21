/** Clean-room bounded async facade. SQLite never executes on the caller thread. */
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import type { z } from 'zod'
import {
  type WorkflowJournalPort, type WorkflowReportSinkPort, type JournalCommit,
  type WorkflowWriteAcknowledgement, type WorkflowEventReport, type JournalSnapshot,
  type RunRef, type WorkflowCommand
} from '../../../shared/workflow'
import type { TaskAliasRecord } from '../observability/store-core'
import { neighborWorkerFile } from '../worker-path'
import {
  CONTROL_REQUEST_TIMEOUT_MS, DEFAULT_OWNER_TTL_MS, MAX_CONTROL_PENDING_BYTES,
  MAX_CONTROL_PENDING_REQUESTS, MAX_CONTROL_REQUEST_BYTES, WorkflowControlError,
  eventPageInputSchema,
  type WorkflowCommitInput, type WorkflowControlOperation, type WorkflowControlResponse,
  type WorkflowScope, type WorkflowOwner, type WorkflowControlHealth,
  type LeaseResult, type WorkspaceLease, type WorkspaceIdentity, type WorkflowEventPage, type OperationRecord,
  type WorkflowStepRecord
} from './types'
import type { CommandRecord } from './core'

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; bytes: number }
export type WorkflowControlServiceOptions = { workerFile?: string; requestTimeoutMs?: number }

export class WorkflowControlService implements WorkflowJournalPort, WorkflowReportSinkPort {
  private worker: Worker | undefined
  private opening: Promise<WorkflowControlHealth> | undefined
  private readonly requests = new Map<number, Pending>()
  private readonly ownerId = randomUUID()
  private pendingBytes = 0
  private nextId = 1
  private closed = false
  private readonly timeoutMs: number
  constructor(private readonly runtimeDir: string, private readonly options: WorkflowControlServiceOptions = {}) {
    this.timeoutMs = options.requestTimeoutMs ?? CONTROL_REQUEST_TIMEOUT_MS
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) throw new WorkflowControlError('INVALID_ARGUMENT', 'Invalid workflow worker deadline')
  }
  open(): Promise<WorkflowControlHealth> {
    if (this.closed) return Promise.reject(new WorkflowControlError('SERVICE_CLOSED', 'Workflow control service is closed'))
    if (this.opening) return this.opening
    const worker = new Worker(this.options.workerFile ?? neighborWorkerFile('workflow-control-worker.js', 'TRELLIS_WORKFLOW_CONTROL_WORKER_FILE'))
    this.worker = worker
    worker.on('message', (message: WorkflowControlResponse) => {
      if (this.worker !== worker) return
      const pending = this.requests.get(message.requestId)
      if (!pending) return
      this.requests.delete(message.requestId); this.pendingBytes -= pending.bytes; clearTimeout(pending.timer)
      if (message.ok) pending.resolve(message.value)
      else pending.reject(new WorkflowControlError(message.code, message.error, message.outcomeUnknown))
    })
    const lost = (message: string): void => {
      if (this.worker !== worker) return
      this.worker = undefined; this.opening = undefined
      for (const pending of this.requests.values()) { clearTimeout(pending.timer); pending.reject(new WorkflowControlError('ACKNOWLEDGEMENT_UNKNOWN', message, true)) }
      this.requests.clear(); this.pendingBytes = 0
      // The main controller/native execution may still be alive. Never release
      // its lease or replay work just because this SQLite writer exited.
    }
    worker.on('error', (error) => lost(`Workflow control worker failed: ${error.message}`))
    worker.on('exit', (code) => lost(`Workflow control worker exited (${code}); check committed identities before retry`))
    worker.unref()
    this.opening = this.request<WorkflowControlHealth>({ op: 'init', runtimeDir: this.runtimeDir }).catch(async (error: unknown) => {
      if (this.worker === worker) { lost('Workflow control initialization acknowledgement unavailable'); await worker.terminate() }
      throw error
    })
    return this.opening
  }
  private request<T>(operation: WorkflowControlOperation): Promise<T> {
    const worker = this.worker
    if (!worker) return Promise.reject(new WorkflowControlError('STORE_UNAVAILABLE', 'Workflow control worker is unavailable'))
    const bytes = Buffer.byteLength(JSON.stringify(operation))
    if (bytes > MAX_CONTROL_REQUEST_BYTES || this.requests.size >= MAX_CONTROL_PENDING_REQUESTS || this.pendingBytes + bytes > MAX_CONTROL_PENDING_BYTES) return Promise.reject(new WorkflowControlError('QUEUE_FULL', 'Workflow control queue is at its bounded limit; request was not sent'))
    const requestId = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.requests.get(requestId)
        if (!pending) return
        // Retain the in-flight entry/budget until an actual response or exit.
        // A deadline is not evidence that the worker discarded the request.
        reject(new WorkflowControlError('ACKNOWLEDGEMENT_UNKNOWN', 'Workflow control acknowledgement timed out; query the original identity before retry', true))
      }, this.timeoutMs)
      this.requests.set(requestId, { resolve: (value) => resolve(value as T), reject, timer, bytes }); this.pendingBytes += bytes
      try { worker.postMessage({ ...operation, requestId }) }
      catch (error) { this.requests.delete(requestId); this.pendingBytes -= bytes; clearTimeout(timer); reject(error) }
    })
  }
  private async call<T>(operation: WorkflowControlOperation): Promise<T> { await this.open(); return this.request<T>(operation) }
  health(): Promise<WorkflowControlHealth> { return this.call({ op: 'health' }) }
  workspaceOwner(input: WorkspaceIdentity): Promise<WorkspaceLease | null> { return this.call({ op: 'workspace-owner', input }) }
  claimWorkspace(scope: WorkflowScope, ttlMs = DEFAULT_OWNER_TTL_MS): Promise<LeaseResult> { return this.call({ op: 'claim', input: { scope, ownerId: this.ownerId, ttlMs } }) }
  renewWorkspace(scope: WorkflowScope, owner: WorkflowOwner, ttlMs = DEFAULT_OWNER_TTL_MS): Promise<WorkspaceLease> { return this.call({ op: 'renew', input: { scope, ownerId: this.ownerId, ttlMs }, owner }) }
  releaseWorkspace(scope: WorkflowScope, owner: WorkflowOwner): Promise<void> { return this.call({ op: 'release', scope, owner }) }
  recoverProcessOwner(scope: WorkflowScope, expectedOwner: WorkflowOwner): Promise<WorkspaceLease> { return this.call({ op: 'recover-process', scope, expectedOwner }) }
  reserveCommand(command: WorkflowCommand, owner: WorkflowOwner): Promise<WorkflowWriteAcknowledgement> { return this.call({ op: 'reserve', command, owner }) }
  cancelReservedCommand(scope: WorkflowScope, commandId: string, owner: WorkflowOwner, evidenceRefs: string[]): Promise<WorkflowWriteAcknowledgement> { return this.call({ op: 'cancel-command', scope, commandId, owner, evidenceRefs }) }
  commit(journal: JournalCommit): Promise<WorkflowWriteAcknowledgement> { return this.commitWithManifests({ journal, manifests: [] }) }
  commitWithManifests(input: WorkflowCommitInput): Promise<WorkflowWriteAcknowledgement> { return this.call({ op: 'commit', input }) }
  load(scope: WorkflowScope, run: RunRef): Promise<JournalSnapshot | null> { return this.call({ op: 'load', scope, run }) }
  head(scope: WorkflowScope): Promise<JournalSnapshot | null> { return this.call({ op: 'head', scope }) }
  append(report: WorkflowEventReport): Promise<WorkflowWriteAcknowledgement> { return this.call({ op: 'append', report }) }
  events(input: z.input<typeof eventPageInputSchema>): Promise<WorkflowEventPage> { return this.call({ op: 'events', input: eventPageInputSchema.parse(input) }) }
  getCommand(scope: WorkflowScope, commandId: string): Promise<CommandRecord | null> { return this.call({ op: 'command', scope, commandId }) }
  getOperation(scope: WorkflowScope, operationId: string): Promise<OperationRecord | null> { return this.call({ op: 'operation', scope, operationId }) }
  pendingOperations(scope: WorkflowScope, owner: WorkflowOwner, limit = 50): Promise<OperationRecord[]> { return this.call({ op: 'pending', scope, owner, limit }) }
  claimOperation(input: Parameters<import('./core').WorkflowControlCore['claimOperation']>[0]): Promise<OperationRecord> { return this.call({ op: 'dispatch', input }) }
  settleOperation(input: Parameters<import('./core').WorkflowControlCore['settleOperation']>[0]): Promise<OperationRecord> { return this.call({ op: 'settle', input }) }
  reconcileOperation(input: Parameters<import('./core').WorkflowControlCore['reconcileOperation']>[0]): Promise<OperationRecord> { return this.call({ op: 'reconcile', input }) }
  recordStep(record: WorkflowStepRecord): Promise<void> { return this.call({ op: 'step', record }) }
  steps(scope: WorkflowScope, run: RunRef): Promise<WorkflowStepRecord[]> { return this.call({ op: 'steps', scope, run }) }
  syncPage(scope: WorkflowScope, limit = 100): Promise<Array<{ deliveryId: string; eventId: string; cursor: { epoch: string; sequence: number } }>> { return this.call({ op: 'sync-page', scope, limit }) }
  confirmSync(scope: WorkflowScope, deliveryIds: string[]): Promise<void> { return this.call({ op: 'sync-confirm', scope, deliveryIds }) }
  getAlias(taskRef: string): Promise<TaskAliasRecord | null> { return this.call({ op: 'alias-read', taskRef }) }
  upsertAlias(taskRef: string, trellisTaskId: string | null, dir: string): Promise<TaskAliasRecord | null> { return this.call({ op: 'alias-upsert', taskRef, trellisTaskId, dir }) }
  async close(): Promise<void> {
    this.closed = true
    const worker = this.worker
    if (!worker) return
    try { await this.request({ op: 'close' }) }
    finally {
      if (this.worker === worker) { this.worker = undefined; this.opening = undefined }
      await worker.terminate()
      for (const pending of this.requests.values()) { clearTimeout(pending.timer); pending.reject(new WorkflowControlError('ACKNOWLEDGEMENT_UNKNOWN', 'Workflow control closed before acknowledgement', true)) }
      this.requests.clear(); this.pendingBytes = 0
    }
  }
}

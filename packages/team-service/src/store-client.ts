import { Worker } from 'node:worker_threads'
import { TeamServiceError } from './errors'
import type { StoreOperation, StoreOptions, StoreRequest, StoreResponse } from './store-types'

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; bytes: number; timer: ReturnType<typeof setTimeout>; expired: boolean; operation: StoreOperation }
const readOnlyOperations = new Set<StoreOperation>(['health', 'authenticate', 'people', 'teams', 'teamMembers', 'projects', 'projectMembers', 'materials', 'versions', 'document', 'feedback', 'events', 'command', 'pairing', 'pairingStatus', 'devices', 'collaborationList', 'collaborationGet', 'collaborationHistory', 'collaborationReplies', 'collaborationReports', 'collaborationReanchor', 'invitations', 'inspectInvitation', 'identity', 'hifoxSnapshot', 'hifoxHead', 'taskProgressRead', 'taskProgressReceipt', 'taskMaterialList', 'taskMaterialRead', 'taskMaterialVersions', 'taskMaterialSubmissions', 'taskMaterialReceipt', 'codeResourceList', 'taskCodeResourceRead', 'localCredential'])
for (const operation of ['contentConfigRead', 'contentCapabilities', 'contentJob', 'contentReceipt', 'contentBudget', 'contentAccounting'] as const) readOnlyOperations.add(operation)
for (const operation of ['governanceList', 'governanceRead', 'governanceReceipt', 'taskInputRead', 'taskInputCandidates', 'taskInputRevision', 'taskInputReadDocument', 'taskInputReceipt'] as const) readOnlyOperations.add(operation)
readOnlyOperations.add('taskDevelopmentContext')
for (const operation of ['taskExecutionRead', 'taskExecutionHistory', 'taskExecutionReconcile', 'taskExecutionArtifact'] as const) readOnlyOperations.add(operation)
for (const operation of ['executionInputRead', 'executionInputResource', 'executionInputReconcile'] as const) readOnlyOperations.add(operation)
for (const operation of ['importReconcile', 'importNamespaces', 'importItems', 'importRead', 'importBatch'] as const) readOnlyOperations.add(operation)
export class TeamStore {
  private readonly worker: Worker
  private readonly pending = new Map<number, Pending>()
  private nextId = 0
  private pendingBytes = 0
  private failed = false
  private readonly exited: Promise<void>
  private closing = false
  private closePromise: Promise<void> | null = null
  private constructor(options: StoreOptions) {
    this.worker = new Worker(new URL('./store-worker.mjs', import.meta.url), { workerData: options })
    this.exited = new Promise((resolve) => { this.worker.once('exit', () => { this.failed = true; this.rejectAll(); resolve() }) })
    this.worker.on('message', (message: StoreResponse) => {
      if (message.id === 0 && !message.ok) {
        this.failed = true
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); if (!pending.expired) pending.reject(new TeamServiceError(message.error.code, message.error.message, message.error.statusCode)) }
        this.pending.clear(); this.pendingBytes = 0
        return
      }
      const request = this.pending.get(message.id)
      if (!request) return
      clearTimeout(request.timer); this.pending.delete(message.id); this.pendingBytes -= request.bytes
      if (request.expired) return
      if (message.ok) request.resolve(message.value)
      else request.reject(new TeamServiceError(message.error.code, message.error.message, message.error.statusCode))
    })
    this.worker.on('error', () => { this.failed = true; this.rejectAll() })
  }
  static async open(options: StoreOptions): Promise<TeamStore> {
    const store = new TeamStore(options)
    try { await store.call('health', {}); return store }
    catch (error) { await store.worker.terminate(); throw error }
  }
  private rejectAll(): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      if (!request.expired) request.reject(readOnlyOperations.has(request.operation)
        ? new TeamServiceError('STORE_UNAVAILABLE', 'Team writer exited; storage is unavailable', 503)
        : new TeamServiceError('ACKNOWLEDGEMENT_UNKNOWN', 'Team writer exited without an acknowledgement; inspect/retry the same command identity', 503))
    }
    this.pending.clear(); this.pendingBytes = 0
  }
  async call<T = unknown>(operation: StoreOperation, input: unknown): Promise<T> {
    if (this.failed || (this.closing && operation !== 'close')) throw new TeamServiceError('STORE_UNAVAILABLE', 'Team writer is unavailable', 503)
    const bytes = Buffer.byteLength(JSON.stringify({ operation, input }))
    if (bytes > 2 * 1024 * 1024 || this.pending.size >= 64 || this.pendingBytes + bytes > 8 * 1024 * 1024) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Team writer queue is full; retain the same command identity', 503)
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending) return
        pending.expired = true
        // Keep the queue budget until actual reply/exit. Timeout does not cancel a write.
        reject(new TeamServiceError('ACKNOWLEDGEMENT_UNKNOWN', 'Team writer response timed out; inspect/retry the same command identity', 503))
      }, operation === 'backup' ? 60_000 : 10_000)
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer, bytes, expired: false, operation }); this.pendingBytes += bytes
      try { this.worker.postMessage({ id, operation, input } satisfies StoreRequest) }
      catch { const pending = this.pending.get(id); if (pending) { clearTimeout(timer); this.pending.delete(id); this.pendingBytes -= bytes }; reject(new TeamServiceError('INVALID_INPUT', 'Writer request could not be serialized')) }
    })
  }
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    const attempt = (async () => { if (!this.failed) await this.call('close', {}); await this.exited })()
    this.closePromise = attempt
    // A rejected admission must not reopen the store or permanently poison cleanup retries.
    void attempt.catch(() => { if (this.closePromise === attempt) this.closePromise = null })
    return attempt
  }
  async backup(destination: string): Promise<{ destination: string; blobCount: number; instanceId: string; epoch: string }> { return this.call('backup', { destination }) }
}

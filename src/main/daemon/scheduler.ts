import type { WorkspaceGrant } from '../../shared/daemon'
import { DAEMON_LIMITS } from '../../shared/daemon'
import type { IntegrationSource, IntegrationWorkInput } from '../../shared/integration-work'
import type { IntegrationRegistry } from '../services/integrations/registry'
import type { IntegrationAdmissionPort, IntegrationWorkPort } from '../services/integrations/work-ports'
import type { ResolvedConnection } from '../services/integrations/types'
import { DaemonRepository } from './repository'
import { DaemonError } from './errors'

/** One scheduler, existing provider registry, persisted dispatch before any adapter call. */
export class IntegrationScheduler {
  private readonly running = new Map<string, AbortController>()
  private closed = false
  constructor(private readonly repository: DaemonRepository, private readonly registry: IntegrationRegistry, private readonly admission?: IntegrationAdmissionPort) {}
  async authorize(grant: WorkspaceGrant, source: IntegrationSource, input: IntegrationWorkInput): Promise<void> {
    if (this.closed) throw new DaemonError('E_UNAVAILABLE', 'Daemon admission is closed.')
    const work = this.registry.catalog().find((item) => item.id === source.providerId) ? this.registry.get(source.providerId).work : undefined
    if (!work?.supports(input.kind) || !this.admission) throw new DaemonError('E_UNAVAILABLE', 'This provider work adapter and connection authority are not installed. Configure the provider after the lifecycle migration.')
    this.assertConnection(await this.admission.resolve(grant, source), source)
    if (this.closed) throw new DaemonError('E_UNAVAILABLE', 'Daemon admission closed while resolving the original connection.')
  }
  private assertConnection(connection: ResolvedConnection, source: IntegrationSource): void {
    if (!connection.public.enabled || connection.public.id !== source.connectionId || connection.public.revision !== source.connectionRevision || connection.public.providerId !== source.providerId || connection.instanceId !== source.instanceId) throw new DaemonError('E_CONFLICT', 'The provider returned a different connection/instance revision from the original admission.')
  }
  async tick(): Promise<void> {
    if (this.closed || !this.admission) return
    for (const original of this.repository.allJobs().filter((job) => job.state === 'queued')) {
      if (this.repository.allJobs().some((job) => job.state === 'unknown' && (job.workspaceId === original.workspaceId || job.source.connectionId === original.source.connectionId && job.source.instanceId === original.source.instanceId))) continue
      if (this.running.size >= DAEMON_LIMITS.providerConcurrency) return
      if (this.running.has(original.id)) continue
      const workspace = this.repository.admission(original.id)
      if (!workspace || JSON.stringify(this.repository.grant(original.workspaceId)) !== JSON.stringify(workspace)) continue
      let work: IntegrationWorkPort | undefined
      try { work = this.registry.get(original.source.providerId).work } catch { continue }
      if (!work?.supports(original.input.kind)) continue
      const port = work
      const abort = new AbortController()
      this.running.set(original.id, abort)
      void (async () => {
        let job = original
        let dispatched = false
        try {
          const connection = await this.admission?.resolve(workspace, job.source)
          if (!connection || this.closed) return
          this.assertConnection(connection, job.source)
          // Recheck the retained workspace after the credential/revision await.
          if (JSON.stringify(this.repository.grant(job.workspaceId)) !== JSON.stringify(workspace)) return
          job = this.repository.transition(job.id, job.revision, job.ownerEpoch, 'dispatched', null)
          dispatched = true
          const result = await port.dispatch({ job, workspace, connection, signal: abort.signal,
            checkpoint: (revision, update, evidence) => this.repository.checkpoint(job.id, revision, job.ownerEpoch, update, evidence)
          })
          const latest = this.repository.job(job.id, job.workspaceId)
          if (!latest || !['dispatched', 'running', 'cancel-requested'].includes(latest.state)) return
          const settlement = latest.state === 'cancel-requested' && result.state === 'paused'
            ? result.evidenceRef ? 'cancelled' : 'unknown'
            : result.state
          this.repository.transition(job.id, latest.revision, job.ownerEpoch, settlement, result.evidenceRef, { cursor: result.cursor, counts: result.counts })
        } catch {
          if (dispatched) {
            const latest = this.repository.job(job.id, job.workspaceId)
            if (latest && ['dispatched', 'running', 'cancel-requested'].includes(latest.state)) this.repository.transition(job.id, latest.revision, job.ownerEpoch, 'unknown', null)
          }
        } finally { this.running.delete(original.id) }
      })().catch(() => { this.closed = true })
    }
  }
  cancel(id: string): void { this.running.get(id)?.abort() }
  closeAdmission(): void { this.closed = true }
  hasRunning(): boolean { return this.running.size > 0 }
  async shutdown(): Promise<void> {
    this.closeAdmission()
    for (const controller of this.running.values()) controller.abort()
    const deadline = Date.now() + 15_000
    while (this.hasRunning() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
    if (this.hasRunning()) throw new DaemonError('E_UNKNOWN', 'Provider workers have not released their original operations; daemon exit is refused.', 'unknown')
  }
}

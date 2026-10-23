import type { WorkspaceGrant } from '../../../shared/daemon'
import type { IntegrationAccount, IntegrationJob, IntegrationSource, IntegrationWorkInput, SyncPlan } from '../../../shared/integration-work'
import type { ResolvedConnection } from './types'

/** Native-only optional capabilities on the existing provider registry. No port implies support. */
export interface IntegrationAccountPort {
  list(connection: ResolvedConnection): Promise<IntegrationAccount[]>
}
export interface IntegrationSyncPort {
  validate(plan: SyncPlan, connection: ResolvedConnection): Promise<{ supported: boolean; reason: string }>
}
export interface IntegrationAdmissionPort {
  resolve(grant: WorkspaceGrant, source: IntegrationSource): Promise<ResolvedConnection>
}
export interface IntegrationWorkPort {
  supports(kind: IntegrationWorkInput['kind']): boolean
  dispatch(input: {
    job: IntegrationJob; workspace: WorkspaceGrant; connection: ResolvedConnection; signal: AbortSignal
    checkpoint(expectedRevision: number, update: Pick<IntegrationJob, 'cursor' | 'counts'>, evidenceRef: string): IntegrationJob
  }): Promise<{
    state: 'completed' | 'partially-failed' | 'paused' | 'unknown' | 'cancelled'
    evidenceRef: string | null
    cursor: string | null
    counts: IntegrationJob['counts']
  }>
  /** Reconciliation is explicit; a timeout cannot authorize another dispatch. */
  reconcile(input: { job: IntegrationJob; workspace: WorkspaceGrant; connection: ResolvedConnection }): Promise<{ resolved: boolean; evidenceRef: string | null }>
}

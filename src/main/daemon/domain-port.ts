import type { DaemonRequest, ProcessOwner } from '../../shared/daemon'
import type { NativeGuiAuthority } from './native-gui-grant'

export interface DaemonDomainPort {
  ready(): boolean
  handles(method: DaemonRequest['method']): boolean
  dispatch(request: DaemonRequest, actor: ProcessOwner, nativeGui?: NativeGuiAuthority): Promise<unknown>
  poll(): Promise<void>
  shutdown(): Promise<void>
  /** Atomically fences intake and refuses active/unknown native owners without
   * cancelling them. Only genuinely idle owners enter canonical shutdown. */
  shutdownIfIdle(): Promise<void>
  observeRuntime(listener: (event: { root: string }) => void): () => void
  blockers(): Promise<Array<{ domain: 'runtime' | 'workflow' | 'application' | 'work-copy'; state: 'active' | 'unknown'; label: string; rootId?: string; ownerGeneration?: string; acquiredAt?: number }>>
  recoverWorkcopy(input: { leaseId: string; owner: import('../../shared/workcopy-use').WorkcopyOwner; acceptedEvidence?: 'job-witness' | 'kernel-transition' | 'cleanup-receipt' }): Promise<{ released: boolean; evidence?: 'job-witness' | 'kernel-transition' | 'cleanup-receipt'; reason?: 'released' | 'already-released' | 'missing-evidence' }>
  withWorkspaceChange(grant: import('../../shared/daemon').WorkspaceGrant, change: () => unknown): Promise<unknown>
}

import type { DaemonRequest, ProcessOwner } from '../../shared/daemon'

export interface DaemonDomainPort {
  ready(): boolean
  handles(method: DaemonRequest['method']): boolean
  dispatch(request: DaemonRequest, actor: ProcessOwner): Promise<unknown>
  poll(): Promise<void>
  shutdown(): Promise<void>
  /** Atomically fences intake and refuses active/unknown native owners without
   * cancelling them. Only genuinely idle owners enter canonical shutdown. */
  shutdownIfIdle(): Promise<void>
  observeRuntime(listener: (event: { root: string }) => void): () => void
  withWorkspaceChange(grant: import('../../shared/daemon').WorkspaceGrant, change: () => unknown): Promise<unknown>
}

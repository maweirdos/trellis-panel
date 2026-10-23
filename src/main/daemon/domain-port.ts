import type { DaemonRequest, ProcessOwner } from '../../shared/daemon'

export interface DaemonDomainPort {
  ready(): boolean
  handles(method: DaemonRequest['method']): boolean
  dispatch(request: DaemonRequest, actor: ProcessOwner): Promise<unknown>
  poll(): Promise<void>
  shutdown(): Promise<void>
  observeRuntime(listener: (event: { root: string }) => void): () => void
  withWorkspaceChange(grant: import('../../shared/daemon').WorkspaceGrant, change: () => unknown): Promise<unknown>
}

import type { ProjectSnapshot } from '../../../shared/types'

/** Native composition only; the implementation must resolve an already authorized scope. */
export interface IntegrationWorkspaceHost {
  root(): string | null
  snapshot(): ProjectSnapshot | null
}

const unavailable: IntegrationWorkspaceHost = { root: () => null, snapshot: () => null }
let workspaceHost: IntegrationWorkspaceHost = unavailable

/** One host per process. Daemon composition may resolve an authenticated async request scope. */
export function installIntegrationWorkspaceHost(host: IntegrationWorkspaceHost): () => void {
  if (workspaceHost !== unavailable && workspaceHost !== host) throw new Error('Integration workspace host is already installed')
  workspaceHost = host
  return () => { if (workspaceHost === host) workspaceHost = unavailable }
}
export function integrationWorkspaceRoot(): string | null { return workspaceHost.root() }
export function integrationWorkspaceSnapshot(): ProjectSnapshot | null { return workspaceHost.snapshot() }

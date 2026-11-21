import type { ComponentType } from 'react'
import type { IntegrationDirectoryEntry, IntegrationDirectoryId } from '../../../../../shared/integration-directory'
import type { IntegrationBinding, IntegrationConnection, ProviderManifest } from '../../../../../shared/integrations'

/** Explicit captured UI context. Provider code must still use native revision/owner checks. */
export interface ProviderWorkspaceProps {
  entry: IntegrationDirectoryEntry
  provider: ProviderManifest
  root: string | null
  connections: readonly IntegrationConnection[]
  connection: IntegrationConnection | undefined
  bindings: readonly IntegrationBinding[]
  nativeAvailable: boolean
  authorizationAvailable: boolean
  refresh: () => Promise<void>
  navigate: (entry: IntegrationDirectoryId) => void
  onConnect: () => void
  onEditConnection: () => void
  /** Selects an existing connection of this provider under the captured UI owner. */
  onSelectConnection?: (id: string) => void
  /** Opens an explicit editor for the captured selected connection; never retargets a binding. */
  onBindProject: (binding?: IntegrationBinding) => void
  /** Provider-owned setup replaces overview chrome without replacing its mounted workspace. */
  onFlowChange?: (active: boolean) => void
}
export interface ProviderWorkspaceExtension {
  /** Provider-owned organization/application setup may replace the shared instance card. */
  connectionMode?: 'shared' | 'provider'
  /** Organization/application setup, when separate from compatibility credentials. */
  BeforeConnection?: ComponentType<ProviderWorkspaceProps>
  /** Account, sync, import and assistant sections, including honest unbound states. */
  Content?: ComponentType<ProviderWorkspaceProps>
}
export type ProviderWorkspaceExtensions = Partial<Record<IntegrationDirectoryId, ProviderWorkspaceExtension>>

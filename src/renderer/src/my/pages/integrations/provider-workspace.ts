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
}
export interface ProviderWorkspaceExtension {
  /** Organization/application setup, when separate from compatibility credentials. */
  BeforeConnection?: ComponentType<ProviderWorkspaceProps>
  /** Account, sync, import, assistant sections after the preserved connection panel. */
  Content: ComponentType<ProviderWorkspaceProps>
}
export type ProviderWorkspaceExtensions = Partial<Record<IntegrationDirectoryId, ProviderWorkspaceExtension>>

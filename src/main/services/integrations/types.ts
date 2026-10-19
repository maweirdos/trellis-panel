import type { IntegrationConnection, PageResult, RemoteRepository, ExternalObject, ProviderManifest, JiraSearchData } from '../../../shared/integrations'
import type { JiraTransition } from '../../../shared/types'

export interface ResolvedConnection {
  public: IntegrationConnection
  secrets: Record<string, string>
  instanceId: string
}
export interface RepositoryPort {
  inspect(connection: ResolvedConnection): Promise<string>
  repositories(connection: ResolvedConnection, page: number, query: string): Promise<PageResult<RemoteRepository>>
  pullRequests(connection: ResolvedConnection, repository: string, page: number): Promise<PageResult<ExternalObject>>
}
/** Authorization credentials are main-only and may never be returned through IPC. */
export interface AuthorizationPort {
  authorize(connection: ResolvedConnection, signal: AbortSignal): Promise<{ secrets: Record<string, string>; detail: string }>
}
export interface NotificationPort {
  send(connection: ResolvedConnection, title: string, body: string): Promise<void>
}
/** First task-source DTOs retain the existing Jira page/import compatibility shape. */
export interface TaskSourcePort {
  search(connection: ResolvedConnection, query: string, signal?: AbortSignal): Promise<JiraSearchData>
  transitions(connection: ResolvedConnection, key: string): Promise<JiraTransition[]>
  transition(connection: ResolvedConnection, key: string, id: string, expectedStatus: string): Promise<{ detail: string }>
  comment(connection: ResolvedConnection, key: string, body: string): Promise<null>
}
export interface IntegrationProvider {
  manifest: ProviderManifest
  repository?: RepositoryPort
  notification?: NotificationPort
  tasks?: TaskSourcePort
  authorization?: AuthorizationPort
  validate?: (connection: ResolvedConnection) => void
  inspect?: (connection: ResolvedConnection) => Promise<string>
}
export class IntegrationError extends Error {
  constructor(message: string, readonly kind: 'invalid' | 'conflict' | 'denied' | 'upstream' | 'io' | 'uncertain' = 'invalid') { super(message) }
}

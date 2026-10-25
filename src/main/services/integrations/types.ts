import type { IntegrationConnection, PageResult, RemoteRepository, ExternalObject, ProviderManifest, JiraSearchData } from '../../../shared/integrations'
import type { JiraTransition } from '../../../shared/types'
import type { KnowledgeCollection } from '../../../shared/knowledge-access'
import { z } from 'zod'
import { verifiedGitlabIdentitySchema } from '../../../shared/integration-native'
export { verifiedGitlabIdentitySchema } from '../../../shared/integration-native'

/** Supplied by the protected team /api/identity response, never renderer config. */
export type VerifiedGitlabIdentity = z.infer<typeof verifiedGitlabIdentitySchema>
export const teamGitlabBindingSchema = verifiedGitlabIdentitySchema.omit({ username: true, provider: true }).extend({
  ownerKey: z.string().regex(/^[a-f0-9]{64}$/), authorizationAttempted: z.boolean().default(false)
})
export type TeamGitlabBinding = z.infer<typeof teamGitlabBindingSchema>

export interface KnowledgeRemoteHit { documentId: string; collectionId: string; title: string; text: string; truncated: boolean }
export interface KnowledgePort {
  collections(connection: ResolvedConnection, signal?: AbortSignal): Promise<{ items: KnowledgeCollection[]; hasMore: boolean }>
  documents(connection: ResolvedConnection, collectionId: string, page: number, signal?: AbortSignal): Promise<{ items: { id: string; title: string; fileType: string; parseStatus: string }[]; page: number; hasMore: boolean }>
  search(connection: ResolvedConnection, collectionIds: string[], query: string, limit: number, signal?: AbortSignal): Promise<{ items: KnowledgeRemoteHit[]; partial: boolean }>
  read(connection: ResolvedConnection, documentId: string, collectionId: string, signal?: AbortSignal): Promise<{ title: string; text: string; mode: 'full' | 'unsupported'; truncated: boolean }>
  publish(connection: ResolvedConnection, collectionId: string, input: { title: string; content: string }, signal?: AbortSignal): Promise<{ documentId: string }>
}

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
  accounts?: import('./work-ports').IntegrationAccountPort
  sync?: import('./work-ports').IntegrationSyncPort
  work?: import('./work-ports').IntegrationWorkPort
  repository?: RepositoryPort
  notification?: NotificationPort
  tasks?: TaskSourcePort
  knowledge?: KnowledgePort
  authorization?: AuthorizationPort
  validate?: (connection: ResolvedConnection) => void
  inspect?: (connection: ResolvedConnection) => Promise<string>
}
export class IntegrationError extends Error {
  constructor(message: string, readonly kind: 'invalid' | 'conflict' | 'denied' | 'upstream' | 'io' | 'uncertain' = 'invalid') { super(message) }
}

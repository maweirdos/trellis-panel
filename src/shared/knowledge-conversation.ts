import type { KnowledgeArtifact, KnowledgePublication, KnowledgeStatus } from './knowledge-access'

/** Facts emitted by an owned host operation, never inferred from model prose. */
export interface KnowledgeOperation {
  operationId: string
  kind: 'context' | 'search' | 'read' | 'save_document' | 'publish_document' | 'handoff'
  phase: 'running' | 'completed' | 'failed' | 'needs_clarification' | 'uncertain' | 'cancelled'
  detail: string
  query?: string
  status?: KnowledgeStatus
  persistence?: 'durable' | 'degraded'
  sourceIds?: string[]
  artifactId?: string
  artifactRevision?: string
  relativePath?: string
  publicationId?: string
  taskDir?: string
  code?: string
}

export type KnowledgeConversationInput =
  | { kind: 'context' }
  | { kind: 'read_document'; artifactId: string; revision?: string }
  | { kind: 'read_task'; taskDir: string }
  | { kind: 'save_document'; title: string; body: string; artifactId?: string; expectedRevision?: string; sourceIds?: string[] }
  | { kind: 'publish_document'; artifactId: string; revision: string; collectionId?: string }
  | { kind: 'handoff'; artifactId: string; revision: string; developerBody: string; taskDir?: string; expectedPrdRevision?: string | null; createTask?: boolean; title?: string }

export interface KnowledgeConversationContext {
  collections: { id: string; name: string }[]
  remoteStatus: string
  artifacts: { id: string; revision: string; title: string; relativePath: string; current: boolean; sessionId: string }[]
  tasks: { taskDir: string; title: string; status: string; prdRevision: string | null }[]
  boundTaskDir: string | null
  truncated: boolean
}

export interface KnowledgeConversationResult {
  operationId: string
  status: 'completed' | 'needs_clarification' | 'uncertain' | 'cancelled' | 'failed'
  detail: string
  context?: KnowledgeConversationContext
  artifact?: KnowledgeArtifact
  document?: { body: string; revision: string | null; relativePath: string; externallyChanged: boolean }
  taskPrd?: { taskDir: string; body: string; revision: string | null }
  publication?: KnowledgePublication
  handoff?: { taskDir: string; prdRevision: string; productPath: string; productRevision: string; createdTask: boolean; status: 'planning' | 'existing'; codingStarted: false }
  clarification?: { field: 'collectionId' | 'taskDir' | 'artifactId'; choices: { id: string; label: string }[] }
}

import type { KnowledgeScope } from '../../../shared/knowledge-access'

/** Constructed by the host, never from model tool arguments. */
export interface KnowledgeOwner {
  root: string; projectGeneration: number; sessionId: string; turnId: string
  connectionGeneration?: string; taskDir?: string; originalUserText?: string
  isCurrent?: () => boolean
}
export interface KnowledgeSearchInput { requestId: string; query: string; limit?: number }
export interface KnowledgeReadInput { requestId: string; sourceHandle: string }
export type CapturedKnowledgeScope = KnowledgeScope

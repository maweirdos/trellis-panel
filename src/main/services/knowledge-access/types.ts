import type { KnowledgeScope } from '../../../shared/knowledge-access'
import { IntegrationError } from '../integrations/types'

/** Fixed host-authored guidance, safe to expose separately from upstream errors. */
export class KnowledgeReadVersionError extends IntegrationError {
  constructor() { super('文档在分页读取期间已改变；请丢弃先前正文页，细化查询重新检索后从第一页读取，不能合并不同版本', 'conflict') }
}

/** Constructed by the host, never from model tool arguments. */
export interface KnowledgeOwner {
  root: string; projectGeneration: number; sessionId: string; turnId: string
  connectionGeneration?: string; taskDir?: string; originalUserText?: string
  isCurrent?: () => boolean
}
export interface KnowledgeSearchInput { requestId: string; query: string; limit?: number }
export interface KnowledgeReadInput { requestId: string; sourceHandle: string; offset?: number; limit?: number }
export type CapturedKnowledgeScope = KnowledgeScope

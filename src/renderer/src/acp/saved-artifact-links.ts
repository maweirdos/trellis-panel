import type { AcpSessionRecord, TimelineEvent } from '../../../shared/types'
import { localDocumentLink } from '../../../shared/local-document-link'
import { sameRelativeDocumentPath } from '../reader/reader-paths'
import { projectRootKey } from '../my/navigation'
import { readKnowledgeOperation } from './knowledge-operations'

export interface SavedArtifactLink { artifactId: string; revision: string; relativePath: string }

/** Exact prior saved receipts, never document names or model claims, establish identity. */
export function savedArtifactForMessage(href: string, messageId: string, events: readonly TimelineEvent[], session: AcpSessionRecord): SavedArtifactLink | 'ambiguous' | null {
  const link = localDocumentLink(href)
  if (!link) return null
  // A complete project-relative target is exact evidence; a basename is not.
  if (!link.absolute && (!link.path.includes('/') || link.path.split('/').some(part => !part || part === '.' || part === '..'))) return null
  const position = events.findIndex(event => event.id === messageId)
  const message = events[position]
  if (!message || message.source !== 'acp' || message.kind !== 'message' || message.payload?.role === 'user' || !message.turnId || !message.connectionGeneration || message.sessionId !== session.sessionId || projectRootKey(message.projectRoot) !== projectRootKey(session.projectRoot)) return null
  const matches = new Map<string, SavedArtifactLink>()
  for (const event of events.slice(0, position)) {
    if (event.sessionId !== message.sessionId || event.turnId !== message.turnId || event.connectionGeneration !== message.connectionGeneration || projectRootKey(event.projectRoot) !== projectRootKey(message.projectRoot)) continue
    const receipt = readKnowledgeOperation(event)
    if (receipt?.kind !== 'save_document' || receipt.phase !== 'completed' || !receipt.artifactId || !receipt.artifactRevision || !receipt.relativePath) continue
    const relativePath = receipt.relativePath.replace(/\\/g, '/')
    if (relativePath.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) continue
    const fullPath = `${message.projectRoot.replace(/[\\/]+$/, '')}/${relativePath}`
    if (!sameRelativeDocumentPath(message.projectRoot, link.path, link.absolute ? fullPath : relativePath)) continue
    matches.set(JSON.stringify([receipt.artifactId, receipt.artifactRevision]), { artifactId: receipt.artifactId, revision: receipt.artifactRevision, relativePath })
  }
  return matches.size === 1 ? [...matches.values()][0] ?? null : matches.size > 1 ? 'ambiguous' : null
}

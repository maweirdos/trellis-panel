import type { AcpMaterialChange, AcpSourceReference, FileEntry, TimelineEvent } from '../../../shared/types'
import { projectRootKey } from '../my/navigation'
import { relativePathUnderRoot } from '../reader/reader-paths'
import { computeHeadingAnchors } from '../reader/heading-anchors'

export interface ConversationArtifact {
  projectRoot: string
  taskDir: string
  relativePath: string
  label: string
  source: 'task-inventory' | 'filesystem-event'
  availability: 'present' | 'readable' | 'missing' | 'unreadable'
  observedAt?: number
  observedRevision?: string
  change?: 'add' | 'change' | 'unlink'
}

/** Accept known task-relative files only. No traversal/absolute-path legacy fallback. */
export function isTaskMaterialPath(taskDir: string, relativePath: string): boolean {
  const path = relativePath.replace(/\\/g, '/')
  if (!taskDir || taskDir.includes('/') || taskDir.includes('\\') || taskDir === '..') return false
  if (path.split('/').some((part) => !part || part === '.' || part === '..') || path.includes(':')) return false
  const active = `.trellis/tasks/${taskDir}/`
  const archived = /^\.trellis\/tasks\/archive\/[^/]+\/([^/]+)\//.exec(path)
  return path.startsWith(active) || archived?.[1] === taskDir
}

export function projectConversationArtifacts({ projectRoot, taskDir, artifacts, changes = [], events = [] }: {
  projectRoot: string
  taskDir: string
  artifacts: readonly FileEntry[]
  changes?: readonly AcpMaterialChange[]
  events?: readonly TimelineEvent[]
}): ConversationArtifact[] {
  const entries = new Map<string, ConversationArtifact>()
  for (const file of artifacts) {
    if (file.kind !== 'file') continue
    const path = relativePathUnderRoot(projectRoot, file.path)
    if (path === null || !isTaskMaterialPath(taskDir, path)) continue
    entries.set(path, { projectRoot, taskDir, relativePath: path, label: file.name, source: 'task-inventory', availability: 'present', observedAt: file.mtime })
  }
  const typed = events.flatMap((event): AcpMaterialChange[] => {
    if (event.source !== 'trellis' || event.kind !== 'material-change' ||
      projectRootKey(event.projectRoot) !== projectRootKey(projectRoot) || event.taskDir !== taskDir) return []
    const change = event.payload?.materialChange
    if (!change || typeof change !== 'object') return []
    // Timeline payloads are untyped/legacy. Validate before treating them as file facts.
    const value = change as Partial<AcpMaterialChange>
    return typeof value.projectRoot === 'string' && typeof value.taskDir === 'string' && typeof value.relativePath === 'string' &&
      typeof value.projectGeneration === 'number' && typeof value.observedAt === 'number' && value.source === 'filesystem-event' &&
      (value.kind === 'add' || value.kind === 'change' || value.kind === 'unlink') &&
      (value.availability === 'readable' || value.availability === 'missing' || value.availability === 'unreadable') &&
      (value.revision === null || typeof value.revision === 'string') ? [value as AcpMaterialChange] : []
  })
  for (const change of [...typed, ...changes].sort((a, b) => a.observedAt - b.observedAt)) {
    if (projectRootKey(change.projectRoot) !== projectRootKey(projectRoot) || change.taskDir !== taskDir || !isTaskMaterialPath(taskDir, change.relativePath)) continue
    const path = change.relativePath.replace(/\\/g, '/')
    const previous = entries.get(path)
    if (previous?.observedAt !== undefined && previous.observedAt > change.observedAt) continue
    entries.set(path, {
      projectRoot, taskDir, relativePath: path, label: path.split('/').pop() ?? path,
      source: 'filesystem-event', availability: change.availability, change: change.kind,
      observedAt: change.observedAt, ...(change.revision === null ? {} : { observedRevision: change.revision })
    })
  }
  const priority = (artifact: ConversationArtifact): number => ({ 'prd.md': 0, 'design.md': 1, 'implement.md': 2 })[artifact.label.toLowerCase()] ?? 3
  return [...entries.values()].sort((a, b) => priority(a) - priority(b) || a.relativePath.localeCompare(b.relativePath)).slice(0, 80)
}

/** Capture bytes displayed now, never the pending candidate or a filename-derived version. */
export function captureDocumentReference(input: {
  projectRoot: string; taskDir: string; relativePath: string; sessionId: string; connectionGeneration?: string
  displayed: { revision: string; text: string } | null
  quote?: string; sectionAnchor?: string
}): AcpSourceReference | null {
  if (input.displayed === null || !isTaskMaterialPath(input.taskDir, input.relativePath)) return null
  const quote = input.quote?.trim().slice(0, 4000)
  // A quotation must actually occur in these displayed bytes.
  if (quote && !input.displayed.text.includes(quote)) return null
  if (input.sectionAnchor && !computeHeadingAnchors(input.displayed.text).some((heading) => heading.id === input.sectionAnchor)) return null
  return {
    projectRoot: input.projectRoot, taskDir: input.taskDir, relativePath: input.relativePath,
    displayedRevision: input.displayed.revision, targetSessionId: input.sessionId,
    ...(input.connectionGeneration ? { targetConnectionGeneration: input.connectionGeneration } : {}),
    ...(quote ? { quote } : {}), ...(input.sectionAnchor ? { sectionAnchor: input.sectionAnchor } : {})
  }
}

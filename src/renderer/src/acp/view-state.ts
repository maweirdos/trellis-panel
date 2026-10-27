import { projectRootKey } from '../my/navigation'
import type { AcpSourceReference } from '../../../shared/types'

export type DraftIntent = 'plain' | 'feedback' | 'planning' | 'implementation'
export interface SessionView { draft: string; scrollTop: number; follow: boolean; updatedAt: number; sourceReferences?: AcpSourceReference[]; intent?: DraftIntent; draftBackup?: string; backupReferences?: AcpSourceReference[]; backupIntent?: DraftIntent }
export type WorkspaceView = 'agents' | 'conversation' | 'history'
interface ProjectView { activeId: string | null; view?: WorkspaceView; sessions: Record<string, SessionView> }
const cached = new Map<string, ProjectView>()
const forgotten = new Map<string, Set<string>>()
const EMPTY_VIEW: SessionView = { draft: '', scrollTop: 0, follow: true, updatedAt: 0 }
const storageKey = (root: string): string => `tpanel.acp.view.${encodeURIComponent(projectRootKey(root) ?? '')}`
function restoreReferences(value: unknown): AcpSourceReference[] {
  return Array.isArray(value) ? value.filter((reference: unknown): reference is AcpSourceReference => {
    if (!reference || typeof reference !== 'object') return false
    const source = reference as Partial<AcpSourceReference>
    return typeof source.projectRoot === 'string' && typeof source.taskDir === 'string' && typeof source.relativePath === 'string' && typeof source.displayedRevision === 'string' && typeof source.targetSessionId === 'string'
  }).slice(0, 12) : []
}

function projectView(root: string): ProjectView {
  const key = projectRootKey(root) ?? ''
  const memory = cached.get(key)
  if (memory) return memory
  const view: ProjectView = { activeId: null, sessions: {} }
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey(root)) ?? 'null')
    if (stored && typeof stored === 'object' && 'activeId' in stored && typeof stored.activeId === 'string') view.activeId = stored.activeId
    if (stored && typeof stored === 'object' && 'view' in stored && (stored.view === 'agents' || stored.view === 'conversation' || stored.view === 'history')) view.view = stored.view
    if (stored && typeof stored === 'object' && 'sessions' in stored && Array.isArray(stored.sessions)) {
      for (const row of stored.sessions.slice(0, 30)) {
        if (!row || typeof row !== 'object' || typeof row.id !== 'string') continue
        view.sessions[row.id] = {
          // Match the facade's accepted prompt size; restoring preferences must
          // not silently cut a previously accepted draft down to 20k characters.
          draft: typeof row.draft === 'string' ? row.draft.slice(0, 200000) : '',
          scrollTop: typeof row.scrollTop === 'number' && Number.isFinite(row.scrollTop) ? Math.max(0, row.scrollTop) : 0,
          follow: row.follow !== false,
          updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
          sourceReferences: restoreReferences(row.sourceReferences),
          intent: row.intent === 'feedback' || row.intent === 'planning' || row.intent === 'implementation' ? row.intent : 'plain',
          draftBackup: typeof row.draftBackup === 'string' ? row.draftBackup.slice(0, 200000) : undefined,
          backupReferences: restoreReferences(row.backupReferences),
          backupIntent: row.backupIntent === 'feedback' || row.backupIntent === 'planning' || row.backupIntent === 'implementation' ? row.backupIntent : 'plain'
        }
      }
    }
  } catch { /* Corrupt/unavailable UI preferences fall back to memory; transcripts are unaffected. */ }
  cached.set(key, view)
  return view
}

function persist(root: string, view: ProjectView): void {
  const entries = Object.entries(view.sessions).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 30)
  try { localStorage.setItem(storageKey(root), JSON.stringify({ activeId: view.activeId, view: view.view, sessions: entries.map(([id, state]) => ({ id, ...state })) })) }
  catch { /* Storage quota/private mode: keep this session's UI state in memory. */ }
}

export function readSessionView(root: string, sessionId: string): SessionView {
  return projectView(root).sessions[sessionId] ?? { ...EMPTY_VIEW }
}

export function writeSessionView(root: string, sessionId: string, patch: Partial<SessionView>): void {
  if (forgotten.get(projectRootKey(root) ?? '')?.has(sessionId)) return
  const view = projectView(root)
  view.sessions[sessionId] = { ...readSessionView(root, sessionId), ...patch, updatedAt: Date.now() }
  persist(root, view)
}

export function readActiveSession(root: string): string | null { return projectView(root).activeId }
export function writeActiveSession(root: string, sessionId: string | null): void {
  if (sessionId && forgotten.get(projectRootKey(root) ?? '')?.has(sessionId)) return
  const view = projectView(root)
  view.activeId = sessionId
  persist(root, view)
}

/** A confirmed deletion also removes drafts and fences late source-owned writes. */
export function forgetSessionView(root: string, sessionId: string): void {
  const key = projectRootKey(root) ?? ''
  const ids = forgotten.get(key) ?? new Set<string>()
  ids.add(sessionId); forgotten.set(key, ids)
  const view = projectView(root)
  delete view.sessions[sessionId]
  if (view.activeId === sessionId) view.activeId = null
  persist(root, view)
}

export function readWorkspaceView(root: string): WorkspaceView | undefined {
  const view = projectView(root)
  if (view.view === 'history') { view.view = 'conversation'; persist(root, view) }
  return view.view
}
export function writeWorkspaceView(root: string, value: WorkspaceView): void {
  const view = projectView(root)
  view.view = value
  persist(root, view)
}

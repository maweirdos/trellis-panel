import { projectRootKey } from '../my/navigation'

interface SessionView { draft: string; scrollTop: number; follow: boolean; updatedAt: number }
interface ProjectView { activeId: string | null; sessions: Record<string, SessionView> }
const cached = new Map<string, ProjectView>()
const EMPTY_VIEW: SessionView = { draft: '', scrollTop: 0, follow: true, updatedAt: 0 }
const storageKey = (root: string): string => `tpanel.acp.view.${encodeURIComponent(projectRootKey(root) ?? '')}`

function projectView(root: string): ProjectView {
  const key = projectRootKey(root) ?? ''
  const memory = cached.get(key)
  if (memory) return memory
  const view: ProjectView = { activeId: null, sessions: {} }
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey(root)) ?? 'null')
    if (stored && typeof stored === 'object' && 'activeId' in stored && typeof stored.activeId === 'string') view.activeId = stored.activeId
    if (stored && typeof stored === 'object' && 'sessions' in stored && Array.isArray(stored.sessions)) {
      for (const row of stored.sessions.slice(0, 30)) {
        if (!row || typeof row !== 'object' || typeof row.id !== 'string') continue
        view.sessions[row.id] = {
          // Match the facade's accepted prompt size; restoring preferences must
          // not silently cut a previously accepted draft down to 20k characters.
          draft: typeof row.draft === 'string' ? row.draft.slice(0, 200000) : '',
          scrollTop: typeof row.scrollTop === 'number' && Number.isFinite(row.scrollTop) ? Math.max(0, row.scrollTop) : 0,
          follow: row.follow !== false,
          updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0
        }
      }
    }
  } catch { /* Corrupt/unavailable UI preferences fall back to memory; transcripts are unaffected. */ }
  cached.set(key, view)
  return view
}

function persist(root: string, view: ProjectView): void {
  const entries = Object.entries(view.sessions).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 30)
  view.sessions = Object.fromEntries(entries)
  try { localStorage.setItem(storageKey(root), JSON.stringify({ activeId: view.activeId, sessions: entries.map(([id, state]) => ({ id, ...state })) })) }
  catch { /* Storage quota/private mode: keep this session's UI state in memory. */ }
}

export function readSessionView(root: string, sessionId: string): SessionView {
  return projectView(root).sessions[sessionId] ?? { ...EMPTY_VIEW }
}

export function writeSessionView(root: string, sessionId: string, patch: Partial<SessionView>): void {
  const view = projectView(root)
  view.sessions[sessionId] = { ...readSessionView(root, sessionId), ...patch, updatedAt: Date.now() }
  persist(root, view)
}

export function readActiveSession(root: string): string | null { return projectView(root).activeId }
export function writeActiveSession(root: string, sessionId: string | null): void {
  const view = projectView(root)
  view.activeId = sessionId
  persist(root, view)
}

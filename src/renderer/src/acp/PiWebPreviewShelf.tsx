import { useCallback, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Globe } from 'lucide-react'
import { readPiWebPreviewArtifact, type PiWebPreviewArtifact } from '../../../shared/pi-web-preview'
import type { AcpSessionRecord, TimelineEvent } from '../../../shared/types'
import { ActivityResult } from '../my/ActivityResult'
import { Button } from '../my/ui'
import { projectRootKey } from '../my/navigation'
import { useApp } from '../store'
import { useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'
import type { CodePreviewLanguage, OpenCodePreview } from '../components/CodePreviewContext'
import { PREVIEW_LIMITS } from '../creations/preview-bridge'
import { asObject } from './timeline'

export interface PiWebPreviewSelection { artifact: PiWebPreviewArtifact; eventId: string; key: string }
export interface CodePreviewSnippet { source: string; language: CodePreviewLanguage; key: string; error?: string }
export type ConversationPreviewTab =
  | { id: string; kind: 'file'; title: string; selection: PiWebPreviewSelection }
  | { id: string; kind: 'snippet'; title: string; snippet: CodePreviewSnippet }
interface PreviewState {
  tabs: ConversationPreviewTab[]; activeTabId: string | null; latestKey: string
  collapsed: boolean; expanded: boolean; notice: string
}

// Main currently permits four leases per window. Never evict a reader to make room.
export const CONVERSATION_PREVIEW_TAB_LIMIT = 8
export const CONVERSATION_PREVIEW_FILE_LIMIT = 4
const emptyState = (): PreviewState => ({ tabs: [], activeTabId: null, latestKey: '', collapsed: false, expanded: false, notice: '' })
const fileTab = (selection: PiWebPreviewSelection): ConversationPreviewTab => ({
  id: JSON.stringify(['file', selection.artifact.path]), kind: 'file', title: selection.artifact.title, selection
})
function addTab(state: PreviewState, tab: ConversationPreviewTab, reveal: boolean): PreviewState {
  const exists = state.tabs.some(item => item.id === tab.id)
  const full = !exists && (state.tabs.length >= CONVERSATION_PREVIEW_TAB_LIMIT || tab.kind === 'file' && state.tabs.filter(item => item.kind === 'file').length >= CONVERSATION_PREVIEW_FILE_LIMIT)
  if (full) return { ...state, collapsed: reveal ? false : state.collapsed, notice: `最多保留 ${CONVERSATION_PREVIEW_FILE_LIMIT} 个文件预览、共 ${CONVERSATION_PREVIEW_TAB_LIMIT} 个标签页。请先关闭一个标签页，再打开此预览。` }
  return {
    ...state, tabs: exists ? state.tabs.map(item => item.id === tab.id ? tab : item) : [...state.tabs, tab],
    activeTabId: reveal || !state.activeTabId ? tab.id : state.activeTabId,
    collapsed: reveal ? false : state.collapsed, notice: ''
  }
}

export interface PiWebPreviewShelf {
  ownerKey: string; tabs: ConversationPreviewTab[]; activeTabId: string | null; collapsed: boolean; expanded: boolean; notice: string
  selection: PiWebPreviewSelection | null; snippet: CodePreviewSnippet | null
  openWebPreview: (artifact: PiWebPreviewArtifact, eventId: string) => void; openCodePreview: OpenCodePreview
  selectTab: (id: string) => void; closeTab: (id: string) => void
  setCollapsed: (collapsed: boolean) => void; closeWebPreview: () => void; setExpanded: (expanded: boolean) => void
}

export function PiWebPreviewCard({ artifact, eventId, onOpenWebPreview }: {
  artifact: PiWebPreviewArtifact; eventId: string
  onOpenWebPreview?: (artifact: PiWebPreviewArtifact, eventId: string) => void
}): JSX.Element {
  return <div className="acp-web-preview-card"><ActivityResult icon={<Globe size={18} />} title={artifact.title} description={artifact.path} action={<Button size="sm" variant="outline" disabled={!onOpenWebPreview} onClick={() => onOpenWebPreview?.(artifact, eventId)}>打开预览</Button>} /></div>
}

/** Remember selection and dismissal per source; paging old events cannot reopen it. */
export function usePiWebPreviewShelf({ root, session, events, enabled, onAutoOpen }: {
  root: string; session: AcpSessionRecord | null; events: TimelineEvent[]; enabled: boolean; onAutoOpen: () => void
}): PiWebPreviewShelf {
  const canInteract = useInteractionGuard()
  const signal = useInteractionSignal()
  const ownerKey = JSON.stringify([projectRootKey(root), session?.sessionId])
  const active = enabled && Boolean(root && session && projectRootKey(session.projectRoot) === projectRootKey(root))
  const source = useMemo(() => ({ ownerKey, enabled: active, signal, generation: session?.connectionGeneration }), [ownerKey, active, signal, session?.connectionGeneration])
  const sourceRef = useRef(source)
  sourceRef.current = source
  const [states, setStates] = useState<Record<string, PreviewState>>({})
  const snippetSerial = useRef(0)
  const statesRef = useRef(states)
  statesRef.current = states
  const previews = useMemo(() => events.flatMap(event => {
    const role = event.payload?.role
    if (!session || event.source !== 'pi' || event.kind !== 'message' || role !== undefined && role !== 'assistant' || event.sessionId !== session.sessionId || projectRootKey(event.projectRoot) !== projectRootKey(root) || projectRootKey(session.projectRoot) !== projectRootKey(root)) return []
    const artifact = readPiWebPreviewArtifact(asObject(event.payload?.meta)?.piWebPreview)
    return artifact ? [{ artifact, eventId: event.id, key: JSON.stringify([event.id, artifact.path, artifact.revision]) }] : []
  }), [events, root, session?.sessionId, session?.projectRoot])
  const latest = previews.at(-1)
  const ownsSource = (): boolean => active && sourceRef.current === source && !signal?.aborted && canInteract() && projectRootKey(useApp.getState().snapshot?.meta.root ?? '') === projectRootKey(root)
  useLayoutEffect(() => {
    if (!ownsSource() || !latest || statesRef.current[ownerKey]?.latestKey === latest.key) return
    const previous = statesRef.current[ownerKey]
    setStates(current => {
      let state = current[ownerKey] ?? emptyState()
      if (!current[ownerKey]) {
        // Seed distinct existing files; old history paging never resurrects dismissed tabs.
        const distinct = new Map<string, PiWebPreviewSelection>()
        for (const preview of previews) { distinct.delete(preview.artifact.path); distinct.set(preview.artifact.path, preview) }
        for (const preview of [...distinct.values()].slice(-CONVERSATION_PREVIEW_FILE_LIMIT)) state = addTab(state, fileTab(preview), true)
      } else state = addTab(state, fileTab(latest), !state.collapsed)
      return { ...current, [ownerKey]: { ...state, latestKey: latest.key } }
    })
    if (!previous?.collapsed) onAutoOpen()
  }, [source, latest?.key, onAutoOpen, canInteract])
  const openWebPreview = (artifact: PiWebPreviewArtifact, eventId: string): void => {
    if (!ownsSource()) return
    const selected = previews.find(preview => preview.eventId === eventId && preview.artifact.path === artifact.path && preview.artifact.revision === artifact.revision)
    if (!selected) return
    setStates(current => ({ ...current, [ownerKey]: { ...addTab(current[ownerKey] ?? emptyState(), fileTab(selected), true), latestKey: latest?.key ?? selected.key } }))
    onAutoOpen()
  }
  const openCodePreview: OpenCodePreview = (text, language) => {
    if (!ownsSource()) return
    const tooLarge = text.length > PREVIEW_LIMITS.bodyBytes || new TextEncoder().encode(text).length > PREVIEW_LIMITS.bodyBytes
    const existing = statesRef.current[ownerKey]?.tabs.find(tab => tab.kind === 'snippet' && tab.snippet.source === text && tab.snippet.language === language)
    const snippet: CodePreviewSnippet = { source: tooLarge ? '' : text, language, key: String(++snippetSerial.current), ...(tooLarge ? { error: '内容超过预览大小限制，请缩短后重试。' } : {}) }
    const tab: ConversationPreviewTab = existing ?? { id: `snippet:${snippet.key}`, kind: 'snippet', title: `${language.toUpperCase()} 片段 ${snippet.key}`, snippet }
    setStates(current => ({ ...current, [ownerKey]: { ...addTab(current[ownerKey] ?? emptyState(), tab, true), latestKey: latest?.key ?? current[ownerKey]?.latestKey ?? '' } }))
    onAutoOpen()
  }
  const setCollapsed = (collapsed: boolean): void => {
    if (!ownsSource()) return
    setStates(current => current[ownerKey] ? { ...current, [ownerKey]: { ...current[ownerKey], collapsed } } : current)
    if (!collapsed) onAutoOpen()
  }
  const closeWebPreview = (): void => setCollapsed(true)
  const selectTab = (id: string): void => {
    if (!ownsSource()) return
    setStates(current => {
      const state = current[ownerKey]
      return state?.tabs.some(tab => tab.id === id) ? { ...current, [ownerKey]: { ...state, activeTabId: id } } : current
    })
  }
  const closeTab = (id: string): void => {
    if (!ownsSource()) return
    setStates(current => {
      const state = current[ownerKey]
      const index = state?.tabs.findIndex(tab => tab.id === id) ?? -1
      if (!state || index < 0) return current
      const tabs = state.tabs.filter(tab => tab.id !== id)
      const activeTabId = state.activeTabId === id ? tabs[Math.min(index, tabs.length - 1)]?.id ?? null : state.activeTabId
      return { ...current, [ownerKey]: { ...state, tabs, activeTabId, notice: '' } }
    })
  }
  // Resize cancellation must restore the original owner, even after selection changes.
  const setExpanded = useCallback((expanded: boolean): void => {
    setStates(current => current[ownerKey] ? { ...current, [ownerKey]: { ...current[ownerKey], expanded } } : current)
  }, [ownerKey])
  const state = states[ownerKey]
  const selected = state?.tabs.find(tab => tab.id === state.activeTabId)
  return {
    ownerKey, tabs: active ? state?.tabs ?? [] : [], activeTabId: state?.activeTabId ?? null, collapsed: state?.collapsed ?? false,
    notice: state?.notice ?? '', selection: active && !state?.collapsed && selected?.kind === 'file' ? selected.selection : null,
    snippet: active && !state?.collapsed && selected?.kind === 'snippet' ? selected.snippet : null,
    expanded: state?.expanded ?? false, openWebPreview, openCodePreview, closeWebPreview, setExpanded, selectTab, closeTab, setCollapsed
  }
}

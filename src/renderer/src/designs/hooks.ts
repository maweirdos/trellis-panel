import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DesignConversationSummary, DesignDocument, DesignSummary, DesignResult } from '@shared/design-workspace'
import { DESIGN_PLACEHOLDER_DOCUMENT_ID, readDesignGenerationOutput } from '@shared/design-generation'
import { projectRootKey } from '../my/navigation'
import { conversationError, conversationValue } from '../conversations/client'
import type { TranscriptOwner } from '../acp/conversation-transcript'
import type { WorkspaceEntry } from '../conversations/workspace'
import { useInteractionActive } from '../utils/interaction-scope'
import { designClient, notifyDesignChanged, requireDesignClient } from './client'

export function useDesignLibrary(enabled: boolean) {
  const active = useInteractionActive(), serial = useRef(0), alive = useRef(false)
  const [items, setItems] = useState<DesignSummary[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const refresh = useCallback(async (): Promise<void> => {
    if (!enabled || !active || !designClient()) return
    const ticket = ++serial.current
    setBusy(true)
    try { const result = conversationValue(await requireDesignClient().list()); if (alive.current && serial.current === ticket) { setItems(result.items); setError(result.incomplete ? '部分设计暂未同步，请重新读取或打开原会话查看原因' : '') } }
    catch (cause) { if (alive.current && serial.current === ticket) { setError(conversationError(cause)) } }
    finally { if (alive.current && serial.current === ticket) setBusy(false) }
  }, [enabled, active])
  useEffect(() => {
    alive.current = true; void refresh()
    if (!enabled || !active) return () => { alive.current = false; serial.current++ }
    const changed = (): void => { if (!document.hidden) void refresh() }
    window.addEventListener('trellis-design-changed', changed); document.addEventListener('visibilitychange', changed)
    const timer = setInterval(changed, 10_000)
    return () => { alive.current = false; serial.current++; clearInterval(timer); window.removeEventListener('trellis-design-changed', changed); document.removeEventListener('visibilitychange', changed) }
  }, [refresh, enabled, active])
  return { items: enabled ? items : [], busy: enabled && busy, error: enabled ? error : '', refresh }
}

export function useDesignDocument(documentId: string) {
  const active = useInteractionActive(), serial = useRef(0), alive = useRef(false)
  const [document, setDocument] = useState<DesignDocument | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(true)
  const refresh = useCallback(async (): Promise<DesignDocument | null> => {
    const ticket = ++serial.current
    setBusy(true)
    try { const result = conversationValue(await requireDesignClient().get({ documentId })); if (alive.current && serial.current === ticket) { setDocument(result); setError('') }; return result }
    catch (cause) { if (alive.current && serial.current === ticket) { setError(conversationError(cause)); setDocument(null) }; return null }
    finally { if (alive.current && serial.current === ticket) setBusy(false) }
  }, [documentId])
  useEffect(() => {
    alive.current = true; void refresh()
    const changed = (): void => { if (active && !window.document.hidden) void refresh() }
    window.addEventListener('trellis-design-changed', changed)
    return () => { alive.current = false; serial.current++; window.removeEventListener('trellis-design-changed', changed) }
  }, [refresh, active])
  const accept = useCallback((next: DesignDocument): void => {
    if (!alive.current || next.id !== documentId) return
    serial.current++; setDocument(next); setError(''); setBusy(false)
  }, [documentId])
  return { document, error, busy, refresh, accept }
}

interface DesignVersionRequest { version: string; token: string }
interface ConversationDesignState { documents: DesignConversationSummary[]; selectedId: string | null; versionRequest: DesignVersionRequest | null; collapsed: boolean; expanded: boolean; error: string; busy: boolean; notice: string }
interface DesignReceipt { key: string; documentId: string; revisionId: string; ts: number; origin: TranscriptOwner }
interface PendingDesignReceipt { receipt: DesignReceipt; wasExisting: boolean }
const empty = (): ConversationDesignState => ({ documents: [], selectedId: null, versionRequest: null, collapsed: true, expanded: false, error: '', busy: false, notice: '' })
const receiptDocumentId = (receipt: DesignReceipt): string => receipt.documentId === DESIGN_PLACEHOLDER_DOCUMENT_ID ? receipt.revisionId : receipt.documentId
const sameId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase()

const summaryReads = new Map<string, Promise<DesignConversationSummary[]>>()
const syncReads = new Map<string, Promise<DesignDocument[]>>()
function joinDesignRead<T>(reads: Map<string, Promise<T>>, owner: string, read: () => Promise<DesignResult<T>>): Promise<T> {
  const previous = reads.get(owner)
  if (previous) return previous
  const request = Promise.resolve().then(read).then(conversationValue).finally(() => { if (reads.get(owner) === request) reads.delete(owner) })
  reads.set(owner, request)
  return request
}
function designReadError(cause: unknown): string {
  const message = conversationError(cause)
  return /daemon request queue is full/i.test(message) ? '后台读取暂时繁忙，已显示的设计仍可打开。稍后可核对设计。' : message
}

/** Source refresh ingests real tool outputs; replaying history never starts a turn. */
export function useConversationDesigns(current: WorkspaceEntry | undefined, enabled: boolean) {
  const owner = JSON.stringify([current?.owner, current?.conversation?.creatorId, current?.conversation?.id, projectRootKey(current?.conversation?.workspace.root), current?.conversation?.archivedAt, current?.conversation?.nativeRef?.agentId, current?.conversation?.nativeRef?.sessionId, current?.session?.connectionGeneration]), active = useInteractionActive()
  const [states, setStates] = useState<Record<string, ConversationDesignState>>({})
  const statesRef = useRef(states); statesRef.current = states
  const previous = useRef({ owner: '', since: Date.now(), receipts: new Set<string>(), pending: new Map<string, PendingDesignReceipt>(), retries: 0 })
  const completedSync = useRef(0), manualRefresh = useRef(false)
  const live = useRef({ owner, current, enabled, active }); live.current = { owner, current, enabled, active }
  const [refreshCount, setRefreshCount] = useState(0)
  const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  const receipts: DesignReceipt[] = useMemo(() => current?.events.flatMap(event => {
    const payload = record(event.payload)
    if (event.source !== 'pi' || event.kind !== 'tool-call' || payload?.title !== 'design_open' || payload.status !== 'completed' || payload.tag !== 'pi_tool_end' || !event.sessionId || !event.turnId || !event.connectionGeneration || event.sessionId !== current.conversation?.nativeRef?.sessionId || projectRootKey(event.projectRoot) !== projectRootKey(current.conversation?.workspace.root)) return []
    const output = readDesignGenerationOutput(record(record(payload.rawOutput)?.details)?.designOutput)
    return output ? [{ key: `${event.id}:${output.revisionId}`, documentId: output.documentId, revisionId: output.revisionId, ts: event.ts, origin: { source: event.source, projectRoot: event.projectRoot, sessionId: event.sessionId, connectionGeneration: event.connectionGeneration, turnId: event.turnId } }] : []
  }) ?? [], [current?.events, current?.conversation?.nativeRef?.sessionId, current?.conversation?.workspace.root])
  const eventKey = receipts.map(receipt => receipt.key).join('|')
  useLayoutEffect(() => {
    previous.current = { owner, since: Date.now(), receipts: new Set(receipts.map(receipt => receipt.key)), pending: new Map(), retries: 0 }
  }, [owner])
  useEffect(() => {
    const changed = (event: Event): void => { if ((event as CustomEvent<{ origin?: string }>).detail?.origin !== 'conversation-sync' && live.current.enabled && live.current.active) setRefreshCount(value => value + 1) }
    window.addEventListener('trellis-design-changed', changed)
    return () => window.removeEventListener('trellis-design-changed', changed)
  }, [])
  useEffect(() => {
    const conversationId = current?.conversation?.id, client = designClient()
    if (!enabled || !active || !conversationId || current.locked || !client || typeof client.listConversation !== 'function') return
    const syncAtStart = completedSync.current
    let canceled = false
    void joinDesignRead(summaryReads, owner, () => client.listConversation({ conversationId })).then(documents => {
      if (canceled || live.current.owner !== owner || !live.current.enabled || !live.current.active || completedSync.current !== syncAtStart) return
      setStates(values => {
        const state = values[owner] ?? empty()
        const selectedId = documents.some(document => document.id === state.selectedId) ? state.selectedId : null
        return { ...values, [owner]: { ...state, documents, selectedId, error: state.error.startsWith('会话设计读取失败：') ? '' : state.error } }
      })
    }).catch(cause => {
      if (!canceled && live.current.owner === owner && live.current.enabled && live.current.active && completedSync.current === syncAtStart) setStates(values => ({ ...values, [owner]: { ...(values[owner] ?? empty()), error: `会话设计读取失败：${designReadError(cause)}` } }))
    })
    return () => { canceled = true }
  }, [owner, enabled, active, current?.locked, refreshCount])
  useEffect(() => {
    const conversationId = current?.conversation?.id
    if (!enabled || !active || !conversationId || current.locked || !current.loaded || !current.conversation?.nativeRef) return
    if (!designClient()) {
      if (receipts.length) setStates(values => ({ ...values, [owner]: { ...(values[owner] ?? empty()), error: '本机设计接口当前不可用，请在桌面应用中重新核对。' } }))
      return
    }
    let canceled = false, retryTimer: ReturnType<typeof setTimeout> | undefined
    for (const receipt of receipts) {
      if (!previous.current.receipts.has(receipt.key) && receipt.ts >= previous.current.since) {
        const wasExisting = (statesRef.current[owner]?.documents ?? []).some(document => sameId(document.id, receiptDocumentId(receipt)))
        previous.current.pending.set(receipt.key, { receipt, wasExisting }); previous.current.retries = 0
      }
      previous.current.receipts.add(receipt.key)
    }
    setStates(values => ({ ...values, [owner]: { ...(values[owner] ?? empty()), busy: true, notice: '' } }))
    void joinDesignRead(syncReads, owner, () => requireDesignClient().sync({ conversationId })).then(documents => {
      if (canceled || live.current.owner !== owner || !live.current.enabled || !live.current.active) return
      completedSync.current++
      let reveal: { document: DesignDocument; candidateId?: string; token: string } | undefined
      for (const [key, pending] of previous.current.pending) {
        const document = documents.find(value => sameId(value.id, receiptDocumentId(pending.receipt)))
        const candidate = document?.candidates.find(value => sameId(value.id, pending.receipt.revisionId))
        if (!document || pending.wasExisting && !candidate) continue
        reveal = { document, candidateId: candidate?.id, token: key }
        previous.current.pending.delete(key)
      }
      // A completed tool call is only a receipt. The returned document is the authority for opening it.
      const missing = previous.current.pending.size > 0 || receipts.some(receipt => !documents.some(document => sameId(document.id, receiptDocumentId(receipt))))
      setStates(values => {
        const state = values[owner] ?? empty()
        const visible = missing && documents.length === 0 ? state.documents : documents
        const selectedId = reveal?.document.id ?? (visible.some(document => document.id === state.selectedId) ? state.selectedId : null)
        return { ...values, [owner]: { ...state, documents: visible, selectedId, versionRequest: reveal ? { version: reveal.candidateId ? `candidate:${reveal.candidateId}` : 'current', token: reveal.token } : state.versionRequest, collapsed: reveal ? false : state.collapsed,
          notice: manualRefresh.current && !missing ? '设计核对完成' : '', error: missing ? state.error || '设计工具已完成，但尚未核对到可打开的设计。请重新核对。' : '' } }
      })
      if (previous.current.pending.size && previous.current.retries < 2) {
        previous.current.retries++
        retryTimer = setTimeout(() => { if (!canceled && live.current.owner === owner) setRefreshCount(value => value + 1) }, 750)
      }
      notifyDesignChanged('conversation-sync')
    }).catch(cause => {
      if (!canceled && live.current.owner === owner && live.current.enabled && live.current.active) setStates(values => ({ ...values, [owner]: { ...(values[owner] ?? empty()), error: `会话设计同步失败：${designReadError(cause)}` } }))
    }).finally(() => {
      if (!canceled && live.current.owner === owner) { manualRefresh.current = false; setStates(values => ({ ...values, [owner]: { ...(values[owner] ?? empty()), busy: false } })) }
    })
    return () => { canceled = true; if (retryTimer) clearTimeout(retryTimer) }
  }, [owner, enabled, active, current?.loaded, current?.locked, current?.conversation?.nativeRef?.sessionId, eventKey, refreshCount])
  const state = enabled && active && !current?.locked ? states[owner] ?? empty() : empty()
  const change = (patch: Partial<ConversationDesignState>): void => { if (live.current.owner === owner && live.current.enabled) setStates(values => ({ ...values, [owner]: { ...(values[owner] ?? empty()), ...patch } })) }
  return { ...state, origins: receipts.filter((receipt, index) => receipts.findIndex(other => sameId(receiptDocumentId(other), receiptDocumentId(receipt))) === index).map(receipt => ({ documentId: receiptDocumentId(receipt), origin: receipt.origin })), ownerKey: owner, open: (id: string, candidateId?: string) => {
    const document = state.documents.find(value => value.id === id)
    if (document && (!candidateId || document.candidates.some(candidate => candidate.id === candidateId))) change({ selectedId: id, collapsed: false, versionRequest: { version: candidateId ? `candidate:${candidateId}` : 'current', token: crypto.randomUUID() } })
  }, close: () => change({ collapsed: true }), setCollapsed: (collapsed: boolean) => change({ collapsed }), setExpanded: (expanded: boolean) => change({ expanded }), refresh: () => { if (!statesRef.current[owner]?.busy) { manualRefresh.current = true; setRefreshCount(value => value + 1) } } }
}

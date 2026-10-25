import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CreationApi, CreationList } from '@shared/creation-api'
import type { CreationCommand, CreationCommandReply, CreationView } from '@shared/creations'
import { api } from '../api'
import { useHifox } from '../hifox/store'
import { useInteractionGuard } from '../utils/interaction-scope'
import { mergeComments, mergeSummaries } from './creation-state'

export type CreationFailure = { code: string; error: string; outcomeUnknown?: boolean }
const unavailable = { code: 'UNAVAILABLE', error: '当前环境未连接创作服务' }
const uncertainOperations = new Map<string, CreationFailure>()
export function creationApi(): CreationApi | undefined { return api?.creations }
export function failureOf(error: unknown): CreationFailure {
  return { code: 'REQUEST_FAILED', error: error instanceof Error ? error.message : String(error) }
}
export function needsRecovery(error: CreationFailure | null): boolean {
  return Boolean(error?.outcomeUnknown || error?.code === 'PENDING_OPERATION')
}

/** A → B → A changes, unmounts and authority changes all invalidate earlier replies. */
export function useCreationOwner(suffix: string): {
  workspaceKey: string; actorId: string | null; identity: string; principalKey: string; enabled: boolean; capture: () => () => boolean
} {
  const context = useHifox((state) => state.workspaceContext)
  const canInteract = useInteractionGuard()
  const identity = JSON.stringify([context.key, context.actorId, context.epoch, context.authorizationRevision, context.state])
  const key = `${identity}:${suffix}`
  const owner = useRef({ key, generation: 0, mounted: true })
  if (owner.current.key !== key) owner.current = { key, generation: owner.current.generation + 1, mounted: true }
  useLayoutEffect(() => {
    owner.current.mounted = true
    return () => { owner.current.mounted = false; owner.current.generation++ }
  }, [key])
  const capture = useCallback(() => {
    const generation = owner.current.generation
    return (): boolean => {
      const live = useHifox.getState().workspaceContext
      return owner.current.mounted && owner.current.key === key && owner.current.generation === generation && canInteract()
        && JSON.stringify([live.key, live.actorId, live.epoch, live.authorizationRevision, live.state]) === identity
    }
  }, [key, identity, canInteract])
  return { workspaceKey: context.key, actorId: context.actorId, identity, principalKey: JSON.stringify([context.key, context.actorId, context.epoch]), enabled: Boolean(context.actorId) && context.state !== 'access-revoked', capture }
}

export function useCreationList(input: { scope: 'personal' | 'team'; spaceId?: string; taskId?: string; enabled?: boolean }): {
  data: CreationList | null; busy: boolean; error: CreationFailure | null; refresh: () => Promise<void>; loadMore: () => Promise<void>
} {
  const query = JSON.stringify([input.scope, input.spaceId, input.taskId])
  const { workspaceKey, identity, enabled, capture } = useCreationOwner(`list:${query}`)
  const [state, setState] = useState<{ key: string; data: CreationList | null; busy: boolean; error: CreationFailure | null }>({ key: '', data: null, busy: false, error: null })
  const current = useRef(state)
  current.current = state
  const request = useRef(0)
  const stateKey = `${identity}:${query}`
  const active = enabled && input.enabled !== false && (input.scope !== 'team' || Boolean(input.spaceId))
  const fetchPage = useCallback(async (append: boolean): Promise<void> => {
    if (!active) return
    const bridge = creationApi()
    const valid = capture()
    if (!valid()) return
    const previous = current.current.key === stateKey ? current.current.data : null
    if (append && (!previous?.nextCursor || current.current.busy)) return
    const ticket = ++request.current
    setState({ key: stateKey, data: previous, busy: true, error: null })
    try {
      const reply = bridge ? await bridge.list({ workspaceKey, scope: input.scope, ...(input.spaceId ? { spaceId: input.spaceId } : {}), ...(input.taskId ? { taskId: input.taskId } : {}), ...(append && previous?.nextCursor ? { cursor: previous.nextCursor } : {}), limit: 20 }) : { ok: false as const, ...unavailable }
      if (!valid() || ticket !== request.current) return
      if (reply.ok) setState({ key: stateKey, data: { ...reply.value, items: append ? mergeSummaries(previous?.items ?? [], reply.value.items) : reply.value.items }, busy: false, error: null })
      else setState({ key: stateKey, data: previous, busy: false, error: reply })
    } catch (error) {
      if (valid() && ticket === request.current) setState({ key: stateKey, data: previous, busy: false, error: failureOf(error) })
    }
  }, [active, capture, stateKey, workspaceKey, input.scope, input.spaceId, input.taskId])
  const refresh = useCallback(() => fetchPage(false), [fetchPage])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (!active) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = creationApi()?.onChanged((event) => {
      if (event.workspaceKey !== workspaceKey) return
      clearTimeout(timer)
      timer = setTimeout(() => { void refresh() }, 250)
    })
    return () => { clearTimeout(timer); unsubscribe?.() }
  }, [active, workspaceKey, refresh])
  return { data: state.key === stateKey ? state.data : null, busy: active && (state.key !== stateKey || state.busy), error: state.key === stateKey ? state.error : null, refresh, loadMore: () => fetchPage(true) }
}

export function useCreationView(creationId: string, revisionId?: string): {
  view: CreationView | null; busy: boolean; loadingMore: boolean; error: CreationFailure | null; changed: boolean
  refresh: () => Promise<CreationView | null>; loadMore: () => Promise<void>; markChanged: () => void
} {
  const { workspaceKey, identity, enabled, capture } = useCreationOwner(`view:${creationId}:${revisionId ?? 'draft'}`)
  const key = `${identity}:${creationId}:${revisionId ?? 'draft'}`
  const [state, setState] = useState<{ key: string; view: CreationView | null; busy: boolean; loadingMore: boolean; error: CreationFailure | null; changed: boolean }>({ key: '', view: null, busy: false, loadingMore: false, error: null, changed: false })
  const current = useRef(state)
  current.current = state
  const request = useRef(0)
  const changes = useRef(0)
  const refresh = useCallback(async (): Promise<CreationView | null> => {
    if (!enabled) return null
    const valid = capture()
    if (!valid()) return null
    const ticket = ++request.current
    const noticedChanges = changes.current
    const previous = current.current.key === key ? current.current.view : null
    setState({ key, view: previous, busy: true, loadingMore: false, error: null, changed: false })
    try {
      const reply = await creationApi()?.get({ workspaceKey, creationId, ...(revisionId ? { revisionId } : {}), commentLimit: 20 })
      if (!valid() || ticket !== request.current) return null
      if (!reply?.ok) {
        // Permission loss removes original content; ordinary errors keep the readable version.
        const error = reply ?? unavailable
        setState({ key, view: /FORBIDDEN|REVOKED|UNAUTHORIZED/.test(error.code) ? null : previous, busy: false, loadingMore: false, error, changed: true })
        return null
      }
      let value = reply.value
      // Retain the loaded range so refresh does not unmount later reply/rule editors.
      const loadedCount = previous?.comments.length ?? 0
      while (value.nextCommentOffset !== null && value.comments.length < loadedCount) {
        const page = await creationApi()?.get({ workspaceKey, creationId, revisionId: value.selected.revisionId, commentOffset: value.nextCommentOffset, commentLimit: 20 })
        if (!valid() || ticket !== request.current) return null
        if (!page?.ok) {
          setState({ key, view: value, busy: false, loadingMore: false, error: page ?? unavailable, changed: true }); return value
        }
        if (page.value.summary.revision !== value.summary.revision) {
          setState({ key, view: previous, busy: false, loadingMore: false, error: { code: 'REVISION_CONFLICT', error: '创作在读取期间更新，请重新刷新' }, changed: true }); return null
        }
        value = { ...value, comments: mergeComments(value.comments, page.value.comments), nextCommentOffset: page.value.nextCommentOffset }
      }
      setState({ key, view: value, busy: false, loadingMore: false, error: null, changed: changes.current !== noticedChanges })
      return value
    } catch (error) {
      if (valid() && ticket === request.current) setState({ key, view: previous, busy: false, loadingMore: false, error: failureOf(error), changed: true })
      return null
    }
  }, [enabled, capture, key, workspaceKey, creationId, revisionId])
  const loadMore = useCallback(async (): Promise<void> => {
    const previous = current.current
    const previousView = previous.view
    const offset = previousView?.nextCommentOffset
    if (!enabled || previous.key !== key || !previousView || offset == null || previous.loadingMore || previous.busy) return
    const valid = capture()
    const ticket = request.current
    setState({ ...previous, loadingMore: true, error: null })
    try {
      const reply = await creationApi()?.get({ workspaceKey, creationId, revisionId: previousView.selected.revisionId, commentOffset: offset, commentLimit: 20 })
      if (!valid() || ticket !== request.current) return
      if (!reply?.ok) { setState({ ...previous, loadingMore: false, error: reply ?? unavailable }); return }
      if (reply.value.summary.revision !== previousView.summary.revision || reply.value.selected.revisionId !== previousView.selected.revisionId) {
        setState({ ...previous, loadingMore: false, changed: true, error: { code: 'REVISION_CONFLICT', error: '批注已更新，请刷新后继续加载' } }); return
      }
      setState((currentState) => ({ ...previous, changed: previous.changed || currentState.changed, loadingMore: false, view: { ...previousView, comments: mergeComments(previousView.comments, reply.value.comments), nextCommentOffset: reply.value.nextCommentOffset } }))
    } catch (error) {
      if (valid() && ticket === request.current) setState({ ...previous, loadingMore: false, error: failureOf(error) })
    }
  }, [enabled, key, capture, workspaceKey, creationId])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (!enabled) return
    const valid = capture()
    return creationApi()?.onChanged((event) => {
      if (valid() && event.workspaceKey === workspaceKey && (!event.creationId || event.creationId === creationId)) { changes.current++; setState((previous) => ({ ...previous, changed: true })) }
    })
  }, [enabled, capture, workspaceKey, creationId])
  return { view: state.key === key ? state.view : null, busy: enabled && (state.key !== key || state.busy), loadingMore: state.key === key && state.loadingMore,
    error: state.key === key ? state.error : null, changed: state.key === key && state.changed, refresh, loadMore, markChanged: () => setState((previous) => ({ ...previous, changed: true })) }
}

type CommandPayload = CreationCommand extends infer C ? C extends CreationCommand ? Omit<C, 'commandId' | 'creationId' | 'expectedRevision'> : never : never

export function useCreationCommands(creationId: string, revision: number | null, selectedRevisionId: string): {
  busy: boolean; error: CreationFailure | null; recoveryRequired: boolean; clearError: () => void
  run: (payload: CommandPayload) => Promise<CreationCommandReply | null>
  recover: () => Promise<CreationCommandReply | null | false>
  reportFailure: (failure: CreationFailure) => void
} {
  const { workspaceKey, identity, principalKey, enabled, capture } = useCreationOwner(`command:${creationId}:${selectedRevisionId}`)
  const key = `${identity}:${creationId}:${selectedRevisionId}`
  const recordKey = `${principalKey}:${creationId}`
  const [state, setState] = useState<{ key: string; busy: boolean; error: CreationFailure | null }>({ key, busy: false, error: null })
  const lock = useRef(false)
  const pending = useRef<CreationFailure | null>(null)
  useLayoutEffect(() => { lock.current = false; pending.current = uncertainOperations.get(recordKey) ?? null; setState({ key, busy: false, error: pending.current }) }, [key, recordKey])
  const run = useCallback(async (payload: CommandPayload): Promise<CreationCommandReply | null> => {
    if (!enabled || lock.current || needsRecovery(pending.current) || uncertainOperations.has(recordKey)) return null
    const bridge = creationApi()
    const valid = capture()
    if (!valid()) return null
    lock.current = true
    setState({ key, busy: true, error: null })
    try {
      const command: CreationCommand = { ...payload, creationId, expectedRevision: revision, commandId: crypto.randomUUID() }
      const reply = bridge ? await bridge.command({ workspaceKey, command }) : { ok: false as const, ...unavailable }
      if (!reply.ok && needsRecovery(reply)) uncertainOperations.set(recordKey, reply)
      if (!valid()) return null
      if (!reply.ok) { pending.current = reply; setState({ key, busy: false, error: reply }); return null }
      pending.current = null
      setState({ key, busy: false, error: null })
      return reply.value
    } catch (error) {
      const failure = { ...failureOf(error), outcomeUnknown: true }
      uncertainOperations.set(recordKey, failure)
      if (valid()) {
        // A transport exception after admission has no known outcome. Reconcile the journal.
        pending.current = failure
        setState({ key, busy: false, error: failure })
      }
      return null
    } finally { if (valid()) lock.current = false }
  }, [enabled, capture, key, recordKey, workspaceKey, creationId, revision])
  const recover = useCallback(async (): Promise<CreationCommandReply | null | false> => {
    if (!enabled || lock.current) return false
    const valid = capture()
    if (!valid()) return false
    lock.current = true
    setState({ key, busy: true, error: pending.current })
    try {
      const reply = await creationApi()?.recover({ workspaceKey, creationId })
      if (!valid()) return false
      if (!reply?.ok) { pending.current = reply ?? unavailable; if (needsRecovery(pending.current)) uncertainOperations.set(recordKey, pending.current); setState({ key, busy: false, error: pending.current }); return false }
      uncertainOperations.delete(recordKey)
      pending.current = null
      setState({ key, busy: false, error: null })
      return reply.value
    } catch (error) {
      if (valid()) setState({ key, busy: false, error: { ...failureOf(error), outcomeUnknown: true } })
      return false
    } finally { if (valid()) lock.current = false }
  }, [enabled, capture, key, recordKey, workspaceKey, creationId])
  const reportFailure = useCallback((failure: CreationFailure): void => {
    pending.current = failure
    if (needsRecovery(failure)) uncertainOperations.set(recordKey, failure)
    setState({ key, busy: false, error: failure })
  }, [key, recordKey])
  return useMemo(() => ({ busy: state.key === key && state.busy, error: state.key === key ? state.error : null, recoveryRequired: state.key === key && needsRecovery(state.error),
    run, recover, reportFailure, clearError: () => { if (!needsRecovery(pending.current)) setState({ key, busy: false, error: null }) } }), [state, key, run, recover, reportFailure])
}

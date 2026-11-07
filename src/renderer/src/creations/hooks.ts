import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CreationApi, CreationList } from '@shared/creation-api'
import type { CreationCommand, CreationCommandReply, CreationView } from '@shared/creations'
import { api } from '../api'
import { useCrux } from '../crux/store'
import { useInteractionGuard } from '../utils/interaction-scope'
import { mergeComments, mergeSummaries } from './creation-state'
import { readCreationForm, recordCreationFormReceipt, releaseCreationFormCommand, retainCreationFormCommand, type CreationFormIdentity } from './creation-form-memory'

export type CreationFailure = { code: string; error: string; outcomeUnknown?: boolean }
const unavailable = { code: 'UNAVAILABLE', error: '当前环境未连接创作服务' }
const uncertainOperations = new Map<string, CreationFailure>()
export function creationApi(): CreationApi | undefined { return api?.creations }
export function failureOf(error: unknown): CreationFailure {
  return { code: 'REQUEST_FAILED', error: error instanceof Error ? error.message : String(error) }
}
function accessDenied(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' && /FORBIDDEN|REVOKED|UNAUTHORIZED/.test(error.code)
}
function detailFailure(error: unknown): CreationFailure {
  if (accessDenied(error) && typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return { ...failureOf(error), code: error.code }
  }
  return failureOf(error)
}
export function needsRecovery(error: CreationFailure | null): boolean {
  return Boolean(error?.outcomeUnknown || error?.code === 'PENDING_OPERATION')
}

/** A → B → A changes, unmounts and authority changes all invalidate earlier replies. */
export function useCreationOwner(suffix: string): {
  workspaceKey: string; actorId: string | null; identity: string; principalKey: string; enabled: boolean; capture: () => () => boolean
} {
  const context = useCrux((state) => state.workspaceContext)
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
      const live = useCrux.getState().workspaceContext
      return owner.current.mounted && owner.current.key === key && owner.current.generation === generation && canInteract()
        && JSON.stringify([live.key, live.actorId, live.epoch, live.authorizationRevision, live.state]) === identity
    }
  }, [key, identity, canInteract])
  return { workspaceKey: context.key, actorId: context.actorId, identity, principalKey: JSON.stringify([context.key, context.actorId, context.epoch]), enabled: Boolean(context.actorId) && context.state !== 'access-revoked', capture }
}

export function useCreationList(input: { scope: 'personal' | 'team'; spaceId?: string; taskId?: string; query?: string; kind?: 'document' | 'prototype'; sort?: 'name' | 'updated'; enabled?: boolean }): {
  data: CreationList | null; busy: boolean; error: CreationFailure | null; mode: 'full' | 'fallback'; queryError: CreationFailure | null; refresh: () => Promise<void>; loadMore: () => Promise<void>
} {
  const query = JSON.stringify([input.scope, input.spaceId, input.taskId, input.query, input.kind, input.sort])
  const { workspaceKey, identity, enabled, capture } = useCreationOwner(`list:${query}`)
  const [state, setState] = useState<{ key: string; data: CreationList | null; busy: boolean; error: CreationFailure | null; mode: 'full' | 'fallback'; queryError: CreationFailure | null }>({ key: '', data: null, busy: false, error: null, mode: 'full', queryError: null })
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
    const prior = current.current.key === stateKey ? current.current : null
    const previous = prior?.data ?? null
    if (append && (!previous?.nextCursor || prior?.busy)) return
    const fallback = append && prior?.mode === 'fallback'
    const ticket = ++request.current
    setState({ key: stateKey, data: previous, busy: true, error: prior?.mode === 'fallback' ? prior.queryError : null, mode: prior?.mode ?? 'full', queryError: prior?.queryError ?? null })
    let mode: 'full' | 'fallback' = fallback ? 'fallback' : 'full'
    let queryError = fallback ? prior?.queryError ?? null : null
    let restarted = false
    try {
      const base = { workspaceKey, scope: input.scope, ...(input.spaceId ? { spaceId: input.spaceId } : {}), ...(input.taskId ? { taskId: input.taskId } : {}), ...(append && previous?.nextCursor ? { cursor: previous.nextCursor } : {}), limit: 20 }
      const requested = input.query !== undefined || input.kind !== undefined || input.sort !== undefined
      let reply = bridge ? await bridge.list({ ...base, ...(!fallback ? { ...(input.query !== undefined ? { query: input.query } : {}), ...(input.kind ? { kind: input.kind } : {}), ...(input.sort ? { sort: input.sort } : {}) } : {}) }) : { ok: false as const, ...unavailable }
      if (!valid() || ticket !== request.current) return
      if (!fallback && requested && !reply.ok && reply.code === 'INVALID_INPUT' && bridge) {
        queryError = reply
        mode = 'fallback'; restarted = true
        const { cursor: _cursor, ...firstPage } = base
        reply = await bridge.list(firstPage)
        if (!valid() || ticket !== request.current) return
      }
      if (reply.ok) setState({ key: stateKey, data: { ...reply.value, items: append && !restarted ? mergeSummaries(previous?.items ?? [], reply.value.items) : reply.value.items }, busy: false, error: queryError, mode, queryError })
      else setState({ key: stateKey, data: /FORBIDDEN|REVOKED|UNAUTHORIZED|SOURCE_CHANGED/.test(reply.code) ? null : restarted ? null : previous, busy: false, error: reply, mode: restarted || fallback ? mode : prior?.mode ?? 'full', queryError: restarted || fallback ? queryError : prior?.queryError ?? null })
    } catch (error) {
      if (valid() && ticket === request.current) setState({ key: stateKey, data: accessDenied(error) || restarted ? null : previous, busy: false, error: detailFailure(error), mode: restarted || fallback ? mode : prior?.mode ?? 'full', queryError: restarted || fallback ? queryError : prior?.queryError ?? null })
    }
  }, [active, capture, stateKey, workspaceKey, input.scope, input.spaceId, input.taskId, input.query, input.kind, input.sort])
  const refresh = useCallback(() => fetchPage(false), [fetchPage])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (!active) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = creationApi()?.onChanged((event) => {
      if (event.workspaceKey !== workspaceKey) return
      request.current++
      setState((previous) => previous.key === stateKey ? { ...previous, busy: true } : previous)
      clearTimeout(timer)
      timer = setTimeout(() => { void refresh() }, 250)
    })
    return () => { clearTimeout(timer); unsubscribe?.() }
  }, [active, workspaceKey, stateKey, refresh])
  return { data: state.key === stateKey ? state.data : null, busy: active && (state.key !== stateKey || state.busy), error: state.key === stateKey ? state.error : null, mode: state.key === stateKey ? state.mode : 'full', queryError: state.key === stateKey ? state.queryError : null, refresh, loadMore: () => fetchPage(true) }
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
        setState({ key, view: accessDenied(error) ? null : previous, busy: false, loadingMore: false, error, changed: true })
        return null
      }
      let value = reply.value
      // Retain the loaded range so refresh does not unmount later reply/rule editors.
      const loadedCount = previous?.comments.length ?? 0
      while (value.nextCommentOffset !== null && value.comments.length < loadedCount) {
        const page = await creationApi()?.get({ workspaceKey, creationId, revisionId: value.selected.revisionId, commentOffset: value.nextCommentOffset, commentLimit: 20 })
        if (!valid() || ticket !== request.current) return null
        if (!page?.ok) {
          const error = page ?? unavailable
          const view = accessDenied(error) ? null : value
          setState({ key, view, busy: false, loadingMore: false, error, changed: true }); return view
        }
        if (page.value.summary.revision !== value.summary.revision) {
          setState({ key, view: previous, busy: false, loadingMore: false, error: { code: 'REVISION_CONFLICT', error: '创作在读取期间更新，请重新刷新' }, changed: true }); return null
        }
        value = { ...value, comments: mergeComments(value.comments, page.value.comments), nextCommentOffset: page.value.nextCommentOffset }
      }
      setState({ key, view: value, busy: false, loadingMore: false, error: null, changed: changes.current !== noticedChanges })
      return value
    } catch (error) {
      if (valid() && ticket === request.current) setState({ key, view: accessDenied(error) ? null : previous, busy: false, loadingMore: false, error: detailFailure(error), changed: true })
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
      if (!reply?.ok) { const error = reply ?? unavailable; setState({ ...previous, view: accessDenied(error) ? null : previousView, loadingMore: false, error, changed: accessDenied(error) || previous.changed }); return }
      if (reply.value.summary.revision !== previousView.summary.revision || reply.value.selected.revisionId !== previousView.selected.revisionId) {
        setState({ ...previous, loadingMore: false, changed: true, error: { code: 'REVISION_CONFLICT', error: '批注已更新，请刷新后继续加载' } }); return
      }
      setState((currentState) => ({ ...previous, changed: previous.changed || currentState.changed, loadingMore: false, view: { ...previousView, comments: mergeComments(previousView.comments, reply.value.comments), nextCommentOffset: reply.value.nextCommentOffset } }))
    } catch (error) {
      if (valid() && ticket === request.current) setState({ ...previous, view: accessDenied(error) ? null : previousView, loadingMore: false, error: detailFailure(error), changed: accessDenied(error) || previous.changed })
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

export function useCreationCommands(creationId: string, revision: number | null, selectedRevisionId: string, formIdentity?: CreationFormIdentity): {
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
    if (!enabled || lock.current || needsRecovery(pending.current) || uncertainOperations.has(recordKey)) { if (formIdentity) releaseCreationFormCommand(formIdentity); return null }
    const bridge = creationApi()
    const valid = capture()
    const context = useCrux.getState().workspaceContext
    if (!valid() || (formIdentity && (formIdentity.workspaceKey !== context.key || formIdentity.actorId !== context.actorId || formIdentity.epoch !== (context.epoch ?? null)))) { if (formIdentity) releaseCreationFormCommand(formIdentity); return null }
    lock.current = true
    setState({ key, busy: true, error: null })
    let admitted: Extract<CreationCommand, { action: 'create' }> | undefined
    try {
      const command: CreationCommand = { ...payload, creationId, expectedRevision: revision, commandId: crypto.randomUUID(), ...(formIdentity?.epoch ? { expectedEpoch: formIdentity.epoch } : {}) }
      if (formIdentity) {
        if (command.action !== 'create' || command.home !== formIdentity.scope || command.spaceId !== formIdentity.spaceId || !retainCreationFormCommand(formIdentity, command)) {
          releaseCreationFormCommand(formIdentity)
          if (valid()) setState({ key, busy: false, error: { code: 'FORM_IDENTITY_MISMATCH', error: '原创建表单或操作身份无法核对' } })
          return null
        }
        admitted = command
      }
      const reply = bridge ? await bridge.command({ workspaceKey, command }) : { ok: false as const, ...unavailable }
      if (!reply.ok) {
        const uncertain = needsRecovery(reply) || Boolean(admitted && /SOURCE_CHANGED|OWNER_CHANGED|BINDING_CHANGED|SERVICE_CLOSED/.test(reply.code))
        const failure = uncertain ? { ...reply, outcomeUnknown: true } : reply
        if (uncertain) uncertainOperations.set(recordKey, failure)
        else if (formIdentity && admitted) releaseCreationFormCommand(formIdentity, admitted.commandId)
        if (valid()) { pending.current = failure; setState({ key, busy: false, error: failure }) }
        return null
      }
      if (formIdentity && admitted && !recordCreationFormReceipt(formIdentity, reply.value)) {
        const failure = { code: 'RECEIPT_MISMATCH', error: '创建回执与原操作不一致，请保留表单并核对', outcomeUnknown: true }
        uncertainOperations.set(recordKey, failure)
        if (valid()) { pending.current = failure; setState({ key, busy: false, error: failure }) }
        return null
      }
      if (!valid()) return null
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
  }, [enabled, capture, key, recordKey, workspaceKey, creationId, revision, formIdentity])
  const recover = useCallback(async (): Promise<CreationCommandReply | null | false> => {
    if (!enabled || lock.current) return false
    const valid = capture()
    const context = useCrux.getState().workspaceContext
    if (!valid() || (formIdentity && (formIdentity.workspaceKey !== context.key || formIdentity.actorId !== context.actorId || formIdentity.epoch !== (context.epoch ?? null)))) return false
    const form = formIdentity ? readCreationForm(formIdentity) : undefined
    if (formIdentity && (!form?.pending || !form.command || form.command.action !== 'create' || form.command.creationId !== creationId || form.command.home !== formIdentity.scope || form.command.spaceId !== formIdentity.spaceId)) return false
    lock.current = true
    setState({ key, busy: true, error: pending.current })
    try {
      const reply = await creationApi()?.recover({ workspaceKey, creationId, ...(form?.command && formIdentity ? { commandId: form.command.commandId, expectedEpoch: formIdentity.epoch } : {}) })
      if (reply?.ok && reply.value && formIdentity && !recordCreationFormReceipt(formIdentity, reply.value)) {
        const failure = { code: 'RECEIPT_MISMATCH', error: '核对回执与原创建操作不一致，请保留表单', outcomeUnknown: true }
        uncertainOperations.set(recordKey, failure)
        if (valid()) { pending.current = failure; setState({ key, busy: false, error: failure }) }
        return false
      }
      if (reply?.ok && reply.value && formIdentity) uncertainOperations.delete(recordKey)
      if (!valid()) return false
      if (!reply?.ok) { pending.current = reply ?? unavailable; if (needsRecovery(pending.current)) uncertainOperations.set(recordKey, pending.current); setState({ key, busy: false, error: pending.current }); return false }
      if (formIdentity && reply.value === null) {
        const failure = { code: 'PENDING_OPERATION', error: '未找到可核对的原操作，结果仍未确认', outcomeUnknown: true }
        uncertainOperations.set(recordKey, failure); pending.current = failure; setState({ key, busy: false, error: failure }); return null
      }
      uncertainOperations.delete(recordKey)
      pending.current = null
      setState({ key, busy: false, error: null })
      return reply.value
    } catch (error) {
      if (valid()) setState({ key, busy: false, error: { ...failureOf(error), outcomeUnknown: true } })
      return false
    } finally { if (valid()) lock.current = false }
  }, [enabled, capture, key, recordKey, workspaceKey, creationId, formIdentity])
  const reportFailure = useCallback((failure: CreationFailure): void => {
    pending.current = failure
    if (needsRecovery(failure)) uncertainOperations.set(recordKey, failure)
    setState({ key, busy: false, error: failure })
  }, [key, recordKey])
  return useMemo(() => ({ busy: state.key === key && state.busy, error: state.key === key ? state.error : null, recoveryRequired: state.key === key && needsRecovery(state.error),
    run, recover, reportFailure, clearError: () => { if (!needsRecovery(pending.current)) setState({ key, busy: false, error: null }) } }), [state, key, run, recover, reportFailure])
}

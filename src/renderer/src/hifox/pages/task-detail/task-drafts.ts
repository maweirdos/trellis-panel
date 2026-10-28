import { useCallback, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react'
import type { HifoxSnapshot, HifoxTask } from '@shared/hifox'
import type { HifoxWorkspaceContext } from '@shared/hifox-remote'
import { useHifox } from '../../store'
import { canReadTaskSpace, taskSourceKey } from './use-task-source'

interface DraftScope {
  owner: string
  generation: number
  key: string
  spaceId: string
  taskId?: string
  taskCreatedAt?: string
  base?: string
}
interface DraftEntry extends DraftScope {
  fields: ReadonlyMap<string, { value: unknown }>
}
const MAX_DRAFTS = 32
const drafts = new Map<string, DraftEntry>()
const listeners = new Set<() => void>()
const sourceOwner = (): string | null => {
  const state = useHifox.getState()
  return state.snapshot && state.workspaceContext.state !== 'access-revoked' ? taskSourceKey(state.snapshot, state.workspaceContext) : null
}
let owner = sourceOwner()
let generation = 0
const emit = (): void => { for (const listener of listeners) listener() }
const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
function valid(scope: DraftScope): boolean {
  const state = useHifox.getState()
  return scope.owner === owner && scope.generation === generation && Boolean(state.snapshot &&
    canReadTaskSpace(state.snapshot, state.workspaceContext, scope.spaceId) &&
    (!scope.taskId || state.snapshot.tasks.some((task) => task.id === scope.taskId && task.createdAt === scope.taskCreatedAt && task.spaceId === scope.spaceId)))
}
// Memory belongs to one current authority. Synchronous observation fences batched A → B → A.
useHifox.subscribe(() => {
  const nextOwner = sourceOwner()
  let changed = false
  if (nextOwner !== owner) { owner = nextOwner; generation++; changed = drafts.size > 0; drafts.clear() }
  for (const [key, entry] of drafts) if (!valid(entry)) { drafts.delete(key); changed = true }
  if (changed) emit()
})

export interface TaskDraft extends DraftScope {
  hasDraft: boolean
  stale: boolean
  discard(): void
  review(): void
  /** A known success clears only the exact submitted fields, including after a close. */
  acknowledge(fields?: readonly string[]): () => void
}

/** Bounded volatile drafts: never serialized, and never revived under another authority. */
export function useTaskDraft(snapshot: HifoxSnapshot, context: HifoxWorkspaceContext, scope: {
  kind: 'create' | 'details' | 'workflow' | 'progress' | 'conversation'
  spaceId: string
  task?: Pick<HifoxTask, 'id' | 'createdAt'>
  creationContext?: readonly unknown[]
  base?: string
}): TaskDraft {
  const identity = taskSourceKey(snapshot, context)
  const key = JSON.stringify([identity, generation, scope.spaceId, scope.kind, scope.task?.id, scope.task?.createdAt, scope.creationContext])
  const read = useCallback(() => drafts.get(key), [key])
  const entry = useSyncExternalStore(subscribe, read, () => undefined)
  const captured: DraftScope = { owner: identity, generation, key, spaceId: scope.spaceId, taskId: scope.task?.id, taskCreatedAt: scope.task?.createdAt, base: scope.base }
  return {
    ...captured, hasDraft: Boolean(entry?.fields.size), stale: Boolean(entry && entry.base !== scope.base),
    discard: () => { if (valid(captured) && drafts.delete(key)) emit() },
    review: () => { if (valid(captured) && entry) { drafts.set(key, { ...entry, base: scope.base }); emit() } },
    acknowledge: (fields) => {
      const submitted = drafts.get(key)
      return () => {
        if (!valid(captured) || !submitted) return
        const current = drafts.get(key)
        if (!current) return
        const remaining = new Map(current.fields)
        for (const [field, value] of submitted.fields) if ((!fields || fields.includes(field)) && remaining.get(field) === value) remaining.delete(field)
        if (remaining.size) drafts.set(key, { ...current, fields: remaining })
        else drafts.delete(key)
        emit()
      }
    }
  }
}

export function useTaskDraftField<T>(scope: TaskDraft, field: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const [fallback] = useState(initial)
  const read = useCallback(() => {
    const stored = drafts.get(scope.key)?.fields.get(field)
    return stored ? stored.value as T : fallback
  }, [scope.key, field, fallback])
  const value = useSyncExternalStore(subscribe, read, () => fallback)
  const setValue: Dispatch<SetStateAction<T>> = (action) => {
    if (!valid(scope)) return
    const previous = drafts.get(scope.key)
    const stored = previous?.fields.get(field)
    const next = typeof action === 'function' ? (action as (previous: T) => T)(stored ? stored.value as T : fallback) : action
    if (stored && Object.is(stored.value, next)) return
    const fields = new Map(previous?.fields)
    fields.set(field, { value: next })
    drafts.delete(scope.key)
    const { owner, generation, key, spaceId, taskId, taskCreatedAt, base } = scope
    drafts.set(scope.key, { ...(previous ?? { owner, generation, key, spaceId, taskId, taskCreatedAt, base }), fields })
    while (drafts.size > MAX_DRAFTS) { const oldest = drafts.keys().next(); if (oldest.done) break; drafts.delete(oldest.value) }
    emit()
  }
  return [value, setValue]
}

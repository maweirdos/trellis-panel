import { useLayoutEffect, useRef, useState } from 'react'
import type { CruxFailure, CruxSnapshot } from '@shared/crux'
import type { CruxWorkspaceContext } from '@shared/crux-remote'
import { hasIpc } from '../../../api'
import { useInteractionGuard, useInteractionSignal } from '../../../utils/interaction-scope'
import { useCrux } from '../../store'

export function taskActorId(snapshot: CruxSnapshot | null, context: CruxWorkspaceContext): string | undefined {
  if (!snapshot) return undefined
  return context.actorId ?? (context.state === 'local' ? snapshot.members.find((member) => member.role === 'owner')?.id : undefined)
}

export function canReadTaskSpace(snapshot: CruxSnapshot, context: CruxWorkspaceContext, spaceId: string): boolean {
  const space = snapshot.spaces.find((candidate) => candidate.id === spaceId)
  const actorId = taskActorId(snapshot, context)
  return Boolean(space && context.state !== 'access-revoked' &&
    (context.state === 'local' || actorId && space.memberIds.includes(actorId)))
}

export function taskSourceKey(snapshot: CruxSnapshot, context: CruxWorkspaceContext): string {
  return JSON.stringify([context.key, context.instanceId, context.epoch, context.actorId, taskActorId(snapshot, context)])
}

/** A later reopen is a new surface even when React batches close/open to the same ID. */
export function useTaskSurfaceGeneration(creating = false): number {
  const [generation, setGeneration] = useState(0)
  useLayoutEffect(() => {
    const identity = (state: ReturnType<typeof useCrux.getState>): string => {
      const task = state.snapshot?.tasks.find((candidate) => candidate.id === state.openTaskId)
      const spaceId = task?.spaceId ?? state.currentSpaceId
      return JSON.stringify([
        state.snapshot ? taskSourceKey(state.snapshot, state.workspaceContext) : null,
        state.currentSpaceId, state.module, state.openTaskId, task?.createdAt,
        Boolean(state.snapshot && spaceId && canReadTaskSpace(state.snapshot, state.workspaceContext, spaceId)),
        creating ? state.createTaskOpen : undefined, creating ? state.createTaskContext : undefined
      ])
    }
    return useCrux.subscribe((next, previous) => {
      if (identity(next) !== identity(previous)) setGeneration((current) => current + 1)
    })
  }, [creating])
  return generation
}

interface TaskSourceScope {
  spaceId: string
  taskId?: string
  creating?: boolean
  /** An embedded post owns its taskId without selecting the global task drawer. */
  embedded?: boolean
}

export interface TaskSourceOwner {
  available: boolean
  signal: AbortSignal
  ticket: () => number
  owns: (ticket?: number) => boolean
  canWrite: (ticket?: number) => boolean
}

/** Invalidate on the actual transition, including a batched A → B → A. */
export function useTaskSource({ spaceId, taskId, creating, embedded }: TaskSourceScope): TaskSourceOwner {
  const [available, setAvailable] = useState(true)
  const generation = useRef(0)
  const mounted = useRef(false)
  const invalidated = useRef(false)
  const canInteract = useInteractionGuard()
  const parentSignal = useInteractionSignal()
  const [controller] = useState(() => new AbortController())
  const [origin] = useState(() => {
    const state = useCrux.getState()
    return {
      key: state.snapshot ? taskSourceKey(state.snapshot, state.workspaceContext) : '',
      currentSpaceId: state.currentSpaceId,
      openTaskId: state.openTaskId,
      embedded: Boolean(embedded),
      module: state.module,
      globalCreation: creating && state.createTaskOpen,
      creationContext: JSON.stringify(state.createTaskContext)
    }
  })
  const matches = (): boolean => {
    const state = useCrux.getState()
    return Boolean(state.snapshot && taskSourceKey(state.snapshot, state.workspaceContext) === origin.key &&
      state.currentSpaceId === origin.currentSpaceId && state.openTaskId === origin.openTaskId && state.module === origin.module &&
      (!origin.embedded || state.openTaskId === null || state.openTaskId === taskId) &&
      (!origin.globalCreation || state.createTaskOpen && JSON.stringify(state.createTaskContext) === origin.creationContext) &&
      canReadTaskSpace(state.snapshot, state.workspaceContext, spaceId) &&
      (!taskId || state.snapshot.tasks.some((task) => task.id === taskId && task.spaceId === spaceId)))
  }
  useLayoutEffect(() => {
    mounted.current = true
    const abort = (): void => controller.abort()
    if (parentSignal?.aborted) abort()
    parentSignal?.addEventListener('abort', abort, { once: true })
    const inspect = (): void => {
      if (invalidated.current || matches()) return
      invalidated.current = true
      generation.current++
      controller.abort()
      setAvailable(false)
    }
    inspect()
    const unsubscribe = useCrux.subscribe(inspect)
    return () => {
      unsubscribe()
      parentSignal?.removeEventListener('abort', abort)
      mounted.current = false
      generation.current++
      queueMicrotask(() => { if (!mounted.current) controller.abort() })
    }
    // This owner is immutable; the caller keys a new source by workspace/actor/task.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin, spaceId, taskId, controller, parentSignal])
  const owns = (ticket = generation.current): boolean => mounted.current && !invalidated.current && !controller.signal.aborted &&
    ticket === generation.current && canInteract() && matches()
  return {
    available,
    signal: controller.signal,
    ticket: () => generation.current,
    owns,
    canWrite: (ticket) => owns(ticket) && hasIpc &&
      !useCrux.getState().snapshot?.spaces.find((space) => space.id === spaceId)?.archived
  }
}

export type TaskMutation = <T extends { ok: true; data: CruxSnapshot }>(
  label: string,
  call: () => Promise<T | CruxFailure>
) => Promise<T | null>

/** Errors stay with this source and drafts are committed only after owned success. */
export function useTaskMutation(source: TaskSourceOwner): { mutate: TaskMutation; error: string | null; pending: boolean } {
  const [failure, setFailure] = useState<{ label: string; message: string } | null>(null)
  const [pending, setPending] = useState(false)
  const inFlight = useRef(false)
  const mutate: TaskMutation = async (label, call) => {
    const ticket = source.ticket()
    if (inFlight.current || useCrux.getState().busy || !source.canWrite(ticket)) return null
    inFlight.current = true
    setPending(true)
    try {
      const result = await useCrux.getState().run(label, async () => {
        if (!source.canWrite(ticket)) return { ok: false as const, error: '原任务来源已不可编辑，请重新打开。' }
        try { return await call() }
        catch (failure) { return { ok: false as const, error: failure instanceof Error ? failure.message : String(failure) } }
      })
      if (!source.owns(ticket)) return null
      if (!result?.ok) { setFailure({ label, message: result?.error ?? `${label}未完成，请重试。` }); return null }
      setFailure((current) => current?.label === label ? null : current)
      return result
    } finally {
      inFlight.current = false
      if (source.owns(ticket)) setPending(false)
    }
  }
  return { mutate, error: failure?.message ?? null, pending }
}

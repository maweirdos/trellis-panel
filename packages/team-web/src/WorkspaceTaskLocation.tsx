import { useLayoutEffect, useRef, useState, type JSX } from 'react'
import { z } from 'zod'
import { teamIdSchema, teamOpaqueIdSchema } from './contracts'
import { useCrux } from '../../../src/renderer/src/crux/store'
import { canReadTaskSpace } from '../../../src/renderer/src/crux/pages/task-detail/use-task-source'
import type { BrowserCruxWorkspace } from './crux-browser-api'

const targetSchema = z.object({ projectId: teamIdSchema, taskId: teamOpaqueIdSchema, taskCreatedAt: z.iso.datetime({ offset: true }).max(64) })
type TaskLocation = z.infer<typeof targetSchema>
type Target = { kind: 'none' } | { kind: 'invalid' } | { kind: 'task'; value: TaskLocation }
type Workspace = Pick<BrowserCruxWorkspace, 'context' | 'isCurrent'>
type LocationOwner = { active(): boolean; retry(): void; clear(): void; dispose(): void }

export function workspaceProjectFromLocation(): string {
  const params = new URLSearchParams(location.search)
  const project = teamIdSchema.safeParse(params.get('project'))
  return params.getAll('project').length === 1 && project.success ? project.data : ''
}

function readTarget(): Target {
  const params = new URLSearchParams(location.search)
  if (!params.has('task') && !params.has('taskCreatedAt')) return { kind: 'none' }
  if (['project', 'task', 'taskCreatedAt'].some((key) => params.getAll(key).length !== 1)) return { kind: 'invalid' }
  const parsed = targetSchema.safeParse({ projectId: params.get('project'), taskId: params.get('task'), taskCreatedAt: params.get('taskCreatedAt') })
  return parsed.success ? { kind: 'task', value: parsed.data } : { kind: 'invalid' }
}

function replaceLocation(projectId: string, task?: TaskLocation): void {
  const url = new URL(location.href)
  url.searchParams.set('project', projectId)
  if (task) { url.searchParams.set('task', task.taskId); url.searchParams.set('taskCreatedAt', task.taskCreatedAt) }
  else { url.searchParams.delete('task'); url.searchParams.delete('taskCreatedAt') }
  const next = url.pathname + url.search + url.hash
  if (next !== location.pathname + location.search + location.hash) history.replaceState(history.state, '', next)
}

/** One lease owns recovery and URL updates; a later matching account cannot revive it. */
export function trackWorkspaceTaskLocation(workspace: Workspace, accountId: string, notice: (message: string) => void): LocationOwner {
  const origin = workspace.context()
  let target = readTarget(), live = true, invalidated = false, attempted = false
  let source: { instanceId: string | undefined; epoch: string | undefined } | null = null
  let observed: TaskLocation | null = null
  if (target.kind === 'task' && target.value.projectId !== origin.projectId) target = { kind: 'none' }
  const owns = (): boolean => {
    const context = useCrux.getState().workspaceContext
    return live && !invalidated && workspace.isCurrent() && context.key === origin.key && context.projectId === origin.projectId && (!context.actorId || context.actorId === accountId)
  }
  const invalidate = (): void => {
    invalidated = true
    if (target.kind !== 'none' || observed) notice('原任务的登录、工作区或服务已改变，请重新载入页面核对。')
  }
  const inspect = (): void => {
    if (!live || invalidated) return
    if (!owns()) { invalidate(); return }
    const state = useCrux.getState(), context = state.workspaceContext, current = workspace.context()
    if (context.state === 'access-revoked' || source && (context.instanceId !== source.instanceId || context.epoch !== source.epoch)) { invalidate(); return }
    // The first empty lease and background reconnects cannot consume the URL target.
    if (!state.snapshot || state.loadError || context.state !== 'connected' || context.actorId !== accountId || !context.instanceId || !context.epoch || current.state !== 'connected' || current.actorId !== accountId ||
      current.instanceId !== context.instanceId || current.epoch !== context.epoch || current.revision !== context.revision || current.authorizationRevision !== context.authorizationRevision) return
    source ??= { instanceId: context.instanceId, epoch: context.epoch }
    const task = state.snapshot.tasks.find((item) => item.id === state.openTaskId)
    if (task && canReadTaskSpace(state.snapshot, context, task.spaceId)) {
      const original = target.kind === 'task' ? target.value : observed
      if (original && task.id === original.taskId && task.createdAt !== original.taskCreatedAt) {
        target = { kind: 'task', value: original }; attempted = true
        state.openTask(null)
        notice('链接中的原任务已变化，未打开当前同编号任务。请返回工作区重新选择。'); return
      }
      const parsed = targetSchema.safeParse({ projectId: context.projectId, taskId: task.id, taskCreatedAt: task.createdAt })
      if (!parsed.success) { notice('当前任务缺少可恢复的创建标识。'); return }
      // An explicit newer task selection takes precedence over an unresolved link.
      target = { kind: 'none' }; observed = parsed.data
      notice(''); replaceLocation(parsed.data.projectId, parsed.data); return
    }
    if (target.kind === 'invalid') { notice('任务链接不完整或格式不正确，请重新复制完整链接，或返回工作区。'); return }
    if (target.kind === 'task') {
      if (attempted) return
      attempted = true
      const requested = target.value
      const original = state.snapshot.tasks.find((item) => item.id === requested.taskId)
      if (!original) { notice('原任务已不存在，或你当前没有读取权限。请重新核对，或返回工作区。'); return }
      if (original.createdAt !== requested.taskCreatedAt) { notice('链接中的原任务已变化，未打开当前同编号任务。请返回工作区重新选择。'); return }
      if (!canReadTaskSpace(state.snapshot, context, original.spaceId)) { notice('你当前没有原任务所在空间的读取权限，请联系空间管理员核对。'); return }
      observed = target.value; target = { kind: 'none' }
      notice(''); state.openTask(original.id); return
    }
    if (observed && (!task || task.createdAt !== observed.taskCreatedAt || !canReadTaskSpace(state.snapshot, context, task.spaceId)) && state.openTaskId) {
      target = { kind: 'task', value: observed }; attempted = true
      state.openTask(null)
      notice('原任务已不存在、发生变化或失去读取权限，请重新核对。'); return
    }
    if (state.openTaskId) return
    observed = null
    notice(''); if (origin.projectId) replaceLocation(origin.projectId)
  }
  const unsubscribe = useCrux.subscribe(inspect)
  inspect()
  return {
    active: owns,
    retry() {
      if (!owns()) return
      if (observed && target.kind === 'none') target = { kind: 'task', value: observed }
      attempted = false
      void useCrux.getState().bootstrap()
    },
    clear() {
      if (!owns() || useCrux.getState().workspaceContext.state !== 'connected') return
      target = { kind: 'none' }; observed = null; attempted = false
      useCrux.getState().openTask(null); useCrux.getState().setModule('overview')
      if (origin.projectId) replaceLocation(origin.projectId)
      notice('')
    },
    dispose() { live = false; unsubscribe() }
  }
}

export function WorkspaceTaskLocation({ workspace, accountId }: { workspace: Workspace; accountId: string }): JSX.Element | null {
  const [message, setMessage] = useState('')
  const owner = useRef<{ binding: LocationOwner; workspace: Workspace } | null>(null)
  useLayoutEffect(() => {
    setMessage('')
    const binding = trackWorkspaceTaskLocation(workspace, accountId, setMessage)
    owner.current = { binding, workspace }
    return () => { binding.dispose(); if (owner.current?.binding === binding) owner.current = null }
  }, [workspace, accountId])
  return message ? <div className="crux-host-status" role="alert"><p>{message}</p><button type="button" disabled={!owner.current?.binding.active()} onClick={() => { if (owner.current?.workspace === workspace) owner.current.binding.retry() }}>重新核对任务</button><button type="button" disabled={!owner.current?.binding.active()} onClick={() => { if (owner.current?.workspace === workspace) owner.current.binding.clear() }}>返回工作区</button><button type="button" onClick={() => { if (owner.current?.workspace === workspace) location.reload() }}>重新载入页面</button></div> : null
}

import { useSyncExternalStore } from 'react'
import type { CruxTask } from '@shared/crux'
import { api } from '../api'
import { useCrux } from '../crux/store'
import { useMy } from '../my/store'
import { useApp } from '../store'

interface WorkThreadIntent {
  key: string
  root: string
  threadId: string
  workspaceKey: string
  actorId: string
  instanceId: string | null | undefined
  epoch: string | null | undefined
}

let intent: WorkThreadIntent | null = null
const listeners = new Set<() => void>()
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
const snapshot = (): WorkThreadIntent | null => intent

export function useTaskWorkThread(root: string | undefined): WorkThreadIntent | null {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot)
  const { key, actorId, state, instanceId, epoch } = useCrux(store => store.workspaceContext)
  return current && root === current.root && state === 'connected' && key === current.workspaceKey
    && actorId === current.actorId && instanceId === current.instanceId && epoch === current.epoch ? current : null
}

export async function openTaskWorkThread(task: CruxTask, threadId: string, current: () => boolean): Promise<void> {
  const context = useCrux.getState().workspaceContext
  const actorId = context.actorId
  const assertLinked = (): void => {
    const latest = useCrux.getState()
    if (!current() || !actorId || latest.workspaceContext.state !== 'connected'
      || latest.workspaceContext.key !== context.key || latest.workspaceContext.actorId !== actorId
      || latest.workspaceContext.instanceId !== context.instanceId || latest.workspaceContext.epoch !== context.epoch
      || !latest.snapshot?.tasks.some(item => item.id === task.id && item.createdAt === task.createdAt && item.spaceId === task.spaceId
        && item.conversations?.some(link => link.id === threadId && link.actorId === actorId))) {
      throw Error('当前成员没有权限打开这条 Work 来源。')
    }
  }
  if (!threadId.startsWith('thr_') || !actorId) throw Error('无法核对原 Work 对话。')
  assertLinked()
  const root = await api.conversationWorkRoot()
  assertLinked()
  if (!root.ok) throw Error(root.error)
  const read = await api.conversationRead(threadId, root.root)
  assertLinked()
  if (!read.ok || read.thread.id !== threadId) throw Error(read.ok ? '原 Work 对话身份不一致。' : read.error)
  intent = { key: crypto.randomUUID(), root: root.root, threadId, workspaceKey: context.key, actorId,
    instanceId: context.instanceId, epoch: context.epoch }
  for (const listener of listeners) listener()
  useMy.getState().setChatWorkdirMode('default')
  useApp.getState().setPage('chat')
}

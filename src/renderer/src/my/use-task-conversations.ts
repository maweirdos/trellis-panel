import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, hasIpc } from '../api'
import { useApp } from '../store'
import { relativePathUnderRoot, sameRelativeDocumentPath } from '../reader/reader-paths'
import { useInteractionActive, useInteractionGuard } from '../utils/interaction-scope'
import { errorText } from '../../../shared/errors'
import type { TaskConversationBinding, TaskConversationCandidates, TaskConversationSource, TaskConversationsApi, TaskConversationsSnapshot } from '../../../shared/task-conversations'
import { projectRootKey } from './navigation'

const AUTOMATIC_REFRESH_INTERVAL_MS = 5000
export const TASK_CONVERSATION_SOURCE_LABELS: Record<TaskConversationSource, string> = { codex: 'Codex', 'claude-code': 'Claude Code', zcode: 'ZCode' }

/** Compare actual project-relative directories, retaining archive parents and POSIX case. */
export function taskConversationDirectory(root: string, path: string | null): string | null {
  if (!path || !root) return null
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const absolute = normalized.startsWith('/') || /^[a-z]:/i.test(normalized)
  const relative = absolute ? relativePathUnderRoot(root, normalized) : normalized
  if (!relative || relative.split('/').some((part) => !part || part === '.' || part === '..')) return null
  // The public contract abbreviates .trellis/tasks/, but never archive parents.
  return relative.replace(/^\.trellis\/tasks\//, '')
}

interface Owner { root: string; key: string | null }
interface Feedback { error: boolean; message: string; taskDir?: string }
interface State {
  owner: Owner
  data: TaskConversationsSnapshot | null
  loading: boolean
  error: string | null
  feedback: Feedback | null
  pendingTaskDir: string | null
}

export interface TaskConversationController {
  available: boolean
  data: TaskConversationsSnapshot | null
  loading: boolean
  refreshing: boolean
  error: string | null
  feedback: Feedback | null
  pendingTaskDir: string | null
  bindingsFor: (taskPath: string | null) => TaskConversationBinding[]
  refresh: (force?: boolean) => Promise<void>
  discover: () => Promise<TaskConversationCandidates | null>
  bind: (taskDir: string, conversationId: string) => Promise<boolean>
  setPrimary: (taskDir: string, bindingId: string) => Promise<boolean>
  unbind: (taskDir: string, bindingId: string) => Promise<boolean>
  open: (taskDir: string, bindingId: string) => Promise<boolean>
}

export function useTaskConversations(projectRoot: string | undefined): TaskConversationController {
  const owner = useMemo<Owner>(() => ({ root: projectRoot ?? '', key: projectRootKey(projectRoot) }), [projectRoot])
  const currentOwner = useRef(owner)
  currentOwner.current = owner
  const mounted = useRef(false)
  const requestSequence = useRef(0)
  const discoverySequence = useRef(0)
  const listFlight = useRef<Owner | null>(null)
  const mutation = useRef<{ owner: Owner; taskDir: string } | null>(null)
  const lastStarted = useRef(0)
  const interactive = useInteractionActive()
  const canInteract = useInteractionGuard()
  const [state, setState] = useState<State>({ owner, data: null, loading: false, error: null, feedback: null, pendingTaskDir: null })
  const available = Boolean(owner.key && hasIpc && typeof api.taskConversationsList === 'function'
    && typeof api.taskConversationsDiscover === 'function' && typeof api.taskConversationsBind === 'function'
    && typeof api.taskConversationsSetPrimary === 'function' && typeof api.taskConversationsUnbind === 'function'
    && typeof api.taskConversationsOpen === 'function')
  const current = state.owner === owner ? state : { owner, data: null, loading: available, error: null, feedback: null, pendingTaskDir: null }
  const isCurrent = useCallback((): boolean => mounted.current && currentOwner.current === owner && canInteract()
    && projectRootKey(useApp.getState().snapshot?.meta.root) === owner.key, [owner, canInteract])
  const update = useCallback((patch: Partial<State>): void => {
    if (isCurrent()) setState((previous) => previous.owner === owner ? { ...previous, ...patch } : previous)
  }, [owner, isCurrent])

  useLayoutEffect(() => {
    mounted.current = true
    lastStarted.current = 0
    listFlight.current = null
    mutation.current = null
    setState({ owner, data: null, loading: available, error: null, feedback: null, pendingTaskDir: null })
    return () => { mounted.current = false; requestSequence.current++; discoverySequence.current++ }
  }, [owner, available])

  useLayoutEffect(() => {
    if (interactive) return
    requestSequence.current++
    discoverySequence.current++
    listFlight.current = null
    mutation.current = null
    setState((previous) => previous.owner === owner ? { ...previous, loading: false, pendingTaskDir: null } : previous)
  }, [interactive, owner])

  const refresh = useCallback(async (force = true): Promise<void> => {
    if (!available || !isCurrent() || mutation.current?.owner === owner || !force && listFlight.current === owner) return
    const sequence = ++requestSequence.current
    listFlight.current = owner
    lastStarted.current = Date.now()
    // A deliberate retry supersedes old action feedback; background reads do not.
    update({ loading: true, error: null, ...(force ? { feedback: null } : {}) })
    try {
      const result = await api.taskConversationsList({ expectedRoot: owner.root })
      if (!isCurrent() || sequence !== requestSequence.current) return
      if (!result.ok) throw new Error(result.error)
      if (projectRootKey(result.value.projectRoot) !== owner.key) throw new Error('会话列表的项目归属不匹配，请刷新重试。')
      update({ data: result.value })
    } catch (cause) {
      if (sequence === requestSequence.current) update({ error: errorText(cause, '读取任务会话失败。') })
    } finally {
      if (isCurrent() && sequence === requestSequence.current) { listFlight.current = null; update({ loading: false }) }
    }
  }, [available, owner, isCurrent, update])

  useEffect(() => {
    if (!available || !interactive) return
    void refresh()
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (): void => {
      if (document.visibilityState !== 'visible' || timer !== undefined || !isCurrent()) return
      timer = setTimeout(() => { timer = undefined; void refresh(false) }, Math.max(0, AUTOMATIC_REFRESH_INTERVAL_MS - (Date.now() - lastStarted.current)))
    }
    const unsubscribe = api.onSnapshotUpdated((snapshot) => { if (projectRootKey(snapshot.meta.root) === owner.key) schedule() })
    window.addEventListener('focus', schedule)
    document.addEventListener('visibilitychange', schedule)
    return () => { clearTimeout(timer); unsubscribe(); window.removeEventListener('focus', schedule); document.removeEventListener('visibilitychange', schedule) }
  }, [available, interactive, owner, refresh, isCurrent])

  const discover = useCallback(async (): Promise<TaskConversationCandidates | null> => {
    if (!available || !isCurrent()) return null
    const sequence = ++discoverySequence.current
    try {
      const result = await api.taskConversationsDiscover({ expectedRoot: owner.root })
      if (!isCurrent() || sequence !== discoverySequence.current) return null
      if (!result.ok) throw new Error(result.error)
      if (projectRootKey(result.value.projectRoot) !== owner.key) throw new Error('候选会话的项目归属不匹配。')
      return result.value
    } catch (cause) {
      if (!isCurrent() || sequence !== discoverySequence.current) return null
      throw cause
    }
  }, [available, owner, isCurrent])

  const change = useCallback(async (taskDir: string, request: (directory: string) => ReturnType<TaskConversationsApi['taskConversationsBind']>): Promise<boolean> => {
    if (!available || !isCurrent() || mutation.current?.owner === owner) return false
    const directory = taskConversationDirectory(owner.root, taskDir)
    if (!directory) { update({ feedback: { error: true, message: '任务目录不属于当前项目。' } }); return false }
    const ticket = { owner, taskDir: directory }
    mutation.current = ticket
    const sequence = ++requestSequence.current
    update({ pendingTaskDir: directory, loading: false, feedback: null })
    try {
      const result = await request(directory)
      if (!isCurrent() || sequence !== requestSequence.current) return false
      if (!result.ok) throw new Error(result.error)
      if (projectRootKey(result.value.projectRoot) !== owner.key) throw new Error('关联结果的项目归属不匹配。')
      update({ data: result.value })
      return true
    } catch (cause) {
      if (sequence === requestSequence.current) update({ feedback: { error: true, message: errorText(cause, '更新会话关联失败。'), taskDir: directory } })
      return false
    } finally {
      if (mutation.current === ticket) { mutation.current = null; listFlight.current = null; update({ pendingTaskDir: null }) }
    }
  }, [available, owner, isCurrent, update])

  const bind = useCallback((taskDir: string, conversationId: string) => change(taskDir, (directory) => api.taskConversationsBind({ expectedRoot: owner.root, taskDir: directory, conversationId })), [owner, change])
  const setPrimary = useCallback((taskDir: string, bindingId: string) => change(taskDir, (directory) => api.taskConversationsSetPrimary({ expectedRoot: owner.root, taskDir: directory, bindingId })), [owner, change])
  const unbind = useCallback((taskDir: string, bindingId: string) => change(taskDir, (directory) => api.taskConversationsUnbind({ expectedRoot: owner.root, taskDir: directory, bindingId })), [owner, change])
  const open = useCallback(async (taskDir: string, bindingId: string): Promise<boolean> => {
    if (!available || !isCurrent() || mutation.current?.owner === owner) return false
    const directory = taskConversationDirectory(owner.root, taskDir)
    if (!directory) { update({ feedback: { error: true, message: '任务目录不属于当前项目。' } }); return false }
    const ticket = { owner, taskDir: directory }
    mutation.current = ticket
    const sequence = ++requestSequence.current
    update({ pendingTaskDir: directory, loading: false, feedback: null })
    try {
      const result = await api.taskConversationsOpen({ expectedRoot: owner.root, taskDir: directory, bindingId })
      if (!isCurrent() || sequence !== requestSequence.current) return false
      if (!result.ok) throw new Error(result.error)
      update({ feedback: { error: false, message: result.value.detail ?? `已请求${result.value.destinationLabel ?? (result.value.capability === 'workspace' ? '打开工作区' : '恢复原生会话')}`, taskDir: directory } })
      return true
    } catch (cause) {
      if (sequence === requestSequence.current) update({ feedback: { error: true, message: errorText(cause, '打开原生会话失败。'), taskDir: directory } })
      return false
    } finally {
      if (mutation.current === ticket) { mutation.current = null; listFlight.current = null; update({ pendingTaskDir: null }); void refresh(false) }
    }
  }, [available, owner, isCurrent, update, refresh])

  const bindingsFor = useCallback((taskPath: string | null): TaskConversationBinding[] => {
    const key = taskConversationDirectory(owner.root, taskPath)
    return key ? current.data?.bindings.filter((binding) => {
      const directory = taskConversationDirectory(owner.root, binding.taskDir)
      return binding.currentTaskRef === binding.taskRef && directory !== null && sameRelativeDocumentPath(owner.root, directory, key)
    }) ?? [] : []
  }, [owner, current.data])

  return { available, data: current.data, loading: current.loading && !current.data, refreshing: current.loading && current.data !== null,
    error: current.error, feedback: current.feedback, pendingTaskDir: current.pendingTaskDir, bindingsFor, refresh, discover, bind, setPrimary, unbind, open }
}

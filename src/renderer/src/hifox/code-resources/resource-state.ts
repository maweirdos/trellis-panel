import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { HifoxResourcePending } from '@shared/hifox-code-resources'
import { teamCodeResourceCommandSchema, type TeamCodeResourceCommand, type TeamCodeResourceCommandReply, type TeamCodeResourceList } from '@shared/team-code-resources'
import { api } from '../../api'
import { useInteractionActive, useInteractionGuard } from '../../utils/interaction-scope'
import { useHifox } from '../store'

type State = ReturnType<typeof useHifox.getState>
function identity(state: State, spaceId: string, taskId?: string): string {
  const context = state.workspaceContext, space = state.snapshot?.spaces.find((item) => item.id === spaceId)
  const task = state.snapshot?.tasks.find((item) => item.id === taskId)
  return JSON.stringify([context.key, context.instanceId, context.epoch, context.actorId, context.authorizationRevision, context.canManage, context.state,
    state.currentSpaceId, state.module, state.openTaskId, space?.archived, space?.memberIds, taskId, task?.createdAt, task?.spaceId, task?.workKind, task?.workflow?.handlerId, task?.assigneeIds])
}

/** Observe transitions synchronously, including a React-batched A → B → A. */
export function useResourceSurfaceKey(spaceId: string, taskId?: string): string {
  const [generation, setGeneration] = useState(0)
  useLayoutEffect(() => useHifox.subscribe((next, previous) => {
    if (identity(next, spaceId, taskId) !== identity(previous, spaceId, taskId)) setGeneration((value) => value + 1)
  }), [spaceId, taskId])
  return `${identity(useHifox.getState(), spaceId, taskId)}:${generation}`
}

export function useResourceOwner(spaceId: string, taskId?: string) {
  const [origin] = useState(() => identity(useHifox.getState(), spaceId, taskId))
  const [context] = useState(() => useHifox.getState().workspaceContext)
  const valid = useRef(true), mounted = useRef(false)
  const interact = useInteractionGuard()
  const active = useInteractionActive()
  useLayoutEffect(() => {
    mounted.current = true
    const inspect = (): void => { if (identity(useHifox.getState(), spaceId, taskId) !== origin) valid.current = false }
    inspect()
    const off = useHifox.subscribe(inspect)
    return () => { mounted.current = false; off() }
  }, [origin, spaceId, taskId])
  const alive = useCallback(() => mounted.current && valid.current && identity(useHifox.getState(), spaceId, taskId) === origin, [origin, spaceId, taskId])
  const owns = useCallback(() => alive() && interact(), [alive, interact])
  const task = useHifox.getState().snapshot?.tasks.find((item) => item.id === taskId)
  const draftKey = JSON.stringify([context.key, context.instanceId, context.epoch, context.actorId, spaceId, taskId, task?.createdAt])
  const bridge = api && Object.hasOwn(api, 'hifoxResources') ? api.hifoxResources : undefined
  return { owns, alive, active, context, draftKey, bridge, spaceId, taskId }
}
export type ResourceOwner = ReturnType<typeof useResourceOwner>

// Volatile drafts retain exact submitted bodies across navigation; never browser storage.
const drafts = new Map<string, unknown>()
export function useResourceDraft<T>(owner: ResourceOwner, name: string, initial: T): [T, (next: T) => void] {
  const key = `${owner.draftKey}:${name}`
  const [value, setValue] = useState<T>(() => drafts.has(key) ? drafts.get(key) as T : initial)
  return [value, (next) => { if (!owner.owns()) return; drafts.set(key, next); setValue(next) }]
}

export function useResourceList(owner: ResourceOwner, spaceId?: string, enabled = true) {
  const [page, setPage] = useState<TeamCodeResourceList | null>(null)
  const [loading, setLoading] = useState(false), [error, setError] = useState('')
  const request = useRef(0), busy = useRef(false)
  const load = useCallback(async (append = false): Promise<void> => {
    if (!owner.owns() || !owner.bridge || busy.current || !enabled || owner.context.state === 'local') return
    const ticket = ++request.current
    busy.current = true; setLoading(true); setError('')
    try {
      const cursor = append ? page?.nextCursor : undefined
      if (append && (!page?.hasMore || !cursor)) throw new Error('分页游标不可用，请重新加载资源')
      const reply = await owner.bridge.list({ workspaceKey: owner.context.key, ...(spaceId ? { spaceId } : {}), ...(cursor ? { cursor } : {}), limit: 100 })
      if (!owner.owns() || ticket !== request.current) return
      if (!reply.ok) {
        // Only a transport failure permits last-observed data; a denied or changed
        // source must not leave its private resource catalogue on screen.
        if (reply.code !== 'NETWORK_UNAVAILABLE') setPage(null)
        throw new Error(reply.error)
      }
      const next = reply.value
      if (append && page && (page.epoch !== next.epoch || page.authorizationRevision !== next.authorizationRevision || page.spaceResources?.revision !== next.spaceResources?.revision)) throw new Error('资源权限或空间关联已更新，请重新加载后核对草稿')
      if (next.hasMore && (!next.nextCursor || next.nextCursor === cursor)) throw new Error('未能取得下一页，资源列表尚不完整')
      setPage(append && page ? { ...next, items: [...new Map([...page.items, ...next.items].map((item) => [item.resourceId, item])).values()] } : next)
    } catch (cause) { if (owner.owns()) setError(cause instanceof Error ? cause.message : '资源读取失败') }
    finally { busy.current = false; if (owner.alive()) setLoading(false) }
  }, [owner.owns, owner.alive, owner.bridge, owner.context.key, owner.context.state, spaceId, page, enabled])
  useEffect(() => { void load(); /* Initial source load; paging is explicit. */ }, [owner.draftKey, spaceId, enabled, owner.active])
  return { page, loading, error, load }
}

type Intent = { command: TeamCodeResourceCommand; state: 'pending' | 'unknown' | 'rejected'; error: string | null }
export function useResourceCommands(owner: ResourceOwner, onCommitted: (reply: TeamCodeResourceCommandReply, original?: TeamCodeResourceCommand) => void, refreshAuthority: () => void) {
  const [intent, setIntent] = useResourceDraft<Intent | null>(owner, 'intent', null)
  const [pending, setPending] = useState<HifoxResourcePending[]>([])
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const inFlight = useRef(false)
  const refreshPending = useCallback(async (): Promise<void> => {
    if (!owner.owns() || !owner.bridge || owner.context.state === 'local') return
    try { const reply = await owner.bridge.pending({ workspaceKey: owner.context.key }); if (owner.owns()) { if (reply.ok) setPending(reply.value); else setError(reply.error) } }
    catch (cause) { if (owner.owns()) setError(cause instanceof Error ? cause.message : '待核对操作读取失败') }
  }, [owner.owns, owner.bridge, owner.context.key, owner.context.state])
  useEffect(() => { void refreshPending() }, [refreshPending, owner.active])
  const perform = async (commandId: string, mode: 'command' | 'reconcile' | 'retry', command?: TeamCodeResourceCommand): Promise<void> => {
    if (!owner.owns() || !owner.bridge || inFlight.current) return
    inFlight.current = true; setBusy(true); setError(''); setMessage('')
    try {
      const reply = mode === 'command' && command ? await owner.bridge.command({ workspaceKey: owner.context.key, command })
          : await owner.bridge[mode === 'reconcile' ? 'reconcile' : 'retry']({ workspaceKey: owner.context.key, commandId })
      if (!owner.owns()) return
      if (!reply.ok) {
        setError(reply.code === 'RESOURCE_IN_USE' ? '此任务仍绑定开发进度。请在桌面端核对当前执行并释放进度绑定，再重新核对代码资源；当前选择与草稿已保留。' : reply.error)
        const original = command ?? intent?.command
        if (original?.commandId === commandId) setIntent({ command: original, state: reply.outcomeUnknown || mode !== 'command' && intent?.state !== 'rejected' ? 'unknown' : 'rejected', error: reply.error })
      } else if (reply.value) {
        if (command || intent?.command.commandId === commandId) setIntent(null)
        setMessage('原操作已确认，正在核对当前资源。')
        const original = command ?? (intent?.command.commandId === commandId ? intent.command : undefined)
        onCommitted(reply.value, original)
      } else setMessage('尚未查到原操作回执；原内容和标识保留，可核对后重试。')
    } catch (cause) {
      if (owner.owns()) {
        const message = cause instanceof Error ? cause.message : '原操作结果未确认'
        setError(message)
        const original = command ?? intent?.command
        if (original?.commandId === commandId) setIntent({ command: original, state: 'unknown', error: message })
      }
    } finally { inFlight.current = false; if (owner.alive()) setBusy(false); if (owner.owns()) { void refreshPending(); refreshAuthority() } }
  }
  const submit = (makeCommand: (commandId: string) => TeamCodeResourceCommand): void => {
    if (!owner.owns() || inFlight.current || intent) return
    try {
      const command = teamCodeResourceCommandSchema.parse(makeCommand(crypto.randomUUID()))
      setIntent({ command, state: 'pending', error: null })
      void perform(command.commandId, 'command', command)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '请核对资源信息') }
  }
  const all = new Map(pending.map((entry) => [entry.commandId, entry]))
  if (intent) all.set(intent.command.commandId, { commandId: intent.command.commandId, kind: intent.command.kind, state: intent.state, createdAt: 0, error: intent.error })
  return { submit, intent, busy, error, message, pending: [...all.values()], refreshPending,
    recover: (id: string, retry: boolean) => void perform(id, retry ? 'retry' : 'reconcile'),
    editAgain: () => { if (intent?.state === 'rejected' && !busy) { setIntent(null); setError(''); setMessage('原操作记录已保留；请核对最新资源后提交修改。') } }
  }
}
export type ResourceCommands = ReturnType<typeof useResourceCommands>

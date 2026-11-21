import { useEscLayer } from '../utils/use-esc-layer'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type RefObject } from 'react'
import { Search } from 'lucide-react'
import type { ConversationTaskAction as Action, ConversationTaskResult, ConversationTaskTurn } from '@shared/conversation-task'
import { Button } from '../my/ui'
import { useCrux } from '../crux/store'
import type { CruxWorkspaceContext } from '@shared/crux-remote'
import type { CruxSnapshot } from '@shared/crux'
import { Select } from '../components/Select'
import { conversationClient, conversationValue } from './client'
import { readConversation } from './workspace'

const taskTurnEvent = 'conversation-task-turn-updated'

type TaskSpace = CruxSnapshot['spaces'][number]
type TaskAccount = Omit<CruxWorkspaceContext, 'actorId'> & { actorId: string }
type TaskContext = { spaces: TaskSpace[]; account: TaskAccount; tasks: CruxSnapshot['tasks']; selected: string }

export interface ConversationTaskReceiptProps {
  conversationId: string
  refreshKey?: string | number
  onOpenTask(taskId: string): void
  onUpdated?(result: ConversationTaskResult | null): void
}

export function ConversationTaskReceipt({ conversationId, refreshKey = '', onOpenTask, onUpdated }: ConversationTaskReceiptProps): JSX.Element | null {
  const [result, setResult] = useState<ConversationTaskResult | null>(null)
  const [attempt, setAttempt] = useState(0)
  const retryFailed = useRef(false)
  const updated = useRef(onUpdated); updated.current = onUpdated
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout> | undefined
    const client = conversationClient()
    if (!client?.taskAction) return
    const read = async (): Promise<void> => {
      let knownIntent = false
      try {
        let receipt = conversationValue(await client.taskAction(conversationId, { action: 'status' }))
        if (!live) return
        const retry = retryFailed.current; retryFailed.current = false
        if ((receipt.state === 'working' || retry && (receipt.state === 'failed' || receipt.state === 'unknown')) && receipt.spaceId) {
          knownIntent = true
          const account = useCrux.getState().workspaceContext
          if (!account.actorId) throw Error('请回到原任务空间核对创建结果。')
          receipt = conversationValue(await client.taskAction(conversationId, { action: retry && receipt.state === 'failed' ? 'create' : 'check', workspaceKey: account.key, actorId: account.actorId, spaceId: receipt.spaceId }))
        }
        if (!live) return
        setResult(receipt); updated.current?.(receipt)
        window.dispatchEvent(new CustomEvent(taskTurnEvent, { detail: { conversationId, turn: receipt.state === 'idle' ? undefined : receipt.turn } }))
        if (receipt.state === 'working') timer = setTimeout(() => void read(), 1500)
        if (receipt.state === 'bound') void useCrux.getState().bootstrap()
      } catch (cause) {
        if (live && knownIntent) setResult({ state: 'unknown', message: cause instanceof Error ? cause.message : '任务结果尚未确认' })
      }
    }
    void read()
    return () => { live = false; clearTimeout(timer) }
  }, [conversationId, refreshKey, attempt])
  if (!result || result.state === 'idle') return null
  if (result.state === 'bound') return <div className="my-activity-note" role="status"><button type="button" className="my-control my-button-ghost" title={result.title} onClick={() => onOpenTask(result.taskId)}>{result.origin === 'created' ? '已创建' : '已绑定'} {result.taskId}{result.title ? ` · ${result.title}` : ''}</button></div>
  return <div className="my-activity-note" role="status">{result.message}{result.state !== 'working' && <Button size="sm" variant="ghost" onClick={() => { retryFailed.current = true; setAttempt(n => n + 1) }}>{result.state === 'failed' ? '继续创建' : '核对结果'}</Button>}</div>
}

async function loadTaskContext(): Promise<TaskContext> {
  await useCrux.getState().bootstrap()
  const store = useCrux.getState(), account = store.workspaceContext
  const actorId = account.actorId
  if (!store.snapshot || store.loadError || !actorId || !['connected', 'local'].includes(account.state)) throw Error(store.loadError || '请连接任务所属的工作区。')
  const spaces = store.snapshot.spaces.filter(item => !item.archived && item.memberIds.includes(actorId))
  if (!spaces.length) throw Error('当前工作区没有可用空间，请先在团队空间中创建或加入空间。')
  if (!account.actorId) throw Error('当前工作区身份尚未确认。')
  const authorized: TaskAccount = { ...account, actorId }
  const selected = spaces.find(item => item.id === store.currentSpaceId)?.id ?? (spaces.length === 1 ? spaces[0].id : '')
  return { spaces, account: authorized, tasks: store.snapshot.tasks, selected }
}

export function ConversationTaskAction({ id, entryKey, mode, close, anchorRef, onCompleted }: { id: string; entryKey: string; mode: 'create' | 'bind'; close(): void; anchorRef?: RefObject<HTMLElement | null>; onCompleted?(): void }): JSX.Element {
  const [state, setState] = useState<ConversationTaskResult>()
  const [context, setContext] = useState<TaskContext>()
  const [target, setTarget] = useState('')
  const [spaceId, setSpaceId] = useState('')
  const [query, setQuery] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [request, setRequest] = useState<'create' | 'check' | 'bind'>(mode)
  const [error, setError] = useState('')
  const completed = useRef<(() => void) | undefined>(); completed.current = onCompleted
  useEffect(() => {
    let live = true
    void loadTaskContext().then(value => { if (live) { setContext(value); setSpaceId(value.selected) } }).catch(cause => { if (live) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { live = false }
  }, [id])
  useEffect(() => {
    if (!context || !spaceId || request === 'bind' && !target) return
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const run = async (action: Action['action']): Promise<void> => {
      const client = conversationClient(), account = context.account
      const actorId: string = account.actorId
      try {
        if (!client?.taskAction) throw Error('请重新打开桌面客户端以加载对话任务入口。')
        const task = context.tasks.find(item => item.id === target && item.spaceId === spaceId)
        if (mode === 'bind') {
          if (!task) throw Error('请选择原空间的任务。')
          const input: Action = { spaceId, workspaceKey: account.key, actorId, action: 'bind', taskId: task.id, taskCreatedAt: task.createdAt }
          const result = conversationValue(await client.taskAction(id, input))
          if (!live) return
          setError(''); setState(result)
          if (result.state === 'bound') completed.current?.()
          return
        }
        const input: Action = { spaceId, workspaceKey: account.key, actorId, action: action === 'create' ? 'create' : 'check' }
        const result = conversationValue(await client.taskAction(id, input))
        if (!live) return
        setError(''); setState(result); setQuery('')
        if (action === 'create') void readConversation(entryKey)
        window.dispatchEvent(new CustomEvent(taskTurnEvent, { detail: { conversationId: id, turn: result.state === 'idle' ? undefined : result.turn } }))
        if (result.state === 'working' && mode === 'create') { timer = setTimeout(() => void run('check'), 1500); return }
        if (result.state === 'bound') {
          const store = useCrux.getState()
          if (store.workspaceContext.key !== account.key || store.workspaceContext.actorId !== account.actorId) await store.bootstrap()
          else void store.bootstrap()
          completed.current?.()
        }
      } catch (cause) { if (live) setError(cause instanceof Error ? cause.message : '任务操作尚未确认') }
    }
    void run(request)
    return () => { live = false; clearTimeout(timer) }
  }, [context, spaceId, target, request, attempt, id, entryKey])
  if (!error && context && (!spaceId || mode === 'bind' && !target)) {
    if (mode === 'bind') return <TaskBindingChooser anchorRef={anchorRef} context={context} query={query} target={target} onQuery={setQuery} onSpace={setSpaceId} onTarget={setTarget} onClose={close} />
    return <div className="my-activity-note" role="status">选择任务空间<Select className="w-52" ariaLabel="选择空间" value={spaceId} onChange={setSpaceId} options={context.spaces.map(space => ({ value: space.id, label: space.name }))} /><Button size="sm" variant="ghost" onClick={close}>取消</Button></div>
  }
  return <div className="my-activity-note" role={error ? 'alert' : 'status'}>
    <span>{error || (state && state.state !== 'bound' ? state.message : '正在核对任务…')}</span>
    {(state?.state === 'unknown' || state?.state === 'failed' || error && context) && <Button size="sm" variant="ghost" onClick={() => { setRequest(state?.state === 'failed' ? 'create' : mode === 'bind' ? 'bind' : 'check'); setAttempt(n => n + 1) }}>{state?.state === 'failed' ? '继续创建' : '核对结果'}</Button>}
    <Button size="sm" variant="ghost" onClick={close}>收起</Button>
  </div>
}

function TaskBindingChooser({ anchorRef, context, query, onQuery, onSpace, onTarget, onClose }: {
  anchorRef?: RefObject<HTMLElement | null>
  context: TaskContext
  query: string
  target: string
  onQuery(value: string): void
  onSpace(value: string): void
  onTarget(value: string): void
  onClose(): void
}): JSX.Element {
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef(onClose); close.current = onClose
  useEscLayer(true, { kind: 'overlay', id: 'conversation-binding', onClose, returnFocusRef: anchorRef })
  useEffect(() => {
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !anchorRef?.current?.contains(event.target)) close.current()
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [anchorRef])
  const search = query.trim().toLocaleLowerCase()
  const spaces = new Map(context.spaces.map(space => [space.id, space.name]))
  const matches = context.tasks.filter(task => spaces.has(task.spaceId) && `${spaces.get(task.spaceId)} ${task.id} ${task.title}`.toLocaleLowerCase().includes(search))
  return <div ref={panel} role="region" aria-label="绑定已有任务" className="conversation-task-picker my-menu">
    <div className="flex items-center gap-2 p-2"><Search size={14} aria-hidden="true" /><input className="my-input min-w-0 flex-1" autoFocus aria-label="搜索可绑定任务" value={query} placeholder="搜索空间、编号或标题" onChange={event => onQuery(event.target.value)} /></div>
    <div role="group" aria-label="可绑定任务" className="my-scrollbar max-h-64 overflow-y-auto">
      {matches.map(task => <button key={task.id} type="button" className="my-menu-item" onClick={() => { onSpace(task.spaceId); onTarget(task.id) }}>{spaces.get(task.spaceId)} · {task.id} · {task.title}</button>)}
      {!matches.length && <p className="my-item-description p-2">没有找到匹配任务</p>}
    </div>
  </div>
}

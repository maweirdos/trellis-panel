import { useEffect, useRef, useState } from 'react'
import type { WorkTaskAction, WorkTaskActionValue } from '@shared/conversation/work-task-action'
import { api } from '../api'
import { useCrux } from '../crux/store'
import { Select } from '../components/Select'
import { Button, Modal } from '../my/ui'

interface WorkTaskActionsInput {
  root: string
  threadId: string | null | undefined
  enabled: boolean
}

type Mode = 'create' | 'bind'
type Intent = {
  mode: Mode
  commandId: string
  spaceId: string
  target?: { id: string; createdAt: string }
}

function readIntent(key: string): Intent | undefined {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (saved && typeof saved === 'object' && 'mode' in saved && (saved.mode === 'create' || saved.mode === 'bind')
      && 'commandId' in saved && typeof saved.commandId === 'string' && 'spaceId' in saved && typeof saved.spaceId === 'string') return saved as Intent
  } catch { /* The authoritative intent is held by desktop. */ }
  return undefined
}

export function useWorkTaskActions({ root, threadId, enabled }: WorkTaskActionsInput) {
  const context = useCrux(state => state.workspaceContext)
  const snapshot = useCrux(state => state.snapshot)
  const selectedSpace = useCrux(state => state.currentSpaceId)
  const key = JSON.stringify([context.key, context.actorId, context.instanceId, context.epoch, root, threadId])
  const [opened, setOpened] = useState<{ key: string; mode: Mode }>()
  useEffect(() => {
    if (enabled && typeof api.conversationWorkTaskAction === 'function' && !useCrux.getState().snapshot) {
      void useCrux.getState().bootstrap()
    }
  }, [enabled, root])
  const available = enabled && Boolean(threadId) && context.state === 'connected' && typeof api.conversationWorkTaskAction === 'function'
  const mode = opened?.key === key && available ? opened.mode : undefined
  const spaces = snapshot?.spaces.filter(space => !space.archived && context.actorId && space.memberIds.includes(context.actorId)) ?? []
  return {
    available,
    open: (requested: Mode) => { if (available) setOpened({ key, mode: requested }) },
    dialog: mode && threadId ? <WorkTaskActionDialog key={JSON.stringify([key, mode])} mode={mode} scopeKey={key} root={root} threadId={threadId}
      spaces={spaces} selectedSpace={selectedSpace} close={() => setOpened(undefined)} /> : null,
  }
}

function WorkTaskActionDialog({ mode, scopeKey, root, threadId, spaces, selectedSpace, close }: {
  mode: Mode; scopeKey: string; root: string; threadId: string; spaces: { id: string; name: string }[];
  selectedSpace?: string | null; close(): void
}) {
  const context = useCrux(state => state.workspaceContext)
  const tasks = useCrux(state => state.snapshot?.tasks)
  const key = `crux.work-task-action.${scopeKey}.${mode}`
  const [intent, setIntent] = useState(() => readIntent(key))
  const [spaceId, setSpaceId] = useState(intent?.spaceId ?? (spaces.some(space => space.id === selectedSpace) ? selectedSpace ?? '' : spaces[0]?.id ?? ''))
  const [targetId, setTargetId] = useState(intent?.target?.id ?? '')
  const [value, setValue] = useState<WorkTaskActionValue>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const live = useRef(false)
  const pending = useRef(false)
  const invoke = async (original: Intent, action: 'begin' | 'status' | 'publish' | 'retry'): Promise<void> => {
    const bridge = api.conversationWorkTaskAction
    if (!bridge || pending.current) return
    pending.current = true
    if (action !== 'status') setBusy(true)
    setError('')
    const base = { cwd: root, threadId, workspaceKey: context.key, commandId: original.commandId }
    try {
      let input: WorkTaskAction
      if (action === 'begin') {
        if (original.mode === 'bind' && !original.target) throw Error('请选择原空间的任务。')
        input = original.mode === 'bind' && original.target
          ? { ...base, action: 'bind', spaceId: original.spaceId, taskId: original.target.id, taskCreatedAt: original.target.createdAt }
          : { ...base, action: 'generate', spaceId: original.spaceId }
      } else if (action === 'publish') {
        if (value?.state !== 'candidate') throw Error('请确认当前候选。')
        input = { ...base, action, candidateRevision: value.candidateRevision }
      } else input = { ...base, action }
      const reply = await bridge(input)
      if (!live.current) return
      if (!reply.ok) { setError(reply.error); return }
      setValue(reply.value)
      if (reply.value.state === 'bound') void useCrux.getState().bootstrap()
    } catch (cause) {
      if (live.current) setError(cause instanceof Error ? cause.message : '任务操作原结果待核对。')
    } finally {
      pending.current = false
      if (live.current) setBusy(false)
    }
  }
  useEffect(() => {
    live.current = true
    if (intent) void invoke(intent, 'status')
    return () => { live.current = false }
  }, [])
  useEffect(() => {
    if (!intent || value?.state !== 'working') return
    const timer = setInterval(() => void invoke(intent, 'status'), 1400)
    return () => clearInterval(timer)
  }, [intent, value?.state])

  const begin = (): void => {
    const target = tasks?.find(task => task.id === targetId && task.spaceId === spaceId)
    if (!spaceId || mode === 'bind' && !target) return
    const original = intent ?? { mode, spaceId, commandId: crypto.randomUUID(), ...(target && { target: { id: target.id, createdAt: target.createdAt } }) }
    try { localStorage.setItem(key, JSON.stringify(original)) }
    catch { setError('无法保存原操作编号，请重试。'); return }
    setIntent(original)
    void invoke(original, 'begin')
  }
  const reset = (): void => {
    localStorage.removeItem(key)
    setIntent(undefined)
    setValue(undefined)
    setError('')
  }
  const title = mode === 'create' ? '将此对话转为任务' : '将此对话绑定到已有任务'
  return <Modal open ariaLabel={title} onClose={close}>
    <div className="space-y-4">
      <h2 className="my-item-title">{title}</h2>
      {!value || value.state === 'idle' ? <>
        <Select ariaLabel="任务空间" value={spaceId} options={spaces.map(space => ({ value: space.id, label: space.name }))}
          onChange={id => { setSpaceId(id); setTargetId('') }} disabled={Boolean(intent)} />
        {mode === 'bind' && <Select ariaLabel="已有任务" value={targetId}
          options={(tasks ?? []).filter(task => task.spaceId === spaceId).map(task => ({ value: task.id, label: `${task.id} · ${task.title}` }))}
          onChange={setTargetId} disabled={Boolean(intent)} />}
        <Button variant="primary" onClick={begin} disabled={busy || !spaceId || mode === 'bind' && !targetId}>
          {mode === 'create' ? '整理任务草稿' : '确认绑定'}
        </Button>
      </> : value.state === 'candidate' ? <>
        <h3 className="my-item-title">{value.title}</h3>
        <p className="my-chat-prose max-h-64 overflow-auto whitespace-pre-wrap">{value.description}</p>
        <Button variant="primary" disabled={busy || !intent} onClick={() => { if (intent) void invoke(intent, 'publish') }}>确认分享并创建任务</Button>
      </> : value.state === 'bound' ? <p role="status">已关联任务 {value.taskId}</p>
        : <>
          <p role="status">{value.detail}</p>
          {value.state === 'failed' && <Button variant="ghost" disabled={busy} onClick={reset}>重新整理</Button>}
          {value.state === 'unknown' && intent && <div className="flex gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => void invoke(intent, 'status')}>核对原回执</Button>
            {value.canRetry && <Button variant="ghost" disabled={busy} onClick={() => void invoke(intent, 'retry')}>重试原团队命令</Button>}
          </div>}
        </>}
      {error && <p role="alert">{error}</p>}
    </div>
  </Modal>
}

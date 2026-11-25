import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CruxWorkspaceContext } from '@shared/crux-remote'
import type { WorkTaskAction, WorkTaskActionValue } from '@shared/conversation/work-task-action'
import { api } from '../api'
import { useCrux } from '../crux/store'
import { useApp } from '../store'
import { canReadTaskSpace } from '../crux/pages/task-detail/use-task-source'
import { Select } from '../components/Select'
import { Button, Modal } from '../my/ui'
import { useInteractionGuard } from '../utils/interaction-scope'
import { updateComposerDraft } from './useComposerDraft'
import type { ComposerSendState, ComposerWorkTaskSelection } from './useComposerSend'

interface WorkTaskActionsInput {
  root: string
  threadId: string | null | undefined
  enabled: boolean
  isWork: boolean
  draftKey: string
  draftSelection?: ComposerWorkTaskSelection
  canPreselect: boolean
}

type Mode = 'create' | 'bind'
type Intent = {
  mode: Mode
  commandId: string
  spaceId: string
  target?: { id: string; createdAt: string }
  authorizationRevision?: number
}

function authorityKey(context: CruxWorkspaceContext): string {
  return JSON.stringify([context.state, context.key, context.actorId, context.connectionId,
    context.instanceId, context.epoch, context.authorizationRevision])
}

function threadKey(context: CruxWorkspaceContext, root: string, threadId: string | null | undefined): string {
  return JSON.stringify([context.key, context.actorId, context.instanceId, context.epoch, root, threadId])
}

const intentKey = (scope: string, mode: Mode): string => `crux.work-task-action.${scope}.${mode}`

function canEditSelection(state: ComposerSendState): boolean {
  return state.phase === 'idle' || (state.phase === 'rejected' && state.restored)
}

function readIntent(key: string): Intent | undefined {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (saved && typeof saved === 'object' && 'mode' in saved && (saved.mode === 'create' || saved.mode === 'bind')
      && 'commandId' in saved && typeof saved.commandId === 'string' && 'spaceId' in saved && typeof saved.spaceId === 'string') return saved as Intent
  } catch { /* The authoritative intent is held by desktop. */ }
  return undefined
}

export function useWorkTaskActions({ root, threadId, enabled, isWork, draftKey, draftSelection, canPreselect }: WorkTaskActionsInput) {
  const context = useCrux(state => state.workspaceContext)
  const snapshot = useCrux(state => state.snapshot)
  const selectedSpace = useCrux(state => state.currentSpaceId)
  const loadError = useCrux(state => state.loadError)
  const key = threadKey(context, root, threadId)
  const canInteract = useInteractionGuard()
  const [session, setSession] = useState(() => crypto.randomUUID())
  const liveSession = useRef(session)
  const liveLookup = useRef({ key, authority: authorityKey(context) })
  liveLookup.current = { key, authority: authorityKey(context) }
  const authority = JSON.stringify([session, liveLookup.current.authority])
  const [opened, setOpened] = useState<{ key: string; authority: string; mode: Mode }>()
  useLayoutEffect(() => {
    if (!isWork) return
    return useCrux.subscribe((next, previous) => {
      if (authorityKey(next.workspaceContext) === authorityKey(previous.workspaceContext)) return
      liveSession.current = crypto.randomUUID()
      setSession(liveSession.current)
    })
  }, [isWork])
  const linkedTask = isWork && threadId && context.state === 'connected' && !loadError && context.actorId
    ? snapshot?.tasks.find(task => task.conversations?.some(link => link.id === threadId && link.actorId === context.actorId))
    : undefined
  useEffect(() => {
    if (isWork && enabled && typeof api.conversationWorkTaskAction === 'function' && !useCrux.getState().snapshot) {
      void useCrux.getState().bootstrap()
    }
  }, [isWork, enabled, root])
  const spaces = context.state === 'connected' && !loadError
    ? snapshot?.spaces.filter(space => !space.archived && context.actorId && space.memberIds.includes(context.actorId)) ?? []
    : []
  const reason = !enabled ? '当前会话只读或已归档，不能关联团队任务。'
    : context.state === 'access-revoked' ? '团队访问权限已失效，请重新登录。'
      : context.state !== 'connected' ? '尚未连接团队，暂时无法关联任务。'
        : loadError ? '无法核对当前团队权限。'
          : !snapshot ? '正在读取团队空间。'
            : typeof api.conversationWorkTaskAction !== 'function' ? '当前版本无法关联团队任务。'
              : spaces.length === 0 ? '当前账号没有可关联的团队空间。' : undefined
  const bindReason = reason ?? (!snapshot?.tasks.some(task => spaces.some(space => space.id === task.spaceId))
    ? '没有可关联的团队任务。' : !threadId && (context.authorizationRevision === undefined || !canPreselect)
      ? '当前草稿正在确认发送结果，或团队授权尚未就绪。' : undefined)
  const createReason = reason ?? (!threadId ? '发送首条消息后即可创建任务。' : undefined)
  const linkedSpace = linkedTask ? snapshot?.spaces.find(space => space.id === linkedTask.spaceId) : undefined
  const linkedReason = !linkedTask ? undefined
    : !snapshot || !linkedSpace || !canReadTaskSpace(snapshot, context, linkedSpace.id) ? '当前账号已无权查看原任务。'
      : linkedSpace.archived ? '原任务所在空间已归档。' : undefined
  const mode = opened?.key === key && opened.authority === authority && !reason ? opened.mode : undefined
  const pending = !threadId && draftSelection?.authority === authority
    ? snapshot?.tasks.find(task => task.id === draftSelection.taskId && task.createdAt === draftSelection.taskCreatedAt &&
      spaces.some(space => space.id === task.spaceId && space.id === draftSelection.spaceId))
    : undefined
  const current = (): boolean => canInteract() && liveSession.current === session &&
    authorityKey(useCrux.getState().workspaceContext) === liveLookup.current.authority && liveLookup.current.key === key

  const bindAfterSend = (acceptedThreadId: string, selection: ComposerWorkTaskSelection): void => {
    if (!isWork || threadId || !current()) return
    // The preselect is only ever offered behind this reason, but the bridge can be
    // missing on a stale host: refuse before writing the intent record.
    if (typeof api.conversationWorkTaskAction !== 'function') {
      useApp.getState().pushToast({ kind: 'error', title: '未关联团队任务', body: '当前版本无法关联团队任务。' })
      return
    }
    if (selection.authority !== authority) {
      useApp.getState().pushToast({ kind: 'error', title: '未关联团队任务', body: '团队授权已变化，请重新选择。' })
      return
    }
    const state = useCrux.getState()
    const original = state.snapshot?.tasks.find(task => task.id === selection.taskId && task.spaceId === selection.spaceId &&
      task.createdAt === selection.taskCreatedAt)
    if (!original || !state.snapshot || state.loadError || !canReadTaskSpace(state.snapshot, state.workspaceContext, selection.spaceId)) {
      useApp.getState().pushToast({ kind: 'error', title: '未关联团队任务', body: '原任务已变化，请重新选择。' })
      return
    }
    const intent: Intent = { mode: 'bind', commandId: selection.commandId, spaceId: selection.spaceId,
      target: { id: selection.taskId, createdAt: selection.taskCreatedAt }, authorizationRevision: selection.authorizationRevision }
    const nextKey = threadKey(context, root, acceptedThreadId)
    try { localStorage.setItem(intentKey(nextKey, 'bind'), JSON.stringify(intent)) }
    catch {
      useApp.getState().pushToast({ kind: 'error', title: '未关联团队任务', body: '无法保存原操作编号，请重新选择。' })
      return
    }
    void api.conversationWorkTaskAction({
      action: 'bind', cwd: root, threadId: acceptedThreadId, workspaceKey: context.key, commandId: intent.commandId,
      spaceId: selection.spaceId, taskId: selection.taskId, taskCreatedAt: selection.taskCreatedAt,
      expectedAuthorizationRevision: selection.authorizationRevision,
    }).then(reply => {
      if (liveSession.current !== session || authorityKey(useCrux.getState().workspaceContext) !== authorityKey(context)) return
      if (reply.ok && reply.value.state === 'bound') void useCrux.getState().bootstrap()
      else useApp.getState().pushToast({ kind: 'error', title: '未确认任务关联', body: '在原会话的加号菜单中核对关联结果。' })
    }).catch(() => {
      if (liveSession.current === session && authorityKey(useCrux.getState().workspaceContext) === authorityKey(context)) {
        useApp.getState().pushToast({ kind: 'error', title: '任务关联结果待核对', body: '从原会话打开「关联已有团队任务」。' })
      }
    })
  }
  return {
    bindReason,
    createReason,
    linkedTask: linkedReason ? undefined : linkedTask,
    linkedReason,
    pendingTitle: pending?.title,
    needsReselection: Boolean(!threadId && canPreselect && draftSelection && !pending && !reason),
    clearPending: () => {
      if (current() && !threadId) updateComposerDraft(draftKey, draft =>
        draft.workTask && canEditSelection(draft.state) ? { ...draft, workTask: undefined } : draft)
    },
    bindAfterSend,
    open: (requested: Mode) => {
      if (current() && !(requested === 'bind' ? bindReason : createReason)) setOpened({ key, authority, mode: requested })
    },
    view: () => {
      if (!current() || !linkedTask || linkedReason) return
      const crux = useCrux.getState()
      if (crux.loadError || !crux.snapshot || !canReadTaskSpace(crux.snapshot, crux.workspaceContext, linkedTask.spaceId) ||
        !crux.snapshot.tasks.some(task => task.id === linkedTask.id && task.createdAt === linkedTask.createdAt &&
          task.conversations?.some(link => link.id === threadId && link.actorId === context.actorId))) return
      crux.setModule('tasks')
      crux.openTask(linkedTask.id)
      useApp.getState().setPage('crux')
    },
    dialog: mode ? <WorkTaskActionDialog key={JSON.stringify([key, mode])} mode={mode} scopeKey={key} root={root} threadId={threadId ?? undefined}
      spaces={spaces} selectedSpace={selectedSpace} current={current} preselection={pending}
      onPreselect={(spaceId, target) => {
        if (!current() || !canPreselect || threadId || context.authorizationRevision === undefined) return
        const selection: ComposerWorkTaskSelection = { authority, commandId: crypto.randomUUID(), authorizationRevision: context.authorizationRevision,
          spaceId, taskId: target.id, taskCreatedAt: target.createdAt }
        const draft = updateComposerDraft(draftKey, currentDraft =>
          canEditSelection(currentDraft.state) ? { ...currentDraft, workTask: selection } : currentDraft)
        if (draft.workTask?.commandId === selection.commandId) setOpened(undefined)
      }} close={() => setOpened(undefined)} /> : null,
  }
}

function WorkTaskActionDialog({ mode, scopeKey, root, threadId, spaces, selectedSpace, current, preselection, onPreselect, close }: {
  mode: Mode; scopeKey: string; root: string; threadId?: string; spaces: { id: string; name: string }[];
  selectedSpace?: string | null; current(): boolean; preselection?: { id: string; spaceId: string }
  onPreselect(spaceId: string, target: { id: string; createdAt: string }): void; close(): void
}) {
  const context = useCrux(state => state.workspaceContext)
  const tasks = useCrux(state => state.snapshot?.tasks)
  const key = intentKey(scopeKey, mode)
  const [intent, setIntent] = useState(() => threadId ? readIntent(key) : undefined)
  const [spaceId, setSpaceId] = useState(intent?.spaceId ?? preselection?.spaceId ?? (spaces.some(space => space.id === selectedSpace) ? selectedSpace ?? '' : spaces[0]?.id ?? ''))
  const [targetId, setTargetId] = useState(intent?.target?.id ?? preselection?.id ?? '')
  const [value, setValue] = useState<WorkTaskActionValue>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const live = useRef(false)
  const pending = useRef(false)
  const invoke = async (original: Intent, action: 'begin' | 'status' | 'publish' | 'retry'): Promise<void> => {
    const bridge = api.conversationWorkTaskAction
    if (!bridge || !threadId || !current() || pending.current) return
    pending.current = true
    if (action !== 'status') setBusy(true)
    setError('')
    const base = { cwd: root, threadId, workspaceKey: context.key, commandId: original.commandId }
    try {
      let input: WorkTaskAction
      if (action === 'begin') {
        if (original.mode === 'bind' && !original.target) throw Error('请选择原空间的任务。')
        input = original.mode === 'bind' && original.target
          ? { ...base, action: 'bind', spaceId: original.spaceId, taskId: original.target.id, taskCreatedAt: original.target.createdAt,
            ...(original.authorizationRevision !== undefined && { expectedAuthorizationRevision: original.authorizationRevision }) }
          : { ...base, action: 'generate', spaceId: original.spaceId }
      } else if (action === 'publish') {
        if (value?.state !== 'candidate') throw Error('请确认当前候选。')
        input = { ...base, action, candidateRevision: value.candidateRevision }
      } else input = { ...base, action }
      const reply = await bridge(input)
      if (!live.current || !current()) return
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
    if (!current() || !spaces.some(space => space.id === spaceId) || mode === 'bind' && !target) return
    if (!threadId && target) { onPreselect(spaceId, target); return }
    const original = intent ?? { mode, spaceId, commandId: crypto.randomUUID(),
      ...(target && { target: { id: target.id, createdAt: target.createdAt }, authorizationRevision: context.authorizationRevision }) }
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
  const title = mode === 'create' ? '从此对话创建任务' : '关联已有团队任务'
  return <Modal open ariaLabel={title} onClose={close}>
    <div className="space-y-4">
      <h2 className="my-item-title">{title}</h2>
      {!value || value.state === 'idle' ? <>
        <Select ariaLabel="任务空间" value={spaceId} options={spaces.map(space => ({ value: space.id, label: space.name }))}
          onChange={id => { setSpaceId(id); setTargetId('') }} disabled={Boolean(intent)} />
        {!threadId && <p className="my-item-description">发送首条消息并确认受理后，才会关联所选任务。</p>}
        {mode === 'bind' && <Select ariaLabel="已有任务" value={targetId}
          options={(tasks ?? []).filter(task => task.spaceId === spaceId && spaces.some(space => space.id === spaceId))
            .map(task => ({ value: task.id, label: `${task.id} · ${task.title}` }))}
          onChange={setTargetId} disabled={Boolean(intent)} />}
        <Button variant="primary" onClick={begin} disabled={busy || !spaceId || mode === 'bind' && !targetId}>
          {mode === 'create' ? '用当前模型整理草稿' : threadId ? '确认关联' : '发送后关联'}
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

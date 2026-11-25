import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { CodeTaskActionValue, CodeTaskSummary, ComposerCodeTaskSelection } from '../../../shared/conversation/code-task-action'
import { api, hasIpc } from '../api'
import { Select } from '../components/Select'
import { projectRootKey } from '../my/navigation'
import { useApp } from '../store'
import { FeedbackNotice } from '../my/FeedbackNotice'
import { Button, Modal } from '../my/ui'
import { useInteractionGuard } from '../utils/interaction-scope'
import type { ComposerTaskSection } from './ComposerAddMenu'

interface CodeTaskActionsInput {
  readonly root: string
  readonly threadId: string | null | undefined
  readonly enabled: boolean
  readonly draftKey: string
  readonly draftSelection?: ComposerCodeTaskSelection
  readonly canPreselect?: boolean
  readonly onPreselect?: (selection: ComposerCodeTaskSelection) => void
  readonly onClearSelection?: () => void
}

interface CodeTaskActions {
  readonly taskSection: ComposerTaskSection
  readonly dialog: ReactNode
  readonly bindAfterSend: (acceptedThreadId: string, selection: ComposerCodeTaskSelection) => void
}

type BoundValue = Extract<CodeTaskActionValue, { state: 'bound' }>

const receiptKey = (scope: string): string => `crux.conversation.code-task-receipt.v1:${scope}`

function readReceipt(scope: string): string | null {
  try {
    const commandId = localStorage.getItem(receiptKey(scope))
    return commandId && /^[0-9a-f-]{36}$/iu.test(commandId) ? commandId : null
  } catch { return null }
}

function clearReceipt(scope: string, commandId: string): void {
  try {
    if (readReceipt(scope) === commandId) localStorage.removeItem(receiptKey(scope))
  } catch {}
}

export function useCodeTaskActions({
  root, threadId, enabled, draftKey, draftSelection, canPreselect = false, onPreselect, onClearSelection,
}: CodeTaskActionsInput): CodeTaskActions {
  const bridge = hasIpc ? api.conversationCodeTaskAction : undefined
  const authority = projectRootKey(root) ?? root
  const scopeKey = JSON.stringify([authority, threadId ?? draftKey])
  const canInteract = useInteractionGuard()
  const mounted = useRef(false)
  const liveScope = useRef(scopeKey)
  liveScope.current = scopeKey
  const writing = useRef(new Set<string>())
  const requestSequence = useRef(0)
  const [linked, setLinked] = useState<{ key: string; value?: BoundValue }>()
  const [linkedIssue, setLinkedIssue] = useState<{ key: string; detail: string }>()
  const [opened, setOpened] = useState<{ key: string }>()
  const [revision, setRevision] = useState(0)

  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (!bridge || !threadId || writing.current.has(scopeKey)) return
    const sequence = ++requestSequence.current
    const key = scopeKey
    let active = true
    const read = async (): Promise<void> => {
      try {
        const commandId = readReceipt(key)
        const reply = await bridge({ action: 'status', cwd: root, threadId, ...(commandId && { commandId }) })
        if (!active || liveScope.current !== key || sequence !== requestSequence.current) return
        if (!reply.ok) throw Error(reply.error)
        if (reply.value.state === 'tasks') throw Error('无法核对本地任务关联状态。')
        if (reply.value.state === 'bound' && commandId) clearReceipt(key, commandId)
        setLinked(reply.value.state === 'bound' ? { key, value: reply.value } : { key })
        setLinkedIssue(reply.value.state === 'bound' ? undefined : { key, detail: reply.value.detail })
      } catch (cause) {
        if (!active || liveScope.current !== key || sequence !== requestSequence.current) return
        setLinked({ key })
        setLinkedIssue({ key, detail: cause instanceof Error ? cause.message : '本地任务关联状态待核对。' })
      }
    }
    void read()
    return () => { active = false }
  }, [bridge, root, revision, scopeKey, threadId])

  const current = useCallback((): boolean => mounted.current && canInteract() && liveScope.current === scopeKey
    && projectRootKey(useApp.getState().snapshot?.meta.root) === authority, [authority, canInteract, scopeKey])

  const pendingSelection = !threadId && draftSelection?.authority === authority ? draftSelection : undefined
  const linkedTask = linked?.key === scopeKey ? linked.value : undefined
  const statusIssue = linkedIssue?.key === scopeKey ? linkedIssue.detail : undefined
  const bridgeReason = !bridge ? '当前版本无法关联本地任务。' : undefined
  const bindReason = bridgeReason ?? (!enabled ? '当前会话只读或已归档，不能关联本地任务。'
    : !threadId && !canPreselect ? '请先核对当前发送结果。' : undefined)
  const pendingReceipt = threadId ? readReceipt(scopeKey) : null
  const bindAfterSend = useCallback((acceptedThreadId: string, selection: ComposerCodeTaskSelection): void => {
    if (!bridge || !current()) return
    if (selection.authority !== authority) {
      useApp.getState().pushToast({ kind: 'error', title: '未关联本地任务', body: '任务选择已变化，请重新选择。' })
      return
    }
    const nextScope = JSON.stringify([authority, acceptedThreadId])
    try { localStorage.setItem(receiptKey(nextScope), selection.commandId) }
    catch {
      useApp.getState().pushToast({ kind: 'error', title: '未关联本地任务', body: '无法保留原关联编号。' })
      return
    }
    writing.current.add(nextScope)
    void bridge({
      action: 'bind', cwd: root, threadId: acceptedThreadId, commandId: selection.commandId,
      taskDir: selection.taskDir, taskRef: selection.taskRef, taskIdentity: selection.taskIdentity,
    }).then(reply => {
      if (reply.ok) clearReceipt(nextScope, selection.commandId)
      if (liveScope.current !== nextScope || !canInteract()) return
      if (!reply.ok) setLinkedIssue({ key: nextScope, detail: reply.error })
      else if (reply.value.state === 'bound') setLinked({ key: nextScope, value: reply.value })
      else setLinkedIssue({ key: nextScope, detail: reply.value.state === 'tasks' ? '无法核对本地任务关联状态。' : reply.value.detail })
    }).catch(cause => {
      if (liveScope.current !== nextScope || !canInteract()) return
      setLinkedIssue({ key: nextScope, detail: cause instanceof Error ? cause.message : '本地任务关联结果待核对。' })
    }).finally(() => {
      writing.current.delete(nextScope)
      if (liveScope.current === nextScope && canInteract()) setRevision(value => value + 1)
    })
  }, [authority, bridge, canInteract, current, root])

  const clearPending = useCallback((): void => {
    if (current()) onClearSelection?.()
  }, [current, onClearSelection])

  const taskSection = useMemo(() => {
    if (linkedTask) {
      return {
        label: `查看本地任务 · ${linkedTask.title}`,
        onView: () => {
          if (!current() || !bridge || !threadId) return
          void bridge({ action: 'status', cwd: root, threadId }).then(reply => {
            if (!current()) return
            if (!reply.ok || reply.value.state !== 'bound' || reply.value.taskRef !== linkedTask.taskRef ||
              reply.value.taskDir !== linkedTask.taskDir || !useApp.getState().snapshot?.tasks.some(item => item.dirName === linkedTask.taskDir)) {
              throw Error('原任务详情已不可用，请刷新工程后核对。')
            }
            useApp.getState().setPage('tasks')
            useApp.getState().showTask(linkedTask.taskDir, false)
          }).catch(cause => {
            if (current()) useApp.getState().pushToast({ kind: 'error', title: '无法打开本地任务', body: cause instanceof Error ? cause.message : undefined })
          })
        },
      }
    }
    if (pendingReceipt && threadId) {
      return {
        label: '当前会话',
        actions: [{
          label: '核对本地任务关联…',
          icon: 'link' as const,
          description: statusIssue,
          disabledReason: writing.current.has(scopeKey) ? '正在关联原本地任务。' : bridgeReason,
          onSelect: () => {
            if (!bridge || !current() || writing.current.has(scopeKey)) return
            writing.current.add(scopeKey)
            void bridge({ action: 'status', cwd: root, threadId, commandId: pendingReceipt }).then(reply => {
              if (!current()) return
              if (!reply.ok || reply.value.state === 'tasks') throw Error('原本地任务关联回执仍不可用。')
              clearReceipt(scopeKey, pendingReceipt)
              if (reply.value.state === 'bound') setLinked({ key: scopeKey, value: reply.value })
              else setLinkedIssue({ key: scopeKey, detail: reply.value.detail })
            }).catch(cause => {
              if (current()) useApp.getState().pushToast({ kind: 'error', title: '关联结果待核对', body: cause instanceof Error ? cause.message : undefined })
            }).finally(() => {
              writing.current.delete(scopeKey)
              if (current()) setRevision(value => value + 1)
            })
          },
        }],
      }
    }
    const actions = [
      ...(pendingSelection ? [{
        label: `取消待关联 · ${pendingSelection.title}`,
        icon: 'link' as const,
        onSelect: clearPending,
        description: '只取消草稿预选，不发送消息。',
        disabledReason: bindReason,
      }] : []),
      {
        label: '关联本地工程任务…',
        icon: 'link' as const,
        onSelect: () => { if (current() && !bindReason) setOpened({ key: scopeKey }) },
        description: statusIssue,
        disabledReason: bindReason,
      },
    ]
    return {
      label: '当前会话',
      description: '关联本机受信工程的 Trellis 任务。',
      disabledReason: undefined,
      actions,
    }
  }, [bindReason, bridge, bridgeReason, clearPending, current, linkedTask, pendingReceipt, pendingSelection, root, scopeKey, statusIssue, threadId])

  const dialog = opened?.key === scopeKey && enabled ? <CodeTaskDialog
    key={scopeKey}
    root={root}
    threadId={threadId ?? undefined}
    draftSelection={pendingSelection}
    canPreselect={canPreselect && !threadId}
    onClose={() => setOpened(undefined)}
    onPreselect={selection => {
      if (!current() || !canPreselect || threadId) return
      onPreselect?.(selection)
      setOpened(undefined)
    }}
    onBound={value => setLinked({ key: scopeKey, value })}
    onIssue={detail => setLinkedIssue({ key: scopeKey, detail })}
  /> : null

  return {
    taskSection,
    dialog,
    bindAfterSend,
  }
}

function CodeTaskDialog({
  root, threadId, draftSelection, canPreselect, onClose, onPreselect, onBound, onIssue,
}: {
  root: string
  threadId?: string
  draftSelection?: ComposerCodeTaskSelection
  canPreselect: boolean
  onClose: () => void
  onPreselect: (selection: ComposerCodeTaskSelection) => void
  onBound: (value: BoundValue) => void
  onIssue: (detail: string) => void
}) {
  const bridge = hasIpc ? api.conversationCodeTaskAction : undefined
  const authority = projectRootKey(root) ?? root
  const [tasks, setTasks] = useState<readonly CodeTaskSummary[]>()
  const [truncated, setTruncated] = useState(false)
  const [listIssue, setListIssue] = useState('')
  const [targetId, setTargetId] = useState(draftSelection?.taskDir ?? '')
  const [value, setValue] = useState<CodeTaskActionValue>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState<ComposerCodeTaskSelection>()
  const mounted = useRef(false)

  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    const action = api.conversationCodeTaskAction
    if (!action) return
    let active = true
    const read = async (): Promise<void> => {
      try {
        const reply = await action({ action: 'list', cwd: root })
        if (!active) return
        if (!reply.ok) throw Error(reply.error)
        if (reply.value.state !== 'tasks') throw Error('本地任务列表不可用。')
        setTasks(reply.value.tasks)
        setTruncated(reply.value.truncated)
        setListIssue('')
      } catch (cause) {
        if (!active) return
        setTasks([])
        setListIssue(cause instanceof Error ? cause.message : '读取本地任务失败。')
      }
    }
    void read()
    return () => { active = false }
  }, [root])

  const invoke = async (selection: ComposerCodeTaskSelection, check = false): Promise<void> => {
    const action = api.conversationCodeTaskAction
    if (!action || !threadId || busy) return
    setBusy(true)
    setError('')
    setAttempt(selection)
    const receiptScope = JSON.stringify([authority, threadId])
    try {
      if (!check) localStorage.setItem(receiptKey(receiptScope), selection.commandId)
      const reply = await action(check ? {
        action: 'status', cwd: root, threadId, commandId: selection.commandId,
      } : {
        action: 'bind', cwd: root, threadId, commandId: selection.commandId,
        taskDir: selection.taskDir, taskRef: selection.taskRef, taskIdentity: selection.taskIdentity,
      })
      if (!mounted.current) return
      if (!reply.ok) throw Error(reply.error)
      if (reply.value.state === 'tasks') throw Error('无法核对本地任务关联状态。')
      clearReceipt(receiptScope, selection.commandId)
      setValue(reply.value)
      if (reply.value.state === 'bound') onBound(reply.value)
      else {
        onIssue(reply.value.detail)
        if (reply.value.state === 'failed' || reply.value.state === 'conflict' || reply.value.state === 'idle') setAttempt(undefined)
      }
    } catch (cause) {
      if (mounted.current) {
        const detail = cause instanceof Error ? cause.message : '本地任务关联结果待核对。'
        setError(detail)
        onIssue(detail)
      }
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const selected = tasks?.find(task => task.taskDir === targetId)
  const selectionFor = (task: CodeTaskSummary): ComposerCodeTaskSelection => {
    if (draftSelection?.taskDir === task.taskDir && draftSelection.taskRef === task.taskRef && draftSelection.taskIdentity === task.taskIdentity
      && draftSelection.authority === authority) return draftSelection
    return {
      authority,
      commandId: crypto.randomUUID(),
      taskDir: task.taskDir,
      taskRef: task.taskRef,
      taskIdentity: task.taskIdentity,
      title: task.title,
    }
  }
  const submit = (): void => {
    if (!selected) return
    const selection = selectionFor(selected)
    if (!threadId) {
      if (!canPreselect) return
      onPreselect(selection)
      return
    }
    void invoke(selection)
  }
  const title = threadId ? '关联本地工程任务' : '发送后关联本地任务'
  return <Modal open ariaLabel={title} onClose={onClose} width={480}>
    <div className="space-y-4 p-4">
      <h2 className="my-item-title">{title}</h2>
      {value?.state === 'bound' ? <p role="status">已关联任务 {value.title}</p>
        : <>
          <Select
            ariaLabel="本地工程任务"
            value={targetId}
            options={(tasks ?? []).map(task => ({ value: task.taskDir, label: task.title }))}
            onChange={setTargetId}
            disabled={busy || Boolean(attempt)}
            emptyContent={listIssue || '当前工程没有可用本地任务。'}
          />
          {truncated && <p className="my-item-description">任务较多，仅显示前 200 个。</p>}
          {!threadId && <p className="my-item-description">发送首条消息并确认受理后，才会关联所选任务。</p>}
          <Button variant="primary" disabled={busy || Boolean(attempt) || !selected} onClick={submit}>
            {threadId ? '确认关联' : '发送后关联'}
          </Button>
          {value && (value.state === 'conflict' || value.state === 'failed') && <FeedbackNotice
            variant="inline" title="无法完成关联" description={value.detail} />}
        </>}
      {error && value?.state !== 'bound' && <FeedbackNotice variant="inline" title="关联结果待核对" description={error} />}
      {attempt && value?.state !== 'bound' && !busy && <Button size="sm" variant="ghost"
        onClick={() => void invoke(attempt, true)}>核对原回执</Button>}
      <div className="flex justify-end">
        <Button variant="ghost" onClick={onClose}>关闭</Button>
      </div>
    </div>
  </Modal>
}

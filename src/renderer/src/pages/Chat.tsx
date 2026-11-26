import { Suspense, useEffect, useState, type JSX } from 'react'
import { FolderOpen } from 'lucide-react'
import { api, hasIpc } from '../api'
import { StartupContentCommit } from '../daemon/StartupContext'
import { PageLoading } from '../my/layout/PageLoading'
import { useMy } from '../my/store'
import { FeedbackNotice } from '../my/FeedbackNotice'
import { Button, EmptyState } from '../my/ui'
import { useApp } from '../store'
import { useTaskWorkThread } from '../conversation-workbench/task-work-navigation'
import { ThreadRouteView } from '../conversation-workbench/ThreadRouteView'

const WORK_ROOT_STORAGE_KEY = 'crux.conversation.workRoot.v1'
let retainedWorkRoot: string | undefined = (() => {
  try { return localStorage.getItem(WORK_ROOT_STORAGE_KEY) || undefined } catch { return undefined }
})()
let workRootInflight: Promise<string | undefined> | undefined

export function preloadWorkConversationRoot(): Promise<string | undefined> {
  if (!hasIpc) return Promise.resolve(undefined)
  if (workRootInflight) return workRootInflight
  const pending = api.conversationWorkRoot().then(result => {
    if (result.ok && result.root) {
      retainedWorkRoot = result.root
      try { localStorage.setItem(WORK_ROOT_STORAGE_KEY, result.root) } catch { /* ignore */ }
      return result.root
    }
    return undefined
  }).catch(() => undefined).finally(() => {
    if (workRootInflight === pending) workRootInflight = undefined
  })
  workRootInflight = pending
  return pending
}

function WorkConversation({ active }: { active: boolean }): JSX.Element {
  const [root, setRoot] = useState<string | undefined>(() => retainedWorkRoot)
  const [issue, setIssue] = useState('')
  const [retry, setRetry] = useState(0)
  const taskThread = useTaskWorkThread(root)

  useEffect(() => {
    if (!active || !hasIpc) return
    let current = true
    void api.conversationWorkRoot().then(result => {
      if (!current) return
      if (result.ok) {
        retainedWorkRoot = result.root
        try { localStorage.setItem(WORK_ROOT_STORAGE_KEY, result.root) } catch { /* ignore */ }
        setRoot(prev => prev === result.root ? prev : result.root)
        setIssue('')
      } else {
        retainedWorkRoot = undefined
        try { localStorage.removeItem(WORK_ROOT_STORAGE_KEY) } catch { /* ignore */ }
        setRoot(undefined)
        setIssue(result.error)
      }
    }).catch(() => { if (current && !retainedWorkRoot) setIssue('无法打开 Work 会话目录。') })
    return () => { current = false }
  }, [active, retry])

  if (root) return <><ThreadRouteView root={root} source="work" target={taskThread} /><StartupContentCommit active={active} /></>
  if (!hasIpc) return <><EmptyState title="请在 Crux 桌面端打开对话" /><StartupContentCommit active={active} /></>
  if (issue) return <><FeedbackNotice variant="inline" title="无法打开 Work 对话" diagnostic={issue}
    actions={<Button size="sm" variant="ghost" onClick={() => setRetry(value => value + 1)}>重新打开</Button>} /><StartupContentCommit active={active} /></>
  return <PageLoading />
}

function CodeProjectPrompt(): JSX.Element {
  const canOpen = useMy((state) => state.canOpenLocalProject)
  const pickAndOpen = useApp((state) => state.pickAndOpen)
  const openError = useApp((state) => state.openError)
  const [opening, setOpening] = useState(false)
  const [issue, setIssue] = useState('')

  async function chooseProject(): Promise<void> {
    setOpening(true)
    setIssue('')
    try {
      await pickAndOpen({ keepPage: true })
    } catch (error) {
      setIssue(error instanceof Error ? error.message : String(error))
    } finally {
      setOpening(false)
    }
  }

  return <section className="flex h-full min-h-0 flex-col items-center justify-center gap-3 overflow-auto p-4" aria-label="对话工作目录">
    <EmptyState title="选择对话使用的本机目录" />
    <div className="flex flex-wrap items-center justify-center gap-2">
      <Button size="sm" variant="outline" onClick={() => void chooseProject()} disabled={!canOpen || opening} aria-busy={opening}>
        <FolderOpen size={15} aria-hidden="true" />打开本机工程…
      </Button>
      <Button size="sm" variant="ghost" onClick={() => useMy.getState().setChatWorkdirMode('default')}>
        使用托管默认目录
      </Button>
    </div>
    {(issue || openError) && <FeedbackNotice variant="inline" title="工程打开失败" diagnostic={issue || openError || undefined} />}
  </section>
}

export function ChatPage({ active }: { active: boolean }): JSX.Element {
  const directoryMode = useMy((state) => state.chatWorkdirMode === 'directory')
  const root = useApp((state) => state.snapshot?.meta.root)
  let content: JSX.Element
  if (!directoryMode) content = <WorkConversation active={active} />
  else if (!root) content = <><CodeProjectPrompt /><StartupContentCommit active={active} /></>
  else content = <><ThreadRouteView root={root} source="code" /><StartupContentCommit active={active} /></>
  return <Suspense fallback={active ? <PageLoading /> : null}>
    {content}
  </Suspense>
}

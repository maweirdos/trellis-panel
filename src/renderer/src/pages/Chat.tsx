import { lazy, Suspense, useEffect, useState, type JSX } from 'react'
import { FolderOpen } from 'lucide-react'
import { api, hasIpc } from '../api'
import { StartupContentCommit } from '../daemon/StartupContext'
import { PageLoading } from '../my/layout/PageLoading'
import { projectRootKey } from '../my/navigation'
import { useMy } from '../my/store'
import { FeedbackNotice } from '../my/FeedbackNotice'
import { Button, EmptyState } from '../my/ui'
import { useApp } from '../store'
import { useTaskWorkThread } from '../conversation-workbench/task-work-navigation'

const NativeConversation = lazy(() => import('../conversation-workbench/ConversationWorkbench').then((module) => ({ default: module.ConversationWorkbench })))

function WorkConversation({ active }: { active: boolean }): JSX.Element {
  const [root, setRoot] = useState<string>()
  const [issue, setIssue] = useState('')
  const [retry, setRetry] = useState(0)
  const taskThread = useTaskWorkThread(root)

  useEffect(() => {
    if (!active || !hasIpc) return
    let current = true
    void api.conversationWorkRoot().then(result => {
      if (!current) return
      if (result.ok) {
        setRoot(result.root)
        setIssue('')
      } else setIssue(result.error)
    }).catch(() => { if (current) setIssue('无法打开 Work 会话目录。') })
    return () => { current = false }
  }, [active, retry])

  if (root) return <NativeConversation key={taskThread?.key ?? projectRootKey(root)} root={root} source="work" initialThreadId={taskThread?.threadId} />
  if (!hasIpc) return <EmptyState title="请在 Crux 桌面端打开对话" />
  if (issue) return <FeedbackNotice variant="inline" title="无法打开 Work 对话" diagnostic={issue}
    actions={<Button size="sm" variant="ghost" onClick={() => setRetry(value => value + 1)}>重新打开</Button>} />
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

  return <section className="flex h-full min-h-0 flex-col items-center justify-center gap-3 overflow-auto p-4" aria-label="Code 对话">
    <EmptyState title="选择 Code 的工作目录" />
    <Button size="sm" variant="outline" onClick={() => void chooseProject()} disabled={!canOpen || opening} aria-busy={opening}>
      <FolderOpen size={15} aria-hidden="true" />打开本机工程…
    </Button>
    {(issue || openError) && <FeedbackNotice variant="inline" title="工程打开失败" diagnostic={issue || openError || undefined} />}
  </section>
}

export function ChatPage({ active }: { active: boolean }): JSX.Element {
  const development = useMy((state) => state.shellView === 'development')
  const root = useApp((state) => state.snapshot?.meta.root)
  let content: JSX.Element
  if (!development) content = <WorkConversation active={active} />
  else if (!root) content = <CodeProjectPrompt />
  else content = <NativeConversation key={projectRootKey(root)} root={root} source="code" />
  return <Suspense fallback={active ? <PageLoading /> : null}>
    {content}
    <StartupContentCommit active={active} />
  </Suspense>
}

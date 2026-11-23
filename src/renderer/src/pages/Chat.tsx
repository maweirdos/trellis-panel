import { lazy, Suspense, useState, type JSX } from 'react'
import { FolderOpen } from 'lucide-react'
import { PrivateWorkspace } from '../conversations/PrivateWorkspace'
import { StartupContentCommit } from '../daemon/StartupContext'
import { PageLoading } from '../my/layout/PageLoading'
import { projectRootKey } from '../my/navigation'
import { useMy } from '../my/store'
import { FeedbackNotice } from '../my/FeedbackNotice'
import { Button, EmptyState } from '../my/ui'
import { useApp } from '../store'

const CodeConversation = lazy(() => import('../conversation-workbench/ConversationWorkbench').then((module) => ({ default: module.ConversationWorkbench })))

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
  const privateCodeChat = useApp((state) => state.privateCodeChat)
  const root = useApp((state) => state.snapshot?.meta.root)
  let content: JSX.Element
  if (!development || privateCodeChat) content = <PrivateWorkspace />
  else if (!root) content = <CodeProjectPrompt />
  else content = <CodeConversation key={projectRootKey(root)} root={root} source="code" />
  return <Suspense fallback={active ? <PageLoading /> : null}>
    {content}
    <StartupContentCommit active={active} />
  </Suspense>
}

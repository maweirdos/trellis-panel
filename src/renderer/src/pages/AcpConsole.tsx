/** ACP route remains within the existing project-scoped conversation module. */
import { lazy, Suspense, type JSX } from 'react'
import { useMy } from '../my/store'
import { useApp } from '../store'
import { AcpConsolePage as LegacyConsolePage } from '../acp/ConsoleWorkspace'

const NativeConversationWorkbench = lazy(() => import('../conversation-workbench/ConversationWorkbench').then(module => ({ default: module.ConversationWorkbench })))

export function AcpConsolePage(options: { compact?: boolean }): JSX.Element {
  const agentView = useMy((state) => state.agentTarget)
  const root = useApp((state) => state.snapshot?.meta.root)
  if (agentView === 'native' && root && !options.compact) {
    return <Suspense fallback={null}><NativeConversationWorkbench key={root} root={root} /></Suspense>
  }
  return <LegacyConsolePage {...options} />
}

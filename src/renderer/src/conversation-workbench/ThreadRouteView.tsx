import { lazy } from 'react'
import { projectRootKey } from '../my/navigation'

const Workbench = lazy(() => import('./ConversationWorkbench').then(({ ConversationWorkbench }) => ({ default: ConversationWorkbench })))

interface ThreadRouteViewProps {
  readonly root: string
  readonly source: 'work' | 'code'
  readonly target?: {
    readonly key: string
    readonly threadId: string
  } | null
}

export function ThreadRouteView({ root, source, target }: ThreadRouteViewProps) {
  const routeKey = target?.key ?? `${source}:${projectRootKey(root) ?? root}`
  return <Workbench key={routeKey} root={root} source={source} initialThreadId={target?.threadId} />
}

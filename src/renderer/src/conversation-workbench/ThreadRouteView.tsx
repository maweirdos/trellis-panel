import { lazy } from 'react'
import { projectRootKey } from '../my/navigation'
import type { EmbeddedCruxChatConfig } from './ConversationWorkbench'

const Workbench = lazy(() => import('./ConversationWorkbench').then(({ ConversationWorkbench }) => ({ default: ConversationWorkbench })))

interface ThreadRouteViewProps {
  readonly root: string
  readonly source: 'work' | 'code'
  readonly target?: {
    readonly key: string
    readonly threadId: string
  } | null
  readonly embeddedCrux?: EmbeddedCruxChatConfig
}

export function ThreadRouteView({ root, source, target, embeddedCrux }: ThreadRouteViewProps) {
  const routeKey = target?.key ?? `${source}:${projectRootKey(root) ?? root}`
  return <Workbench key={routeKey} root={root} source={source} initialThreadId={target?.threadId} embeddedCrux={embeddedCrux} />
}

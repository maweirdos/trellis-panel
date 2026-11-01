import type { JSX, ReactNode } from 'react'

export interface ConversationWorkspaceHeaderProps {
  leading?: ReactNode
  identity: ReactNode
  actions?: ReactNode
}

export function ConversationWorkspaceHeader({ leading, identity, actions }: ConversationWorkspaceHeaderProps): JSX.Element {
  return <header className="acp-workspace-header">
    {leading}
    <div className="acp-header-identity">{identity}</div>
    <div className="acp-header-actions">{actions}</div>
  </header>
}

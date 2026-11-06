import { createContext, useContext, type JSX, type ReactNode, type RefObject } from 'react'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'

export interface ConversationPreviewControls {
  panelId: string
  collapsed: boolean
  toggleRef: RefObject<HTMLButtonElement>
  onToggle(): void
}

export const ConversationPreviewContext = createContext<ConversationPreviewControls | null>(null)

export interface ConversationWorkspaceHeaderProps {
  leading?: ReactNode
  identity: ReactNode
  actions?: ReactNode
}

export function ConversationWorkspaceHeader({ leading, identity, actions }: ConversationWorkspaceHeaderProps): JSX.Element {
  const preview = useContext(ConversationPreviewContext)
  const previewLabel = preview?.collapsed ? '展开预览栏' : '收起预览栏'
  return <header className="acp-workspace-header">
    {leading}
    <div className="acp-header-identity">{identity}</div>
    <div className="acp-header-actions">{actions}{preview && <button ref={preview.toggleRef} type="button" className="my-icon-control" aria-label={previewLabel} title={previewLabel} aria-controls={preview.panelId} aria-expanded={!preview.collapsed} onClick={preview.onToggle}>{preview.collapsed ? <PanelRightOpen size={16} aria-hidden="true" /> : <PanelRightClose size={16} aria-hidden="true" />}</button>}</div>
  </header>
}

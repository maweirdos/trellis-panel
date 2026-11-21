import type { JSX } from 'react'
import { History, Paperclip } from 'lucide-react'
import type { Conversation } from '@shared/private-conversations'
import { useInteractionGuard } from '../utils/interaction-scope'
import { isPrivateEntrySelected } from './source'
import { useConversations } from './workspace'

export function ConversationHomeActions({ entryKey, canAddFiles, onFiles, onSelect }: {
  entryKey: string; canAddFiles: boolean; onFiles(): void; onSelect(conversation: Conversation): void
}): JSX.Element | null {
  const entry = useConversations(state => state.entries[entryKey]), conversations = useConversations(state => state.conversations)
  const canInteract = useInteractionGuard()
  const conversationId = entry?.conversation?.id
  if (!entry) return null
  const recent = conversations.filter(item => item.kind === entry.kind && item.archivedAt === undefined && item.id !== conversationId && item.conversationPreview).sort((a, b) => b.updatedAt - a.updatedAt)[0]
  const invoke = (action: () => void): void => { if (canInteract() && isPrivateEntrySelected(entryKey)) action() }
  return <nav className="private-home-actions" aria-label="快捷入口">
    {recent && <button type="button" className="private-home-action my-card" onClick={() => invoke(() => onSelect(recent))}>
      <div className="private-home-tag">
        <History size={12} aria-hidden="true" />
        <span>继续对话</span>
      </div>
      <strong className="private-home-title">{recent.title}</strong>
      <span className="private-home-desc">{recent.conversationPreview || '恢复上下文并继续'}</span>
    </button>}
    {canAddFiles && <button type="button" className="private-home-action my-card" onClick={() => invoke(onFiles)}>
      <div className="private-home-tag">
        <Paperclip size={12} aria-hidden="true" />
        <span>从资料开始</span>
      </div>
      <strong className="private-home-title">选入本机文件</strong>
      <span className="private-home-desc">添加文件作为会话上下文</span>
    </button>}
  </nav>
}

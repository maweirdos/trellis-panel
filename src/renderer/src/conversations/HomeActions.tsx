import type { JSX } from 'react'
import { ArrowUpRight, FilePlus2, FileText, History, Paperclip, RefreshCw } from 'lucide-react'
import type { RequirementSummary } from '@shared/conversation-requirements'
import type { Conversation } from '@shared/private-conversations'
import { useInteractionGuard } from '../utils/interaction-scope'
import { isPrivateEntrySelected } from './source'
import { useConversations } from './workspace'

export function ConversationHomeActions({ entryKey, requirements, requirementsError, requirementsLoading, onRefreshRequirements, canAddFiles, onFiles, onSelect, onRequirement }: {
  entryKey: string; requirements: RequirementSummary[]; requirementsError: string; requirementsLoading: boolean; onRefreshRequirements(): void; canAddFiles: boolean; onFiles(): void; onSelect(conversation: Conversation): void; onRequirement(id?: string): void
}): JSX.Element | null {
  const entry = useConversations(state => state.entries[entryKey]), conversations = useConversations(state => state.conversations)
  const canInteract = useInteractionGuard()
  const conversationId = entry?.conversation?.id
  if (!entry) return null
  const recent = conversations.filter(item => item.kind === entry.kind && item.archivedAt === undefined && item.id !== conversationId && item.conversationPreview).sort((a, b) => b.updatedAt - a.updatedAt)[0]
  const requirement = requirements.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0]
  const invoke = (action: () => void): void => { if (canInteract() && isPrivateEntrySelected(entryKey)) action() }
  return <nav className="private-home-actions" aria-label="继续工作">
    {recent && <button type="button" className="private-home-action my-card" onClick={() => invoke(() => onSelect(recent))}>
      <span className="private-home-action-kind"><History size={14} aria-hidden="true" /><span>继续对话</span><ArrowUpRight size={13} aria-hidden="true" /></span>
      <span className="my-item-title">{recent.title}</span><span className="my-item-description">{recent.conversationPreview}</span>
    </button>}
    <button type="button" className="private-home-action my-card" disabled={requirementsLoading || !entry.loaded || Boolean(entry.action) || entry.kind === 'code' && !entry.conversation && !entry.directory} onClick={() => invoke(() => requirementsError ? onRefreshRequirements() : onRequirement(requirement?.id))}>
      <span className="private-home-action-kind">{requirementsError ? <RefreshCw size={14} aria-hidden="true" /> : requirement?.handoff?.task ? <FileText size={14} aria-hidden="true" /> : <FilePlus2 size={14} aria-hidden="true" />}<span>{requirementsError ? '需求暂不可用' : requirement ? requirement.handoff?.task ? 'Trellis 需求' : '继续需求' : '整理需求'}</span><ArrowUpRight size={13} aria-hidden="true" /></span>
      <span className="my-item-title">{requirementsLoading ? '正在读取…' : requirementsError ? '重新读取需求' : requirement?.title ?? '新建需求'}</span>{requirement && !requirementsError && <span className="my-item-description">{requirement.handoff?.task?.title ?? '需求草稿'}</span>}
    </button>
    {canAddFiles && <button type="button" className="private-home-action my-card" onClick={() => invoke(onFiles)}>
      <span className="private-home-action-kind"><Paperclip size={14} aria-hidden="true" /><span>从资料开始</span><ArrowUpRight size={13} aria-hidden="true" /></span><span className="my-item-title">选入本机文件</span>
    </button>}
  </nav>
}

import { useEffect, useRef, useState, type JSX } from 'react'
import { ChevronDown, GitBranch, GitCommitHorizontal, Loader2, RefreshCw } from 'lucide-react'
import type { ConversationGitStatus } from '@shared/conversation-git'
import { Button, Dropdown, DropdownHeader } from '../my/ui'
import { useInteractionActive, useInteractionGuard } from '../utils/interaction-scope'
import { conversationClient, conversationError, conversationValue } from './client'
import { isPrivateEntrySelected } from './source'
import { ensureConversation, useConversations } from './workspace'

/** Git always follows the original conversation directory, independently of the app project. */
export function ConversationGitContext({ entryKey }: { entryKey: string }): JSX.Element | null {
  const entry = useConversations(state => state.entries[entryKey])
  const active = useInteractionActive(), canInteract = useInteractionGuard()
  const [value, setValue] = useState<ConversationGitStatus>(), [error, setError] = useState(''), [pending, setPending] = useState(false)
  const root = entry?.conversation?.workspace.root ?? entry?.directory?.path
  const identity = JSON.stringify([entryKey, entry?.owner, root]), owner = useRef(identity), request = useRef(0), inflight = useRef<string | null>(null)
  owner.current = identity
  const refresh = async (): Promise<void> => {
    const client = conversationClient(), observed = identity
    if (!client || !root || !active || !canInteract() || !isPrivateEntrySelected(entryKey) || inflight.current === observed || !entry?.conversation && entry?.action) return
    const sequence = ++request.current
    inflight.current = observed
    const current = (): boolean => owner.current === observed && sequence === request.current && canInteract() && isPrivateEntrySelected(entryKey)
    setPending(true); setError('')
    try {
      const conversation = entry?.conversation ?? await ensureConversation(entryKey)
      if (!current()) return
      const result = conversationValue(await client.git(conversation.id))
      if (current()) setValue(result)
    } catch (cause) { if (current()) { setValue(undefined); setError(conversationError(cause)) } }
    finally { if (inflight.current === observed) inflight.current = null; if (current()) setPending(false) }
  }
  useEffect(() => {
    setValue(undefined); setError(''); setPending(false)
    if (active && root) void refresh()
    return () => { request.current++ }
  }, [identity, active])
  useEffect(() => {
    if (!active) return
    const visible = (): void => { if (!document.hidden) void refresh() }
    document.addEventListener('visibilitychange', visible)
    return () => document.removeEventListener('visibilitychange', visible)
  }, [identity, active])
  if (!root || entry?.kind !== 'code' || entry.locked || entry.conversation?.archivedAt !== undefined) return null
  const tracked = value && (value.state === 'branch' || value.state === 'detached' || value.state === 'unborn') ? value : null
  const label = tracked ? tracked.state === 'detached' ? tracked.head?.slice(0, 8) ?? '分离 HEAD' : tracked.branch ?? '新仓库' : value?.state === 'not-git' ? '未检测到 Git' : error || value?.state === 'error' ? 'Git 未就绪' : 'Git'
  const changes = tracked ? tracked.staged + tracked.unstaged + tracked.untracked : 0
  return <Dropdown placement="top" width={300} trigger={({ open, toggle }) => <Button variant="ghost" size="sm" className="acp-context-action private-git-trigger" aria-label={`Git：${label}${changes ? `，${changes} 项变更` : ''}`} aria-expanded={open} onClick={() => { toggle(); if (!open) void refresh() }}>
    {pending && !value ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : tracked?.state === 'detached' ? <GitCommitHorizontal size={14} aria-hidden="true" /> : <GitBranch size={14} aria-hidden="true" />}
    <span>{label}</span>{tracked && changes > 0 && <span className="private-git-count" title="仓库变更项数">{changes}</span>}<ChevronDown size={12} aria-hidden="true" />
  </Button>}>
    {() => <div className="private-git-menu">
      <div className="private-git-heading"><DropdownHeader>Git</DropdownHeader><Button size="sm" variant="ghost" title="刷新 Git 状态" aria-label="刷新 Git 状态" disabled={pending} onClick={() => void refresh()}><RefreshCw size={14} className={pending ? 'animate-spin' : undefined} /></Button></div>
      <p className="private-git-root my-item-description" title={tracked?.repositoryRoot ?? root}>{tracked?.repositoryRoot ?? root}</p>
      {tracked && <>
        <div className="private-git-row"><span className="my-item-title">{tracked.state === 'detached' ? '分离 HEAD' : '分支'}</span><span className="private-git-value">{label}</span></div>
        {tracked.state === 'unborn' && <p className="my-item-description">尚无提交</p>}
        <div className="private-git-row"><span className="my-item-description">已暂存</span><span>{tracked.staged}</span></div>
        <div className="private-git-row"><span className="my-item-description">未暂存</span><span>{tracked.unstaged}</span></div>
        <div className="private-git-row"><span className="my-item-description">未跟踪</span><span>{tracked.untracked}</span></div>
        {tracked.conflicts && <p className="text-my-sm text-my-warning-text" role="status">存在合并冲突</p>}
      </>}
      {value?.state === 'not-git' && <p className="my-item-description">当前目录未关联 Git 仓库</p>}
      {(error || value?.state === 'error') && <p className="my-item-description text-my-danger-text" role="alert">{error || (value?.state === 'error' ? value.error : '')}</p>}
    </div>}
  </Dropdown>
}

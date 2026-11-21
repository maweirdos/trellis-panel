import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { ChevronDown, FilePlus2, FileText, ListChecks, RefreshCw } from 'lucide-react'
import type { RequirementDocument } from '@shared/conversation-requirements'
import type { RequirementSummary } from '@shared/conversation-requirements'
import { Button, Dropdown, DropdownHeader, DropdownItem } from '../my/ui'
import { useInteractionGuard } from '../utils/interaction-scope'
import { conversationClient, conversationError, conversationValue } from './client'
import type { WorkspaceEntry } from './workspace'

export function useRequirementSummaries(entry: WorkspaceEntry | undefined, active: boolean): { records: RequirementSummary[]; error: string; loading: boolean; refresh(): void } {
  const id = entry?.conversation?.id
  const identity = JSON.stringify([entry?.owner, id, entry?.conversation?.workspace.root])
  const [state, setState] = useState<{ identity: string; records: RequirementSummary[]; error: string; loading: boolean }>({ identity, records: [], error: '', loading: false })
  const request = useRef(0), current = useRef({ identity, active })
  current.current = { identity, active }
  const refresh = useCallback((): void => {
    const client = conversationClient(), ticket = ++request.current
    if (!id || !active || !client) return
    setState(previous => ({ identity, records: previous.identity === identity ? previous.records : [], error: '', loading: true }))
    void client.requirements.list(id).then(result => {
      const records = conversationValue(result)
      if (request.current === ticket && current.current.identity === identity && current.current.active) setState({ identity, records, error: '', loading: false })
    }).catch(cause => {
      if (request.current === ticket && current.current.identity === identity && current.current.active) setState({ identity, records: [], error: conversationError(cause), loading: false })
    })
  }, [identity, active])
  useEffect(() => { refresh(); return () => { request.current++ } }, [refresh])
  return { records: state.identity === identity ? state.records : [], error: state.identity === identity ? state.error : '', loading: state.identity === identity && state.loading, refresh }
}

export function ConversationRequirementMenu({ records, error, loading, disabled, preferredId, onOpen, onRefresh }: {
  records: RequirementSummary[]; error: string; loading: boolean; disabled: boolean; preferredId?: string; onOpen(id?: string, document?: RequirementDocument): void; onRefresh(): void
}): JSX.Element {
  const canInteract = useInteractionGuard(), [limit, setLimit] = useState(20)
  const resume = records.find(record => record.id === preferredId) ?? records[0]
  return <div className="private-requirement-context">
    {resume && <Button variant="ghost" size="sm" className="acp-context-action" disabled={disabled} title={resume.title} onClick={() => { if (canInteract()) onOpen(resume.id) }}><FileText size={14} aria-hidden="true" /><span>继续需求</span></Button>}
    {resume?.hasPlan && <Button variant="ghost" size="sm" className="acp-context-action" disabled={disabled} onClick={() => { if (canInteract()) onOpen(resume.id, 'plan') }}><ListChecks size={14} aria-hidden="true" /><span>查看计划</span></Button>}
    <Button variant="ghost" size="sm" className="acp-context-action" disabled={disabled} onClick={() => { if (canInteract()) onOpen() }}><FilePlus2 size={14} aria-hidden="true" /><span>起草需求说明</span></Button>
    {(records.length > 1 || error) && <Dropdown placement="top" width={300} trigger={({ open, toggle }) => <Button variant="ghost" size="sm" className="private-requirement-menu-trigger" aria-label="更多已有需求" aria-expanded={open} disabled={disabled} onClick={() => { setLimit(20); toggle(); if (!open) onRefresh() }}><ChevronDown size={12} /></Button>}>
      {close => <><div className="private-git-heading px-2"><DropdownHeader>此对话的需求</DropdownHeader><Button variant="ghost" size="sm" title="刷新需求" aria-label="刷新需求" disabled={loading} onClick={onRefresh}><RefreshCw size={13} className={loading ? 'animate-spin' : undefined} /></Button></div>
        <div className="private-requirement-list my-scrollbar">{records.slice(0, limit).map(record => <DropdownItem key={record.id} icon={<FileText size={14} />} onClick={() => { close(); onOpen(record.id) }}><span className="private-requirement-menu-row"><span className="private-requirement-menu-title">{record.title}</span><span className="text-my-xs text-my-tertiary">{record.handoff?.state === 'created' ? '已交接' : record.handoff ? '待核对' : '草稿'}</span></span></DropdownItem>)}</div>
        {error && <p className="my-item-description px-3 py-2" role="alert">{error}</p>}
        {records.length > limit && <DropdownItem onClick={() => setLimit(value => value + 20)}>显示更多需求</DropdownItem>}
      </>}
    </Dropdown>}
  </div>
}

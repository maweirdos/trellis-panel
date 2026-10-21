import { useEffect, useRef, useState, type JSX } from 'react'
import { GitBranch, Loader2, X } from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { Button, Modal } from '../my/ui'
import { integrationBridgeMessage, integrationBridgeState } from '../my/pages/integrations/bridge'
import { useKnowledgeRequest } from '../knowledge/request-intake'
import type { JiraContext } from '../../../shared/integrations'
import type { JiraIssueDetail } from '../../../shared/types'

export function JiraPickerModal({ onClose, onSelected, isCurrent }: { onClose: () => void; onSelected: () => void; isCurrent: () => boolean }): JSX.Element {
  const root = useApp((state) => state.snapshot?.meta.root ?? '')
  const [context, setContext] = useState<JiraContext | null>(null)
  const [issues, setIssues] = useState<JiraIssueDetail[]>([])
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [more, setMore] = useState(false)
  const pending = useRef<string | null>(null)
  const sequence = useRef(0)
  useEffect(() => {
    let disposed = false
    if (integrationBridgeState() !== 'ready') { setError(integrationBridgeMessage(integrationBridgeState())); return }
    void api.integrations.jiraContext({ expectedRoot: root }).then((result) => {
      if (disposed || !isCurrent()) return
      if (result.ok) { setContext(result.data); setQuery(result.data?.jql || 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'); if (!result.data) setError('当前项目尚未绑定 Jira 来源，请在集成中设置。') } else setError(result.error)
    }).catch((failure: unknown) => { if (!disposed && isCurrent()) setError(failure instanceof Error ? failure.message : '无法读取项目 Jira 来源') })
    return () => { disposed = true; sequence.current++; if (pending.current) void api.integrations.cancelRead(pending.current) }
  }, [root, isCurrent])
  const search = async (): Promise<void> => {
    if (!context || busy || !isCurrent()) return
    const token = ++sequence.current, requestId = crypto.randomUUID()
    pending.current = requestId; setBusy(true); setError(''); setIssues([])
    try {
      const response = await api.integrations.jiraSearch({ ...context, requestId, jql: query.trim() || context.jql })
      if (!isCurrent() || token !== sequence.current) return
      if (response.ok) { setIssues(response.data.issues); setMore(response.data.total > response.data.issues.length) } else setError(response.error)
    } catch (failure) { if (isCurrent() && token === sequence.current) setError(failure instanceof Error ? failure.message : '工单检索失败') }
    finally { if (token === sequence.current) { pending.current = null; if (isCurrent()) setBusy(false) } }
  }
  return <Modal open onClose={onClose} width={640}><div role="dialog" aria-label="从 Jira 进入需求梳理" className="max-h-[80vh] overflow-hidden"><div className="flex items-center gap-2 border-b border-my-line px-4 py-3"><GitBranch size={15} /><h2 className="min-w-0 flex-1 text-my-sm font-medium">从项目 Jira 来源选取需求</h2><Button size="sm" variant="ghost" title="关闭 Jira 选择器" onClick={onClose}><X size={14} /></Button></div><div className="space-y-3 p-4"><p className="text-my-xs leading-relaxed text-my-tertiary">只准备来源明确、可编辑的需求草稿；选择工单不会创建开发任务、启动引擎或自动发送。</p><label className="block text-my-xs text-my-secondary">项目来源：{context?.name || '未配置'}<textarea aria-label="Jira 查询" className="my-input mt-2 min-h-16 w-full" disabled={busy} value={query} onChange={(event) => setQuery(event.target.value)} /></label><Button size="sm" variant="outline" disabled={!context || busy} onClick={() => void search()}>{busy && <Loader2 size={12} className="animate-spin" />}查询工单</Button>{error && <p role="alert" className="text-my-xs text-my-danger-text">{error}</p>}<div className="my-scrollbar max-h-[42vh] space-y-1 overflow-y-auto">{issues.map((issue) => <button type="button" key={issue.key} className="flex w-full items-start gap-2 rounded-my-md border border-my-line p-3 text-left hover:bg-my-layer-1" onClick={() => {
    if (!context || !isCurrent()) return
    if (useKnowledgeRequest.getState().stage({ root, title: issue.summary, description: issue.description || issue.summary, source: { kind: 'jira', key: issue.key, url: issue.url, instanceId: context.instanceId, issueId: issue.issueId } })) onSelected()
  }}><span className="font-mono text-my-xs text-my-info-text">{issue.key}</span><span className="min-w-0 flex-1 text-my-sm">{issue.summary}</span><span className="text-my-2xs text-my-tertiary">准备草稿</span></button>)}</div>{more && <p className="text-my-xs text-my-tertiary">仅显示当前查询首批结果，请收窄 JQL 定位其他工单。</p>}</div></div></Modal>
}

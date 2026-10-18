import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { GitBranch, Loader2, X } from 'lucide-react'
import { useApp } from '../store'
import { api, hasIpc } from '../api'
import { Button, Modal } from '../my/ui'
import { Select } from '../components/Select'
import type { AcpAgentStatus, JiraIssue } from '../../../shared/types'

/* ---------------- 工单选择器（人工审查流） ---------------- */

const JQL_PRESETS = [
  { label: '我的待办', jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC' },
  { label: '近期更新', jql: 'ORDER BY updated DESC' }
]

export function JiraPickerModal(props: { onClose: () => void; onStarted: (sessionId: string) => void; isCurrent: () => boolean }): JSX.Element {
  const { onClose, onStarted, isCurrent } = props
  const snapshot = useApp((s) => s.snapshot)
  const settings = useApp((s) => s.settings)
  const pushToast = useApp((s) => s.pushToast)
  const [issues, setIssues] = useState<JiraIssue[]>([])
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState<string | null>(null)
  const [agentId, setAgentId] = useState('')
  const [agents, setAgents] = useState<AcpAgentStatus[]>([])
  const startLock = useRef(false)
  const close = (): void => { if (!startLock.current) onClose() }

  useEffect(() => {
    if (!hasIpc) return
    let disposed = false
    void api.acpAgents().then((res) => {
      if (!disposed && isCurrent() && res.ok && res.agents) {
        const ok = res.agents.filter((a) => a.enabled && a.available)
        setAgents(ok)
        setAgentId((cur) => cur || ok[0]?.id || '')
      }
    }).catch((error: unknown) => { if (!disposed && isCurrent()) pushToast({ kind: 'error', title: 'Runtime 列表加载失败', body: error instanceof Error ? error.message : '' }) })
    return () => { disposed = true }
  }, [isCurrent])

  const search = useCallback(
    async (jql: string): Promise<void> => {
      if (!isCurrent()) return
      const cfg = settings?.jira
      if (!cfg?.baseUrl) {
        pushToast({ kind: 'error', title: '未配置 Jira', body: '设置页先完成 Jira 连接' })
        return
      }
      setLoading(true)
      try {
        const res = await api.jiraSearch(cfg, jql)
        if (!isCurrent()) return
        if (res.ok && res.issues) setIssues(res.issues.slice(0, 20))
        else pushToast({ kind: 'error', title: '工单查询失败', body: res.error ?? '' })
      } catch (error) {
        if (isCurrent()) pushToast({ kind: 'error', title: '工单查询失败', body: error instanceof Error ? error.message : '' })
      } finally {
        if (isCurrent()) setLoading(false)
      }
    },
    [settings, pushToast, isCurrent]
  )

  useEffect(() => {
    if (!hasIpc) return
    void search(JQL_PRESETS[0].jql)
  }, [search])

  const startWith = useCallback(
    async (issue: JiraIssue): Promise<void> => {
      if (!isCurrent() || startLock.current) return
      if (!agentId) {
        pushToast({ kind: 'error', title: '无可用 agent', body: '设置页启用一个 ACP agent' })
        return
      }
      startLock.current = true
      setImporting(issue.key)
      try {
        // ① 导入为 Trellis 任务（jiraKey 防重；已存在时直接复用）
        let dirName: string | null = null
        const existing = snapshot?.tasks.find((t) => String(t.record?.meta?.jiraKey ?? '').toUpperCase() === issue.key.toUpperCase())
        if (existing) {
          dirName = existing.dirName
        } else {
          const res = await api.createTaskFromJira({
            dirName: `${issue.key.toLowerCase()}-${issue.summary.slice(0, 20).replace(/[^\w\u4e00-\u9fa5-]+/g, '-')}`,
            title: `[${issue.key}] ${issue.summary}`,
            description: `${issue.summary}\n\n来源：${issue.url}`,
            status: 'planning',
            priority: issue.priority || 'P2',
            assignee: snapshot?.meta.developer ?? '',
            jiraKey: issue.key,
            jiraUrl: issue.url
          })
          if (!isCurrent()) return
          if (res.ok && res.dirName) dirName = res.dirName
          else {
            // jiraKey 防重命中时 error 文案含「已关联」
            pushToast({ kind: (res.error ?? '').includes('已关联') ? 'info' : 'error', title: '导入结果', body: res.error ?? '' })
            return
          }
        }
        // ② 以该任务开新 ACP 会话（人工下达推进指令，无自动派发）
        const s = await api.acpSessionNew({ agentId, taskDir: dirName ?? undefined })
        if (!isCurrent()) return
        if (s.ok && s.sessionId) {
          pushToast({ kind: 'success', title: '会话已创建', body: `任务 ${dirName} 的环境正在准备，就绪后可下达指令` })
          onStarted(s.sessionId)
        } else {
          pushToast({ kind: 'error', title: '会话创建失败', body: s.error ?? '' })
        }
      } catch (error) {
        if (isCurrent()) pushToast({ kind: 'error', title: '工单会话创建失败', body: error instanceof Error ? error.message : '' })
      } finally {
        startLock.current = false
        if (isCurrent()) setImporting(null)
      }
    },
    [agentId, snapshot, pushToast, onStarted, isCurrent]
  )

  return (
    <Modal open onClose={close} width={640}>
      <div role="dialog" aria-modal="true" aria-label="从 Jira 选工单开始" className="max-h-[76vh] max-w-[92vw] overflow-hidden">
        <div className="flex items-center gap-2 border-b border-my-line px-4 py-3">
          <GitBranch size={15} className="text-my-info-text" />
          <span className="text-my-sm font-medium text-my-primary">从 Jira 选工单开始</span>
          <div className="flex-1" />
          <Select ariaLabel="Jira 工单 Runtime" disabled={importing !== null} className="h-8 min-w-0 max-w-44" size="sm" value={agentId} onChange={setAgentId} options={agents.map((agent) => ({ value: agent.id, label: agent.name }))} />
          <Button variant="ghost" size="sm" title="关闭 Jira 选择器" disabled={importing !== null} onClick={close}>
            <X size={14} />
          </Button>
        </div>
        <div className="flex gap-1.5 border-b border-my-line px-4 py-2">
          {JQL_PRESETS.map((p) => (
            <button key={p.label} className="my-chip border border-my-line text-my-secondary transition-colors hover:border-my-line-accent-subtle" disabled={loading} onClick={() => void search(p.jql)}>
              {p.label}
            </button>
          ))}
          {loading && <Loader2 size={13} className="animate-spin self-center text-my-tertiary" />}
        </div>
        <div className="my-scrollbar max-h-[52vh] overflow-y-auto p-2">
          {issues.length === 0 && !loading && <div className="py-8 text-center text-my-xs text-my-tertiary">无工单</div>}
          {issues.map((it) => (
            <button
              key={it.key}
              disabled={importing !== null}
              onClick={() => void startWith(it)}
              className="mb-1 flex w-full items-center gap-3 rounded-my-md px-3 py-2 text-left hover:bg-my-layer-1 disabled:opacity-50"
            >
              <span className="shrink-0 font-mono text-my-xs text-my-info-text">{it.key}</span>
              <span className="min-w-0 flex-1 truncate text-my-sm text-my-primary">{it.summary}</span>
              <span className="shrink-0 text-my-2xs text-my-tertiary">{it.status}</span>
              {importing === it.key && <Loader2 size={12} className="animate-spin" />}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}

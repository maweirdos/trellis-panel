import { useCallback, useEffect, useState } from 'react'
import {
  RefreshCw,
  Download,
  ExternalLink,
  Link2,
  CheckCircle2,
  Search,
  MessageSquarePlus,
  ArrowRightCircle
} from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import { JIRA_CATEGORY_STATUS, statusLabel } from '../utils/labels'
import { fmtIso } from '../utils/format'
import type { JSX } from 'react'
import type { JiraIssue, TaskInfo } from '../../../shared/types'

function priorityOf(name: string): string {
  if (/highest|最高/i.test(name)) return 'P0'
  if (/high|高/i.test(name)) return 'P1'
  if (/low|低/i.test(name)) return 'P3'
  return 'P2'
}

export function JiraPage(): JSX.Element {
  const settings = useApp((s) => s.settings)!
  const snapshot = useApp((s) => s.snapshot)!
  const pushToast = useApp((s) => s.pushToast)

  const [issues, setIssues] = useState<JiraIssue[]>([])
  const [total, setTotal] = useState(0)
  const [jql, setJql] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [linkTargets, setLinkTargets] = useState<Record<string, string>>({})

  const cfg = settings.jira

  const search = useCallback(
    async (query: string): Promise<void> => {
      if (!cfg?.enabled || !cfg.baseUrl) {
        setError('尚未配置 Jira 连接 —— 请先到「设置 → Jira 集成」填写并保存')
        return
      }
      setLoading(true)
      setError(null)
      const res = await api.jiraSearch(cfg, query)
      setLoading(false)
      if (res.ok && res.issues) {
        setIssues(res.issues)
        setTotal(res.total ?? res.issues.length)
      } else {
        setError(res.error ?? '查询失败')
        setIssues([])
      }
    },
    [cfg]
  )

  useEffect(() => {
    if (cfg?.enabled && cfg.baseUrl) void search('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg?.enabled, cfg?.baseUrl])

  const quickSearch = (preset: 'mine' | 'sprint'): void => {
    const q =
      preset === 'sprint'
        ? 'assignee = currentUser() AND sprint in openSprints() ORDER BY updated DESC'
        : ''
    setJql(preset === 'sprint' ? q : '')
    void search(q)
  }

  const linkedByKey = new Map<string, TaskInfo>()
  for (const t of [...snapshot.tasks, ...snapshot.archived]) {
    const k = t.record?.meta?.jiraKey
    if (typeof k === 'string' && k) linkedByKey.set(k.toUpperCase(), t)
  }

  const slug = (key: string): string => 'jira-' + key.toLowerCase().replace(/[^a-z0-9-]+/g, '-')

  const importIssue = async (issue: JiraIssue): Promise<void> => {
    setBusyKey(issue.key)
    const res = await api.createTaskFromJira({
      dirName: slug(issue.key),
      title: `[${issue.key}] ${issue.summary}`,
      description: `从 Jira 导入 ${issue.key}\n类型：${issue.issueType} · 优先级：${issue.priority} · 负责人：${issue.assignee}\n链接：${issue.url}`,
      status: JIRA_CATEGORY_STATUS[issue.statusCategory] ?? 'planning',
      priority: priorityOf(issue.priority),
      assignee: snapshot.meta.developer ?? settings.jira.user,
      jiraKey: issue.key,
      jiraUrl: issue.url
    })
    setBusyKey(null)
    if (res.ok) {
      pushToast({ kind: 'success', title: `已导入 ${issue.key}`, body: `创建任务目录 ${res.dirName}` })
    } else {
      pushToast({ kind: 'error', title: `导入 ${issue.key} 失败`, body: res.error })
    }
  }

  const syncIssue = async (issue: JiraIssue): Promise<void> => {
    const linked = linkedByKey.get(issue.key.toUpperCase())
    if (!linked?.record) return
    setBusyKey(issue.key)
    const custom = cfg.statusMap?.[issue.status]
    const trellisStatus = custom ?? JIRA_CATEGORY_STATUS[issue.statusCategory] ?? 'planning'
    const patch: Record<string, unknown> = { status: trellisStatus }
    const res = await api.updateTask(linked.path, patch)
    setBusyKey(null)
    if (res.ok) {
      pushToast({
        kind: 'success',
        title: `${issue.key} 已同步`,
        body: `Jira「${issue.status}」→ Trellis「${statusLabel(trellisStatus)}」${custom ? '（自定义映射）' : ''}`
      })
    } else {
      pushToast({ kind: 'error', title: `${issue.key} 同步失败`, body: res.error })
    }
  }

  const pushStatusToJira = async (issue: JiraIssue): Promise<void> => {
    const linked = linkedByKey.get(issue.key.toUpperCase())
    if (!linked?.record) return
    setBusyKey(issue.key)
    const tr = await api.jiraTransitions(cfg, issue.key)
    if (!tr.ok || !tr.transitions?.length) {
      setBusyKey(null)
      pushToast({ kind: 'error', title: `${issue.key} 无可用流转`, body: tr.error })
      return
    }
    const target =
      linked.record.status === 'completed'
        ? tr.transitions.find((t) => /完成|关闭|done|close|resolve/i.test(t.name))
        : linked.record.status === 'review'
          ? tr.transitions.find((t) => /评审|测试|审核|review/i.test(t.name))
          : tr.transitions.find((t) => /进行|开始|开发|start|progress|in progress/i.test(t.name))
    if (!target) {
      setBusyKey(null)
      pushToast({ kind: 'warn', title: `${issue.key} 未找到匹配的流转`, body: `可用：${tr.transitions.map((t) => t.name).join('、')}` })
      return
    }
    const res = await api.jiraTransition(cfg, issue.key, target.id)
    setBusyKey(null)
    if (res.ok) {
      pushToast({ kind: 'success', title: `${issue.key} → ${target.name}`, body: '已推送 Trellis 状态到 Jira' })
      void search(jql)
    } else {
      pushToast({ kind: 'error', title: `${issue.key} 流转失败`, body: res.error })
    }
  }

  const addProgressComment = async (issue: JiraIssue): Promise<void> => {
    const linked = linkedByKey.get(issue.key.toUpperCase())
    if (!linked?.record) return
    setBusyKey(issue.key)
    const body = `[Trellis Panel] 任务进度同步\n- Trellis 状态：${statusLabel(linked.record.status)}\n- 目录：${linked.dirName}\n- 分支：${linked.record.branch ?? '—'}\n- 更新时间：${new Date().toLocaleString('zh-CN')}`
    const res = await api.jiraComment(cfg, issue.key, body)
    setBusyKey(null)
    if (res.ok) pushToast({ kind: 'success', title: `已评论 ${issue.key}`, body: '进度评论已发布到 Jira' })
    else pushToast({ kind: 'error', title: `评论 ${issue.key} 失败`, body: res.error })
  }

  const linkExisting = async (issue: JiraIssue, dirName: string): Promise<void> => {
    const t = snapshot.tasks.find((x) => x.dirName === dirName)
    if (!t?.record) return
    setBusyKey(issue.key)
    const notes = `${t.record.notes ? t.record.notes + '\n' : ''}关联 Jira：${issue.key}（${issue.status}）\n${issue.url}`
    const patch = { notes, meta: { ...t.record.meta, jiraKey: issue.key, jiraUrl: issue.url } }
    const res = await api.updateTask(t.path, patch as never)
    setBusyKey(null)
    if (res.ok) {
      setLinkTargets((m) => {
        const n = { ...m }
        delete n[issue.key]
        return n
      })
      pushToast({ kind: 'success', title: `${issue.key} 已关联 ${dirName}` })
    } else {
      pushToast({ kind: 'error', title: '关联失败', body: res.error })
    }
  }

  if (!cfg?.enabled) {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="max-w-sm text-center">
          <Link2 size={28} className="mx-auto mb-3 text-mist-500" />
          <div className="mb-1.5 text-sm font-medium text-mist-100">尚未启用 Jira 集成</div>
          <p className="mb-4 text-xs leading-5 text-mist-400">
            在「设置 → Jira 集成」中填写服务器地址与账号，即可把 Jira 待办导入为 Trellis 任务、
            双向同步状态，并把 Trellis 进度以评论形式回写到 Jira。
          </p>
          <button onClick={() => useApp.getState().setPage('settings')} className="btn-primary">
            前往设置
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full animate-fade-in flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-700 bg-ink-850/40 px-5 py-2.5">
        <h1 className="text-sm font-semibold text-mist-50">Jira 任务</h1>
        <span className="chip bg-blue-500/15 font-mono text-blue-300">{cfg.baseUrl.replace(/^https?:\/\//, '')}</span>
        <div className="flex overflow-hidden rounded-lg border border-ink-500">
          <button
            onClick={() => quickSearch('mine')}
            className="px-2.5 py-1.5 text-[11px] text-mist-300 transition-colors hover:bg-ink-700/40"
            title="assignee = currentUser()"
          >
            我的待办
          </button>
          <button
            onClick={() => quickSearch('sprint')}
            className="px-2.5 py-1.5 text-[11px] text-mist-300 transition-colors hover:bg-ink-700/40"
            title="当前冲刺中的任务"
          >
            当前冲刺
          </button>
        </div>
        <div className="relative min-w-[260px] flex-1 max-w-md">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-mist-500" />
          <input
            value={jql}
            onChange={(e) => setJql(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void search(jql)}
            placeholder="自定义 JQL，如 project = HONSKY AND status != 完成（留空 = 我的待办）"
            className="field w-full pl-8"
          />
        </div>
        <button onClick={() => void search(jql)} disabled={loading} className="btn-primary disabled:opacity-50">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          {loading ? '查询中…' : '查询'}
        </button>
        <span className="text-[11px] text-mist-500">共 {total} 条</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {error && (
          <div className="mx-auto mb-4 max-w-3xl rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-300">
            {error}
          </div>
        )}
        <div className="mx-auto max-w-3xl space-y-2">
          {issues.map((issue) => {
            const linked = linkedByKey.get(issue.key.toUpperCase())
            const busy = busyKey === issue.key
            return (
              <div key={issue.key} className="card px-4 py-3">
                <div className="flex items-start gap-3">
                  <span className="chip mt-0.5 shrink-0 bg-blue-500/15 font-mono text-[11px] text-blue-300">
                    {issue.key}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-mist-100" title={issue.summary}>
                      {issue.summary}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-mist-400">
                      <span className="chip border border-ink-500 text-mist-300">{issue.issueType}</span>
                      <span className="chip border border-ink-500 text-mist-300">{issue.status}</span>
                      <span className="chip border border-ink-500 text-mist-300">{issue.priority}</span>
                      <span>{issue.assignee}</span>
                      <span>{issue.updated ? fmtIso(issue.updated) : ''}</span>
                      {linked && (
                        <span className="chip border border-leaf-dim/30 bg-leaf/10 text-leaf-soft">
                          ✓ 已关联 {linked.dirName}
                        </span>
                      )}
                    </div>
                    {linked && (
                      <select
                        value={linkTargets[issue.key] ?? ''}
                        onChange={(e) => setLinkTargets((m) => ({ ...m, [issue.key]: e.target.value }))}
                        className="field mt-2 w-56"
                      >
                        <option value="">关联到已有任务…</option>
                        {snapshot.tasks.map((t) => (
                          <option key={t.dirName} value={t.dirName}>{t.dirName}</option>
                        ))}
                      </select>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <div className="flex gap-1.5">
                      {!linked ? (
                        <button disabled={busy} onClick={() => void importIssue(issue)} className="btn-primary disabled:opacity-50">
                          <Download size={11} /> {busy ? '导入中…' : '导入任务'}
                        </button>
                      ) : (
                        <>
                          <button disabled={busy} onClick={() => void syncIssue(issue)} className="btn-outline disabled:opacity-50" title="Jira 状态 → Trellis 任务">
                            <RefreshCw size={11} /> 同步
                          </button>
                          <button disabled={busy} onClick={() => void pushStatusToJira(issue)} className="btn-outline disabled:opacity-50" title="Trellis 状态 → Jira 流转">
                            <ArrowRightCircle size={11} /> 推送
                          </button>
                        </>
                      )}
                    </div>
                    <div className="flex gap-1.5">
                      {linked && linkTargets[issue.key] && (
                        <button
                          disabled={busy}
                          onClick={() => void linkExisting(issue, linkTargets[issue.key])}
                          className="btn-outline disabled:opacity-50"
                        >
                          <CheckCircle2 size={11} /> 确认关联
                        </button>
                      )}
                      {linked && (
                        <button disabled={busy} onClick={() => void addProgressComment(issue)} className="btn-ghost disabled:opacity-50">
                          <MessageSquarePlus size={11} /> 回写进度
                        </button>
                      )}
                      <button onClick={() => api.openExternal(issue.url)} className="btn-ghost px-1.5" title="在浏览器打开">
                        <ExternalLink size={11} />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
          {!loading && issues.length === 0 && !error && (
            <div className={clsx('py-16 text-center text-xs text-mist-500')}>没有匹配的 Jira 问题</div>
          )}
        </div>
      </div>
    </div>
  )
}

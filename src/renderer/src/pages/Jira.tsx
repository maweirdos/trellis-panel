import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  RefreshCw,
  Download,
  ExternalLink,
  Link2,
  CheckCircle2,
  Search,
  MessageSquarePlus,
  ArrowRightCircle,
  Tag,
  EyeOff,
  Eye,
  Layers
} from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import { JIRA_CATEGORY_STATUS, statusLabel } from '../utils/labels'
import type { JSX } from 'react'
import type { JiraIssue, TaskInfo } from '../../../shared/types'

function priorityOf(name: string): string {
  if (/highest|最高/i.test(name)) return 'P0'
  if (/high|高/i.test(name)) return 'P1'
  if (/low|低/i.test(name)) return 'P3'
  return 'P2'
}

/** 组装最终 JQL：用户输入（或默认我的待办）+ 可选过滤已完成；ORDER BY 摘出来放最后 */
function composeJql(userJql: string, hideDone: boolean): string {
  const raw = userJql.trim() || 'assignee = currentUser()'
  const parts = raw.split(/\s+order\s+by\s+/i)
  const core = parts[0].trim()
  const order = parts.length > 1 ? ` ORDER BY ${parts.slice(1).join(' ')}` : ' ORDER BY updated DESC'
  return hideDone ? `(${core}) AND statusCategory != Done${order}` : `${core}${order}`
}

const STATUS_PILL: Record<string, string> = {
  new: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  indeterminate: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  done: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
}

const NO_VERSION = '无版本'

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
  /** 正在展开「关联到已有任务」的问题 */
  const [linkingKey, setLinkingKey] = useState<string | null>(null)
  /** 默认隐藏已关闭/完成的历史问题 */
  const [hideDone, setHideDone] = useState(true)
  /** 按修复版本分组展示 */
  const [groupByVersion, setGroupByVersion] = useState(true)

  const cfg = settings.jira

  const search = useCallback(
    async (query: string, hideOverride?: boolean): Promise<void> => {
      if (!cfg?.enabled || !cfg.baseUrl) {
        setError('尚未配置 Jira 连接 —— 请先到「设置 → Jira 连接」填写并保存')
        return
      }
      setLoading(true)
      setError(null)
      const res = await api.jiraSearch(cfg, composeJql(query, hideOverride ?? hideDone))
      setLoading(false)
      if (res.ok && res.issues) {
        setIssues(res.issues)
        setTotal(res.total ?? res.issues.length)
      } else {
        setError(res.error ?? '查询失败')
        setIssues([])
      }
    },
    [cfg, hideDone]
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

  /* 版本分组：命名版本按自然序倒排（新的在上），无版本殿后 */
  const versionGroups = useMemo<Array<{ version: string; issues: JiraIssue[] }>>(() => {
    const map = new Map<string, JiraIssue[]>()
    for (const it of issues) {
      const v = it.fixVersions[0] ?? NO_VERSION
      const list = map.get(v) ?? []
      list.push(it)
      map.set(v, list)
    }
    return [...map.entries()]
      .sort(([a], [b]) => {
        if (a === NO_VERSION) return 1
        if (b === NO_VERSION) return -1
        return -a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
      })
      .map(([version, list]) => ({ version, issues: list }))
  }, [issues])

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
      pushToast({ kind: 'success', title: `已加入待办：${issue.key}`, body: `创建任务目录 ${res.dirName}，等待 AI 认领` })
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

  const renderIssue = (issue: JiraIssue, groupVersion?: string): JSX.Element => {
    const linked = linkedByKey.get(issue.key.toUpperCase())
    const busy = busyKey === issue.key
    const linking = linkingKey === issue.key
    // 版本分组时行内不再重复当前分组版本，仅展示额外 fixVersion
    const versionChips = groupByVersion
      ? issue.fixVersions.filter((v) => v !== groupVersion)
      : issue.fixVersions
    return (
      <div key={issue.key} className="card px-3.5 py-2.5 transition-colors hover:border-ink-500">
        <div className="flex items-center gap-2">
          <span className="chip shrink-0 bg-blue-500/15 font-mono text-[10.5px] text-blue-300">{issue.key}</span>
          <span className={clsx('chip shrink-0 border', STATUS_PILL[issue.statusCategory] ?? 'border-ink-500 text-mist-300')}>
            {issue.status}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-mist-100" title={issue.summary}>
            {issue.summary}
          </span>
          <span className="shrink-0 text-[10.5px] text-mist-400">{issue.assignee}</span>
          <span className="shrink-0 font-mono text-[10px] text-mist-600" title="最近更新">
            {(issue.updated || '').slice(0, 10)}
          </span>
          <button onClick={() => api.openExternal(issue.url)} className="btn-ghost shrink-0 px-1 py-0.5" title="在浏览器打开">
            <ExternalLink size={11} />
          </button>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[10.5px] text-mist-400">
          <span className="chip border border-ink-600 text-mist-300">{issue.issueType}</span>
          <span className="chip border border-ink-600 text-mist-300">{issue.priority}</span>
          {versionChips.map((v) => (
            <span key={v} className="chip border border-violet-500/30 bg-violet-500/10 font-mono text-violet-300" title="修复版本">
              <Tag size={9} /> {v}
            </span>
          ))}
          {linked && (
            <span className="chip border border-leaf-dim/30 bg-leaf/10 text-leaf-soft" title={`已关联本地任务 ${linked.dirName}`}>
              ✓ {linked.dirName}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            {!linked ? (
              <>
                <button disabled={busy} onClick={() => void importIssue(issue)} className="btn-primary px-2 py-1 text-[10.5px] disabled:opacity-50">
                  <Download size={10} /> {busy ? '加入中…' : '加入待办'}
                </button>
                {!linking && (
                  <button onClick={() => setLinkingKey(issue.key)} className="btn-ghost px-1.5 py-1 text-[10.5px]" title="关联到已有本地任务">
                    <Link2 size={10} /> 关联
                  </button>
                )}
              </>
            ) : (
              <>
                <button disabled={busy} onClick={() => void syncIssue(issue)} className="btn-ghost px-1.5 py-1 text-[10.5px] disabled:opacity-50" title="Jira 状态 → Trellis 任务">
                  <RefreshCw size={10} /> 同步
                </button>
                <button disabled={busy} onClick={() => void pushStatusToJira(issue)} className="btn-ghost px-1.5 py-1 text-[10.5px] disabled:opacity-50" title="Trellis 状态 → Jira 流转">
                  <ArrowRightCircle size={10} /> 推送
                </button>
                <button disabled={busy} onClick={() => void addProgressComment(issue)} className="btn-ghost px-1.5 py-1 text-[10.5px] disabled:opacity-50" title="把任务进度以评论回写到 Jira">
                  <MessageSquarePlus size={10} /> 回写
                </button>
              </>
            )}
          </div>
        </div>
        {linking && !linked && (
          <div className="mt-2 flex items-center gap-1.5">
            <select
              autoFocus
              value={linkTargets[issue.key] ?? ''}
              onChange={(e) => setLinkTargets((m) => ({ ...m, [issue.key]: e.target.value }))}
              className="field flex-1"
            >
              <option value="">选择要关联的本地任务…</option>
              {snapshot.tasks.map((t) => (
                <option key={t.dirName} value={t.dirName}>{t.dirName}</option>
              ))}
            </select>
            <button
              disabled={busy || !linkTargets[issue.key]}
              onClick={() => void linkExisting(issue, linkTargets[issue.key])}
              className="btn-outline px-2 py-1 text-[10.5px] disabled:opacity-50"
            >
              <CheckCircle2 size={10} /> 确认
            </button>
            <button onClick={() => setLinkingKey(null)} className="btn-ghost px-1.5 py-1 text-[10.5px]">
              取消
            </button>
          </div>
        )}
      </div>
    )
  }

  if (!cfg?.enabled) {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="max-w-sm text-center">
          <Link2 size={28} className="mx-auto mb-3 text-mist-500" />
          <div className="mb-1.5 text-sm font-medium text-mist-100">尚未启用 Jira 连接</div>
          <p className="mb-4 text-xs leading-5 text-mist-400">
            在「设置 → Jira 连接」中填写服务器地址与账号，即可把 Jira 待办导入为 Trellis 任务、
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
        <button
          onClick={() => {
            const v = !hideDone
            setHideDone(v)
            void search(jql, v)
          }}
          className={clsx(
            'chip border transition-colors',
            hideDone ? 'border-leaf-dim/50 text-leaf-soft' : 'border-ink-500 text-mist-400'
          )}
          title="隐藏 statusCategory = Done 的已关闭/已完成问题"
        >
          {hideDone ? <EyeOff size={11} /> : <Eye size={11} />} 已关闭{hideDone ? ' · 隐藏' : ' · 显示'}
        </button>
        <button
          onClick={() => setGroupByVersion((v) => !v)}
          className={clsx(
            'chip border transition-colors',
            groupByVersion ? 'border-leaf-dim/50 text-leaf-soft' : 'border-ink-500 text-mist-400'
          )}
          title="按修复版本（fixVersion）分组"
        >
          <Layers size={11} /> 版本分组{groupByVersion ? ' 开' : ' 关'}
        </button>
        <button onClick={() => void search(jql)} disabled={loading} className="btn-primary disabled:opacity-50">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          {loading ? '查询中…' : '查询'}
        </button>
        <span className="text-[11px] text-mist-500">
          显示 {issues.length} / 共 {total} 条
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {error && (
          <div className="mx-auto mb-4 max-w-3xl rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-300">
            {error}
          </div>
        )}
        <div className="mx-auto max-w-3xl space-y-2">
          {groupByVersion
            ? versionGroups.map((g) => (
                <div key={g.version} className="space-y-2">
                  <div className="flex items-center gap-1.5 px-1 pb-1 pt-2 text-[11px] text-mist-300">
                    <Tag size={11} className="text-mist-500" />
                    <span className="font-mono font-medium text-mist-100">{g.version}</span>
                    <span className="text-mist-600">· {g.issues.length} 个问题</span>
                    <span className="ml-1 h-px flex-1 bg-ink-700" />
                  </div>
                  {g.issues.map((issue) => renderIssue(issue, g.version))}
                </div>
              ))
            : issues.map((issue) => renderIssue(issue))}
          {!loading && issues.length === 0 && !error && (
            <div className={clsx('py-16 text-center text-xs text-mist-500')}>没有匹配的 Jira 问题</div>
          )}
        </div>
      </div>
    </div>
  )
}

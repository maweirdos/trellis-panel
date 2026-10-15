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
  Layers,
  Wand2,
  FolderPlus
} from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import { Button } from '../my/ui'
import { JIRA_CATEGORY_STATUS, statusLabel } from '../utils/labels'
import { PlanningModal, type PlanningSeed } from '../components/PlanningModal'
import type { JSX } from 'react'
import type { JiraIssue, JiraIssueDetail, JiraPagedSearchMeta, TaskInfo } from '../../../shared/types'

function priorityOf(name: string): string {
  if (/highest|最高/i.test(name)) return 'P0'
  if (/high|高/i.test(name)) return 'P1'
  if (/low|低/i.test(name)) return 'P3'
  return 'P2'
}

/**
 * G4：创建失败分级文案（design §7.2 语义红线：未创建≠失败、超时≠成功）。
 * 按 serviceCode 给出可操作的下一步，不静默吞错；detail 为服务侧已脱敏的错误文本。
 */
function describeCreateFailure(res: {
  code?: string
  serviceCode?: string
}): { kind: 'error' | 'warn'; title: string; body: (detail: string) => string } {
  if (res.code === 'E_NO_PROJECT') {
    return { kind: 'warn', title: '未打开项目', body: () => '本入口只在当前已打开的项目中创建任务；请先打开项目后重试' }
  }
  switch (res.serviceCode) {
    case 'conflict':
      return {
        kind: 'error',
        title: '同名或多任务冲突，需人工确认',
        body: (d) => `${d}。面板不自动选择、不使用 --force；请在任务目录人工确认后重试`
      }
    case 'control_store':
      return { kind: 'error', title: '本地控制库不可用', body: (d) => `任务未被创建（可安全重试）：${d}` }
    case 'cli_failed':
      return { kind: 'error', title: 'task.py create 失败', body: (d) => `任务未被创建（可安全重试）：${d}` }
    case 'interrupted':
      return {
        kind: 'warn',
        title: '创建被中断，可恢复',
        body: (d) => `目录已保留：再次点击同一入口会续写补完，不会重复建任务。${d}`
      }
    case 'invalid':
      return { kind: 'warn', title: '创建参数不合法', body: (d) => d }
    default:
      return { kind: 'error', title: '创建失败', body: (d) => d }
  }
}

const SAMPLE_REASON: Record<string, string> = {
  max_pages: '已达最大页数',
  page_failed: '有页失败（重试耗尽）'
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
  new: 'border-my-label-indigo-border bg-my-label-indigo text-my-label-indigo-text',
  indeterminate: 'border-my-label-yellow-border bg-my-label-yellow text-my-label-yellow-text',
  done: 'border-my-label-emerald-border bg-my-label-emerald text-my-label-emerald-text'
}

const NO_VERSION = '无版本'

export function JiraPage(): JSX.Element {
  const settings = useApp((s) => s.settings)!
  const snapshot = useApp((s) => s.snapshot)!
  const pushToast = useApp((s) => s.pushToast)
  const saveTodo = useApp((s) => s.saveTodo)
  const todos = useApp((s) => s.todos)
  const setPage = useApp((s) => s.setPage)
  const showTask = useApp((s) => s.showTask)
  const refresh = useApp((s) => s.refresh)

  const [issues, setIssues] = useState<JiraIssueDetail[]>([])
  const [total, setTotal] = useState(0)
  /** 分页完整性口径（design §7.1）：sample ≠ 查询失败，样本如实标注 */
  const [searchMeta, setSearchMeta] = useState<JiraPagedSearchMeta | null>(null)
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
  /** AI 规划工作台的种子（Jira issue） */
  const [planSeed, setPlanSeed] = useState<PlanningSeed | null>(null)
  /** G4 轻任务入口：同键 in-flight 防抖（重复点击并发只跑一次服务调用） */
  const [creatingKey, setCreatingKey] = useState<string | null>(null)
  /** G4 轻任务入口：服务返回的本地任务定位（created/already 共用；键为 issue.key 大写） */
  const [localTasks, setLocalTasks] = useState<Record<string, { dirName: string; archived: boolean }>>({})

  const cfg = settings.jira

  const search = useCallback(
    async (query: string, hideOverride?: boolean): Promise<void> => {
      if (!cfg?.enabled || !cfg.baseUrl) {
        setError('尚未配置 Jira 连接 —— 请先到「设置 → Jira 连接」填写并保存')
        return
      }
      setLoading(true)
      setError(null)
      // G4 第二片：分页查询（完整字段 issueId/description/updatedAtMs 供本地任务创建消费；
      // 旧单页 jira:search 保留给 AcpConsole 等既有调用方，零回归）
      const res = await api.jiraSearchPaged(cfg, composeJql(query, hideOverride ?? hideDone))
      setLoading(false)
      if (res.ok && res.issues) {
        setIssues(res.issues)
        setTotal(res.total ?? res.issues.length)
        setSearchMeta(res.meta ?? null)
      } else {
        setError(res.error ?? '查询失败')
        setIssues([])
        setSearchMeta(null)
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
  const versionGroups = useMemo<Array<{ version: string; issues: JiraIssueDetail[] }>>(() => {
    const map = new Map<string, JiraIssueDetail[]>()
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

  /* 本地关联索引：旧 meta.jiraKey（手动关联/旧流程）+ 新 panel_jira_issue_key（G4 服务创建）双索引 */
  const linkedByKey = useMemo(() => {
    const map = new Map<string, TaskInfo>()
    for (const t of [...snapshot.tasks, ...snapshot.archived]) {
      const meta = t.record?.meta
      for (const k of [meta?.jiraKey, meta?.panel_jira_issue_key]) {
        if (typeof k === 'string' && k) map.set(k.toUpperCase(), t)
      }
    }
    return map
  }, [snapshot.tasks, snapshot.archived])

  /* G4 轻任务入口的已知定位：快照关联 ∪ 服务返回（服务结果覆盖，避免快照竞态） */
  const entryByKey = useMemo(() => {
    const m = new Map<string, { dirName: string; archived: boolean }>()
    for (const [k, t] of linkedByKey) m.set(k, { dirName: t.dirName, archived: Boolean(t.archived) })
    for (const [k, v] of Object.entries(localTasks)) m.set(k, v)
    return m
  }, [linkedByKey, localTasks])

  /** G4：打开（定位）本地任务——跳任务页选中；归档任务不跳空列表，如实提示去归档页。 */
  const openLocalTask = (dirName: string, archived: boolean, issueKey: string): void => {
    if (archived) {
      pushToast({
        kind: 'info',
        title: `${issueKey} 关联的本地任务已归档`,
        body: `任务目录 ${dirName} 已在归档区，可在「归档」页查看`
      })
      return
    }
    setPage('tasks')
    showTask(dirName, false)
  }

  /**
   * G4：Jira 行 → 本地轻任务入口（design §7.2 单一创建器，全部经 task:createFromJira）。
   * - 已知定位 → 直接打开；否则携带工单完整字段调用服务，按 created/already 切换文案。
   * - 不提供「一单多任务」快捷入口（服务支持 allowAdditional，UI 保持显式后置）。
   * - 入口只作用于当前已打开项目（换仓库须显式选择，不在本入口隐式切换）。
   */
  const createOrOpenLocal = async (issue: JiraIssueDetail): Promise<void> => {
    const key = issue.key.toUpperCase()
    const known = entryByKey.get(key)
    if (known) {
      openLocalTask(known.dirName, known.archived, issue.key)
      return
    }
    if (creatingKey !== null) return // 同键 in-flight 防抖（重复点击只跑一次）
    setCreatingKey(issue.key)
    setBusyKey(issue.key)
    let res
    try {
      res = await api.createTaskFromJira({
        jiraKey: issue.key,
        issueId: issue.issueId,
        title: `[${issue.key}] ${issue.summary}`,
        description: issue.summary,
        fullDescription: issue.description,
        jiraUrl: issue.url,
        priority: priorityOf(issue.priority),
        assignee: snapshot?.meta.developer || issue.assignee,
        updatedAtMs: issue.updatedAtMs,
        allowAdditional: false
      })
    } finally {
      // invoke 意外 reject 也必须复位入口，否则全部行卡在禁用（check P3-2）
      setCreatingKey(null)
      setBusyKey(null)
    }
    if (res.ok && res.dirName) {
      const archived = res.archived === true
      setLocalTasks((m) => ({ ...m, [key]: { dirName: res.dirName as string, archived } }))
      if (res.created) await refresh() // 新任务先进快照再跳转，避免空选中
      if (archived) {
        openLocalTask(res.dirName, true, issue.key)
        return
      }
      const notes = (res.notes ?? []).join('；')
      pushToast({
        kind: 'success',
        title: res.already ? `${issue.key} 已打开已有本地任务` : `${issue.key} 已在当前项目创建任务`,
        body: `任务目录 ${res.dirName}${notes ? `（${notes}）` : ''}`
      })
      openLocalTask(res.dirName, false, issue.key)
      return
    }
    // 失败分级：控制库/CLI/冲突/中断各给可操作文案，不静默（未创建≠失败：可安全重试的明说）
    const tier = describeCreateFailure(res)
    pushToast({ kind: tier.kind, title: `${issue.key} ${tier.title}`, body: tier.body(res.error ?? '未知错误') })
  }

  const importToBacklog = async (issue: JiraIssue): Promise<void> => {
    setBusyKey(issue.key)
    const ok = await saveTodo({
      id: issue.key,
      title: `[${issue.key}] ${issue.summary}`,
      description: `### Jira 信息\n- 关键标识：${issue.key}\n- 需求类型：${issue.issueType}\n- 优先级：${issue.priority}\n- 负责人：${issue.assignee}\n- 原始链接：${issue.url}\n\n### 需求描述\n${issue.summary}\n`,
      priority: priorityOf(issue.priority),
      source: 'jira',
      jiraKey: issue.key,
      jiraUrl: issue.url
    })
    setBusyKey(null)
    if (ok) {
      pushToast({ kind: 'success', title: `已加入待办池：${issue.key}`, body: `保存为 .trellis/todos/${issue.key}.md，可供 AI 读取` })
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

  const renderIssue = (issue: JiraIssueDetail, groupVersion?: string): JSX.Element => {
    const linked = linkedByKey.get(issue.key.toUpperCase())
    const busy = busyKey === issue.key
    const linking = linkingKey === issue.key
    const creating = creatingKey === issue.key
    const knownLocal = entryByKey.get(issue.key.toUpperCase())
    // 版本分组时行内不再重复当前分组版本，仅展示额外 fixVersion
    const versionChips = groupByVersion
      ? issue.fixVersions.filter((v) => v !== groupVersion)
      : issue.fixVersions
    const inTodos = todos.some((t) => t.jiraKey === issue.key || t.id === issue.key)
    return (
      <div key={issue.key} className="my-card px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <span className="my-chip shrink-0 bg-my-label-indigo font-mono text-my-label-indigo-text">{issue.key}</span>
          <span className={clsx('my-chip shrink-0 border', STATUS_PILL[issue.statusCategory] ?? 'border-my-line text-my-secondary')}>
            {issue.status}
          </span>
          <span className="min-w-0 flex-1 truncate text-my-xs font-medium text-my-primary" title={issue.summary}>
            {issue.summary}
          </span>
          <span className="shrink-0 text-my-xs text-my-tertiary">{issue.assignee}</span>
          <span className="shrink-0 font-mono text-my-2xs text-my-placeholder" title="最近更新">
            {(issue.updated || '').slice(0, 10)}
          </span>
          <Button variant="ghost" size="sm" className="shrink-0" onClick={() => api.openExternal(issue.url)} title="在浏览器打开">
            <ExternalLink size={11} />
          </Button>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-my-xs text-my-tertiary">
          <span className="my-chip border border-my-line text-my-secondary">{issue.issueType}</span>
          <span className="my-chip border border-my-line text-my-secondary">{issue.priority}</span>
          {versionChips.map((v) => (
            <span key={v} className="my-chip border border-my-label-purple-border bg-my-label-purple font-mono text-my-label-purple-text" title="修复版本">
              <Tag size={9} /> {v}
            </span>
          ))}
          {linked && (
            <span className="my-chip border border-my-line-accent-subtle bg-my-accent-subtle text-my-accent-text" title={`已关联本地任务 ${linked.dirName}`}>
              ✓ {linked.dirName}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            {/* G4：轻任务入口——同一按钮按服务返回 created/already 切换文案；只作用于当前已打开项目 */}
            <Button
              size="sm"
              variant={knownLocal ? 'outline' : 'primary'}
              disabled={!snapshot || busy || creatingKey !== null}
              onClick={() => void createOrOpenLocal(issue)}
              title={
                !snapshot
                  ? '未打开项目——本入口只在当前已打开的项目中创建任务，请先打开项目'
                  : knownLocal
                    ? `打开当前项目中的本地任务 ${knownLocal.dirName}（重复点击不重复创建）`
                    : '在当前已打开的项目中创建本地轻任务（task.py create --no-start + 来源 PRD 草稿）'
              }
            >
              <FolderPlus size={10} /> {creating ? '创建中…' : knownLocal ? '打开本地任务' : '在当前项目创建任务'}
            </Button>
            {!linked ? (
              <>
                {inTodos ? (
                  <span className="my-chip border border-my-label-yellow-border bg-my-label-yellow text-my-label-yellow-text" title="已在本地待办池中">
                    ✓ 已在待办池
                  </span>
                ) : (
                  <Button variant="primary" size="sm" disabled={busy} onClick={() => void importToBacklog(issue)}>
                    <Download size={10} /> {busy ? '加入中…' : '加入待办池'}
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={() => setPlanSeed({ title: issue.summary, description: `从 Jira ${issue.key} 规划（类型：${issue.issueType} · 优先级：${issue.priority} · 负责人：${issue.assignee}）\n\n${issue.summary}`, jiraKey: issue.key, jiraUrl: issue.url })} title="知识库 → AI 任务规划">
                  <Wand2 size={10} /> AI 规划
                </Button>
                {!linking && (
                  <Button variant="ghost" size="sm" onClick={() => setLinkingKey(issue.key)} title="关联到已有本地任务">
                    <Link2 size={10} /> 关联
                  </Button>
                )}
              </>
            ) : (
              <>
                {/* R0：Jira→Trellis 状态直写（同步按钮）已停用——任务阶段收归外部工作流，页面对账化 */}
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void pushStatusToJira(issue)} title="Trellis 状态 → Jira 流转">
                  <ArrowRightCircle size={10} /> 推送
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void addProgressComment(issue)} title="把任务进度以评论回写到 Jira">
                  <MessageSquarePlus size={10} /> 回写
                </Button>
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
              className="h-8 min-w-0 flex-1 rounded-my-md border border-my-line bg-my-surface-1 px-2 text-my-sm text-my-primary outline-none focus:border-my-line-accent [&>option]:bg-my-layer-2 [&>option]:text-my-primary"
            >
              <option value="">选择要关联的本地任务…</option>
              {snapshot.tasks.map((t) => (
                <option key={t.dirName} value={t.dirName}>{t.dirName}</option>
              ))}
            </select>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !linkTargets[issue.key]}
              onClick={() => void linkExisting(issue, linkTargets[issue.key])}
            >
              <CheckCircle2 size={10} /> 确认
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setLinkingKey(null)}>
              取消
            </Button>
          </div>
        )}
      </div>
    )
  }

  if (!cfg?.enabled) {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="max-w-sm text-center">
          <Link2 size={28} className="mx-auto mb-3 text-my-tertiary" />
          <div className="mb-1.5 text-my-sm font-medium text-my-primary">尚未启用 Jira 连接</div>
          <p className="mb-4 text-my-xs leading-5 text-my-tertiary">
            在「设置 → Jira 连接」中填写服务器地址与账号，即可把 Jira 待办导入为 Trellis 任务、
            双向同步状态，并把 Trellis 进度以评论形式回写到 Jira。
          </p>
          <Button variant="primary" onClick={() => useApp.getState().setPage('settings')}>
            前往设置
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-my-line px-5 py-2.5">
        <span className="my-chip bg-my-label-indigo font-mono text-my-label-indigo-text">{cfg.baseUrl.replace(/^https?:\/\//, '')}</span>
        <div className="flex overflow-hidden rounded-my-md border border-my-line">
          <button
            onClick={() => quickSearch('mine')}
            className="px-2.5 py-1.5 text-my-sm text-my-secondary transition-colors hover:bg-my-layer-1"
            title="assignee = currentUser()"
          >
            我的待办
          </button>
          <button
            onClick={() => quickSearch('sprint')}
            className="px-2.5 py-1.5 text-my-sm text-my-secondary transition-colors hover:bg-my-layer-1"
            title="当前冲刺中的任务"
          >
            当前冲刺
          </button>
        </div>
        <div className="relative min-w-[260px] flex-1 max-w-md">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-my-tertiary" />
          <input
            value={jql}
            onChange={(e) => setJql(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void search(jql)}
            placeholder="自定义 JQL，如 project = HONSKY AND status != 完成（留空 = 我的待办）"
            className="h-8 w-full rounded-my-md border border-my-line bg-my-surface-1 pl-7 pr-2 text-my-sm text-my-primary outline-none placeholder:text-my-placeholder focus:border-my-line-accent"
          />
        </div>
        <button
          onClick={() => {
            const v = !hideDone
            setHideDone(v)
            void search(jql, v)
          }}
          className={clsx(
            'my-chip border transition-colors',
            hideDone ? 'border-my-line-accent-subtle text-my-accent-text' : 'border-my-line text-my-tertiary'
          )}
          title="隐藏 statusCategory = Done 的已关闭/已完成问题"
        >
          {hideDone ? <EyeOff size={11} /> : <Eye size={11} />} 已关闭{hideDone ? ' · 隐藏' : ' · 显示'}
        </button>
        <button
          onClick={() => setGroupByVersion((v) => !v)}
          className={clsx(
            'my-chip border transition-colors',
            groupByVersion ? 'border-my-line-accent-subtle text-my-accent-text' : 'border-my-line text-my-tertiary'
          )}
          title="按修复版本（fixVersion）分组"
        >
          <Layers size={11} /> 版本分组{groupByVersion ? ' 开' : ' 关'}
        </button>
        <Button variant="primary" onClick={() => void search(jql)} disabled={loading}>
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          {loading ? '查询中…' : '查询'}
        </Button>
        <span className="text-my-xs text-my-tertiary">
          显示 {issues.length} / 共 {total} 条
        </span>
        {searchMeta?.sample && (
          <span
            className="my-chip border border-my-label-yellow-border bg-my-label-yellow text-my-label-yellow-text"
            title={`结果为样本，不是完整集合（去重 ${searchMeta.duplicateCount} 条；采集 ${searchMeta.pagesFetched} 页）`}
          >
            样本 · {SAMPLE_REASON[searchMeta.incompleteReason ?? ''] ?? '未取全'}
          </span>
        )}
      </div>

      <div className="p-5">
        {error && (
          <div className="mx-auto mb-4 max-w-3xl rounded-my-lg border border-my-line-danger bg-my-danger-subtle px-4 py-2.5 text-my-xs text-my-danger-text">
            {error}
          </div>
        )}
        <div className="mx-auto max-w-3xl space-y-2">
          {groupByVersion
            ? versionGroups.map((g) => (
                <div key={g.version} className="space-y-2">
                  <div className="flex items-center gap-1.5 px-1 pb-1 pt-2 text-my-xs text-my-secondary">
                    <Tag size={11} className="text-my-tertiary" />
                    <span className="font-mono font-medium text-my-primary">{g.version}</span>
                    <span className="text-my-placeholder">· {g.issues.length} 个问题</span>
                    <span className="ml-1 h-px flex-1 bg-my-line" />
                  </div>
                  {g.issues.map((issue) => renderIssue(issue, g.version))}
                </div>
              ))
            : issues.map((issue) => renderIssue(issue))}
          {!loading && issues.length === 0 && !error && (
            <div className={clsx('py-16 text-center text-my-xs text-my-tertiary')}>没有匹配的 Jira 问题</div>
          )}
        </div>
      </div>

      {planSeed && <PlanningModal seed={planSeed} onClose={() => setPlanSeed(null)} />}
    </div>
  )
}

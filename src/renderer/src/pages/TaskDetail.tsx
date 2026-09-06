import { useEffect, useMemo, useState } from 'react'
import {
  X,
  FolderOpen,
  ExternalLink,
  SquarePen,
  Circle,
  CircleCheck,
  FileWarning,
  FileText,
  GitCompare,
  Save,
  RotateCcw,
  Bot,
  Zap,
  RefreshCw,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  ArrowUpRight,
  ArrowDownLeft,
  Check,
  Plus
} from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import { PriorityBadge, StatusBadge, JiraChip } from '../components/badges'
import { STATUS_OPTIONS, statusLabel } from '../utils/labels'
import { fmtBytes, parseSubtask, taskDateLabel } from '../utils/format'
import { DiffModal } from './DiffModal'
import type { JSX } from 'react'
import type { TaskGitInfo, TaskInfo, TaskPatch } from '../../../shared/types'

const FIELD_LABEL: Record<string, string> = {
  title: '标题',
  description: '描述',
  status: '状态',
  priority: '优先级',
  assignee: '负责人',
  notes: '备注',
  branch: '分支',
  pr_url: 'PR 链接'
}

function Row({ label, modified, children }: { label: string; modified?: boolean; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="w-16 shrink-0 pt-0.5 text-[11px] text-mist-500">
        {label}
        {modified && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-400 align-middle" title="待保存修改" />}
      </span>
      <div className="min-w-0 flex-1 text-xs text-mist-200">{children}</div>
    </div>
  )
}

function FieldRow({
  field,
  label,
  value,
  pendingValue,
  onChange,
  multiline,
  options,
  display
}: {
  field: string
  label: string
  value: string
  pendingValue: string | null | undefined
  onChange: (field: string, v: string) => void
  multiline?: boolean
  options?: Array<{ value: string; label: string }>
  display?: (v: string) => string
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const shown = pendingValue ?? value
  const modified = pendingValue !== undefined && pendingValue !== null && pendingValue !== value

  useEffect(() => {
    if (!editing) setDraft(shown)
  }, [shown, editing])

  const done = (): void => {
    if (draft !== shown) onChange(field, draft)
    setEditing(false)
  }

  return (
    <Row label={label} modified={modified}>
      {editing ? (
        <div className="space-y-1.5">
          {options ? (
            <select
              autoFocus
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                onChange(field, e.target.value)
                setEditing(false)
              }}
              onBlur={() => setEditing(false)}
              className="field"
            >
              {options.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          ) : multiline ? (
            <textarea
              autoFocus
              rows={3}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="field resize-y"
            />
          ) : (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') done()
                if (e.key === 'Escape') setEditing(false)
              }}
              className="field"
            />
          )}
          {!options && (
            <div className="flex gap-1.5">
              <button onClick={done} className="btn-primary px-2 py-0.5">
                确认
              </button>
              <button onClick={() => setEditing(false)} className="btn-ghost px-2 py-0.5">
                取消
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="group flex items-start gap-1.5">
          <span className={clsx('min-w-0 flex-1 whitespace-pre-wrap break-words', modified && 'text-leaf-soft')}>
            {(display ? display(shown) : shown) || <span className="text-mist-600">—</span>}
            {modified && value && (
              <span className="ml-1.5 text-[10px] text-mist-600 line-through">{display ? display(value) : value}</span>
            )}
          </span>
          <button
            onClick={() => setEditing(true)}
            className="mt-0.5 shrink-0 text-mist-600 opacity-0 transition-opacity hover:text-mist-200 group-hover:opacity-100"
            title="编辑"
          >
            <SquarePen size={12} />
          </button>
        </div>
      )}
    </Row>
  )
}

export function TaskDetail({
  onOpenArtifact
}: {
  onOpenArtifact: (f: { name: string; path: string; kind: 'file' | 'dir'; size: number; mtime: number; ext: string }) => void
}): JSX.Element | null {
  const snapshot = useApp((s) => s.snapshot)
  const settings = useApp((s) => s.settings)
  const openTaskDir = useApp((s) => s.openTaskDir)
  const archived = useApp((s) => s.openTaskArchived)
  const showTask = useApp((s) => s.showTask)
  const pushToast = useApp((s) => s.pushToast)

  const [tab, setTab] = useState<'info' | 'artifacts'>('info')
  const [pending, setPending] = useState<TaskPatch>({})
  const [showDiff, setShowDiff] = useState(false)
  const [syncingJira, setSyncingJira] = useState(false)
  const [aiBusy, setAiBusy] = useState<string | null>(null)
  const [git, setGit] = useState<TaskGitInfo | null>(null)
  const [gitLoading, setGitLoading] = useState(false)
  const [newBranch, setNewBranch] = useState('')
  /** task.json mtime captured when the drawer opened — for conflict detection */
  const [openedMtime, setOpenedMtime] = useState<number | undefined>(undefined)

  useEffect(() => {
    setTab('info')
    setPending({})
    setShowDiff(false)
    setGit(null)
    setOpenedMtime(task?.taskJsonMtime)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTaskDir])

  // load git info when drawer opens or a rescan lands (30s-cached in main)
  const scannedAt = useApp((s) => s.snapshot?.scannedAt)
  useEffect(() => {
    if (!openTaskDir || archived) return
    setGitLoading(true)
    api.gitTaskInfo(openTaskDir).then((g) => {
      setGit(g)
      setGitLoading(false)
    })
  }, [openTaskDir, archived, scannedAt])

  const task: TaskInfo | undefined = useMemo(
    () =>
      snapshot
        ? archived
          ? snapshot.archived.find((t) => t.path === openTaskDir)
          : snapshot.tasks.find((t) => t.dirName === openTaskDir)
        : undefined,
    [snapshot, archived, openTaskDir]
  )

  if (!task) return null
  const r = task.record
  const jiraKey = typeof r?.meta?.jiraKey === 'string' ? (r.meta.jiraKey as string) : null
  const jiraUrl = typeof r?.meta?.jiraUrl === 'string' ? (r.meta.jiraUrl as string) : null
  const pendingCount = Object.keys(pending).length

  const setField = (field: string, v: string): void => {
    setPending((p) => {
      const next = { ...p, [field]: v } as TaskPatch
      if (String(next[field as keyof TaskPatch]) === String((r as any)?.[field] ?? '')) {
        delete next[field as keyof TaskPatch]
      }
      return next
    })
  }

  const saveAll = async (): Promise<void> => {
    if (!pendingCount) return
    const res = await api.updateTask(task.path, pending, openedMtime)
    if (res.ok) {
      pushToast({ kind: 'success', title: '任务已保存', body: `${pendingCount} 处修改已写入 task.json` })
      setPending({})
      setShowDiff(false)
      setOpenedMtime(snapshot?.tasks.find((t) => t.dirName === task.dirName)?.taskJsonMtime)
    } else if (res.conflict) {
      pushToast({
        kind: 'warn',
        title: '保存冲突',
        body: 'task.json 已被外部修改（AI 工具或其他成员）。已刷新最新内容，请核对后重试。'
      })
      setPending({})
      setShowDiff(false)
      await useApp.getState().refresh()
    } else {
      pushToast({ kind: 'error', title: '保存失败', body: res.error })
    }
  }

  const toggleSubtask = async (idx: number): Promise<void> => {
    if (!r) return
    const next = r.subtasks.map((s, i) => {
      if (i !== idx) return s
      const { done, text } = parseSubtask(s)
      return `[${done ? ' ' : 'x'}] ${text}`
    })
    const res = await api.updateTask(task.path, { subtasks: next }, task.taskJsonMtime)
    if (!res.ok) pushToast({ kind: 'error', title: '更新失败', body: res.error })
  }

  const syncJira = async (): Promise<void> => {
    if (!jiraKey || !settings?.jira?.enabled) return
    setSyncingJira(true)
    const res = await api.jiraSearch(settings.jira, `issuekey = ${jiraKey}`)
    setSyncingJira(false)
    const issue = res.issues?.[0]
    if (!res.ok || !issue) {
      pushToast({ kind: 'error', title: 'Jira 同步失败', body: res.error ?? '未找到该问题' })
      return
    }
    const map: Record<string, string> = { new: 'planning', indeterminate: 'in_progress', done: 'completed' }
    const trellisStatus = map[issue.statusCategory] ?? 'planning'
    const patch: TaskPatch = { status: trellisStatus }
    if (issue.summary !== r?.title) patch.title = issue.summary
    const res2 = await api.updateTask(task.path, patch, task.taskJsonMtime)
    if (res2.ok) {
      pushToast({
        kind: 'success',
        title: `Jira ${jiraKey} 已同步`,
        body: `状态：${issue.status} → ${statusLabel(trellisStatus)}`
      })
    } else {
      pushToast({ kind: 'error', title: '同步写入失败', body: res2.error })
    }
  }

  const launchAi = async (app: 'codex' | 'zcode' | 'claude'): Promise<void> => {
    setAiBusy(app)
    const res = await api.launchAiApp(app, task.dirName)
    setAiBusy(null)
    if (res.ok) {
      pushToast({ kind: 'success', title: `已在终端调起 ${app}`, body: '任务上下文已注入提示词' })
    } else {
      pushToast({ kind: 'error', title: `调起 ${app} 失败`, body: res.error })
    }
  }

  return (
    <div className="relative flex h-full w-[460px] shrink-0 animate-slide-in flex-col border-l border-ink-700 bg-ink-850 shadow-2xl">
      <div className="flex items-start gap-2 border-b border-ink-700 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            {r && <StatusBadge status={pending.status ?? r.status} />}
            {r && <PriorityBadge priority={pending.priority ?? r.priority} />}
            {jiraKey && <JiraChip jiraKey={jiraKey} />}
            <span className="font-mono text-[10px] text-mist-500">
              {taskDateLabel(task.dirName, task.date)}
              {archived ? ' · 已归档' : ''}
            </span>
          </div>
          <h2 className="line-clamp-2 text-[13px] font-semibold leading-5 text-mist-50">
            {pending.title ?? r?.title ?? task.dirName}
          </h2>
          <div className="mt-0.5 font-mono text-[10.5px] text-mist-500">{task.dirName}</div>
        </div>
        <button onClick={() => showTask(null)} className="btn-ghost px-1.5 py-1" title="关闭">
          <X size={15} />
        </button>
      </div>

      {/* tabs */}
      <div className="flex border-b border-ink-700 bg-ink-850 px-2">
        {(
          [
            ['info', '详情'],
            ['artifacts', `产物 (${task.artifacts.length})`]
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={clsx(
              'relative px-3 py-2 text-xs transition-colors',
              tab === id ? 'font-medium text-leaf-soft' : 'text-mist-400 hover:text-mist-200'
            )}
          >
            {label}
            {tab === id && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded bg-leaf" />}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 pb-20">
        {tab === 'info' && (
          <div className="space-y-1 divide-y divide-ink-700/50">
            {task.parseError && (
              <div className="mb-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-300">
                task.json 解析失败：{task.parseError}
              </div>
            )}
            {r ? (
              <>
                <FieldRow field="title" label="标题" value={r.title} pendingValue={pending.title} onChange={setField} />
                <FieldRow
                  field="status"
                  label="状态"
                  value={r.status}
                  pendingValue={pending.status}
                  onChange={setField}
                  options={STATUS_OPTIONS}
                  display={statusLabel}
                />
                <FieldRow
                  field="priority"
                  label="优先级"
                  value={r.priority}
                  pendingValue={pending.priority}
                  onChange={setField}
                  options={[
                    { value: 'P0', label: '紧急 P0' },
                    { value: 'P1', label: '高 P1' },
                    { value: 'P2', label: '中 P2' },
                    { value: 'P3', label: '低 P3' }
                  ]}
                />
                <FieldRow field="assignee" label="负责人" value={r.assignee} pendingValue={pending.assignee} onChange={setField} />
                <FieldRow field="branch" label="分支" value={r.branch ?? ''} pendingValue={pending.branch} onChange={setField} />
                <FieldRow field="pr_url" label="PR 链接" value={r.pr_url ?? ''} pendingValue={pending.pr_url} onChange={setField} />
                <FieldRow
                  field="description"
                  label="描述"
                  value={r.description}
                  pendingValue={pending.description}
                  onChange={setField}
                  multiline
                />
                <FieldRow field="notes" label="备注" value={r.notes} pendingValue={pending.notes} onChange={setField} multiline />

                {r.subtasks.length > 0 && (
                  <div className="py-1.5">
                    <div className="mb-1.5 text-[11px] text-mist-500">子任务</div>
                    <div className="space-y-1">
                      {r.subtasks.map((s, i) => {
                        const { done, text, isCheckable } = parseSubtask(s)
                        return (
                          <div key={i} className="flex items-start gap-2 text-xs text-mist-200">
                            {isCheckable ? (
                              <button onClick={() => void toggleSubtask(i)} className="mt-0.5 shrink-0">
                                {done ? (
                                  <CircleCheck size={13} className="text-leaf" />
                                ) : (
                                  <Circle size={13} className="text-mist-500 hover:text-mist-300" />
                                )}
                              </button>
                            ) : null}
                            <span className={clsx(done && 'text-mist-500 line-through')}>{text}</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-x-4 py-1.5 text-[11px] leading-5 text-mist-400">
                  <span>创建者</span><span className="text-right text-mist-200">{r.creator || '—'}</span>
                  <span>创建时间</span><span className="text-right font-mono text-mist-200">{r.createdAt || '—'}</span>
                  <span>完成时间</span><span className="text-right font-mono text-mist-200">{r.completedAt ?? '—'}</span>
                  <span>基础分支</span><span className="text-right font-mono text-mist-200">{r.base_branch ?? '—'}</span>
                  <span>任务类型</span><span className="text-right text-mist-200">{r.dev_type ?? '—'}</span>
                  <span>范围 / 包</span><span className="text-right text-mist-200">{[r.scope, r.package].filter(Boolean).join(' / ') || '—'}</span>
                  <span>提交</span><span className="truncate text-right font-mono text-mist-200">{r.commit ?? '—'}</span>
                  <span>工作树</span><span className="truncate text-right font-mono text-mist-200">{r.worktree_path ?? '—'}</span>
                  <span>父任务</span><span className="truncate text-right font-mono text-mist-200">{r.parent ?? '—'}</span>
                  <span>子任务(引用)</span><span className="truncate text-right font-mono text-mist-200">{r.children.length ? r.children.join(', ') : '—'}</span>
                </div>

                {r.relatedFiles.length > 0 && (
                  <div className="py-1.5">
                    <div className="mb-1.5 text-[11px] text-mist-500">相关文件</div>
                    <div className="space-y-0.5">
                      {r.relatedFiles.map((f) => (
                        <div key={f} className="break-all font-mono text-[11px] text-mist-300">· {f}</div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Git 集成 */}
                {!archived && (
                  <div className="pt-3">
                    <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-mist-500">
                      <GitBranch size={12} /> Git 状态
                      {gitLoading && <RefreshCw size={10} className="animate-spin" />}
                    </div>
                    {git?.error ? (
                      <div className="text-[11px] text-mist-600">{git.error}</div>
                    ) : git ? (
                      <div className="space-y-1.5 rounded-lg border border-ink-700 bg-ink-800/60 px-3 py-2.5 text-[11px]">
                        <div className="flex items-center gap-2">
                          <span className="chip bg-ink-750 font-mono text-mist-300">{r.branch ?? '无分支'}</span>
                          {git.ahead > 0 && (
                            <span className="chip border border-sky-500/30 text-sky-300">
                              <ArrowUpRight size={10} /> 领先 {git.ahead}
                            </span>
                          )}
                          {git.behind > 0 && (
                            <span className="chip border border-orange-500/30 text-orange-300">
                              <ArrowDownLeft size={10} /> 落后 {git.behind}
                            </span>
                          )}
                          {git.worktreeDirty && <span className="chip border border-amber-500/30 text-amber-300">有未提交改动</span>}
                        </div>
                        {git.merged && (
                          <div className="flex items-center gap-1.5 rounded bg-emerald-500/10 px-2 py-1 text-emerald-300">
                            <GitMerge size={11} /> 分支已合入 {r.base_branch ?? '主分支'}
                            {r.status !== 'completed' && (
                              <button
                                onClick={() => setPending((p) => ({ ...p, status: 'completed' }))}
                                className="ml-auto flex items-center gap-0.5 text-[10.5px] underline"
                              >
                                标记为已完成 <Check size={10} />
                              </button>
                            )}
                          </div>
                        )}
                        {git.commits.length > 0 && (
                          <div className="space-y-1">
                            {git.commits.slice(0, 4).map((c) => (
                              <div key={c.short} className="flex items-center gap-2 text-[10.5px] text-mist-400">
                                <GitCommitHorizontal size={10} className="shrink-0" />
                                <span className="font-mono text-mist-300">{c.short}</span>
                                <span className="min-w-0 flex-1 truncate">{c.subject}</span>
                                <span className="shrink-0">{c.author}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {!r.branch && (
                          <div className="flex items-center gap-1.5 pt-0.5">
                            <input
                              value={newBranch}
                              onChange={(e) => setNewBranch(e.target.value)}
                              placeholder={`从 ${r.base_branch ?? 'main'} 新建分支…`}
                              className="field flex-1 font-mono"
                            />
                            <button
                              disabled={!newBranch.trim()}
                              onClick={async () => {
                                const res = await api.gitCreateBranch(newBranch.trim(), r?.base_branch ?? 'main')
                                if (res.ok) {
                                  const w = await api.updateTask(task.path, { branch: newBranch.trim() }, task.taskJsonMtime)
                                  if (w.ok) {
                                    setNewBranch('')
                                    pushToast({ kind: 'success', title: '分支已创建并关联', body: newBranch })
                                  } else {
                                    pushToast({ kind: 'warn', title: '分支已创建，关联失败', body: w.error })
                                  }
                                } else {
                                  pushToast({ kind: 'error', title: '建分支失败', body: res.error })
                                }
                              }}
                              className="btn-outline disabled:opacity-50"
                            >
                              <Plus size={11} /> 创建
                            </button>
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>
                )}

                {/* AI 调起 */}
                <div className="pt-3">
                  <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-mist-500">
                    <Bot size={12} /> 把任务交给 AI 工具继续
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <button disabled={aiBusy !== null} onClick={() => void launchAi('codex')} className="btn-outline disabled:opacity-50">
                      <Zap size={12} /> {aiBusy === 'codex' ? '调起中…' : 'Codex 接手'}
                    </button>
                    <button disabled={aiBusy !== null} onClick={() => void launchAi('zcode')} className="btn-outline disabled:opacity-50">
                      <Zap size={12} /> {aiBusy === 'zcode' ? '调起中…' : 'ZCode 接手'}
                    </button>
                    <button disabled={aiBusy !== null} onClick={() => void launchAi('claude')} className="btn-outline disabled:opacity-50">
                      <Zap size={12} /> {aiBusy === 'claude' ? '调起中…' : 'Claude 接手'}
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 pt-3">
                  <button onClick={() => api.revealInExplorer(task.path)} className="btn-outline">
                    <FolderOpen size={12} /> 打开目录
                  </button>
                  <button onClick={() => api.openInEditor(task.path)} className="btn-outline">
                    <ExternalLink size={12} /> 编辑器打开
                  </button>
                  {jiraKey && (
                    <>
                      {jiraUrl && (
                        <button onClick={() => api.openExternal(jiraUrl)} className="btn-outline">
                          <ExternalLink size={12} /> Jira {jiraKey}
                        </button>
                      )}
                      {settings?.jira?.enabled && (
                        <button onClick={() => void syncJira()} disabled={syncingJira} className="btn-outline disabled:opacity-50">
                          <RefreshCw size={12} className={syncingJira ? 'animate-spin' : ''} />
                          {syncingJira ? '同步中…' : '从 Jira 同步'}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </>
            ) : (
              <div className="py-6 text-center text-xs text-mist-500">缺少 task.json</div>
            )}
          </div>
        )}

        {tab === 'artifacts' && (
          <div className="space-y-1">
            {task.artifacts.length === 0 && (
              <div className="py-6 text-center text-xs text-mist-500">该任务目录暂无其他产物文件</div>
            )}
            {task.artifacts.map((f) => {
              const clickable = f.kind === 'file' && /\.(md|markdown|json|jsonl|txt|yaml|yml|log|py|ts|js)$/i.test(f.name)
              return (
                <button
                  key={f.path}
                  disabled={!clickable}
                  onClick={() => clickable && onOpenArtifact(f)}
                  className={clsx(
                    'flex w-full items-center gap-2.5 rounded-lg border border-transparent px-3 py-2 text-left transition-colors',
                    clickable
                      ? 'hover:border-ink-600 hover:bg-ink-750/60'
                      : 'cursor-default opacity-60'
                  )}
                >
                  <FileText size={13} className={clsx('shrink-0', /\.md$/i.test(f.name) ? 'text-leaf' : 'text-mist-500')} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-mist-200">{f.name}</span>
                  <span className="shrink-0 text-[10.5px] text-mist-500">{f.kind === 'file' ? fmtBytes(f.size) : '目录'}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* 待保存修改 footer */}
      {pendingCount > 0 && (
        <div className="absolute inset-x-0 bottom-0 z-10 flex animate-fade-in items-center gap-2 border-t border-ink-600 bg-ink-800/95 px-4 py-2.5 backdrop-blur">
          <span className="text-[11px] text-amber-300">
            {pendingCount} 处待保存修改
          </span>
          <div className="ml-auto flex gap-1.5">
            <button onClick={() => setPending({})} className="btn-ghost" title="放弃全部修改">
              <RotateCcw size={12} /> 放弃
            </button>
            <button onClick={() => setShowDiff(true)} className="btn-outline">
              <GitCompare size={12} /> 预览
            </button>
            <button onClick={() => void saveAll()} className="btn-primary">
              <Save size={12} /> 保存
            </button>
          </div>
        </div>
      )}

      {showDiff && (
        <DiffModal
          task={task}
          pending={pending}
          onCancel={() => setShowDiff(false)}
          onSave={() => void saveAll()}
        />
      )}
    </div>
  )
}

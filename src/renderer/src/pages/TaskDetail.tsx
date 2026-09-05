import { useEffect, useState } from 'react'
import {
  X,
  FileText,
  FolderOpen,
  ExternalLink,
  SquarePen,
  Circle,
  CircleCheck,
  FileWarning
} from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import { MarkdownView } from '../components/MarkdownView'
import { PriorityBadge, StatusBadge } from '../components/badges'
import { fmtBytes, parseSubtask, taskDateLabel } from '../utils/format'
import type { JSX } from 'react'
import type { FileEntry, TaskInfo, TaskPatch, TaskPriority, TaskStatus } from '../../../shared/types'

const STATUS_OPTIONS: Array<{ v: TaskStatus; l: string }> = [
  { v: 'planning', l: '规划中' },
  { v: 'in_progress', l: '进行中' },
  { v: 'review', l: '评审中' },
  { v: 'completed', l: '已完成' }
]

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="w-16 shrink-0 pt-0.5 text-[11px] text-mist-500">{label}</span>
      <div className="min-w-0 flex-1 text-xs text-mist-200">{children}</div>
    </div>
  )
}

function FieldRow({
  label,
  value,
  onSave,
  multiline,
  options
}: {
  label: string
  value: string
  onSave: (v: string) => Promise<void>
  multiline?: boolean
  options?: string[]
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])

  const commit = async (): Promise<void> => {
    if (draft !== value) {
      setBusy(true)
      await onSave(draft)
      setBusy(false)
    }
    setEditing(false)
  }

  return (
    <Row label={label}>
      {editing ? (
        <div className="space-y-1.5">
          {options ? (
            // Selection fields commit immediately on change — a separate
            // save button would lose the click to the select's blur-cancel.
            <select
              autoFocus
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                setBusy(true)
                void onSave(e.target.value).finally(() => setBusy(false))
                setEditing(false)
              }}
              onBlur={() => setEditing(false)}
              className="field"
            >
              {options.map((o) => (
                <option key={o} value={o}>{o}</option>
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
                if (e.key === 'Enter') void commit()
                if (e.key === 'Escape') setEditing(false)
              }}
              className="field"
            />
          )}
          <div className="flex gap-1.5">
            <button disabled={busy} onClick={() => void commit()} className="btn-primary px-2 py-0.5">
              保存
            </button>
            <button onClick={() => setEditing(false)} className="btn-ghost px-2 py-0.5">
              取消
            </button>
          </div>
        </div>
      ) : (
        <div className="group flex items-start gap-1.5">
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{value || <span className="text-mist-600">—</span>}</span>
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

function ArtifactPreview({ file, onClose }: { file: FileEntry; onClose: () => void }): JSX.Element | null {
  const [state, setState] = useState<{ loading: boolean; content?: string; error?: string }>({ loading: true })

  useEffect(() => {
    let alive = true
    setState({ loading: true })
    api.readTextFile(file.path).then((res) => {
      if (!alive) return
      if (res.ok) setState({ loading: false, content: res.content })
      else setState({ loading: false, error: res.error })
    })
    return () => {
      alive = false
    }
  }, [file.path])

  const isMd = /\.(md|markdown)$/i.test(file.name)

  return (
    <div className="absolute inset-0 z-20 flex animate-fade-in flex-col rounded-r-xl bg-ink-850">
      <div className="flex items-center gap-2 border-b border-ink-700 px-4 py-2.5">
        <FileText size={13} className="text-leaf" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-mist-200">{file.name}</span>
        <span className="text-[10.5px] text-mist-500">{fmtBytes(file.size)}</span>
        <button onClick={onClose} className="btn-ghost px-1.5 py-1" title="关闭预览">
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-auto px-5 py-4">
        {state.loading && <div className="text-xs text-mist-500">加载中…</div>}
        {state.error && (
          <div className="flex items-center gap-1.5 text-xs text-rose-300">
            <FileWarning size={13} /> {state.error}
          </div>
        )}
        {!state.loading && !state.error && isMd && <MarkdownView content={state.content ?? ''} />}
        {!state.loading && !state.error && !isMd && (
          <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-5 text-mist-300">
            {state.content}
          </pre>
        )}
      </div>
    </div>
  )
}

export function TaskDetail(): JSX.Element | null {
  const snapshot = useApp((s) => s.snapshot)
  const openTaskDir = useApp((s) => s.openTaskDir)
  const archived = useApp((s) => s.openTaskArchived)
  const showTask = useApp((s) => s.showTask)

  const [previewFile, setPreviewFile] = useState<FileEntry | null>(null)
  const [tab, setTab] = useState<'info' | 'artifacts'>('info')

  useEffect(() => {
    setPreviewFile(null)
    setTab('info')
  }, [openTaskDir])

  const task: TaskInfo | undefined = snapshot
    ? archived
      ? snapshot.archived.find((t) => t.path === openTaskDir)
      : snapshot.tasks.find((t) => t.dirName === openTaskDir)
    : undefined

  if (!task) return null
  const r = task.record

  const save = async (patch: TaskPatch): Promise<void> => {
    await api.updateTask(task.path, patch)
  }

  const toggleSubtask = async (idx: number): Promise<void> => {
    if (!r) return
    const next = r.subtasks.map((s, i) => {
      if (i !== idx) return s
      const { done, text } = parseSubtask(s)
      return `[${done ? ' ' : 'x'}] ${text}`
    })
    await save({ subtasks: next })
  }

  return (
    <div className="relative flex w-[460px] shrink-0 animate-slide-in flex-col border-l border-ink-700 bg-ink-850">
      <div className="relative z-30 flex items-start gap-2 border-b border-ink-700 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-1.5">
            {r && <StatusBadge status={r.status} />}
            {r && <PriorityBadge priority={r.priority} />}
            <span className="font-mono text-[10px] text-mist-500">
              {taskDateLabel(task.dirName, task.date)}
              {archived ? ' · 已归档' : ''}
            </span>
          </div>
          <h2 className="line-clamp-2 text-[13px] font-semibold leading-5 text-mist-50">
            {r?.title ?? task.dirName}
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
            ['info', `详情`],
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

      <div className="flex-1 overflow-y-auto p-4">
        {tab === 'info' && (
          <div className="space-y-1 divide-y divide-ink-700/50">
            {task.parseError && (
              <div className="mb-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-300">
                task.json 解析失败：{task.parseError}
              </div>
            )}
            {r ? (
              <>
                <FieldRow label="标题" value={r.title} onSave={(v) => save({ title: v })} />
                <FieldRow label="状态" value={r.status} onSave={(v) => save({ status: v })} options={STATUS_OPTIONS.map((o) => o.v)} />
                <FieldRow label="优先级" value={r.priority} onSave={(v) => save({ priority: v })} options={[...['P0', 'P1', 'P2', 'P3']]} />
                <FieldRow label="负责人" value={r.assignee} onSave={(v) => save({ assignee: v })} />
                <FieldRow label="分支" value={r.branch ?? ''} onSave={(v) => save({ branch: v || null })} />
                <FieldRow label="PR 链接" value={r.pr_url ?? ''} onSave={(v) => save({ pr_url: v || null })} />
                <FieldRow label="描述" value={r.description} onSave={(v) => save({ description: v })} multiline />
                <FieldRow label="备注" value={r.notes} onSave={(v) => save({ notes: v })} multiline />

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
                  <span>dev_type</span><span className="text-right text-mist-200">{r.dev_type ?? '—'}</span>
                  <span>scope / package</span><span className="text-right text-mist-200">{[r.scope, r.package].filter(Boolean).join(' / ') || '—'}</span>
                  <span>commit</span><span className="text-right font-mono text-mist-200">{r.commit ?? '—'}</span>
                  <span>worktree</span><span className="truncate text-right font-mono text-mist-200">{r.worktree_path ?? '—'}</span>
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

                <div className="flex gap-2 pt-3">
                  <button onClick={() => api.revealInExplorer(task.path)} className="btn-outline">
                    <FolderOpen size={12} /> 打开目录
                  </button>
                  <button onClick={() => api.openInEditor(task.path)} className="btn-outline">
                    <ExternalLink size={12} /> 编辑器打开
                  </button>
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
                  onClick={() => clickable && setPreviewFile(f)}
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

      {previewFile && <ArtifactPreview file={previewFile} onClose={() => setPreviewFile(null)} />}
    </div>
  )
}

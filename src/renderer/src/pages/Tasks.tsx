import { useEffect, useMemo, useState } from 'react'
import {
  Search,
  Filter,
  Inbox,
  LayoutGrid,
  Rows3,
  Users2,
  Star,
  Paperclip,
  CircleCheck,
  ChevronDown,
  ChevronRight,
  Sparkles,
  Layers,
  BookOpenText,
  Loader2,
  Wand2,
  ExternalLink,
  PanelLeftClose,
  FolderOpen,
  Archive,
  GitBranch,
  Timer,
  Split
} from 'lucide-react'
import { useApp } from '../store'
import { clsx } from 'clsx'
import { PriorityBadge, StatusBadge, JiraChip } from '../components/badges'
import { statusLabel } from '../utils/labels'
import { taskDateLabel } from '../utils/format'
import { api } from '../api'
import { MarkdownView } from '../components/MarkdownView'
import { PlanningModal, type PlanningSeed } from '../components/PlanningModal'
import { DoDModal } from '../components/DoDModal'
import { FocusTimer } from '../components/FocusTimer'
import type { JSX } from 'react'
import type { TaskInfo } from '../../../shared/types'

type ViewMode = 'board' | 'list' | 'swimlane' | 'reader'

const COLUMNS: Array<{ status: string; label: string; dot: string; ring: string }> = [
  { status: 'planning', label: '规划中', dot: 'bg-sky-400', ring: 'ring-sky-500/40' },
  { status: 'in_progress', label: '进行中', dot: 'bg-amber-400', ring: 'ring-amber-500/40' },
  { status: 'review', label: '评审中', dot: 'bg-violet-400', ring: 'ring-violet-500/40' },
  { status: 'completed', label: '已完成', dot: 'bg-emerald-400', ring: 'ring-emerald-500/40' }
]

function jiraKeyOf(t: TaskInfo): string | null {
  const k = t.record?.meta?.jiraKey
  return typeof k === 'string' && k ? k : null
}

function subtaskProgress(t: TaskInfo): { done: number; total: number } | null {
  const list = t.record?.subtasks ?? []
  if (list.length === 0) return null
  const done = list.filter((s) => /\[[xX]\]/.test(s.trim().replace(/^-\s*/, ''))).length
  return { done, total: list.length }
}

const statusOf = (t: TaskInfo): string => (t.record?.status ?? '').toLowerCase()

const matchCol = (t: TaskInfo, status: string): boolean =>
  statusOf(t) === status || (status === 'completed' && statusOf(t) === 'done')

/** resolve a parent/child textual reference (dirName | id | name) to an actual task */
function matchTaskByRef(ref: string | null | undefined, tasks: TaskInfo[]): TaskInfo | undefined {
  if (!ref) return undefined
  const r = ref.toLowerCase()
  return tasks.find(
    (t) =>
      t.dirName.toLowerCase() === r ||
      (t.record?.id ?? '').toLowerCase() === r ||
      (t.record?.name ?? '').toLowerCase() === r
  )
}

/* ---------------- Kanban card ---------------- */

function TaskCard({ t, onOpen }: { t: TaskInfo; onOpen: () => void }): JSX.Element {
  const current = useApp((s) => s.snapshot?.meta.currentTask)
  const isCurrent = current === t.dirName
  const prog = subtaskProgress(t)
  const jira = jiraKeyOf(t)
  const fullTitle = t.record?.title ?? t.dirName
  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/task-dir', t.dirName)}
      onClick={onOpen}
      title={`${fullTitle}${t.record?.assignee ? ` · ${t.record.assignee}` : ''}`}
      className="group cursor-pointer rounded-lg border border-ink-700 bg-ink-800 px-3 py-2.5 transition-all hover:border-ink-500 hover:shadow-md active:cursor-grabbing"
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <PriorityBadge priority={t.record?.priority ?? ''} />
        <span className="font-mono text-[10px] text-mist-500">{taskDateLabel(t.dirName, t.date)}</span>
        {isCurrent && <Star size={11} className="text-leaf" fill="currentColor" />}
        {t.parseError && <span className="ml-auto text-[10px] text-rose-400">JSON 错误</span>}
      </div>
      <div className="line-clamp-2 text-xs leading-5 text-mist-100">{fullTitle}</div>
      <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-mist-500">
        <span className="truncate" title={t.record?.assignee || t.record?.creator || '未分配'}>
          {t.record?.assignee || t.record?.creator || '未分配'}
        </span>
        {jira && <JiraChip jiraKey={jira} />}
        {prog && (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <CircleCheck size={10} className={prog.done === prog.total ? 'text-leaf' : 'text-mist-600'} />
            {prog.done}/{prog.total}
          </span>
        )}
        {t.artifacts.length > 0 && (
          <span className="flex shrink-0 items-center gap-0.5">
            <Paperclip size={10} />
            {t.artifacts.length}
          </span>
        )}
        {t.record?.pr_url && (
          <a
            href="#"
            onClick={(e) => {
              e.stopPropagation()
              void api.openExternal(t.record!.pr_url!)
            }}
            className="shrink-0 text-leaf-soft/80 hover:text-leaf-soft"
          >
            PR ↗
          </a>
        )}
      </div>
    </div>
  )
}

/* ---------------- Epic card（需求 → 子任务折叠组） ---------------- */

function EpicCard({
  epic,
  children,
  onOpen
}: {
  epic: TaskInfo
  children: TaskInfo[]
  onOpen: (dir: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const done = children.filter((c) => matchCol(c, 'completed')).length
  const prog = subtaskProgress(epic)
  const fullTitle = epic.record?.title ?? epic.dirName
  return (
    <div
      className={clsx(
        'overflow-hidden rounded-lg border transition-all',
        open ? 'border-leaf-dim/40 bg-ink-800' : 'border-ink-700 bg-ink-800/80 hover:border-ink-500'
      )}
    >
      <button onClick={() => setOpen((o) => !o)} className="w-full px-3 py-2.5 text-left" title={fullTitle}>
        <div className="flex items-center gap-1.5">
          {open ? (
            <ChevronDown size={12} className="shrink-0 text-leaf" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-mist-500" />
          )}
          <Layers size={11} className="shrink-0 text-leaf" />
          <span className="text-[10px] font-medium uppercase tracking-wide text-leaf-soft/80">需求组</span>
          <span className="ml-auto shrink-0 rounded bg-ink-750 px-1.5 font-mono text-[10px] text-mist-400">
            {done}/{children.length}
          </span>
        </div>
        <div className="mt-1.5 line-clamp-2 pl-4 text-xs leading-5 text-mist-100">{fullTitle}</div>
        <div className="mt-1.5 flex items-center gap-2 pl-4 text-[10.5px] text-mist-500">
          <span className="truncate">{epic.record?.assignee || epic.record?.creator || '未分配'}</span>
          {prog && (
            <span className="ml-auto flex shrink-0 items-center gap-1">
              <CircleCheck size={10} className={prog.done === prog.total ? 'text-leaf' : 'text-mist-600'} />
              {prog.done}/{prog.total}
            </span>
          )}
        </div>
        <div className="ml-4 mt-2 h-1 overflow-hidden rounded-full bg-ink-700">
          <div
            className="h-full rounded-full bg-leaf-dim/80 transition-all"
            style={{ width: `${children.length ? (done / children.length) * 100 : 0}%` }}
          />
        </div>
      </button>
      {open && (
        <div className="space-y-1 border-t border-ink-700/70 bg-ink-850/60 p-2">
          {children.map((c) => {
            const st = statusOf(c)
            const col = COLUMNS.find((x) => matchCol(c, x.status))
            return (
              <button
                key={c.dirName}
                onClick={() => onOpen(c.dirName)}
                className="flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors hover:border-ink-600 hover:bg-ink-750/60"
                title={c.record?.title ?? c.dirName}
              >
                <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', col?.dot ?? 'bg-mist-600')} />
                <span className="min-w-0 flex-1 truncate text-[11px] text-mist-200">{c.record?.title ?? c.dirName}</span>
                <span className="shrink-0 text-[10px] text-mist-500">{c.record?.assignee || col?.label || statusLabel(st)}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ---------------- List row ---------------- */

function TaskRow({ t, onOpen }: { t: TaskInfo; onOpen: () => void }): JSX.Element {
  const jira = jiraKeyOf(t)
  return (
    <div
      onClick={onOpen}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/task-dir', t.dirName)}
      className="grid cursor-pointer grid-cols-[92px_84px_74px_1fr_110px_88px_84px] items-center gap-3 border-b border-ink-700/50 px-4 py-2 text-xs transition-colors hover:bg-ink-750/60"
    >
      <span className="font-mono text-[10.5px] text-mist-500">{taskDateLabel(t.dirName, t.date)}</span>
      <span>{jira ? <JiraChip jiraKey={jira} /> : <span className="text-mist-600">—</span>}</span>
      <PriorityBadge priority={t.record?.priority ?? ''} />
      <span className="min-w-0 truncate text-mist-100" title={t.record?.title ?? t.dirName}>
        {t.record?.title ?? t.dirName}
      </span>
      <span className="truncate text-mist-400" title={t.record?.assignee || '未分配'}>
        {t.record?.assignee || '未分配'}
      </span>
      <StatusBadge status={t.record?.status ?? ''} />
      <span className="truncate text-right font-mono text-[10px] text-mist-500" title={t.record?.branch ?? ''}>
        {t.record?.branch ?? '—'}
      </span>
    </div>
  )
}

/* ---------------- Reader view（PRD 阅读模式） ---------------- */

function extractHeadings(md: string): Array<{ level: number; text: string }> {
  const out: Array<{ level: number; text: string }> = []
  for (const line of md.split(/\r?\n/)) {
    const m = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line)
    if (m) out.push({ level: m[1].length, text: m[2] })
  }
  return out
}

function ReaderView({
  tasks,
  selected,
  onSelect,
  onOpenDetail
}: {
  tasks: TaskInfo[]
  selected: string | null
  onSelect: (dir: string | null) => void
  onOpenDetail: (dir: string) => void
}): JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const aiEnabled = useApp((s) => s.settings?.ai.enabled ?? false)
  const [wide, setWide] = useState(false)
  const [prd, setPrd] = useState<string | null>(null)
  const [prdName, setPrdName] = useState<string | null>(null)
  const [loadingPrd, setLoadingPrd] = useState(false)
  const [aiBusy, setAiBusy] = useState<'prd' | 'summary' | 'split' | null>(null)
  const [aiDraft, setAiDraft] = useState<string | null>(null)
  const [aiSummaryText, setAiSummaryText] = useState<string | null>(null)
  const [dodOpen, setDodOpen] = useState(false)

  const idx = Math.max(0, tasks.findIndex((t) => t.dirName === selected))
  const task = tasks[idx] ?? null

  useEffect(() => {
    if (!task || selected === null) {
      setPrd(null)
      setAiDraft(null)
      setAiSummaryText(null)
      return
    }
    // 找任务目录里的 PRD 类文档：prd.md > PRD.md > requirement.md
    const candidates = task.artifacts
      .filter((a) => a.kind === 'file' && /^(prd|prd-final|requirement|requirements|需求)\.md$/i.test(a.name))
      .sort((a, b) => (/^prd\.md$/i.test(a.name) ? -1 : 0) - (/^prd\.md$/i.test(b.name) ? -1 : 0))
    setAiDraft(null)
    setAiSummaryText(null)
    if (candidates.length === 0) {
      setPrd(null)
      setPrdName(null)
      return
    }
    const file = candidates[0]
    setLoadingPrd(true)
    void api
      .readTextFile(file.path)
      .then((res) => {
        if (res.ok && res.content !== undefined) {
          setPrd(res.content)
          setPrdName(file.name)
        } else {
          setPrd(null)
          setPrdName(null)
        }
      })
      .finally(() => setLoadingPrd(false))
  }, [task?.dirName, selected]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!task) {
    return (
      <div className="grid h-full place-items-center text-xs text-mist-500">
        <div className="text-center">
          <BookOpenText size={28} className="mx-auto mb-2 text-mist-600" />
          没有匹配的任务
        </div>
      </div>
    )
  }

  const headings = prd ? extractHeadings(prd) : []
  const prog = subtaskProgress(task)
  const goto = (delta: number): void => {
    const next = tasks[idx + delta]
    if (next) onSelect(next.dirName)
  }

  const genPrd = async (): Promise<void> => {
    setAiBusy('prd')
    const res = await api.aiPrdDraft(task.dirName)
    setAiBusy(null)
    if (res.ok && res.content) setAiDraft(res.content)
    else pushToast({ kind: 'error', title: 'PRD 生成失败', body: res.error })
  }

  const genSummary = async (): Promise<void> => {
    setAiBusy('summary')
    const res = await api.aiSummary(task.dirName)
    setAiBusy(null)
    if (res.ok && res.content) setAiSummaryText(res.content)
    else pushToast({ kind: 'error', title: '摘要生成失败', body: res.error })
  }

  const saveDraft = async (): Promise<void> => {
    if (!aiDraft) return
    const exists = task.artifacts.some((a) => /^prd\.md$/i.test(a.name))
    if (exists && !confirm('任务目录已有 prd.md，覆盖？')) return
    const res = await api.taskWriteArtifact(task.dirName, 'prd.md', aiDraft)
    if (res.ok) {
      pushToast({ kind: 'success', title: '已保存 prd.md', body: task.dirName })
      setAiDraft(null)
      setPrd(aiDraft)
      setPrdName('prd.md')
    } else {
      pushToast({ kind: 'error', title: '保存失败', body: res.error })
    }
  }

  const isDone = ['completed', 'done'].includes(statusOf(task))
  const isRoot = !task.record?.parent
  const archive = async (): Promise<void> => {
    const res = await api.taskArchive(task.dirName)
    if (res.ok) {
      pushToast({ kind: 'success', title: '已归档', body: res.dirName })
      onSelect(null)
    } else {
      pushToast({ kind: 'error', title: '归档失败', body: res.error })
    }
  }
  const split = async (): Promise<void> => {
    setAiBusy('split')
    const res = await api.aiSplitEpic(task.dirName)
    setAiBusy(null)
    if (res.ok) pushToast({ kind: 'success', title: `已拆分 ${res.created?.length ?? 0} 个子任务`, body: res.created?.join('、') })
    else pushToast({ kind: 'error', title: '拆分失败', body: res.error })
  }
  const genText = async (kind: 'commit' | 'pr'): Promise<void> => {
    const res = kind === 'commit' ? await api.aiCommitMsg(task.dirName) : await api.aiPrDesc(task.dirName)
    if (res.ok && res.content) {
      await api.copyToClipboard(res.content)
      pushToast({ kind: 'success', title: kind === 'commit' ? '提交信息已复制' : 'PR 描述已复制' })
    } else {
      pushToast({ kind: 'error', title: kind === 'commit' ? '生成失败' : '生成失败', body: res.error })
    }
  }

  return (
    <div className="flex h-full min-h-0">
      {/* 左侧任务轨 */}
      <div className="flex w-72 shrink-0 flex-col border-r border-ink-700/70">
        <div className="flex items-center gap-1.5 border-b border-ink-700/70 px-3 py-2 text-[10.5px] uppercase tracking-wide text-mist-500">
          <BookOpenText size={11} className="text-leaf" /> 任务轨 · {tasks.length}
          <button onClick={() => onSelect(null)} className="btn-ghost ml-auto justify-center px-1" title="收起说明">
            <PanelLeftClose size={11} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {tasks.map((t) => {
            const st = statusOf(t)
            const col = COLUMNS.find((x) => matchCol(t, x.status))
            const isSel = t.dirName === selected
            return (
              <button
                key={t.dirName}
                onClick={() => onSelect(t.dirName)}
                className={clsx(
                  'mb-1 w-full rounded-lg px-2.5 py-2 text-left transition-colors',
                  isSel ? 'bg-leaf-dim/15 ring-1 ring-leaf-dim/40' : 'hover:bg-ink-750/60'
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', col?.dot ?? 'bg-mist-600')} />
                  <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-mist-100">{t.record?.title ?? t.dirName}</span>
                  <PriorityBadge priority={t.record?.priority ?? ''} />
                </div>
                <div className="mt-1 flex items-center gap-1.5 pl-3 text-[10px] text-mist-500">
                  <span className="truncate">{t.record?.assignee || '未分配'}</span>
                  {t.jiraKey && <JiraChip jiraKey={t.jiraKey} />}
                  {prog && <span className="ml-auto shrink-0">{prog.done}/{prog.total}</span>}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* 阅读区 */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className={clsx('mx-auto px-8 py-6', wide ? 'max-w-[980px]' : 'max-w-[760px]')}>
          {/* 头部 */}
          <div className="flex items-center gap-1.5 text-[11px] text-mist-500">
            <span className="font-mono">{task.dirName}</span>
            <span>·</span>
            <span>{task.record?.assignee || '未分配'}</span>
            <span>·</span>
            <span>{taskDateLabel(task.dirName, task.date)}</span>
            <button onClick={() => setWide((w) => !w)} className="btn-ghost ml-auto text-[10.5px]">
              {wide ? '舒适宽度' : '加宽阅读'}
            </button>
            <button onClick={() => onOpenDetail(task.dirName)} className="btn-outline text-[10.5px]">
              在详情中打开
            </button>
          </div>
          <h1 className="mt-2 text-[22px] font-bold leading-snug text-mist-100">{task.record?.title ?? task.dirName}</h1>

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <StatusBadge status={task.record?.status ?? ''} />
            <PriorityBadge priority={task.record?.priority ?? ''} />
            {task.jiraKey && <JiraChip jiraKey={task.jiraKey} />}
            {task.record?.branch && <span className="chip bg-ink-750 font-mono text-[10px] text-mist-300">{task.record.branch}</span>}
            {typeof task.record?.workflow === 'string' && task.record.workflow && (
              <span className="chip bg-violet-500/15 text-[10px] text-violet-300" title="task.json 的 workflow pin">workflow: {task.record.workflow}</span>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              <FocusTimer task={task} />
              <select
                value={statusOf(task)}
                onChange={(e) => {
                  void (async () => {
                    const target = e.target.value
                    if (target === 'completed' && !isDone) {
                      setDodOpen(true)
                      return
                    }
                    const res = await api.updateTask(task.path, { status: target })
                    if (!res.ok) pushToast({ kind: 'error', title: '状态更新失败', body: res.error })
                  })()
                }}
                className="field w-28 px-2 py-1 text-[11px]"
              >
                {COLUMNS.map((c) => (
                  <option key={c.status} value={c.status}>{statusLabel(c.status)}</option>
                ))}
              </select>
              {isRoot && (
                <button onClick={() => void split()} disabled={aiBusy !== null || !aiEnabled} className="btn-ghost justify-center px-1.5" title="AI 拆分子任务">
                  {aiBusy === 'split' ? <Loader2 size={12} className="animate-spin" /> : <Split size={12} />}
                </button>
              )}
              {isDone && (
                <button onClick={() => void archive()} className="btn-ghost justify-center px-1.5 text-amber-300" title="归档">
                  <Archive size={12} />
                </button>
              )}
              <button onClick={() => void genText('commit')} disabled={!aiEnabled} className="btn-ghost justify-center px-1.5 disabled:opacity-40" title="AI 提交信息（复制）">
                <GitBranch size={12} />
              </button>
              <button onClick={() => void genText('pr')} disabled={!aiEnabled} className="btn-ghost justify-center px-1.5 disabled:opacity-40" title="AI PR 描述（复制）">
                <ExternalLink size={12} />
              </button>
              <button onClick={() => void api.revealInExplorer(task.path)} className="btn-ghost justify-center px-1.5" title="打开任务目录">
                <FolderOpen size={12} />
              </button>
            </div>
          </div>

          {/* AI 摘要卡 */}
          {aiSummaryText && (
            <div className="mt-4 rounded-xl border border-leaf-dim/30 bg-leaf-dim/5 p-4">
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-leaf-soft">
                <Sparkles size={12} /> AI 任务摘要
              </div>
              <MarkdownView content={aiSummaryText} />
            </div>
          )}

          {/* 章节导航 */}
          {headings.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5 border-b border-ink-700/70 pb-3">
              {headings.map((h, i) => (
                <span key={i} className={clsx('chip text-[10px]', h.level === 2 ? 'bg-ink-750 text-mist-300' : 'bg-ink-800 text-mist-500')}>
                  {h.text}
                </span>
              ))}
            </div>
          )}

          {/* 正文 */}
          <div className="mt-4">
            {loadingPrd ? (
              <div className="flex items-center gap-2 py-10 text-xs text-mist-500">
                <Loader2 size={14} className="animate-spin" /> 读取 {prdName}…
              </div>
            ) : aiDraft ? (
              <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-4">
                <div className="mb-2 flex items-center gap-2">
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold text-violet-300">
                    <Wand2 size={12} /> AI PRD 草稿
                  </span>
                  <button onClick={() => void saveDraft()} className="btn-primary ml-auto text-[11px]">
                    保存为 prd.md
                  </button>
                  <button onClick={() => setAiDraft(null)} className="btn-ghost text-[11px]">放弃</button>
                </div>
                <MarkdownView content={aiDraft} />
              </div>
            ) : prd !== null ? (
              <MarkdownView content={prd} />
            ) : (
              <div className="space-y-4">
                {task.record?.description ? (
                  <div>
                    <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-mist-500">需求描述</div>
                    <MarkdownView content={task.record.description} />
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-ink-600 p-6 text-center">
                    <BookOpenText size={22} className="mx-auto mb-2 text-mist-600" />
                    <div className="text-xs text-mist-400">该任务还没有 prd.md，描述也为空</div>
                    <button onClick={() => void genPrd()} disabled={aiBusy !== null} className="btn-primary mt-3 disabled:opacity-40">
                      {aiBusy === 'prd' ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />} AI 生成 PRD 草稿
                    </button>
                  </div>
                )}
                {task.record?.description && (
                  <button onClick={() => void genPrd()} disabled={aiBusy !== null} className="btn-outline text-[11px]">
                    {aiBusy === 'prd' ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />} AI 生成 PRD 草稿
                  </button>
                )}
              </div>
            )}
          </div>

          {/* 子任务 / 备注 */}
          {!aiDraft && (
            <div className="mt-6 space-y-4 border-t border-ink-700/70 pt-4 pb-8">
              {prog && (
                <div>
                  <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-mist-500">
                    子任务 {prog.done}/{prog.total}
                    <div className="h-1 w-32 overflow-hidden rounded-full bg-ink-700">
                      <div className="h-full bg-leaf-dim/80" style={{ width: `${(prog.done / prog.total) * 100}%` }} />
                    </div>
                  </div>
                  <ul className="space-y-1">
                    {task.record?.subtasks.map((s, i) => {
                      const m = /^\s*[-*]?\s*\[( |x|X)\]\s*(.*)$/.exec(s)
                      const done = m?.[1]?.toLowerCase() === 'x'
                      const text = m?.[2] ?? s
                      return (
                        <li key={i} className="flex items-start gap-2 text-xs leading-5 text-mist-300">
                          <CircleCheck size={13} className={clsx('mt-0.5 shrink-0', done ? 'text-leaf' : 'text-mist-600')} />
                          <span className={done ? 'text-mist-500 line-through' : ''}>{text}</span>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
              {task.record?.notes && (
                <div>
                  <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-mist-500">备注</div>
                  <div className="whitespace-pre-wrap rounded-lg border border-ink-700/70 bg-ink-850/50 p-3 text-xs leading-5 text-mist-300">{task.record.notes}</div>
                </div>
              )}
              {task.artifacts.length > 0 && (
                <div>
                  <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-mist-500">产物（{task.artifacts.length}）</div>
                  <div className="flex flex-wrap gap-1.5">
                    {task.artifacts.map((a) => (
                      <button
                        key={a.path}
                        onClick={() => useApp.getState().openArtifact({ ...a }, true)}
                        className="chip border border-ink-600 text-[10.5px] text-mist-300 hover:border-ink-500 hover:text-mist-100"
                      >
                        <Paperclip size={10} /> {a.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {dodOpen && (
            <DoDModal
              task={task}
              onClose={() => setDodOpen(false)}
              onDone={() => {
                setDodOpen(false)
                pushToast({ kind: 'success', title: '已完成', body: task.dirName })
              }}
            />
          )}

          {/* 上一篇 / 下一篇 */}
          <div className="sticky bottom-0 -mx-8 flex items-center gap-2 border-t border-ink-700/70 bg-ink-900/90 px-8 py-2.5 backdrop-blur">
            <button onClick={() => goto(-1)} disabled={idx <= 0} className="btn-ghost text-[11px] disabled:opacity-30">
              ← 上一篇
            </button>
            <span className="text-[10.5px] text-mist-600">{idx + 1} / {tasks.length}</span>
            <button onClick={() => goto(1)} disabled={idx >= tasks.length - 1} className="btn-ghost ml-auto text-[11px] disabled:opacity-30">
              下一篇 →
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ---------------- Page ---------------- */

export function TasksPage(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)!
  const showTask = useApp((s) => s.showTask)
  const pushToast = useApp((s) => s.pushToast)
  const setIntakeOpen = useApp((s) => s.setIntakeOpen)
  const [view, setView] = useState<ViewMode>('board')
  const [readerDir, setReaderDir] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [planSeed, setPlanSeed] = useState<PlanningSeed | null>(null)
  /** 已展开的「已完成」等大列（列 key） */
  const [expandedCols, setExpandedCols] = useState<Set<string>>(new Set())
  /** 完成门禁：待确认的任务 */
  const [dodTask, setDodTask] = useState<TaskInfo | null>(null)
  const [assignee, setAssignee] = useState('')
  const [priority, setPriority] = useState('')
  const [dragOver, setDragOver] = useState<string | null>(null)

  const assignees = useMemo(
    () => [...new Set(snapshot.tasks.map((t) => t.record?.assignee).filter(Boolean) as string[])].sort(),
    [snapshot.tasks]
  )

  const filtered = useMemo(
    () =>
      snapshot.tasks.filter((t) => {
        const q = query.trim().toLowerCase()
        if (q) {
          const hay = `${t.dirName} ${t.record?.title ?? ''} ${t.record?.description ?? ''}`.toLowerCase()
          if (!hay.includes(q)) return false
        }
        if (assignee && t.record?.assignee !== assignee) return false
        if (priority && t.record?.priority !== priority) return false
        return true
      }),
    [snapshot.tasks, query, assignee, priority]
  )

  /* ----- 任务树（parent 引用 → Epic 折叠组） ----- */
  const { childMap, childDirs, hasEpics } = useMemo(() => {
    const map = new Map<string, TaskInfo[]>()
    const dirs = new Set<string>()
    for (const t of snapshot.tasks) {
      const p = matchTaskByRef(t.record?.parent ?? null, snapshot.tasks)
      if (p && p.dirName !== t.dirName) {
        const list = map.get(p.dirName) ?? []
        list.push(t)
        map.set(p.dirName, list)
        dirs.add(t.dirName)
      }
    }
    return { childMap: map, childDirs: dirs, hasEpics: map.size > 0 }
  }, [snapshot.tasks])
  const [grouped, setGrouped] = useState<boolean | null>(null)
  const groupOn = grouped ?? hasEpics

  /* ----- 动态兜底列：自定义状态不丢失 ----- */
  const extraColumns = useMemo(() => {
    const known = new Set(COLUMNS.map((c) => c.status))
    const extras: Array<{ status: string; label: string; dot: string; ring: string }> = []
    for (const t of snapshot.tasks) {
      const st = statusOf(t)
      if (!st || st === 'done' || known.has(st)) continue
      if (!extras.some((c) => c.status === st)) {
        extras.push({ status: st, label: statusLabel(st), dot: 'bg-mist-500', ring: 'ring-mist-500/40' })
      }
    }
    return extras
  }, [snapshot.tasks])
  const columns = [...COLUMNS, ...extraColumns]

  const moveTo = async (t: TaskInfo, status: string): Promise<void> => {
    if (t.record?.status === status) return
    if (status === 'completed' && !['completed', 'done'].includes((t.record?.status ?? '').toLowerCase())) {
      setDodTask(t)
      return
    }
    const res = await api.updateTask(t.path, { status })
    if (!res.ok) {
      pushToast({ kind: 'error', title: '状态更新失败', body: res.error })
    }
  }

  /* ----- 聚合状态计数（filtered） ----- */
  const counts = useMemo(
    () =>
      columns.map((c) => ({
        ...c,
        count: filtered.filter((t) => matchCol(t, c.status)).length
      })),
    [filtered, columns]
  )

  const boardColumns = groupOn ? filtered.filter((t) => !childDirs.has(t.dirName)) : filtered

  return (
    <div className="flex h-full min-w-0 animate-fade-in flex-col">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-700 bg-ink-850/40 px-5 py-2.5">
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-mist-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索任务…"
            className="field w-64 pl-8"
          />
        </div>
        <Filter size={13} className="text-mist-500" />
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className="field w-32">
          <option value="">全部负责人</option>
          {assignees.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <select value={priority} onChange={(e) => setPriority(e.target.value)} className="field w-28">
          <option value="">全部优先级</option>
          {['P0', 'P1', 'P2', 'P3'].map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>

        {/* 聚合健康度：状态计数条 */}
        <div className="hidden items-center gap-1.5 xl:flex">
          {counts.map((c) => (
            <span key={c.status} className="flex items-center gap-1 text-[11px] text-mist-400" title={c.label}>
              <span className={clsx('h-1.5 w-1.5 rounded-full', c.dot)} />
              <span className="font-mono text-mist-200">{c.count}</span>
            </span>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => setIntakeOpen(true)} className="btn-primary" title="新建待办">
            <Sparkles size={12} /> 新建待办
          </button>
          <button onClick={() => setPlanSeed({ title: '', description: '' })} className="btn-outline" title="知识库 → AI 生成任务规划">
            <Wand2 size={12} /> AI 规划
          </button>
          {hasEpics && view === 'board' && (
            <button
              onClick={() => setGrouped(!groupOn)}
              className={clsx('chip border transition-colors', groupOn ? 'border-leaf-dim/50 text-leaf-soft' : 'border-ink-500 text-mist-400')}
              title="按需求组（parent 引用）折叠子任务"
            >
              <Layers size={11} /> 需求组{groupOn ? ' 开' : ' 关'}
            </button>
          )}
          <span className="hidden text-[11px] text-mist-500 md:inline">{filtered.length} 个任务</span>
          <div className="flex overflow-hidden rounded-lg border border-ink-500">
            {(
              [
                ['board', '看板', <LayoutGrid size={12} key="b" />],
                ['reader', '阅读', <BookOpenText size={12} key="r" />],
                ['list', '列表', <Rows3 size={12} key="l" />],
                ['swimlane', '泳道', <Users2 size={12} key="s" />]
              ] as const
            ).map(([id, label, icon]) => (
              <button
                key={id}
                onClick={() => setView(id)}
                className={clsx(
                  'flex items-center gap-1 px-2.5 py-1 text-[11px] transition-colors',
                  view === id ? 'bg-leaf-dim/25 text-leaf-soft' : 'text-mist-400 hover:text-mist-200'
                )}
              >
                {icon} {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* board view */}
      {view === 'board' && (
        <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden p-3">
          <div className="flex h-full min-h-0 gap-3">
            {columns.map((col) => {
              const items = boardColumns.filter((t) => matchCol(t, col.status))
              // 大列自动折叠（>8 条只显示最近 5 条，避免"已完成"列无限增长挤压工作区）
              const collapsible = items.length > 8
              const expanded = expandedCols.has(col.status)
              const visible = collapsible && !expanded
                ? [...items].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5)
                : items
              const hiddenCount = items.length - visible.length
              return (
                <div
                  key={col.status}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDragOver(col.status)
                  }}
                  onDragLeave={() => setDragOver((cur) => (cur === col.status ? null : cur))}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDragOver(null)
                    const dir = e.dataTransfer.getData('text/task-dir')
                    const t = snapshot.tasks.find((x) => x.dirName === dir)
                    if (t) void moveTo(t, col.status)
                  }}
                  className={clsx(
                    'flex w-full min-w-[230px] flex-1 flex-col rounded-xl border border-ink-700 bg-ink-850/50',
                    dragOver === col.status && `ring-2 ${col.ring}`
                  )}
                >
                  <div className="flex shrink-0 items-center gap-2 border-b border-ink-700/70 px-3 py-2.5">
                    <span className={clsx('h-2 w-2 rounded-full', col.dot)} />
                    <span className="text-xs font-semibold text-mist-100">{col.label}</span>
                    <span className="ml-auto rounded bg-ink-750 px-1.5 font-mono text-[10.5px] text-mist-400">
                      {items.length}
                    </span>
                  </div>
                  <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
                    {visible.map((t) =>
                      groupOn && childMap.has(t.dirName) ? (
                        <EpicCard
                          key={t.dirName}
                          epic={t}
                          children={childMap.get(t.dirName)!}
                          onOpen={(dir) => showTask(dir)}
                        />
                      ) : (
                        <TaskCard key={t.dirName} t={t} onOpen={() => showTask(t.dirName)} />
                      )
                    )}
                    {hiddenCount > 0 && (
                      <button
                        onClick={() => setExpandedCols((s) => new Set(s).add(col.status))}
                        className="w-full rounded-lg border border-dashed border-ink-600 py-1.5 text-[10.5px] text-mist-500 hover:border-ink-500 hover:text-mist-300"
                      >
                        展开更早的 {hiddenCount} 条
                      </button>
                    )}
                    {items.length === 0 && (
                      <div className="grid place-items-center gap-1.5 py-10 text-mist-600">
                        <Inbox size={18} />
                        <span className="text-[11px]">拖拽任务到这里</span>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* reader view（PRD 阅读模式）——阅读场景需要覆盖全部任务（含子任务 PRD），不受需求组折叠影响 */}
      {view === 'reader' && (
        <ReaderView
          tasks={filtered}
          selected={readerDir ?? filtered[0]?.dirName ?? null}
          onSelect={setReaderDir}
          onOpenDetail={(dir) => showTask(dir)}
        />
      )}

      {/* list view */}
      {view === 'list' && (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="min-w-[820px]">
            <div className="sticky top-0 z-10 grid grid-cols-[92px_84px_74px_1fr_110px_88px_84px] gap-3 border-b border-ink-700 bg-ink-850 px-4 py-2 text-[10.5px] font-semibold uppercase tracking-wide text-mist-400">
              <span>日期</span><span>Jira</span><span>优先级</span><span>标题</span><span>负责人</span><span>状态</span><span className="text-right">分支</span>
            </div>
            {filtered.map((t) => (
              <TaskRow key={t.dirName} t={t} onOpen={() => showTask(t.dirName)} />
            ))}
            {filtered.length === 0 && (
              <div className="py-16 text-center text-xs text-mist-500">没有匹配的任务</div>
            )}
          </div>
        </div>
      )}

      {/* swimlane view */}
      {view === 'swimlane' && <SwimlaneView />}

      {planSeed && <PlanningModal seed={planSeed} onClose={() => setPlanSeed(null)} />}
      {dodTask && (
        <DoDModal
          task={dodTask}
          onClose={() => setDodTask(null)}
          onDone={() => setDodTask(null)}
        />
      )}
    </div>
  )
  function SwimlaneView(): JSX.Element {
    const lanes: Array<{ key: string; label: string; mine: TaskInfo[] }> = [
      ...(filtered.some((t) => !t.record?.assignee)
        ? [{ key: '__unassigned', label: '未分配', mine: filtered.filter((t) => !t.record?.assignee) }]
        : []),
      ...assignees.map((a) => ({ key: a, label: a, mine: filtered.filter((t) => t.record?.assignee === a) }))
    ]
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {lanes.length === 0 && (
          <div className="py-16 text-center text-xs text-mist-500">暂无负责人数据</div>
        )}
        <div className="space-y-4">
          {lanes.map((lane) => {
            const done = lane.mine.filter((t) => matchCol(t, 'completed')).length
            return (
              <div key={lane.key} className="card overflow-hidden">
                <div className="flex items-center gap-3 border-b border-ink-700 bg-ink-750/50 px-4 py-2.5">
                  <span className="grid h-6 w-6 place-items-center rounded-full bg-leaf-deep/60 text-[11px] font-bold text-leaf">
                    {lane.label.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="text-xs font-semibold text-mist-100">{lane.label}</span>
                  <span className="text-[11px] text-mist-500">{lane.mine.length} 个任务 · 已完成 {done}</span>
                  <div className="ml-auto h-1.5 w-40 overflow-hidden rounded-full bg-ink-700">
                    <div
                      className="h-full rounded-full bg-leaf-dim/80"
                      style={{ width: `${lane.mine.length ? (done / lane.mine.length) * 100 : 0}%` }}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-4 divide-x divide-ink-700/50">
                  {columns.map((col) => {
                    const items = lane.mine.filter((t) => matchCol(t, col.status))
                    const laneKey = `${lane.key}:${col.status}`
                    return (
                      <div
                        key={col.status}
                        onDragOver={(e) => {
                          e.preventDefault()
                          setDragOver(laneKey)
                        }}
                        onDragLeave={() => setDragOver((cur) => (cur === laneKey ? null : cur))}
                        onDrop={(e) => {
                          e.preventDefault()
                          setDragOver(null)
                          const dir = e.dataTransfer.getData('text/task-dir')
                          const t = snapshot.tasks.find((x) => x.dirName === dir)
                          if (t) void moveTo(t, col.status)
                        }}
                        className={clsx(
                          'flex min-h-16 flex-col p-2',
                          dragOver === laneKey && 'bg-leaf-dim/5 ring-1 ring-inset ring-leaf-dim/40'
                        )}
                      >
                        <div className="mb-1.5 flex items-center gap-1.5 px-1">
                          <span className={clsx('h-1.5 w-1.5 rounded-full', col.dot)} />
                          <span className="text-[10.5px] text-mist-400">
                            {col.label} · {items.length}
                          </span>
                        </div>
                        <div className="max-h-[26rem] min-h-0 space-y-1.5 overflow-y-auto">
                          {items.map((t) => (
                            <TaskCard key={t.dirName} t={t} onOpen={() => showTask(t.dirName)} />
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }
}

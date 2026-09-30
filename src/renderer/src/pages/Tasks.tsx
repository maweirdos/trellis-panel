import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Search,
  Filter,
  Inbox,
  Star,
  Paperclip,
  CircleCheck,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Sparkles,
  Layers,
  BookOpenText,
  Loader2,
  Wand2,
  ExternalLink,
  FolderOpen,
  GitBranch,
  Split,
  X,
  Check,
  ListChecks,
  FileText,
  FileCode,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Compass,
  ArrowLeft,
  ClipboardPaste,
  ListTodo,
  Link2,
  SquareCode,
  ClipboardCopy,
  ScanSearch,
  ShieldCheck
} from 'lucide-react'
import { useApp } from '../store'
import { clsx } from 'clsx'
import { PriorityBadge, StatusBadge, JiraChip } from '../components/badges'
import { statusLabel } from '../utils/labels'
import { getReading, setReading } from '../utils/reading'
import { taskDateLabel } from '../utils/format'
import { api } from '../api'
import { MarkdownView } from '../components/MarkdownView'
import { CodeView } from '../components/CodeView'
import { confirmDialog } from '../components/Dialogs'
import { FocusTimer } from '../components/FocusTimer'
import { HandoffModal } from '../components/HandoffModal'
import { TaskInsightsModal } from '../components/TaskInsightsModal'
import { DispatchModal } from '../components/DispatchModal'
import { Select } from '../components/Select'
import type { JSX } from 'react'
import type { TaskInfo } from '../../../shared/types'

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

const TaskCard = React.memo(function TaskCard({
  t,
  isCurrent,
  onOpen
}: {
  t: TaskInfo
  isCurrent?: boolean
  onOpen: () => void
}): JSX.Element {
  const prog = subtaskProgress(t)
  const jira = jiraKeyOf(t)
  const fullTitle = t.record?.title ?? t.dirName
  return (
    <div
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
              const prUrl = t.record?.pr_url
              if (prUrl) void api.openExternal(prUrl)
            }}
            className="shrink-0 text-leaf-soft/80 hover:text-leaf-soft"
          >
            PR ↗
          </a>
        )}
      </div>
    </div>
  )
})

/* ---------------- Epic card（需求 → 子任务折叠组） ---------------- */

const EpicCard = React.memo(function EpicCard({
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
        'group overflow-hidden rounded-lg border transition-all',
        open ? 'border-leaf-dim/40 bg-ink-800' : 'border-ink-700 bg-ink-800/80 hover:border-ink-500'
      )}
    >
      <div className="flex items-start">
        {/* 左侧折叠/展开子任务切换按钮 */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setOpen((o) => !o)
          }}
          className="p-2.5 pr-1 text-mist-500 transition-colors hover:text-leaf"
          title={open ? '收起子任务列表' : `展开 ${children.length} 个子任务`}
        >
          {open ? <ChevronDown size={14} className="text-leaf" /> : <ChevronRight size={14} />}
        </button>

        {/* 卡片主体：点击直接打开需求组父任务本身的文档 */}
        <div
          onClick={() => onOpen(epic.dirName)}
          className="min-w-0 flex-1 cursor-pointer py-2.5 pr-3"
          title={`点击查看需求组文档 · ${fullTitle}`}
        >
          <div className="flex items-center gap-1.5">
            <Layers size={11} className="shrink-0 text-leaf" />
            <span className="text-[10px] font-semibold uppercase tracking-wide text-leaf-soft">需求组</span>
            <span className="ml-auto shrink-0 rounded bg-ink-750 px-1.5 font-mono text-[10px] text-mist-400">
              {done}/{children.length}
            </span>
          </div>
          <div className="mt-1 line-clamp-2 text-xs leading-5 text-mist-100 transition-colors group-hover:text-leaf-soft">
            {fullTitle}
          </div>
          <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-mist-500">
            <span className="truncate">{epic.record?.assignee || epic.record?.creator || '未分配'}</span>
            {prog && (
              <span className="ml-auto flex shrink-0 items-center gap-1">
                <CircleCheck size={10} className={prog.done === prog.total ? 'text-leaf' : 'text-mist-600'} />
                {prog.done}/{prog.total}
              </span>
            )}
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-ink-700">
            <div
              className="h-full rounded-full bg-leaf-dim/80 transition-all"
              style={{ width: `${children.length ? (done / children.length) * 100 : 0}%` }}
            />
          </div>
        </div>
      </div>

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
                title={`子任务 · ${c.record?.title ?? c.dirName}`}
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
})

/* ---------------- List row ---------------- */

function TaskRow({ t, onOpen }: { t: TaskInfo; onOpen: () => void }): JSX.Element {
  const jira = jiraKeyOf(t)
  return (
    <div
      onClick={onOpen}
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

/* ---------------- Task Workspace（一体化看板工作台） ---------------- */

function extractHeadings(md: string): Array<{ level: number; text: string }> {
  const out: Array<{ level: number; text: string }> = []
  for (const line of md.split(/\r?\n/)) {
    const m = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line)
    if (m) out.push({ level: m[1].length, text: m[2] })
  }
  return out
}

interface DocTabItem {
  id: string
  type: 'prd' | 'design' | 'other'
  label: string
  fileName: string
  path: string
  isInherited?: boolean
}

function TaskWorkspace({
  tasks,
  selected,
  onSelect,
  onClose,
  columns,
  childMap,
  childDirs
}: {
  tasks: TaskInfo[]
  selected: string | null
  onSelect: (dir: string | null) => void
  onClose: () => void
  columns: Array<{ status: string; label: string; dot: string; ring: string }>
  childMap: Map<string, TaskInfo[]>
  childDirs: Set<string>
}): JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const aiEnabled = useApp((s) => s.settings?.ai.enabled ?? false)
  const projectName = useApp((s) => s.snapshot?.meta.name ?? '')
  const [leftRailOpen, setLeftRailOpen] = useState(true)
  const [rightAsideOpen, setRightAsideOpen] = useState(true)
  const [activeDocPath, setActiveDocPath] = useState<string | null>(null)
  const [activeDocType, setActiveDocType] = useState<'prd' | 'design' | 'artifact' | 'other'>('prd')
  const [activeDocName, setActiveDocName] = useState<string>('prd.md')
  const [docContent, setDocContent] = useState<string | null>(null)
  const [loadingDoc, setLoadingDoc] = useState(false)
  const [aiBusy, setAiBusy] = useState<'prd' | 'summary' | 'split' | null>(null)
  const [aiDraft, setAiDraft] = useState<string | null>(null)
  const [aiSummaryText, setAiSummaryText] = useState<string | null>(null)
  const [filterStatus, setFilterStatus] = useState<string | null>(null)
  const [collapsedEpics, setCollapsedEpics] = useState<Record<string, boolean>>({})
  const docContainerRef = useRef<HTMLDivElement>(null)
  const scrollSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [handoffOpen, setHandoffOpen] = useState(false)
  const [insightsOpen, setInsightsOpen] = useState(false)
  const [dispatchOpen, setDispatchOpen] = useState(false)

  const idx = Math.max(0, tasks.findIndex((t) => t.dirName === selected))
  const task = tasks[idx] ?? null

  // 寻找父需求组与子任务
  const parentTask = useMemo(() => {
    if (!task?.record?.parent) return null
    return matchTaskByRef(task.record.parent, tasks) ?? null
  }, [task, tasks])

  const myChildren = useMemo(() => {
    if (!task) return []
    return childMap.get(task.dirName) ?? []
  }, [task, childMap])

  // 提取当前任务的可用文档列表（PRD / Design / Other）
  const docTabs = useMemo<DocTabItem[]>(() => {
    if (!task) return []
    const items: DocTabItem[] = []

    for (const a of task.artifacts) {
      if (a.kind !== 'file' || !/\.(md|markdown|txt)$/i.test(a.name)) continue
      let type: DocTabItem['type'] = 'other'
      let label = a.name
      if (/^(prd|requirement|需求)/i.test(a.name) || /prd/i.test(a.name)) {
        type = 'prd'
        label = 'PRD 需求文档'
      } else if (/^(design|方案|arch|tech|spec|技术方案)/i.test(a.name) || /design/i.test(a.name)) {
        type = 'design'
        label = 'Design 设计方案'
      }
      items.push({ id: a.path, type, label, fileName: a.name, path: a.path })
    }

    // 若当前任务是子任务且自身没有 design 文档，但父需求组有 design 文档，贴心引入继承 Design
    const hasDesign = items.some((it) => it.type === 'design')
    if (!hasDesign && parentTask) {
      const parentDesign = parentTask.artifacts.find(
        (a) => a.kind === 'file' && (/^(design|方案|arch|tech|spec|技术方案)/i.test(a.name) || /design/i.test(a.name))
      )
      if (parentDesign) {
        items.push({
          id: parentDesign.path,
          type: 'design',
          label: 'Design 设计方案 (父需求)',
          fileName: parentDesign.name,
          path: parentDesign.path,
          isInherited: true
        })
      }
    }

    return items.sort((a, b) => {
      const w = (x: DocTabItem) => (x.type === 'prd' ? 0 : x.type === 'design' ? 1 : 2)
      return w(a) - w(b) || a.fileName.localeCompare(b.fileName)
    })
  }, [task, parentTask])

  // 非文档类的交付产物（json、代码产物等，杜绝 prd.md 重复进入）
  const nonDocArtifacts = useMemo(() => {
    if (!task) return []
    return task.artifacts.filter((a) => !/\.(md|markdown)$/i.test(a.name))
  }, [task])

  // 切换任务时，默认选中 PRD 文档或首个可用文档
  useEffect(() => {
    setAiDraft(null)
    setAiSummaryText(null)
    if (!task) {
      setActiveDocPath(null)
      setActiveDocName('prd.md')
      setDocContent(null)
      return
    }
    const prdItem = docTabs.find((d) => d.type === 'prd')
    if (prdItem) {
      setActiveDocPath(prdItem.path)
      setActiveDocType('prd')
      setActiveDocName(prdItem.fileName)
    } else if (docTabs.length > 0) {
      setActiveDocPath(docTabs[0].path)
      setActiveDocType(docTabs[0].type)
      setActiveDocName(docTabs[0].fileName)
    } else {
      setActiveDocPath(null)
      setActiveDocType('prd')
      setActiveDocName('prd.md')
      setDocContent(null)
    }
  }, [task?.dirName, docTabs])

  // FR：阅读位置记忆——任务/文档切换即落库
  useEffect(() => {
    if (!task || !projectName) return
    setReading(projectName, {
      dirName: task.dirName,
      docName: activeDocName,
      docType: activeDocType,
      scrollTop: docContainerRef.current?.scrollTop ?? 0
    })
  }, [task?.dirName, activeDocName, activeDocType, projectName, task])

  // 读取当前激活文档的内容
  useEffect(() => {
    if (!activeDocPath) {
      setDocContent(null)
      return
    }
    let alive = true
    setLoadingDoc(true)
    void api
      .readTextFile(activeDocPath)
      .then((res) => {
        if (!alive) return
        if (res.ok && res.content !== undefined) {
          setDocContent(res.content)
          // FR：恢复上次阅读的滚动位置（仅当任务与文档都对得上）
          const saved = getReading(projectName)
          if (saved && task && saved.dirName === task.dirName && saved.docName === activeDocName) {
            requestAnimationFrame(() => {
              if (alive && docContainerRef.current) docContainerRef.current.scrollTop = saved.scrollTop
            })
          }
        } else {
          setDocContent(null)
        }
      })
      .finally(() => {
        if (alive) setLoadingDoc(false)
      })
    return () => {
      alive = false
    }
  }, [activeDocPath, activeDocName, projectName, task?.dirName, task])

  // 需求组与独立任务分类（保留层级结构，杜绝打散）
  const { epicsList, standalonesList } = useMemo(() => {
    const epics: TaskInfo[] = []
    const standalones: TaskInfo[] = []

    for (const t of tasks) {
      if (childMap.has(t.dirName)) {
        epics.push(t)
      } else if (!childDirs.has(t.dirName)) {
        standalones.push(t)
      }
    }
    return { epicsList: epics, standalonesList: standalones }
  }, [tasks, childMap, childDirs])

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

  const headings = docContent ? extractHeadings(docContent) : []
  const prog = subtaskProgress(task)
  const isRoot = !task.record?.parent

  const goto = (delta: number): void => {
    const next = tasks[idx + delta]
    if (next) onSelect(next.dirName)
  }

  const scrollToHeading = (text: string): void => {
    if (!docContainerRef.current) return
    const clean = text.trim().toLowerCase()
    const all = docContainerRef.current.querySelectorAll('h1, h2, h3, h4')
    const match = Array.from(all).find((h) => h.textContent?.trim().toLowerCase() === clean)
    if (match) {
      match.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  const toggleSubtask = async (subIdx: number): Promise<void> => {
    if (!task.record) return
    const list = task.record.subtasks ?? []
    const next = list.map((s, i) => {
      if (i !== subIdx) return s
      const m = /^\s*[-*]?\s*\[( |x|X)\]\s*(.*)$/.exec(s)
      const done = m?.[1]?.toLowerCase() === 'x'
      const text = m?.[2] ?? s
      return `[${done ? ' ' : 'x'}] ${text}`
    })
    const res = await api.updateTask(task.path, { subtasks: next })
    if (!res.ok) pushToast({ kind: 'error', title: '子任务更新失败', body: res.error })
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
    if (exists) {
      const ok = await confirmDialog({
        title: '任务目录已有 prd.md，覆盖？',
        confirmText: '覆盖',
        danger: true
      })
      if (!ok) return
    }
    const res = await api.taskWriteArtifact(task.dirName, 'prd.md', aiDraft)
    if (res.ok) {
      pushToast({ kind: 'success', title: '已保存 prd.md', body: task.dirName })
      setAiDraft(null)
      setDocContent(aiDraft)
      setActiveDocType('prd')
    } else {
      pushToast({ kind: 'error', title: '保存失败', body: res.error })
    }
  }

  const split = async (): Promise<void> => {
    setAiBusy('split')
    const res = await api.aiSplitEpic(task.dirName)
    setAiBusy(null)
    if (res.ok) pushToast({ kind: 'success', title: `已拆分 ${res.created?.length ?? 0} 个子任务`, body: res.created?.join('、') })
    else pushToast({ kind: 'error', title: '拆分失败', body: res.error })
  }

  const copyTaskLink = async (): Promise<void> => {
    const res = await api.taskBuildTaskLink(task.dirName)
    if (res.ok) {
      await api.copyToClipboard(res.url)
      pushToast({ kind: 'success', title: '任务链接已复制', body: '本机粘贴运行可直接回到此任务' })
    } else {
      pushToast({ kind: 'error', title: '生成链接失败', body: res.error })
    }
  }

  const genText = async (kind: 'commit' | 'pr'): Promise<void> => {
    const res = kind === 'commit' ? await api.aiCommitMsg(task.dirName) : await api.aiPrDesc(task.dirName)
    if (res.ok && res.content) {
      await api.copyToClipboard(res.content)
      pushToast({ kind: 'success', title: kind === 'commit' ? '提交信息已复制' : 'PR 描述已复制' })
    } else {
      pushToast({ kind: 'error', title: '生成失败', body: res.error })
    }
  }

  const activeDocItem = docTabs.find((d) => d.path === activeDocPath)

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden">
      {/* 左侧：树形需求导轨（保持需求组层级，杜绝打散） */}
      <div
        className={clsx(
          'flex shrink-0 flex-col border-r border-ink-700 bg-ink-900 transition-all duration-200 ease-in-out',
          leftRailOpen ? 'w-56' : 'w-11'
        )}
      >
        {/* 顶部控制栏：返回看板 + 收起展开 + 状态筛选 (两行独立镜像右侧，消除复合边框叠压) */}
        {leftRailOpen ? (
          <>
            {/* 第 1 行：返回看板栏 (44px，与右侧 Primary Header 100% 对齐) */}
            <div className="flex h-11 shrink-0 items-center justify-between border-b border-ink-700 bg-ink-850/90 px-2.5">
              <button
                onClick={onClose}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-mist-300 hover:bg-ink-750 hover:text-mist-50 transition-colors"
                title="关闭当前任务，回到空态 (Esc)"
              >
                <ArrowLeft size={13.5} />
                <span>关闭任务</span>
              </button>
              <button
                onClick={() => setLeftRailOpen(false)}
                className="btn-ghost p-1.5 text-mist-400 hover:text-mist-100"
                title="收起任务导轨（释放更多阅读空间）"
              >
                <PanelLeftClose size={14} />
              </button>
            </div>
            {/* 第 2 行：状态筛选栏 (36px，与右侧 Secondary Tab 栏 100% 对齐) */}
            <div className="flex h-9 shrink-0 items-center flex-wrap gap-1 border-b border-ink-700/60 bg-ink-850/50 px-2 text-[10.5px]">
              <button
                onClick={() => setFilterStatus(null)}
                className={clsx(
                  'rounded px-1.5 py-0.5 transition-colors',
                  filterStatus === null ? 'bg-leaf-dim/20 font-semibold text-leaf-soft' : 'text-mist-500 hover:text-mist-200'
                )}
              >
                全部 {tasks.length}
              </button>
              {columns.map((c) => {
                const count = tasks.filter((t) => matchCol(t, c.status)).length
                const on = filterStatus === c.status
                return (
                  <button
                    key={c.status}
                    onClick={() => setFilterStatus(on ? null : c.status)}
                    className={clsx(
                      'flex items-center gap-1 rounded px-1 py-0.5 transition-colors',
                      on ? 'bg-ink-750 font-semibold text-mist-100' : 'text-mist-500 hover:text-mist-300'
                    )}
                    title={c.label}
                  >
                    <span className={clsx('h-1.5 w-1.5 rounded-full', c.dot)} />
                    <span>{count}</span>
                  </button>
                )
              })}
            </div>
          </>
        ) : (
          <>
            {/* 收起状态第 1 行：返回看板 (44px，与右侧 Primary Header 100% 对齐) */}
            <div className="flex h-11 shrink-0 items-center justify-center border-b border-ink-700 bg-ink-850/90">
              <button
                onClick={onClose}
                className="flex h-7 w-7 items-center justify-center rounded-md text-mist-400 hover:bg-ink-750 hover:text-mist-100 transition-colors cursor-pointer"
                title="关闭当前任务 (Esc)"
              >
                <ArrowLeft size={14} />
              </button>
            </div>
            {/* 收起状态第 2 行：展开导轨 (36px，与右侧 Secondary Tab 栏 100% 对齐) */}
            <div className="flex h-9 shrink-0 items-center justify-center border-b border-ink-700/60 bg-ink-850/50">
              <button
                onClick={() => setLeftRailOpen(true)}
                className="flex h-6 w-6 items-center justify-center rounded-md text-mist-400 hover:bg-ink-750 hover:text-mist-100 transition-colors cursor-pointer"
                title="展开任务导轨"
              >
                <PanelLeftOpen size={14} />
              </button>
            </div>
          </>
        )}

        {/* 树形列表内容 */}
        {leftRailOpen && (
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2">
            {/* 需求组分组列表 */}
            {epicsList.length > 0 && (
              <div className="space-y-1.5">
                <div className="px-1 text-[10px] font-semibold uppercase tracking-wider text-mist-500">需求组</div>
                {epicsList.map((epic) => {
                  const children = childMap.get(epic.dirName) ?? []
                  const visibleChildren = filterStatus
                    ? children.filter((c) => matchCol(c, filterStatus))
                    : children
                  const isCollapsed = collapsedEpics[epic.dirName] ?? false
                  const isEpicSelected = epic.dirName === selected
                  const isChildSelected = children.some((c) => c.dirName === selected)
                  const doneCount = children.filter((c) => matchCol(c, 'completed')).length
                  const epicCol = columns.find((x) => matchCol(epic, x.status))

                  // 若开启状态筛选且该需求组与子任务均不符合，则过滤隐藏
                  if (filterStatus !== null && !matchCol(epic, filterStatus) && visibleChildren.length === 0) {
                    return null
                  }

                  return (
                    <div
                      key={epic.dirName}
                      className={clsx(
                        'overflow-hidden rounded-lg border transition-all shadow-xs',
                        isEpicSelected
                          ? 'border-leaf-dim/60 bg-ink-800 ring-1 ring-leaf-dim/40'
                          : isChildSelected
                            ? 'border-ink-600 bg-ink-800'
                            : 'border-ink-700/80 bg-ink-800 hover:border-ink-600'
                      )}
                    >
                      {/* 需求组节点卡片头：点击查看需求组本身，支持展开/收起 */}
                      <div
                        onClick={() => onSelect(epic.dirName)}
                        className={clsx(
                          'group cursor-pointer p-2 transition-colors',
                          isEpicSelected ? 'bg-leaf-dim/15' : 'hover:bg-ink-750/50'
                        )}
                      >
                        {/* 上行：折叠箭头 + 需求组标识 + 优先级 + 标题 + 进度徽标 */}
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              setCollapsedEpics((s) => ({ ...s, [epic.dirName]: !isCollapsed }))
                            }}
                            className="shrink-0 rounded p-0.5 text-mist-500 hover:bg-ink-700 hover:text-leaf transition-colors"
                            title={isCollapsed ? '展开子任务' : '收起子任务'}
                          >
                            {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                          </button>
                          <Layers size={11} className="shrink-0 text-leaf" />
                          {epic.record?.priority && <PriorityBadge priority={epic.record.priority} />}
                          <span
                            className={clsx(
                              'min-w-0 flex-1 truncate text-xs transition-colors',
                              isEpicSelected ? 'font-medium text-leaf-soft' : 'text-mist-200 group-hover:text-mist-100'
                            )}
                            title={`需求组 · ${epic.record?.title ?? epic.dirName}`}
                          >
                            {epic.record?.title ?? epic.dirName}
                          </span>
                          <span
                            className="shrink-0 rounded bg-ink-750/90 px-1 font-mono text-[9.5px] text-mist-400"
                            title={`子任务完成度：${doneCount}/${children.length}`}
                          >
                            {doneCount}/{children.length}
                          </span>
                        </div>

                        {/* 下行：与独立任务完全同构的分配人与状态 */}
                        <div className="mt-1.5 flex items-center gap-2 text-[10px] text-mist-500">
                          <span className="truncate" title={`分配人：${epic.record?.assignee || '未分配'}`}>
                            {epic.record?.assignee || '未分配'}
                          </span>
                          <span className="ml-auto flex shrink-0 items-center gap-1">
                            <span className={clsx('h-1.5 w-1.5 rounded-full', epicCol?.dot ?? 'bg-mist-600')} />
                            <span className="text-mist-400">{epicCol?.label ?? '规划中'}</span>
                          </span>
                        </div>
                      </div>

                      {/* 子任务列表 */}
                      {!isCollapsed && visibleChildren.length > 0 && (
                        <div className="space-y-0.5 border-t border-ink-700/60 bg-ink-900/60 p-1.5 pl-5">
                          {visibleChildren.map((c) => {
                            const isSel = c.dirName === selected
                            const col = columns.find((x) => matchCol(c, x.status))
                            return (
                              <button
                                key={c.dirName}
                                onClick={() => onSelect(c.dirName)}
                                className={clsx(
                                  'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] transition-colors',
                                  isSel
                                    ? 'bg-leaf-dim/20 font-medium text-leaf-soft'
                                    : 'text-mist-300 hover:bg-ink-750/60 hover:text-mist-100'
                                )}
                                title={`子任务 · ${c.record?.title ?? c.dirName}${c.record?.assignee ? ` · ${c.record.assignee}` : ''}`}
                              >
                                <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', col?.dot ?? 'bg-mist-600')} />
                                <span className="min-w-0 flex-1 truncate">{c.record?.title ?? c.dirName}</span>
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* 独立任务分组列表 */}
            {standalonesList.length > 0 && (
              <div className="space-y-1.5">
                <div className="px-1 text-[10px] font-semibold uppercase tracking-wider text-mist-500">独立任务</div>
                {standalonesList
                  .filter((t) => filterStatus === null || matchCol(t, filterStatus))
                  .map((t) => {
                    const isSel = t.dirName === selected
                    const col = columns.find((x) => matchCol(t, x.status))
                    return (
                      <div
                        key={t.dirName}
                        onClick={() => onSelect(t.dirName)}
                        className={clsx(
                          'group cursor-pointer rounded-lg border p-2 text-left transition-all shadow-xs',
                          isSel
                            ? 'border-leaf-dim/60 bg-leaf-dim/15 text-mist-50 ring-1 ring-leaf-dim/40'
                            : 'border-ink-700/80 bg-ink-800 hover:border-ink-600 hover:shadow-sm'
                        )}
                      >
                        {/* 上行：优先级徽标 + 任务标题 */}
                        <div className="flex items-center gap-1.5">
                          <PriorityBadge priority={t.record?.priority ?? ''} />
                          <span
                            className={clsx(
                              'min-w-0 flex-1 truncate text-xs transition-colors',
                              isSel ? 'font-medium text-leaf-soft' : 'text-mist-200 group-hover:text-mist-100'
                            )}
                            title={t.record?.title ?? t.dirName}
                          >
                            {t.record?.title ?? t.dirName}
                          </span>
                        </div>

                        {/* 下行：分配人与状态 */}
                        <div className="mt-1.5 flex items-center gap-2 text-[10px] text-mist-500">
                          <span className="truncate" title={`分配人：${t.record?.assignee || '未分配'}`}>
                            {t.record?.assignee || '未分配'}
                          </span>
                          <span className="ml-auto flex shrink-0 items-center gap-1">
                            <span className={clsx('h-1.5 w-1.5 rounded-full', col?.dot ?? 'bg-mist-600')} />
                            <span className="text-mist-400">{col?.label ?? '规划中'}</span>
                          </span>
                        </div>
                      </div>
                    )
                  })}
              </div>
            )}
          </div>
        )}

        {/* 收起状态下的迷你任务气泡导轨 */}
        {!leftRailOpen && (
          <div className="min-h-0 flex-1 flex flex-col items-center gap-2 overflow-y-auto py-3 px-1.5 scrollbar-none">
            {/* 需求组气泡 */}
            {epicsList.map((epic) => {
              const children = childMap.get(epic.dirName) ?? []
              const isEpicSelected = epic.dirName === selected
              const isChildSelected = children.some((c) => c.dirName === selected)
              const epicCol = columns.find((x) => matchCol(epic, x.status))
              const doneCount = children.filter((c) => matchCol(c, 'completed')).length

              return (
                <button
                  key={epic.dirName}
                  onClick={() => onSelect(epic.dirName)}
                  title={`【需求组】${epic.record?.title ?? epic.dirName}\n子任务：${doneCount}/${children.length}\n负责人：${epic.record?.assignee || '未分配'}\n状态：${epicCol?.label ?? '规划中'}`}
                  className={clsx(
                    'group relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-all cursor-pointer shadow-xs',
                    isEpicSelected
                      ? 'border-leaf bg-leaf/10 text-leaf-soft ring-2 ring-leaf/20 dark:bg-leaf/15 dark:text-leaf'
                      : isChildSelected
                        ? 'border-leaf-dim/40 bg-ink-800 text-leaf-soft'
                        : 'border-ink-700/80 bg-ink-800/90 text-mist-400 hover:border-ink-500 hover:bg-ink-750 hover:text-mist-100'
                  )}
                >
                  <Layers
                    size={14}
                    className={clsx(
                      'transition-colors',
                      isEpicSelected
                        ? 'text-leaf-soft dark:text-leaf'
                        : isChildSelected
                          ? 'text-leaf-soft'
                          : 'text-mist-400 group-hover:text-mist-100'
                    )}
                  />
                  {/* 状态指示圆点 */}
                  <span
                    className={clsx(
                      'absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-ink-900',
                      epicCol?.dot ?? 'bg-mist-600'
                    )}
                  />
                </button>
              )
            })}

            {/* 分割线 */}
            {epicsList.length > 0 && standalonesList.length > 0 && (
              <div className="my-0.5 h-px w-5 bg-ink-700/60 shrink-0" />
            )}

            {/* 独立任务气泡 */}
            {standalonesList.map((t) => {
              const isSel = t.dirName === selected
              const col = columns.find((x) => matchCol(t, x.status))
              const rawPriority = t.record?.priority
              const priorityText = rawPriority?.trim().toUpperCase()
              const priority =
                priorityText && priorityText !== 'P?' && priorityText !== '?' ? priorityText : null

              return (
                <button
                  key={t.dirName}
                  onClick={() => onSelect(t.dirName)}
                  title={`【任务】${t.record?.title ?? t.dirName}\n优先级：${priority || '未设定'}\n负责人：${t.record?.assignee || '未分配'}\n状态：${col?.label ?? '规划中'}`}
                  className={clsx(
                    'group relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-all cursor-pointer shadow-xs',
                    isSel
                      ? 'border-leaf bg-leaf/10 text-leaf-soft ring-2 ring-leaf/20 dark:bg-leaf/15 dark:text-leaf'
                      : 'border-ink-700/80 bg-ink-800/90 text-mist-300 hover:border-ink-500 hover:bg-ink-750 hover:text-mist-100'
                  )}
                >
                  {priority ? (
                    <span
                      className={clsx(
                        'font-mono text-[10px] font-bold leading-none tracking-tight',
                        priority === 'P0'
                          ? 'text-rose-500 dark:text-rose-400'
                          : priority === 'P1'
                            ? 'text-amber-500 dark:text-amber-400'
                            : priority === 'P2'
                              ? 'text-sky-500 dark:text-sky-400'
                              : isSel
                                ? 'text-leaf-soft dark:text-leaf'
                                : 'text-mist-300'
                      )}
                    >
                      {priority}
                    </span>
                  ) : (
                    <FileText
                      size={13.5}
                      className={clsx(
                        'transition-colors',
                        isSel ? 'text-leaf-soft dark:text-leaf' : 'text-mist-400 group-hover:text-mist-100'
                      )}
                    />
                  )}

                  {/* 状态指示圆点 */}
                  <span
                    className={clsx(
                      'absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-ink-900',
                      col?.dot ?? 'bg-mist-600'
                    )}
                  />
                </button>
              )
            })}
          </div>
        )}

        {/* 底部导航翻页 */}
        {leftRailOpen ? (
          <div className="flex items-center gap-2 border-t border-ink-700 bg-ink-850/60 px-3 py-2 text-[11px]">
            <button onClick={() => goto(-1)} disabled={idx <= 0} className="btn-ghost px-2 py-0.5 text-[11px] disabled:opacity-30">
              ← 上篇
            </button>
            <span className="mx-auto font-mono text-[10px] text-mist-500">{idx + 1} / {tasks.length}</span>
            <button onClick={() => goto(1)} disabled={idx >= tasks.length - 1} className="btn-ghost px-2 py-0.5 text-[11px] disabled:opacity-30">
              下篇 →
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-0.5 border-t border-ink-700 bg-ink-850/60 py-1">
            <button
              onClick={() => goto(-1)}
              disabled={idx <= 0}
              className="p-1 text-mist-400 hover:text-mist-100 disabled:opacity-20 cursor-pointer"
              title="上一篇任务"
            >
              <ChevronUp size={11} />
            </button>
            <span className="font-mono text-[8.5px] text-mist-500">{idx + 1}/{tasks.length}</span>
            <button
              onClick={() => goto(1)}
              disabled={idx >= tasks.length - 1}
              className="p-1 text-mist-400 hover:text-mist-100 disabled:opacity-20 cursor-pointer"
              title="下一篇任务"
            >
              <ChevronDown size={11} />
            </button>
          </div>
        )}
      </div>

      {/* 右侧：主阅读与一体化工作区（FR：未选任务时展示空态，主从常驻） */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-ink-900">
        {task ? (
          <>
        {/* 任务工作台 Primary Header：任务主控栏 (44px，与左侧第一行严格对齐) */}
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-ink-700 bg-ink-850/90 px-4 backdrop-blur-sm">
          {/* 左侧：任务身份与正式标题（清晰的主视觉） */}
          <div className="flex min-w-0 items-center gap-2 text-xs">
            {parentTask ? (
              <button
                onClick={() => onSelect(parentTask.dirName)}
                className="flex items-center gap-1 rounded bg-leaf-dim/15 px-2 py-0.5 text-[11px] font-medium text-leaf-soft transition-colors hover:bg-leaf-dim/25 shrink-0"
                title={`所属需求组：${parentTask.record?.title ?? parentTask.dirName} (点击跳转)`}
              >
                <Layers size={11.5} />
                <span className="truncate max-w-[130px]">{parentTask.record?.title ?? parentTask.dirName}</span>
                <span className="text-mist-500 font-normal">/</span>
              </button>
            ) : myChildren.length > 0 ? (
              <span className="flex items-center gap-1 rounded bg-leaf-dim/15 px-2 py-0.5 text-[11px] font-medium text-leaf-soft shrink-0">
                <Layers size={11.5} />
                <span>需求组 ({myChildren.length})</span>
              </span>
            ) : (
              <span className="rounded bg-ink-750/80 px-2 py-0.5 text-[11px] text-mist-400 shrink-0">
                独立任务
              </span>
            )}

            {/* 正式任务标题 */}
            <h1 className="truncate text-xs font-semibold text-mist-50" title={task.record?.title ?? task.dirName}>
              {task.record?.title ?? task.dirName}
            </h1>

            {/* 辅助元信息 */}
            <span className="font-mono text-[10.5px] text-mist-500 shrink-0 truncate max-w-[150px]" title={task.dirName}>
              {task.dirName}
            </span>

            {task.record?.branch && (
              <span className="chip bg-ink-750/80 font-mono text-[10px] text-mist-300 shrink-0" title={`Git 分支: ${task.record.branch}`}>
                {task.record.branch}
              </span>
            )}

            {jiraKeyOf(task) && <JiraChip jiraKey={jiraKeyOf(task)!} />}

            <span className="text-mist-600">·</span>
            <span className="text-[11px] text-mist-400 truncate shrink-0 max-w-[100px]">{task.record?.assignee || '未分配'}</span>
          </div>

          {/* 右侧：结构化功能操作区 */}
          <div className="flex items-center gap-2.5 shrink-0">
            {/* 分组 1：核心状态与属性 */}
            <div className="flex items-center gap-1.5 rounded-lg bg-ink-800 p-0.5 border border-ink-700/80 shadow-xs">
              {/* R0：状态只读展示，生命周期写入收归外部 Trellis 工作流 */}
              <span
                className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-mist-100"
                title="任务阶段由外部 Trellis 工作流管理，面板不直接修改"
              >
                <span className={clsx('h-1.5 w-1.5 rounded-full', columns.find((c) => c.status === statusOf(task))?.dot ?? 'bg-mist-400')} />
                <span>{statusLabel(statusOf(task))}</span>
              </span>
              <PriorityBadge priority={task.record?.priority ?? ''} />
              <div className="pr-1">
                <FocusTimer task={task} />
              </div>
            </div>

            <div className="h-4 w-px bg-ink-700/80" />

            {/* 分组 2：工具与操作（AI / 目录 / 归档） */}
            <div className="flex items-center gap-1">
              <button
                onClick={() => void api.openInEditor(task.path)}
                className="btn-ghost p-1.5 text-mist-400 hover:bg-ink-750 hover:text-mist-100"
                title="在 VS Code / 默认编辑器打开任务目录"
              >
                <SquareCode size={13.5} />
              </button>
              <button
                onClick={() => void api.revealInExplorer(task.path)}
                className="btn-ghost p-1.5 text-mist-400 hover:bg-ink-750 hover:text-mist-100"
                title="在资源管理器中打开任务目录"
              >
                <FolderOpen size={13.5} />
              </button>
              {/* T3：任务交接包——确定性文本，意图可选，附加 PRD 需显式勾选 */}
              <button
                onClick={() => setHandoffOpen(true)}
                className="btn-ghost p-1.5 text-leaf-soft hover:bg-ink-750 hover:text-leaf"
                title="生成任务交接包（复制给任意 AI 工具接续）"
              >
                <ClipboardCopy size={13.5} />
              </button>
              {/* T2：任务透视——文件事实 + 流程参考（规则预览）+ 上下文预期诊断 */}
              <button
                onClick={() => setInsightsOpen(true)}
                className="btn-ghost p-1.5 text-mist-400 hover:bg-ink-750 hover:text-mist-100"
                title="任务透视：文件事实、流程参考与上下文注入预期"
              >
                <ScanSearch size={13.5} />
              </button>
              {/* T4 能力验证：派 codex 只读 worker 审阅本任务（read-only 沙箱，报告不落盘） */}
              <button
                onClick={() => setDispatchOpen(true)}
                className="btn-ghost p-1.5 text-violet-300 hover:bg-ink-750 hover:text-violet-200"
                title="派 Codex 只读审阅（read-only 沙箱 worker，固定三段报告）"
              >
                <ShieldCheck size={13.5} />
              </button>
              {isRoot && (
                <button
                  onClick={() => void split()}
                  disabled={aiBusy !== null || !aiEnabled}
                  className="btn-ghost p-1.5 text-mist-400 hover:bg-ink-750 hover:text-mist-100"
                  title="AI 拆分子任务"
                >
                  {aiBusy === 'split' ? <Loader2 size={13.5} className="animate-spin" /> : <Split size={13.5} />}
                </button>
              )}
              <button
                onClick={() => void genText('commit')}
                disabled={!aiEnabled}
                className="btn-ghost p-1.5 text-mist-400 hover:bg-ink-750 hover:text-mist-100 disabled:opacity-40"
                title="AI 生成提交信息 (Commit Msg)"
              >
                <GitBranch size={13.5} />
              </button>
              <button
                onClick={() => void genText('pr')}
                disabled={!aiEnabled}
                className="btn-ghost p-1.5 text-mist-400 hover:bg-ink-750 hover:text-mist-100 disabled:opacity-40"
                title="AI 生成 PR 描述"
              >
                <ExternalLink size={13.5} />
              </button>
              {/* T1：任务级分享深链——token 主进程拼装，本机任意处粘贴可回到此任务 */}
              <button
                onClick={() => void copyTaskLink()}
                className="btn-ghost p-1.5 text-mist-400 hover:bg-ink-750 hover:text-mist-100"
                title="复制任务链接（深链，本机粘贴可直达）"
              >
                <Link2 size={13.5} />
              </button>
            </div>

            <div className="h-4 w-px bg-ink-700/80" />

            {/* 分组 3：视图切换 */}
            <div className="flex items-center gap-1">
              <button
                onClick={() => setRightAsideOpen((o) => !o)}
                className={clsx(
                  'btn-ghost p-1.5 transition-colors',
                  rightAsideOpen ? 'bg-leaf-dim/15 text-leaf-soft' : 'text-mist-400 hover:text-mist-100'
                )}
                title={rightAsideOpen ? '折叠右侧辅助栏（宽屏阅读模式）' : '展开右侧大纲与产物'}
              >
                {rightAsideOpen ? <PanelRightClose size={13.5} /> : <PanelRightOpen size={13.5} />}
              </button>
            </div>
          </div>
        </div>

        {/* 文档 Secondary Tabs：轻量分段视图切换栏 (36px，与左侧第二行严格对齐) */}
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-ink-700/60 bg-ink-850/50 px-4">
          {/* 左侧：轻量分段胶囊 Tabs */}
          <div className="flex items-center gap-1.5">
            {/* PRD Tab */}
            <button
              onClick={() => {
                const prdItem = docTabs.find((d) => d.type === 'prd')
                setActiveDocType('prd')
                setActiveDocPath(prdItem?.path ?? null)
                setActiveDocName(prdItem?.fileName ?? 'prd.md')
              }}
              className={clsx(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] transition-all',
                activeDocType === 'prd'
                  ? 'bg-ink-800 text-mist-50 font-medium shadow-xs border border-ink-700/70'
                  : 'text-mist-400 hover:text-mist-200 hover:bg-ink-800/50'
              )}
            >
              <FileText size={12} className={activeDocType === 'prd' ? 'text-leaf-soft' : 'text-mist-500'} />
              <span>PRD 需求文档</span>
              {docTabs.some((d) => d.type === 'prd') && (
                <span className={clsx('h-1.5 w-1.5 rounded-full', activeDocType === 'prd' ? 'bg-leaf' : 'bg-mist-600')} />
              )}
            </button>

            {/* Design Tab */}
            <button
              onClick={() => {
                const designItem = docTabs.find((d) => d.type === 'design')
                setActiveDocType('design')
                setActiveDocPath(designItem?.path ?? null)
                setActiveDocName(designItem?.fileName ?? 'design.md')
              }}
              className={clsx(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] transition-all',
                activeDocType === 'design'
                  ? 'bg-ink-800 text-mist-50 font-medium shadow-xs border border-ink-700/70'
                  : 'text-mist-400 hover:text-mist-200 hover:bg-ink-800/50'
              )}
            >
              <Compass size={12} className={activeDocType === 'design' ? 'text-sky-300' : 'text-mist-500'} />
              <span>Design 设计方案</span>
              {docTabs.some((d) => d.type === 'design') && (
                <span className={clsx('h-1.5 w-1.5 rounded-full', activeDocType === 'design' ? 'bg-sky-400' : 'bg-mist-600')} />
              )}
            </button>

            {/* 其他文档 Tabs */}
            {docTabs
              .filter((d) => d.type === 'other')
              .map((d) => (
                <button
                  key={d.path}
                  onClick={() => {
                    setActiveDocType('other')
                    setActiveDocPath(d.path)
                    setActiveDocName(d.fileName)
                  }}
                  className={clsx(
                    'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] transition-all',
                    activeDocPath === d.path
                      ? 'bg-ink-800 text-mist-50 font-medium shadow-xs border border-ink-700/70'
                      : 'text-mist-400 hover:text-mist-200 hover:bg-ink-800/50'
                  )}
                >
                  <BookOpenText size={12} className={activeDocPath === d.path ? 'text-violet-300' : 'text-mist-500'} />
                  <span className="truncate max-w-[140px]">{d.fileName}</span>
                </button>
              ))}

            {/* 激活的执行产物动态 Tab */}
            {activeDocType === 'artifact' && (
              <div className="flex items-center gap-1.5 rounded-md bg-ink-800 px-2.5 py-1 text-[11.5px] font-medium text-mist-50 border border-ink-700/70 shadow-xs">
                <FileCode size={12} className="text-leaf-soft" />
                <span className="truncate max-w-[140px]">{activeDocName}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    const prdItem = docTabs.find((d) => d.type === 'prd')
                    setActiveDocType('prd')
                    setActiveDocPath(prdItem?.path ?? null)
                    setActiveDocName(prdItem?.fileName ?? 'prd.md')
                  }}
                  className="ml-1 text-mist-400 hover:text-mist-100"
                  title="关闭产物预览，返回 PRD"
                >
                  <X size={11} />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* 双列/单列工作台容器（宽阔阅读区域） */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* 中间：自适应宽幅文档阅读区（纯白/纯黑纸张画布） */}
          <div
            ref={docContainerRef}
            onScroll={(e) => {
              // FR：滚动位置节流落库（500ms）
              const el = e.currentTarget
              if (scrollSaveTimer.current) clearTimeout(scrollSaveTimer.current)
              scrollSaveTimer.current = setTimeout(() => {
                if (task && projectName) {
                  setReading(projectName, {
                    dirName: task.dirName,
                    docName: activeDocName,
                    docType: activeDocType,
                    scrollTop: el.scrollTop
                  })
                }
              }, 500)
            }}
            className="flex-1 min-w-0 overflow-y-auto bg-ink-950 px-6 py-5">
            <div className={clsx('mx-auto transition-all', rightAsideOpen ? 'max-w-[1080px]' : 'max-w-[1240px]')}>
              {/* AI 摘要卡片 */}
              {aiSummaryText && (
                <div className="mb-5 rounded-xl border border-leaf-dim/30 bg-leaf-dim/5 p-4">
                  <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-leaf-soft">
                    <Sparkles size={12} /> AI 任务摘要
                  </div>
                  <MarkdownView content={aiSummaryText} />
                </div>
              )}

              {/* 正文渲染：根据活跃类型就地渲染 Markdown 或 CodeView */}
              <div>
                {loadingDoc ? (
                  <div className="flex items-center gap-2 py-10 text-xs text-mist-500">
                    <Loader2 size={14} className="animate-spin" /> 正在加载内容…
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
                ) : activeDocType === 'artifact' ? (
                  /* 执行产物就地代码/JSON高亮视图 */
                  <div className="space-y-3">
                    <div className="flex items-center justify-between border-b border-ink-750/70 pb-2.5">
                      <div className="flex items-center gap-2 text-xs font-mono text-mist-200">
                        <FileCode size={14} className="text-leaf" />
                        <span className="font-semibold">{activeDocName}</span>
                        <span className="text-[11px] text-mist-500">· 执行产物就地预览</span>
                      </div>
                      <button
                        onClick={() => {
                          const prdItem = docTabs.find((d) => d.type === 'prd')
                          setActiveDocType('prd')
                          setActiveDocPath(prdItem?.path ?? null)
                          setActiveDocName(prdItem?.fileName ?? 'prd.md')
                        }}
                        className="btn-ghost px-2 py-0.5 text-xs text-mist-400 hover:text-mist-100"
                      >
                        返回 PRD 文档
                      </button>
                    </div>
                    {docContent !== null ? (
                      <CodeView content={docContent} ext={activeDocName.slice(activeDocName.lastIndexOf('.'))} />
                    ) : (
                      <div className="py-10 text-center text-xs text-mist-500">该产物暂无文本内容</div>
                    )}
                  </div>
                ) : docContent !== null ? (
                  <MarkdownView content={docContent} />
                ) : activeDocType === 'prd' ? (
                  /* PRD 为空时的引导状态 */
                  <div className="space-y-4">
                    {task.record?.description ? (
                      <div>
                        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-mist-500">需求描述</div>
                        <MarkdownView content={task.record.description} />
                      </div>
                    ) : (
                      <div className="rounded-xl border border-dashed border-ink-600 p-8 text-center">
                        <BookOpenText size={24} className="mx-auto mb-2 text-mist-600" />
                        <div className="text-xs text-mist-400">该任务暂无 prd.md 需求文档</div>
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
                ) : activeDocType === 'design' ? (
                  /* Design 为空时的引导状态 */
                  <div className="rounded-xl border border-dashed border-ink-600 p-8 text-center">
                    <Compass size={24} className="mx-auto mb-2 text-mist-600" />
                    <div className="text-xs text-mist-400">该任务暂无 design.md 设计文档</div>
                    <div className="mt-1 text-[11px] text-mist-500">
                      复杂需求通常包含架构设计方案（design.md），可与 PRD 需求文档协同查看
                    </div>
                  </div>
                ) : (
                  <div className="py-10 text-center text-xs text-mist-500">暂无文档内容</div>
                )}
              </div>
            </div>
          </div>

          {/* 右侧：结构化辅助栏（支持一键折叠，释放极宽阅读空间） */}
          {rightAsideOpen && (
            <div className="w-56 shrink-0 space-y-5 overflow-y-auto border-l border-ink-700 bg-ink-900 p-3.5 transition-all">
              {/* 文档大纲 (TOC) */}
              {headings.length > 0 && activeDocType !== 'artifact' && (
                <div>
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-mist-400">
                    <ListChecks size={12} className="text-leaf" /> 文档大纲
                  </div>
                  <div className="space-y-1">
                    {headings.map((h, i) => (
                      <button
                        key={i}
                        onClick={() => scrollToHeading(h.text)}
                        className={clsx(
                          'block w-full truncate rounded px-2 py-1 text-left text-[11px] transition-colors hover:bg-ink-750 hover:text-mist-100',
                          h.level === 2 ? 'font-medium text-mist-300' : 'pl-4 text-mist-500'
                        )}
                        title={h.text}
                      >
                        {h.text}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* 子任务检查项 */}
              {prog && (
                <div className="border-t border-ink-700/60 pt-4">
                  <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-mist-400">
                    <span>子任务清单</span>
                    <span className="font-mono text-mist-200">{prog.done}/{prog.total}</span>
                  </div>
                  <div className="mb-2 h-1 overflow-hidden rounded-full bg-ink-700">
                    <div className="h-full bg-leaf-dim/80 transition-all" style={{ width: `${(prog.done / prog.total) * 100}%` }} />
                  </div>
                  <ul className="space-y-1.5">
                    {task.record?.subtasks.map((s, i) => {
                      const m = /^\s*[-*]?\s*\[( |x|X)\]\s*(.*)$/.exec(s)
                      const done = m?.[1]?.toLowerCase() === 'x'
                      const text = m?.[2] ?? s
                      return (
                        <li
                          key={i}
                          onClick={() => void toggleSubtask(i)}
                          className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 text-xs leading-5 text-mist-300 transition-colors hover:bg-ink-750/60"
                        >
                          <CircleCheck size={13} className={clsx('mt-0.5 shrink-0', done ? 'text-leaf' : 'text-mist-600')} />
                          <span className={done ? 'text-mist-500 line-through' : ''}>{text}</span>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}

              {/* 代码与执行产物：就地无缝查看，绝不跳出到外部抽屉 */}
              {nonDocArtifacts.length > 0 && (
                <div className="border-t border-ink-700/60 pt-4">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-mist-400">
                    执行产物 ({nonDocArtifacts.length})
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {nonDocArtifacts.map((a) => {
                      const isViewing = activeDocPath === a.path
                      return (
                        <button
                          key={a.path}
                          onClick={() => {
                            setActiveDocPath(a.path)
                            setActiveDocType('artifact')
                            setActiveDocName(a.name)
                          }}
                          className={clsx(
                            'flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] transition-colors',
                            isViewing
                              ? 'border-leaf-dim/60 bg-leaf-dim/20 text-leaf-soft font-medium shadow-sm'
                              : 'border-ink-700 bg-ink-800/80 text-mist-300 hover:border-ink-500 hover:text-mist-100'
                          )}
                          title={`就地查看 · ${a.name}`}
                        >
                          <FileCode size={11} className={isViewing ? 'text-leaf' : 'text-mist-400'} />
                          <span className="truncate max-w-[180px]">{a.name}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* 备注 */}
              {task.record?.notes && (
                <div className="border-t border-ink-700/60 pt-4">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-mist-400">备注</div>
                  <div className="whitespace-pre-wrap rounded-lg border border-ink-700/70 bg-ink-850/50 p-2.5 text-xs leading-5 text-mist-300">
                    {task.record.notes}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-mist-500">
            <ListTodo size={22} className="text-mist-600" />
            <div className="text-xs">从左侧选择任务开始阅读</div>
            <div className="text-[10.5px] text-mist-600">j / k 或 ↑↓ 切换 · Esc 关闭 · Ctrl+K 全局搜索</div>
          </div>
        )}
        {handoffOpen && task && <HandoffModal task={task} onClose={() => setHandoffOpen(false)} />}
        {insightsOpen && task && <TaskInsightsModal task={task} onClose={() => setInsightsOpen(false)} />}
        {dispatchOpen && task && <DispatchModal task={task} onClose={() => setDispatchOpen(false)} />}
      </div>

    </div>
  )
}

/* ---------------- Page ---------------- */

export function TasksPage(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)!
  const showTask = useApp((s) => s.showTask)
  const openTaskDir = useApp((s) => s.openTaskDir)
  const pushToast = useApp((s) => s.pushToast)
  const [query, setQuery] = useState('')
  const [assignee, setAssignee] = useState('')
  const [priority, setPriority] = useState('')

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
  const { childMap, childDirs } = useMemo(() => {
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
    return { childMap: map, childDirs: dirs }
  }, [snapshot.tasks])
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

  /* ----- 聚合状态计数（filtered） ----- */
  const counts = useMemo(
    () =>
      columns.map((c) => ({
        ...c,
        count: filtered.filter((t) => matchCol(t, c.status)).length
      })),
    [filtered, columns]
  )

  /* FR：显式打开剪贴板中的任务路径 */
  const openFromClipboard = async (): Promise<void> => {
    const res = await api.taskResolveClipboardTask()
    if (res.ok) {
      showTask(res.dirName, res.archived)
      pushToast({ kind: 'success', title: '已打开任务', body: res.dirName })
    } else {
      pushToast({ kind: 'warn', title: '未能识别剪贴板任务', body: res.error })
    }
  }

  /* FR：进入任务页时恢复上次阅读的任务（稳定地址；仅首次） */
  const restoredRef = useRef(false)
  useEffect(() => {
    if (restoredRef.current || !snapshot?.tasks.length) return
    restoredRef.current = true
    if (openTaskDir) return
    const saved = getReading(snapshot.meta.name)
    if (saved && snapshot.tasks.some((t) => t.dirName === saved.dirName)) {
      showTask(saved.dirName)
    }
  }, [snapshot, openTaskDir, showTask])

  /* 键盘导航：Escape 退出工作台；j/k 上下切换任务 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (openTaskDir) {
        if (e.key === 'Escape') {
          showTask(null)
        } else if (e.key === 'j' || e.key === 'ArrowDown') {
          const curIdx = filtered.findIndex((t) => t.dirName === openTaskDir)
          if (curIdx >= 0 && curIdx < filtered.length - 1) {
            showTask(filtered[curIdx + 1].dirName)
          }
        } else if (e.key === 'k' || e.key === 'ArrowUp') {
          const curIdx = filtered.findIndex((t) => t.dirName === openTaskDir)
          if (curIdx > 0) {
            showTask(filtered[curIdx - 1].dirName)
          }
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openTaskDir, filtered, showTask])

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* 任务页工具栏（FR：主从常驻，不再随选中状态隐藏） */}
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
          <Select
            value={assignee}
            onChange={setAssignee}
            options={[
              { value: '', label: '全部负责人' },
              ...assignees.map((a) => ({ value: a, label: a }))
            ]}
            className="w-32"
            size="sm"
          />
          <Select
            value={priority}
            onChange={setPriority}
            options={[
              { value: '', label: '全部优先级' },
              { value: 'P0', label: 'P0 紧急' },
              { value: 'P1', label: 'P1 高' },
              { value: 'P2', label: 'P2 中' },
              { value: 'P3', label: 'P3 低' }
            ]}
            className="w-32"
            size="sm"
          />

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
            {/* FR：显式打开剪贴板中的任务路径（从 AI 客户端复制路径后一键定位；不自动跳转） */}
            <button onClick={() => void openFromClipboard()} className="btn-outline" title="读取剪贴板中的任务路径并打开">
              <ClipboardPaste size={12} /> 打开剪贴板任务
            </button>
            <span className="text-[11px] text-mist-500">{filtered.length} 个任务</span>
          </div>
        </div>

      {/* 视图内容：FR 主从布局常驻——左侧任务导轨 + 右侧阅读区（未选任务显示空态） */}
      <TaskWorkspace
        tasks={filtered}
        selected={openTaskDir}
        onSelect={(dir) => showTask(dir)}
        onClose={() => showTask(null)}
        columns={columns}
        childMap={childMap}
        childDirs={childDirs}
      />

    </div>
  )
}

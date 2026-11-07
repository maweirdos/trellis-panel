import React, { useEffect, useMemo, useRef, useState } from 'react'
import { PageContent, PageLayout } from '../my/layout/PageLayout'
import { Select } from '../components/Select'
import {
  X,
  FolderOpen,
  ExternalLink,
  SquarePen,
  Circle,
  CircleCheck,
  FileText,
  GitCompare,
  Save,
  RotateCcw,
  RefreshCw,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  ArrowUpRight,
  ArrowDownLeft,
  Check,
  Plus,
  Settings2,
  Copy,
  Maximize2,
  Paperclip,
  ArrowLeft,
  PanelRightOpen
} from 'lucide-react'
import { useApp } from '../store'
import { api, hasIpc } from '../api'
import { WorkItemIntegrations } from '../my/pages/integrations/WorkItemIntegrations'
import { clsx } from 'clsx'
import { PriorityBadge, StatusBadge, JiraChip } from '../components/badges'
import { Button } from '../my/ui'
import { confirmDialog } from '../components/Dialogs'
import { fmtBytes, parseSubtask, taskDateLabel } from '../utils/format'
import { DocumentReader } from '../reader/DocumentReader'
import { readingSessionKey } from '../reader/reading-session'
import { relativePathUnderRoot } from '../reader/reader-paths'
import { TASK_MATERIAL_GROUPS, taskMaterialGroup, type TaskMaterialGroup } from '../reader/task-materials'
import { ObservationPanel } from '../observation/ObservationPanel'
import { useEscLayer } from '../utils/use-esc-layer'
import { DiffModal } from './DiffModal'
import type { JSX } from 'react'
import type { FileEntry, GitLabTaskStatus, TaskGitInfo, TaskInfo, TaskPatch } from '../../../shared/types'
import { developmentPanelPosition, saveDevelopmentPanelPosition } from '../crux/development/context'

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
      <span className="my-item-title w-16 shrink-0 pt-0.5">
        {label}
        {modified && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-my-warning align-middle" title="待保存修改" />}
      </span>
      <div className="min-w-0 flex-1 text-my-xs text-my-primary">{children}</div>
    </div>
  )
}

/* ---------------- 文档优先：任务产物（PRD / Design …）直接在抽屉里阅读 ---------------- */

/** PRD / Design 排最前，其余按名称 */
function docWeight(name: string): number {
  if (/prd|requirement|需求/i.test(name)) return 0
  if (/design|方案|tech/i.test(name)) return 1
  return 2
}

function docLabel(name: string): string {
  const base = name.split('/').pop() ?? name
  const stem = base.replace(/\.[^.]+$/, '')
  if (/^prd$/i.test(stem)) return 'PRD'
  if (/^design$/i.test(stem)) return 'Design'
  return stem
}

/** 子目录同名文件（如 a/check.md、b/check.md）标签去重：加父目录前缀 */
function docLabels(names: string[]): Map<string, string> {
  const stems = names.map((n) => docLabel(n))
  const counts = new Map<string, number>()
  for (const s of stems) counts.set(s, (counts.get(s) ?? 0) + 1)
  return new Map(
    names.map((n, i) => {
      const stem = stems[i]
      if ((counts.get(stem) ?? 0) <= 1) return [n, stem]
      const parent = n.split('/').slice(-2, -1)[0]
      return [n, parent ? `${parent}/${stem}` : stem]
    })
  )
}

/** 抽屉内嵌文档阅读器（S0 G2 第三片）：正文走共享 DocumentReader（同一加载/错误/版本契约），
 * 头部保留复制/放大既有能力，并新增「展开为完整工作区」入口（AC1）。 */
const DocPane = React.memo(function DocPane({
  file,
  taskRef,
  onOpenInViewer,
  onExpand,
  presentation
}: {
  file: FileEntry
  taskRef: string | null
  onOpenInViewer: () => void
  onExpand: () => void
  presentation: 'preview' | 'workspace'
}): JSX.Element {
  const projectRoot = useApp((s) => s.snapshot?.meta.root ?? '')
  const relativePath = relativePathUnderRoot(projectRoot, file.path)
  // 复制按钮取展示版全文（阅读会话状态机是三入口共同的正文事实源）
  const sessionKey = relativePath !== null && taskRef !== null
    ? readingSessionKey({ workspaceId: projectRoot, taskRef }, relativePath)
    : null
  const displayedText = useApp((s) => (sessionKey !== null ? s.readingSessions[sessionKey]?.displayed?.text : undefined))
  const isMd = /\.(md|markdown)$/i.test(file.name)
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    await api.copyToClipboard(displayedText ?? '')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div data-task-document={file.path}>
      <div className="mb-4 flex items-center gap-2 rounded-my-lg border border-my-line bg-my-layer-1 px-3 py-1.5">
        <FileText size={12} className={clsx('shrink-0', isMd ? 'text-my-icon-accent' : 'text-my-icon-tertiary')} />
        <span className="min-w-0 flex-1 truncate font-mono text-my-xs text-my-tertiary" title={file.path}>
          {file.name} · {fmtBytes(file.size)}
        </span>
        <Button variant="ghost" size="sm" onClick={() => void copy()} title="复制全文">
          <Copy size={11} /> {copied ? '已复制' : '复制'}
        </Button>
        {presentation === 'preview' && (
          <Button variant="ghost" size="sm" onClick={onExpand} title="展开为完整任务工作区（保留返回位置）">
            <Maximize2 size={11} /> 展开
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onOpenInViewer} title="在产物查看器中打开（固定标签）">
          <ArrowUpRight size={11} /> 放大
        </Button>
      </div>
      {relativePath !== null ? (
        <DocumentReader
          workspaceId={projectRoot}
          taskRef={taskRef ?? undefined}
          relativePath={relativePath}
          variant={presentation === 'workspace' ? 'full' : 'compact'}
        />
      ) : (
        <div className="rounded-my-lg border border-my-line bg-my-layer-1 px-3 py-2 text-my-sm text-my-tertiary">
          该文件不在当前项目内，使用普通读取打开；不提供版本比较与变更提示。
        </div>
      )}
    </div>
  )
})

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
            <Select
              autoFocus
              value={draft}
              onChange={(value) => {
                setDraft(value)
                onChange(field, value)
                setEditing(false)
              }}
              onBlur={() => setEditing(false)}
              className="h-8 w-full"
              ariaLabel={label}
              options={options}
            />
          ) : multiline ? (
            <textarea
              autoFocus
              rows={3}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="w-full rounded-my-md border border-my-line bg-my-surface-1 px-2.5 py-1.5 text-my-sm text-my-primary outline-none placeholder:text-my-placeholder focus:border-my-line-accent resize-y"
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
              className="h-8 w-full rounded-my-md border border-my-line bg-my-surface-1 px-2.5 text-my-sm text-my-primary outline-none placeholder:text-my-placeholder focus:border-my-line-accent"
            />
          )}
          {!options && (
            <div className="flex gap-1.5">
              <Button variant="primary" size="sm" onClick={done}>
                确认
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                取消
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="group flex items-start gap-1.5">
          <span className={clsx('min-w-0 flex-1 whitespace-pre-wrap break-words', modified && 'text-my-accent-text')}>
            {(display ? display(shown) : shown) || <span className="text-my-placeholder">—</span>}
            {modified && value && (
              <span className="ml-1.5 text-my-2xs text-my-placeholder line-through">{display ? display(value) : value}</span>
            )}
          </span>
          <button
            onClick={() => setEditing(true)}
            className="mt-0.5 shrink-0 text-my-icon-placeholder transition-colors hover:text-my-icon-accent"
            title="编辑"
          >
            <SquarePen size={12} />
          </button>
        </div>
      )}
    </Row>
  )
}

/* D1/PF-11：接续与交接——把"这次怎么继续"集中放回原任务：真实材料清单、
 * 已知读取问题、可选携带 PRD、生命周期命令提示。确定性生成（不依赖 LLM）、
 * 只含索引与元信息、不含凭据；复制出去的内容以文本为准。 */
const HANDOFF_INTENTS = ['只核对与阅读，不开始实施', '继续该任务的实施'] as const

function HandoffSection({ dirName, status }: { dirName: string; status: string | null }): JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const [intent, setIntent] = useState<string>(HANDOFF_INTENTS[0])
  const [includePrd, setIncludePrd] = useState(false)
  const [result, setResult] = useState<{
    text: string
    issues: string[]
    files: string[]
    gitLines: string[]
    checkFiles: string[]
    uncheckedSubtasks: string[]
    openQuestions: string[]
  } | null>(null)
  const [building, setBuilding] = useState(false)

  const build = async (): Promise<void> => {
    setBuilding(true)
    try {
      const res = await api.taskHandoffBuild(dirName, intent, includePrd)
      if (res.ok) {
        setResult({
          text: res.text,
          issues: res.issues,
          files: res.files,
          gitLines: res.gitLines ?? [],
          checkFiles: res.checkFiles ?? [],
          uncheckedSubtasks: res.uncheckedSubtasks ?? [],
          openQuestions: res.openQuestions ?? []
        })
      } else {
        setResult(null)
        pushToast({ kind: 'error', title: '交接材料生成失败', body: res.error ?? '未知错误' })
      }
    } finally {
      setBuilding(false)
    }
  }

  const statusHint = ((): string => {
    const cmd = (sub: string): string => `python .trellis/scripts/task.py ${sub} ${dirName}`
    switch ((status ?? '').toLowerCase()) {
      case '': return '任务尚未开始——需要进入开发时运行 ' + cmd('start')
      case 'planning': return '进入开发请运行 ' + cmd('start') + '（会置为 in_progress 并设为当前任务）'
      case 'in_progress': return '本轮告一段落可运行 task.py finish 清除当前任务指针（finish 不修改任务状态）'
      case 'review': return '评审通过后按项目流程归档：' + cmd('archive')
      case 'completed': case 'done': return '归档请运行 ' + cmd('archive')
      default: return '状态变化请走项目工作流（task.py / AI 会话），面板不直接改写生命周期'
    }
  })()

  return (
    <div className="py-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-my-xs text-my-tertiary">
        <ArrowUpRight size={12} /> 接续与交接
      </div>
      <p className="my-item-description mb-2 px-1">{statusHint}</p>
      <div className="flex flex-wrap items-center gap-2 px-1">
        <Select
          value={intent}
          onChange={setIntent}
          className="max-w-52"
          size="sm"
          ariaLabel="交接意图"
          options={HANDOFF_INTENTS.map((item) => ({ value: item, label: item }))}
        />
        <label className="flex items-center gap-1.5 text-my-xs text-my-secondary">
          <input type="checkbox" checked={includePrd} onChange={(e) => setIncludePrd(e.target.checked)} />
          携带 PRD 原文（内容将离开本机）
        </label>
        <Button size="sm" variant="outline" onClick={() => void build()} disabled={building}>
          {building ? <RefreshCw size={12} className="animate-spin" /> : <FileText size={12} />} 生成交接材料
        </Button>
      </div>
      {result && (
        <div className="mt-2 px-1">
          {result.issues.length > 0 && (
            <p className="mb-1.5 rounded-my-md border border-my-line-warning bg-my-warning-subtle px-2 py-1.5 text-my-xs leading-4 text-my-warning-text">
              已知读取问题：{result.issues.join('；')}
            </p>
          )}
          {result.gitLines.length > 0 && (
            <div className="mb-1.5 rounded-my-md border border-my-line bg-my-layer-1 px-2 py-1.5">
              <p className="mb-0.5 text-my-xs font-medium text-my-tertiary">本次变化（Git · 归属以 git 为准）</p>
              {result.gitLines.map((l, i) => (
                <p key={i} className="truncate font-mono text-my-2xs leading-4 text-my-secondary" title={l}>· {l}</p>
              ))}
            </div>
          )}
          <div className="mb-1.5 rounded-my-md border border-my-line bg-my-layer-1 px-2 py-1.5">
            <p className="mb-0.5 text-my-xs font-medium text-my-tertiary">检查与未完成项</p>
            <p className="text-my-2xs leading-4 text-my-secondary">
              检查记录：{result.checkFiles.length > 0 ? result.checkFiles.join('、') : '未发现检查记录文件'}
              {result.uncheckedSubtasks.length > 0 ? ` · 未完成子任务 ${result.uncheckedSubtasks.length} 项` : ' · 未完成子任务：无'}
            </p>
          </div>
          {result.openQuestions.length > 0 && (
            <div className="mb-1.5 rounded-my-md border border-my-line-warning bg-my-warning-subtle px-2 py-1.5">
              <p className="mb-0.5 text-my-xs font-medium text-my-warning-text">待确认问题（来自 prd.md，{result.openQuestions.length} 项）</p>
              {result.openQuestions.map((q, i) => (
                <p key={i} className="truncate text-my-2xs leading-4 text-my-warning-text" title={q}>· {q}</p>
              ))}
            </div>
          )}
          <p className="mb-1 text-my-xs text-my-tertiary">阅读清单（实际存在 {result.files.length} 个文件）</p>
          <ul className="mb-1.5 space-y-0.5">
            {result.files.map((f) => (
              <li key={f} className="truncate font-mono text-my-2xs text-my-secondary">· {f}</li>
            ))}
          </ul>
          <Button size="sm" variant="ghost" onClick={() => { void api.copyToClipboard(result.text); pushToast({ kind: 'success', title: '交接材料已复制' }) }}>
            <Copy size={12} /> 复制完整交接材料
          </Button>
        </div>
      )}
    </div>
  )
}

export function TaskDetail({ presentation = 'preview' }: { presentation?: 'preview' | 'workspace' }): JSX.Element | null {
  const snapshot = useApp((s) => s.snapshot)
  const settings = useApp((s) => s.settings)
  const openTaskDir = useApp((s) => s.openTaskDir)
  const archived = useApp((s) => s.openTaskArchived)
  const showTask = useApp((s) => s.showTask)
  const pushToast = useApp((s) => s.pushToast)
  const inboxRemove = useApp((s) => s.inboxRemove)
  const openArtifact = useApp((s) => s.openArtifact)
  const materialTarget = useApp((s) => s.taskMaterialTarget)
  const workspace = presentation === 'workspace'

  /** 当前选中视图：null = 自动（首选文档），'info' = 详情字段，其余 = 产物文件路径 */
  const [sel, setSel] = useState<string | null>(() => developmentPanelPosition(snapshot?.meta.root, openTaskDir)?.selection ?? null)
  const [materialGroup, setMaterialGroup] = useState<TaskMaterialGroup>(() => developmentPanelPosition(snapshot?.meta.root, openTaskDir)?.materialGroup ?? 'all')
  const [contextOpen, setContextOpen] = useState(() => developmentPanelPosition(snapshot?.meta.root, openTaskDir)?.contextOpen ?? false)
  const [pending, setPending] = useState<TaskPatch>(() => developmentPanelPosition(snapshot?.meta.root, openTaskDir)?.pending ?? {})
  const [showDiff, setShowDiff] = useState(() => developmentPanelPosition(snapshot?.meta.root, openTaskDir)?.showDiff ?? false)
  const [git, setGit] = useState<TaskGitInfo | null>(null)
  const [gitLoading, setGitLoading] = useState(false)
  const [newBranch, setNewBranch] = useState('')
  const [showAllCommits, setShowAllCommits] = useState(false)
  /** drawer widths, draggable — 看文档用宽幅、改字段用窄幅，分开记忆 */
  const [widths, setWidths] = useState(() => {
    const n = Number(localStorage.getItem('tpanel.drawerWidth'))
    const d = Number(localStorage.getItem('tpanel.drawerDocWidth'))
    return {
      field: n >= 360 && n <= 1400 ? n : 460,
      doc: d >= 520 && d <= 1600 ? d : Math.min(920, Math.round(window.innerWidth * 0.62))
    }
  })
  /** task.json mtime captured when the drawer opened — for conflict detection */
  const [openedMtime, setOpenedMtime] = useState<number | undefined>(undefined)

  /* ----- drawer interactions: Esc 关闭走全局 Esc 层（preview；编辑字段时不抢），左缘拖拽调宽 ----- */
  useEscLayer(openTaskDir !== null, {
    kind: 'preview',
    // A consumed layer must register again on preview/workspace transition.
    id: `task-detail-${presentation}`,
    // 焦点在输入控件内时 Esc 交给字段自身（如取消编辑），不关抽屉——守卫在 Esc 层派发前生效
    deferWhenInputFocused: true,
    onClose: () => {
      if (workspace) useApp.getState().returnFromWorkspace()
      else showTask(null)
    }
  })
  useEscLayer(contextOpen, {
    kind: 'overlay',
    id: 'task-detail-context',
    deferWhenInputFocused: true,
    onClose: () => setContextOpen(false)
  })

  /* S0 G2 第三片（AC1）：展开为完整工作区——记录来源页面与滚动位置，返回时恢复 */
  const expandToWorkspace = (): void => {
    const st = useApp.getState()
    if (!openTaskDir || workspace) return
    const pageScroll = document.querySelector<HTMLElement>('[data-page-scroll]')
    st.expandTaskWorkspace({
      fromPage: st.page,
      taskDir: openTaskDir,
      archived,
      scrollTop: pageScroll?.scrollTop ?? 0
    })
  }

  const onStartResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    document.body.style.cursor = 'ew-resize'
    const onMove = (moveEv: MouseEvent): void => {
      const min = activeDocRef.current ? 520 : 360
      const w = Math.min(1600, Math.max(min, window.innerWidth - moveEv.clientX))
      setWidths((s) => (activeDocRef.current ? { ...s, doc: w } : { ...s, field: w }))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      setWidths((s) => {
        localStorage.setItem(
          activeDocRef.current ? 'tpanel.drawerDocWidth' : 'tpanel.drawerWidth',
          String(activeDocRef.current ? s.doc : s.field)
        )
        return s
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  useEffect(() => {
    const saved = developmentPanelPosition(snapshot?.meta.root, openTaskDir)
    setSel(saved?.selection ?? null)
    setMaterialGroup(saved?.materialGroup ?? 'all')
    setContextOpen(saved?.contextOpen ?? false)
    setPending(saved?.pending ?? {})
    setShowDiff(saved?.showDiff ?? false)
    setGit(null)
    setShowAllCommits(false)
    setOpenedMtime(saved?.openedMtime ?? task?.taskJsonMtime)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTaskDir, archived])
  useEffect(() => {
    saveDevelopmentPanelPosition(snapshot?.meta.root, openTaskDir, { selection: sel, materialGroup, contextOpen, pending, showDiff, openedMtime })
  }, [sel, materialGroup, contextOpen, pending, showDiff, openedMtime, snapshot?.meta.root, openTaskDir])

  // load git info when drawer opens or a rescan lands (30s-cached in main)
  const scannedAt = useApp((s) => s.snapshot?.scannedAt)
  useEffect(() => {
    if (!hasIpc) return
    if (!openTaskDir || archived) return
    let alive = true
    setGitLoading(true)
    api.gitTaskInfo(openTaskDir).then((g) => {
      if (!alive) return
      setGit(g)
      setGitLoading(false)
    }).catch(() => { if (alive) setGitLoading(false) })
    return () => { alive = false }
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

  /* 文档优先：PRD / Design 排前，直接在抽屉里阅读 */
  const docs = useMemo(
    () =>
      (task?.artifacts ?? [])
        .filter((f) => f.kind === 'file')
        .sort((a, b) => docWeight(a.name) - docWeight(b.name) || a.name.localeCompare(b.name)),
    [task]
  )
  const activeDoc = sel === 'info' ? undefined : (docs.find((d) => d.path === sel) ?? docs[0])
  const showInfo = !activeDoc
  const labels = useMemo(() => docLabels(docs.map((d) => d.name)), [docs])
  const visibleDocs = materialGroup === 'all' ? docs : docs.filter((d) => taskMaterialGroup(d.name) === materialGroup)
  useEffect(() => {
    if (materialTarget === null) return
    if (docs.some((d) => d.path === materialTarget)) {
      setSel(materialTarget)
      setMaterialGroup('all')
    }
    useApp.getState().setTaskMaterialTarget(null)
  }, [materialTarget, docs])
  /** 当前生效宽度：读文档宽幅 / 改字段窄幅（拖拽手柄各自记忆） */
  const width = activeDoc ? widths.doc : widths.field
  const activeDocRef = useRef(activeDoc)
  activeDocRef.current = activeDoc

  /* ----- GitLab connector: MR + pipeline status for the task branch ----- */
  const gitlabEnabled = settings?.gitlab?.enabled && !!settings?.gitlab?.baseUrl && !!settings?.gitlab?.project
  const [gl, setGl] = useState<GitLabTaskStatus | null>(null)
  const [glBusy, setGlBusy] = useState(false)
  useEffect(() => {
    if (!hasIpc) return
    if (!gitlabEnabled || !openTaskDir || archived) return
    let alive = true
    api.gitlabTaskStatus(openTaskDir).then((status) => { if (alive) setGl(status) }).catch(() => undefined)
    return () => { alive = false }
  }, [gitlabEnabled, openTaskDir, archived, scannedAt, task?.record?.branch])

  if (!task) return null
  const r = task.record
  const jiraKey = typeof r?.meta?.jiraKey === 'string' ? (r.meta.jiraKey as string) : null
  const jiraUrl = typeof r?.meta?.jiraUrl === 'string' ? (r.meta.jiraUrl as string) : null
  const pendingCount = Object.keys(pending).length

  const setField = (field: string, v: string): void => {
    setPending((p) => {
      const next = { ...p, [field]: v } as TaskPatch
      const oldVal = r ? (r as unknown as Record<string, unknown>)[field] : undefined
      if (String(next[field as keyof TaskPatch]) === String(oldVal ?? '')) {
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
      // 冲突不清空暂存：刷新基线后保留用户编辑，重新预览即可再次保存
      pushToast({
        kind: 'warn',
        title: '保存冲突',
        body: 'task.json 已被外部修改。已刷新最新内容，你的暂存修改已保留——请重新预览确认后再保存。'
      })
      await useApp.getState().refresh()
      setOpenedMtime(useApp.getState().snapshot?.tasks.find((t) => t.dirName === task.dirName)?.taskJsonMtime)
    } else {
      pushToast({ kind: 'error', title: '保存失败', body: res.error })
    }
  }

  const toggleSubtask = async (idx: number): Promise<void> => {
    if (!r) return
    // base on pending edits when present so checkbox edits never clash with staged field edits
    const base = pending.subtasks ?? r.subtasks
    const next = base.map((s, i) => {
      if (i !== idx) return s
      const { done, text } = parseSubtask(s)
      return `[${done ? ' ' : 'x'}] ${text}`
    })
    setPending((p) => ({ ...p, subtasks: next }))
  }

  const deleteTodo = async (): Promise<void> => {
    if (r?.status !== 'planning') return
    const confirmed = await confirmDialog({
      title: `确定删除待办“${r?.title ?? task.dirName}”吗？`,
      message: '只会删除本地 Trellis 待办，不会删除 Jira 问题。',
      danger: true
    })
    if (!confirmed) return
    const res = await api.deleteTask(task.path, task.taskJsonMtime)
    if (res.ok) {
      inboxRemove(task.dirName)
      showTask(null)
      pushToast({ kind: 'success', title: '待办已删除', body: task.dirName })
    } else if (res.conflict) {
      pushToast({ kind: 'warn', title: '删除冲突', body: res.error })
      await useApp.getState().refresh()
    } else {
      pushToast({ kind: 'error', title: '删除待办失败', body: res.error })
    }
  }

  return (
    <PageLayout variant="full"
      data-task-detail-presentation={presentation}
      className={clsx('relative flex h-full min-w-0 shrink-0 flex-col', pendingCount > 0 && 'my-page-with-bottom-actions', workspace ? 'w-full bg-my-surface-1' : 'animate-slide-in bg-my-canvas')}
      style={workspace ? undefined : { width, maxWidth: '100%' }}
    >
      {/* 左缘拖拽调宽手柄 */}
      {!workspace && <div
        onMouseDown={onStartResize}
        className="absolute inset-y-0 left-0 z-30 w-1.5 cursor-ew-resize transition-colors hover:bg-my-line-strong"
        title="拖拽调整宽度"
      />}
      <div className="my-page-toolbar-row items-start">
        {workspace && (
          <Button variant="ghost" size="sm" onClick={() => { useApp.getState().returnFromWorkspace() }} title="返回来源视图的任务预览">
            <ArrowLeft size={14} /> 返回
          </Button>
        )}
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            {r && <StatusBadge status={pending.status ?? r.status} />}
            {r && <PriorityBadge priority={pending.priority ?? r.priority} />}
            {jiraKey && <JiraChip jiraKey={jiraKey} />}
            <span className="font-mono text-my-2xs text-my-tertiary">
              {taskDateLabel(task.dirName, task.date)}
              {archived ? ' · 已归档' : ''}
            </span>
          </div>
          <h2 className="my-item-title line-clamp-2">
            {pending.title ?? r?.title ?? task.dirName}
          </h2>
          <div className="my-item-description mt-0.5 font-mono">{task.dirName}</div>
        </div>
        {!workspace && (
          <Button variant="ghost" size="sm" onClick={expandToWorkspace} title="展开为中央任务工作区">
            <Maximize2 size={14} />
          </Button>
        )}
        <button type="button" aria-expanded={contextOpen} aria-controls="task-context-panel" onClick={() => setContextOpen((open) => !open)} title="任务属性、关联与上下文回执" className={clsx('my-control my-control-sm shrink-0', contextOpen ? 'bg-my-accent-subtle text-my-accent-text' : 'text-my-secondary hover:bg-my-layer-1-hover')}>
          <PanelRightOpen size={14} /> 上下文
        </button>
        <Button variant="ghost" size="sm" onClick={() => showTask(null)} title="关闭任务">
          <X size={15} />
        </Button>
      </div>

      <div className="shrink-0 border-b border-my-line bg-my-layer-1 px-3 py-2">
        <div className="my-scrollbar mb-2 flex items-center gap-1 overflow-x-auto" aria-label="材料浏览分组">
          {TASK_MATERIAL_GROUPS.map((group) => (
            <button key={group.id} type="button" aria-pressed={materialGroup === group.id} onClick={() => setMaterialGroup(group.id)} className={clsx('my-control my-control-sm shrink-0', materialGroup === group.id ? 'bg-my-layer-2 font-medium text-my-primary' : 'text-my-secondary hover:bg-my-layer-1-hover')}>
              {group.label}
            </button>
          ))}
        </div>
        <div className="my-scrollbar flex max-h-24 flex-wrap items-center gap-1 overflow-y-auto" aria-label="任务材料">
          {visibleDocs.map((d) => {
            const on = activeDoc?.path === d.path
            const isMd = /\.(md|markdown)$/i.test(d.name)
            return (
              <button
                key={d.path}
                type="button"
                aria-pressed={on}
                data-development-material={d.path}
                aria-current={on ? 'page' : undefined}
                onClick={() => setSel(d.path)}
                title={d.name}
                className={clsx(
                  'flex items-center gap-1 rounded-my-md border px-2 py-1 text-my-xs transition-colors',
                  on
                    ? 'border-my-line-accent bg-my-accent-subtle text-my-accent-text'
                    : 'border-my-line text-my-secondary hover:bg-my-layer-1-hover'
                )}
              >
                <FileText size={11} className={isMd ? 'text-my-icon-accent' : 'text-my-icon-tertiary'} />
                {labels.get(d.name) ?? docLabel(d.name)}
              </button>
            )
          })}
          {visibleDocs.length === 0 && <span className="px-1 text-my-xs text-my-secondary">该分组暂无材料；分组只便于查找，不代表阶段完成。</span>}
          <button
            onClick={() => setSel('info')}
            className={clsx(
              'flex items-center gap-1 rounded-my-md border px-2 py-1 text-my-xs transition-colors',
              showInfo
                ? 'border-my-line-accent bg-my-accent-subtle text-my-accent-text'
                : 'border-transparent text-my-tertiary hover:bg-my-layer-1-hover hover:text-my-secondary'
            )}
          >
            <Settings2 size={11} /> 详情
          </button>
          {task.artifacts.length > docs.length && (
            <span className="ml-auto flex shrink-0 items-center gap-1 text-my-2xs text-my-tertiary" title="其余产物见「详情」底部">
              <Paperclip size={10} /> {task.artifacts.length - docs.length}
            </span>
          )}
        </div>
      </div>

      <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto">
        <PageContent variant={workspace ? 'centered' : 'full'}>
        {activeDoc && (
          <DocPane
            key={activeDoc.path}
            file={activeDoc}
            taskRef={task.dirName}
            onOpenInViewer={() => openArtifact(activeDoc, true)}
            onExpand={expandToWorkspace}
            presentation={presentation}
          />
        )}

        {showInfo && (
          <div className="space-y-1 divide-y divide-my-line">
            {task.parseError && (
              <div className="mb-2 rounded-my-lg border border-my-line-danger bg-my-danger-subtle px-3 py-2 text-my-xs text-my-danger-text">
                task.json 解析失败：{task.parseError}
              </div>
            )}
            {r ? (
              <>
                <FieldRow field="title" label="标题" value={r.title} pendingValue={pending.title} onChange={setField} />
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
                    <div className="mb-1.5 text-my-xs text-my-tertiary">子任务</div>
                    <div className="space-y-1">
                      {r.subtasks.map((s, i) => {
                        const { done, text, isCheckable } = parseSubtask(s)
                        return (
                          <div key={i} className="flex items-start gap-2 text-my-xs text-my-primary">
                            {isCheckable ? (
                              <button onClick={() => void toggleSubtask(i)} className="mt-0.5 shrink-0">
                                {done ? (
                                  <CircleCheck size={13} className="text-my-icon-accent" />
                                ) : (
                                  <Circle size={13} className="text-my-icon-tertiary transition-colors hover:text-my-icon-secondary" />
                                )}
                              </button>
                            ) : null}
                            <span className={clsx(done && 'text-my-tertiary line-through')}>{text}</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-x-4 py-1.5 text-my-xs leading-5 text-my-secondary">
                  <span>创建者</span><span className="text-right text-my-primary">{r.creator || '—'}</span>
                  <span>创建时间</span><span className="text-right font-mono text-my-primary">{r.createdAt || '—'}</span>
                  <span>完成时间</span><span className="text-right font-mono text-my-primary">{r.completedAt ?? '—'}</span>
                  <span>基础分支</span><span className="text-right font-mono text-my-primary">{r.base_branch ?? '—'}</span>
                  <span>任务类型</span><span className="text-right text-my-primary">{r.dev_type ?? '—'}</span>
                  <span>范围 / 包</span><span className="text-right text-my-primary">{[r.scope, r.package].filter(Boolean).join(' / ') || '—'}</span>
                  <span>提交</span><span className="truncate text-right font-mono text-my-primary">{r.commit ?? '—'}</span>
                  <span>工作树</span><span className="truncate text-right font-mono text-my-primary">{r.worktree_path ?? '—'}</span>
                  <span>父任务</span><span className="truncate text-right font-mono text-my-primary">{r.parent ?? '—'}</span>
                  <span>子任务(引用)</span><span className="truncate text-right font-mono text-my-primary">{r.children.length ? r.children.join(', ') : '—'}</span>
                </div>

                {r.relatedFiles.length > 0 && (
                  <div className="py-1.5">
                    <div className="mb-1.5 text-my-xs text-my-tertiary">相关文件</div>
                    <div className="space-y-0.5">
                      {r.relatedFiles.map((f) => (
                        <div key={f} className="break-all font-mono text-my-xs text-my-secondary">· {f}</div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Git 集成 */}
                <WorkItemIntegrations key={task.path} taskDir={task.path} />
                {!archived && (
                  <div className="pt-3">
                    <div className="mb-1.5 flex items-center gap-1.5 text-my-xs text-my-tertiary">
                      <GitBranch size={12} /> Git 状态
                      {gitLoading && <RefreshCw size={10} className="animate-spin" />}
                    </div>
                    {git?.error ? (
                      <div className="text-my-xs text-my-tertiary">{git.error}</div>
                    ) : git ? (
                      <div className="space-y-1.5 rounded-my-lg border border-my-line bg-my-layer-1 px-3 py-2.5 text-my-xs">
                        <div className="flex items-center gap-2">
                          <span className="my-chip bg-my-layer-2 font-mono text-my-secondary">{r.branch ?? '无分支'}</span>
                          {git.ahead > 0 && (
                            <span className="my-chip border border-my-label-indigo-border text-my-label-indigo-text">
                              <ArrowUpRight size={10} /> 领先 {git.ahead}
                            </span>
                          )}
                          {git.behind > 0 && (
                            <span className="my-chip border border-my-label-orange-border text-my-label-orange-text">
                              <ArrowDownLeft size={10} /> 落后 {git.behind}
                            </span>
                          )}
                          {git.worktreeDirty && <span className="my-chip border border-my-label-yellow-border text-my-label-yellow-text">有未提交改动</span>}
                        </div>
                        {git.merged && (
                          <div className="flex items-center gap-1.5 rounded-my-sm bg-my-success-subtle px-2 py-1 text-my-success-text">
                            <GitMerge size={11} /> 分支已合入 {r.base_branch ?? '主分支'}
                          </div>
                        )}
                        {git.commits.length > 0 && (
                          <div className="space-y-1">
                            {(showAllCommits ? git.commits : git.commits.slice(0, 4)).map((c) => (
                              <div key={c.short} className="flex items-center gap-2 text-my-xs text-my-secondary">
                                <GitCommitHorizontal size={10} className="shrink-0" />
                                <span className="font-mono text-my-secondary">{c.short}</span>
                                <span className="min-w-0 flex-1 truncate" title={`${c.subject} · ${c.date}`}>
                                  {c.subject}
                                </span>
                                <span className="shrink-0">{c.author}</span>
                              </div>
                            ))}
                            {git.commits.length > 4 && (
                              <button
                                onClick={() => setShowAllCommits((v) => !v)}
                                className="text-my-xs text-my-accent-text underline"
                              >
                                {showAllCommits ? '收起提交记录' : `展开全部 ${git.commits.length} 条提交`}
                              </button>
                            )}
                          </div>
                        )}
                        {!r.branch && (
                          <div className="flex items-center gap-1.5 pt-0.5">
                            <input
                              value={newBranch}
                              onChange={(e) => setNewBranch(e.target.value)}
                              placeholder={`从 ${r.base_branch ?? 'main'} 新建分支…`}
                              className="h-8 w-full flex-1 rounded-my-md border border-my-line bg-my-surface-1 px-2.5 font-mono text-my-sm text-my-primary outline-none placeholder:text-my-placeholder focus:border-my-line-accent"
                            />
                              <Button variant="outline" size="sm" disabled={!newBranch.trim()} onClick={async () => {
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
                              }}>
                                <Plus size={11} /> 创建
                              </Button>
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>
                )}

                {/* GitLab 连接器：MR / 流水线 */}
                {gitlabEnabled && r?.branch && (
                  <div className="pt-3">
                    <div className="mb-1.5 flex items-center gap-1.5 text-my-xs text-my-tertiary">
                      <GitMerge size={12} /> GitLab
                      {!gl && <RefreshCw size={10} className="animate-spin" />}
                    </div>
                    {gl && !gl.ok && (
                      <div className="text-my-xs text-my-tertiary">{gl.error}</div>
                    )}
                    {gl?.ok && (
                      <div className="flex flex-wrap items-center gap-1.5 rounded-my-lg border border-my-line bg-my-layer-1 px-3 py-2.5 text-my-xs">
                        {gl.mr ? (
                          <button
                            onClick={() => {
                              const mr = gl.mr
                              if (mr) api.openExternal(mr.webUrl)
                            }}
                            className={clsx(
                              'my-chip border',
                              gl.mr.state === 'merged'
                                ? 'border-my-label-purple-border bg-my-label-purple text-my-label-purple-text'
                                : 'border-my-label-indigo-border bg-my-label-indigo text-my-label-indigo-text'
                            )}
                            title={`${gl.mr.title} → ${gl.mr.targetBranch}`}
                          >
                            <GitMerge size={10} /> MR !{gl.mr.iid} · {gl.mr.state === 'merged' ? '已合并' : '评审中'} ↗
                          </button>
                        ) : (
                          <span className="my-chip border border-my-line text-my-tertiary">无 MR</span>
                        )}
                        {gl.pipeline ? (
                          <button
                            onClick={() => {
                              const pipeline = gl.pipeline
                              if (pipeline) api.openExternal(pipeline.webUrl)
                            }}
                            className={clsx(
                              'my-chip border',
                              ['success', 'passed'].includes(gl.pipeline.status)
                                ? 'border-my-label-emerald-border bg-my-label-emerald text-my-label-emerald-text'
                                : ['failed'].includes(gl.pipeline.status)
                                  ? 'border-my-label-crimson-border bg-my-label-crimson text-my-label-crimson-text'
                                  : 'border-my-label-yellow-border bg-my-label-yellow text-my-label-yellow-text'
                            )}
                            title="打开流水线"
                          >
                            构建源码 ·{' '}
                            {gl.pipeline.status === 'success' || gl.pipeline.status === 'passed'
                              ? '成功'
                              : gl.pipeline.status === 'failed'
                                ? '失败'
                                : gl.pipeline.status === 'running'
                                  ? '运行中'
                                  : gl.pipeline.status}{' '}
                            ↗
                          </button>
                        ) : (
                          <span className="my-chip border border-my-line text-my-tertiary">无流水线</span>
                        )}
                        {!gl.mr && (
                          <button
                            disabled={glBusy}
                            onClick={async () => {
                              setGlBusy(true)
                              const res = await api.gitlabCreateMr(task.dirName)
                              setGlBusy(false)
                              if (res.ok && res.url) {
                                pushToast({ kind: 'success', title: 'MR 已创建', body: res.url })
                                api.openExternal(res.url)
                                setGl(await api.gitlabTaskStatus(task.dirName))
                              } else {
                                pushToast({ kind: 'error', title: '创建 MR 失败', body: res.error })
                              }
                            }}
                            className="my-chip border border-my-line-accent-subtle text-my-accent-text hover:bg-my-accent-subtle disabled:opacity-50"
                          >
                            <GitMerge size={10} /> {glBusy ? '创建中…' : '新建 MR'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <div className="flex flex-wrap gap-2 pt-3">
                  {r?.status === 'planning' && (
                    <button
                      type="button"
                      onClick={() => void deleteTodo()}
                      className="my-control my-control-sm bg-my-danger-subtle text-my-danger-text hover:bg-my-danger-subtle-hover"
                    >
                      <X size={12} /> 删除待办
                    </button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => api.revealInExplorer(task.path)}>
                    <FolderOpen size={12} /> 打开目录
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => api.openInEditor(task.path)}>
                    <ExternalLink size={12} /> 编辑器打开
                  </Button>
                  {jiraKey && (
                    <>
                      {jiraUrl && (
                        <Button size="sm" variant="outline" onClick={() => api.openExternal(jiraUrl)}>
                          <ExternalLink size={12} /> Jira {jiraKey}
                        </Button>
                      )}
                      {/* R0：从 Jira 同步（直写任务状态）已停用——任务阶段收归外部工作流 */}
                    </>
                  )}
                </div>
              </>
            ) : (
              <div className="py-6 text-center text-my-xs text-my-tertiary">缺少 task.json</div>
            )}

            {/* 全部产物：未知扩展名仍可选择，读取诊断由共享阅读器原样显示。 */}
            {task.artifacts.length > 0 && (
              <div className="py-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-my-xs text-my-tertiary">
                  <Paperclip size={12} /> 产物文件 ({task.artifacts.length})
                </div>
                <div className="space-y-1">
                  {task.artifacts.map((f) => {
                    const clickable = f.kind === 'file'
                    return (
                      <button
                        key={f.path}
                        disabled={!clickable}
                        onClick={() => clickable && setSel(f.path)}
                        className={clsx(
                          'flex w-full items-center gap-2.5 rounded-my-lg border border-transparent px-3 py-2 text-left transition-colors',
                          clickable
                            ? 'hover:border-my-line hover:bg-my-layer-1-hover'
                            : 'cursor-default opacity-60'
                        )}
                      >
                        <FileText size={13} className={clsx('shrink-0', /\.md$/i.test(f.name) ? 'text-my-icon-accent' : 'text-my-icon-tertiary')} />
                        <span className="my-item-title min-w-0 flex-1 truncate font-mono">{f.name}</span>
                        <span className="shrink-0 text-my-xs text-my-tertiary">{f.kind === 'file' ? fmtBytes(f.size) : '目录'}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* D1：接续与交接（生命周期命令提示 + 确定性交接包） */}
            {r && <HandoffSection dirName={task.dirName} status={r.status ?? null} />}
          </div>
        )}
        </PageContent>
      </div>

      {contextOpen && (
        <aside id="task-context-panel" aria-label="任务上下文" className="my-scrollbar absolute inset-y-0 right-0 z-30 w-[min(340px,100%)] overflow-y-auto border-l border-my-line-strong bg-my-layer-1 p-4 shadow-[var(--my-shadow-overlay-200)]">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="my-item-title">任务上下文</h3>
            <Button variant="ghost" size="sm" onClick={() => setContextOpen(false)} title="收起上下文"><X size={14} /></Button>
          </div>
          <dl className="mb-4 space-y-3 text-my-sm">
            <div><dt className="my-item-title">负责人</dt><dd className="mt-0.5 break-words text-my-primary">{r?.assignee || '未分配'}</dd></div>
            <div><dt className="my-item-title">创建者</dt><dd className="mt-0.5 text-my-primary">{r?.creator || '未知'}</dd></div>
            <div><dt className="my-item-title">任务目录</dt><dd className="mt-0.5 break-all font-mono text-my-xs text-my-primary">{task.path}</dd></div>
            {r?.branch && <div><dt className="my-item-title">关联分支</dt><dd className="mt-0.5 break-all font-mono text-my-xs text-my-primary">{r.branch}</dd></div>}
          </dl>
          <div className="mb-4 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => { setSel('info'); setContextOpen(false) }}><Settings2 size={12} /> 详细属性</Button>
            {jiraUrl && <Button size="sm" variant="outline" onClick={() => { void api.openExternal(jiraUrl) }}><ExternalLink size={12} /> Jira 来源</Button>}
            {r?.pr_url && <Button size="sm" variant="outline" onClick={() => { void api.openExternal(r.pr_url ?? '') }}><ExternalLink size={12} /> PR / MR</Button>}
          </div>
          {hasIpc && snapshot ? (
            <ObservationPanel workspaceId={snapshot.meta.root} taskRef={r?.id ? `task:${r.id}` : `dir:${relativePathUnderRoot(snapshot.meta.root, task.path) ?? `.trellis/tasks/${task.dirName}`}`} variant="compact" />
          ) : <p className="my-item-description">当前没有本机项目连接，无法读取真实上下文回执。</p>}
        </aside>
      )}

      {/* 待保存修改 footer */}
      {pendingCount > 0 && (
        <div className="absolute inset-x-0 bottom-0 z-10 flex animate-fade-in items-center gap-2 border-t border-my-line bg-my-layer-2 px-4 py-2.5">
          <span className="text-my-xs text-my-warning-text">
            {pendingCount} 处待保存修改
          </span>
          <div className="ml-auto flex gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => setPending({})} title="放弃全部修改">
              <RotateCcw size={12} /> 放弃
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowDiff(true)}>
              <GitCompare size={12} /> 预览
            </Button>
            <Button variant="primary" size="sm" onClick={() => void saveAll()}>
              <Save size={12} /> 保存
            </Button>
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
    </PageLayout>
  )
}

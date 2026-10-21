import { useEffect, useRef, useState, type JSX } from 'react'
import { ArrowUpRight, CheckSquare, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Circle, CircleCheck, CircleDot, ClipboardCheck, Code2, Copy, FileCode2, FileText, FolderOpen, GitBranch, ListTodo, Loader2, Maximize2, Minimize2, PanelsTopLeft, Pin, PinOff, Square, SquarePen, X } from 'lucide-react'
import { clsx } from 'clsx'
import { useApp } from '../store'
import { api } from '../api'
import { errorMessage } from '../../../shared/errors'
import { PriorityBadge, StatusBadge } from './badges'
import { subtaskProgressOf } from '../utils/format2'
import { statusLabel } from '../utils/labels'
import { CAPSULE_PHASES, capsuleDocuments, type CapsuleDocument } from './capsule-model'
import { FloatingFrame, FloatingIconButton, readFloatingPreference, writeFloatingPreference } from './FloatingWindow'

type Shape = 'pill' | 'card'
interface SelectionOwner { root: string | null; taskPath: string | null }
const SHAPE_KEY = 'trellis:capsuleShape'

function initialShape(): Shape {
  const value = new URLSearchParams(window.location.search).get('shape') ?? readFloatingPreference(SHAPE_KEY)
  return value === 'card' ? 'card' : 'pill'
}

/** The task strip and compact work surface share real selection and native actions. */
export function CapsuleView(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)
  const [shape, setShape] = useState<Shape>(initialShape)
  const [onTop, setOnTop] = useState(() => new URLSearchParams(window.location.search).get('pinned') !== 'false')
  const [selectedTask, setSelectedTask] = useState<{ root: string | null; dirName: string | null }>({ root: null, dirName: null })
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ owner: SelectionOwner; message: string } | null>(null)
  const [expandedOwner, setExpandedOwner] = useState<SelectionOwner | null>(null)
  const [openingDocument, setOpeningDocument] = useState<{ owner: SelectionOwner; path: string; request: number } | null>(null)
  const mutationLock = useRef(false)
  const shapeLock = useRef(false)
  const documentRequest = useRef(0)
  const selectionOwner = useRef<SelectionOwner>({ root: null, taskPath: null })
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    const unsubscribe = api.onSnapshotUpdated((snap) => {
      if (!mounted.current) return
      if (selectionOwner.current.root !== snap.meta.root) {
        selectionOwner.current = { root: snap.meta.root, taskPath: null }
        setSelectedTask({ root: snap.meta.root, dirName: null })
        setFeedback(null)
      }
      useApp.getState().setSnapshot(snap)
    })
    return () => { mounted.current = false; unsubscribe() }
  }, [])
  useEffect(() => {
    void api.setCapsuleShape(shape).catch((cause: unknown) => { if (mounted.current) setError(errorMessage(cause) ?? '任务悬浮窗初始化失败') })
    // Window shape is fixed at entry; subsequent changes go through switchShape.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const root = snapshot?.meta.root ?? null
  const selectedId = selectedTask.root === root ? selectedTask.dirName : null
  useEffect(() => {
    setSelectedTask((selection) => selection.root === root ? selection : { root, dirName: null })
  }, [root])
  const tasks = snapshot?.tasks ?? []
  const activeTasks = tasks.filter((task) => ['planning', 'in_progress', 'review'].includes(task.record?.status ?? ''))
  const displayTasks = activeTasks.length ? activeTasks : tasks
  const safeIndex = Math.max(0, displayTasks.findIndex((task) => task.dirName === selectedId))
  const current = displayTasks[safeIndex]
  const progress = current ? subtaskProgressOf(current) : null
  const status = current?.record?.status
  const documents = current && root ? capsuleDocuments(current, root) : []
  const phaseIndex = CAPSULE_PHASES.findIndex((item) => item.phase === current?.phase)
  const phaseHint = CAPSULE_PHASES[phaseIndex]?.hint ?? `当前状态：${statusLabel(status)}`
  const statusTone = status === 'in_progress' ? 'bg-my-warning' : status === 'review' ? 'bg-my-label-purple-strong' : status === 'completed' || status === 'done' ? 'bg-my-success' : 'bg-my-icon-tertiary'

  // An object identity fences late replies even after A -> B -> A selection changes.
  if (selectionOwner.current.root !== root || selectionOwner.current.taskPath !== (current?.path ?? null)) {
    selectionOwner.current = { root, taskPath: current?.path ?? null }
  }
  const owner = selectionOwner.current
  const error = feedback?.owner === owner ? feedback.message : null
  const setError = (message: string | null): void => setFeedback(message === null ? null : { owner, message })
  const subtasksExpanded = expandedOwner === owner
  const ownsView = (expectedOwner = owner): boolean => mounted.current && selectionOwner.current === expectedOwner

  const run = async (action: () => Promise<unknown>, expectedOwner = owner): Promise<void> => {
    if (!ownsView(expectedOwner)) return
    setError(null)
    try { await action() } catch (cause) {
      if (ownsView(expectedOwner)) setError(errorMessage(cause) ?? '操作失败，请重试')
    }
  }
  const switchShape = async (next: Shape): Promise<void> => {
    if (shapeLock.current || shape === next) return
    shapeLock.current = true
    try {
      await api.setCapsuleShape(next)
      if (mounted.current) setShape(next)
      writeFloatingPreference(SHAPE_KEY, next)
    } catch (cause) { if (ownsView()) setError(errorMessage(cause) ?? '窗口切换失败') } finally { shapeLock.current = false }
  }
  const selectTask = (direction: number): void => {
    if (!displayTasks.length) return
    const next = displayTasks[(safeIndex + direction + displayTasks.length) % displayTasks.length]
    selectionOwner.current = { root, taskPath: next.path }
    setSelectedTask({ root, dirName: next.dirName })
    setError(null)
  }
  const toggleOnTop = (): void => {
    void run(async () => { const next = !onTop; await api.setCapsuleOnTop(next); if (mounted.current) setOnTop(next) })
  }
  const openMain = async (): Promise<void> => {
    await run(async () => {
      if (!root || !current) { api.setCapsuleMode(false); return }
      const result = await api.openMainTask(root, current.dirName)
      if (!result.ok) throw new Error(result.error || '无法打开当前任务')
    })
  }
  const openDocument = async (document: CapsuleDocument): Promise<void> => {
    if (!ownsView() || !root || !current) return
    const liveSnapshot = useApp.getState().snapshot
    const liveTask = liveSnapshot?.meta.root === root
      ? liveSnapshot.tasks.find((task) => task.path === current.path && task.dirName === current.dirName)
      : undefined
    const liveDocument = liveTask && capsuleDocuments(liveTask, root).find((item) => item.file.path === document.file.path && item.file.name === document.file.name)
    if (!liveTask || !liveDocument) {
      setError('任务资料已变化，请等待刷新后重新打开')
      return
    }
    const request = ++documentRequest.current
    setOpeningDocument({ owner, path: document.file.path, request })
    setError(null)
    try {
      const theme = window.document.documentElement.classList.contains('dark') ? 'dark' : 'light'
      const result = await api.docOpen({ key: liveDocument.file.path, title: `${liveDocument.label} · ${liveTask.record?.title ?? liveTask.dirName}`, file: liveDocument.file.path, theme })
      if (!result.ok) throw new Error(result.error || '文档打开失败')
    } catch (cause) {
      if (ownsView() && documentRequest.current === request) setError(errorMessage(cause) ?? '文档打开失败')
    } finally {
      if (mounted.current) setOpeningDocument((pending) => pending?.request === request ? null : pending)
    }
  }
  const toggleSubtask = async (index: number): Promise<void> => {
    if (!current?.record || mutationLock.current) return
    const subtasks = [...(current.record.subtasks ?? [])]
    const item = subtasks[index]
    if (!item || !/\[[ xX]\]/.test(item)) return
    subtasks[index] = /\[[xX]\]/.test(item) ? item.replace(/\[[xX]\]/, '[ ]') : item.replace(/\[ \]/, '[x]')
    mutationLock.current = true
    setBusy(true)
    try {
      await run(async () => {
        const result = await api.updateTask(current.path, { subtasks }, current.taskJsonMtime)
        if (!result.ok) throw new Error(result.error || '子任务更新失败')
        const latest = await api.getSnapshot()
        if (ownsView() && latest?.meta.root === root) useApp.getState().setSnapshot(latest)
      })
    } finally {
      mutationLock.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const windowActions = <div className="no-drag flex shrink-0 items-center gap-0.5">
    <FloatingIconButton label={shape === 'pill' ? '展开任务悬浮窗' : '收起为任务状态条'} onClick={() => void switchShape(shape === 'pill' ? 'card' : 'pill')}>{shape === 'pill' ? <Maximize2 size={14} /> : <Minimize2 size={14} />}</FloatingIconButton>
    {shape === 'card' && <FloatingIconButton label={onTop ? '取消置顶' : '置顶窗口'} aria-pressed={onTop} onClick={toggleOnTop}>{onTop ? <Pin size={14} /> : <PinOff size={14} />}</FloatingIconButton>}
    {shape === 'pill' && <FloatingIconButton label="打开主面板" onClick={() => void openMain()}><ArrowUpRight size={15} /></FloatingIconButton>}
    <FloatingIconButton label="隐藏任务悬浮窗" onClick={() => void run(() => api.closeCapsule())}><X size={15} /></FloatingIconButton>
  </div>

  if (shape === 'pill') return <FloatingFrame strip>
    <div className="drag-region my-floating-strip my-capsule-strip" title={error ?? '拖动可移动任务状态条'}>
      <span className={clsx('my-floating-dot', current ? statusTone : 'bg-my-icon-tertiary')} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-my-sm font-medium" title={current?.record?.title ?? current?.dirName}>{current?.record?.title ?? current?.dirName ?? (snapshot ? '暂无任务' : '未打开项目')}</div>
        <div className={clsx('truncate text-my-2xs', error ? 'text-my-danger-text' : 'text-my-secondary')}>
          {error ?? `${snapshot?.meta.name ?? '任务状态条'}${progress ? ` · 子任务 ${progress.done}/${progress.total}` : ' · 展开查看详情'}`}
        </div>
      </div>
      {displayTasks.length > 1 && <button type="button" className="no-drag my-floating-count" onClick={() => selectTask(1)} title="切换到下一个任务">{safeIndex + 1}/{displayTasks.length}</button>}
      {windowActions}
    </div>
  </FloatingFrame>

  return <FloatingFrame>
    <header className="drag-region my-floating-header my-capsule-header">
      <PanelsTopLeft size={16} className="shrink-0 text-my-icon-secondary" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-my-sm font-medium" title={snapshot?.meta.root}>{snapshot?.meta.name ?? '未打开项目'}</span>
      {windowActions}
    </header>
    <div className="no-drag my-floating-body my-capsule-body my-scrollbar">
      {(error || current?.parseError) && <p role="alert" className="my-capsule-error select-text">{error ?? current?.parseError}</p>}
      {current ? <>
        <section className="my-capsule-current" aria-label="当前任务">
          <div className="my-capsule-task-bar">
            <div className="flex min-w-0 items-center gap-2"><StatusBadge status={status ?? ''} /><PriorityBadge priority={current.record?.priority ?? ''} /></div>
            <div className="my-capsule-pagination" role="group" aria-label="任务切换">
              <FloatingIconButton label="上一个任务" disabled={displayTasks.length < 2} onClick={() => selectTask(-1)}><ChevronLeft size={14} /></FloatingIconButton>
              <span>{safeIndex + 1} / {displayTasks.length}</span>
              <FloatingIconButton label="下一个任务" disabled={displayTasks.length < 2} onClick={() => selectTask(1)}><ChevronRight size={14} /></FloatingIconButton>
            </div>
          </div>
          <div className="my-capsule-title-row">
            <h1 className="my-capsule-title min-w-0 flex-1 select-text" title={current.record?.title ?? current.dirName}>{current.record?.title ?? current.dirName}</h1>
            <FloatingIconButton label="复制任务信息" onClick={() => void run(async () => {
              await api.copyToClipboard(`${current.dirName} ${current.record?.title ?? ''}`)
              if (ownsView()) useApp.getState().pushToast({ kind: 'info', title: '已复制任务信息' })
            })}><Copy size={14} /></FloatingIconButton>
          </div>
          <div className="my-capsule-metadata">
            <span className="my-capsule-meta-line select-text" title={`${current.record?.assignee || '未分配'} · ${current.dirName}`}>{current.jiraKey || current.dirName}</span>
            {current.record?.branch && <><span className="my-capsule-meta-separator" aria-hidden="true">·</span><span className="my-capsule-branch select-text" title={current.record.branch}><GitBranch size={13} className="shrink-0" aria-hidden="true" /><span className="min-w-0 truncate font-mono">{current.record.branch}</span></span></>}
          </div>
        </section>
        <section className="my-capsule-materials" aria-label="资料与产物">
          <div className="my-capsule-section-header"><h2>资料与产物</h2>{documents.length > 0 && <button type="button" className="my-capsule-text-action" onClick={() => void openMain()} aria-label="在主面板查看全部资料">全部 {documents.length} 份 <ArrowUpRight size={12} aria-hidden="true" /></button>}</div>
          {documents.length ? <div className="my-capsule-documents">{documents.slice(0, 3).map((document) => {
            const opening = openingDocument?.owner === owner && openingDocument.path === document.file.path
            const Icon = document.group === 'execution' ? FileCode2 : document.group === 'validation' ? ClipboardCheck : FileText
            return <button key={document.file.path} type="button" className="my-capsule-document" disabled={opening} aria-busy={opening || undefined} aria-label={`阅读：${document.file.name}`} title={`${document.file.name}\n${document.modifiedTitle}\n${document.file.path}`} onClick={() => void openDocument(document)}>
              <span className="my-capsule-document-icon">{opening ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Icon size={15} aria-hidden="true" />}</span>
              <span className="my-capsule-document-name">{document.label}</span>
              <span className="my-capsule-document-kind">{document.kind}</span>
              <time className="my-capsule-document-time" dateTime={document.modifiedAt} title={document.modifiedTitle}>{document.modified}</time>
              <ArrowUpRight size={12} className="shrink-0 text-my-icon-tertiary" aria-hidden="true" />
            </button>
          })}</div> : <p className="my-capsule-materials-empty">暂无任务资料</p>}
        </section>
        <section className="my-capsule-workflow" aria-label="本地任务阶段">
          <div className="my-capsule-section-header"><h2>任务进度</h2><span className="my-capsule-workflow-source">本地任务阶段</span></div>
          <ol className="my-capsule-stages" aria-label={phaseIndex >= 0 ? `当前阶段：${CAPSULE_PHASES[phaseIndex].label}` : '当前任务阶段未知'}>{CAPSULE_PHASES.map((stage, index) => <li key={stage.phase} className={clsx('my-capsule-stage', index === phaseIndex && 'is-current')} aria-current={index === phaseIndex ? 'step' : undefined}>
            {index === phaseIndex ? (stage.phase === 'completed' ? <CircleCheck size={15} aria-hidden="true" /> : <CircleDot size={15} aria-hidden="true" />) : <Circle size={15} aria-hidden="true" />}<span>{stage.label}</span>
          </li>)}</ol>
          <div className="my-capsule-workflow-next"><span title={phaseHint}>{phaseHint}</span>{progress ? <button type="button" className="my-capsule-text-action" aria-expanded={subtasksExpanded} aria-controls="my-capsule-subtasks" onClick={() => setExpandedOwner(subtasksExpanded ? null : owner)}>子任务 {progress.done}/{progress.total} {subtasksExpanded ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}</button> : <button type="button" className="my-capsule-text-action" onClick={() => void openMain()}>查看 <ChevronRight size={12} aria-hidden="true" /></button>}</div>
        </section>
        {progress && subtasksExpanded && <section id="my-capsule-subtasks" className="my-capsule-subtasks" aria-label="子任务">
          <div className="my-capsule-section-header"><h2>子任务</h2><span className="tabular-nums">{progress.done} / {progress.total}</span></div>
          <div className="my-floating-progress-track" role="progressbar" aria-label="子任务完成进度" aria-valuenow={progress.done} aria-valuemin={0} aria-valuemax={progress.total}><span style={{ width: `${progress.done / progress.total * 100}%` }} /></div>
          <div className="mt-2 space-y-1">{current.record?.subtasks?.map((item, index) => {
            const checked = /\[[xX]\]/.test(item)
            return <button key={index} type="button" role="checkbox" aria-checked={checked} disabled={busy || !/\[[ xX]\]/.test(item)} onClick={() => void toggleSubtask(index)} className="my-floating-subtask">
              {checked ? <CheckSquare size={15} className="shrink-0 text-my-success-text" /> : <Square size={15} className="shrink-0 text-my-icon-tertiary" />}
              <span className={clsx('min-w-0 break-words text-left', checked && 'text-my-tertiary line-through')}>{item.replace(/^\s*[-*]?\s*\[[ xX]\]\s*/, '')}</span>
            </button>
          })}</div>
        </section>}
      </> : <div className="my-floating-empty"><ListTodo size={28} className="text-my-icon-tertiary" /><p className="font-medium">{snapshot ? '当前项目暂无任务' : '打开项目后开始工作'}</p><p className="text-my-xs text-my-secondary">任务与主面板保持同步，可随时收起为状态条。</p></div>}
    </div>
    <footer className="no-drag my-floating-footer my-capsule-footer">
      <button type="button" className="my-capsule-footer-action" aria-label="打开当前工程" disabled={!root} onClick={() => root && void run(() => api.openInEditor(root))}><Code2 size={15} aria-hidden="true" /><span>工程</span></button>
      <button type="button" className="my-capsule-footer-action" aria-label="打开任务目录" disabled={!current} onClick={() => current && void run(() => api.revealInExplorer(current.path))}><FolderOpen size={15} aria-hidden="true" /><span>目录</span></button>
      <button type="button" className="my-capsule-footer-action" aria-label="速记" disabled={!root} onClick={() => void run(() => api.showQuickTodo())}><SquarePen size={15} aria-hidden="true" /><span>速记</span></button>
      <button type="button" className="my-capsule-footer-action my-capsule-main-action" aria-label="打开主面板" onClick={() => void openMain()}><PanelsTopLeft size={15} aria-hidden="true" /><span>主面板</span></button>
    </footer>
  </FloatingFrame>
}

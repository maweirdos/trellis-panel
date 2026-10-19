import { useEffect, useRef, useState, type JSX } from 'react'
import { ArrowUpRight, CheckSquare, ChevronLeft, ChevronRight, Code2, Copy, FolderOpen, GitBranch, ListTodo, Maximize2, Minimize2, Pin, PinOff, Square, X } from 'lucide-react'
import { clsx } from 'clsx'
import { useApp } from '../store'
import { api } from '../api'
import { errorMessage } from '../../../shared/errors'
import { PriorityBadge, StatusBadge } from './badges'
import { Button } from '../my/ui'
import { subtaskProgressOf } from '../utils/format2'
import { FloatingFrame, FloatingIconButton, readFloatingPreference, writeFloatingPreference } from './FloatingWindow'

type Shape = 'pill' | 'card'
const SHAPE_KEY = 'trellis:capsuleShape'

function initialShape(): Shape {
  const value = new URLSearchParams(window.location.search).get('shape') ?? readFloatingPreference(SHAPE_KEY)
  return value === 'card' ? 'card' : 'pill'
}

/** The task status bar and task floating window share selection, theme and actions. */
export function CapsuleView(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)
  const [shape, setShape] = useState<Shape>(initialShape)
  const [onTop, setOnTop] = useState(() => new URLSearchParams(window.location.search).get('pinned') !== 'false')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mutationLock = useRef(false)
  const shapeLock = useRef(false)

  useEffect(() => api.onSnapshotUpdated((snap) => useApp.getState().setSnapshot(snap)), [])
  useEffect(() => {
    void api.setCapsuleShape(shape).catch((cause: unknown) => setError(errorMessage(cause)))
    // Window shape is fixed at entry; subsequent changes go through switchShape.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const tasks = snapshot?.tasks ?? []
  const activeTasks = tasks.filter((task) => ['planning', 'in_progress', 'review'].includes(task.record?.status ?? ''))
  const displayTasks = activeTasks.length ? activeTasks : tasks
  const safeIndex = Math.max(0, displayTasks.findIndex((task) => task.dirName === selectedId))
  const current = displayTasks[safeIndex]
  const progress = current ? subtaskProgressOf(current) : null
  const status = current?.record?.status
  const statusTone = status === 'in_progress' ? 'bg-my-warning' : status === 'review' ? 'bg-my-label-purple-strong' : status === 'completed' || status === 'done' ? 'bg-my-success' : 'bg-my-icon-tertiary'

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    try { setError(null); await action() } catch (cause) { setError(errorMessage(cause)) }
  }
  const switchShape = async (next: Shape): Promise<void> => {
    if (shapeLock.current || shape === next) return
    shapeLock.current = true
    try {
      await api.setCapsuleShape(next)
      setShape(next)
      writeFloatingPreference(SHAPE_KEY, next)
    } catch (cause) { setError(errorMessage(cause)) } finally { shapeLock.current = false }
  }
  const selectTask = (direction: number): void => {
    if (!displayTasks.length) return
    setSelectedId(displayTasks[(safeIndex + direction + displayTasks.length) % displayTasks.length].dirName)
    setError(null)
  }
  const toggleOnTop = (): void => {
    void run(async () => { const next = !onTop; await api.setCapsuleOnTop(next); setOnTop(next) })
  }
  const openMain = (): void => api.setCapsuleMode(false)
  const toggleSubtask = async (index: number): Promise<void> => {
    if (!current?.record || mutationLock.current) return
    const subtasks = [...(current.record.subtasks ?? [])]
    const item = subtasks[index]
    if (!item || !/\[[ xX]\]/.test(item)) return
    subtasks[index] = /\[[xX]\]/.test(item) ? item.replace(/\[[xX]\]/, '[ ]') : item.replace(/\[ \]/, '[x]')
    mutationLock.current = true
    setBusy(true)
    await run(async () => {
      const result = await api.updateTask(current.path, { subtasks }, current.taskJsonMtime)
      if (!result.ok) throw new Error(result.error || '子任务更新失败')
      const latest = await api.getSnapshot()
      if (latest) useApp.getState().setSnapshot(latest)
    })
    mutationLock.current = false
    setBusy(false)
  }

  const windowActions = <div className="no-drag flex shrink-0 items-center gap-0.5">
    <FloatingIconButton label={shape === 'pill' ? '展开任务悬浮窗' : '收起为任务状态条'} onClick={() => void switchShape(shape === 'pill' ? 'card' : 'pill')}>{shape === 'pill' ? <Maximize2 size={14} /> : <Minimize2 size={14} />}</FloatingIconButton>
    {shape === 'card' && <FloatingIconButton label={onTop ? '取消置顶' : '置顶窗口'} aria-pressed={onTop} onClick={toggleOnTop}>{onTop ? <Pin size={14} /> : <PinOff size={14} />}</FloatingIconButton>}
    <FloatingIconButton label="打开主面板" onClick={openMain}><ArrowUpRight size={15} /></FloatingIconButton>
    <FloatingIconButton label="隐藏任务悬浮窗" onClick={() => void run(() => api.closeCapsule())}><X size={15} /></FloatingIconButton>
  </div>

  if (shape === 'pill') return <FloatingFrame strip>
    <div className="drag-region my-floating-strip" title={error ?? '拖动可移动任务状态条'}>
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
    <header className="drag-region my-floating-header">
      <ListTodo size={16} className="shrink-0 text-my-icon-secondary" />
      <span className="min-w-0 flex-1 truncate text-my-sm font-medium">任务悬浮窗</span>
      {windowActions}
    </header>
    <div className="my-floating-body my-scrollbar">
      <div className="mb-3 flex items-center gap-2 text-my-xs text-my-secondary">
        <span className="min-w-0 flex-1 truncate" title={snapshot?.meta.root}>{snapshot?.meta.name ?? '未打开项目'}</span>
        {displayTasks.length > 0 && <div className="flex items-center gap-1 tabular-nums">
          <FloatingIconButton label="上一个任务" disabled={displayTasks.length < 2} onClick={() => selectTask(-1)}><ChevronLeft size={14} /></FloatingIconButton>
          <span>{safeIndex + 1} / {displayTasks.length}</span>
          <FloatingIconButton label="下一个任务" disabled={displayTasks.length < 2} onClick={() => selectTask(1)}><ChevronRight size={14} /></FloatingIconButton>
        </div>}
      </div>
      {error && <p role="alert" className="mb-3 rounded-my-md bg-my-danger-subtle p-2 text-my-xs text-my-danger-text">{error}</p>}
      {current ? <>
        <div className="mb-2 flex flex-wrap items-center gap-2"><StatusBadge status={status ?? ''} /><PriorityBadge priority={current.record?.priority ?? ''} /></div>
        <div className="flex items-start gap-2">
          <h1 className="min-w-0 flex-1 select-text break-words text-my-lg font-semibold leading-snug">{current.record?.title ?? current.dirName}</h1>
          <FloatingIconButton label="复制任务信息" onClick={() => void run(async () => {
            await api.copyToClipboard(`${current.dirName} ${current.record?.title ?? ''}`)
            useApp.getState().pushToast({ kind: 'info', title: '已复制任务信息' })
          })}><Copy size={14} /></FloatingIconButton>
        </div>
        <p className="mt-1 truncate text-my-xs text-my-secondary" title={current.dirName}>{current.record?.assignee ?? '未分配'} · {current.dirName}</p>
        {current.record?.branch && <p className="mt-2 flex items-center gap-2 text-my-xs text-my-tertiary"><GitBranch size={13} className="shrink-0" /><span className="truncate font-mono" title={current.record.branch}>{current.record.branch}</span></p>}
        <div className="my-floating-progress">
          <div className="mb-2 flex justify-between text-my-xs"><span className="text-my-secondary">子任务进度</span><span className="tabular-nums">{progress ? `${progress.done} / ${progress.total}` : '暂无子任务'}</span></div>
          {progress && <>
            <div className="my-floating-progress-track" role="progressbar" aria-label="子任务完成进度" aria-valuenow={progress.done} aria-valuemin={0} aria-valuemax={progress.total}><span style={{ width: `${progress.done / progress.total * 100}%` }} /></div>
            <div className="mt-2 space-y-1">{current.record?.subtasks?.map((item, index) => {
              const checked = /\[[xX]\]/.test(item)
              return <button key={index} type="button" role="checkbox" aria-checked={checked} disabled={busy || !/\[[ xX]\]/.test(item)} onClick={() => void toggleSubtask(index)} className="my-floating-subtask">
                {checked ? <CheckSquare size={15} className="shrink-0 text-my-success-text" /> : <Square size={15} className="shrink-0 text-my-icon-tertiary" />}
                <span className={clsx('min-w-0 break-words text-left', checked && 'text-my-tertiary line-through')}>{item.replace(/^\s*[-*]?\s*\[[ xX]\]\s*/, '')}</span>
              </button>
            })}</div>
          </>}
        </div>
      </> : <div className="my-floating-empty"><ListTodo size={28} className="text-my-icon-tertiary" /><p className="font-medium">{snapshot ? '当前项目暂无任务' : '打开项目后开始工作'}</p><p className="text-my-xs text-my-secondary">任务与主面板保持同步，可随时收起为状态条。</p></div>}
    </div>
    <footer className="my-floating-footer">
      <div className="flex items-center gap-1">
        <FloatingIconButton label="在编辑器中打开任务" disabled={!current} onClick={() => current && void run(() => api.openInEditor(current.path))}><Code2 size={16} /></FloatingIconButton>
        <FloatingIconButton label="打开任务目录" disabled={!current} onClick={() => current && void run(() => api.revealInExplorer(current.path))}><FolderOpen size={16} /></FloatingIconButton>
      </div>
      <Button variant="primary" size="sm" onClick={openMain}>打开主面板 <ArrowUpRight size={14} /></Button>
    </footer>
  </FloatingFrame>
}

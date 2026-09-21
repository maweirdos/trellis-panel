import {
  Pin,
  PinOff,
  Maximize2,
  Minimize2,
  X,
  Zap,
  ChevronLeft,
  ChevronRight,
  Square,
  CheckSquare,
  Code2,
  FolderOpen,
  ArrowUpRight,
  Copy,
  Play,
  RotateCcw
} from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { StatusBadge, PriorityBadge } from './badges'
import { subtaskProgressOf } from '../utils/format2'
import { clsx } from 'clsx'
import { useState, useEffect } from 'react'
import type { JSX } from 'react'

/** 获取状态呼吸灯配色与发光效果 */
function getStatusPulse(status?: string): { dot: string; glow: string; label: string } {
  switch (status?.toLowerCase()) {
    case 'in_progress':
      return {
        dot: 'bg-amber-400',
        glow: 'shadow-[0_0_8px_rgba(251,191,36,0.8)] animate-pulse',
        label: '进行中'
      }
    case 'review':
      return {
        dot: 'bg-violet-400',
        glow: 'shadow-[0_0_8px_rgba(167,139,250,0.8)]',
        label: '评审中'
      }
    case 'completed':
    case 'done':
      return {
        dot: 'bg-leaf',
        glow: 'shadow-[0_0_8px_rgba(52,211,153,0.8)]',
        label: '已完成'
      }
    case 'planning':
    default:
      return {
        dot: 'bg-sky-400',
        glow: 'shadow-[0_0_8px_rgba(56,189,248,0.8)]',
        label: '规划中'
      }
  }
}

/** 桌面胶囊：高性能按需挂载，支持药丸条（360x44）与全功能卡片（380x260）形态切换。 */
export function CapsuleView(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)
  const setSnapshot = useApp((s) => s.setSnapshot)
  const pushToast = useApp((s) => s.pushToast)
  const [onTop, setOnTop] = useState(true)

  // 胶囊形态：'pill'（极简药丸条，360x44） | 'card'（便签卡片，380x260）
  const [shape, setShape] = useState<'pill' | 'card'>(() => {
    const urlShape = new URLSearchParams(window.location.search).get('shape') as 'pill' | 'card' | null
    if (urlShape === 'pill' || urlShape === 'card') return urlShape
    const saved = localStorage.getItem('trellis:capsuleShape') as 'pill' | 'card' | null
    return saved === 'pill' || saved === 'card' ? saved : 'pill'
  })

  // 1. 挂载时主动拉取最新快照，并建立实时长效监听，确保卡片数据 100% 实时同步
  useEffect(() => {
    let mounted = true
    void api.getSnapshot().then((snap) => {
      if (mounted && snap) {
        setSnapshot(snap)
      }
    })
    const off = api.onSnapshotUpdated((snap) => {
      if (mounted && snap) {
        setSnapshot(snap)
      }
    })
    return () => {
      mounted = false
      off()
    }
  }, [setSnapshot])

  // 2. 首次挂载时校准一次原生窗口尺寸
  useEffect(() => {
    void api.setCapsuleShape(shape)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 任务集合与索引
  const tasks = snapshot?.tasks ?? []
  const activeTasks = tasks.filter(
    (t) =>
      t.record?.status === 'in_progress' ||
      t.record?.status === 'planning' ||
      t.record?.status === 'review'
  )
  const displayTasks = activeTasks.length > 0 ? activeTasks : tasks
  const [selectedIndex, setSelectedIndex] = useState(0)

  // 确保索引合法
  const safeIndex =
    displayTasks.length > 0 ? Math.min(Math.max(0, selectedIndex), displayTasks.length - 1) : 0
  const current = displayTasks[safeIndex] ?? null
  const inProgressCount = tasks.filter((t) => t.record?.status === 'in_progress').length
  const prog = current ? subtaskProgressOf(current) : null
  const pulse = getStatusPulse(current?.record?.status)

  // 切换形态
  const switchShape = async (next: 'pill' | 'card'): Promise<void> => {
    if (next === shape) return
    setShape(next)
    localStorage.setItem('trellis:capsuleShape', next)
    await api.setCapsuleShape(next)
  }

  const toggleOnTop = (): void => {
    const next = !onTop
    setOnTop(next)
    void api.setCapsuleOnTop(next)
  }

  const expandToMain = (): void => {
    void api.setCapsuleMode(false)
  }

  const closeCapsule = (): void => {
    void api.closeCapsule()
  }

  const prevTask = (): void => {
    if (displayTasks.length <= 1) return
    setSelectedIndex((i) => (i <= 0 ? displayTasks.length - 1 : i - 1))
  }

  const nextTask = (): void => {
    if (displayTasks.length <= 1) return
    setSelectedIndex((i) => (i >= displayTasks.length - 1 ? 0 : i + 1))
  }

  const handleAdvanceStatus = async (): Promise<void> => {
    if (!current?.record) return
    const cur = current.record.status
    let nextStatus = 'in_progress'
    if (cur === 'planning') nextStatus = 'in_progress'
    else if (cur === 'in_progress') nextStatus = 'review'
    else if (cur === 'review') nextStatus = 'completed'
    else nextStatus = 'in_progress'

    const res = await api.updateTask(current.path, { status: nextStatus })
    if (res.ok) {
      pushToast({
        kind: 'success',
        title: '状态已流转',
        body: `${current.record.title} -> ${nextStatus}`
      })
    } else {
      pushToast({ kind: 'error', title: '状态流转失败', body: res.error || '未知错误' })
    }
  }

  const handleOpenEditor = async (): Promise<void> => {
    if (!current?.path) return
    await api.openInEditor(current.path)
  }

  const handleReveal = async (): Promise<void> => {
    if (!current?.path) return
    await api.revealInExplorer(current.path)
  }

  const handleToggleSubtask = async (index: number): Promise<void> => {
    if (!current?.record) return
    const list = [...(current.record.subtasks ?? [])]
    const item = list[index]
    if (!item) return
    const isChecked = /\[[xX]\]/.test(item.trim().replace(/^-\s*/, ''))
    const toggled = isChecked ? item.replace(/\[[xX]\]/, '[ ]') : item.replace(/\[\s*\]/, '[x]')
    list[index] = toggled
    const res = await api.updateTask(current.path, { subtasks: list })
    if (res.ok) {
      pushToast({
        kind: 'success',
        title: isChecked ? '子任务重置' : '子任务已完成',
        body: toggled.replace(/^-\s*\[[xX ]\]\s*/, '')
      })
    } else {
      pushToast({ kind: 'error', title: '子任务更新失败', body: res.error || '未知错误' })
    }
  }

  const handleCopyInfo = async (): Promise<void> => {
    if (!current?.record) return
    await api.copyToClipboard(`${current.dirName} ${current.record.title}`)
    pushToast({ kind: 'info', title: '已复制任务信息', body: current.dirName })
  }

  return (
    <div className="h-full w-full bg-transparent overflow-hidden select-none">
      {shape === 'pill' ? (
        /* ------------------------- 形态 1：药丸条视图（Pill View，360x44） ------------------------- */
        <div
          onDoubleClick={() => switchShape('card')}
          className="drag-region flex h-full w-full items-center justify-between gap-2 rounded-full border border-ink-600 bg-ink-850 px-3 py-1 text-mist-100 shadow-2xl overflow-hidden transition-opacity duration-150"
        >
          {/* 左侧：呼吸指示灯与闪电标识 */}
          <div className="flex shrink-0 items-center gap-1.5">
            <div className={clsx('h-2.5 w-2.5 rounded-full transition-all', pulse.dot, pulse.glow)} />
            <span className="flex items-center text-leaf">
              <Zap size={12} />
            </span>
          </div>

          {/* 中间：任务标题与进度提示 */}
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
            {!snapshot ? (
              <span className="truncate text-xs text-mist-400">未打开项目</span>
            ) : current?.record ? (
              <>
                <span
                  className="truncate text-xs font-medium text-mist-50"
                  title={`${current.dirName}: ${current.record.title}`}
                >
                  {current.record.title}
                </span>
                {prog && (
                  <span className="shrink-0 rounded-full bg-ink-700 px-1.5 py-0.5 font-mono text-[10px] text-leaf-soft">
                    {prog.done}/{prog.total}
                  </span>
                )}
              </>
            ) : (
              <span className="truncate text-xs text-mist-400">暂无活跃任务</span>
            )}
          </div>

          {/* 右侧：快捷操作组 */}
          <div className="no-drag flex shrink-0 items-center gap-0.5">
            {displayTasks.length > 1 && (
              <button
                onClick={nextTask}
                className="btn-ghost px-1.5 py-0.5 font-mono text-[10px] text-mist-300 hover:text-mist-50"
                title={`点击切换下一个任务 (${safeIndex + 1}/${displayTasks.length})`}
              >
                {safeIndex + 1}/{displayTasks.length}
              </button>
            )}
            <button
              onClick={() => switchShape('card')}
              className="btn-ghost p-1 text-mist-300 hover:text-leaf-soft"
              title="展开为便签卡片"
            >
              <Maximize2 size={12} />
            </button>
            <button
              onClick={expandToMain}
              className="btn-ghost p-1 text-mist-300 hover:text-mist-50"
              title="打开完整面板"
            >
              <ArrowUpRight size={13} />
            </button>
            <button
              onClick={closeCapsule}
              className="btn-ghost p-1 text-mist-400 hover:text-rose-400"
              title="关闭胶囊"
            >
              <X size={12} />
            </button>
          </div>
        </div>
      ) : (
        /* ------------------------- 形态 2：便签卡片视图（Card View，380x260） ------------------------- */
        <div className="drag-region flex h-full w-full flex-col justify-between overflow-hidden rounded-2xl border border-ink-600 bg-ink-850 text-mist-100 shadow-2xl transition-opacity duration-150">
          {/* 顶栏 Header */}
          <div className="flex shrink-0 items-center justify-between border-b border-ink-700 bg-ink-800/90 px-3 py-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <div className={clsx('h-2 w-2 rounded-full', pulse.dot, pulse.glow)} />
              <span className="flex items-center gap-1 text-[11px] font-semibold text-leaf-soft">
                <Zap size={12} className="text-leaf" /> 胶囊
              </span>
              {snapshot && (
                <span
                  className="max-w-[120px] truncate text-[10px] text-mist-400"
                  title={snapshot.meta.name}
                >
                  · {snapshot.meta.name}
                </span>
              )}
            </div>

            {/* 任务轮播翻页器 */}
            {displayTasks.length > 1 && (
              <div className="no-drag flex items-center gap-0.5 font-mono text-[10px] text-mist-400">
                <button
                  onClick={prevTask}
                  className="btn-ghost p-0.5 hover:text-mist-50"
                  title="上一条任务"
                >
                  <ChevronLeft size={12} />
                </button>
                <span className="px-1 text-mist-200">
                  {safeIndex + 1}/{displayTasks.length}
                </span>
                <button
                  onClick={nextTask}
                  className="btn-ghost p-0.5 hover:text-mist-50"
                  title="下一条任务"
                >
                  <ChevronRight size={12} />
                </button>
              </div>
            )}

            {/* 顶栏窗口控制按钮组 */}
            <div className="no-drag flex items-center gap-0.5">
              <button
                onClick={() => switchShape('pill')}
                className="btn-ghost p-1 text-mist-300 hover:text-mist-50"
                title="收起为药丸条"
              >
                <Minimize2 size={12} />
              </button>
              <button
                onClick={toggleOnTop}
                className="btn-ghost p-1 text-mist-300 hover:text-mist-50"
                title={onTop ? '取消置顶' : '置顶窗口'}
              >
                {onTop ? <Pin size={12} className="text-leaf" /> : <PinOff size={12} />}
              </button>
              <button
                onClick={expandToMain}
                className="btn-ghost p-1 text-mist-300 hover:text-mist-50"
                title="打开主面板"
              >
                <ArrowUpRight size={12} />
              </button>
              <button
                onClick={closeCapsule}
                className="btn-ghost p-1 text-mist-400 hover:text-rose-400"
                title="关闭胶囊"
              >
                <X size={12} />
              </button>
            </div>
          </div>

          {/* 卡片主体 Body */}
          <div className="flex min-h-0 flex-1 flex-col justify-between overflow-hidden p-3">
            {!snapshot ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                <span className="text-xs text-mist-400">未检测到已打开项目</span>
                <button
                  onClick={expandToMain}
                  className="no-drag btn-outline px-3 py-1 text-xs"
                >
                  打开主面板
                </button>
              </div>
            ) : current?.record ? (
              <div className="flex h-full flex-col justify-between">
                {/* 徽章与基础信息 */}
                <div>
                  <div className="mb-1 flex items-center gap-1.5">
                    <StatusBadge status={current.record.status} />
                    <PriorityBadge priority={current.record.priority} />
                    {current.record.branch && (
                      <span className="chip max-w-[120px] truncate border border-ink-600 bg-ink-800 font-mono text-[10px] text-mist-300">
                        {current.record.branch}
                      </span>
                    )}
                    <span className="ml-auto font-mono text-[10px] text-mist-400">
                      进行中 {inProgressCount}
                    </span>
                  </div>

                  {/* 任务标题与复制 */}
                  <div className="group mt-1 flex items-start justify-between gap-1">
                    <div
                      className="line-clamp-2 text-xs font-semibold leading-snug text-mist-50 select-text"
                      title={current.record.title}
                    >
                      {current.record.title}
                    </div>
                    <button
                      onClick={handleCopyInfo}
                      className="no-drag shrink-0 text-mist-500 opacity-0 transition-opacity group-hover:opacity-100 hover:text-mist-200"
                      title="复制任务信息"
                    >
                      <Copy size={11} />
                    </button>
                  </div>

                  <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-mist-400">
                    <span className="truncate">{current.dirName}</span>
                    {current.record.assignee && (
                      <span className="shrink-0 text-mist-500">· {current.record.assignee}</span>
                    )}
                  </div>
                </div>

                {/* 子任务进度与待办勾选 */}
                <div className="my-1.5 rounded-xl border border-ink-700 bg-ink-800/80 p-2">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-mist-300 font-medium">子任务进度</span>
                    <span className="font-mono text-[10px] text-mist-400">
                      {prog ? `${prog.done}/${prog.total}` : '无子任务'}
                    </span>
                  </div>
                  {prog && (
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-ink-700">
                      <div
                        className="h-full rounded-full bg-leaf-dim transition-all duration-300"
                        style={{ width: `${(prog.done / prog.total) * 100}%` }}
                      />
                    </div>
                  )}

                  {/* 最近未完成的子任务直接勾选打卡 */}
                  {current.record.subtasks && current.record.subtasks.length > 0 && (
                    <div className="no-drag mt-1.5 max-h-[44px] space-y-1 overflow-y-auto">
                      {current.record.subtasks.slice(0, 2).map((item, idx) => {
                        const isDone = /\[[xX]\]/.test(item.trim().replace(/^-\s*/, ''))
                        const text = item.replace(/^-\s*\[[xX ]\]\s*/, '')
                        return (
                          <div
                            key={idx}
                            onClick={() => handleToggleSubtask(idx)}
                            className="flex cursor-pointer items-center gap-1.5 text-[11px] text-mist-300 transition-colors hover:text-mist-100"
                          >
                            {isDone ? (
                              <CheckSquare size={12} className="shrink-0 text-leaf" />
                            ) : (
                              <Square size={12} className="shrink-0 text-mist-500" />
                            )}
                            <span className={clsx('truncate', isDone && 'line-through text-mist-500')}>
                              {text}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>

                {/* 底部快捷操作栏 Footer */}
                <div className="no-drag mt-auto flex items-center gap-1.5 pt-2 border-t border-ink-700/80">
                  {/* 快捷推进状态按钮 */}
                  <button
                    onClick={handleAdvanceStatus}
                    className="btn-outline flex items-center gap-1 px-2 py-1 text-[11px]"
                    title="推进任务到下一阶段"
                  >
                    {current.record.status === 'planning' ? (
                      <>
                        <Play size={10} className="text-leaf" /> 开始进行
                      </>
                    ) : current.record.status === 'in_progress' ? (
                      <>
                        <ArrowUpRight size={10} className="text-violet-400" /> 提评审
                      </>
                    ) : (
                      <>
                        <RotateCcw size={10} /> 状态流转
                      </>
                    )}
                  </button>

                  {/* 在编辑器中打开 */}
                  <button
                    onClick={handleOpenEditor}
                    className="btn-ghost p-1 text-mist-400 hover:text-mist-100"
                    title="在 VS Code / 编辑器中定位"
                  >
                    <Code2 size={13} />
                  </button>

                  {/* 在文件资源管理器中打开 */}
                  <button
                    onClick={handleReveal}
                    className="btn-ghost p-1 text-mist-400 hover:text-mist-100"
                    title="在文件资源管理器中打开目录"
                  >
                    <FolderOpen size={13} />
                  </button>

                  {/* 打开主面板大按钮 */}
                  <button
                    onClick={expandToMain}
                    className="btn-primary ml-auto flex-1 justify-center py-1 text-xs font-medium"
                  >
                    打开面板
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                <span className="text-xs text-mist-400">暂无活跃任务</span>
                <button
                  onClick={expandToMain}
                  className="no-drag btn-outline px-3 py-1 text-xs"
                >
                  前往主面板创建
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

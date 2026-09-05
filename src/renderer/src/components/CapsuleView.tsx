import { Pin, PinOff, Maximize2, X, Zap } from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { StatusBadge, PriorityBadge } from './badges'
import { subtaskProgressOf } from '../utils/format2'
import { clsx } from 'clsx'
import { useState } from 'react'
import type { JSX } from 'react'

/** 胶囊模式：置顶小卡片，显示当前任务 + 快捷操作，与主窗口共享同一快照。 */
export function CapsuleView(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)
  const settings = useApp((s) => s.settings)
  const pushToast = useApp((s) => s.pushToast)
  const [onTop, setOnTop] = useState(true)
  const [busy, setBusy] = useState(false)

  const tasks = snapshot?.tasks ?? []
  const current =
    tasks.find((t) => t.dirName === snapshot?.meta.currentTask) ??
    tasks.find((t) => t.record?.status === 'in_progress') ??
    tasks.find((t) => t.record?.status === 'planning')
  const inProgress = tasks.filter((t) => t.record?.status === 'in_progress').length
  const prog = current ? subtaskProgressOf(current) : null

  const toggleOnTop = (): void => {
    const next = !onTop
    setOnTop(next)
    void api.setCapsuleOnTop(next)
  }

  const expand = (): void => {
    void api.setCapsuleMode(false)
  }

  const handOff = async (app: 'codex' | 'zcode'): Promise<void> => {
    setBusy(true)
    const res = await api.launchAiApp(app, current?.dirName ?? null)
    setBusy(false)
    pushToast(
      res.ok
        ? { kind: 'success', title: `${app} 已在终端启动`, body: current?.record?.title }
        : { kind: 'error', title: `${app} 调起失败`, body: res.error }
    )
  }

  return (
    <div className="drag-region flex h-full flex-col overflow-hidden rounded-xl border border-ink-600 bg-ink-850 shadow-2xl">
      {/* header */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-ink-700 bg-ink-800/80 px-3 py-1.5">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-leaf-soft">
          <Zap size={11} /> Trellis 胶囊
        </span>
        {snapshot && (
          <span className="max-w-[100px] truncate text-[10px] text-mist-500">{snapshot.meta.name}</span>
        )}
        <div className="ml-auto flex items-center gap-0.5 no-drag">
          <button onClick={toggleOnTop} className="btn-ghost px-1.5 py-1" title={onTop ? '取消置顶' : '窗口置顶'}>
            {onTop ? <Pin size={11} className="text-leaf" /> : <PinOff size={11} />}
          </button>
          <button onClick={expand} className="btn-ghost px-1.5 py-1" title="展开主窗口">
            <Maximize2 size={11} />
          </button>
          <button onClick={expand} className="btn-ghost px-1.5 py-1" title="关闭胶囊">
            <X size={11} />
          </button>
        </div>
      </div>

      {/* body */}
      <div className="min-h-0 flex-1 overflow-hidden px-3 py-2.5">
        {!snapshot ? (
          <div className="grid h-full place-items-center text-[11px] text-mist-500">
            主窗口未打开项目
          </div>
        ) : current?.record ? (
          <div className="flex h-full flex-col">
            <div className="mb-1.5 flex items-center gap-1.5">
              <StatusBadge status={current.record.status} />
              <PriorityBadge priority={current.record.priority} />
              <span className="ml-auto font-mono text-[10px] text-mist-500">
                进行中 {inProgress}
              </span>
            </div>
            <div className="line-clamp-2 text-xs font-medium leading-5 text-mist-50" title={current.record.title}>
              {current.record.title}
            </div>
            <div className="mt-0.5 font-mono text-[10px] text-mist-500">
              {current.dirName}
              {current.record.assignee ? ` · ${current.record.assignee}` : ''}
            </div>
            {prog && (
              <div className="mt-2 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-700">
                  <div
                    className="h-full rounded-full bg-leaf-dim"
                    style={{ width: `${(prog.done / prog.total) * 100}%` }}
                  />
                </div>
                <span className="font-mono text-[10px] text-mist-400">
                  {prog.done}/{prog.total}
                </span>
              </div>
            )}
            <div className="mt-auto flex items-center gap-1.5 pt-2">
              <button disabled={busy} onClick={() => void handOff('codex')} className="btn-outline flex-1 justify-center px-1 py-1 disabled:opacity-50">
                Codex
              </button>
              <button disabled={busy} onClick={() => void handOff('zcode')} className="btn-outline flex-1 justify-center px-1 py-1 disabled:opacity-50">
                ZCode
              </button>
              <button
                onClick={expand}
                className={clsx('btn-primary flex-1 justify-center px-1 py-1')}
              >
                打开面板
              </button>
            </div>
          </div>
        ) : (
          <div className="grid h-full place-items-center text-[11px] text-mist-500">
            没有进行中的任务
          </div>
        )}
      </div>
    </div>
  )
}

import { useEffect, useRef, useState, type JSX } from 'react'
import { useApp } from '../store'
import type { ToastItem } from '../store/types'
import { NotificationCard } from '../my/NotificationCard'
import { projectRootKey } from '../my/navigation'
import { MOTION_TOAST_EXIT_MS, prefersReducedMotion } from '../my/motion'

interface RenderedToast {
  item: ToastItem
  closing: boolean
}

function Toast({ toast, hidden, closing }: { toast: ToastItem; hidden: boolean; closing: boolean }): JSX.Element {
  const dismiss = useApp((s) => s.dismissToast)
  const root = useApp((s) => s.snapshot?.meta.root)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const paused = hidden || hovered || focused || expanded || closing
  const durationMs = toast.durationMs ?? (toast.kind === 'error' || toast.kind === 'warn' ? 9000 : 5000)
  const task = toast.task
  const canOpenTask = Boolean(task && projectRootKey(task.projectRoot) === projectRootKey(root))

  useEffect(() => {
    if (paused) return
    const timer = setTimeout(() => dismiss(toast.id), durationMs)
    return () => clearTimeout(timer)
  }, [dismiss, toast.id, durationMs, paused])

  const openTask = (): void => {
    const state = useApp.getState()
    if (!task || projectRootKey(task.projectRoot) !== projectRootKey(state.snapshot?.meta.root)) return
    const archived = state.snapshot?.archived.some((item) => item.dirName === task.dirName) ?? false
    const known = archived || state.snapshot?.tasks.some((item) => item.dirName === task.dirName)
    if (!known) {
      dismiss(toast.id)
      state.pushToast({ kind: 'warn', title: '该任务已不可用', body: '任务可能已被移动或删除。' })
      return
    }
    state.showTask(task.dirName, archived)
    dismiss(toast.id)
  }

  const runAction = (): void => {
    const fn = toast.action?.onClick
    dismiss(toast.id)
    fn?.()
  }

  return (
    <div className="my-toast-slot" data-state={closing ? 'closing' : 'open'}>
      <div className="my-toast-slot-inner">
        <div
          className="my-toast"
          data-state={closing ? 'closing' : 'open'}
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
          onFocusCapture={() => setFocused(true)}
          onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}
        >
          <NotificationCard
            notification={toast}
            onDismiss={() => dismiss(toast.id)}
            onExpandedChange={setExpanded}
            durationMs={durationMs}
            paused={paused}
            action={toast.action ? { label: toast.action.label, onClick: runAction } : canOpenTask ? { label: '查看任务', onClick: openTask } : undefined}
          />
        </div>
      </div>
    </div>
  )
}

/** One bounded, themed stack shared by the main window and floating utilities. */
export function Toasts(): JSX.Element {
  const toasts = useApp((s) => s.toasts)
  const [hidden, setHidden] = useState(document.hidden)
  const [rendered, setRendered] = useState<RenderedToast[]>(() => toasts.map((item) => ({ item, closing: false })))
  const timersRef = useRef<Map<ToastItem['id'], number>>(new Map())

  useEffect(() => {
    const onVisibility = (): void => setHidden(document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  useEffect(() => {
    const activeIds = new Set(toasts.map((t) => t.id))
    const reduced = prefersReducedMotion()

    setRendered((prev) => {
      const next: RenderedToast[] = []
      const seen = new Set<ToastItem['id']>()
      for (const entry of prev) {
        const live = toasts.find((t) => t.id === entry.item.id)
        if (live) {
          const pendingTimer = timersRef.current.get(live.id)
          if (pendingTimer !== undefined) {
            window.clearTimeout(pendingTimer)
            timersRef.current.delete(live.id)
          }
          next.push({ item: live, closing: false })
          seen.add(live.id)
        } else if (!reduced) {
          next.push({ item: entry.item, closing: true })
          seen.add(entry.item.id)
          if (!timersRef.current.has(entry.item.id)) {
            const id = entry.item.id
            const timer = window.setTimeout(() => {
              timersRef.current.delete(id)
              setRendered((list) => list.filter((x) => x.item.id !== id))
            }, MOTION_TOAST_EXIT_MS)
            timersRef.current.set(id, timer)
          }
        }
      }
      for (const item of toasts) {
        if (!seen.has(item.id)) next.push({ item, closing: false })
      }
      return next
    })

    // 清理不再存在的计时器（若在 reduced 模式下）
    if (reduced) {
      for (const [id, timer] of timersRef.current) {
        if (!activeIds.has(id)) {
          window.clearTimeout(timer)
          timersRef.current.delete(id)
        }
      }
    }
  }, [toasts])

  useEffect(() => () => {
    for (const timer of timersRef.current.values()) window.clearTimeout(timer)
    timersRef.current.clear()
  }, [])

  return <section className="my-notification-stack" aria-label="通知">
    {rendered.map(({ item, closing }) => <Toast key={item.id} toast={item} hidden={hidden} closing={closing} />)}
  </section>
}

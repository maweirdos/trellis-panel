import { useEffect, useState, type JSX } from 'react'
import { useApp } from '../store'
import type { ToastItem } from '../store/types'
import { NotificationCard } from '../my/NotificationCard'
import { projectRootKey } from '../my/navigation'

function Toast({ toast, hidden }: { toast: ToastItem; hidden: boolean }): JSX.Element {
  const dismiss = useApp((s) => s.dismissToast)
  const root = useApp((s) => s.snapshot?.meta.root)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const paused = hidden || hovered || focused || expanded
  const task = toast.task
  const canOpenTask = Boolean(task && projectRootKey(task.projectRoot) === projectRootKey(root))

  useEffect(() => {
    if (paused) return
    const timer = setTimeout(() => dismiss(toast.id), toast.kind === 'error' || toast.kind === 'warn' ? 9000 : 5000)
    return () => clearTimeout(timer)
  }, [dismiss, toast.id, toast.kind, paused])

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

  return <div
    className="my-toast"
    onPointerEnter={() => setHovered(true)}
    onPointerLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)}
    onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}
  >
    <NotificationCard notification={toast} onDismiss={() => dismiss(toast.id)} onExpandedChange={setExpanded}
      action={canOpenTask ? { label: '查看任务', onClick: openTask } : undefined} />
  </div>
}

/** One bounded, themed stack shared by the main window and floating utilities. */
export function Toasts(): JSX.Element {
  const toasts = useApp((s) => s.toasts)
  const [hidden, setHidden] = useState(document.hidden)
  useEffect(() => {
    const onVisibility = (): void => setHidden(document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])
  return <section className="my-notification-stack" aria-label="通知">
    {toasts.map((toast) => <Toast key={toast.id} toast={toast} hidden={hidden} />)}
  </section>
}

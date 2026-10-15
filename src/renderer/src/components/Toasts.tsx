import { CheckCircle2, AlertTriangle, Info, XCircle, X } from 'lucide-react'
import { useApp } from '../store'
import { clsx } from 'clsx'
import type { JSX } from 'react'

const STYLE: Record<string, { icon: JSX.Element; cls: string }> = {
  success: { icon: <CheckCircle2 size={15} className="text-my-success-text" />, cls: 'border-my-line-success' },
  info: { icon: <Info size={15} className="text-my-info-text" />, cls: 'border-my-line-info' },
  warn: { icon: <AlertTriangle size={15} className="text-my-warning-text" />, cls: 'border-my-line-warning' },
  error: { icon: <XCircle size={15} className="text-my-danger-text" />, cls: 'border-my-line-danger' }
}

/** 右下角通知堆栈：AI 桥接事件、保存结果、Jira 同步等都走这里。 */
export function Toasts(): JSX.Element | null {
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismissToast)
  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 flex-col gap-2">
      {toasts.map((t) => {
        const st = STYLE[t.kind] ?? STYLE.info
        return (
          <div
            key={t.id}
            className={clsx(
              'toast-enter pointer-events-auto flex items-start gap-2.5 rounded-my-xl border bg-my-layer-2 px-3.5 py-2.5 shadow-[var(--my-shadow-overlay-200)] backdrop-blur',
              st.cls
            )}
          >
            <span className="mt-0.5 shrink-0">{st.icon}</span>
            <div className="min-w-0 flex-1">
              <div className="text-my-xs font-medium text-my-primary">{t.title}</div>
              {t.body && <div className="mt-0.5 break-words text-my-xs leading-4 text-my-secondary">{t.body}</div>}
            </div>
            <button onClick={() => dismiss(t.id)} className="shrink-0 text-my-icon-tertiary hover:text-my-primary">
              <X size={12} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

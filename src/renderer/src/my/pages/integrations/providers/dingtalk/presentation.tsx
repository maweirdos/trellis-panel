import type { JSX, ReactNode } from 'react'
import { X } from 'lucide-react'
import { Button, Modal } from '../../../../ui'
import { IntegrationProductIcon } from '../../IntegrationProductIcon'

/** Keep provider dialogs inside the shared themed, scoped Modal. */
export function DingTalkDialog({ title, subtitle, open = true, busy = false, onClose, children, footer }: { title: string; subtitle?: string; open?: boolean; busy?: boolean; onClose(): void; children: ReactNode; footer?: ReactNode }): JSX.Element {
  return <Modal open={open} ariaLabel={title} onClose={onClose}>
    <div className="flex max-h-[var(--my-modal-max-height)] flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-my-line px-5 py-4">
        <IntegrationProductIcon provider="dingtalk" />
        <div className="min-w-0 flex-1"><h2 className="text-my-lg font-semibold">{title}</h2>{subtitle && <p className="my-item-description mt-1">{subtitle}</p>}</div>
        <Button variant="ghost" size="sm" disabled={busy} aria-label={`关闭${title}`} onClick={onClose}><X size={16} /></Button>
      </header>
      <div className="my-scrollbar min-h-0 space-y-4 overflow-y-auto px-5 py-4">{children}</div>
      {busy && <p role="status" className="sr-only">正在处理，请稍候。</p>}
      {footer && <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-my-line px-5 py-3">{footer}</footer>}
    </div>
  </Modal>
}

export function DingTalkRow({ title, detail, children }: { title: string; detail: string; children: ReactNode }): JSX.Element {
  return <div className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
    <div className="min-w-0 flex-1"><h4 className="my-item-title">{title}</h4><p className="my-item-description mt-1 break-words">{detail}</p></div>
    <div className="flex flex-wrap items-center gap-2">{children}</div>
  </div>
}

export function DingTalkDetails({ children, label = '查看详情' }: { children: ReactNode; label?: string }): JSX.Element {
  return <details className="text-my-xs text-my-tertiary"><summary className="cursor-pointer rounded-my-md py-1 focus-visible:[outline:var(--my-focus-width)_solid_var(--my-focus-ring)] focus-visible:outline-offset-2">{label}</summary><div className="mt-2 space-y-2 break-words">{children}</div></details>
}

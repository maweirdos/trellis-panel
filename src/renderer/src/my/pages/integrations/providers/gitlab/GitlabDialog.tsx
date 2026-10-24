import type { JSX, ReactNode } from 'react'
import { LoaderCircle, X } from 'lucide-react'
import { Button, Modal } from '../../../../ui'
import { IntegrationProductIcon } from '../../IntegrationProductIcon'
import './gitlab.css'

/** Keep provider dialogs inside the shared theme, focus and interaction owner. */
export function GitlabDialog({ title, subtitle, busy, error, close, children, drawer = false }: {
  title: string
  subtitle?: string
  busy: boolean
  error: string | null
  close: () => void
  children: ReactNode
  drawer?: boolean
}): JSX.Element {
  return <Modal open onClose={close} ariaLabel={title} width={drawer ? 'var(--my-integration-drawer-width, var(--my-modal-width))' : 640}>
    <div className={drawer ? 'gitlab-detail-drawer flex h-full min-h-0 flex-col' : undefined}>
    <div className="flex items-center gap-3 border-b border-my-line p-5">
      <IntegrationProductIcon provider="gitlab" />
      <div className="min-w-0 flex-1"><h3 className="font-medium">{title}</h3>{subtitle && <p className="mt-1 break-words text-my-xs text-my-tertiary">{subtitle}</p>}</div>
      <Button size="sm" variant="ghost" aria-label="关闭弹窗" onClick={close}><X size={16} /></Button>
    </div>
    <div className={`${drawer ? 'min-h-0 flex-1' : 'max-h-[65vh]'} space-y-5 overflow-y-auto p-5 my-scrollbar`} style={{ scrollbarGutter: 'stable' }}>
      {busy && <p role="status" className="flex items-center gap-2 text-my-xs text-my-secondary"><LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" />正在处理…</p>}
      {error && <p role="alert" className="break-words text-my-sm text-my-danger-text">{error}</p>}
      {children}
    </div>
    </div>
  </Modal>
}

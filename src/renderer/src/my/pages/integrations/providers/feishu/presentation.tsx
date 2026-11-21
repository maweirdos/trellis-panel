import { X } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import type { FeishuConnection } from '@shared/feishu-integration'
import { FeedbackNotice, normalizeFeedbackDiagnostic } from '../../../../FeedbackNotice'
import { Button, Modal } from '../../../../ui'
import { IntegrationProductIcon } from '../../IntegrationProductIcon'

const connectionStates: Record<FeishuConnection['state'], string> = {
  verified: '应用已验证 · 未开始接收',
  connecting: '正在连接',
  connected: '接收中',
  blocked: '接收不可用',
  failed: '连接失败',
  stopped: '已停止接收'
}

export function feishuConnectionStatus(connection: FeishuConnection): string {
  if (connection.state === 'connected' && connection.kind === 'organization') return '长连接已接通'
  if (connection.state === 'connected' && connection.kind === 'assistant' && !connection.allowedChatIds.length) {
    return '待添加群聊'
  }
  if (connection.state === 'connected' && connection.kind === 'agent' && !connection.allowedChatIds.length) {
    return '接收私聊'
  }
  return connectionStates[connection.state]
}

export function FeishuDialog({ title, subtitle, onClose, children, footer }: {
  title: string
  subtitle?: string
  onClose: () => void
  children: ReactNode
  footer: ReactNode
}): JSX.Element {
  return <Modal open ariaLabel={title} width={448} onClose={onClose}>
    <div className="flex max-h-[var(--my-modal-max-height)] flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-my-line px-5 py-4">
        <IntegrationProductIcon provider="feishu" />
        <div className="min-w-0 flex-1">
          <h2 className="text-my-lg font-semibold">{title}</h2>
          {subtitle && <p className="my-item-description mt-1 break-words">{subtitle}</p>}
        </div>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label={`关闭${title}`}>
          <X size={16} aria-hidden="true" />
        </Button>
      </header>
      <div className="my-scrollbar min-h-0 space-y-4 overflow-y-auto px-5 py-4">{children}</div>
      <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-my-line px-5 py-3">{footer}</footer>
    </div>
  </Modal>
}

export function FeishuError({ title, message, actions }: {
  title: string
  message: string
  actions?: ReactNode
}): JSX.Element | null {
  if (!message) return null
  const diagnostic = normalizeFeedbackDiagnostic(message)
  const disclosure = diagnostic.length > 240 || diagnostic.includes('\n')
  return <FeedbackNotice variant="inline" tone="error" title={title}
    description={disclosure ? undefined : diagnostic} diagnostic={disclosure ? diagnostic : undefined} actions={actions} />
}

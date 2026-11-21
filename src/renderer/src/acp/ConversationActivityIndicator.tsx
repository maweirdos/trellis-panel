import type { JSX } from 'react'
import { clsx } from 'clsx'
import { AgentActivityMark } from './AgentActivityMark'

export interface ConversationActivityIndicatorProps {
  className?: string
  label?: string
}

export function ConversationActivityIndicator({ className, label = '会话正在进行' }: ConversationActivityIndicatorProps): JSX.Element {
  return (
    <span className={clsx('acp-session-indicator', className)} role="status" aria-label={label} title={label}>
      <AgentActivityMark size={16} />
    </span>
  )
}

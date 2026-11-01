import type { JSX, ReactNode } from 'react'
import { clsx } from 'clsx'

/** A recorded result and its real follow-up action, without implying approval. */
export function ActivityResult({ icon, title, description, action, tone = 'default' }: {
  icon: ReactNode
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  tone?: 'default' | 'danger' | 'warning'
}): JSX.Element {
  return <div className={clsx('my-result-card', tone !== 'default' && `is-${tone}`)}>
    <span className="my-result-icon" aria-hidden="true">{icon}</span>
    <div className="my-result-content"><div className="my-result-title my-item-title">{title}</div>{description && <div className="my-result-description my-item-description">{description}</div>}</div>
    {action && <div className="my-result-action">{action}</div>}
  </div>
}

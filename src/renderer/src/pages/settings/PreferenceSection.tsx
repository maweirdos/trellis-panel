import type { JSX, ReactNode } from 'react'
import './preferences.css'

export function PreferenceSection({ id, title, children, action }: {
  id: string
  title: string
  children: ReactNode
  action?: ReactNode
}): JSX.Element {
  return <section id={id} className="preference-section" aria-labelledby={`${id}-title`}>
    <header className="preference-section-heading">
      <h2 id={`${id}-title`}>{title}</h2>
      {action}
    </header>
    <div className="preference-section-body">{children}</div>
  </section>
}

export function PreferenceRow({ label, children, htmlFor, hint, detail }: {
  label: string
  children: ReactNode
  htmlFor?: string
  hint?: ReactNode
  detail?: ReactNode
}): JSX.Element {
  return <div className="preference-row">
    <div className="preference-row-label">
      {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
      {hint && <p className="mt-1 text-my-xs text-my-tertiary">{hint}</p>}
    </div>
    <div className="preference-row-control">{children}</div>
    {detail && <div className="preference-row-detail">{detail}</div>}
  </div>
}

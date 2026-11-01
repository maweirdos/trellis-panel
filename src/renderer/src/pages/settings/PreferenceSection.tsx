import { Children, cloneElement, isValidElement, useId, type JSX, type ReactNode } from 'react'
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
      {action && <div className="preference-section-action">{action}</div>}
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
  const rowId = useId()
  const labelId = `${rowId}-label`
  const hintId = hint ? `${rowId}-hint` : undefined
  return <div className="preference-row" role="group" aria-labelledby={labelId} aria-describedby={hintId}>
    <div className="preference-row-label">
      {htmlFor ? <label id={labelId} htmlFor={htmlFor}>{label}</label> : <span id={labelId}>{label}</span>}
      {hint && <p id={hintId} className="preference-row-hint">{hint}</p>}
    </div>
    <div className="preference-row-control">{Children.map(children, (child) => {
      if (!hintId || !isValidElement<{ id?: string; 'aria-describedby'?: string; role?: string }>(child) || typeof child.type !== 'string') return child
      if ((!htmlFor || child.props.id !== htmlFor) && child.props.role !== 'group') return child
      return cloneElement(child, { 'aria-describedby': [child.props['aria-describedby'], hintId].filter(Boolean).join(' ') })
    })}</div>
    {detail && <div className="preference-row-detail">{detail}</div>}
  </div>
}

import type { ComponentProps, ReactNode } from 'react'
import { clsx } from 'clsx'

type RowContent = {
  icon?: ReactNode
  label: ReactNode
  wrapLabel?: boolean
}

type LineProps = Omit<ComponentProps<'div'>, 'className' | 'style' | 'children'>

function WorkLogLine({ icon, label, wrapLabel }: RowContent) {
  return (
    <div className="conversation-work-line">
      <div className={clsx('conversation-work-label', wrapLabel && 'conversation-work-label-wrap')}>
        {icon ? (
          <span className="conversation-work-icon">
            <span>{icon}</span>
          </span>
        ) : null}
        <div className="conversation-work-text">{label}</div>
      </div>
    </div>
  )
}

export function WorkLogRow({ icon, label, wrapLabel = false, ...rowProps }: RowContent & LineProps) {
  return (
    <div {...rowProps} className="conversation-work-row">
      <WorkLogLine icon={icon} label={label} wrapLabel={wrapLabel} />
    </div>
  )
}

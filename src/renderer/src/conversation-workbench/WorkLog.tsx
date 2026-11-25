import { useId, type ComponentProps, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
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

export function WorkLogDisclosure({ label, open, onOpenChange, children }: {
  readonly label: string
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly children: ReactNode
}) {
  const entriesId = useId()
  return (
    <div className="conversation-work-fold">
      <button type="button" className="conversation-work-fold-toggle" aria-expanded={open}
        aria-controls={entriesId} onClick={() => onOpenChange(!open)}>
        {label}
        <ChevronRight size={14} aria-hidden="true" />
      </button>
      <div id={entriesId} className="conversation-work-fold-entries" hidden={!open}>
        {open && children}
      </div>
    </div>
  )
}

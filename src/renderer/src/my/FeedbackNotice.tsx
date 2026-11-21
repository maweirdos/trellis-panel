import { useId, useState, type JSX, type ReactNode } from 'react'
import { Check, ChevronRight, CircleAlert, Copy, Loader2, TriangleAlert } from 'lucide-react'
import { clsx } from 'clsx'
import { Button } from './ui'
import { useCopyFeedback } from '../utils/use-copy-feedback'

const MAX_DIAGNOSTIC_LENGTH = 32_768
const REDACTED = '[已脱敏]'

export type FeedbackTone = 'error' | 'warning'

export function normalizeFeedbackDiagnostic(value: string): string {
  const sanitized = value
    .replace(/(\bhttps?:\/\/)[^/\s:@]+:[^/@\s]+@/gi, `$1${REDACTED}@`)
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{12,}\b/g, REDACTED)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/^(\s*(?:set-cookie|cookie):\s*)[^\r\n]+/gim, `$1${REDACTED}`)
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|token)(["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|[^\s,;&}\]\n]+)/gi,
      (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`)
  return sanitized.length > MAX_DIAGNOSTIC_LENGTH
    ? `${sanitized.slice(0, MAX_DIAGNOSTIC_LENGTH)}\n\n诊断过长，已截断。`
    : sanitized
}

export function FeedbackNotice({ title, description, diagnostic, details, actions, tone = 'error', variant = 'card', announcement = true }: {
  title: ReactNode
  description?: ReactNode
  diagnostic?: string
  details?: ReactNode
  actions?: ReactNode
  tone?: FeedbackTone
  variant?: 'compact' | 'card' | 'inline'
  announcement?: boolean
}): JSX.Element {
  const titleId = useId()
  const detailsId = `${titleId}-details`
  const [expanded, setExpanded] = useState(false)
  const normalizedDiagnostic = diagnostic === undefined ? undefined : normalizeFeedbackDiagnostic(diagnostic)
  const copy = useCopyFeedback(normalizedDiagnostic ?? '')
  const Icon = tone === 'warning' ? TriangleAlert : CircleAlert
  const hasDetails = Boolean(normalizedDiagnostic?.trim())
  const hasInlineDetails = hasDetails || Boolean(details)
  const titleNode = <span id={titleId} className="my-feedback-title my-item-title">{title}</span>
  const copyButton = hasDetails ? <button type="button" className="my-feedback-action" disabled={copy.status === 'copying'} onClick={() => void copy.copy(normalizedDiagnostic ?? '')}>
    {copy.status === 'copying' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : copy.status === 'copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    {copy.status === 'copied' ? '已复制' : '复制详情'}
  </button> : null

  if (variant === 'inline') {
    return <article className={clsx('my-feedback', `is-${tone}`, 'is-inline')} aria-labelledby={hasInlineDetails ? titleId : undefined}>
      {announcement && <span className="sr-only" role="alert">{title}</span>}
      {hasInlineDetails
        ? <button type="button" className="my-feedback-inline-toggle" aria-labelledby={titleId} aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(value => !value)}>
          <span className="my-feedback-icon" aria-hidden="true"><Icon /></span>
          {titleNode}
          <ChevronRight size={12} className={clsx('my-feedback-chevron', expanded && 'is-open')} aria-hidden="true" />
        </button>
        : <span className="my-feedback-inline-static">
          <span className="my-feedback-icon" aria-hidden="true"><Icon /></span>
          {titleNode}
        </span>}
      {description && <div className="my-feedback-description my-item-description">{description}</div>}
      {actions && <div className="my-feedback-actions">{actions}</div>}
      {hasInlineDetails && <div id={detailsId} className="my-feedback-inline-details" hidden={!expanded}>
        {expanded && <>
          <div className="my-feedback-details my-scrollbar" role="region" aria-label={hasDetails ? '错误详情' : '详情'} tabIndex={0}>
            {details}
            {hasDetails && <pre>{normalizedDiagnostic}</pre>}
          </div>
          {copyButton}
          {copy.status === 'error' && <p className="my-feedback-copy-error">复制失败，请选择文字后复制。</p>}
        </>}
      </div>}
    </article>
  }

  return <article className={clsx('my-feedback', `is-${tone}`, `is-${variant}`)} aria-labelledby={titleId}>
    <span className="my-feedback-icon" aria-hidden="true"><Icon /></span>
    <div className="my-feedback-content">
      <div role={announcement ? 'alert' : undefined}>{titleNode}</div>
      {description && <div className="my-feedback-description my-item-description">{description}</div>}
      {(hasDetails || actions) && <div className="my-feedback-actions">
        {actions}
        {hasDetails && <button type="button" className="my-feedback-action" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded((value) => !value)}>
          <ChevronRight size={14} className={clsx('my-feedback-chevron', expanded && 'is-open')} aria-hidden="true" />
          {expanded ? '收起详情' : '查看详情'}
        </button>}
        {copyButton}
      </div>}
      {hasDetails && <div id={detailsId} className="my-feedback-details my-scrollbar" role="region" aria-label="错误详情" hidden={!expanded} tabIndex={expanded ? 0 : undefined}>
        <pre>{normalizedDiagnostic}</pre>
      </div>}
      {copy.status === 'error' && <p className="my-feedback-copy-error">复制失败，请选择文字后复制。</p>}
    </div>
  </article>
}

export function FeedbackAction({ children, onClick, variant = 'ghost' }: {
  children: ReactNode
  onClick: () => void
  variant?: 'ghost' | 'outline' | 'primary'
}): JSX.Element {
  return <Button size="sm" variant={variant} className="my-feedback-button" onClick={onClick}>{children}</Button>
}

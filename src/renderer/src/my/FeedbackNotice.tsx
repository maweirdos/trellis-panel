import { useEffect, useId, useRef, useState, type JSX, type ReactNode } from 'react'
import { Check, ChevronRight, CircleAlert, Copy, Loader2, TriangleAlert } from 'lucide-react'
import { clsx } from 'clsx'
import { Button } from './ui'
import { useCopyFeedback } from '../utils/use-copy-feedback'

const MAX_DIAGNOSTIC_LENGTH = 32_768
const REDACTED = '[已脱敏]'

export type FeedbackTone = 'error' | 'warning'
export type FeedbackVariant = 'compact' | 'card' | 'inline' | 'bar' | 'bar-compact'

const DAEMON_OUTDATED_PATTERN = /daemon build is outdated|unverified|--trellis-role=control|daemon.*outdated/i

const FRIENDLY_ERROR_RULES: ReadonlyArray<{ readonly pattern: RegExp; readonly summary: string }> = [
  {
    pattern: DAEMON_OUTDATED_PATTERN,
    summary: '后台服务版本与当前应用不一致，请先停止旧后台服务后重试。',
  },
  {
    pattern: /daemon bundle changed during owner startup|output changed during build verification/i,
    summary: '后台服务正在更新中，请等待构建完成后重试。',
  },
  {
    pattern: /daemon ownership changed/i,
    summary: '后台服务连接已切换，请重新读取。',
  },
  {
    pattern: /conversation admission is closed|conversation kernel is shutting down/i,
    summary: '会话服务正在重启或关闭，请稍后重试。',
  },
]

export function isDaemonOutdatedError(value: string | undefined): boolean {
  return Boolean(value && DAEMON_OUTDATED_PATTERN.test(value))
}

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

export function summarizeFeedbackMessage(value: string | undefined): { readonly summary?: string; readonly diagnostic?: string } {
  if (!value) return {}
  const normalized = normalizeFeedbackDiagnostic(value).trim()
  if (!normalized) return {}
  for (const rule of FRIENDLY_ERROR_RULES) {
    if (rule.pattern.test(normalized)) {
      return { summary: rule.summary, diagnostic: normalized }
    }
  }
  const firstLine = normalized.split('\n')[0]?.trim() ?? ''
  const summary = firstLine.slice(0, 240)
  return {
    summary: summary || undefined,
    diagnostic: summary !== normalized ? normalized : undefined,
  }
}

export function FeedbackNotice({ title, description, diagnostic, details, actions, tone = 'error', variant = 'card', announcement = true }: {
  title: ReactNode
  description?: ReactNode
  diagnostic?: string
  details?: ReactNode
  actions?: ReactNode
  tone?: FeedbackTone
  variant?: FeedbackVariant
  announcement?: boolean
}): JSX.Element {
  const titleId = useId()
  const detailsId = `${titleId}-details`
  const [expanded, setExpanded] = useState(false)
  const [textTruncated, setTextTruncated] = useState(false)
  const titleRef = useRef<HTMLSpanElement>(null)
  const descriptionRef = useRef<HTMLDivElement>(null)
  const isBarLike = variant === 'bar' || variant === 'bar-compact'

  const summarizedDescription = typeof description === 'string' ? summarizeFeedbackMessage(description) : undefined
  const summarizedDiagnosticOnly = description === undefined && diagnostic !== undefined ? summarizeFeedbackMessage(diagnostic) : undefined
  const resolvedDescription: ReactNode = typeof description === 'string'
    ? (summarizedDescription?.summary ?? description)
    : (description ?? (isBarLike ? summarizedDiagnosticOnly?.summary : undefined))

  const explicitDiagnosticSource = diagnostic ?? summarizedDescription?.diagnostic
  const normalizedDiagnostic = explicitDiagnosticSource === undefined ? undefined : normalizeFeedbackDiagnostic(explicitDiagnosticSource)
  const descriptionText = typeof resolvedDescription === 'string' && resolvedDescription.trim()
    ? normalizeFeedbackDiagnostic(resolvedDescription.trim())
    : undefined
  const titleText = typeof title === 'string' && title.trim() ? title.trim() : undefined
  const barDiagnostic = normalizedDiagnostic ?? (textTruncated ? descriptionText : undefined)
  const effectiveDiagnostic = isBarLike ? barDiagnostic : normalizedDiagnostic
  const copy = useCopyFeedback(effectiveDiagnostic ?? '')
  const Icon = tone === 'warning' ? TriangleAlert : CircleAlert
  const hasDetails = Boolean(effectiveDiagnostic?.trim())
  const hasInlineDetails = hasDetails || Boolean(details)
  const hasExplicitDetails = Boolean(normalizedDiagnostic?.trim()) || Boolean(details)

  useEffect(() => {
    if (!isBarLike) {
      setTextTruncated(false)
      return
    }
    const checkOverflow = (): void => {
      const titleEl = titleRef.current
      const descEl = descriptionRef.current
      const overflowed = Boolean(
        (titleEl && titleEl.scrollWidth > titleEl.clientWidth + 1)
        || (descEl && (descEl.scrollWidth > descEl.clientWidth + 1 || descEl.scrollHeight > descEl.clientHeight + 1)),
      )
      setTextTruncated(overflowed)
      if (!overflowed && !hasExplicitDetails) setExpanded(false)
    }
    checkOverflow()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(checkOverflow)
    if (titleRef.current) observer.observe(titleRef.current)
    if (descriptionRef.current) observer.observe(descriptionRef.current)
    return () => observer.disconnect()
  }, [isBarLike, title, resolvedDescription, hasExplicitDetails])

  const titleNode = <span ref={isBarLike ? titleRef : undefined} id={titleId} className="my-feedback-title my-item-title" title={isBarLike ? titleText : undefined}>{title}</span>
  const copyButton = hasDetails ? <button type="button" className="my-feedback-action" disabled={copy.status === 'copying'} onClick={() => void copy.copy(effectiveDiagnostic ?? '')}>
    {copy.status === 'copying' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : copy.status === 'copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    {copy.status === 'copied' ? '已复制' : '复制详情'}
  </button> : null

  const detailsToggle = hasInlineDetails ? <Button
    type="button"
    size="sm"
    variant="outline"
    className="my-feedback-bar-toggle"
    aria-expanded={expanded}
    aria-controls={detailsId}
    onClick={() => setExpanded(value => !value)}
  >
    <span>{expanded ? '收起' : '详情'}</span>
    <ChevronRight size={12} strokeWidth={1.65} className={clsx('my-feedback-chevron', expanded && 'is-open')} aria-hidden="true" />
  </Button> : null

  const barDetailsDrawer = hasInlineDetails ? <div id={detailsId} className="my-feedback-bar-details" hidden={!expanded}>
    {expanded && <>
      <div className="my-feedback-details my-scrollbar" role="region" aria-label={hasDetails ? '错误详情' : '详情'} tabIndex={0}>
        {details}
        {hasDetails && <pre>{effectiveDiagnostic}</pre>}
      </div>
      {copyButton && <div className="my-feedback-bar-details-footer">{copyButton}</div>}
      {copy.status === 'error' && <p className="my-feedback-copy-error">复制失败，请选择文字后复制。</p>}
    </>}
  </div> : null

  if (variant === 'bar') {
    return <article className={clsx('my-feedback', `is-${tone}`, 'is-bar')} aria-labelledby={titleId}>
      <div className="my-feedback-bar-main">
        <span className="my-feedback-icon" aria-hidden="true"><Icon /></span>
        <div className="my-feedback-content">
          <div className="my-feedback-title-row" role={announcement ? 'alert' : undefined}>{titleNode}</div>
          {resolvedDescription && <div ref={descriptionRef} className="my-feedback-description my-item-description" title={descriptionText}>{resolvedDescription}</div>}
        </div>
        {(actions || hasInlineDetails) && <div className="my-feedback-bar-actions">
          {actions}
          {detailsToggle}
        </div>}
      </div>
      {barDetailsDrawer}
    </article>
  }

  if (variant === 'bar-compact') {
    return <article className={clsx('my-feedback', `is-${tone}`, 'is-bar-compact')} aria-labelledby={titleId}>
      <div className="my-feedback-compact-head">
        <span className="my-feedback-icon" aria-hidden="true"><Icon /></span>
        <div className="my-feedback-title-row" role={announcement ? 'alert' : undefined}>{titleNode}</div>
      </div>
      {resolvedDescription && <div ref={descriptionRef} className="my-feedback-description my-item-description" title={descriptionText}>{resolvedDescription}</div>}
      {(actions || hasInlineDetails) && <div className="my-feedback-compact-actions">
        {actions}
        {detailsToggle}
      </div>}
      {barDetailsDrawer}
    </article>
  }

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
      {resolvedDescription && <div className="my-feedback-description my-item-description">{resolvedDescription}</div>}
      {actions && <div className="my-feedback-actions">{actions}</div>}
      {hasInlineDetails && <div id={detailsId} className="my-feedback-inline-details" hidden={!expanded}>
        {expanded && <>
          <div className="my-feedback-details my-scrollbar" role="region" aria-label={hasDetails ? '错误详情' : '详情'} tabIndex={0}>
            {details}
            {hasDetails && <pre>{effectiveDiagnostic}</pre>}
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
      {resolvedDescription && <div className="my-feedback-description my-item-description">{resolvedDescription}</div>}
      {(hasDetails || actions) && <div className="my-feedback-actions">
        {actions}
        {hasDetails && <button type="button" className="my-feedback-action" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded((value) => !value)}>
          <ChevronRight size={14} className={clsx('my-feedback-chevron', expanded && 'is-open')} aria-hidden="true" />
          {expanded ? '收起详情' : '查看详情'}
        </button>}
        {copyButton}
      </div>}
      {hasDetails && <div id={detailsId} className="my-feedback-details my-scrollbar" role="region" aria-label="错误详情" hidden={!expanded} tabIndex={expanded ? 0 : undefined}>
        <pre>{effectiveDiagnostic}</pre>
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

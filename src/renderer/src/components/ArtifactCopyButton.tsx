import { useMemo, type JSX } from 'react'
import { Check, Copy, TriangleAlert } from 'lucide-react'
import { Button } from '../my/ui'
import { useCopyFeedback } from '../utils/use-copy-feedback'

/** Explicit displayed code/document sources only; Markdown prose does not opt in. */
export function ArtifactCopyButton({ text, ownerKey, label, isCurrent }: {
  text: string
  ownerKey: string
  label: string
  isCurrent?: () => boolean
}): JSX.Element {
  const owner = useMemo(() => ({ ownerKey, text }), [ownerKey, text])
  const { status, copy } = useCopyFeedback(owner)
  const caption = status === 'copying' ? '正在复制…' : status === 'copied' ? '已复制' : status === 'error' ? '重试复制' : '复制'
  return <span className="inline-flex min-w-0 flex-wrap items-center gap-1" data-artifact-copy-status={status}>
    <Button size="sm" variant="ghost" aria-label={status === 'idle' ? label : `${caption} · ${label}`} aria-disabled={status === 'copying'} title={label} onClick={() => { if (!isCurrent || isCurrent()) void copy(text) }}>
      {status === 'copied' ? <Check size={13} aria-hidden="true" /> : status === 'error' ? <TriangleAlert size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}{caption}
    </Button>
    <span role="status" aria-live="polite" className={status === 'error' ? 'text-my-sm text-my-danger-text' : 'sr-only'}>{status === 'error' ? '复制失败，请重试或选择文字复制' : status === 'copied' ? `${label}：已复制` : ''}</span>
  </span>
}

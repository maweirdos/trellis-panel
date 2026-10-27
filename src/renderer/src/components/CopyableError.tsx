import type { JSX } from 'react'
import { Check, Copy, Loader2 } from 'lucide-react'
import { Button } from '../my/ui'
import { useCopyFeedback } from '../utils/use-copy-feedback'

export function CopyableError({ message, summary = '操作失败' }: { message: string; summary?: string }): JSX.Element {
  const feedback = useCopyFeedback(message)
  return <div role="alert" className="min-w-0 space-y-2 text-my-sm">
    <div className="flex items-start gap-2">
      <p className="min-w-0 flex-1 select-text break-words text-my-danger-text">{summary}</p>
      <Button size="sm" variant="ghost" aria-label="复制完整错误" title="复制完整错误" disabled={feedback.status === 'copying'} onClick={() => void feedback.copy(message)}>
        {feedback.status === 'copying' ? <Loader2 size={13} className="animate-spin" /> : feedback.status === 'copied' ? <Check size={13} /> : <Copy size={13} />}
        {feedback.status === 'copied' ? '已复制' : '复制'}
      </Button>
    </div>
    <details className="text-my-secondary">
      <summary className="w-fit cursor-pointer text-my-xs">错误详情</summary>
      <pre className="my-scrollbar mt-2 max-h-64 select-text overflow-auto whitespace-pre-wrap break-words rounded-my-md bg-my-layer-1 p-3 font-mono text-my-xs">{message}</pre>
    </details>
    {feedback.status === 'error' && <p role="status" className="text-my-xs text-my-danger-text">复制失败，请选择文字后复制。</p>}
  </div>
}

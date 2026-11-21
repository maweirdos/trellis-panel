import { useRef, type JSX } from 'react'
import { GitCompareArrows, Loader2, RotateCcw, Sparkles, X } from 'lucide-react'
import { Button } from '../../../my/ui'
import type { TaskDescriptionSuggestionState, TaskDescriptionSuggestionSelection } from './use-task-description-suggestion'

function compareText(original: string, replacement: string): { prefix: string; removed: string; added: string; suffix: string } {
  let start = 0
  const end = Math.min(original.length, replacement.length)
  while (start < end && original[start] === replacement[start]) start++
  let tail = 0
  while (tail < end - start && original[original.length - 1 - tail] === replacement[replacement.length - 1 - tail]) tail++
  return { prefix: original.slice(0, start), removed: original.slice(start, original.length - tail), added: replacement.slice(start, replacement.length - tail), suffix: original.slice(original.length - tail) }
}

export function TaskDescriptionSuggestion({ suggestion, canAdopt, onSendToAgent }: {
  suggestion: TaskDescriptionSuggestionState
  canAdopt: boolean
  onSendToAgent(selection: TaskDescriptionSuggestionSelection, instruction: string): void
}): JSX.Element | null {
  const input = useRef<HTMLTextAreaElement>(null)
  if (suggestion.status === 'idle') return null
  const diff = suggestion.replacement !== undefined && suggestion.source ? compareText(suggestion.source.text, suggestion.replacement) : null
  return <section className="rounded-my-md border border-my-line bg-my-layer-1 p-3" aria-label="任务正文建议审阅">
    <header className="mb-2 flex items-center gap-2">
      <GitCompareArrows size={15} aria-hidden="true" />
      <span className="my-item-title">任务正文建议</span>
      <span className="my-item-description">{suggestion.stale ? '任务正文已更新' : suggestion.message}</span>
      <Button size="sm" variant="ghost" className="ml-auto" aria-label="关闭任务正文建议" disabled={suggestion.busy} onClick={suggestion.close}><X size={14} /></Button>
    </header>
    {suggestion.status === 'candidate' && suggestion.source && diff ? <>
      <div className="grid gap-2 md:grid-cols-2">
        <section><h3 className="my-item-title">原选区</h3><pre className="my-scrollbar max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-my-md bg-my-layer-2 p-2 text-my-sm">{suggestion.source.text}</pre></section>
        <section><h3 className="my-item-title">建议替换</h3><pre className="my-scrollbar max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-my-md bg-my-layer-2 p-2 text-my-sm">{diff.prefix}<del>{diff.removed}</del><ins>{diff.added}</ins>{diff.suffix}</pre></section>
      </div>
      <footer className="mt-2 flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={suggestion.busy} onClick={suggestion.close}>取消建议</Button>
        <Button size="sm" variant="primary" disabled={!canAdopt || suggestion.busy || suggestion.stale} onClick={() => void suggestion.adopt()}>采用到任务</Button>
      </footer>
    </> : suggestion.status === 'running' || suggestion.status === 'unknown' ? <div className="flex flex-wrap items-center gap-2">
      {suggestion.status === 'running' && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
      <span className="my-item-description min-w-0 flex-1">{suggestion.message}</span>
      <Button size="sm" variant="outline" disabled={suggestion.busy} onClick={() => void suggestion.check()}>核对结果</Button>
      <Button size="sm" variant="ghost" disabled={suggestion.busy || suggestion.status !== 'running'} onClick={suggestion.cancel}>取消</Button>
    </div> : <p className="my-item-description" role={suggestion.status === 'failed' ? 'alert' : undefined}>{suggestion.message}</p>}
    {(suggestion.status === 'failed' || suggestion.status === 'closed') && <form className="mt-2 flex items-end gap-2" onSubmit={event => {
      event.preventDefault()
      const field = input.current
      if (!field || !field.value.trim()) return
      const text = field.value.trim()
      field.value = ''
      onSendToAgent({ text: suggestion.source?.text ?? text, from: suggestion.source?.from ?? 0, to: suggestion.source?.to ?? text.length }, text)
    }}>
      <label className="flex min-w-0 flex-1 flex-col gap-1"><span className="my-item-title">重新描述修改</span><textarea ref={input} className="my-input" rows={2} maxLength={4000} /></label>
      <Button size="sm" type="submit"><RotateCcw size={13} />重新生成</Button>
    </form>}
  </section>
}

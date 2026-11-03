import { useState, type JSX } from 'react'
import { ChevronRight, Sparkles } from 'lucide-react'
import { MarkdownView } from '../components/MarkdownView'
import { ConnectionNotice } from './ConnectionNotice'
import { EventRow, type EventRowProps } from './TranscriptRow'
import { asObject } from './timeline'
import { isTranscriptEventIssue } from './conversation-transcript'

function errorMessage(payload: Record<string, unknown> | undefined): string | undefined {
  const result = asObject(payload?.result)
  return [payload?.error, result?.error, payload?.message, result?.message, asObject(payload?.hostPolicyOutcome)?.message]
    .map(value => typeof value === 'string' ? value : asObject(value)?.message)
    .find((value): value is string => typeof value === 'string' && Boolean(value.trim()))
}

/** A process leaf owns content only; turn state, timing and grouping live above it. */
export function TranscriptProcessLeaf(props: EventRowProps & { thoughtBody?: boolean }): JSX.Element | null {
  const { item } = props
  const [thoughtOpen, setThoughtOpen] = useState(false)
  if (item.type === 'activity') return null
  if (item.type === 'thought' && props.thoughtBody) return item.text.trim() ? <div data-acp-item={item.key} className="acp-process-leaf-body acp-process-thought break-words"><MarkdownView content={item.text} /></div> : null
  if (item.type === 'thought') return item.text.trim() ? <details data-acp-item={item.key} className="acp-process-leaf acp-process-thought" onToggle={event => setThoughtOpen(event.currentTarget.open)}>
    <summary className="acp-turn-process-toggle"><Sparkles aria-hidden="true" /><span>思考</span><ChevronRight className="acp-turn-process-chevron" aria-hidden="true" /></summary>
    {thoughtOpen && <div className="acp-process-leaf-body break-words"><MarkdownView content={item.text} /></div>}
  </details> : null
  if (item.type === 'detail' && item.ev.kind === 'turn-done') {
    const payload = item.ev.payload
    const result = asObject(payload?.result)
    const message = errorMessage(payload)
      ?? (!/^(回合已结束|本轮结束|回合已取消)$/.test(item.ev.text ?? '') ? item.ev.text : undefined)
    return <div data-acp-item={item.key}>{result?.status === 'failed'
      ? <p className="acp-tool-failure my-scrollbar" role="alert" tabIndex={0}>处理失败：{message ?? '执行引擎未返回进一步原因。'}</p>
      : <details className="acp-process-leaf"><summary className="acp-turn-process-toggle"><span>中止详情</span><ChevronRight className="acp-turn-process-chevron" aria-hidden="true" /></summary><p className="acp-process-leaf-body">{message ?? '本次处理已中止。'}</p></details>}</div>
  }
  if (item.type === 'detail' && isTranscriptEventIssue(item.ev)) return <div data-acp-item={item.key}><ConnectionNotice message={errorMessage(item.ev.payload) ?? item.ev.text ?? String(asObject(item.ev.payload?.observation)?.label ?? '执行引擎报告请求失败。')} /></div>
  return <EventRow {...props} suppressWorkingIndicator compact={props.messagePresentation !== 'final'} />
}

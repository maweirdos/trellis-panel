import { useEffect, useRef, useState, type JSX } from 'react'
import { ChevronRight, Sparkles } from 'lucide-react'
import { MarkdownView } from '../components/MarkdownView'
import { useInteractionActive } from '../utils/interaction-scope'

/** Preview only the active thought segment; full content remains expandable afterward. */
export function ThoughtActivity({ text, streaming }: { text: string; streaming: boolean }): JSX.Element {
  const interactive = useInteractionActive()
  const flat = text.replace(/\s+/g, ' ').trim()
  const characters = Array.from(flat)
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState(() => streaming && characters.length < 200 ? 0 : characters.length)
  const position = useRef(shown)
  const previous = useRef(flat)
  const previewRef = useRef<HTMLDivElement>(null)
  const targetLength = useRef(characters.length)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    const length = Array.from(flat).length
    targetLength.current = length
    if (!flat.startsWith(previous.current)) position.current = 0
    previous.current = flat
    if (!streaming || !interactive || open || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = null
      position.current = length; setShown(length)
      return
    }
    const advance = (): void => {
      const remaining = targetLength.current - position.current
      position.current = Math.min(targetLength.current, position.current + Math.max(1, Math.ceil(remaining / 8)))
      setShown(position.current)
      timerRef.current = position.current < targetLength.current ? window.setTimeout(advance, 30) : null
    }
    if (position.current < length && timerRef.current === null) advance()
  }, [flat, streaming, interactive, open])
  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  const end = Math.min(shown, characters.length)
  const start = Math.max(0, end - 220)
  const preview = `${start ? '…' : ''}${characters.slice(start, end).join('')}`
  const revealing = streaming && interactive && end < characters.length
  useEffect(() => {
    if (interactive && !open && previewRef.current) previewRef.current.scrollLeft = previewRef.current.scrollWidth
  }, [preview, open, interactive])
  return <div className="acp-thought-shell">
    <details className="acp-activity-row acp-thought-row" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary><Sparkles size={14} /><span>思考</span><ChevronRight size={12} className="acp-disclosure-arrow" /></summary>
      {open && <div className="acp-activity-body break-words"><MarkdownView content={text} /></div>}
    </details>
    {streaming && interactive && !open && flat && <div ref={previewRef} className="acp-thought-preview" aria-label="已报告的思考预览" aria-live="off"><span>{preview}</span>{revealing && <i className="acp-thought-caret" aria-hidden="true" />}</div>}
  </div>
}

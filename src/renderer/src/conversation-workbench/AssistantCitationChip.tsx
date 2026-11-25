import { Popover } from '@base-ui/react/popover'
import { ArrowUpRight, Pencil, Quote } from 'lucide-react'
import { useRef, useState } from 'react'
import { ASSISTANT_CITATION_MAX_COMMENT_LENGTH, type AssistantCitation } from '../../../shared/conversation/assistantCitations'
import { assistantCitationLabel } from '../../../shared/conversation/assistantCitationText'
import { Button } from '../my/ui'
import { useInteractionActive } from '../utils/interaction-scope'
import './assistant-citation.css'

export type OpenAssistantCitation = (citation: AssistantCitation) => Promise<boolean>

function CitationExcerpt({ citation }: { readonly citation: AssistantCitation }) {
  return <blockquote dir="auto">{citation.text}</blockquote>
}

export function AssistantCitationCommentEditor({ citation, onSave, onCancel }: {
  readonly citation: AssistantCitation
  readonly onSave: (comment: string) => void
  readonly onCancel: () => void
}) {
  const [comment, setComment] = useState(citation.comment ?? '')
  return <div className="conversation-citation-comment">
    <CitationExcerpt citation={citation} />
    <textarea aria-label="引用备注" placeholder="想补充什么？" autoFocus rows={2} dir="auto" value={comment}
      maxLength={ASSISTANT_CITATION_MAX_COMMENT_LENGTH} onChange={event => setComment(event.target.value)}
      onKeyDown={event => {
        if (event.key !== 'Enter' || !event.ctrlKey || event.nativeEvent.isComposing || event.keyCode === 229) return
        event.preventDefault()
        onSave(comment)
      }} />
    <div className="conversation-citation-popup-actions">
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>取消</Button>
      <Button type="button" size="sm" onClick={() => onSave(comment)}>保存备注</Button>
    </div>
  </div>
}

export function AssistantCitationChip({ citation, onSave, onOpenSource, sent = false }: {
  readonly citation: AssistantCitation
  readonly onSave?: (comment: string) => void
  readonly onOpenSource?: OpenAssistantCitation
  readonly sent?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [missing, setMissing] = useState(false)
  const [finding, setFinding] = useState(false)
  const findRequest = useRef<symbol | null>(null)
  const anchor = useRef<HTMLButtonElement>(null)
  const active = useInteractionActive()
  const label = assistantCitationLabel(citation)
  const portalRoot = anchor.current?.closest<HTMLElement>('.my-root')
  const setPopupOpen = (next: boolean): void => {
    if (!next) {
      findRequest.current = null
      setEditing(false)
      setMissing(false)
      setFinding(false)
    }
    setOpen(next)
  }
  const findSource = async (): Promise<void> => {
    if (!onOpenSource || findRequest.current) return
    const request = Symbol()
    findRequest.current = request
    setMissing(false)
    setFinding(true)
    const found = await onOpenSource(citation).catch(() => false)
    if (findRequest.current !== request) return
    findRequest.current = null
    setFinding(false)
    if (found) setPopupOpen(false)
    else setMissing(true)
  }
  return (
    <Popover.Root open={active && open} onOpenChange={setPopupOpen}>
      <Popover.Trigger ref={anchor} type="button" data-assistant-citation-chip="true" data-kind="citation"
        className={sent ? 'conversation-response-citation' : 'conversation-citation-chip'}
        aria-label={`查看引用：${label}`} onMouseDown={event => { if (!sent) event.preventDefault() }}>
        {sent ? <><Quote size={14} aria-hidden="true" /><span>{label}</span></>
          : <><Quote size={14} aria-hidden="true" /><span data-slot="context-chip-label" dir="auto">{label}</span></>}
      </Popover.Trigger>
      {portalRoot && <Popover.Portal container={portalRoot}>
        <Popover.Positioner side="top" sideOffset={6} align="start" className="conversation-citation-positioner">
          <Popover.Popup aria-label="引用来源" className="conversation-citation-popup">
            {editing && onSave ? <AssistantCitationCommentEditor citation={citation}
              onCancel={() => setEditing(false)} onSave={comment => { onSave(comment); setEditing(false) }} />
              : <>
                <CitationExcerpt citation={citation} />
                {citation.comment && <p dir="auto" className="conversation-citation-note">{citation.comment}</p>}
                {(onOpenSource || onSave) && <div className="conversation-citation-popup-actions">
                  {onSave && <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)}>
                    <Pencil size={13} aria-hidden="true" />{citation.comment ? '编辑备注' : '添加备注'}
                  </Button>}
                  {onOpenSource && <Button type="button" size="sm" variant="ghost" aria-disabled={finding} aria-busy={finding}
                    onClick={() => void findSource()}><ArrowUpRight size={13} aria-hidden="true" />
                    {finding ? '正在查找原文…' : '查看原文'}
                  </Button>}
                </div>}
                {missing && <p className="my-item-description" role="status">找不到可访问的原文。</p>}
              </>}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>}
    </Popover.Root>
  )
}

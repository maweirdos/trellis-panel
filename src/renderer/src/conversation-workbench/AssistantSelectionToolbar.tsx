import { Check, Copy, MessageSquarePlus, Quote } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AssistantCitation } from '../../../shared/conversation/assistantCitations'
import { useInteractionActive } from '../utils/interaction-scope'
import { captureAssistantTextSelection } from './AssistantCitationSource'
import './assistant-citation.css'
import './conversation-enhancements.css'

function modalLayer(viewport: HTMLElement | null): { root: HTMLElement | null; layer: string | undefined } | null {
  // A fixed toolbar inside the animated modal panel would be positioned in the
  // panel's box, not the viewport. Mount beside the modal and carry its layer id
  // so focus containment, Escape and the tab loop keep treating it as inside.
  const panel = viewport?.closest<HTMLElement>('.my-modal-panel')
  const layer = panel?.closest<HTMLElement>('[data-my-layer]')?.dataset.myLayer
  const root = viewport?.closest<HTMLElement>('.my-root')
  return panel && layer && root ? { root, layer } : null
}

export function AssistantSelectionToolbar({ viewport, threadId, onCite, onSideChatQuote }: {
  readonly viewport: HTMLElement | null
  readonly threadId: string
  readonly onCite: (citation: AssistantCitation) => void
  readonly onSideChatQuote?: (citation: AssistantCitation) => void
}) {
  const [selection, setSelection] = useState<{ citation: AssistantCitation; x: number; y: number } | null>(null)
  const [copied, setCopied] = useState(false)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const primaryButtonRef = useRef<HTMLButtonElement>(null)
  const active = useInteractionActive()
  const modal = modalLayer(viewport)
  const portalRoot = modal?.root ?? viewport?.closest('.my-root')
  const layerIds = modal?.layer

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current
    if (!toolbar || !selection) return
    const rect = toolbar.getBoundingClientRect()
    toolbar.style.left = `${Math.max(8, Math.min(selection.x - rect.width, window.innerWidth - rect.width - 8))}px`
    toolbar.style.top = `${Math.max(8, Math.min(selection.y, window.innerHeight - rect.height - 8))}px`
  }, [selection])

  useEffect(() => {
    if (!viewport || !active) return
    let frame = 0
    let dragging = false
    const clear = () => {
      cancelAnimationFrame(frame)
      setSelection(null)
      setCopied(false)
    }
    const update = () => {
      cancelAnimationFrame(frame)
      if (dragging) return
      frame = requestAnimationFrame(() => {
        const captured = captureAssistantTextSelection(viewport, threadId, window.getSelection())
        const rect = captured?.range.getBoundingClientRect()
        const bounds = viewport.getBoundingClientRect()
        if (!captured || !rect || rect.bottom <= bounds.top || rect.top >= bounds.bottom ||
          rect.left >= bounds.right || rect.right <= bounds.left) {
          setSelection(null)
          setCopied(false)
          return
        }
        setCopied(false)
        setSelection({ citation: captured.citation, x: Math.min(rect.right, bounds.right), y: rect.bottom + 5 })
      })
    }
    const press = () => { dragging = true; clear() }
    const release = () => { dragging = false; update() }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && toolbarRef.current) {
        clear()
        return
      }
      if (event.altKey && event.key === 'F10' && primaryButtonRef.current) {
        event.preventDefault()
        primaryButtonRef.current.focus()
      }
    }
    viewport.addEventListener('pointerdown', press)
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    document.addEventListener('selectionchange', update)
    window.addEventListener('keydown', key)
    viewport.addEventListener('scroll', clear)
    window.addEventListener('resize', clear)
    return () => {
      cancelAnimationFrame(frame)
      viewport.removeEventListener('pointerdown', press)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      document.removeEventListener('selectionchange', update)
      window.removeEventListener('keydown', key)
      viewport.removeEventListener('scroll', clear)
      window.removeEventListener('resize', clear)
    }
  }, [viewport, threadId, active])

  if (!viewport || !portalRoot || !selection || !active || selection.citation.threadId !== threadId) return null

  const captureCurrent = () => captureAssistantTextSelection(viewport, threadId, window.getSelection())

  return createPortal(
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label="所选回复快捷操作"
      data-my-layer={layerIds}
      className="conversation-selection-toolbar"
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        ref={primaryButtonRef}
        type="button"
        className="conversation-selection-toolbar-btn"
        onClick={() => {
          const current = captureCurrent()
          if (current) {
            onCite(current.citation)
            window.getSelection()?.removeAllRanges()
          }
          setSelection(null)
        }}
      >
        <Quote size={13} aria-hidden="true" />
        <span>引用追问</span>
      </button>
      {onSideChatQuote && (
        <button
          type="button"
          className="conversation-selection-toolbar-btn"
          onClick={() => {
            const current = captureCurrent()
            if (current) {
              onSideChatQuote(current.citation)
              window.getSelection()?.removeAllRanges()
            }
            setSelection(null)
          }}
        >
          <MessageSquarePlus size={13} aria-hidden="true" />
          <span>开侧聊</span>
        </button>
      )}
      <button
        type="button"
        className="conversation-selection-toolbar-btn"
        aria-label="复制所选内容"
        onClick={() => {
          const text = captureCurrent()?.citation.text ?? selection.citation.text
          if (text && navigator.clipboard?.writeText) {
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true)
              window.setTimeout(() => setSelection(null), 320)
            }).catch(() => undefined)
          }
        }}
      >
        {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
        <span>{copied ? '已复制' : '复制'}</span>
      </button>
    </div>,
    portalRoot,
  )
}

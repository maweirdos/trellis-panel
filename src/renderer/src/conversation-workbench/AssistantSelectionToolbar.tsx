import { Quote } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AssistantCitation } from '../../../shared/conversation/assistantCitations'
import { useInteractionActive } from '../utils/interaction-scope'
import { captureAssistantTextSelection } from './AssistantCitationSource'
import './assistant-citation.css'

function modalLayer(viewport: HTMLElement | null): { root: HTMLElement | null; layer: string | undefined } | null {
  // A fixed toolbar inside the animated modal panel would be positioned in the
  // panel's box, not the viewport. Mount beside the modal and carry its layer id
  // so focus containment, Escape and the tab loop keep treating it as inside.
  const panel = viewport?.closest<HTMLElement>('.my-modal-panel')
  const layer = panel?.closest<HTMLElement>('[data-my-layer]')?.dataset.myLayer
  const root = viewport?.closest<HTMLElement>('.my-root')
  return panel && layer && root ? { root, layer } : null
}

export function AssistantSelectionToolbar({ viewport, threadId, onCite }: {
  readonly viewport: HTMLElement | null
  readonly threadId: string
  readonly onCite: (citation: AssistantCitation) => void
}) {
  const [selection, setSelection] = useState<{ citation: AssistantCitation; x: number; y: number } | null>(null)
  const toolbarRef = useRef<HTMLButtonElement>(null)
  const active = useInteractionActive()
  const modal = modalLayer(viewport)
  const portalRoot = modal?.root ?? viewport?.closest('.my-root')
  const layerIds = modal?.layer

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current
    if (!toolbar || !selection) return
    const rect = toolbar.getBoundingClientRect()
    toolbar.style.left = `${Math.max(8, Math.min(selection.x, window.innerWidth - rect.width - 8))}px`
    toolbar.style.top = `${Math.max(8, Math.min(selection.y, window.innerHeight - rect.height - 8))}px`
  }, [selection])

  useEffect(() => {
    if (!viewport || !active) return
    let frame = 0
    let dragging = false
    const clear = () => { cancelAnimationFrame(frame); setSelection(null) }
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
          return
        }
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
      if (event.altKey && event.key === 'F10' && toolbarRef.current) {
        event.preventDefault()
        toolbarRef.current.focus()
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
  return createPortal(
    <button ref={toolbarRef} type="button" data-my-layer={layerIds}
      className="my-control my-control-sm my-button-neutral conversation-selection-action"
      onMouseDown={event => event.preventDefault()}
      onClick={() => {
        const current = captureAssistantTextSelection(viewport, threadId, window.getSelection())
        if (current) {
          onCite(current.citation)
          window.getSelection()?.removeAllRanges()
        }
        setSelection(null)
      }}>
      <Quote size={14} aria-hidden="true" />引用所选内容
    </button>,
    portalRoot,
  )
}

import type { RefObject } from 'react'
import type { AssistantCitation } from '../../../shared/conversation/assistantCitations'
import { serializeAssistantCitation } from '../../../shared/conversation/assistantCitationText'
import type { ComposerPromptEditorHandle } from './ComposerPromptEditorTiptap'
import type { useComposerSend } from './useComposerSend'

export interface CitationDraftHandle {
  readonly insert: (citation: AssistantCitation) => void
}

export function insertAssistantCitationIntoDraft(
  citation: AssistantCitation,
  draft: Pick<ReturnType<typeof useComposerSend>, 'readDraft' | 'setDraft'>,
  editorRef: RefObject<ComposerPromptEditorHandle | null>,
  isCurrent: () => boolean,
): void {
  if (!isCurrent()) return
  const current = draft.readDraft()
  const editor = editorRef.current
  const { start, end } = editor?.readSnapshot().selection ?? { start: current.length, end: current.length }
  const serialized = serializeAssistantCitation(citation)
  const before = current.slice(0, start)
  const after = current.slice(end)
  const leading = before && !/\s$/u.test(before) ? ' ' : ''
  const trailing = !after || !/^\s/u.test(after) ? ' ' : ''
  const value = `${before}${leading}${serialized}${trailing}${after}`
  const position = before.length + leading.length + serialized.length + trailing.length
  draft.setDraft(text => text === current ? value : text)
  requestAnimationFrame(() => {
    if (isCurrent() && editor && editorRef.current === editor && editor.readSnapshot().value === value) {
      editor.focus()
      editor.setSelectionRange(position, position)
    }
  })
}

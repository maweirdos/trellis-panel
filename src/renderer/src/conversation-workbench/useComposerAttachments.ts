import { useRef, useState } from 'react'
import {
  conversationAttachmentLimitError, type ConversationAttachmentBytesInput, type StagedConversationAttachment,
} from '../../../shared/conversation/attachments'
import type { ConversationTaskLocator } from '../../../shared/conversation/task-scope'
import type { ConversationKnowledgeReference } from '../../../shared/conversation/knowledge-reference'
import { api } from '../api'
import { normalizeFeedbackDiagnostic } from '../my/FeedbackNotice'
import { useInteractionGuard } from '../utils/interaction-scope'
import { readComposerDraft, updateComposerDraft } from './useComposerDraft'

const pastedTextAttachmentThreshold = 32 * 1024
const encoder = new TextEncoder()

export function shouldAttachPastedText(text: string, inlineLength: number, limit: number): boolean {
  return text.length > 0 && (inlineLength > limit || text.length >= pastedTextAttachmentThreshold ||
    encoder.encode(text).byteLength >= pastedTextAttachmentThreshold)
}

function nextPastedTextFileName(attachments: readonly StagedConversationAttachment[]): string {
  const names = new Set(attachments.map(item => item.name.toLowerCase()))
  if (!names.has('pasted-text.txt')) return 'pasted-text.txt'
  let sequence = 2
  while (names.has(`pasted-text-${sequence}.txt`)) sequence++
  return `pasted-text-${sequence}.txt`
}

type DraftTarget = Parameters<typeof api.conversationAttachmentPick>[0]
type AttachmentOperation = { readonly pending: boolean; readonly error?: string; readonly retry?: () => void }
const idle: AttachmentOperation = { pending: false }

export function useComposerAttachments(
  root: string, threadId: string | null, key: string, interactive: boolean, task?: ConversationTaskLocator,
) {
  const canInteract = useInteractionGuard()
  const operations = useRef(new Map<string, AttachmentOperation>())
  const latestKey = useRef(key)
  latestKey.current = key
  const selectionOwner = useRef({ key })
  if (selectionOwner.current.key !== key) selectionOwner.current = { key }
  const [, redraw] = useState(0)
  const available = typeof api?.conversationAttachmentStage === 'function' &&
    typeof api?.conversationAttachmentPick === 'function' && typeof api?.conversationAttachmentRelease === 'function'
  const state = operations.current.get(key) ?? idle
  const phase = readComposerDraft(key).state.phase
  const canEdit = Boolean(threadId || !['submitting', 'accepted', 'unknown'].includes(phase))

  function setOperation(operation: AttachmentOperation): void {
    if (!operation.pending && !operation.error) operations.current.delete(key)
    else operations.current.set(key, operation)
    redraw(revision => revision + 1)
  }

  function add(attachments: readonly StagedConversationAttachment[]): void {
    if (!attachments.length) return
    updateComposerDraft(key, (current) => {
      const ids = new Set(current.attachments.map(item => item.id))
      const added = attachments.filter(item => !ids.has(item.id))
      return added.length ? { ...current, attachments: [...current.attachments, ...added] } : current
    })
  }

  function target(): DraftTarget | undefined {
    if (!available || !interactive || !canInteract() || latestKey.current !== key || operations.current.get(key)?.pending) return
    const state = readComposerDraft(key).state
    if (!threadId && (state.phase === 'submitting' || state.phase === 'accepted' || state.phase === 'unknown')) return
    const draft = updateComposerDraft(key, (current) => current.draftId ? current : { ...current, draftId: crypto.randomUUID() })
    if (!draft.draftId) return
    return { cwd: root, draftId: draft.draftId, ...(threadId ? { threadId } : {}), ...(task ? { task } : {}) }
  }

  async function operate(action: (bound: DraftTarget) => Promise<void>, retry?: () => void): Promise<boolean> {
    const bound = target()
    if (!bound) return false
    setOperation({ pending: true })
    try {
      await action(bound)
      setOperation(idle)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setOperation({ pending: false, error: normalizeFeedbackDiagnostic(message), retry })
      return false
    }
  }

  async function stage(bound: DraftTarget, input: ConversationAttachmentBytesInput): Promise<void> {
    const result = await api.conversationAttachmentStage({ ...bound, ...input })
    if (!result.ok) throw new Error(result.error)
    add([result.attachment])
  }

  function addFiles(files: readonly File[]): Promise<boolean> {
    return operate(async (bound) => {
      const candidates = files.map(file => ({
        type: file.type.startsWith('image/') ? 'image' as const : 'file' as const,
        mimeType: file.type || 'application/octet-stream', sizeBytes: file.size,
      }))
      const error = conversationAttachmentLimitError([...readComposerDraft(key).attachments, ...candidates])
      if (error) throw new Error(error)
      for (const file of files) {
        await stage(bound, { name: file.name, mimeType: file.type || undefined, bytes: new Uint8Array(await file.arrayBuffer()) })
      }
    })
  }

  function addPastedText(text: string): Promise<boolean> {
    return operate(async (bound) => {
      const bytes = encoder.encode(text)
      const existing = readComposerDraft(key).attachments
      const error = conversationAttachmentLimitError([...existing, { type: 'file', mimeType: 'text/plain', sizeBytes: bytes.byteLength }])
      if (error) throw new Error(error)
      await stage(bound, { name: nextPastedTextFileName(existing), mimeType: 'text/plain', bytes, source: 'pasted-text' })
    }, () => { void addPastedText(text) })
  }

  async function addKnowledge(knowledge: ConversationKnowledgeReference, isCurrent: () => boolean): Promise<boolean> {
    const owner = selectionOwner.current
    const current = (): boolean => selectionOwner.current === owner && canInteract() && isCurrent()
    if (!current()) return false
    let added = false
    const ok = await operate(async bound => {
      const result = await api.conversationAttachmentStage({ ...bound, knowledge })
      if (!current()) {
        if (result.ok) await api.conversationAttachmentRelease({ ...bound, attachmentId: result.attachment.id })
        return
      }
      if (!result.ok) throw new Error(result.error)
      add([result.attachment])
      added = true
    })
    return ok && added
  }

  async function pick(): Promise<boolean> {
    let selected = false
    const ok = await operate(async (bound) => {
      const result = await api.conversationAttachmentPick(bound)
      if (!result.ok) throw new Error(result.error)
      selected = result.attachments.length > 0
      add(result.attachments)
    })
    return ok && selected
  }

  function remove(attachmentId: string): Promise<boolean> {
    return operate(async (bound) => {
      const result = await api.conversationAttachmentRelease({ ...bound, attachmentId })
      if (!result.ok) throw new Error(result.error)
      updateComposerDraft(key, current => ({
        ...current, attachments: current.attachments.filter(item => item.id !== attachmentId),
      }))
    })
  }

  return {
    available, canEdit, state, pick, addFiles, addPastedText, addKnowledge, remove,
    isPending: () => operations.current.get(key)?.pending ?? false,
  }
}

const ATTACHMENT_ONLY_BOOTSTRAP =
  '[User attached one or more files without additional text. Respond using the conversation context and the attached files.]'
const CLAUDE_ULTRATHINK_PREFIX = 'Ultrathink:\n'

export interface ComposerPromptHistoryMessage {
  readonly id: string
  readonly role: string
  readonly text: string
}

export interface ComposerPromptHistoryEntry {
  readonly id: string
  readonly prompt: string
}

export interface ComposerPromptHistoryPosition {
  readonly entryId: string
  readonly recalled: string
}

export interface ComposerPromptHistoryStep {
  readonly position: ComposerPromptHistoryPosition | null
  readonly prompt: string
  readonly liveDraft: string
}

export function recallableComposerPrompt(messageText: string): string {
  let prompt = messageText.trim()
  if (prompt.startsWith(CLAUDE_ULTRATHINK_PREFIX)) {
    prompt = prompt.slice(CLAUDE_ULTRATHINK_PREFIX.length).trim()
  }
  if (!prompt || prompt === ATTACHMENT_ONLY_BOOTSTRAP) return ''
  return prompt
}

export function buildComposerPromptHistoryEntries(
  messages: readonly ComposerPromptHistoryMessage[],
): readonly ComposerPromptHistoryEntry[] {
  const entries: ComposerPromptHistoryEntry[] = []
  for (const message of messages) {
    if (message.role !== 'user') continue
    const prompt = recallableComposerPrompt(message.text)
    if (!prompt) continue
    const previous = entries.at(-1)
    if (previous && previous.prompt === prompt) {
      entries[entries.length - 1] = { id: message.id, prompt }
      continue
    }
    entries.push({ id: message.id, prompt })
  }
  return entries
}

function findEntryIndex(
  entries: readonly ComposerPromptHistoryEntry[],
  position: ComposerPromptHistoryPosition,
): number {
  const byId = entries.findIndex((entry) => entry.id === position.entryId)
  if (byId >= 0) return byId
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].prompt === position.recalled) return index
  }
  return -1
}

export function shouldTriggerPromptHistory(input: {
  readonly value: string
  readonly selectionStart: number
  readonly selectionEnd: number
  readonly direction: 'backward' | 'forward'
  readonly inHistoryMode: boolean
}): boolean {
  if (input.selectionStart !== input.selectionEnd) return false
  if (input.direction === 'backward') {
    if (input.value.length === 0) return true
    if (!input.inHistoryMode) return false
    return !input.value.slice(0, input.selectionStart).includes('\n')
  }
  if (!input.inHistoryMode) return false
  return !input.value.slice(input.selectionEnd).includes('\n')
}

export function stepComposerPromptHistory(input: {
  readonly direction: 'backward' | 'forward'
  readonly entries: readonly ComposerPromptHistoryEntry[]
  readonly position: ComposerPromptHistoryPosition | null
  readonly currentDraft: string
  readonly liveDraft: string
}): ComposerPromptHistoryStep | null {
  const { direction, entries, position, currentDraft, liveDraft } = input
  if (entries.length === 0) return null

  if (direction === 'backward') {
    if (position === null) {
      const target = entries[entries.length - 1]
      return {
        position: { entryId: target.id, recalled: target.prompt },
        prompt: target.prompt,
        liveDraft: currentDraft,
      }
    }
    const index = findEntryIndex(entries, position)
    if (index <= 0) return null
    const target = entries[index - 1]
    return {
      position: { entryId: target.id, recalled: target.prompt },
      prompt: target.prompt,
      liveDraft,
    }
  }

  if (position === null) return null
  const index = findEntryIndex(entries, position)
  if (index < 0 || index >= entries.length - 1) {
    return {
      position: null,
      prompt: liveDraft,
      liveDraft: '',
    }
  }
  const target = entries[index + 1]
  return {
    position: { entryId: target.id, recalled: target.prompt },
    prompt: target.prompt,
    liveDraft,
  }
}

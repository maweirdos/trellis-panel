import { randomUUID } from 'node:crypto'
import type { PiActivity, PiTextMeta, PiTextPhase } from '../protocol'

type BlockType = PiTextMeta['blockType']
type Block = { type: BlockType; text: string; phase?: PiTextPhase; providerMessageId?: string }

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Text signatures are public SDK metadata; thinking signatures remain opaque. */
function metadata(value: unknown): Pick<Block, 'phase' | 'providerMessageId'> {
  const block = object(value)
  let signature: Record<string, unknown> | undefined
  if (typeof block?.textSignature === 'string' && block.textSignature.startsWith('{')) {
    try { const parsed = object(JSON.parse(block.textSignature)); if (parsed?.v === 1) signature = parsed } catch { /* Other signature formats carry no phase. */ }
  }
  const phase = block?.phase ?? signature?.phase
  return {
    phase: phase === 'commentary' || phase === 'final_answer' ? phase : undefined,
    providerMessageId: typeof signature?.id === 'string' && signature.id ? signature.id : undefined
  }
}

/** One SDK assistant message, never a whole user turn or a sequence of tool rounds. */
export class AssistantTextStream {
  readonly id = randomUUID()
  readonly thinkingStarted = new Set<number>()
  private blocks = new Map<number, Block>()
  constructor(private emit: (event: PiActivity) => void) {}

  textAt(index: number): string { return this.blocks.get(index)?.text ?? '' }

  private publish(index: number, block: Block, text: string, operation: PiTextMeta['operation'], authority?: PiTextMeta['authority']): void {
    const piText: PiTextMeta = { version: 1, messageId: this.id, blockIndex: index, blockType: block.type, operation,
      ...(block.providerMessageId ? { providerMessageId: block.providerMessageId } : {}), ...(authority ? { authority } : {}) }
    this.emit({ type: 'text_delta', text, stream: block.type === 'thinking' ? 'thought' : 'output', messageId: this.id,
      meta: { piText, ...(block.phase ? { phase: block.phase } : {}) } })
  }

  append(index: number, type: BlockType, text: string, value?: unknown): void {
    if (!text) return
    const previous = this.blocks.get(index)
    if (previous && previous.type !== type) throw new Error('Pi streamed block type changed before finalization')
    const info = metadata(value)
    const block: Block = { type, text: (previous?.text ?? '') + text,
      phase: info.phase ?? previous?.phase, providerMessageId: info.providerMessageId ?? previous?.providerMessageId }
    this.publish(index, block, text, 'append')
    this.blocks.set(index, block)
  }

  reconcile(index: number, type: BlockType, text: string, value: unknown, authority: PiTextMeta['authority']): void {
    let previous = this.blocks.get(index)
    if (previous && previous.type !== type) {
      this.publish(index, { ...previous, text: '' }, '', 'replace', authority)
      previous = undefined
    }
    const block: Block = { type, text, ...metadata(value) }
    const streamed = previous?.text ?? ''
    // The final provider block can retract whitespace, rewrite text or clear a block.
    // A late phase/signature also needs a replayable event even when text is unchanged.
    if (!text.startsWith(streamed) || previous && (previous.phase !== block.phase || previous.providerMessageId !== block.providerMessageId)) {
      this.publish(index, block, text, 'replace', authority)
    } else if (text.length > streamed.length) {
      this.publish(index, block, text.slice(streamed.length), 'append', authority)
    }
    this.blocks.set(index, block)
  }

  finish(content: readonly unknown[]): void {
    const finalIndexes = new Set<number>()
    content.forEach((value, index) => {
      const block = object(value)
      if (block?.type === 'text' && typeof block.text === 'string') {
        finalIndexes.add(index); this.reconcile(index, 'text', block.text, value, 'message_end')
      } else if (block?.type === 'thinking' && typeof block.thinking === 'string') {
        finalIndexes.add(index); this.reconcile(index, 'thinking', block.thinking, value, 'message_end')
      }
    })
    for (const [index, block] of this.blocks) {
      if (!finalIndexes.has(index) && block.text) {
        this.publish(index, { ...block, text: '' }, '', 'replace', 'message_end')
        this.blocks.delete(index)
      }
    }
  }
}

import { StringDecoder } from 'node:string_decoder'

export const MAX_HISTORY_VALUE_BYTES = 2 * 1024 * 1024
// Only the literal meta/messages keys are interesting; even escaped forms fit this budget.
const MAX_HISTORY_KEY_BYTES = 128

/** Select only top-level meta and individual messages from a large ZCode JSON file. */
export class ZcodeJsonStream {
  private readonly decoder = new StringDecoder('utf8')
  private depth = 0
  private quoted = false
  private escaped = false
  private key = ''
  private keyText = ''
  private keyBytes = 0
  private readingKey = false
  private expectsKey = true
  private messages = false
  private capture: { kind: 'meta' | 'message'; depth: number; text: string; size: number; skipped: boolean } | undefined
  limited = false
  constructor(private readonly emit: (kind: 'meta' | 'message', value: unknown) => void) {}
  feed(bytes: Buffer): void {
    const text = this.decoder.write(bytes)
    for (const ch of text) {
      if (!this.capture && !this.quoted && ch === '{' && (this.depth === 1 && this.key === 'meta' || this.depth === 2 && this.messages)) {
        this.capture = { kind: this.depth === 1 ? 'meta' : 'message', depth: this.depth + 1, text: '', size: 0, skipped: false }
      }
      const capture = this.capture
      if (capture) {
        capture.size += Buffer.byteLength(ch)
        if (capture.size > MAX_HISTORY_VALUE_BYTES) { capture.text = ''; capture.skipped = true; this.limited = true }
        if (!capture.skipped) capture.text += ch
      }
      if (this.quoted) {
        if (this.readingKey) {
          this.keyBytes += Buffer.byteLength(ch)
          if (this.keyBytes > MAX_HISTORY_KEY_BYTES) {
            this.keyText = ''; this.key = ''; this.readingKey = false; this.limited = true
          } else this.keyText += ch
        }
        if (this.escaped) this.escaped = false
        else if (ch === '\\') this.escaped = true
        else if (ch === '"') {
          this.quoted = false
          if (this.readingKey) {
            try { this.key = JSON.parse(this.keyText) as string } catch { this.key = '' }
            this.readingKey = false; this.keyText = ''; this.keyBytes = 0
          }
        }
        continue
      }
      if (ch === '"') {
        this.quoted = true
        this.readingKey = this.depth === 1 && this.expectsKey
        if (this.readingKey) { this.key = ''; this.keyText = '"'; this.keyBytes = 1 }
      } else if (ch === '{' || ch === '[') {
        if (ch === '[' && this.depth === 1 && this.key === 'messages') this.messages = true
        this.depth++
      } else if (ch === '}' || ch === ']') {
        const closing = this.depth--
        if (capture && closing === capture.depth) {
          if (!capture.skipped) {
            try { this.emit(capture.kind, JSON.parse(capture.text)) } catch { this.limited = true }
          }
          this.capture = undefined
        }
        if (ch === ']' && closing === 2) this.messages = false
      } else if (this.depth === 1 && ch === ':') this.expectsKey = false
      else if (this.depth === 1 && ch === ',') { this.expectsKey = true; this.key = '' }
    }
  }
}

export class JsonLineStream {
  private pending = Buffer.alloc(0)
  private skipping = false
  limited = false
  constructor(private readonly emit: (value: unknown) => void) {}
  private line(bytes: Buffer): void {
    try { this.emit(JSON.parse(bytes.toString('utf8'))) } catch { this.limited = true }
  }
  feed(bytes: Buffer): void {
    let start = 0
    for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, start)) {
      const piece = bytes.subarray(start, end)
      if (!this.skipping && this.pending.length + piece.length <= MAX_HISTORY_VALUE_BYTES) {
        const line = this.pending.length ? Buffer.concat([this.pending, piece]) : piece
        if (line.length && line.toString('utf8').trim()) this.line(line)
      } else this.limited = true
      this.pending = Buffer.alloc(0); this.skipping = false; start = end + 1
    }
    const tail = bytes.subarray(start)
    if (!this.skipping && this.pending.length + tail.length <= MAX_HISTORY_VALUE_BYTES) this.pending = Buffer.concat([this.pending, tail])
    else { this.pending = Buffer.alloc(0); this.skipping = true; this.limited = true }
  }
  eof(): void {
    // A truncated final record may be completed by a later append. Keep just its bounded bytes.
    if (!this.pending.length || this.skipping) return
    try { const raw: unknown = JSON.parse(this.pending.toString('utf8')); this.pending = Buffer.alloc(0); this.emit(raw) } catch { /* Partial tail. */ }
  }
}

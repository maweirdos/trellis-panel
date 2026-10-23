import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { readBounded, writeAtomic } from './files'

/** Codes only. Never accepts arbitrary error text, URLs, message bodies or credentials. */
export class DaemonLog {
  private sequence = 0
  private entries: { sequence: number; at: number; code: string }[] = []
  constructor(private readonly directory: string) {
    const file = join(directory, 'daemon.log.json')
    if (existsSync(file)) {
      this.entries = z.array(z.object({ sequence: z.number().int().positive().safe(), at: z.number().int().nonnegative().safe(), code: z.string().regex(/^[A-Z_]{1,80}$/) }).strict()).max(500).parse(JSON.parse(readBounded(file, 128 * 1024)))
      this.sequence = this.entries.at(-1)?.sequence ?? 0
    }
  }
  append(code: 'DAEMON_STARTED' | 'DAEMON_STOPPING' | 'TRANSPORT_FAILED' | 'REQUEST_REJECTED' | 'SCHEDULER_FAILED'): void {
    this.entries.push({ sequence: ++this.sequence, at: Date.now(), code })
    this.entries = this.entries.slice(-500)
    const file = join(this.directory, 'daemon.log.json')
    const text = JSON.stringify(this.entries)
    if (existsSync(file) && Buffer.byteLength(readBounded(file, 128 * 1024)) + Buffer.byteLength(text) > 128 * 1024) renameSync(file, join(this.directory, 'daemon.log.previous.json'))
    writeAtomic(file, text)
  }
  page(after: number, limit: number): { entries: typeof this.entries; next: number; resetRequired: boolean } {
    const oldest = this.entries[0]?.sequence ?? 1
    const resetRequired = after > this.sequence || after < oldest - 1
    const entries = this.entries.filter((entry) => entry.sequence > (resetRequired ? 0 : after)).slice(0, limit)
    return { entries: structuredClone(entries), next: entries.at(-1)?.sequence ?? this.sequence, resetRequired }
  }
}

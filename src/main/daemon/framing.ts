import { TextDecoder } from 'node:util'
import { DAEMON_LIMITS } from '../../shared/daemon'
import { DaemonError } from './errors'

export function encodeFrame(value: unknown): Buffer {
  const data = Buffer.from(JSON.stringify(value), 'utf8')
  if (!data.length || data.length > DAEMON_LIMITS.frameBytes) throw new DaemonError('E_BUSY', 'Daemon frame exceeds the protocol limit.')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(data.length)
  return Buffer.concat([header, data])
}
export class FrameDecoder {
  private readonly header = Buffer.alloc(4)
  private headerBytes = 0
  private body: Buffer | undefined
  private bodyBytes = 0
  private readonly utf8 = new TextDecoder('utf-8', { fatal: true })
  push(chunk: Buffer, receive: (value: unknown) => void): void {
    // Allocate one bounded body per frame, even when a peer sends it one byte at a time.
    let offset = 0
    while (offset < chunk.length) {
      if (!this.body) {
        const count = Math.min(4 - this.headerBytes, chunk.length - offset)
        chunk.copy(this.header, this.headerBytes, offset, offset + count)
        this.headerBytes += count; offset += count
        if (this.headerBytes < 4) continue
        const size = this.header.readUInt32BE(0)
        if (!size || size > DAEMON_LIMITS.frameBytes) throw new DaemonError('E_INVALID_ARG', 'Invalid daemon frame length.')
        this.body = Buffer.alloc(size); this.bodyBytes = 0
      }
      const body = this.body
      const count = Math.min(body.length - this.bodyBytes, chunk.length - offset)
      chunk.copy(body, this.bodyBytes, offset, offset + count)
      this.bodyBytes += count; offset += count
      if (this.bodyBytes === body.length) {
        const value: unknown = JSON.parse(this.utf8.decode(body))
        this.body = undefined; this.bodyBytes = 0; this.headerBytes = 0
        receive(value)
      }
    }
  }
}

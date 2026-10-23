import { ipcEvent } from '../../../shared/ipc-channels'
import type { RuntimeCursor } from '../../../shared/daemon-runtime'
import { canonicalDirectory } from '../../services/acp/metadata'
const allowed = new Set<string>([ipcEvent.acpOutput, ipcEvent.acpState, ipcEvent.acpDone, ipcEvent.acpPermission])
export type RuntimeObservation = { sequence: number; root: string; channel: string; payload: unknown; reset: boolean }
/** Replay is a bounded delivery cache; ACP archive/native permission maps remain authoritative. */
export class RuntimeEvents {
  private sequence = 0
  private bytes = 0
  private readonly events: Array<RuntimeObservation & { bytes: number }> = []
  private readonly listeners = new Set<(event: RuntimeObservation) => void>()
  constructor(private readonly epoch: string) {}
  publish(channel: string, payload: unknown): void {
    if (!allowed.has(channel) || !payload || typeof payload !== 'object' || !('projectRoot' in payload) || typeof payload.projectRoot !== 'string') return
    const size = Buffer.byteLength(JSON.stringify(payload))
    const event = { sequence: ++this.sequence, root: payload.projectRoot, channel, payload: size <= 96 * 1024 ? payload : null, reset: size > 96 * 1024, bytes: Math.min(size, 96 * 1024) }
    this.events.push(event); this.bytes += event.bytes
    while (this.events.length > 4096 || this.bytes > 8 * 1024 * 1024) this.bytes -= this.events.shift()?.bytes ?? 0
    for (const listener of this.listeners) { try { listener(event) } catch { /* GUI observers never own a turn. */ } }
  }
  observe(listener: (event: RuntimeObservation) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  cursor(): RuntimeCursor { return { epoch: this.epoch, sequence: this.sequence } }
  catchUp(root: string, after: RuntimeCursor | null, limit: number): { cursor: RuntimeCursor; events: RuntimeObservation[]; resetRequired: boolean; hasMore: boolean } {
    const resetRequired = !after || after.epoch !== this.epoch || after.sequence > this.sequence || after.sequence < (this.events[0]?.sequence ?? this.sequence) - 1
    const matching = resetRequired ? [] : this.events.filter(event => event.sequence > (after?.sequence ?? 0) && canonicalDirectory(event.root) === canonicalDirectory(root))
    const selected = matching.slice(0, limit)
    return { cursor: { epoch: this.epoch, sequence: selected.length === limit ? selected.at(-1)?.sequence ?? this.sequence : this.sequence }, events: selected.map(({ bytes: _bytes, ...event }) => event), resetRequired: resetRequired || selected.some(event => event.reset), hasMore: matching.length > selected.length }
  }
}

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { runtimeWireSchema, type RuntimeWire } from '../../../shared/daemon-runtime'
import { DaemonError } from '../errors'
import { readBounded, writeAtomic } from '../files'
import { canonicalWorkflowJson } from '../../../shared/workflow'

const receipt = z.object({ version: z.literal(1), epoch: z.string().uuid(), root: z.string(), method: z.string(), digest: z.string().length(64), state: z.enum(['dispatching', 'completed', 'unknown']), result: runtimeWireSchema.optional() }).strict()
/** Write-ahead dispatch receipts. A lost/restarted result never repeats native writes. */
export class RuntimeCommands {
  private readonly pending = new Map<string, Promise<RuntimeWire>>()
  private readonly pendingRoots = new Map<string, string>()
  constructor(private readonly directory: string, private readonly epoch: string, private readonly assertOwner: () => void) { mkdirSync(directory, { recursive: true }) }
  private path(id: string): string { z.string().uuid().parse(id); return join(this.directory, `${id}.json`) }
  inspect(root: string, id: string, assertReceipt?: (method: string) => void): { state: 'absent' | 'dispatching' | 'completed' | 'unknown'; result?: RuntimeWire } {
    const path = this.path(id)
    if (!existsSync(path)) return { state: 'absent' }
    const value = receipt.parse(JSON.parse(readBounded(path, 160 * 1024)))
    if (value.root !== root) throw new DaemonError('E_DENIED', 'The original runtime command belongs to another workspace.')
    assertReceipt?.(value.method)
    if (value.epoch !== this.epoch) return { state: 'unknown' }
    return { state: value.state, ...(value.result ? { result: value.result } : {}) }
  }
  async run(root: string, id: string, method: string, input: unknown, action: () => Promise<RuntimeWire>): Promise<RuntimeWire> {
    const path = this.path(id), digest = createHash('sha256').update(canonicalWorkflowJson(JSON.parse(JSON.stringify({ method, input })))).digest('hex')
    if (existsSync(path)) {
      const old = receipt.parse(JSON.parse(readBounded(path, 160 * 1024)))
      if (old.root !== root || old.method !== method || old.digest !== digest) throw new DaemonError('E_CONFLICT', 'The runtime command ID was reused with a different request.')
      const pending = this.pending.get(id)
      if (pending) return pending
      if (old.epoch === this.epoch && old.state === 'completed' && old.result) return old.result
      throw new DaemonError('E_UNKNOWN', 'The original runtime dispatch outcome requires inspection; it cannot be recreated.', 'unknown')
    }
    if (readdirSync(this.directory).length >= 2000) throw new DaemonError('E_BUSY', 'Runtime command retention is full. Preserve and reconcile command history before new admission.')
    const intent = { version: 1 as const, epoch: this.epoch, root, method, digest, state: 'dispatching' as const }
    this.assertOwner(); writeAtomic(path, JSON.stringify(intent))
    const promise = (async () => {
      try {
        const result = await action()
        this.assertOwner(); writeAtomic(path, JSON.stringify({ ...intent, state: 'completed', result }))
        return result
      } catch (error) {
        this.assertOwner(); writeAtomic(path, JSON.stringify({ ...intent, state: 'unknown' }))
        throw error
      } finally { this.pending.delete(id); this.pendingRoots.delete(id) }
    })()
    this.pending.set(id, promise)
    this.pendingRoots.set(id, root)
    return promise
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.pending.values()]) }
  count(root?: string): number { return root ? [...this.pendingRoots.values()].filter(value => value === root).length : this.pending.size }
}

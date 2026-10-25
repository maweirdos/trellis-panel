import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RUNTIME_BULK, type RuntimeBlob, type RuntimeWire } from '../../../shared/daemon-runtime'
import { DaemonError } from '../errors'

type Entry = RuntimeBlob & { root: string; offset: number; sealed: boolean; expires: number }
/** Bounded, opaque spool. No client paths, cross-workspace reads or unbounded socket queues. */
export class RuntimeBlobs {
  private readonly entries = new Map<string, Entry>()
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true })
    if (lstatSync(directory).isSymbolicLink()) throw new DaemonError('E_DENIED', 'Runtime spool cannot be redirected.')
    // Only this epoch's transfers are usable. Prior files count against capacity until expired.
    this.sweep()
  }
  private path(id: string): string { return join(this.directory, `${id}.blob`) }
  private assertFile(entry: Entry): void {
    const facts = lstatSync(this.path(entry.id))
    if (!facts.isFile() || facts.isSymbolicLink() || facts.size !== entry.offset) throw new DaemonError('E_DENIED', 'Runtime transfer bytes were changed outside their original owner.')
  }
  private sweep(): void {
    const now = Date.now()
    for (const [id, entry] of this.entries) if (entry.expires <= now) { this.entries.delete(id); if (existsSync(this.path(id))) unlinkSync(this.path(id)) }
    for (const name of readdirSync(this.directory)) if (/^[a-f0-9-]{36}\.blob$/.test(name) && statSync(join(this.directory, name)).mtimeMs + RUNTIME_BULK.ttlMs <= now) unlinkSync(join(this.directory, name))
  }
  private entry(root: string, id: string): Entry {
    this.sweep()
    const entry = this.entries.get(id)
    if (!entry || entry.root !== root) throw new DaemonError('E_DENIED', 'Runtime transfer expired or belongs to another workspace/epoch.')
    return entry
  }
  open(root: string, input: Omit<RuntimeBlob, 'id'>): RuntimeBlob {
    this.sweep()
    const retained = readdirSync(this.directory).filter(name => name.endsWith('.blob')).reduce((total, name) => total + statSync(join(this.directory, name)).size, 0)
    const reserved = [...this.entries.values()].reduce((total, entry) => total + entry.bytes - entry.offset, 0)
    if (this.entries.size >= RUNTIME_BULK.transfers || retained + reserved + input.bytes > RUNTIME_BULK.spoolBytes) throw new DaemonError('E_BUSY', 'Runtime transfer capacity is full; release completed reads and retry.')
    const blob = { id: randomUUID(), ...input }
    writeFileSync(this.path(blob.id), Buffer.alloc(0), { flag: 'wx', mode: 0o600 })
    this.entries.set(blob.id, { ...blob, root, offset: 0, sealed: false, expires: Date.now() + RUNTIME_BULK.ttlMs })
    return blob
  }
  append(root: string, id: string, offset: number, data: string): { offset: number } {
    const entry = this.entry(root, id)
    this.assertFile(entry)
    const bytes = Buffer.from(data, 'base64')
    if (entry.sealed || offset !== entry.offset || bytes.length > RUNTIME_BULK.chunkBytes || bytes.toString('base64') !== data || entry.offset + bytes.length > entry.bytes) throw new DaemonError('E_INVALID_ARG', 'Runtime transfer chunk is invalid, unordered or oversized.')
    appendFileSync(this.path(id), bytes); entry.offset += bytes.length
    return { offset: entry.offset }
  }
  seal(root: string, id: string): RuntimeBlob {
    const entry = this.entry(root, id)
    this.assertFile(entry)
    if (entry.offset !== entry.bytes || createHash('sha256').update(readFileSync(this.path(id))).digest('hex') !== entry.sha256) throw new DaemonError('E_INVALID_ARG', 'Runtime transfer byte count or digest does not match.')
    // FlushFileBuffers on Windows requires a writable handle for the owned spool file.
    const descriptor = openSync(this.path(id), 'r+'); try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
    entry.sealed = true
    return { id, bytes: entry.bytes, sha256: entry.sha256 }
  }
  bytes(root: string, blob: RuntimeBlob): Buffer {
    const entry = this.entry(root, blob.id)
    this.assertFile(entry)
    if (!entry.sealed || entry.bytes !== blob.bytes || entry.sha256 !== blob.sha256) throw new DaemonError('E_DENIED', 'Runtime blob identity does not match the sealed transfer.')
    return readFileSync(this.path(blob.id))
  }
  read(root: string, blob: RuntimeBlob, offset: number): { data: string; next: number; done: boolean } {
    const entry = this.entry(root, blob.id)
    this.assertFile(entry)
    if (!entry.sealed || entry.bytes !== blob.bytes || entry.sha256 !== blob.sha256) throw new DaemonError('E_DENIED', 'Runtime blob identity does not match the sealed transfer.')
    if (offset > entry.bytes) throw new DaemonError('E_INVALID_ARG', 'Runtime transfer offset exceeds its body.')
    const chunk = Buffer.alloc(Math.min(RUNTIME_BULK.chunkBytes, entry.bytes - offset))
    const descriptor = openSync(this.path(blob.id), 'r')
    let count: number
    try { count = readSync(descriptor, chunk, 0, chunk.length, offset) } finally { closeSync(descriptor) }
    const next = offset + count
    return { data: chunk.subarray(0, count).toString('base64'), next, done: next === entry.bytes }
  }
  release(root: string, id: string): null { this.entry(root, id); unlinkSync(this.path(id)); this.entries.delete(id); return null }
  unpack(root: string, wire: RuntimeWire): unknown {
    if ('blob' in wire) return JSON.parse(this.bytes(root, wire.blob).toString('utf8'))
    const serialized = JSON.stringify(wire.inline)
    if (serialized === undefined || Buffer.byteLength(serialized) > RUNTIME_BULK.chunkBytes) throw new DaemonError('E_INVALID_ARG', 'Use a bounded runtime blob for this request.')
    return wire.inline
  }
  pack(root: string, value: unknown): RuntimeWire {
    let size = 2, nodes = 0
    const serialized = JSON.stringify(value ?? null, (key, item: unknown) => {
      // Bound serialization itself, before allocating an arbitrarily large JSON string.
      if (++nodes > 1_000_000) throw new DaemonError('E_BUSY', 'Pinned runtime result exceeds the serialization bound.')
      if (key.length > 4096) throw new DaemonError('E_BUSY', 'Runtime result field name exceeds its serialization bound.')
      size += Buffer.byteLength(JSON.stringify(key)) + 4
      if (typeof item === 'string') {
        if (Buffer.byteLength(item) > RUNTIME_BULK.valueBytes) throw new DaemonError('E_BUSY', 'Pinned runtime string exceeds transfer capacity.')
        size += Buffer.byteLength(JSON.stringify(item))
      } else if (typeof item === 'number' || typeof item === 'boolean') size += String(item).length
      if (size > RUNTIME_BULK.valueBytes) throw new DaemonError('E_BUSY', 'Pinned runtime result exceeds transfer capacity; request a smaller page.')
      return item
    })
    if (serialized === undefined) throw new DaemonError('E_INVALID_ARG', 'Runtime result is not a JSON value.')
    const bytes = Buffer.from(serialized)
    if (bytes.length <= RUNTIME_BULK.chunkBytes) return { inline: value ?? null }
    if (bytes.length > RUNTIME_BULK.valueBytes) throw new DaemonError('E_BUSY', 'Pinned runtime result exceeds transfer capacity; request a smaller history page.')
    const blob = this.open(root, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    for (let offset = 0; offset < bytes.length; offset += RUNTIME_BULK.chunkBytes) this.append(root, blob.id, offset, bytes.subarray(offset, offset + RUNTIME_BULK.chunkBytes).toString('base64'))
    return { blob: this.seal(root, blob.id) }
  }
}

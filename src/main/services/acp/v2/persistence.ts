import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SessionConfigOption } from '@agentclientprotocol/sdk/experimental/v2'
import { z } from 'zod'

const uuid = z.string().uuid()
const recordSchema = z.object({
  schemaVersion: z.literal(2),
  recordId: uuid,
  sessionKey: z.string().min(1).max(1000),
  cwd: z.string().min(1).max(4096),
  launch: z.object({ argv: z.array(z.string()).max(256), envDigest: z.string().length(64) }),
  negotiated: z.object({ protocolVersion: z.literal(2), agent: z.object({ name: z.string(), title: z.string().nullable(), version: z.string() }).strict(), capabilities: z.record(z.string(), z.unknown()) }).strict(),
  nativeSessionId: z.string().min(1).max(1000),
  agentSessionId: z.string().min(1).max(1000).optional(),
  replayCursor: z.string().max(4096).optional(),
  configOptions: z.array(z.custom<SessionConfigOption>(value => typeof value === 'object' && value !== null && 'configId' in value && 'name' in value)),
  aggregate: z.object({
    messages: z.array(z.object({ nativeId: z.string().min(1), revision: z.string().min(1), value: z.unknown() })),
    toolCalls: z.array(z.object({ nativeId: z.string().min(1), revision: z.string().min(1), value: z.unknown() })),
    plans: z.array(z.object({ nativeId: z.string().min(1), revision: z.string().min(1), value: z.unknown() })),
    terminal: z.array(z.object({ nativeId: z.string().min(1), revision: z.string().min(1), value: z.unknown() })),
    sessionInfo: z.array(z.object({ nativeId: z.string().min(1), revision: z.string().min(1), value: z.unknown() })),
    notices: z.array(z.object({ nativeId: z.string().min(1), revision: z.string().min(1), value: z.unknown() })),
    revisionOrder: z.array(z.string().min(1)).max(256),
    replayCursor: z.string().min(1).max(4096).optional(),
  }).strict(),
  cleanupState: z.enum(['live', 'closed', 'uncertain']),
  updatedAt: z.number().int().nonnegative(),
}).strict()

export type AcpV2NativeRecord = z.infer<typeof recordSchema>
export type AcpV2NativeRecordInput = AcpV2NativeRecord
export interface AcpV2NativeAggregate {
  readonly messages: Array<{ nativeId: string; revision: string; value: unknown }>
  readonly toolCalls: Array<{ nativeId: string; revision: string; value: unknown }>
  readonly plans: Array<{ nativeId: string; revision: string; value: unknown }>
  readonly terminal: Array<{ nativeId: string; revision: string; value: unknown }>
  readonly sessionInfo: Array<{ nativeId: string; revision: string; value: unknown }>
  readonly notices: Array<{ nativeId: string; revision: string; value: unknown }>
  readonly revisionOrder: string[]
  readonly replayCursor?: string
}

export const emptyAggregate = (): AcpV2NativeAggregate => ({ messages: [], toolCalls: [], plans: [], terminal: [], sessionInfo: [], notices: [], revisionOrder: [] })

export interface AcpV2NativeStore {
  load(recordId: string): Promise<AcpV2NativeRecord | undefined>
  loadSync?(recordId: string): AcpV2NativeRecord | undefined
  save(record: AcpV2NativeRecord): Promise<void>
  delete(recordId: string): Promise<void>
  setCleanupState(recordId: string, state: AcpV2NativeRecord['cleanupState']): Promise<void>
}

export const argvIdentity = (argv: readonly string[]): string =>
  argv.map(value => /^[A-Za-z0-9_@%+=:,./^~-]+$/u.test(value) ? value : JSON.stringify(value)).join(' ')

export const envDigest = (env: Readonly<Record<string, string>>): string =>
  createHash('sha256').update(JSON.stringify([...Object.entries(env)].sort(([left], [right]) => left.localeCompare(right)))).digest('hex')

export class AcpV2FileStore implements AcpV2NativeStore {
  constructor(private readonly stateDir: string) {}

  list(limit: number): AcpV2NativeRecord[] {
    if (!existsSync(this.stateDir)) return []
    const records: AcpV2NativeRecord[] = []
    for (const name of readdirSync(this.stateDir)) {
      if (!name.endsWith('.json')) continue
      const record = this.loadSync(name.slice(0, -5))
      if (record !== undefined) records.push(record)
      if (records.length >= limit) break
    }
    return records.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit)
  }

  async load(recordId: string): Promise<AcpV2NativeRecord | undefined> {
    return this.loadSync(recordId)
  }

  loadSync(recordId: string): AcpV2NativeRecord | undefined {
    const path = this.path(recordId)
    if (!existsSync(path)) return undefined
    return recordSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  }

  async save(record: AcpV2NativeRecord): Promise<void> {
    const path = this.path(record.recordId)
    mkdirSync(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(record), 'utf8')
    renameSync(temporary, path)
  }

  async delete(recordId: string): Promise<void> {
    const path = this.path(recordId)
    if (!existsSync(path)) return
    renameSync(path, `${path}.deleted-${Date.now()}`)
  }

  async setCleanupState(recordId: string, cleanupState: AcpV2NativeRecord['cleanupState']): Promise<void> {
    const record = await this.load(recordId)
    if (record) await this.save({ ...record, cleanupState, updatedAt: Date.now() })
  }

  private path(recordId: string): string {
    return join(this.stateDir, `${uuid.parse(recordId)}.json`)
  }
}

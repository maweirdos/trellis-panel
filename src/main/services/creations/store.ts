import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { creationCommandSchema, creationCommandReplySchema, creationRecordSchema, type CreationRecord, type CreationCommand, type CreationCommandReply } from '../../../shared/creations'

const pendingSchema = z.object({
  workspaceKey: z.string().min(1), connectionId: z.string().uuid(), actorId: z.string().min(1),
  projectId: z.string().min(1).optional(),
  epoch: z.string().optional(), instanceId: z.string().optional(), origin: z.string().optional(),
  command: creationCommandSchema, recordedAt: z.number().int().nonnegative()
}).strict()
export type PendingCreation = z.infer<typeof pendingSchema>
const fileLimit = 17 * 1024 * 1024
const totalLimit = 64 * 1024 * 1024
const recordLimit = 256
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const receiptSchema = z.object({ commandId: z.string().uuid(), payloadDigest: z.string(), reply: creationCommandReplySchema }).strict()
const envelopeSchema = z.object({ record: creationRecordSchema, receipts: z.array(receiptSchema).max(64) }).strict()
type Envelope = z.infer<typeof envelopeSchema>

/** Private app-owned files. HTML never enters the general collaboration snapshot. */
export class CreationLocalStore {
  private readonly records = new Map<string, Envelope>()
  private loaded: Promise<void> | null = null
  constructor(private readonly root: string) {}
  private directory(): string { return join(this.root, 'creations', 'local') }
  private async atomic(path: string, value: unknown): Promise<void> {
    const body = JSON.stringify(value)
    if (Buffer.byteLength(body) > fileLimit) throw new Error('创作存储超过限额，请减少历史修订或拆分作品')
    await mkdir(join(path, '..'), { recursive: true })
    const temporary = `${path}.tmp`
    await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  }
  private async load(): Promise<void> {
    if (!this.loaded) this.loaded = (async () => {
      await mkdir(this.directory(), { recursive: true })
      const names = (await readdir(this.directory())).filter((name) => /^[a-f0-9-]{36}\.json$/i.test(name))
      if (names.length > recordLimit) throw new Error('本机创作数量超过限额，请先整理作品')
      let total = 0
      const records = new Map<string, Envelope>()
      for (const name of names) {
        const path = join(this.directory(), name), info = await stat(path)
        total += info.size
        if (!info.isFile() || info.size > fileLimit || total > totalLimit) throw new Error('本机创作存储超过读取限额，原文件已保留')
        const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
        const parsed = envelopeSchema.safeParse(raw)
        const value: Envelope = parsed.success ? parsed.data : { record: creationRecordSchema.parse(raw), receipts: [] }
        if (`${value.record.creationId}.json` !== name || value.record.projectId !== 'local') throw new Error('本机创作身份与文件不一致，原文件已保留')
        records.set(value.record.creationId, value)
      }
      for (const [id, value] of records) this.records.set(id, value)
    })().catch((error: unknown) => { this.loaded = null; throw error })
    return this.loaded
  }
  async list(): Promise<CreationRecord[]> { await this.load(); return [...this.records.values()].map((value) => structuredClone(value.record)) }
  async get(id: string): Promise<CreationRecord | null> { await this.load(); const value = this.records.get(id); return value ? structuredClone(value.record) : null }
  async receipt(command: CreationCommand): Promise<CreationCommandReply | null> {
    await this.load()
    const value = this.records.get(command.creationId)?.receipts.find((entry) => entry.commandId === command.commandId)
    if (!value) return null
    if (value.payloadDigest !== hash(JSON.stringify(command))) throw new Error('原操作标识已用于不同内容，请核对原保存结果')
    return { ...structuredClone(value.reply), status: 'duplicate' }
  }
  async save(raw: CreationRecord, command: CreationCommand, reply: CreationCommandReply): Promise<void> {
    await this.load()
    const record = creationRecordSchema.parse(raw)
    if ([...this.records.keys()].some((id) => id !== record.creationId && id.toLowerCase() === record.creationId.toLowerCase())) throw new Error('创作身份大小写与已有文件冲突，原作品已保留')
    if (!this.records.has(record.creationId) && this.records.size >= recordLimit) throw new Error('本机创作数量超过限额，请先整理作品')
    const receipts = [...(this.records.get(record.creationId)?.receipts ?? []), { commandId: command.commandId, payloadDigest: hash(JSON.stringify(command)), reply }].slice(-64)
    const envelope = envelopeSchema.parse({ record, receipts })
    const otherBytes = [...this.records.values()].filter((item) => item.record.creationId !== record.creationId).reduce((size, item) => size + Buffer.byteLength(JSON.stringify(item)), 0)
    if (otherBytes + Buffer.byteLength(JSON.stringify(envelope)) > totalLimit) throw new Error('本机创作存储已满，请拆分或整理作品')
    await this.atomic(join(this.directory(), `${record.creationId}.json`), envelope)
    this.records.set(record.creationId, structuredClone(envelope))
  }
  private pendingPath(workspaceKey: string, actorId: string, creationId: string): string {
    return join(this.root, 'creations', 'pending', `${hash(JSON.stringify([workspaceKey, actorId, creationId]))}.json`)
  }
  async pending(workspaceKey: string, actorId: string, creationId: string): Promise<PendingCreation | null> {
    const path = this.pendingPath(workspaceKey, actorId, creationId)
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size > fileLimit) throw new Error('创作原操作记录无法核对，原文件已保留')
      const value = pendingSchema.parse(JSON.parse(await readFile(path, 'utf8')))
      if (value.workspaceKey !== workspaceKey || value.actorId !== actorId || value.command.creationId !== creationId) throw new Error('创作原操作记录不属于当前来源')
      return value
    } catch (error) { if (isMissing(error)) return null; throw error }
  }
  async reserve(value: PendingCreation): Promise<void> { await this.atomic(this.pendingPath(value.workspaceKey, value.actorId, value.command.creationId), pendingSchema.parse(value)) }
  async settle(value: PendingCreation): Promise<void> {
    try { await unlink(this.pendingPath(value.workspaceKey, value.actorId, value.command.creationId)) }
    catch (error) { if (!isMissing(error)) throw error }
  }
}

export function sameCreationCommand(left: CreationCommand, right: CreationCommand): boolean { return JSON.stringify(left) === JSON.stringify(right) }
function isMissing(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT' }

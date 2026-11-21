import { join } from 'node:path'
import { z } from 'zod'
import { feishuConnectionSchema, feishuReceiptSchema } from '../../shared/feishu-integration'
import { workspaceGrantSchema } from '../../shared/daemon/identity'
import { protectSecret, revealSecret } from '../services/integrations/credentials'
import { readBounded, writeAtomic } from './files'
import { DaemonError } from './errors'

const connectionSchema = z.object({
  view: feishuConnectionSchema.omit({ lastOperation: true, pendingOperations: true }),
  secret: z.string().min(1).max(1024),
  botOpenId: z.string().min(1).max(256).nullable(),
  installerOpenId: z.string().min(1).max(256).nullable().optional(),
  grant: workspaceGrantSchema.nullable()
}).strict()
const receiptSchema = feishuReceiptSchema.extend({
  connectionId: z.string().uuid(),
  tenantKey: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  chatId: z.string().regex(/^oc_[A-Za-z0-9_-]{1,120}$/),
  installerOpenId: z.string().regex(/^ou_[A-Za-z0-9_-]{1,120}$/).optional(),
  senderOpenId: z.string().regex(/^ou_[A-Za-z0-9_-]{1,120}$/).optional(),
  bindingId: z.string().uuid().optional()
}).strict()
const stateSchema = z.object({
  version: z.literal(1),
  connections: z.array(connectionSchema).max(50),
  account: z.object({
    appId: z.string(), openId: z.string(), unionId: z.string().optional(), tenantKey: z.string().optional(), displayName: z.string().max(256)
  }).strict().nullable(),
  receipts: z.record(z.string().regex(/^[a-f0-9]{64}$/), receiptSchema),
  pendingRegistrations: z.record(z.string().regex(/^[a-f0-9]{64}$/), z.object({
    id: z.string().uuid(),
    expiresAt: z.number().int().nonnegative().safe(),
    phase: z.enum(['pending', 'committing', 'unknown']).optional(),
    grant: workspaceGrantSchema.nullable().optional(),
    scopeKey: z.string().min(1).max(1024).optional()
  }).strict()).default({})
}).strict()
export type StoredFeishuConnection = z.infer<typeof connectionSchema>
export type FeishuState = z.infer<typeof stateSchema>
const MAX_BYTES = 4 * 1024 * 1024

export class FeishuStateOwner {
  private readonly file: string
  private current: FeishuState | null = null

  constructor(directory: string, private readonly assertOwner: () => void) {
    this.file = join(directory, 'feishu-workspace-v1.protected.json')
  }

  read(): FeishuState {
    this.assertOwner()
    if (this.current) return this.current
    let content: string
    try { content = readBounded(this.file, MAX_BYTES) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return this.current = { version: 1, connections: [], account: null, receipts: {}, pendingRegistrations: {} }
    }
    try {
      const outer = z.object({ version: z.literal(1), ciphertext: z.string().min(1) }).strict().parse(JSON.parse(content))
      this.current = stateSchema.parse(JSON.parse(revealSecret(outer.ciphertext)))
      return this.current
    } catch {
      throw new DaemonError('E_IO', '飞书配置无法读取。原记录已保留。')
    }
  }

  update(mutation: (draft: FeishuState) => void): void {
    const draft = structuredClone(this.read())
    mutation(draft)
    const checked = stateSchema.parse(draft)
    const content = JSON.stringify({ version: 1, ciphertext: protectSecret(JSON.stringify(checked)) })
    if (Buffer.byteLength(content) > MAX_BYTES) throw new DaemonError('E_IO', '飞书配置已达到存储上限。')
    this.assertOwner()
    writeAtomic(this.file, content, { retryWindowsRename: true })
    this.current = checked
  }
}

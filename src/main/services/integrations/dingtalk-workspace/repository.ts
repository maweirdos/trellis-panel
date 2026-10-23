import { existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { dingAppSchema, dingAccountSchema, dingAssistantSchema, dingInboxSchema, dingDeliverySchema, dingNotificationSchema, dingPreviewSchema, dingWorkspaceGrantSchema, dingPolicySchema } from '../../../../shared/dingtalk-integration'
import { readBounded, writeAtomic } from '../../../daemon/files'
import { IntegrationError } from '../types'
import type { DingTalkProtectionPort } from './ports'

export const dingMessageSchema = z.object({
  msgId: z.string().min(1).max(256), chatbotCorpId: z.string().min(1).max(256),
  senderCorpId: z.string().min(1).max(256), senderStaffId: z.string().min(1).max(256),
  conversationId: z.string().min(1).max(256), conversationType: z.enum(['1', '2']),
  robotCode: z.string().min(1).max(256), msgtype: z.literal('text'),
  text: z.object({ content: z.string().min(1).max(16000) }), createAt: z.number().int().nonnegative().safe(),
  sessionWebhook: z.string().max(8192).optional(), sessionWebhookExpiredTime: z.number().int().nonnegative().safe().optional()
})
const inbox = dingInboxSchema.extend({ message: dingMessageSchema, digest: z.string().length(64), commandId: z.string().uuid(), taskOperationId: z.string().uuid().nullable(), deadline: z.number().int().nonnegative().safe(), workspace: dingWorkspaceGrantSchema, policy: dingPolicySchema })
const stateSchema = z.object({
  version: z.literal(1), apps: z.array(dingAppSchema.extend({ secret: z.string().max(4096) })).max(50),
  accounts: z.array(dingAccountSchema).max(100), assistants: z.array(dingAssistantSchema).max(100),
  notifications: z.array(dingNotificationSchema).max(50), inbox: z.array(inbox).max(10000),
  previews: z.array(dingPreviewSchema.extend({ nativeSubject: z.string().max(256) })).max(100),
  deliveries: z.array(dingDeliverySchema.extend({ nativeSubject: z.string().max(256), previewId: z.string().uuid() })).max(10000),
  authorizations: z.array(z.object({ id: z.string().uuid(), nativeSubject: z.string().max(256), appId: z.string().uuid(), appRevision: z.number().int(), expiresAt: z.number().int(), state: z.enum(['pending', 'claimed', 'unknown']), requestId: z.string().uuid() }).strict()).max(100)
}).strict()
export type DingState = z.infer<typeof stateSchema>
export type StoredInbox = DingState['inbox'][number]
export type DingMessage = z.infer<typeof dingMessageSchema>
export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** One repository in the leased daemon. All provider records, including incoming
 * business text and OAuth state, use the native OS protection port. No browser or
 * unencrypted fallback, no competing GUI cache and no pruning dedup identities. */
export class DingTalkRepository {
  private readonly path: string
  private cached: { stamp: string; state: DingState } | undefined
  constructor(directory: string, private readonly protection: DingTalkProtectionPort, private readonly assertOwner: () => void) { this.path = join(directory, 'dingtalk-workspace-v1.protected.json') }
  read(): DingState {
    this.assertOwner()
    if (!existsSync(this.path)) return { version: 1, apps: [], accounts: [], assistants: [], notifications: [], inbox: [], previews: [], deliveries: [], authorizations: [] }
    try {
      const entry = lstatSync(this.path)
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Invalid protected record')
      const stamp = `${entry.dev}:${entry.ino}:${entry.size}:${entry.mtimeMs}:${entry.ctimeMs}`
      if (this.cached?.stamp === stamp) return structuredClone(this.cached.state)
      const envelope = z.object({ version: z.literal(1), ciphertext: z.string().max(32 * 1024 * 1024) }).strict().parse(JSON.parse(readBounded(this.path, 32 * 1024 * 1024)))
      const clear = this.protection.reveal(envelope.ciphertext)
      if (Buffer.byteLength(clear) > 16 * 1024 * 1024) throw new Error('capacity')
      const state = stateSchema.parse(JSON.parse(clear))
      const after = lstatSync(this.path)
      if (`${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}` !== stamp) throw new Error('Protected record changed during read')
      this.cached = { stamp, state }
      return structuredClone(state)
    } catch { throw new IntegrationError('钉钉受保护状态不可读、损坏或版本不兼容；原文件已保留，请检查系统凭据访问', 'io') }
  }
  /** No timer/SDK/key work when DingTalk has never been configured. */
  hasBackgroundWork(): boolean {
    this.assertOwner()
    if (!existsSync(this.path)) return false
    const state = this.read()
    return state.assistants.some(item => item.enabled)
      || state.inbox.some(item => ['received', 'processing'].includes(item.state) || item.reply === 'dispatching' || Boolean(item.execution && ['pending', 'admitted', 'unknown'].includes(item.execution.state)))
      || state.deliveries.some(item => ['prepared', 'dispatching'].includes(item.state))
  }
  change<T>(mutate: (state: DingState) => T): T {
    const state = this.read(), result = mutate(state)
    const clear = JSON.stringify(stateSchema.parse(state))
    if (Buffer.byteLength(clear) > 16 * 1024 * 1024) throw new IntegrationError('钉钉消息账本已达容量上限，接收已停止；不能遗忘原消息后重新执行', 'io')
    const text = JSON.stringify({ version: 1, ciphertext: this.protection.protect(clear) })
    if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw new IntegrationError('钉钉受保护状态超过容量限制', 'io')
    this.assertOwner(); writeAtomic(this.path, text); this.cached = undefined
    return structuredClone(result)
  }
}

import { isUtf8 } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { constants, realpathSync, statSync } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  ConversationAttachmentBytesInputSchema,
  ConversationAttachmentIdsSchema,
  ConversationAttachmentIdSchema,
  conversationAttachmentLimitError,
  type ConversationAttachmentBytesInput,
  type ConversationAttachmentClaimInput,
  type ConversationAttachmentContent,
  type ConversationAttachmentLimits,
  type ConversationAttachmentLocator,
  type StagedConversationAttachment,
} from '../../../../shared/conversation/attachments'
import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  isProviderSendTurnSupportedImageMimeType,
  type ChatAttachment,
} from '../../../../shared/conversation/chatAttachment'
import { DaemonError } from '../../../daemon/errors'
import { CONVERSATION_ATTACHMENT_DDL } from './schema'

export interface ConversationAttachmentThreadScope {
  readonly ownerId: string
  readonly spaceId: string
  readonly root: string
}

export interface ConversationAttachmentDraftScope extends ConversationAttachmentThreadScope {
  readonly draftId: string
}

interface ContentRow {
  readonly content_id: string
  readonly kind: 'image' | 'file'
  readonly name: string
  readonly mime_type: string
  readonly size_bytes: number
  readonly sha256: string
  readonly pasted_text: 0 | 1
}

interface ClaimRow extends ContentRow {
  readonly attachment_id: string
  readonly source_attachment_id: string
  readonly owner_id: string
  readonly space_id: string
  readonly root_key: string
  readonly draft_id: string
}

const DRAFT_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000
const DRAFT_SWEEP_INTERVAL_MS = 15 * 60 * 1000
const fileMimes: Readonly<Record<string, string>> = {
  '.csv': 'text/csv', '.json': 'application/json', '.md': 'text/markdown', '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml', '.txt': 'text/plain', '.xml': 'application/xml', '.zip': 'application/zip',
  '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
}
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')

function rasterMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(pngSignature)) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  const gifHeader = bytes.toString('latin1', 0, 6)
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') return 'image/gif'
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
}

function scopeId(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || value.includes('\0')) {
    throw new DaemonError('E_INVALID_ARG', '附件范围或目标无效。')
  }
  return value
}

function threadScope(scope: ConversationAttachmentThreadScope) {
  const ownerId = scopeId(scope.ownerId)
  const spaceId = scopeId(scope.spaceId)
  if (typeof scope.root !== 'string' || !isAbsolute(scope.root)) throw new DaemonError('E_DENIED', '附件缺少已授权的工程根。')
  try {
    const root = realpathSync.native(scope.root)
    const identity = statSync(root, { bigint: true })
    if (!identity.isDirectory()) throw new Error('Expected a directory.')
    const pathKey = process.platform === 'win32' ? root.toLowerCase() : root
    return [ownerId, spaceId, JSON.stringify([pathKey, String(identity.dev), String(identity.ino)])] as const
  } catch {
    throw new DaemonError('E_DENIED', '附件的原工程根当前不可用。')
  }
}

function draftScope(scope: ConversationAttachmentDraftScope) {
  return [...threadScope(scope), scopeId(scope.draftId)] as const
}

function toAttachment(content: ContentRow, id = content.content_id): ChatAttachment {
  const { kind: type, name, mime_type: mimeType, size_bytes: sizeBytes } = content
  return {
    id, type, name, mimeType, sizeBytes,
    ...(type === 'file' && content.pasted_text ? { source: { _tag: 'pasted-text' as const } } : {}),
  }
}

function checkedBytes(row: ContentRow & { bytes: Uint8Array }, id: string): ConversationAttachmentContent {
  if (row.bytes.byteLength !== row.size_bytes || sha256(row.bytes) !== row.sha256) {
    throw new DaemonError('E_IO', '附件内容无法通过完整性校验。')
  }
  return { attachment: toAttachment(row, id), sha256: row.sha256, bytes: row.bytes }
}

export async function readHostConversationAttachmentFile(selectedPath: string): Promise<ConversationAttachmentBytesInput> {
  if (!isAbsolute(selectedPath)) throw new DaemonError('E_INVALID_ARG', '文件选择结果无效。')
  try {
    const canonicalPath = await realpath(selectedPath)
    const selected = await stat(canonicalPath, { bigint: true })
    if (!selected.isFile() || selected.size <= 0n || selected.size > BigInt(PROVIDER_SEND_TURN_MAX_FILE_BYTES)) {
      throw new DaemonError('E_INVALID_ARG', '请选择可读取、非空且不超过 50 MiB 的文件。')
    }
    const handle = await open(canonicalPath, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK))
    try {
      const opened = await handle.stat({ bigint: true })
      if (!opened.isFile() || opened.dev !== selected.dev || opened.ino !== selected.ino || opened.size !== selected.size) {
        throw new DaemonError('E_CONFLICT', '文件在打开之前发生了变化。')
      }
      const bytes = Buffer.alloc(Number(opened.size))
      let offset = 0
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      const final = await handle.stat({ bigint: true })
      if (offset !== bytes.length || final.size !== opened.size || final.mtimeNs !== opened.mtimeNs || final.ctimeNs !== opened.ctimeNs) {
        throw new DaemonError('E_CONFLICT', '文件在读取时发生了变化。')
      }
      return { name: basename(selectedPath), bytes }
    } finally {
      await handle.close()
    }
  } catch (cause) {
    if (cause instanceof DaemonError) throw cause
    throw new DaemonError('E_IO', '无法读取所选文件。')
  }
}

export class ConversationAttachmentStore {
  private lastSweepAt = 0

  constructor(private readonly database: DatabaseSync) {
    this.transaction(() => database.exec(CONVERSATION_ATTACHMENT_DDL))
    this.sweepExpired()
  }

  stageBytes(scope: ConversationAttachmentDraftScope, input: ConversationAttachmentBytesInput, limits?: ConversationAttachmentLimits): StagedConversationAttachment {
    return this.storeBytes(draftScope(scope), input, limits)
  }

  async stageHostFile(scope: ConversationAttachmentDraftScope, selectedPath: string, limits?: ConversationAttachmentLimits): Promise<StagedConversationAttachment> {
    const binding = draftScope(scope)
    const input = await readHostConversationAttachmentFile(selectedPath)
    const currentBinding = draftScope(scope)
    if (binding.some((value, index) => value !== currentBinding[index])) {
      throw new DaemonError('E_DENIED', '读取时附件的原工程根发生了变化。')
    }
    return this.storeBytes(binding, input, limits)
  }

  previewClaim(scope: ConversationAttachmentDraftScope, input: ConversationAttachmentClaimInput, limits?: ConversationAttachmentLimits): readonly ChatAttachment[] {
    return this.resolveClaim(draftScope(scope), input, limits).attachments
  }

  /** Join the command transaction on this same connection. A rollback preserves the draft. */
  claim(scope: ConversationAttachmentDraftScope, input: ConversationAttachmentClaimInput, limits?: ConversationAttachmentLimits): readonly ChatAttachment[] {
    if (!this.database.isTransaction) throw new Error('Attachment claims require the conversation command transaction.')
    const binding = draftScope(scope)
    const result = this.resolveClaim(binding, input, limits)
    if (result.existing) return result.attachments
    const insert = this.database.prepare(`INSERT INTO conversation_v2_attachment_claims
      (attachment_id, thread_id, claim_id, ordinal, content_id, source_attachment_id, owner_id, space_id, root_key, draft_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const [ordinal, content] of result.contents.entries()) {
      insert.run(result.attachments[ordinal].id, input.threadId, input.claimId, ordinal,
        content.content_id, input.attachmentIds[ordinal], ...binding)
    }
    return result.attachments
  }

  readClaimed(scope: ConversationAttachmentThreadScope, input: ConversationAttachmentLocator): ConversationAttachmentContent | null {
    const binding = threadScope(scope)
    if (!ConversationAttachmentIdSchema.safeParse(input.attachmentId).success || !this.assertThreadScope(binding, input.threadId)) return null
    const row = this.database.prepare(`SELECT content.* FROM conversation_v2_attachment_claims claim
      JOIN conversation_v2_attachment_content content ON content.content_id = claim.content_id
      WHERE claim.attachment_id = ? AND claim.thread_id = ? AND claim.owner_id = ? AND claim.space_id = ? AND claim.root_key = ?`)
      .get(input.attachmentId, input.threadId, ...binding) as (ContentRow & { bytes: Uint8Array }) | undefined
    return row ? checkedBytes(row, input.attachmentId) : null
  }

  readDraft(scope: ConversationAttachmentDraftScope, attachmentId: string): ConversationAttachmentContent | null {
    if (!ConversationAttachmentIdSchema.safeParse(attachmentId).success) return null
    const row = this.database.prepare(`SELECT content.* FROM conversation_v2_attachment_drafts draft
      JOIN conversation_v2_attachment_content content ON content.content_id = draft.content_id
      WHERE draft.content_id = ? AND draft.owner_id = ? AND draft.space_id = ? AND draft.root_key = ? AND draft.draft_id = ? AND draft.expires_at > ?`)
      .get(attachmentId, ...draftScope(scope), Date.now()) as (ContentRow & { bytes: Uint8Array }) | undefined
    return row ? checkedBytes(row, attachmentId) : null
  }

  listDraft(scope: ConversationAttachmentDraftScope): readonly StagedConversationAttachment[] {
    const rows = this.database.prepare(`SELECT content.content_id, content.kind, content.name, content.mime_type, content.size_bytes,
      content.sha256, content.pasted_text, draft.expires_at
      FROM conversation_v2_attachment_drafts draft JOIN conversation_v2_attachment_content content ON content.content_id = draft.content_id
      WHERE draft.owner_id = ? AND draft.space_id = ? AND draft.root_key = ? AND draft.draft_id = ? AND draft.expires_at > ?
      ORDER BY draft.rowid`)
      .all(...draftScope(scope), Date.now()) as unknown as (ContentRow & { expires_at: number })[]
    return rows.map(row => ({ ...toAttachment(row), sha256: row.sha256, expiresAt: row.expires_at }))
  }

  releaseDraft(scope: ConversationAttachmentDraftScope, attachmentId: string): boolean {
    if (!ConversationAttachmentIdSchema.safeParse(attachmentId).success) return false
    const binding = draftScope(scope)
    return this.transaction(() => {
      const result = this.database.prepare(`DELETE FROM conversation_v2_attachment_drafts
        WHERE content_id = ? AND owner_id = ? AND space_id = ? AND root_key = ? AND draft_id = ?`)
        .run(attachmentId, ...binding)
      if (result.changes) this.removeUnheldContent(attachmentId)
      return Boolean(result.changes)
    })
  }

  releaseDeletedThreadClaims(threadId: string): void {
    if (!this.database.isTransaction) throw new Error('Deleted thread claims require the cleanup transaction.')
    const claims = this.database.prepare(`DELETE FROM conversation_v2_attachment_claims
      WHERE thread_id = ? AND EXISTS (SELECT 1 FROM conversation_v2_projection_threads
        WHERE thread_id = ? AND deleted_at IS NOT NULL)
      RETURNING content_id`).all(threadId, threadId) as { content_id: string }[]
    const removeExpiredDraft = this.database.prepare(`DELETE FROM conversation_v2_attachment_drafts
      WHERE content_id = ? AND expires_at <= ?`)
    const now = Date.now()
    for (const contentId of new Set(claims.map(claim => claim.content_id))) {
      removeExpiredDraft.run(contentId, now)
      this.removeUnheldContent(contentId)
    }
  }

  sweepExpired(): void {
    const now = Date.now()
    this.transaction(() => {
      this.database.prepare('DELETE FROM conversation_v2_attachment_drafts WHERE expires_at <= ?').run(now)
      this.removeUnheldContent()
    })
    this.lastSweepAt = now
  }

  private storeBytes(binding: ReturnType<typeof draftScope>, input: ConversationAttachmentBytesInput, limits?: ConversationAttachmentLimits): StagedConversationAttachment {
    const parsed = ConversationAttachmentBytesInputSchema.safeParse(input)
    if (!parsed.success || parsed.data.name === '.' || parsed.data.name === '..') {
      throw new DaemonError('E_INVALID_ARG', '附件名称或大小无效。')
    }
    const { name, source } = parsed.data
    const bytes = Buffer.from(parsed.data.bytes)
    const claimedMime = parsed.data.mimeType?.split(';', 1)[0].trim().toLowerCase() || fileMimes[extname(name).toLowerCase()]
    const detectedMime = rasterMime(bytes)
    if ((claimedMime && isProviderSendTurnSupportedImageMimeType(claimedMime) && claimedMime !== detectedMime)
      || (!detectedMime && claimedMime?.startsWith('image/') && claimedMime !== 'image/svg+xml')) {
      throw new DaemonError('E_INVALID_ARG', '图片格式不受支持或与文件内容不一致。')
    }
    if (source && (detectedMime || !isUtf8(bytes) || bytes.includes(0))) {
      throw new DaemonError('E_INVALID_ARG', '粘贴内容必须是有效的 UTF-8 文本。')
    }
    const mime = claimedMime && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(claimedMime) ? claimedMime : 'application/octet-stream'
    const content: ContentRow = {
      content_id: `pending_${randomUUID()}`, name, sha256: sha256(bytes), size_bytes: bytes.length,
      kind: detectedMime ? 'image' : 'file', mime_type: detectedMime ?? (source ? 'text/plain' : mime),
      pasted_text: source ? 1 : 0,
    }
    const attachment = toAttachment(content)
    const now = Date.now()
    if (now - this.lastSweepAt >= DRAFT_SWEEP_INTERVAL_MS) this.sweepExpired()
    const expiresAt = now + DRAFT_ATTACHMENT_TTL_MS
    return this.transaction(() => {
      const draftAttachments = this.database.prepare(`SELECT content.kind AS type, content.mime_type AS mimeType, content.size_bytes AS sizeBytes
        FROM conversation_v2_attachment_drafts draft
        JOIN conversation_v2_attachment_content content ON content.content_id = draft.content_id
        WHERE draft.owner_id = ? AND draft.space_id = ? AND draft.root_key = ? AND draft.draft_id = ? AND draft.expires_at > ?`)
        .all(...binding, now) as Pick<ChatAttachment, 'type' | 'mimeType' | 'sizeBytes'>[]
      this.assertBudget([...draftAttachments, attachment], limits)
      this.database.prepare(`INSERT INTO conversation_v2_attachment_content
        (content_id, kind, name, mime_type, size_bytes, sha256, pasted_text, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(content.content_id, content.kind, name, content.mime_type, content.size_bytes, content.sha256, content.pasted_text, bytes)
      this.database.prepare(`INSERT INTO conversation_v2_attachment_drafts
        (content_id, owner_id, space_id, root_key, draft_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(content.content_id, ...binding, expiresAt)
      return { ...attachment, sha256: content.sha256, expiresAt }
    })
  }

  private resolveClaim(binding: ReturnType<typeof draftScope>, input: ConversationAttachmentClaimInput, limits?: ConversationAttachmentLimits) {
    const { threadId, claimId } = input
    this.assertThreadScope(binding, threadId, true)
    const parsed = ConversationAttachmentIdsSchema.safeParse(input.attachmentIds)
    if (!parsed.success || new Set(parsed.data).size !== parsed.data.length) {
      throw new DaemonError('E_INVALID_ARG', '附件引用无效或重复。')
    }
    const attachmentIds = parsed.data
    const prior = this.database.prepare(`SELECT content.content_id, content.kind, content.name, content.mime_type, content.size_bytes,
      content.sha256, content.pasted_text, claim.attachment_id, claim.source_attachment_id,
      claim.owner_id, claim.space_id, claim.root_key, claim.draft_id
      FROM conversation_v2_attachment_claims claim JOIN conversation_v2_attachment_content content ON content.content_id = claim.content_id
      WHERE claim.thread_id = ? AND claim.claim_id = ? ORDER BY claim.ordinal`)
      .all(threadId, scopeId(claimId)) as unknown as ClaimRow[]
    if (prior.length) {
      if (prior.length !== attachmentIds.length || prior.some((row, index) =>
        row.source_attachment_id !== attachmentIds[index] || row.owner_id !== binding[0] || row.space_id !== binding[1]
        || row.root_key !== binding[2] || row.draft_id !== binding[3])) {
        throw new DaemonError('E_CONFLICT', '此命令已有不同的附件引用。')
      }
      return { existing: true, contents: prior, attachments: prior.map(row => toAttachment(row, row.attachment_id)) }
    }
    const draft = this.database.prepare(`SELECT content.content_id, content.kind, content.name, content.mime_type, content.size_bytes,
      content.sha256, content.pasted_text FROM conversation_v2_attachment_drafts draft
      JOIN conversation_v2_attachment_content content ON content.content_id = draft.content_id
      WHERE draft.content_id = ? AND draft.owner_id = ? AND draft.space_id = ? AND draft.root_key = ? AND draft.draft_id = ? AND draft.expires_at > ?`)
    const retained = this.database.prepare(`SELECT content.content_id, content.kind, content.name, content.mime_type, content.size_bytes,
      content.sha256, content.pasted_text FROM conversation_v2_attachment_claims claim
      JOIN conversation_v2_attachment_content content ON content.content_id = claim.content_id
      WHERE claim.attachment_id = ? AND claim.owner_id = ? AND claim.space_id = ? AND claim.root_key = ? AND claim.thread_id = ?`)
    const now = Date.now()
    const contents = attachmentIds.map(attachmentId => {
      const row = (draft.get(attachmentId, ...binding, now) ?? retained.get(attachmentId, ...binding.slice(0, 3), threadId)) as ContentRow | undefined
      if (!row) throw new DaemonError('E_CONFLICT', '附件尚未就绪、已过期或不属于当前草稿。')
      return row
    })
    if (new Set(contents.map(row => row.content_id)).size !== contents.length) {
      throw new DaemonError('E_INVALID_ARG', '同一附件不能重复引用。')
    }
    const attachments = contents.map((row, index) => toAttachment(row, this.claimedId(input, attachmentIds[index])))
    this.assertBudget(attachments, limits)
    return { existing: false, contents, attachments }
  }

  private claimedId(input: ConversationAttachmentClaimInput, sourceId: string): string {
    return `attachment_${sha256(JSON.stringify([input.threadId, input.claimId, sourceId]))}`
  }

  private assertThreadScope(binding: readonly [string, string, string, ...string[]], threadId: string, allowNew = false): boolean {
    const row = this.database.prepare('SELECT owner_id, space_id, deleted_at FROM conversation_v2_projection_threads WHERE thread_id = ?')
      .get(scopeId(threadId)) as { owner_id: string; space_id: string; deleted_at: string | null } | undefined
    if (!row && allowNew) return true
    if (row && row.owner_id === binding[0] && row.space_id === binding[1] && !row.deleted_at) return true
    if (allowNew) throw new DaemonError('E_DENIED', '附件目标不属于当前会话范围。')
    return false
  }

  private assertBudget(attachments: readonly Pick<ChatAttachment, 'type' | 'mimeType' | 'sizeBytes'>[], limits?: ConversationAttachmentLimits): void {
    const error = conversationAttachmentLimitError(attachments, limits)
    if (error) throw new DaemonError('E_INVALID_ARG', error)
  }

  private removeUnheldContent(contentId?: string): void {
    this.database.prepare(`DELETE FROM conversation_v2_attachment_content AS content
      WHERE ${contentId ? 'content.content_id = ? AND' : ''}
      NOT EXISTS (SELECT 1 FROM conversation_v2_attachment_drafts draft WHERE draft.content_id = content.content_id)
      AND NOT EXISTS (SELECT 1 FROM conversation_v2_attachment_claims claim WHERE claim.content_id = content.content_id)`)
      .run(...(contentId ? [contentId] : []))
  }

  private transaction<Value>(execute: () => Value): Value {
    if (this.database.isTransaction) return execute()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = execute()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
}

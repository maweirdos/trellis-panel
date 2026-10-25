import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { acpHandoffOperationSchema, acpHandoffPreviewSchema } from '../../../shared/acp-handoff'
import { readSessionPreferences, sessionPreferencesPath, updateSessionPreferences } from './session-preferences'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const previewRecordSchema = z.object({
  version: z.literal(1), root: z.string().min(1), rootIdentity: z.string(), sourceFence: digest,
  targetFingerprint: digest, createdAt: z.number(), expiresAt: z.number(), preview: acpHandoffPreviewSchema
}).strict()
const operationRecordSchema = z.object({
  version: z.literal(1), root: z.string().min(1), rootIdentity: z.string(), sourceFence: digest,
  targetFingerprint: digest, previewId: z.string(), requestDigest: digest, context: z.string().max(32768),
  preview: acpHandoffPreviewSchema, operation: acpHandoffOperationSchema,
  phase: z.enum(['reserved', 'native-creating', 'native-ready']),
  cancelRequested: z.boolean(),
  nativeReady: z.object({ backendSessionId: z.string().min(1), agentSessionId: z.string().optional() }).strict().optional(),
  archive: z.object({ previousRevision: z.string(), revision: z.string(), at: z.number(), owned: z.boolean() }).strict().optional(),
  deliveryAttempt: z.object({ connectionGeneration: z.string(), turnId: z.string(),
    state: z.enum(['dispatching', 'not_sent', 'sent']), sentAt: z.number().optional() }).strict().optional()
}).strict()
export type HandoffPreviewRecord = z.infer<typeof previewRecordSchema>
export type HandoffOperationRecord = z.infer<typeof operationRecordSchema>
// Two valid 32 KiB contexts can each expand sixfold when JSON escapes control
// characters. Leave room for both contexts and the bounded provenance fields.
const MAX_STORE_BYTES = 1024 * 1024
export const handoffDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Seal the writable descriptor before publication. Creation is no-replace, so a
 * repeated UUID can never acquire another native effect after an uncertain reply. */
function publish(path: string, value: unknown, create = false): void {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8')
  if (bytes.length > MAX_STORE_BYTES) throw new Error('交接记录超过安全限制，未写入新记录')
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const descriptor = openSync(temporary, 'wx', 0o600)
  try { writeFileSync(descriptor, bytes); fsyncSync(descriptor) }
  finally { closeSync(descriptor) }
  try {
    if (create) { linkSync(temporary, path); unlinkSync(temporary) }
    else renameSync(temporary, path)
  } catch (error) {
    try { unlinkSync(temporary) } catch { /* The publication error remains authoritative. */ }
    throw error
  }
}

/** Private daemon-owned receipts, separate from native transcripts and public metadata. */
export class HandoffStore {
  constructor(private directory: string) {}
  private path(root: string, kind: 'previews' | 'operations', id: string): string {
    z.string().min(1).max(200).regex(/^[\w.-]+$/).parse(id)
    return join(this.directory, 'handoffs', handoffDigest(root), kind, `${id}.json`)
  }
  private read<T>(path: string, schema: z.ZodType<T>): T | undefined {
    if (!existsSync(path)) return undefined
    if (statSync(path).size > MAX_STORE_BYTES) throw new Error('交接记录超过安全限制，原记录已保留')
    return schema.parse(JSON.parse(readFileSync(path, 'utf8')))
  }
  preview(root: string, id: string): HandoffPreviewRecord | undefined {
    const value = this.read(this.path(root, 'previews', id), previewRecordSchema)
    if (value && (value.root !== root || value.preview.id !== id)) throw new Error('交接预览项目或身份不匹配，原记录已保留')
    return value
  }
  savePreview(value: HandoffPreviewRecord): void { publish(this.path(value.root, 'previews', value.preview.id), previewRecordSchema.parse(value), true) }
  operation(root: string, id: string): HandoffOperationRecord | undefined {
    const value = this.read(this.path(root, 'operations', id), operationRecordSchema)
    if (value && (value.root !== root || value.operation.id !== id)) throw new Error('交接操作项目或身份不匹配，原记录已保留')
    return value
  }
  save(value: HandoffOperationRecord, create = false): void { publish(this.path(value.root, 'operations', value.operation.id), operationRecordSchema.parse(value), create) }
  operations(root: string): HandoffOperationRecord[] {
    const path = dirname(this.path(root, 'operations', 'index'))
    if (!existsSync(path)) return []
    return readdirSync(path).filter(name => name.endsWith('.json')).map(name => this.operation(root, name.slice(0, -5))).filter((value): value is HandoffOperationRecord => value !== undefined)
  }
  /** Publish a pre-recorded archival token into the existing preference envelope.
   * A crash between these writes can be reconciled by the exact revision/at pair. */
  archiveSource(record: HandoffOperationRecord): void {
    const token = record.archive
    if (!token) throw new Error('交接缺少归档凭据')
    const previous = readSessionPreferences(this.directory, record.root)
    const old = previous.sessions[record.operation.sourceSessionId]
    if (previous.revision === token.revision && old?.archivedAt === token.at) return
    if (previous.revision !== token.previousRevision || old?.archivedAt !== undefined) throw new Error('源会话偏好已改变，请重新预览')
    publish(sessionPreferencesPath(this.directory, record.root), { ...previous, revision: token.revision,
      sessions: { ...previous.sessions, [record.operation.sourceSessionId]: { ...old, archivedAt: token.at } } })
  }
  restoreSource(record: HandoffOperationRecord): void {
    const token = record.archive
    if (!token?.owned) return
    const preferences = readSessionPreferences(this.directory, record.root)
    if (preferences.sessions[record.operation.sourceSessionId]?.archivedAt === token.at) {
      // Only this field is reversed; later title, pin and other-session edits survive.
      updateSessionPreferences(this.directory, record.root, record.operation.sourceSessionId, { archived: false })
    }
  }
  preferenceRevision(root: string): string { return readSessionPreferences(this.directory, root).revision }
  archived(root: string, id: string): boolean { return readSessionPreferences(this.directory, root).sessions[id]?.archivedAt !== undefined }
}

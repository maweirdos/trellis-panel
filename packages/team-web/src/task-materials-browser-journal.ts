import { z } from 'zod'
import { hifoxMaterialScopeSchema, hifoxMaterialPendingSchema } from '../../../src/shared/hifox-task-materials'
import { teamCommandIdSchema, teamDigestSchema, teamIdSchema } from '../../../src/shared/team-platform'
import { ApiError } from './client'

const recordSchema = z.object({
  scope: hifoxMaterialScopeSchema,
  origin: z.url().max(2048), accountId: teamIdSchema, projectId: teamIdSchema,
  instanceId: teamIdSchema, epoch: teamIdSchema, commandId: teamCommandIdSchema,
  digest: teamDigestSchema, action: hifoxMaterialPendingSchema.shape.action,
  documentId: teamIdSchema.nullable(), versionId: teamIdSchema.nullable(), submissionId: teamIdSchema.nullable(),
  expectedRevision: z.number().int().nonnegative().safe().nullable(),
  expectedDraftRevision: z.number().int().nonnegative().safe().nullable(),
  createdAt: z.number().int().nonnegative(),
  state: z.enum(['pending', 'unknown', 'rejected', 'committed']),
  errorCode: z.string().max(100).nullable()
}).strict()
export type MaterialCommandReference = z.infer<typeof recordSchema>
const MAX_REFERENCES = 100
const STORAGE = 'trellis-task-material-command-refs-v1'
const recordsSchema = z.array(recordSchema).max(MAX_REFERENCES)

/** Identifiers, digests and counters only. Original text and credentials never enter storage. */
export function materialReferences(): MaterialCommandReference[] {
  try {
    const raw = sessionStorage.getItem(STORAGE)
    if (!raw) return []
    if (raw.length > 1024 * 1024) throw new Error('oversized journal')
    const records = recordsSchema.parse(JSON.parse(raw))
    if (new Set(records.map((item) => item.commandId)).size !== records.length) throw new Error('duplicate command')
    return records
  } catch { throw new ApiError('JOURNAL_INVALID', '原材料操作引用无法核对，请保留浏览器数据') }
}

export function rememberMaterialReference(reference: MaterialCommandReference): void {
  const validated = recordSchema.parse(reference)
  const records = materialReferences()
  const existing = records.findIndex((item) => item.commandId === reference.commandId)
  if (existing >= 0) {
    if (records[existing].digest !== reference.digest) throw new ApiError('COMMAND_CONFLICT', '原材料操作摘要不匹配')
    records[existing] = validated
  } else {
    // Never evict an unresolved reference to admit another write.
    if (records.length >= MAX_REFERENCES) {
      const settled = records.findIndex((item) => item.state === 'committed')
      if (settled < 0) throw new ApiError('CAPACITY_EXCEEDED', '待核对材料操作已达上限，请先核对原回执')
      records.splice(settled, 1)
    }
    records.push(validated)
  }
  try { sessionStorage.setItem(STORAGE, JSON.stringify(records)) }
  catch { throw new ApiError('JOURNAL_UNAVAILABLE', '浏览器无法保留原材料操作引用，暂不能提交写入') }
}

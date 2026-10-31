import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { workcopyLeaseSchema, type WorkcopyOwner } from '../../../shared/workcopy-use'
import { processOwnerSchema } from '../../../shared/daemon'
import { readBounded, writeAtomic } from '../../daemon/files'

export const retainedWorkcopyUseSchema = z.object({
  version: z.literal(1), root: z.string().min(1).max(4096), lease: workcopyLeaseSchema,
  state: z.enum(['prepared', 'held', 'unknown', 'released']), host: processOwnerSchema.optional()
}).strict()
export type RetainedWorkcopyUse = z.infer<typeof retainedWorkcopyUseSchema>
export function workcopyOwnerKey(owner: WorkcopyOwner): string {
  return createHash('sha256').update(JSON.stringify([owner.kind, owner.id, owner.generation])).digest('hex')
}
export function workcopyOwnerJournalPath(directory: string, owner: WorkcopyOwner): string {
  return join(directory, 'workcopy-native-owners', `${workcopyOwnerKey(owner)}.json`)
}
export function readWorkcopyOwnerJournal(file: string): RetainedWorkcopyUse {
  return retainedWorkcopyUseSchema.parse(JSON.parse(readBounded(file, 32 * 1024)))
}
export function writeWorkcopyOwnerJournal(file: string, value: RetainedWorkcopyUse): void {
  writeAtomic(file, JSON.stringify(retainedWorkcopyUseSchema.parse(value)))
}

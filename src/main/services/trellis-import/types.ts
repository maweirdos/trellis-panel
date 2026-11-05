import { z } from 'zod'
import type { ImportOwnerEvidence } from '../../../shared/team-import'

export const nativeImportIdentitySchema = z.object({ root: z.string().min(1), device: z.number(), inode: z.number() }).strict()
export type NativeImportIdentity = z.infer<typeof nativeImportIdentitySchema>
export type ImportDiscoveryOptions = { owners?: (root: string) => Promise<ImportOwnerEvidence[]> }
export class TrellisImportError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'TrellisImportError' }
}

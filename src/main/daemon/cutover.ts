import { protectedStorage as safeStorage } from './protected-storage'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { processOwnerSchema, type ProcessOwner } from '../../shared/daemon'
import { readBounded, writeAtomic } from './files'
import { DaemonError } from './errors'
import type { DaemonContext } from './context'
import { sameOwner, processIdentity } from './native'
import type { LegacyRuntimeRelease } from '../services/runtime-host'

const releaseSchema = z.object({
  version: z.literal(1), profileId: z.string().length(64), commandId: z.string().uuid(), owner: processOwnerSchema,
  release: z.object({ runtimeDrained: z.literal(true), releaseId: z.string().uuid(), admission: z.literal('closed'), sessions: z.literal(0), workflows: z.literal(0), at: z.number().int().nonnegative().safe() }).strict(),
  sources: z.object({ settings: z.string().length(64).nullable(), integrations: z.string().length(64).nullable() }).strict()
}).strict()
const sourceHash = (path: string): string | null => existsSync(path) ? createHash('sha256').update(readBounded(path, 2 * 1024 * 1024)).digest('hex') : null
function sources(context: DaemonContext) { return { settings: sourceHash(join(context.userData, 'settings.json')), integrations: sourceHash(join(context.userData, 'integrations.json')) } }
function file(context: DaemonContext): string { return join(context.directory, 'native-cutover.protected') }
/** Called only after real native cleanup AND installation of immutable legacy reader ports. */
export function publishNativeRelease(context: DaemonContext, commandId: string, release: LegacyRuntimeRelease): void {
  if (!safeStorage.isEncryptionAvailable()) throw new DaemonError('E_UNAVAILABLE', 'Native cutover requires OS protected storage.')
  const value = releaseSchema.parse({ version: 1, profileId: context.identity.profileId, owner: context.owner, commandId, release, sources: sources(context) })
  writeAtomic(file(context), safeStorage.encryptString(JSON.stringify(value)).toString('base64'))
}
export function readNativeRelease(context: DaemonContext) {
  if (!safeStorage.isEncryptionAvailable()) throw new DaemonError('E_UNAVAILABLE', 'Native release storage is locked.')
  try { return releaseSchema.parse(JSON.parse(safeStorage.decryptString(Buffer.from(readBounded(file(context), 16384), 'base64')))) }
  catch { throw new DaemonError('E_DENIED', 'The native runtime release proof is unavailable or invalid; preserve the migration checkpoint.') }
}
/** Actor is the actual authenticated pipe process, never a caller-supplied PID. */
export function nativeReleaseDrain(context: DaemonContext, actor: ProcessOwner, commandId: string, releaseId: string) {
  const original = readNativeRelease(context)
  return { original, async assertExclusive(input: { legacyOwner: ProcessOwner; commandId: string }): Promise<{ liveReleased?: true }> {
    const current = readNativeRelease(context)
    if (current.profileId !== context.identity.profileId || current.commandId !== commandId || input.commandId !== commandId || current.release.releaseId !== releaseId || !sameOwner(current.owner, input.legacyOwner) || JSON.stringify(current) !== JSON.stringify(original) || JSON.stringify(current.sources) !== JSON.stringify(sources(context))) throw new DaemonError('E_CONFLICT', 'The original native release or legacy source files changed during cutover.')
    const alive = await processIdentity(current.owner.pid)
    if (alive && sameOwner(alive, current.owner)) {
      if (!sameOwner(actor, current.owner)) throw new DaemonError('E_DENIED', 'Only the original released native process can complete its live cutover.')
      return { liveReleased: true }
    }
    return {}
  } }
}

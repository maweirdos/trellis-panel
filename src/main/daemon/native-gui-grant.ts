import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { canonicalWorkflowJson } from '../../shared/workflow'
import type { ProcessOwner } from '../../shared/daemon'
import type { DaemonContext } from './context'
import { equalProof } from './auth'
import { DaemonError } from './errors'
import { readBounded, writeExclusiveAtomic } from './files'
import { assertLease, type DaemonLease } from './lease'
import { processIdentity, sameOwner } from './native'
import { decodeProtectedCiphertext } from './protection'

const PURPOSE = 'hifox-task-progress-native-gui'
const grantSchema = z.object({
  version: z.literal(1), purpose: z.literal(PURPOSE), id: z.string().uuid(),
  profileId: z.string().length(64), installationId: z.string().length(64), userId: z.string().min(1),
  mode: z.enum(['development', 'production']), executable: z.string().min(1).max(4096), secret: z.string().regex(/^[a-f0-9]{64}$/)
}).strict()
type Grant = z.infer<typeof grantSchema>
const path = (context: DaemonContext): string => join(context.directory, 'native-gui-task-progress.protected')
const executableKey = (value: string): string => {
  const physical = realpathSync.native(value)
  return process.platform === 'win32' ? physical.toLowerCase() : physical
}
function scope(context: DaemonContext, grant: Grant): void {
  const identity = context.identity
  if (grant.profileId !== identity.profileId || grant.installationId !== identity.installationId || grant.userId !== identity.userId
    || grant.mode !== identity.mode || grant.executable !== executableKey(context.owner.executable)) throw new DaemonError('E_DENIED', 'The native GUI grant belongs to another application or profile.')
}
function read(context: DaemonContext): Grant {
  try {
    const ciphertext = decodeProtectedCiphertext(readBounded(path(context), 16 * 1024), 12 * 1024)
    try {
      // This grant has no legacy/plaintext fallback and reuses the existing OS-backed profile key.
      if (!ciphertext.subarray(0, 4).equals(Buffer.from('TPD1'))) throw new Error('Unsupported grant protection')
      const grant = grantSchema.parse(JSON.parse(context.protection.decrypt(ciphertext)))
      scope(context, grant)
      return grant
    } finally { ciphertext.fill(0) }
  } catch { throw new DaemonError('E_DENIED', 'The protected native GUI task grant is unavailable or invalid.') }
}
/** Only the actual leased native daemon issues this fixed-purpose grant. No RPC can mint it. */
export async function ensureNativeGuiGrant(context: DaemonContext, lease: DaemonLease, assertOwner: () => void): Promise<void> {
  assertOwner(); assertLease(context, lease)
  const actual = await processIdentity(process.pid)
  if (!process.versions.electron || process.type !== 'browser' || !actual || !sameOwner(actual, context.owner) || !sameOwner(actual, lease.owner)) throw new DaemonError('E_DENIED', 'Only the leased native application owner may issue its GUI grant.')
  assertOwner(); assertLease(context, lease)
  if (existsSync(path(context))) { read(context); return }
  const secret = randomBytes(32)
  try {
    const grant = grantSchema.parse({ version: 1, purpose: PURPOSE, id: randomUUID(), profileId: context.identity.profileId,
      installationId: context.identity.installationId, userId: context.identity.userId, mode: context.identity.mode,
      executable: executableKey(actual.executable), secret: secret.toString('hex') })
    const ciphertext = context.protection.encrypt(JSON.stringify(grant))
    try { assertOwner(); assertLease(context, lease); writeExclusiveAtomic(path(context), ciphertext.toString('base64')) }
    finally { ciphertext.fill(0) }
  } finally { secret.fill(0) }
}
/** GUI native composition reads an existing grant. It cannot request or create one over the pipe. */
export async function loadNativeGuiGrant(context: DaemonContext): Promise<(challenge: unknown, client: ProcessOwner) => string> {
  const actual = await processIdentity(process.pid)
  const roles = process.argv.filter(value => value.startsWith('--trellis-role='))
  if (!process.versions.electron || process.type !== 'browser' || roles.length > 1 || roles.some(value => value !== '--trellis-role=gui')
    || !actual || !sameOwner(actual, context.owner)) throw new DaemonError('E_DENIED', 'This caller has no native GUI task capability.')
  const grant = read(context)
  return (challenge, client) => {
    if (!sameOwner(actual, client) || read(context).id !== grant.id) throw new DaemonError('E_DENIED', 'The original native GUI task grant changed.')
    return proof(grant.secret, challenge, actual)
  }
}
function proof(secret: string, challenge: unknown, client: ProcessOwner): string {
  return createHmac('sha256', secret).update(canonicalWorkflowJson({ version: 1, purpose: PURPOSE, challenge, client })).digest('hex')
}
/** Opaque, connection-local authority. A serialized object/actor flag can never recreate it. */
export type NativeGuiAuthority = Readonly<{ readonly nativeGuiAuthority: unique symbol }>
const authorities = new WeakMap<NativeGuiAuthority, { actor: ProcessOwner; epoch: string; grantId: string }>()
export function authenticateNativeGuiGrant(context: DaemonContext, epoch: string, challenge: unknown, kernelOwner: ProcessOwner, supplied: string): NativeGuiAuthority {
  const grant = read(context)
  if (kernelOwner.userId !== grant.userId || executableKey(kernelOwner.executable) !== grant.executable || !equalProof(supplied, proof(grant.secret, challenge, kernelOwner))) throw new DaemonError('E_DENIED', 'Native GUI task authentication failed.')
  const authority = Object.freeze({}) as NativeGuiAuthority
  authorities.set(authority, { actor: structuredClone(kernelOwner), epoch, grantId: grant.id })
  return authority
}
export function assertNativeGuiGrant(context: DaemonContext, epoch: string, actor: ProcessOwner, authority?: NativeGuiAuthority): void {
  const admitted = authority && authorities.get(authority)
  if (!admitted || admitted.epoch !== epoch || !sameOwner(admitted.actor, actor) || read(context).id !== admitted.grantId) throw new DaemonError('E_DENIED', 'Task progress control requires the protected native GUI capability.')
}
export function releaseNativeGuiGrant(authority?: NativeGuiAuthority): void { if (authority) authorities.delete(authority) }

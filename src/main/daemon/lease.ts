import { existsSync, lstatSync, mkdirSync, rmdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { daemonLeaseSchema, type DaemonLease } from './lease-schema'
export { daemonLeaseSchema, type DaemonLease } from './lease-schema'
import type { DaemonContext } from './context'
import { processIdentity, sameOwner } from './native'
import { readBounded, writeAtomic } from './files'
import { DaemonError } from './errors'
import { assertLifecycleReleased } from './lifecycle-fence'

export function readLease(context: DaemonContext): DaemonLease | null {
  const directory = join(context.directory, 'owner')
  if (!existsSync(directory)) return null
  const entry = lstatSync(directory)
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new DaemonError('E_DENIED', 'Daemon ownership cannot be redirected to another directory.')
  try { return daemonLeaseSchema.parse(JSON.parse(readBounded(join(directory, 'lease.json'), 8192))) }
  catch { throw new DaemonError('E_UNAVAILABLE', 'Daemon ownership is incomplete, corrupt or from a future version. Preserve the owner directory and reconcile it before starting.') }
}
export async function verifiedLease(context: DaemonContext): Promise<DaemonLease | null> {
  const lease = readLease(context)
  if (!lease) return null
  if (lease.identity.profileId !== context.identity.profileId || lease.identity.userId !== context.identity.userId || lease.identity.mode !== context.identity.mode || lease.owner.userId !== lease.identity.userId) throw new DaemonError('E_DENIED', 'Daemon ownership belongs to a different user or profile.')
  const actual = await processIdentity(lease.owner.pid)
  if (actual && sameOwner(actual, lease.owner)) {
    if (lease.identity.appVersion !== context.identity.appVersion || lease.identity.installationId !== context.identity.installationId) throw new DaemonError('E_VERSION', 'A different installed version owns this daemon. Stop it with its original installation before upgrading.')
    return lease
  }
  return null
}
/** Reconcile a lease left by a process that is no longer present. This is
 * safe before credential preparation because it only removes the exact owner
 * record after a fresh OS identity check and an unchanged lease re-read. A
 * live or unverifiable owner remains protected. */
export async function reconcileStaleLease(context: DaemonContext, verifyingAttemptId?: string): Promise<DaemonLease | null> {
  const previous = readLease(context)
  if (!previous) return null
  const actual = await processIdentity(previous.owner.pid)
  if (actual && sameOwner(actual, previous.owner)) return previous
  assertLifecycleReleased(context, verifyingAttemptId)
  if (JSON.stringify(readLease(context)) !== JSON.stringify(previous)) throw new DaemonError('E_CONFLICT', 'Daemon ownership changed during stale-owner verification.')
  const directory = join(context.directory, 'owner')
  writeAtomic(join(context.directory, 'previous-owner.json'), JSON.stringify(previous))
  unlinkSync(join(directory, 'lease.json'))
  rmdirSync(directory)
  return null
}
/** Requires the native Electron daemon-role lock. Expiry never authorizes replacement. */
export async function acquireLease(context: DaemonContext): Promise<DaemonLease> {
  assertLifecycleReleased(context)
  await reconcileStaleLease(context)
  if (await verifiedLease(context)) throw new DaemonError('E_CONFLICT', 'A verified daemon already owns this profile; attach to it.')
  const directory = join(context.directory, 'owner')
  mkdirSync(directory)
  const lease = daemonLeaseSchema.parse({ version: 1, epoch: randomUUID(), nonce: randomUUID(), identity: context.identity, owner: context.owner, acquiredAt: Date.now() })
  writeAtomic(join(directory, 'lease.json'), JSON.stringify(lease))
  return lease
}
export function assertLease(context: DaemonContext, lease: DaemonLease): void {
  const current = readLease(context)
  if (!current || JSON.stringify(current) !== JSON.stringify(lease) || !sameOwner(current.owner, context.owner)) throw new DaemonError('E_CONFLICT', 'Daemon ownership changed; writes are fenced.')
}
export function releaseLease(context: DaemonContext, lease: DaemonLease): void {
  assertLease(context, lease)
  unlinkSync(join(context.directory, 'owner', 'lease.json'))
  rmdirSync(join(context.directory, 'owner'))
}

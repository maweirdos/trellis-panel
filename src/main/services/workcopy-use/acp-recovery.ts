import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { workcopyOwnerSchema, type WorkcopyLease, type WorkcopyOwner } from '../../../shared/workcopy-use'
import { DaemonError } from '../../daemon/errors'
import { readBounded, writeAtomic } from '../../daemon/files'
import { kernelLifetime, kernelLifetimeSchema, kernelReplaced } from './kernel-lifetime'
import { hasAcpJobOwner, recoverAcpJobOwner } from './acp-jobs'
import type { WorkcopyUseRegistry } from './registry'
import { resolveWorkcopy } from './identity'
import { readWorkcopyOwnerJournal, workcopyOwnerJournalPath, writeWorkcopyOwnerJournal } from './owner-journal'

const legacySchema = z.object({ version: z.literal(1), token: z.string().uuid(), owner: workcopyOwnerSchema,
  identityId: z.string().length(64), kernel: kernelLifetimeSchema, cleanedKernel: kernelLifetimeSchema.optional() }).strict()
const sameOwner = (a: WorkcopyOwner, b: WorkcopyOwner): boolean => a.kind === b.kind && a.id === b.id && a.generation === b.generation && a.taskKey === b.taskKey
const legacyFile = (directory: string, lease: WorkcopyLease): string => join(directory, 'acp-legacy-quarantine', `${lease.token}.json`)
function readLegacy(directory: string, lease: WorkcopyLease): z.infer<typeof legacySchema> | undefined {
  const file = legacyFile(directory, lease)
  if (!existsSync(file)) return undefined
  const original = legacySchema.parse(JSON.parse(readBounded(file, 16 * 1024)))
  if (original.token !== lease.token || !sameOwner(original.owner, lease.owner) || original.identityId !== lease.identity.id
    || original.cleanedKernel && !kernelReplaced(original.kernel, original.cleanedKernel)) throw new DaemonError('E_DENIED', '旧运行隔离见证与原登记不匹配。')
  return original
}
function preserveLegacyOwner(directory: string, lease: WorkcopyLease): void {
  const file = workcopyOwnerJournalPath(directory, lease.owner)
  if (!existsSync(file)) {
    writeWorkcopyOwnerJournal(file, { version: 1, root: lease.identity.canonicalRoot, lease, state: 'unknown' })
    return
  }
  const original = readWorkcopyOwnerJournal(file)
  if (original.lease.token !== lease.token || !sameOwner(original.lease.owner, lease.owner) || original.lease.identity.id !== lease.identity.id) throw new DaemonError('E_CONFLICT', '原隔离清理不能替换另一代次的所有者回执。')
}
async function legacySettled(directory: string, lease: WorkcopyLease): Promise<boolean> {
  const original = readLegacy(directory, lease)
  if (original?.cleanedKernel) { preserveLegacyOwner(directory, lease); return true }
  const current = await kernelLifetime(), file = legacyFile(directory, lease)
  if (!original) {
    writeAtomic(file, JSON.stringify({ version: 1, token: lease.token, owner: lease.owner, identityId: lease.identity.id, kernel: current }))
    return false
  }
  if (!kernelReplaced(original.kernel, current)) return false
  // Publish the original kernel transition before releasing its exact token.
  writeAtomic(file, JSON.stringify({ ...original, cleanedKernel: current }))
  preserveLegacyOwner(directory, lease)
  return true
}
/** Native original-owner evidence only; never creates an intent, Job or replacement quarantine. */
export async function hasLegacyAcpCleanupReceipt(directory: string, root: string, owner: WorkcopyOwner): Promise<boolean> {
  const file = workcopyOwnerJournalPath(directory, owner)
  if (!existsSync(file)) return false
  const original = readWorkcopyOwnerJournal(file)
  if (!sameOwner(original.lease.owner, owner) || original.lease.identity.id !== resolveWorkcopy(root).id) throw new DaemonError('E_DENIED', '原会话清理回执不属于此所有者或物理副本。')
  // Also finish older released records whose original quarantine predates the durable receipt.
  if (original.state !== 'released' || !readLegacy(directory, original.lease) || !await legacySettled(directory, original.lease)) return false
  const current = readWorkcopyOwnerJournal(file)
  if (current.state !== 'released' || current.lease.token !== original.lease.token || !sameOwner(current.lease.owner, owner)
    || current.lease.identity.id !== original.lease.identity.id) throw new DaemonError('E_CONFLICT', '原清理回执在核对期间已变化，未采用旧证明。')
  return true
}
/** Capture old uncontained owners now; a later real kernel replacement is observable. */
export async function prepareAcpRecovery(directory: string, registry: WorkcopyUseRegistry): Promise<void> {
  if (process.platform !== 'win32') return
  for (const lease of registry.agentLeases()) {
    if (!hasAcpJobOwner(directory, lease.owner) && await legacySettled(directory, lease)) registry.release({ token: lease.token, owner: lease.owner, outcome: 'cleanup-confirmed' })
  }
}
/** Skip active generations; no history/PID guessing or synthetic cleanup acknowledgement. */
export async function recoverInactiveAcpUses(directory: string, registry: WorkcopyUseRegistry, root: string, active: (owner: WorkcopyOwner) => boolean, sessionId?: string): Promise<number> {
  const leases = registry.agentLeases(root, sessionId), recovered = new Set<string>()
  for (const lease of leases) {
    if (active(lease.owner)) continue
    const key = JSON.stringify([lease.owner.id, lease.owner.generation, lease.owner.taskKey, lease.identity.id])
    if (!recovered.has(key)) {
      if (!await recoverAcpJobOwner(directory, lease.owner, true) && !await legacySettled(directory, lease)) throw new DaemonError('E_CONFLICT',
        '原执行没有受控 Job 见证，不能追认子进程清理。原历史和隔离登记已保留；请由原控制器完成清理，或完整重启 Windows 后再次核对。')
      recovered.add(key)
    }
    const result = registry.release({ token: lease.token, owner: lease.owner, outcome: 'cleanup-confirmed' })
    if (!result.released) throw new DaemonError('E_UNKNOWN', '原进程已核对，但原使用登记释放尚未确认。', 'unknown')
  }
  return recovered.size
}

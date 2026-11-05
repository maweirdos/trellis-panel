import { createHash, randomUUID } from 'node:crypto'
import type { WorkcopyRecoveryInput, WorkcopyRecoveryResult } from '../../../shared/bootstrap'
import type { DaemonResult } from '../../../shared/daemon'
import { daemonFailure } from '../../daemon/errors'
import { readLease, verifiedLease } from '../../daemon/lease'
import { processIdentity, sameOwner } from '../../daemon/native'
import { DaemonClient } from './client'
import { daemonClientContext } from './manager'

const attempts = new Map<string, { commandId: string; promise: Promise<DaemonResult<WorkcopyRecoveryResult>> }>()
const leaseDigest = (token: string): string => createHash('sha256').update(token).digest('hex')

function payload(input: WorkcopyRecoveryInput, commandId: string): { leaseId: string; owner: WorkcopyRecoveryInput['owner']; acceptedEvidence: WorkcopyRecoveryInput['acceptedEvidence']; commandId: string } {
  return { leaseId: input.leaseId, owner: input.owner, acceptedEvidence: input.acceptedEvidence, commandId }
}

/** Restricted-shell capability only. It authenticates the current daemon owner
 * and retains one exact command UUID per lease across retries or lost replies. */
export async function recoverWorkcopyLease(input: WorkcopyRecoveryInput): Promise<DaemonResult<WorkcopyRecoveryResult>> {
  const key = `${input.leaseId}:${JSON.stringify(input.owner)}:${input.acceptedEvidence}`
  const original = attempts.get(key)
  if (original) return original.promise
  const commandId = randomUUID()
  const pending = submit(input, commandId)
  attempts.set(key, { commandId, promise: pending })
  void pending.finally(() => {
    if (attempts.get(key)?.commandId === commandId) attempts.set(key, { commandId, promise: Promise.resolve(pending) })
  })
  return pending
}

async function submit(input: WorkcopyRecoveryInput, commandId: string): Promise<DaemonResult<WorkcopyRecoveryResult>> {
  let client: DaemonClient | undefined
  try {
    const context = await daemonClientContext(), lease = await verifiedLease(context)
    if (!lease || JSON.stringify(readLease(context)) !== JSON.stringify(lease)) throw new Error('原后台所有者已变化或不可确认。')
    const actual = await processIdentity(lease.owner.pid)
    if (!actual || !sameOwner(actual, lease.owner)) throw new Error('原后台进程身份不可确认，未执行清理。')
    client = await DaemonClient.connect(context)
    if (JSON.stringify(client.lease) !== JSON.stringify(lease)) throw new Error('恢复连接认证到另一个后台所有者。')
    const result = await client.request('daemon.workcopyRecovery', payload(input, commandId), { commandId })
    if (!result.ok && result.outcome !== 'not-admitted') return { ...result, commandId: result.commandId ?? commandId }
    return result
  } catch (error) {
    return daemonFailure(error, commandId)
  } finally {
    client?.close()
  }
}

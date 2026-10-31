import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { workcopyLeaseSchema, workcopyUseResultSchema, type WorkcopyAcquire, type WorkcopyLease, type WorkcopyRelease, type WorkcopyUseResult } from '../../../shared/workcopy-use'
import { DaemonError } from '../../daemon/errors'
import { processIdentity, sameOwner } from '../../daemon/native'
import { writeExclusiveAtomic } from '../../daemon/files'
import { daemonClientContext } from '../daemon-client/manager'
import { nativeDomainCall } from '../daemon-client/runtime'
import { resolveWorkcopy, assertWorkcopyObservation } from './identity'
import { retainedWorkcopyUseSchema as retainedSchema, workcopyOwnerKey as ownerKey, workcopyOwnerJournalPath, readWorkcopyOwnerJournal as read, writeWorkcopyOwnerJournal as save, type RetainedWorkcopyUse } from './owner-journal'
export type { RetainedWorkcopyUse } from './owner-journal'
const acquisitions = new Map<string, Promise<WorkcopyLease>>()
async function journalFile(owner: WorkcopyAcquire['owner']): Promise<string> {
  return workcopyOwnerJournalPath((await daemonClientContext()).directory, owner)
}

function commandId(value: unknown): string {
  const bytes = createHash('sha256').update(JSON.stringify(value)).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
async function call(root: string, body: unknown, id?: string): Promise<WorkcopyUseResult> {
  return workcopyUseResultSchema.parse(await nativeDomainCall(root, 'runtime.workcopyUse', body, id))
}
/** Private capabilities for native recovery; never project these into renderer/team state. */
export async function listRetainedWorkcopyUses(): Promise<RetainedWorkcopyUse[]> {
  const directory = join((await daemonClientContext()).directory, 'workcopy-native-owners')
  if (!existsSync(directory)) return []
  const values: RetainedWorkcopyUse[] = []
  for (const file of readdirSync(directory)) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue
    const value = read(join(directory, file))
    if (value.state !== 'released') values.push(value)
  }
  return values
}
/** Native cwd/task context only. The private token is saved BEFORE RPC/spawn. */
export async function acquireWorkcopyUse(root: string, input: WorkcopyAcquire): Promise<WorkcopyLease> {
  const key = ownerKey(input.owner), pending = acquisitions.get(key)
  if (pending) {
    const lease = await pending
    if (lease.kind !== input.kind || lease.owner.taskKey !== input.owner.taskKey) throw new DaemonError('E_CONFLICT', '此原生运行代次已有不同的准入意图。')
    assertWorkcopyObservation(resolveWorkcopy(root), lease.identity)
    assertWorkcopyObservation(lease.identity, input.expected)
    return lease
  }
  const work = acquireNative(root, input)
  acquisitions.set(key, work)
  try { return await work }
  finally { if (acquisitions.get(key) === work) acquisitions.delete(key) }
}
async function acquireNative(root: string, input: WorkcopyAcquire): Promise<WorkcopyLease> {
  const identity = resolveWorkcopy(root)
  assertWorkcopyObservation(identity, input.expected)
  const file = await journalFile(input.owner)
  const context = await daemonClientContext()
  if (!existsSync(file)) {
    const intent: RetainedWorkcopyUse = { version: 1, root, host: context.owner, state: 'prepared', lease: {
      token: input.token ?? randomUUID(), identity, owner: input.owner, kind: input.kind, state: 'held', acquiredAt: Date.now()
    } }
    mkdirSync(dirname(file), { recursive: true })
    try { writeExclusiveAtomic(file, JSON.stringify(retainedSchema.parse(intent))) }
    catch (error) { if (!existsSync(file)) throw error }
  }
  const original = read(file)
  if (!original.host || !sameOwner(original.host, context.owner)) throw new DaemonError('E_CONFLICT', '原生运行所有者已经变化；请核对原进程树后恢复，不能接管旧登记。')
  if (original.state === 'unknown' || original.state === 'released') throw new DaemonError('E_CONFLICT', '原运行登记需要核对清理，不能复用该执行代次。')
  if (original.lease.owner.taskKey !== input.owner.taskKey || original.lease.kind !== input.kind || input.token && input.token !== original.lease.token) throw new DaemonError('E_CONFLICT', '原生运行代次与已保留的准入意图不一致。')
  assertWorkcopyObservation(identity, original.lease.identity)
  const expected = { id: identity.id, revision: identity.revision }
  try {
    const result = await call(root, { operation: 'acquire', ...input, token: original.lease.token, expected }, commandId(['acquire', original.lease.token]))
    if (result.operation !== 'acquire' || result.lease.token !== original.lease.token) throw new DaemonError('E_UNKNOWN', '原工作副本准入结果未确认。', 'unknown')
    const current = read(file)
    if (current.state === 'released' || current.state === 'unknown') throw new DaemonError('E_CONFLICT', '准入期间原运行已进入清理，未启动执行。')
    save(file, { ...original, lease: result.lease, state: 'held' })
    return result.lease
  } catch (error) {
    if (original.state === 'prepared') {
      // No lease was returned: no process may have started. Cancellation also
      // fences a delayed acquire carrying this original private token.
      try { await releaseWorkcopyUse(root, original.lease, 'cleanup-confirmed') }
      catch { save(file, { ...original, state: 'unknown' }) }
    }
    throw error
  }
}
export async function releaseWorkcopyUse(root: string, lease: WorkcopyLease, outcome: WorkcopyRelease['outcome'], reason?: string): Promise<void> {
  workcopyLeaseSchema.parse(lease)
  const result = workcopyUseResultSchema.parse(await nativeDomainCall(root, 'runtime.workcopyCleanup', { operation: 'release', token: lease.token, owner: lease.owner, outcome, reason }, commandId(['release', lease.token, outcome])))
  if (result.operation !== 'release' || outcome !== 'unknown' && !result.released) throw new DaemonError('E_CONFLICT', '原工作副本占用尚未确认释放，请核对原运行。')
  const file = await journalFile(lease.owner)
  if (existsSync(file)) {
    const original = read(file)
    if (original.lease.token === lease.token) save(file, { ...original, state: result.released ? 'released' : 'unknown' })
  }
}
export async function inspectWorkcopyUse(root: string): Promise<Extract<WorkcopyUseResult, { operation: 'inspect' }>> {
  const result = await call(root, { operation: 'inspect' })
  if (result.operation !== 'inspect') throw new DaemonError('E_UNKNOWN', '工作副本占用核对未确认。', 'unknown')
  return result
}
/** Rechecks private held capability without renewing or changing its baseline. */
export async function assertWorkcopyUse(root: string, lease: WorkcopyLease): Promise<void> {
  const result = await call(root, { operation: 'assert', token: lease.token, owner: lease.owner })
  if (result.operation !== 'assert' || result.identity.id !== lease.identity.id) throw new DaemonError('E_CONFLICT', '原工作副本写入登记核验未通过。')
}
/** Task keys come from persisted native TaskServiceUse/resolver facts, never renderer task IDs. */
export async function updateWorkcopyConsumerTasks(root: string, lease: WorkcopyLease, taskKeys: string[]): Promise<WorkcopyLease> {
  const expectedRevision = lease.consumerAccess?.revision ?? 0
  const result = await call(root, { operation: 'consumer-tasks', token: lease.token, owner: lease.owner, expectedRevision, taskKeys },
    commandId(['consumer-tasks', lease.token, expectedRevision, [...new Set(taskKeys)].sort()]))
  if (result.operation !== 'consumer-tasks' || result.lease.token !== lease.token) throw new DaemonError('E_UNKNOWN', '原服务任务使用范围更新未确认。', 'unknown')
  const file = await journalFile(lease.owner)
  if (existsSync(file)) {
    const original = read(file)
    if (original.lease.token === lease.token) save(file, { ...original, lease: result.lease, state: result.lease.state })
  }
  return result.lease
}
async function consumerCleanup(root: string, lease: WorkcopyLease, operation: 'consumer-read' | 'consumer-restrict', taskKeys?: string[]): Promise<WorkcopyLease> {
  const body = { operation, root, token: lease.token, owner: lease.owner, identityId: lease.identity.id,
    ...(operation === 'consumer-restrict' ? { expectedRevision: lease.consumerAccess?.revision ?? 0, taskKeys } : {}) }
  const result = workcopyUseResultSchema.parse(await nativeDomainCall(root, 'runtime.workcopyCleanup', body,
    operation === 'consumer-read' ? randomUUID() : commandId([operation, lease.token, lease.consumerAccess?.revision ?? 0, taskKeys ?? []])))
  if (result.operation !== operation || result.lease.token !== lease.token) throw new DaemonError('E_UNKNOWN', '原服务消费登记核对未确认。', 'unknown')
  const file = await journalFile(lease.owner)
  if (existsSync(file)) {
    const original = read(file)
    if (original.lease.token === lease.token) save(file, { ...original, lease: result.lease, state: result.lease.state })
  }
  return result.lease
}
export function readWorkcopyConsumerLease(root: string, originalLease: WorkcopyLease): Promise<WorkcopyLease> {
  return consumerCleanup(root, originalLease, 'consumer-read')
}
export function restrictWorkcopyConsumerTasks(root: string, observedLease: WorkcopyLease, nextSubsetTaskKeys: string[]): Promise<WorkcopyLease> {
  return consumerCleanup(root, observedLease, 'consumer-restrict', [...new Set(nextSubsetTaskKeys)].sort())
}
/** The original native owner verifies its process tree AND operation cleanup. */
export async function recoverWorkcopyUse(root: string, lease: WorkcopyLease, verifyCleanup: () => Promise<boolean>): Promise<void> {
  const original = read(await journalFile(lease.owner))
  if (original.root !== root || original.lease.token !== lease.token) throw new DaemonError('E_DENIED', '恢复请求没有原生所有者保留的登记凭据。')
  if (original.host && original.host.pid !== process.pid) {
    const current = await processIdentity(original.host.pid)
    if (current && sameOwner(current, original.host)) throw new DaemonError('E_CONFLICT', '原运行所有者仍存活，请由原运行执行停止和清理。')
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const verified = await Promise.race([verifyCleanup(), new Promise<false>(accept => { timer = setTimeout(() => accept(false), 15_000) })])
    if (!verified) throw new DaemonError('E_UNKNOWN', '原进程树和操作清理尚未确认，登记已保留。', 'unknown')
    await releaseWorkcopyUse(root, lease, 'cleanup-confirmed')
  } finally { if (timer) clearTimeout(timer) }
}

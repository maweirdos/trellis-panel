import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { workcopyAcquireSchema, workcopyConsumerAccessSchema, workcopyLeaseSchema, workcopyReleaseSchema, type WorkcopyAcquire, type WorkcopyIdentity, type WorkcopyLease, type WorkcopyOwner, type WorkcopyRelease, type WorkcopyUseFact } from '../../../shared/workcopy-use'
import { DaemonError } from '../../daemon/errors'
import { readBounded, writeAtomic, writeExclusiveAtomic } from '../../daemon/files'
import { assertWorkcopyObservation, resolveWorkcopy } from './identity'
import { workcopyOwnerJournalPath, readWorkcopyOwnerJournal, writeWorkcopyOwnerJournal } from './owner-journal'

const releasedSchema = z.object({ token: z.string().uuid(), owner: workcopyLeaseSchema.shape.owner, at: z.number().int().nonnegative() }).strict()
type ReleasedUse = z.infer<typeof releasedSchema>
const consumerMutationSchema = z.object({ token: z.string().uuid(), revision: z.number().int().nonnegative().safe(), operation: z.enum(['grant', 'restrict']) }).strict()
type ConsumerMutation = z.infer<typeof consumerMutationSchema>
const storeSchema = z.object({ version: z.literal(1), leases: z.array(workcopyLeaseSchema).max(256), released: z.array(releasedSchema).max(1024).default([]), consumerMutations: z.array(consumerMutationSchema).max(256).default([]) }).strict()
const sameOwner = (a: WorkcopyOwner, b: WorkcopyOwner): boolean => a.kind === b.kind && a.id === b.id && a.generation === b.generation && a.taskKey === b.taskKey
const consumerTasks = (lease: WorkcopyLease): string[] => lease.consumerAccess?.taskKeys ?? (lease.owner.taskKey ? [lease.owner.taskKey] : [])
export function sameWorkcopy(a: WorkcopyIdentity, b: WorkcopyIdentity): boolean {
  if (a.id === b.id || a.physicalId === b.physicalId) return true
  const within = (parent: string, child: string): boolean => { const path = relative(parent, child); return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\') }
  // Removing/redirecting .git externally must not hide an existing physical directory lease.
  return within(a.canonicalRoot, b.canonicalRoot) || within(b.canonicalRoot, a.canonicalRoot)
}
export class WorkcopyUseConflict extends DaemonError {
  constructor(public blockers: WorkcopyUseFact[]) {
    super('E_CONFLICT', `工作副本正在使用：${blockers.slice(0, 4).map(use => `${use.owner.label}（${use.kind}${use.state === 'unknown' ? '，待核对清理' : ''}）`).join('、')}。请等待、完成原运行清理或选择另一副本。`.slice(0, 400))
  }
}
/** One instance belongs to the existing daemon owner. Its durable leases never expire. */
export class WorkcopyUseRegistry {
  private leases = new Map<string, WorkcopyLease>()
  private released = new Map<string, ReleasedUse>()
  private consumerMutations = new Map<string, ConsumerMutation>()
  constructor(private file: string, private assertOwner: () => void) {
    assertOwner()
    if (existsSync(file)) {
      const saved = storeSchema.parse(JSON.parse(readBounded(file, 4 * 1024 * 1024)))
      this.released = new Map(saved.released.map(receipt => [receipt.token, receipt]))
      this.consumerMutations = new Map(saved.consumerMutations.map(receipt => [receipt.token, receipt]))
      for (const lease of saved.leases) {
        if (this.leases.has(lease.token)) throw new DaemonError('E_IO', '工作副本登记重复，原文件已保留。')
        const released = this.releaseReceipt(lease.token)
        if (released && sameOwner(released.owner, lease.owner)) continue
        this.leases.set(lease.token, { ...lease, state: 'unknown', reason: '原协调者已退出；需由原运行核验实际清理，登记不会自动到期。' })
      }
    }
  }
  private publish(next: Map<string, WorkcopyLease>, released = this.released, mutations = this.consumerMutations): void {
    this.assertOwner()
    const receipts = new Map(released)
    const consumerMutations = new Map([...mutations].filter(([token]) => next.has(token)))
    let text = JSON.stringify(storeSchema.parse({ version: 1, leases: [...next.values()], released: [...receipts.values()], consumerMutations: [...consumerMutations.values()] }))
    while (Buffer.byteLength(text) > 4 * 1024 * 1024 && receipts.size) {
      const oldest = receipts.keys().next().value
      if (oldest) receipts.delete(oldest)
      text = JSON.stringify({ version: 1, leases: [...next.values()], released: [...receipts.values()], consumerMutations: [...consumerMutations.values()] })
    }
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new DaemonError('E_BUSY', '工作副本登记超过保存上限，请先核对原运行。')
    writeAtomic(this.file, text)
    this.leases = next
    this.released = receipts
    this.consumerMutations = consumerMutations
  }
  facts(identity?: WorkcopyIdentity): WorkcopyUseFact[] {
    this.assertOwner()
    return [...this.leases.values()].filter(use => !identity || sameWorkcopy(use.identity, identity)
      || identity.commonId !== null && identity.commonId === use.identity.commonId && ['tree-change', 'git-mutation'].includes(use.kind))
      .map(({ token: _token, ...fact }) => structuredClone(fact))
  }
  /** Exact private recovery capability. The digest is safe to expose publicly. */
  leaseByDigest(leaseId: string, owner: WorkcopyOwner): WorkcopyLease | undefined {
    this.assertOwner()
    const lease = [...this.leases.values()].find(candidate => createHash('sha256').update(candidate.token).digest('hex') === leaseId)
    return lease && sameOwner(lease.owner, owner) ? structuredClone(lease) : undefined
  }
  /** Native lifecycle recovery only; this private inventory is never a renderer DTO. */
  agentLeases(root?: string, sessionId?: string): WorkcopyLease[] {
    this.assertOwner()
    let identity: WorkcopyIdentity | undefined
    if (root) { try { identity = resolveWorkcopy(root) } catch { /* Original cleanup can outlive a removed directory. */ } }
    return [...this.leases.values()].filter(lease => {
      if (lease.owner.kind !== 'agent' || sessionId && lease.owner.id !== sessionId) return false
      if (!root) return true
      return identity ? sameWorkcopy(identity, lease.identity) : resolve(root).toLowerCase() === resolve(lease.identity.canonicalRoot).toLowerCase()
    }).map(lease => structuredClone(lease))
  }
  acquire(root: string, raw: WorkcopyAcquire): WorkcopyLease {
    this.assertOwner()
    const input = workcopyAcquireSchema.parse(raw), identity = resolveWorkcopy(root)
    assertWorkcopyObservation(identity, input.expected)
    if (input.token && this.releaseReceipt(input.token)) throw new DaemonError('E_CONFLICT', '原登记已经释放，不能用旧代次重新接纳执行。')
    const duplicate = [...this.leases.values()].find(use => sameOwner(use.owner, input.owner))
    if (duplicate) {
      // Public owner facts, task IDs and command receipts are not capabilities.
      if (input.token !== duplicate.token) throw new DaemonError('E_DENIED', '只有持有原登记凭据的运行所有者可以核对该登记。')
      if (duplicate.identity.id !== identity.id || duplicate.kind !== input.kind || duplicate.state !== 'held') throw new WorkcopyUseConflict(this.facts(duplicate.identity))
      assertWorkcopyObservation(identity, duplicate.identity)
      return structuredClone(duplicate)
    }
    const blockers = [...this.leases.values()].filter(use => {
      const sameTree = sameWorkcopy(use.identity, identity)
      const gitOperation = input.kind === 'git-mutation' || input.kind === 'tree-change'
      const existingGit = use.kind === 'git-mutation' || use.kind === 'tree-change'
      if (gitOperation && existingGit && identity.commonId !== null && identity.commonId === use.identity.commonId) return true
      if (!sameTree) return false
      if (use.state === 'unknown' || input.kind === 'tree-change' || use.kind === 'tree-change') return true
      if (input.kind === 'consumer' && use.kind === 'consumer') return false
      if (input.kind === 'consumer' || use.kind === 'consumer') {
        // Git index/ref writes can coexist with readers, but a source writer
        // may share a service only under its captured native task context.
        if (gitOperation || existingGit) return false
        const writerKey = input.kind === 'consumer' ? use.owner.taskKey : input.owner.taskKey
        const allowed = input.kind === 'consumer' ? input.owner.taskKey ? [input.owner.taskKey] : [] : consumerTasks(use)
        return !writerKey || !allowed.includes(writerKey)
      }
      return true
    })
    if (blockers.length) throw new WorkcopyUseConflict(blockers.map(({ token: _token, ...fact }) => fact))
    if (this.leases.size >= 256) throw new DaemonError('E_BUSY', '工作副本登记已达上限，请先核对并清理原运行。')
    if (input.token && this.leases.has(input.token)) throw new DaemonError('E_DENIED', '原登记凭据属于另一运行所有者。')
    const lease: WorkcopyLease = { token: input.token ?? randomUUID(), identity, owner: input.owner, kind: input.kind, state: 'held', acquiredAt: Date.now() }
    if (lease.kind === 'consumer') lease.consumerAccess = { revision: 0, taskKeys: lease.owner.taskKey ? [lease.owner.taskKey] : [] }
    if (lease.owner.kind === 'agent') writeWorkcopyOwnerJournal(workcopyOwnerJournalPath(dirname(this.file), lease.owner), { version: 1, root, lease, state: 'prepared' })
    const next = new Map(this.leases); next.set(lease.token, lease); this.publish(next)
    if (lease.owner.kind === 'agent') writeWorkcopyOwnerJournal(workcopyOwnerJournalPath(dirname(this.file), lease.owner), { version: 1, root, lease, state: 'held' })
    return structuredClone(lease)
  }
  release(raw: WorkcopyRelease): { released: boolean; state: 'released' | 'unknown' | 'stale' } {
    this.assertOwner()
    const input = workcopyReleaseSchema.parse(raw), lease = this.leases.get(input.token)
    if (!lease) {
      const prior = this.releaseReceipt(input.token)
      if (prior) return sameOwner(prior.owner, input.owner) ? { released: true, state: 'released' } : { released: false, state: 'stale' }
      if (input.outcome !== 'cleanup-confirmed') return { released: false, state: 'stale' }
      // Write-ahead cancellation: a delayed acquire carrying this private token
      // must never start work after its native owner has abandoned admission.
      this.rememberRelease(input.token, input.owner, new Map(this.leases))
      return { released: true, state: 'released' }
    }
    if (!sameOwner(lease.owner, input.owner)) return { released: false, state: 'stale' }
    if (input.outcome === 'unknown' || lease.state === 'unknown' && input.outcome !== 'cleanup-confirmed') {
      const next = new Map(this.leases)
      next.set(lease.token, { ...lease, state: 'unknown', reason: input.reason ?? lease.reason ?? '真实停止或后台清理尚未确认。' })
      this.publish(next)
      this.updateAgentJournal(lease, 'unknown')
      return { released: false, state: 'unknown' }
    }
    const next = new Map(this.leases); next.delete(lease.token)
    this.rememberRelease(lease.token, lease.owner, next)
    this.updateAgentJournal(lease, 'released')
    return { released: true, state: 'released' }
  }
  private rememberRelease(token: string, owner: WorkcopyOwner, next: Map<string, WorkcopyLease>): void {
    const file = this.releasePath(token)
    mkdirSync(dirname(file), { recursive: true })
    const receipt: ReleasedUse = { token, owner, at: Date.now() }
    if (!existsSync(file)) writeExclusiveAtomic(file, JSON.stringify(receipt))
    const original = this.releaseReceipt(token)
    if (!original || !sameOwner(original.owner, owner)) throw new DaemonError('E_DENIED', '原释放回执所有者不一致。')
    const released = new Map(this.released); released.set(token, { token, owner, at: Date.now() })
    while (released.size > 1024) { const oldest = released.keys().next().value; if (oldest) released.delete(oldest) }
    this.publish(next, released)
  }
  private releasePath(token: string): string { return join(dirname(this.file), 'workcopy-use-released', `${token}.json`) }
  private releaseReceipt(token: string): ReleasedUse | undefined {
    const cached = this.released.get(token)
    if (cached) return cached
    const file = this.releasePath(token)
    if (!existsSync(file)) return undefined
    return releasedSchema.parse(JSON.parse(readBounded(file, 16 * 1024)))
  }
  private updateAgentJournal(lease: WorkcopyLease, state: 'released' | 'unknown'): void {
    if (lease.owner.kind !== 'agent') return
    const file = workcopyOwnerJournalPath(dirname(this.file), lease.owner)
    if (!existsSync(file)) return
    const original = readWorkcopyOwnerJournal(file)
    if (original.lease.token === lease.token) writeWorkcopyOwnerJournal(file, { ...original, lease: { ...lease, state: state === 'unknown' ? 'unknown' : lease.state }, state })
  }
  assertHeld(root: string, token: string, owner: WorkcopyOwner): WorkcopyIdentity {
    this.assertOwner()
    const lease = this.leases.get(token)
    if (!lease || !sameOwner(lease.owner, owner) || lease.state !== 'held') throw new DaemonError('E_DENIED', '原工作副本写入登记已失效或清理未确认。')
    const identity = resolveWorkcopy(root)
    if (identity.id !== lease.identity.id) throw new DaemonError('E_CONFLICT', '原工作副本物理身份已经变化，未执行旧操作。')
    return identity
  }
  /** Original native service owner CAS; this does not alter process/run/config identity. */
  updateConsumerTasks(root: string, token: string, owner: WorkcopyOwner, expectedRevision: number, rawTaskKeys: string[]): WorkcopyLease {
    this.assertOwner()
    workcopyConsumerAccessSchema.shape.revision.parse(expectedRevision)
    const keys = [...new Set(workcopyConsumerAccessSchema.shape.taskKeys.parse(rawTaskKeys))].sort()
    const lease = this.leases.get(token)
    if (!lease || !sameOwner(lease.owner, owner) || lease.kind !== 'consumer' || owner.kind !== 'application') throw new DaemonError('E_DENIED', '只有原服务运行所有者可以更新任务使用范围。')
    if (resolveWorkcopy(root).id !== lease.identity.id) throw new DaemonError('E_CONFLICT', '服务的原工作副本物理身份已经变化。')
    const revision = lease.consumerAccess?.revision ?? 0
    const unchanged = JSON.stringify([...consumerTasks(lease)].sort()) === JSON.stringify(keys)
    if (unchanged && (expectedRevision === revision || expectedRevision + 1 === revision && this.consumerMutations.get(token)?.operation !== 'restrict')) return structuredClone(lease)
    if (expectedRevision !== revision) throw new DaemonError('E_CONFLICT', '服务任务使用范围已变化，请核对原运行后重试。')
    const blockers = [...this.leases.values()].filter(use => use.token !== token && sameWorkcopy(use.identity, lease.identity)
      && use.kind === 'writer' && (!use.owner.taskKey || !keys.includes(use.owner.taskKey)))
    if (blockers.length) throw new WorkcopyUseConflict(blockers.map(({ token: _token, ...fact }) => structuredClone(fact)))
    const updated: WorkcopyLease = { ...lease, consumerAccess: { revision: revision + 1, taskKeys: keys } }
    const next = new Map(this.leases); next.set(token, updated)
    const mutations = new Map(this.consumerMutations); mutations.set(token, { token, revision: revision + 1, operation: 'grant' }); this.publish(next, this.released, mutations)
    return structuredClone(updated)
  }
  readConsumerLease(root: string, token: string, owner: WorkcopyOwner, identityId: string): WorkcopyLease {
    this.assertOwner()
    const lease = this.leases.get(token)
    if (!lease || lease.kind !== 'consumer' || owner.kind !== 'application' || !sameOwner(owner, lease.owner) || lease.identity.id !== identityId) throw new DaemonError('E_DENIED', '原服务消费登记的私有身份不匹配。')
    const file = workcopyOwnerJournalPath(dirname(this.file), lease.owner)
    if (existsSync(file)) {
      const original = readWorkcopyOwnerJournal(file)
      if (original.lease.token !== token || resolve(original.root).toLowerCase() !== resolve(root).toLowerCase()) throw new DaemonError('E_DENIED', '原服务消费登记的工作目录不匹配。')
    } else if (resolveWorkcopy(root).id !== identityId) throw new DaemonError('E_DENIED', '原服务消费登记的物理副本不匹配。')
    return structuredClone({ ...lease, consumerAccess: lease.consumerAccess ?? { revision: 0, taskKeys: consumerTasks(lease) } })
  }
  restrictConsumerTasks(root: string, token: string, owner: WorkcopyOwner, identityId: string, expectedRevision: number, rawTaskKeys: string[]): WorkcopyLease {
    const lease = this.readConsumerLease(root, token, owner, identityId)
    workcopyConsumerAccessSchema.shape.revision.parse(expectedRevision)
    const keys = [...new Set(workcopyConsumerAccessSchema.shape.taskKeys.parse(rawTaskKeys))].sort()
    const current = consumerTasks(lease), revision = lease.consumerAccess?.revision ?? 0
    if (keys.some(key => !current.includes(key))) throw new DaemonError('E_DENIED', '清理通道只能收缩原服务的任务范围，不能新增授权。')
    const unchanged = JSON.stringify([...current].sort()) === JSON.stringify(keys)
    if (expectedRevision + 1 === revision && unchanged && this.consumerMutations.get(token)?.operation === 'restrict') return lease
    if (expectedRevision !== revision) throw new DaemonError('E_CONFLICT', '原消费范围已变化，请核对原收缩操作。')
    const blockers = [...this.leases.values()].filter(use => use.token !== token && sameWorkcopy(use.identity, lease.identity) && use.kind === 'writer' && (!use.owner.taskKey || !keys.includes(use.owner.taskKey)))
    if (blockers.length) throw new WorkcopyUseConflict(blockers.map(({ token: _token, ...fact }) => structuredClone(fact)))
    const updated = { ...lease, consumerAccess: { revision: revision + 1, taskKeys: keys } }
    const next = new Map(this.leases); next.set(token, updated)
    const mutations = new Map(this.consumerMutations); mutations.set(token, { token, revision: revision + 1, operation: 'restrict' }); this.publish(next, this.released, mutations)
    return structuredClone(updated)
  }
  /** Only the original in-daemon lifecycle may add a conservative cleanup barrier. */
  retainUnknown(root: string, owner: WorkcopyOwner, original?: WorkcopyLease): WorkcopyLease {
    this.assertOwner()
    const lease = original && this.leases.get(original.token)
      || [...this.leases.values()].find(use => sameOwner(use.owner, owner))
      || { token: randomUUID(), identity: resolveWorkcopy(root), owner, kind: 'writer' as const, acquiredAt: Date.now(), state: 'held' as const }
    if (!sameOwner(lease.owner, owner)) throw new DaemonError('E_DENIED', '原清理登记属于另一运行所有者。')
    const retained: WorkcopyLease = { ...lease, state: 'unknown', reason: '原执行器后台工作或清理尚未确认。' }
    const next = new Map(this.leases); next.set(retained.token, retained); this.publish(next)
    if (retained.owner.kind === 'agent') {
      const file = workcopyOwnerJournalPath(dirname(this.file), retained.owner)
      writeWorkcopyOwnerJournal(file, { version: 1, root, lease: retained, state: 'unknown' })
    }
    return structuredClone(retained)
  }
  assertScope(root: string, token: string): void {
    this.assertOwner()
    const lease = this.leases.get(token)
    if (lease && resolveWorkcopy(root).id !== lease.identity.id) throw new DaemonError('E_DENIED', '此登记不属于原工作副本。')
  }
}

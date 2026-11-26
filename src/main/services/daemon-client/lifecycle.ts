import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, rmdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { processOwnerSchema, type DaemonStatus } from '../../../shared/daemon'
import { daemonLeaseSchema, readLease, reconcileStaleLease, type DaemonLease } from '../../daemon/lease'
import { type DaemonContext } from '../../daemon/context'
import { readBounded, writeAtomic, writeExclusive } from '../../daemon/files'
import { processIdentity, sameOwner } from '../../daemon/native'
import { prepareDaemonTermination, type DaemonTermination } from '../../daemon/lifecycle-native'
import { DaemonError } from '../../daemon/errors'
import { DaemonClient } from './client'

export type LifecycleReason = 'development' | 'build-change' | 'upgrade' | 'restart'
export interface LifecycleConfirmation {
  attemptId: string; reason: LifecycleReason; sessions: Array<{ title: string }>; uncertain: boolean
}
export const lifecycleAttemptSchema = z.object({
  version: z.literal(1), attemptId: z.string().uuid(), commandId: z.string().uuid(),
  admissionId: z.string().uuid(), reason: z.enum(['development', 'build-change', 'upgrade', 'restart']),
  lease: daemonLeaseSchema.nullable(), controller: processOwnerSchema,
  targetBuild: z.string().regex(/^[a-f0-9]{64}$/), installationId: z.string().length(64), profileId: z.string().length(64),
  launch: z.object({ id: z.string().uuid(), owner: processOwnerSchema }).strict().optional(),
  phase: z.enum(['inspecting', 'awaiting-confirmation', 'cancelled', 'stopping', 'terminating', 'verifying', 'released', 'failed']),
  confirmed: z.boolean(), submitted: z.boolean(), admitted: z.boolean(), admissionRequested: z.boolean().optional(), admissionRetired: z.boolean().optional(),
  startedAt: z.number().optional(), releasedAt: z.number().optional(), failure: z.string().max(400).optional(),
  legacyGuiRecovery: z.object({ owner: processOwnerSchema, unmanagedDescendants: z.literal('unknown'), managedCleanup: z.enum(['pending', 'verified']) }).strict().optional()
}).strict()
export type LifecycleAttempt = z.infer<typeof lifecycleAttemptSchema>
export interface LifecycleOptions {
  reason: LifecycleReason
  targetBuild: string
  launch?: LifecycleAttempt['launch']
  confirm(input: LifecycleConfirmation): Promise<boolean>
  /** Captures GUI/native scopes before any cancellation, never arbitrary PIDs. */
  prepareAdditional?(): Promise<DaemonTermination | null>
  /** Must fence GUI admission synchronously before returning its cleanup work. */
  stopAdditional?(attempt: LifecycleAttempt): Promise<void>
  progress?(attempt: LifecycleAttempt): void
  /** 用户已在独立退出确认窗完成授权时静默推进后台停止，不再二次弹出“正在重启…”进度窗。 */
  silentProgress?: boolean
}
export class LifecycleCancelled extends DaemonError {
  constructor() { super('E_UNAVAILABLE', '已取消重启。原会话继续运行；可选择重试或退出。') }
}
export function readLifecycleAttempt(context: DaemonContext): LifecycleAttempt | undefined {
  const file = join(context.directory, 'lifecycle-attempt.json')
  return existsSync(file) ? lifecycleAttemptSchema.parse(JSON.parse(readBounded(file, 32 * 1024))) : undefined
}
function save(context: DaemonContext, attempt: LifecycleAttempt, options: LifecycleOptions): void {
  writeAtomic(join(context.directory, 'lifecycle-attempt.json'), JSON.stringify(lifecycleAttemptSchema.parse(attempt)))
  options.progress?.(structuredClone(attempt))
}
export function lifecycleDeadline<T>(work: Promise<T>, deadline: number, description: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new DaemonError('E_UNKNOWN', description, 'unknown')), Math.max(0, deadline - Date.now()))
    work.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}
const pause = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 15))
const sameLease = (a: DaemonLease | null, b: DaemonLease | null): boolean => JSON.stringify(a) === JSON.stringify(b)
const active = new Map<string, Promise<LifecycleAttempt>>()

/** The lock owns only this protected handoff record, never the daemon lease.
 * Crash recovery removes only its exact dead-controller witness. */
async function acquire(context: DaemonContext): Promise<() => void> {
  const directory = join(context.directory, 'lifecycle-lock')
  const file = join(directory, 'owner.json')
  try { mkdirSync(directory) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new DaemonError('E_DENIED', '退出控制器锁目录不能重定向。')
    for (let retry = 0; !existsSync(file) && retry < 5; retry++) await pause()
    const owner = processOwnerSchema.parse(JSON.parse(readBounded(file, 8192)))
    const actual = await processIdentity(owner.pid)
    if (actual && sameOwner(actual, owner)) throw new DaemonError('E_BUSY', '另一个本机控制器正在处理原退出请求。')
    if (JSON.stringify(processOwnerSchema.parse(JSON.parse(readBounded(file, 8192)))) !== JSON.stringify(owner)) throw new DaemonError('E_CONFLICT', '退出控制器身份已变化。')
    unlinkSync(file); rmdirSync(directory); mkdirSync(directory)
  }
  writeExclusive(file, JSON.stringify(context.owner))
  return () => {
    if (JSON.stringify(processOwnerSchema.parse(JSON.parse(readBounded(file, 8192)))) !== JSON.stringify(context.owner)) throw new DaemonError('E_CONFLICT', '退出控制器锁已变化。')
    unlinkSync(file); rmdirSync(directory)
  }
}
export function runDaemonLifecycle(context: DaemonContext, options: LifecycleOptions): Promise<LifecycleAttempt> {
  const pending = active.get(context.directory)
  if (pending) return pending.then(result => {
    assertRequestedSuccessor(result, options)
    return result
  })
  const work = joinOrRun(context, options)
  active.set(context.directory, work)
  void work.finally(() => { if (active.get(context.directory) === work) active.delete(context.directory) }).catch(() => {})
  return work
}
function assertRequestedSuccessor(result: LifecycleAttempt, options: LifecycleOptions): void {
  if (options.reason === 'upgrade' && (result.reason !== 'upgrade' || result.targetBuild !== options.targetBuild)) {
    throw new DaemonError('E_CONFLICT', '原退出已完成，但并发请求的目标版本不同；请重新发起本次升级以核验新的安装目标。')
  }
}
/** The original uninstaller can only verify the installer's exact released
 * handoff. It cannot retarget the successor, stop a new owner or create an exit. */
export async function reconcileReleasedLifecycle(
  context: DaemonContext,
  expected: Pick<LifecycleAttempt, 'attemptId' | 'targetBuild'>,
  prepareAdditional?: () => Promise<DaemonTermination | null>
): Promise<LifecycleAttempt> {
  z.object({ attemptId: z.string().uuid(), targetBuild: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(expected)
  const unlock = await acquire(context)
  let scope: DaemonTermination | null | undefined
  const deadline = Date.now() + 10_000
  try {
    const original = readLifecycleAttempt(context)
    if (!original || original.attemptId !== expected.attemptId || original.targetBuild !== expected.targetBuild || original.reason !== 'upgrade' || original.phase !== 'released' ||
      original.profileId !== context.identity.profileId || original.installationId !== context.identity.installationId ||
      original.controller.userId !== context.owner.userId || readLease(context)) {
      throw new DaemonError('E_CONFLICT', '原卸载器只能核验本次安装已释放的退出请求；不能建立新的退出或替换目标版本。')
    }
    let capturePending = true
    const capture = Promise.resolve().then(() => prepareAdditional?.() ?? null)
    void capture.then(value => { if (!capturePending && value) void value.dispose().catch(() => {}) }, () => {})
    try { scope = await lifecycleDeadline(capture, deadline, '原安装退出范围复核超时。') }
    finally { capturePending = false }
    if (scope) await lifecycleDeadline(scope.verify(Math.max(1, Math.min(1000, deadline - Date.now()))), deadline, '原安装出现了尚未退出的桌面。')
    if (readLease(context) || JSON.stringify(readLifecycleAttempt(context)) !== JSON.stringify(original)) throw new DaemonError('E_CONFLICT', '原安装交接记录或后台所有权已变化。')
    return original
  } finally {
    if (scope) await lifecycleDeadline(scope.dispose(), Date.now() + 1500, '原安装复核控制器尚未结束。').catch(() => {})
    unlock()
  }
}
async function joinOrRun(context: DaemonContext, options: LifecycleOptions): Promise<LifecycleAttempt> {
  const launchFile = options.launch ? join(context.directory, `lifecycle-launch-${options.launch.id}.json`) : undefined
  if (launchFile && existsSync(launchFile)) {
    const receipt = lifecycleAttemptSchema.parse(JSON.parse(readBounded(launchFile, 32 * 1024)))
    if (JSON.stringify(receipt.launch) === JSON.stringify(options.launch) && receipt.targetBuild === options.targetBuild && receipt.phase === 'released') return receipt
  }
  let result: LifecycleAttempt
  try { result = await run(context, options) }
  catch (error) {
    if (!(error instanceof DaemonError) || error.code !== 'E_BUSY') throw error
    // Join the protected original controller, including its user-thinking time.
    // Never mint another stop while a live peer owns this exact target.
    let observed: LifecycleAttempt | undefined
    const waitStarted = Date.now()
    let checkedController = '', checkedAt = 0
    while (true) {
      const lock = join(context.directory, 'lifecycle-lock')
      const lockOwnerFile = join(lock, 'owner.json')
      let controller: LifecycleAttempt['controller'] | undefined
      if (existsSync(lock)) {
        if (!lstatSync(lock).isDirectory() || lstatSync(lock).isSymbolicLink()) throw new DaemonError('E_DENIED', '退出控制器锁目录不能重定向。')
        if (existsSync(lockOwnerFile)) controller = processOwnerSchema.parse(JSON.parse(readBounded(lockOwnerFile, 8192)))
      }
      if (controller && (JSON.stringify(controller) !== checkedController || Date.now() - checkedAt >= 1000)) {
        const actual = await lifecycleDeadline(processIdentity(controller.pid), Date.now() + 7500, '原退出控制器身份核验超时。')
        checkedAt = Date.now(); checkedController = JSON.stringify(controller)
        if (!actual || !sameOwner(actual, controller)) {
          try { result = await run(context, options); break }
          catch (retry) { if (!(retry instanceof DaemonError) || retry.code !== 'E_BUSY') throw retry }
          await pause(); continue
        }
      }
      const record = readLifecycleAttempt(context)
      // The lock can be published just before its new record. Do not consume a
      // previous controller's terminal receipt in that publication interval.
      const current = !existsSync(lock) || controller && record && sameOwner(record.controller, controller) ? record : undefined
      if (current) {
        if (observed && observed.attemptId !== current.attemptId) throw new DaemonError('E_CONFLICT', '并发退出请求已改变身份。')
        observed = current
        if (current.phase === 'released') { result = current; break }
        if (current.phase === 'cancelled') throw new LifecycleCancelled()
        if (current.phase === 'failed') throw new DaemonError('E_UNKNOWN', current.failure ?? '原退出请求未完成。', 'unknown')
        if (current.startedAt && Date.now() > current.startedAt + 30_000) throw new DaemonError('E_UNKNOWN', '原退出控制器超过截止时间；请核对同一次退出请求。', 'unknown')
      }
      if (!existsSync(lock)) { result = await run(context, options); break }
      if (!observed && Date.now() - waitStarted > 5000) throw new DaemonError('E_UNKNOWN', '原退出控制器未发布可核验请求。', 'unknown')
      await pause()
    }
  }
  assertRequestedSuccessor(result, options)
  if (launchFile && options.launch) writeAtomic(launchFile, JSON.stringify({ ...result, launch: options.launch, targetBuild: options.targetBuild }))
  return result
}
async function run(context: DaemonContext, options: LifecycleOptions): Promise<LifecycleAttempt> {
  const unlock = await acquire(context)
  let client: DaemonClient | undefined
  const scopes: DaemonTermination[] = []
  let attempt: LifecycleAttempt | undefined
  try {
    const lease = readLease(context), previous = readLifecycleAttempt(context)
    if (lease && (lease.identity.profileId !== context.identity.profileId || lease.identity.installationId !== context.identity.installationId || lease.owner.userId !== context.owner.userId)) throw new DaemonError('E_DENIED', '退出目标不属于本安装或当前用户。')
    const sameLaunch = Boolean(options.launch && previous?.launch && JSON.stringify(options.launch) === JSON.stringify(previous.launch) && previous.targetBuild === options.targetBuild)
    // A completed launch remains consumed across electron-vite main rebuilds.
    // Changed output starts a distinct replacement; renderer HMR never enters.
    if (previous?.phase === 'released' && sameLaunch) return previous
    if (previous && !['released', 'cancelled'].includes(previous.phase)) {
      if (lease && !sameLease(previous.lease, lease)) throw new DaemonError('E_CONFLICT', '原退出请求尚未核验，新后台不在该确认范围内。')
      attempt = previous
      attempt.controller = context.owner
      // A refreshed installer still cleans the exact original owner/commands,
      // but owns the new successor build. Original-uninstaller checks use the
      // read-only reconciliation entry above and never reach this assignment.
      if (options.reason === 'upgrade') {
        attempt.reason = 'upgrade'
        attempt.targetBuild = options.targetBuild
      }
      // An explicit retry keeps the original stop identities and only renews
      // its bounded verification window after a settled failure.
      if (attempt.phase === 'failed') delete attempt.startedAt
    } else {
      attempt = { version: 1, attemptId: randomUUID(), commandId: randomUUID(), admissionId: randomUUID(),
        reason: options.reason, lease, controller: context.owner,
        targetBuild: options.targetBuild,
        installationId: context.identity.installationId, profileId: context.identity.profileId,
        ...(options.launch ? { launch: options.launch } : {}),
        phase: 'inspecting', confirmed: false, submitted: false, admitted: false }
    }
    save(context, attempt, options)
    const original = attempt.lease
    let status: DaemonStatus | undefined
    if (original && sameLease(lease, original)) {
      try {
        const connection = DaemonClient.connect(context)
        // Close even a late authenticated socket after inspection times out.
        let accepted = false
        void connection.then(value => { setTimeout(() => { if (!accepted) value.close() }, 0) }, () => {})
        client = await lifecycleDeadline(connection, Date.now() + 4000, '后台状态读取超时，无法证明会话空闲。')
        accepted = true
        const result = await lifecycleDeadline(client.request('daemon.status', {}, { timeoutMs: 3000 }), Date.now() + 3500, '后台状态读取超时。')
        if (result.ok && result.data.epoch === original.epoch && sameOwner(result.data.owner, original.owner)) status = result.data
      } catch { client?.close(); client = undefined }
    }
    if (attempt.admissionRequested && !attempt.admitted) {
      if (!original) throw new DaemonError('E_UNKNOWN', '原空闲退出准入缺少目标身份。', 'unknown')
      if (!client) {
        const actual = await processIdentity(original.owner.pid)
        if (actual && sameOwner(actual, original.owner)) throw new DaemonError('E_UNKNOWN', '原空闲退出准入回执未确认；不能取消或重建退出身份。', 'unknown')
        // An ended original host cannot accept its delayed frame. Children
        // still need captured-scope confirmation and verification below.
        attempt.admissionRetired = true
      } else {
        const resolved = await client.request('daemon.lifecycle.resolve', { expectedOwner: original.owner, nonce: original.nonce, attemptId: attempt.attemptId, admissionId: attempt.admissionId }, { timeoutMs: 2000 })
        if (!resolved.ok || resolved.data.attemptId !== attempt.attemptId || resolved.data.admissionId !== attempt.admissionId) throw new DaemonError('E_UNKNOWN', '原空闲退出准入回执未确认；保留原请求并重试核验。', 'unknown')
        attempt.admitted = resolved.data.state === 'admitted'
        attempt.admissionRetired = resolved.data.state === 'not-admitted'
      }
      attempt.admissionRequested = false
      save(context, attempt, options)
    }
    // Capture is read-only and precedes user acceptance. Slow native inventory
    // cannot consume an unbounded interval after the user confirms stopping.
    const captures = await Promise.allSettled([
      Promise.resolve().then(() => original ? prepareDaemonTermination(context, original) : null),
      Promise.resolve().then(() => options.prepareAdditional?.() ?? null)
    ])
    for (const capture of captures) if (capture.status === 'fulfilled' && capture.value) scopes.push(capture.value)
    const failedCapture = captures.find(capture => capture.status === 'rejected')
    if (failedCapture?.status === 'rejected') throw failedCapture.reason
    const additionalScope = captures[1]?.status === 'fulfilled' ? captures[1].value : null
    if (additionalScope?.legacyGuiRecovery) {
      attempt.legacyGuiRecovery = { owner: additionalScope.legacyGuiRecovery.owner, unmanagedDescendants: 'unknown', managedCleanup: 'pending' }
      save(context, attempt, options)
    }
    const originalExitedBeforeBoot = captures[0]?.status === 'fulfilled' && captures[0].value?.exitedBeforeBoot === true
    // Older status has no activity contract. Never infer idle from zero jobs,
    // empty blockers or legacy/runtime authority.
    const uncertain = attempt.admissionRetired === true || !status?.activity || status.activity.state === 'uncertain' || additionalScope?.legacyGuiRecovery?.requiresConfirmation === true
    const liveScope = original && !originalExitedBeforeBoot || additionalScope && !additionalScope.exitedBeforeBoot &&
      (!additionalScope.legacyGuiRecovery || additionalScope.legacyGuiRecovery.requiresConfirmation)
    const needsConfirmation = Boolean(liveScope && (uncertain || status?.activity?.state === 'interruptible'))
    if (!attempt.confirmed && !attempt.admitted && needsConfirmation) {
      attempt.phase = 'awaiting-confirmation'; save(context, attempt, options)
      if (!await options.confirm({ attemptId: attempt.attemptId, reason: attempt.reason,
        sessions: status?.activity?.sessions.filter(session => session.state !== 'idle').map(session => ({ title: session.title })) ?? [], uncertain })) {
        attempt.phase = 'cancelled'; save(context, attempt, options); throw new LifecycleCancelled()
      }
      attempt.confirmed = true; save(context, attempt, options)
    }
    if (original && !sameLease(readLease(context), original) && readLease(context) !== null) throw new DaemonError('E_CONFLICT', '确认后后台代次已变化；旧确认不授权停止新的后台。')
    attempt.startedAt ??= Date.now()
    save(context, attempt, options)
    if (original && !originalExitedBeforeBoot && !attempt.confirmed && !attempt.admitted) {
      if (!client || status?.lifecycleVersion !== 1) throw new DaemonError('E_VERSION', '旧后台没有可核验的空闲退出能力，需要确认中断。')
      attempt.admissionRequested = true; save(context, attempt, options)
      const admission = await client.request('daemon.lifecycle.admit', { expectedOwner: original.owner,
        lifecycle: { version: 1, attemptId: attempt.attemptId, nonce: original.nonce, interrupt: false } }, { commandId: attempt.admissionId, timeoutMs: 3000 })
      if (!admission.ok) {
        if (admission.outcome === 'unknown') {
          const resolved = await client.request('daemon.lifecycle.resolve', { expectedOwner: original.owner, nonce: original.nonce, attemptId: attempt.attemptId, admissionId: attempt.admissionId }, { timeoutMs: 2000 })
          if (!resolved.ok || resolved.data.attemptId !== attempt.attemptId || resolved.data.admissionId !== attempt.admissionId) {
            throw new DaemonError('E_UNKNOWN', '原空闲退出准入回执未确认；保留原请求并重试核验。', 'unknown')
          }
          attempt.admitted = resolved.data.state === 'admitted'
          attempt.admissionRetired = resolved.data.state === 'not-admitted'
          attempt.admissionRequested = false
          save(context, attempt, options)
          if (!attempt.admitted) throw new DaemonError('E_UNAVAILABLE', '原空闲退出请求已核验为未接纳。重试时请确认中断；原工作仍在运行。')
        } else {
        attempt.admissionRequested = false
        delete attempt.startedAt
        // No watchdog is armed until either atomic idle admission or explicit
        // interruption consent exists. An admission race cannot kill a turn.
        attempt.phase = 'awaiting-confirmation'; save(context, attempt, options)
        if (!await options.confirm({ attemptId: attempt.attemptId, reason: attempt.reason, sessions: [], uncertain: true })) {
          attempt.phase = 'cancelled'; save(context, attempt, options); throw new LifecycleCancelled()
        }
        attempt.confirmed = true
        attempt.startedAt = Date.now()
        }
      } else attempt.admitted = true
      save(context, attempt, options)
    }
    // All stop work, including connect/RPC and GUI cleanup, shares one budget.
    // The native watchdog independently enforces the same grace when JS hangs.
    attempt.startedAt ??= Date.now()
    const grace = attempt.startedAt + 15_000, nativeDeadline = attempt.startedAt + 25_000, total = attempt.startedAt + 30_000
    attempt.phase = 'stopping'; save(context, attempt, options)
    const nativeBudget = (deadline: number): number => Math.max(1, Math.min(10_000, deadline - Date.now()))
    await lifecycleDeadline(Promise.all(scopes.map(scope => scope.arm(Math.max(0, grace - Date.now()), nativeBudget(nativeDeadline)))), grace, '原生退出监护器未能及时启动。')
    const stopping = (async (): Promise<void> => {
      const gui = Promise.resolve().then(() => options.stopAdditional?.(attempt as LifecycleAttempt))
      const daemon = (async () => {
        if (!original || originalExitedBeforeBoot) return
        if (attempt?.submitted) {
          // Inspect the original receipt only. Never replay an uncertain stop.
          if (client) await client.request('commands.get', { commandId: attempt.commandId }, { timeoutMs: 2000 })
          return
        }
        client ??= await DaemonClient.connect(context)
        if (!sameLease(client.lease, original)) throw new DaemonError('E_CONFLICT', '停止连接不属于原后台。')
        if (!attempt) throw new DaemonError('E_CONFLICT', '退出请求已丢失。')
        attempt.submitted = true; save(context, attempt, options)
        const result = await client.request('daemon.stop', { expectedOwner: original.owner,
          ...(status?.lifecycleVersion === 1 ? { lifecycle: { version: 1 as const, attemptId: attempt.attemptId, nonce: original.nonce, interrupt: attempt.confirmed } } : {})
        }, { commandId: attempt.commandId, timeoutMs: Math.max(1, grace - Date.now()) })
        if (!result.ok) throw new DaemonError(result.code, result.error, result.outcome)
      })()
      const results = await Promise.allSettled([gui, daemon])
      const changedTarget = results.find(result => result.status === 'rejected' && result.reason instanceof DaemonError && ['E_DENIED', 'E_CONFLICT'].includes(result.reason.code))
      if (changedTarget?.status === 'rejected') throw changedTarget.reason
      if (results.some(result => result.status === 'rejected')) throw new DaemonError('E_UNKNOWN', '正常退出未获完整回执，将核验原生退出范围。', 'unknown')
      while (original && !originalExitedBeforeBoot && sameLease(readLease(context), original)) {
        if (Date.now() >= grace) throw new DaemonError('E_UNKNOWN', '正常退出达到截止时间。', 'unknown')
        await pause()
      }
      await Promise.all(scopes.map(scope => scope.verify(nativeBudget(grace))))
    })()
    let verifiedGraceful = false
    try {
      await lifecycleDeadline(stopping, grace, '正常退出达到截止时间。')
      verifiedGraceful = true
    }
    catch (error) {
      if (error instanceof DaemonError && ['E_DENIED', 'E_CONFLICT'].includes(error.code)) throw error
      client?.close(); client = undefined
      while (Date.now() < grace) await pause()
      attempt.phase = 'terminating'; save(context, attempt, options)
      await lifecycleDeadline(Promise.all(scopes.map(scope => scope.terminate(nativeBudget(nativeDeadline)))), nativeDeadline, '原生终止未能在截止时间内完成。')
    }
    attempt.phase = 'verifying'; save(context, attempt, options)
    if (!verifiedGraceful) {
      await lifecycleDeadline(Promise.all(scopes.map(scope => scope.verify(nativeBudget(nativeDeadline)))), nativeDeadline, '原生退出范围核验失败。')
    }
    if (attempt.legacyGuiRecovery) attempt.legacyGuiRecovery.managedCleanup = 'verified'
    if (original) {
      const current = readLease(context)
      if (current && !sameLease(current, original)) throw new DaemonError('E_CONFLICT', '退出核验期间出现了另一个后台。')
      // Persist exact exit evidence before invoking the existing stale-owner
      // recovery path. Never clear workcopy/operation ledgers or unknown effects.
      writeAtomic(join(context.directory, `lifecycle-exit-${original.epoch}.json`), JSON.stringify({
        version: 1, attemptId: attempt.attemptId, commandId: attempt.commandId, lease: original, verifiedAt: Date.now()
      }))
      if (current) await lifecycleDeadline(reconcileStaleLease(context, attempt.attemptId), total, '原后台退出已核验，但所有权交接未完成。')
      if (readLease(context)) throw new DaemonError('E_CONFLICT', '后台所有权尚未释放。')
    }
    attempt.phase = 'released'; attempt.releasedAt = Date.now(); delete attempt.failure
    save(context, attempt, options)
    return attempt
  } catch (error) {
    if (attempt && !(error instanceof LifecycleCancelled)) {
      attempt.phase = 'failed'; attempt.failure = (error instanceof Error ? error.message : '退出核验失败').slice(0, 400)
      save(context, attempt, options)
    }
    throw error instanceof Error && attempt ? Object.assign(error, { commandId: attempt.commandId }) : error
  } finally {
    client?.close()
    await lifecycleDeadline(Promise.allSettled(scopes.map(scope => Promise.resolve(scope.dispose()))), attempt?.startedAt ? attempt.startedAt + 30_000 : Date.now() + 1500, '退出监护器收尾尚未确认。').catch(() => {})
    unlock()
  }
}

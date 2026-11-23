import { spawn, execFile, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { processOwnerSchema, type ProcessOwner } from '../../../shared/daemon'
import { workcopyOwnerSchema, type WorkcopyOwner } from '../../../shared/workcopy-use'
import { DaemonError } from '../../daemon/errors'
import { readBounded, writeAtomic, writeExclusiveAtomic } from '../../daemon/files'
import { powershellPath, processIdentity, sameOwner } from '../../daemon/native'
import { workcopyOwnerKey } from './owner-journal'
import { kernelLifetime, kernelLifetimeSchema, kernelReplaced } from './kernel-lifetime'
import { workcopyJobLauncher } from './job-launcher'
import { resolveWorkcopy } from './identity'

const uuid = z.string().uuid(), ticks = z.string().regex(/^\d+$/)
import type { AcpProcessLaunch, AcpProcessStarted } from '../acp/v2'
const ownerSchema = z.object({ version: z.literal(1), scheme: z.literal('windows-job-v1'), owner: workcopyOwnerSchema,
  root: z.string().min(1).max(4096), identityId: z.string().length(64), host: processOwnerSchema,
  kernel: kernelLifetimeSchema.optional(), launches: z.array(uuid).max(256) }).strict()
const launchSchema = z.object({ version: z.literal(1), launchId: uuid, nonce: uuid,
  purpose: z.enum(['agent', 'command-probe']), commandHash: z.string().length(64), state: z.enum(['prepared', 'running', 'cleaned']) }).strict()
const proofSchema = z.object({ version: z.literal(1), nonce: uuid, launchId: uuid, rootPid: z.number().int().positive(), rootStartedAt: ticks,
  helperPid: z.number().int().positive(), helperStartedAt: ticks }).strict()
type OwnerState = z.infer<typeof ownerSchema>
type LaunchState = z.infer<typeof launchSchema>
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const same = (a: WorkcopyOwner, b: WorkcopyOwner): boolean => a.kind === b.kind && a.id === b.id && a.generation === b.generation && a.taskKey === b.taskKey
let hostIdentity: Promise<ProcessOwner> | undefined
const currentOwners = new Set<{ directory: string; owner: WorkcopyOwner; cleanup(): Promise<void> }>()
const jobRecordWriteOptions = { retryWindowsRename: true }
const nativeHost = (): Promise<ProcessOwner> => hostIdentity ??= processIdentity(process.pid).then(value => {
  if (!value) throw new DaemonError('E_UNAVAILABLE', '无法核对原生执行所有者。')
  return value
}).catch(error => { hostIdentity = undefined; throw error })
function ownerDirectory(directory: string, owner: WorkcopyOwner): string { return join(directory, 'acp-jobs', workcopyOwnerKey(owner)) }
function readOwner(directory: string, owner: WorkcopyOwner): OwnerState | undefined {
  const file = join(ownerDirectory(directory, owner), 'owner.json')
  if (!existsSync(file)) return undefined
  const value = ownerSchema.parse(JSON.parse(readBounded(file, 64 * 1024)))
  if (!same(value.owner, owner)) throw new DaemonError('E_DENIED', '原进程 Job 所有者与运行代次不一致。')
  return value
}
function readLaunch(base: string, launchId: string): LaunchState {
  uuid.parse(launchId)
  const value = launchSchema.parse(JSON.parse(readBounded(join(base, launchId, 'owner.json'), 16 * 1024)))
  if (value.launchId !== launchId) throw new DaemonError('E_DENIED', '原进程启动见证不匹配。')
  return value
}
function checkedSpec(base: string, state: OwnerState, record: LaunchState): string {
  const directory = join(base, record.launchId), file = join(directory, 'launch.json')
  const spec = z.object({ executable: z.string(), args: z.array(z.string()), root: z.string(), jobName: z.string(),
    resultPath: z.string(), proofPath: z.string(), nonce: uuid, launchId: uuid, timeoutMs: z.literal(0), hostPid: z.number(), hostStart: ticks, windowsVerbatimArguments: z.boolean() }).strict()
    .parse(JSON.parse(readBounded(file, 256 * 1024)))
  if (spec.nonce !== record.nonce || spec.launchId !== record.launchId || spec.jobName !== `Global\\TrellisAcp-${record.nonce}`
    || spec.proofPath !== join(directory, 'proof.json') || spec.resultPath !== join(directory, 'result.json')
    || spec.hostPid !== state.host.pid || spec.hostStart !== state.host.startedAt || digest([spec.executable, spec.args, spec.root, spec.windowsVerbatimArguments]) !== record.commandHash) {
    throw new DaemonError('E_DENIED', '原进程 Job/nonce/命令见证不匹配，未触碰任何进程。')
  }
  const proof = join(directory, 'proof.json')
  if (existsSync(proof)) {
    const value = proofSchema.parse(JSON.parse(readBounded(proof, 4096)))
    if (value.nonce !== record.nonce || value.launchId !== record.launchId) throw new DaemonError('E_DENIED', '原进程 kernel 见证不属于此 Job。')
  }
  return file
}
async function cleanLaunch(directory: string, state: OwnerState, launchId: string): Promise<void> {
  const base = ownerDirectory(directory, state.owner), record = readLaunch(base, launchId)
  if (record.state === 'cleaned') return
  const spec = checkedSpec(base, state, record), launcher = workcopyJobLauncher(directory)
  const result = await new Promise<boolean>((accept) => execFile(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher, '-Mode', 'cleanup', '-SpecPath', spec], {
    windowsHide: true, timeout: 15_000, maxBuffer: 8192, encoding: 'utf8'
  }, (error, stdout) => {
    if (error) { accept(false); return }
    try { accept(z.object({ cleaned: z.boolean() }).strict().parse(JSON.parse(stdout.replace(/^\uFEFF/, '').trim())).cleaned) }
    catch { accept(false) }
  }))
  if (!result) throw new DaemonError('E_UNKNOWN', '原运行 Job 的完整清理尚未确认，原 nonce 和占用已保留，可重试原清理。', 'unknown')
  writeAtomic(join(base, launchId, 'owner.json'), JSON.stringify({ ...record, state: 'cleaned' }), jobRecordWriteOptions)
}

export interface AcpJobOwner {
  spawn(launch: AcpProcessLaunch, options: SpawnOptions): ChildProcess
  spawned(started: AcpProcessStarted): Promise<void>
  cleanup(started: AcpProcessStarted): Promise<void>
  cleanupLaunch(launchId: string): Promise<void>
  cleanupAll(): Promise<void>
}
/** One native connection owner, separate Job per actual agent/probe spawn. */
export async function createAcpJobOwner(directory: string, root: string, owner: WorkcopyOwner, probe = false): Promise<AcpJobOwner> {
  if (process.platform !== 'win32') throw new DaemonError('E_UNAVAILABLE', '当前系统没有此原生 Job 启动能力。')
  const host = await nativeHost(), kernel = await kernelLifetime().catch(() => undefined), identity = resolveWorkcopy(root), base = ownerDirectory(directory, owner)
  mkdirSync(base, { recursive: true })
  let state = readOwner(directory, owner)
  if (state && (!sameOwner(state.host, host) || state.identityId !== identity.id)) throw new DaemonError('E_CONFLICT', '此原生运行代次已由原进程拥有，不能接管。')
  if (!state) {
    state = { version: 1, scheme: 'windows-job-v1', owner, root, identityId: identity.id, host, kernel, launches: [] }
    writeExclusiveAtomic(join(base, 'owner.json'), JSON.stringify(state))
  }
  const original = state
  const children = new Map<string, ChildProcess>(), launcher = workcopyJobLauncher(directory)
  let closing = false
  const registration = { directory, owner, cleanup: async (): Promise<void> => api.cleanupAll() }
  const api: AcpJobOwner = {
    spawn(launch, options) {
      if (closing) throw new DaemonError('E_DENIED', '原运行已开始清理，不能在旧 Job 所有者下再启动进程。')
      if (probe ? launch.scope.kind !== 'runtime-probe' : launch.scope.kind !== 'runtime-session' || launch.scope.sessionKey !== owner.id) throw new DaemonError('E_DENIED', '原生进程启动范围不属于此会话。')
      if (resolveWorkcopy(launch.cwd).id !== original.identityId || resolve(String(options.cwd)).toLowerCase() !== resolve(launch.cwd).toLowerCase()) throw new DaemonError('E_DENIED', '原生进程目录与原副本不匹配。')
      if (!Array.isArray(options.stdio) || options.stdio.length !== 3 || !['pipe', 'ignore'].includes(String(options.stdio[0])) || options.stdio[1] !== 'pipe' || options.stdio[2] !== 'pipe') throw new DaemonError('E_DENIED', '原生进程 stdio 契约不受支持，未降级启动。')
      if (original.launches.includes(launch.launchId) || original.launches.length >= 256) throw new DaemonError('E_CONFLICT', '原启动代次已存在或启动上限已达，不能重复执行。')
      uuid.parse(launch.launchId)
      const target = join(base, launch.launchId), nonce = randomUUID(), purpose = launch.purpose
      mkdirSync(target)
      const spec = { executable: launch.command, args: [...launch.args], root: launch.cwd, jobName: `Global\\TrellisAcp-${nonce}`,
        resultPath: join(target, 'result.json'), proofPath: join(target, 'proof.json'), nonce, launchId: launch.launchId,
        timeoutMs: 0 as const, hostPid: host.pid, hostStart: host.startedAt, windowsVerbatimArguments: Boolean(options.windowsVerbatimArguments) }
      const record: LaunchState = { version: 1, launchId: launch.launchId, nonce, purpose,
        commandHash: digest([spec.executable, spec.args, spec.root, spec.windowsVerbatimArguments]), state: 'prepared' }
      writeExclusiveAtomic(join(target, 'launch.json'), JSON.stringify(spec))
      writeExclusiveAtomic(join(target, 'owner.json'), JSON.stringify(launchSchema.parse(record)))
      writeAtomic(join(base, 'owner.json'), JSON.stringify({ ...original, launches: [...original.launches, launch.launchId] }), jobRecordWriteOptions)
      original.launches.push(launch.launchId)
      const child = spawn(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher, '-Mode', 'transport', '-SpecPath', join(target, 'launch.json')], {
        cwd: options.cwd, env: options.env, windowsHide: true, stdio: options.stdio
      })
      children.set(launch.launchId, child)
      return child
    },
    async spawned(started) {
      const child = children.get(started.launchId)
      if (!child || child.pid !== started.pid) throw new DaemonError('E_DENIED', '原生 spawn 回执不匹配。')
      const record = readLaunch(base, started.launchId), proofPath = join(base, started.launchId, 'proof.json'), deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        if (existsSync(proofPath)) {
          let proof: z.infer<typeof proofSchema> | undefined
          try { proof = proofSchema.parse(JSON.parse(readBounded(proofPath, 4096))) } catch { /* A still-writing witness is not admission. */ }
          if (proof) {
            if (proof.nonce !== record.nonce || proof.launchId !== started.launchId || proof.helperPid !== started.pid) throw new DaemonError('E_DENIED', '原生 kernel 见证不匹配。')
            if (closing || readLaunch(base, started.launchId).state === 'cleaned') throw new DaemonError('E_DENIED', '原生 Job 已关闭，未接纳协议执行。')
            writeAtomic(join(base, started.launchId, 'owner.json'), JSON.stringify({ ...record, state: 'running' }), jobRecordWriteOptions)
            return
          }
        }
        if (child.exitCode !== null || child.signalCode !== null) throw new DaemonError('E_UNAVAILABLE', '原生进程未完成受控 Job 启动。')
        await new Promise(accept => setTimeout(accept, 30))
      }
      throw new DaemonError('E_UNKNOWN', '原生 Job 启动见证超时，未接纳协议执行。', 'unknown')
    },
    async cleanup(started) {
      const child = children.get(started.launchId)
      if (!child || child.pid !== started.pid) throw new DaemonError('E_DENIED', '清理回执不属于原生启动代次。')
      await cleanLaunch(directory, original, started.launchId)
    },
    async cleanupLaunch(launchId) {
      if (!original.launches.includes(launchId)) throw new DaemonError('E_DENIED', '清理不能选择其他所有者的启动代次。')
      await cleanLaunch(directory, original, launchId)
    },
    async cleanupAll() { closing = true; for (const launchId of original.launches) await cleanLaunch(directory, original, launchId); currentOwners.delete(registration) }
  }
  currentOwners.add(registration)
  return api
}
/** Closes this host's ACP owners, including probes, without requiring a registry installation. */
export async function shutdownAcpJobs(directory?: string): Promise<void> {
  const results = await Promise.allSettled([...currentOwners].filter(item => item.owner.kind === 'agent' && (directory === undefined || resolve(item.directory) === resolve(directory))).map(item => item.cleanup()))
  if (results.some(item => item.status === 'rejected')) throw new DaemonError('E_UNKNOWN', '原生执行或连接探测的 Job 清理尚未确认，原所有者已保留。', 'unknown')
}
/** No PID adoption: only the original durable Job names/nonces can be reconciled. */
export async function recoverAcpJobOwner(directory: string, owner: WorkcopyOwner, allowCurrentOwner = false): Promise<boolean> {
  const state = readOwner(directory, owner)
  if (!state) return false
  const host = await processIdentity(state.host.pid)
  if (host && sameOwner(host, state.host) && !(allowCurrentOwner && host.pid === process.pid)) throw new DaemonError('E_CONFLICT', '原运行所有者仍存活，请由原所有者清理。')
  const kernel = await kernelLifetime().catch(() => undefined)
  for (const launchId of state.launches) {
    if (state.kernel && kernel && kernelReplaced(state.kernel, kernel)) {
      const base = ownerDirectory(directory, owner), record = readLaunch(base, launchId)
      writeAtomic(join(base, launchId, 'owner.json'), JSON.stringify({ ...record, state: 'cleaned' }), jobRecordWriteOptions)
    } else await cleanLaunch(directory, state, launchId)
  }
  return true
}
export function hasAcpJobOwner(directory: string, owner: WorkcopyOwner): boolean { return readOwner(directory, owner) !== undefined }
/** Historical owner files survive canonical cleanup; existence is not liveness. */
export function isAcpJobOwnerCleaned(directory: string, owner: WorkcopyOwner): boolean {
  const state = readOwner(directory, owner)
  if (!state || [...currentOwners].some(item => resolve(item.directory) === resolve(directory) && same(item.owner, owner))) return false
  const base = ownerDirectory(directory, owner)
  return state.launches.every(launchId => readLaunch(base, launchId).state === 'cleaned')
}

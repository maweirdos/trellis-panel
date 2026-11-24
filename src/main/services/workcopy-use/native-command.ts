import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { processOwnerSchema, type ProcessOwner } from '../../../shared/daemon'
import {
  workcopyIdentitySchema, workcopyLeaseSchema, workcopyObservationSchema, workcopyOwnerSchema,
  type WorkcopyLease, type WorkcopyObservation, type WorkcopyRelease,
} from '../../../shared/workcopy-use'
import { DaemonError } from '../../daemon/errors'
import { readBounded, writeAtomic, writeExclusiveAtomic } from '../../daemon/files'
import { powershellPath, processIdentity, sameOwner } from '../../daemon/native'
import { resolveWorkcopy } from './identity'
import { workcopyJobLauncher } from './job-launcher'
import type { WorkcopyUseRegistry } from './registry'

const resultSchema = z.object({
  code: z.number().int().nullable(), stdout: z.string().max(4 * 1024 * 1024), stderr: z.string().max(4 * 1024 * 1024),
  aborted: z.boolean(), failedToStart: z.boolean(), cleanupConfirmed: z.boolean(), operationId: z.string().min(1).max(200)
}).strict()
export type NativeWorkcopyCommandResult = z.infer<typeof resultSchema>
const receiptSchema = z.object({
  version: z.literal(1), id: z.string().min(1).max(200), root: z.string().min(1).max(4096), digest: z.string().length(64),
  host: processOwnerSchema, lease: workcopyLeaseSchema, ownsLease: z.boolean(),
  launchDigest: z.string().length(64).optional(), admissionDigest: z.string().length(64).optional(),
  state: z.enum(['prepared', 'dispatched', 'completed', 'unknown']), result: resultSchema.optional()
}).strict()
type CommandReceipt = z.infer<typeof receiptSchema>
const pinnedParentSchema = workcopyIdentitySchema.pick({ id: true, revision: true, physicalId: true, commonId: true })
type PinnedParent = z.infer<typeof pinnedParentSchema>
const admissionReceiptSchema = z.strictObject({
  version: z.literal(1), id: receiptSchema.shape.id, root: receiptSchema.shape.root, digest: receiptSchema.shape.digest,
  directoryId: z.string().min(1), daemonDirectoryId: z.string().min(1), host: processOwnerSchema,
  owner: workcopyOwnerSchema, token: z.string().uuid(), pinnedParent: pinnedParentSchema, expected: workcopyObservationSchema,
})
export type NativeWorkcopyCommand = {
  /** Native operation identity retained by the caller, never a new ID on retry. */
  operationId: string
  executable: string
  args: string[]
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  /** An enclosing native preparation already holds writer/tree-change admission. */
  lease?: WorkcopyLease
  redactOutput?: (value: string) => string
  maxOutputBytes?: number
  maxErrorBytes?: number
}
const pending = new Map<string, Promise<NativeWorkcopyCommandResult>>()
const pendingDigests = new Map<string, string>()
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const readReceipt = (file: string): CommandReceipt => receiptSchema.parse(JSON.parse(readBounded(file, Math.min(statSync(file).size + 1, 32 * 1024 * 1024))))
const saveReceipt = (file: string, value: CommandReceipt): void => writeAtomic(file, JSON.stringify(receiptSchema.parse(value)))
type DaemonCommandAdmission = {
  directory: string
  registry: WorkcopyUseRegistry
  pinnedParent: PinnedParent
  expected: WorkcopyObservation
  signal?: AbortSignal
  assertCurrent(): void
}
function location(stateDirectory: string, root: string, id: string): { directory: string; file: string } {
  z.string().min(1).max(200).parse(id)
  // Keep the original lexical root in the key: cleanup also works if it moves.
  const directory = join(stateDirectory, 'workcopy-commands', hash([root.toLowerCase(), id]))
  return { directory, file: join(directory, 'operation.json') }
}
function unknown(id: string, stdout = '', stderr = ''): NativeWorkcopyCommandResult {
  return { code: null, stdout, stderr, aborted: true, failedToStart: false, cleanupConfirmed: false, operationId: id }
}
async function originalHostIsLiveElsewhere(host: ProcessOwner): Promise<boolean> {
  if (host.pid === process.pid) return false
  const current = await processIdentity(host.pid)
  return current !== null && sameOwner(current, host)
}
async function cleanup(directory: string, record: CommandReceipt, assertCommandFiles?: () => void): Promise<boolean> {
  if (await originalHostIsLiveElsewhere(record.host)) return false
  assertCommandFiles?.()
  const file = workcopyJobLauncher(dirname(dirname(directory)))
  return new Promise((accept) => {
    execFile(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-Mode', 'cleanup', '-SpecPath', join(directory, 'launch.json')], {
      windowsHide: true, timeout: 15_000, maxBuffer: 32 * 1024, encoding: 'utf8'
    }, (error, stdout) => {
      if (error) { accept(false); return }
      try { accept(z.object({ cleaned: z.boolean() }).strict().parse(JSON.parse(stdout.replace(/^\uFEFF/, '').trim())).cleaned) }
      catch { accept(false) }
    })
  })
}
function nativeResult(directory: string, id: string, stdout: string, stderr: string): NativeWorkcopyCommandResult | undefined {
  const file = join(directory, 'result.json')
  if (!existsSync(file)) return undefined
  const value = z.object({ code: z.number().int().nullable(), aborted: z.boolean(), failedToStart: z.boolean(), cleanupConfirmed: z.literal(true) }).strict().parse(JSON.parse(readBounded(file, 4096)))
  return { ...value, stdout, stderr, operationId: id }
}
/** Never replays the command. Reconciles and stops only its original named job. */
export async function recoverNativeWorkcopyCommand(root: string, operationId: string): Promise<NativeWorkcopyCommandResult> {
  const { daemonClientContext } = await import('../daemon-client/manager')
  const { releaseWorkcopyUse } = await import('./client')
  const { directory, file } = location((await daemonClientContext()).directory, root, operationId)
  if (!existsSync(file)) throw new DaemonError('E_CONFLICT', '未找到原生命令回执；不能重建命令身份。')
  const running = pending.get(file)
  if (running) return running
  const record = readReceipt(file)
  let result = record.result
  if (record.state !== 'completed') {
    if (!await cleanup(directory, record)) return unknown(operationId, result?.stdout, result?.stderr)
    try { result = nativeResult(directory, operationId, result?.stdout ?? '', result?.stderr ?? '') }
    catch { /* A torn result is not replayed; verified job cleanup remains valid. */ }
    result ??= { ...unknown(operationId, record.result?.stdout, record.result?.stderr), cleanupConfirmed: true }
  }
  if (!result) throw new DaemonError('E_IO', '原生命令回执不完整，原文件已保留。')
  saveReceipt(file, { ...record, state: 'completed', result })
  if (record.ownsLease) await releaseWorkcopyUse(record.root, record.lease, 'cleanup-confirmed')
  return result
}
/** The enclosing native preparation owns these receipts and their lease token. */
export async function cleanupNativeWorkcopyCommands(lease: WorkcopyLease): Promise<boolean> {
  const { daemonClientContext } = await import('../daemon-client/manager')
  const context = await daemonClientContext(), directory = join(context.directory, 'workcopy-commands')
  if (!existsSync(directory)) return true
  const { readdirSync } = await import('node:fs')
  for (const name of readdirSync(directory)) {
    if (!/^[a-f0-9]{64}$/.test(name)) continue
    const file = join(directory, name, 'operation.json')
    if (!existsSync(file)) continue
    const record = readReceipt(file)
    if (record.lease.token !== lease.token) continue
    if (!(await recoverNativeWorkcopyCommand(record.root, record.id)).cleanupConfirmed) return false
  }
  return true
}
/** Windows Job containment, durable original-command receipt and common admission. */
export async function runNativeWorkcopyCommand(root: string, input: NativeWorkcopyCommand): Promise<NativeWorkcopyCommandResult> {
  return run(root, input)
}
export async function runFreshDaemonWorkcopyCommand(
  root: string, input: NativeWorkcopyCommand & { lease?: never; env: NodeJS.ProcessEnv }, admission: DaemonCommandAdmission
): Promise<NativeWorkcopyCommandResult> {
  return run(root, input, admission)
}
export async function recoverDaemonWorkcopyCommand(
  root: string, operationId: string, input: { directory: string; registry: WorkcopyUseRegistry; pinnedParent: PinnedParent }
): Promise<NativeWorkcopyCommandResult | null> {
  const { file, directory } = location(input.directory, root, operationId)
  if (pending.has(file)) throw new DaemonError('E_BUSY', '原工作树准备命令仍在结算。')
  if (!lstatSync(directory, { throwIfNoEntry: false })) return null
  if (process.platform !== 'win32') throw new DaemonError('E_UNAVAILABLE', '原生命令清理需要 Windows Job。')
  const commandIdentity = commandDirectoryIdentity(directory)
  const admissionPath = join(directory, 'admission.json')
  const admissionText = lstatSync(admissionPath, { throwIfNoEntry: false }) ? readBounded(admissionPath, 32 * 1024) : undefined
  const intent = admissionText === undefined ? undefined : admissionReceiptSchema.parse(JSON.parse(admissionText))
  const launchPath = join(directory, 'launch.json')
  const resultPath = join(directory, 'result.json')
  const assertAdmission = (): void => {
    if (!intent || intent.root !== root || intent.id !== operationId || intent.owner.kind !== 'git' ||
      intent.owner.id !== operationId || intent.expected.id !== input.pinnedParent.id ||
      intent.pinnedParent.id !== input.pinnedParent.id || intent.pinnedParent.revision !== input.pinnedParent.revision ||
      intent.pinnedParent.physicalId !== input.pinnedParent.physicalId || intent.pinnedParent.commonId !== input.pinnedParent.commonId ||
      intent.directoryId !== commandDirectoryIdentity(directory) || intent.daemonDirectoryId !== commandDirectoryIdentity(input.directory) ||
      readBounded(admissionPath, 32 * 1024) !== admissionText) {
      throw new DaemonError('E_UNKNOWN', '原工作树准备的预写准入回执无法核对。', 'unknown')
    }
  }
  const release = (token: string, owner: WorkcopyLease['owner']): void => {
    if (!input.registry.release({ token, owner, outcome: 'cleanup-confirmed' }).released) {
      throw new DaemonError('E_UNKNOWN', '原工作树准备登记尚未确认释放。', 'unknown')
    }
  }
  const notStarted = { ...unknown(operationId), aborted: false, failedToStart: true, cleanupConfirmed: true }
  if (!lstatSync(file, { throwIfNoEntry: false })) {
    const assertNoDispatch = (): void => {
      assertAdmission()
      if (lstatSync(file, { throwIfNoEntry: false }) || lstatSync(launchPath, { throwIfNoEntry: false }) ||
        lstatSync(resultPath, { throwIfNoEntry: false })) {
        throw new DaemonError('E_UNKNOWN', '原工作树准备的启动证据不完整，不能确认未启动。', 'unknown')
      }
    }
    assertNoDispatch()
    if (!intent) throw new DaemonError('E_UNKNOWN', '缺少原工作树准备的预写准入回执。', 'unknown')
    if (await originalHostIsLiveElsewhere(intent.host).catch(() => true)) return unknown(operationId)
    assertNoDispatch()
    const lease = input.registry.leaseByDigest(createHash('sha256').update(intent.token).digest('hex'), intent.owner)
    if (lease && (lease.kind !== 'tree-change' || lease.identity.id !== intent.expected.id || lease.identity.revision !== intent.expected.revision ||
      lease.identity.physicalId !== intent.pinnedParent.physicalId || lease.identity.commonId !== intent.pinnedParent.commonId)) {
      throw new DaemonError('E_UNKNOWN', '预写令牌对应的原工作树登记无法核对。', 'unknown')
    }
    release(intent.token, intent.owner)
    return notStarted
  }
  const original = readReceipt(file)
  const assertCommandFiles = (): void => {
    if (commandDirectoryIdentity(directory) !== commandIdentity ||
      hash(readBounded(launchPath, 64 * 1024)) !== original.launchDigest) {
      throw new DaemonError('E_UNKNOWN', '原工作树命令启动凭据已变化，清理待核对。', 'unknown')
    }
    if (original.admissionDigest || intent) assertAdmission()
  }
  if (!original.launchDigest || original.root !== root || original.id !== operationId || !original.ownsLease ||
    original.lease.identity.id !== input.pinnedParent.id || original.lease.kind !== 'tree-change' ||
    original.lease.owner.kind !== 'git' || original.lease.owner.id !== operationId) {
    throw new DaemonError('E_CONFLICT', '工作树清理回执与原操作不一致。')
  }
  if (original.admissionDigest || intent) {
    assertAdmission()
    if (!intent || admissionText === undefined || original.admissionDigest !== hash(admissionText) || original.digest !== intent.digest ||
      !sameOwner(original.host, intent.host) || original.lease.token !== intent.token ||
      original.lease.owner.generation !== intent.owner.generation || original.lease.owner.taskKey !== intent.owner.taskKey ||
      original.lease.identity.revision !== intent.expected.revision ||
      original.lease.identity.physicalId !== intent.pinnedParent.physicalId || original.lease.identity.commonId !== intent.pinnedParent.commonId) {
      throw new DaemonError('E_UNKNOWN', '原工作树命令与预写准入回执不一致，清理待核对。', 'unknown')
    }
  }
  let result = original.result
  if (original.state === 'prepared') {
    if (await originalHostIsLiveElsewhere(original.host).catch(() => true)) return unknown(operationId)
    if (lstatSync(resultPath, { throwIfNoEntry: false }) || readReceipt(file).state !== 'prepared') {
      throw new DaemonError('E_UNKNOWN', '原工作树命令已越过未派发边界。', 'unknown')
    }
    if (!intent || lstatSync(launchPath, { throwIfNoEntry: false })) assertCommandFiles()
    else assertAdmission()
    if (!lstatSync(launchPath, { throwIfNoEntry: false })) {
      release(original.lease.token, original.lease.owner)
      return notStarted
    }
    result = notStarted
  } else {
    assertCommandFiles()
  }
  if (original.state === 'dispatched' || original.state === 'unknown') {
    if (!await cleanup(directory, original, assertCommandFiles).catch(() => false)) return unknown(operationId, result?.stdout, result?.stderr)
    assertCommandFiles()
    try { result = nativeResult(directory, operationId, result?.stdout ?? '', result?.stderr ?? '') }
    catch { result = undefined }
    result ??= { ...unknown(operationId), cleanupConfirmed: true }
  }
  if (!result?.cleanupConfirmed) throw new DaemonError('E_UNKNOWN', '原工作树命令清理回执待核对。', 'unknown')
  saveReceipt(file, { ...original, state: 'completed', result })
  release(original.lease.token, original.lease.owner)
  return result
}
async function run(root: string, input: NativeWorkcopyCommand, admission?: DaemonCommandAdmission): Promise<NativeWorkcopyCommandResult> {
  if (process.platform !== 'win32') throw new DaemonError('E_UNAVAILABLE', '此命令入口尚无可恢复的原生进程容器，未接纳写入。')
  admission?.assertCurrent()
  const stateDirectory = admission ? admission.directory : (await (await import('../daemon-client/manager')).daemonClientContext()).directory
  const { file, directory } = location(stateDirectory, root, input.operationId)
  const digest = hash([root, input.executable, input.args, input.env ?? null, input.timeoutMs ?? 30_000, input.maxOutputBytes ?? 64 * 1024, input.maxErrorBytes ?? 64 * 1024])
  const current = pending.get(file)
  if (admission && (current || lstatSync(directory, { throwIfNoEntry: false }))) {
    throw new DaemonError('E_UNKNOWN', '原工作树准备命令已有记录，需核对原回执。', 'unknown')
  }
  if (current) {
    if (pendingDigests.get(file) !== digest) throw new DaemonError('E_CONFLICT', '原命令身份对应不同输入。')
    return current
  }
  if (existsSync(file)) {
    if (readReceipt(file).digest !== digest) throw new DaemonError('E_CONFLICT', '原命令身份对应不同输入，未重复执行。')
    return recoverNativeWorkcopyCommand(root, input.operationId)
  }
  const work = execute(root, input, digest, directory, file, admission)
  pending.set(file, work)
  pendingDigests.set(file, digest)
  try { return await work }
  finally { if (pending.get(file) === work) { pending.delete(file); pendingDigests.delete(file) } }
}
function commandDirectoryIdentity(directory: string): string {
  const stat = lstatSync(directory, { bigint: true })
  if (!stat.isDirectory() || realpathSync.native(directory).toLowerCase() !== resolve(directory).toLowerCase()) {
    throw new DaemonError('E_DENIED', '原生命令回执目录发生重定向。')
  }
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
}
async function execute(root: string, input: NativeWorkcopyCommand, digest: string, directory: string, file: string, admission?: DaemonCommandAdmission): Promise<NativeWorkcopyCommandResult> {
  const outputCap = z.number().int().min(1).max(4 * 1024 * 1024).parse(input.maxOutputBytes ?? 64 * 1024)
  const errorCap = z.number().int().min(1).max(4 * 1024 * 1024).parse(input.maxErrorBytes ?? 64 * 1024)
  const timeoutMs = z.number().int().min(1).max(10 * 60_000).parse(input.timeoutMs ?? 30_000)
  if (input.lease && !['writer', 'tree-change', 'git-mutation'].includes(input.lease.kind)) throw new DaemonError('E_DENIED', '原生命令需要写入登记。')
  const owner = { kind: 'git' as const, id: input.operationId, generation: randomUUID(), label: admission ? '委派工作树准备' : 'Trellis 任务命令' }
  const commandRoot = dirname(directory)
  const admissionPath = join(directory, 'admission.json')
  let commandIdentity: string | undefined, admissionText: string | undefined
  let host: ProcessOwner, lease: WorkcopyLease, release: (outcome: WorkcopyRelease['outcome'], reason?: string) => void | Promise<void>
  if (admission) {
    const actual = await processIdentity(process.pid)
    if (!actual) throw new DaemonError('E_UNAVAILABLE', '当前 daemon 原生进程身份不可用。')
    host = actual
    admission.assertCurrent()
    if (!lstatSync(commandRoot, { throwIfNoEntry: false })) mkdirSync(commandRoot)
    commandDirectoryIdentity(commandRoot)
    mkdirSync(directory)
    commandIdentity = commandDirectoryIdentity(directory)
    const token = randomUUID()
    admissionText = JSON.stringify(admissionReceiptSchema.parse({
      version: 1, id: input.operationId, root, digest, host, owner, token, directoryId: commandIdentity,
      daemonDirectoryId: commandDirectoryIdentity(admission.directory), pinnedParent: admission.pinnedParent, expected: admission.expected,
    }))
    writeExclusiveAtomic(admissionPath, admissionText)
    lease = admission.registry.acquire(root, { kind: 'tree-change', owner, expected: admission.expected, token })
    release = (outcome, reason) => {
      const result = admission.registry.release({ token: lease.token, owner, outcome, reason })
      if (outcome === 'cleanup-confirmed' && !result.released) throw new DaemonError('E_UNKNOWN', '原工作树准备登记尚未确认释放。', 'unknown')
    }
  } else {
    const { daemonClientContext } = await import('../daemon-client/manager')
    const { acquireWorkcopyUse, assertWorkcopyUse, releaseWorkcopyUse } = await import('./client')
    const identity = resolveWorkcopy(root)
    host = (await daemonClientContext()).owner
    if (input.lease) await assertWorkcopyUse(root, input.lease)
    lease = input.lease ?? await acquireWorkcopyUse(root, { kind: 'writer', owner, expected: identity })
    release = (outcome, reason) => releaseWorkcopyUse(root, lease, outcome, reason)
  }
  let record: CommandReceipt = { version: 1, id: input.operationId, root, digest, host, lease, ownsLease: !input.lease, state: 'prepared' }
  let started = false
  try {
    if (!admission) mkdirSync(directory, { recursive: true })
    const runner = workcopyJobLauncher(dirname(commandRoot))
    const launchPath = join(directory, 'launch.json')
    const spec = JSON.stringify({
      executable: input.executable, args: input.args, root: realpathSync.native(root),
      jobName: `Local\\TrellisWorkcopy-${randomUUID()}`, resultPath: join(directory, 'result.json'),
      timeoutMs, hostPid: host.pid, hostStart: host.startedAt
    })
    if (admissionText !== undefined) {
      record = { ...record, launchDigest: hash(spec), admissionDigest: hash(admissionText) }
      writeExclusiveAtomic(file, JSON.stringify(receiptSchema.parse(record)))
      writeExclusiveAtomic(launchPath, spec)
    } else {
      writeExclusiveAtomic(launchPath, spec)
      writeExclusiveAtomic(file, JSON.stringify(receiptSchema.parse(record)))
    }
    const assertCommandFiles = (): void => {
      if (commandIdentity !== undefined && (commandDirectoryIdentity(directory) !== commandIdentity ||
        readBounded(admissionPath, 32 * 1024) !== admissionText || readBounded(launchPath, 64 * 1024) !== spec)) {
        throw new DaemonError('E_UNKNOWN', '原生命令回执目录已变化，清理待核对。', 'unknown')
      }
    }
    admission?.registry.assertLeaseHeld(lease.token, lease.owner)
    admission?.assertCurrent()
    assertCommandFiles()
    record = { ...record, state: 'dispatched' }; saveReceipt(file, record)
    started = true
    const result = await new Promise<NativeWorkcopyCommandResult>((accept) => {
      const child = spawn(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runner, '-Mode', 'run', '-SpecPath', join(directory, 'launch.json')], {
        cwd: root, env: admission ? input.env : { ...process.env, ...input.env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
      })
      const out: Buffer[] = [], err: Buffer[] = []
      let outBytes = 0, errBytes = 0, overflow = false
      const output = (buffers: Buffer[]): string => (input.redactOutput ?? (value => value))(Buffer.concat(buffers).toString('utf8'))
      let cleanupPending: Promise<boolean> | undefined
      const cleanupOnce = (): Promise<boolean> => cleanupPending ??= cleanup(directory, record, assertCommandFiles).catch(() => false)
      const stopOverflow = (): void => { if (!overflow) { overflow = true; void cleanupOnce() } }
      child.stdout.on('data', (chunk: Buffer) => { if (outBytes < outputCap) out.push(chunk.subarray(0, outputCap - outBytes)); outBytes += chunk.length; if (outBytes > outputCap) stopOverflow() })
      child.stderr.on('data', (chunk: Buffer) => { if (errBytes < errorCap) err.push(chunk.subarray(0, errorCap - errBytes)); errBytes += chunk.length; if (errBytes > errorCap) stopOverflow() })
      let stopping = false
      let settled = false
      const stop = (): void => {
        if (stopping || settled) return
        stopping = true
        void cleanupOnce().then(cleaned => {
          child.stdout.destroy(); child.stderr.destroy(); child.unref()
          const stdout = output(out), stderr = output(err)
          let result: NativeWorkcopyCommandResult | undefined
          if (cleaned && admission && !overflow) {
            try {
              assertCommandFiles()
              result = nativeResult(directory, input.operationId, stdout, stderr)
            } catch {}
          }
          finish(result ?? { ...unknown(input.operationId, stdout, stderr), cleanupConfirmed: cleaned })
        }).catch(() => finish(unknown(input.operationId)))
      }
      const timer = setTimeout(stop, timeoutMs + 12_000)
      const finish = (result: NativeWorkcopyCommandResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        admission?.signal?.removeEventListener('abort', stop)
        accept(result)
      }
      child.once('error', () => {
        if (!stopping) finish({ ...unknown(input.operationId), aborted: false, failedToStart: true, cleanupConfirmed: true })
      })
      child.once('close', () => {
        if (stopping || settled) return
        try {
          const stdout = output(out), stderr = output(err)
          assertCommandFiles()
          const result = nativeResult(directory, input.operationId, stdout, stderr) ?? unknown(input.operationId, stdout, stderr)
          finish(overflow ? { ...result, code: null, aborted: true } : result)
        }
        catch { finish(unknown(input.operationId)) }
      })
      admission?.signal?.addEventListener('abort', stop, { once: true })
      if (admission?.signal?.aborted) stop()
    })
    assertCommandFiles()
    saveReceipt(file, { ...record, state: result.cleanupConfirmed ? 'completed' : 'unknown', result })
    if (record.ownsLease) await release(result.cleanupConfirmed ? 'cleanup-confirmed' : 'unknown', '原 Trellis 命令子进程清理待核对。')
    return result
  } catch (error) {
    if (record.ownsLease) {
      try { await release(started ? 'unknown' : 'cleanup-confirmed') } catch {}
    }
    if (admission && started) throw new DaemonError('E_UNKNOWN', '原工作树准备命令或清理回执待核对。', 'unknown')
    throw error
  }
}

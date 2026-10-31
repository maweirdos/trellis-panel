import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { processOwnerSchema } from '../../../shared/daemon'
import { workcopyLeaseSchema, type WorkcopyLease } from '../../../shared/workcopy-use'
import { DaemonError } from '../../daemon/errors'
import { readBounded, writeAtomic, writeExclusiveAtomic } from '../../daemon/files'
import { powershellPath, processIdentity, sameOwner } from '../../daemon/native'
import { daemonClientContext } from '../daemon-client/manager'
import { acquireWorkcopyUse, assertWorkcopyUse, releaseWorkcopyUse } from './client'
import { resolveWorkcopy } from './identity'
import { workcopyJobLauncher } from './job-launcher'

const resultSchema = z.object({
  code: z.number().int().nullable(), stdout: z.string().max(4 * 1024 * 1024), stderr: z.string().max(4 * 1024 * 1024),
  aborted: z.boolean(), failedToStart: z.boolean(), cleanupConfirmed: z.boolean(), operationId: z.string().min(1).max(200)
}).strict()
export type NativeWorkcopyCommandResult = z.infer<typeof resultSchema>
const receiptSchema = z.object({
  version: z.literal(1), id: z.string().min(1).max(200), root: z.string().min(1).max(4096), digest: z.string().length(64),
  host: processOwnerSchema, lease: workcopyLeaseSchema, ownsLease: z.boolean(),
  state: z.enum(['prepared', 'dispatched', 'completed', 'unknown']), result: resultSchema.optional()
}).strict()
type CommandReceipt = z.infer<typeof receiptSchema>
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
async function location(root: string, id: string): Promise<{ directory: string; file: string }> {
  z.string().min(1).max(200).parse(id)
  const context = await daemonClientContext()
  // Keep the original lexical root in the key: cleanup also works if it moves.
  const directory = join(context.directory, 'workcopy-commands', hash([root.toLowerCase(), id]))
  return { directory, file: join(directory, 'operation.json') }
}
async function launcher(): Promise<string> {
  return workcopyJobLauncher((await daemonClientContext()).directory)
}
function unknown(id: string, stdout = '', stderr = ''): NativeWorkcopyCommandResult {
  return { code: null, stdout, stderr, aborted: true, failedToStart: false, cleanupConfirmed: false, operationId: id }
}
async function cleanup(directory: string, record: CommandReceipt): Promise<boolean> {
  const current = await processIdentity(record.host.pid)
  if (current && sameOwner(current, record.host) && record.host.pid !== process.pid) return false
  const file = await launcher()
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
  const { directory, file } = await location(root, operationId)
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
  if (process.platform !== 'win32') throw new DaemonError('E_UNAVAILABLE', '此命令入口尚无可恢复的原生进程容器，未接纳写入。')
  const { file, directory } = await location(root, input.operationId)
  const digest = hash([root, input.executable, input.args, input.env ?? null, input.timeoutMs ?? 30_000, input.maxOutputBytes ?? 64 * 1024, input.maxErrorBytes ?? 64 * 1024])
  const current = pending.get(file)
  if (current) {
    if (pendingDigests.get(file) !== digest) throw new DaemonError('E_CONFLICT', '原命令身份对应不同输入。')
    return current
  }
  if (existsSync(file)) {
    if (readReceipt(file).digest !== digest) throw new DaemonError('E_CONFLICT', '原命令身份对应不同输入，未重复执行。')
    return recoverNativeWorkcopyCommand(root, input.operationId)
  }
  const work = execute(root, input, digest, directory, file)
  pending.set(file, work)
  pendingDigests.set(file, digest)
  try { return await work }
  finally { if (pending.get(file) === work) { pending.delete(file); pendingDigests.delete(file) } }
}
async function execute(root: string, input: NativeWorkcopyCommand, digest: string, directory: string, file: string): Promise<NativeWorkcopyCommandResult> {
  const outputCap = z.number().int().min(1).max(4 * 1024 * 1024).parse(input.maxOutputBytes ?? 64 * 1024)
  const errorCap = z.number().int().min(1).max(4 * 1024 * 1024).parse(input.maxErrorBytes ?? 64 * 1024)
  const timeoutMs = z.number().int().min(1).max(10 * 60_000).parse(input.timeoutMs ?? 30_000)
  const identity = resolveWorkcopy(root), context = await daemonClientContext()
  if (input.lease && !['writer', 'tree-change', 'git-mutation'].includes(input.lease.kind)) throw new DaemonError('E_DENIED', '原生命令需要写入登记。')
  const generation = randomUUID()
  if (input.lease) await assertWorkcopyUse(root, input.lease)
  const lease = input.lease ?? await acquireWorkcopyUse(root, { kind: 'writer', owner: { kind: 'git', id: input.operationId, generation, label: 'Trellis 任务命令' }, expected: identity })
  let record: CommandReceipt = { version: 1, id: input.operationId, root, digest, host: context.owner, lease, ownsLease: !input.lease, state: 'prepared' }
  let started = false
  try {
    mkdirSync(directory, { recursive: true })
    const runner = await launcher()
    writeExclusiveAtomic(join(directory, 'launch.json'), JSON.stringify({
      executable: input.executable, args: input.args, root: realpathSync.native(root),
      jobName: `Local\\TrellisWorkcopy-${randomUUID()}`, resultPath: join(directory, 'result.json'),
      timeoutMs, hostPid: context.owner.pid, hostStart: context.owner.startedAt
    }))
    writeExclusiveAtomic(file, JSON.stringify(receiptSchema.parse(record)))
    record = { ...record, state: 'dispatched' }; saveReceipt(file, record)
    started = true
    const result = await new Promise<NativeWorkcopyCommandResult>((accept) => {
      const child = spawn(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runner, '-Mode', 'run', '-SpecPath', join(directory, 'launch.json')], {
        cwd: root, env: { ...process.env, ...input.env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
      })
      const out: Buffer[] = [], err: Buffer[] = []
      let outBytes = 0, errBytes = 0, overflow = false
      const output = (buffers: Buffer[]): string => (input.redactOutput ?? (value => value))(Buffer.concat(buffers).toString('utf8'))
      const stopOverflow = (): void => { if (!overflow) { overflow = true; void cleanup(directory, record).catch(() => false) } }
      child.stdout.on('data', (chunk: Buffer) => { if (outBytes < outputCap) out.push(chunk.subarray(0, outputCap - outBytes)); outBytes += chunk.length; if (outBytes > outputCap) stopOverflow() })
      child.stderr.on('data', (chunk: Buffer) => { if (errBytes < errorCap) err.push(chunk.subarray(0, errorCap - errBytes)); errBytes += chunk.length; if (errBytes > errorCap) stopOverflow() })
      const timer = setTimeout(() => {
        void cleanup(directory, record).then(cleaned => {
          child.stdout.destroy(); child.stderr.destroy(); child.unref()
          accept({ ...unknown(input.operationId, output(out), output(err)), cleanupConfirmed: cleaned })
        }).catch(() => accept(unknown(input.operationId)))
      }, timeoutMs + 12_000)
      child.once('error', () => { clearTimeout(timer); accept({ ...unknown(input.operationId), aborted: false, failedToStart: true, cleanupConfirmed: true }) })
      child.once('close', () => {
        clearTimeout(timer)
        const stdout = output(out), stderr = output(err)
        try {
          const result = nativeResult(directory, input.operationId, stdout, stderr) ?? unknown(input.operationId, stdout, stderr)
          accept(overflow ? { ...result, code: null, aborted: true } : result)
        }
        catch { accept(unknown(input.operationId, stdout, stderr)) }
      })
    })
    saveReceipt(file, { ...record, state: result.cleanupConfirmed ? 'completed' : 'unknown', result })
    if (record.ownsLease) await releaseWorkcopyUse(root, lease, result.cleanupConfirmed ? 'cleanup-confirmed' : 'unknown', '原 Trellis 命令子进程清理待核对。')
    return result
  } catch (error) {
    if (record.ownsLease) await releaseWorkcopyUse(root, lease, started ? 'unknown' : 'cleanup-confirmed').catch(() => {})
    throw error
  }
}

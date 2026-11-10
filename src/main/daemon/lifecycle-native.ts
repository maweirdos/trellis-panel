import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { daemonIdentitySchema, processOwnerSchema, type ProcessOwner } from '../../shared/daemon'
import type { DaemonContext } from './context'
import { type DaemonLease, daemonLeaseSchema, readLease } from './lease'
import { DaemonError } from './errors'
import { readBounded, writeAtomic } from './files'
import { nativeResource, powershellPath, sameOwner } from './native'
import { WINDOWS_WORKCOPY_COMMAND } from '../services/workcopy-use/windows-command'
import { nativeJobProofSchema } from './job-proof'

/** Capture is read-only. Arm only after consent or an authoritative idle admission.
 * dispose/disarm cancel a pending watchdog, never a termination already underway. */
export interface DaemonTermination {
  /** Native kernel boot proof, never inferred from a missing root PID alone. */
  readonly exitedBeforeBoot?: true
  readonly legacyGuiRecovery?: { owner: ProcessOwner; unmanagedDescendants: 'unknown'; requiresConfirmation: boolean }
  arm(graceMs: number, timeoutMs: number): Promise<void>
  disarm(): Promise<void>
  terminate(timeoutMs: number): Promise<void>
  verify(timeoutMs: number): Promise<void>
  dispose(): Promise<void>
}
const uuid = z.string().uuid()
const proofSchema = nativeJobProofSchema
const processDetailsSchema = z.object({ owner: processOwnerSchema, argv: z.array(z.string()).max(256) })
const inspectionSchema = z.object({ root: processDetailsSchema.nullable(), children: z.array(processDetailsSchema).max(4096), bootStartedAt: z.string().regex(/^[0-9]{1,19}$/).optional() })
type ProcessDetails = z.infer<typeof processDetailsSchema>
type Job = { name: string; processes: ProcessOwner[]; roots?: Array<{ pid: number; startedAt: string }> }
type Scope = {
  root: ProcessOwner; argv: string[]; contained: boolean; directory: string
  jobs: Job[]; helpers: ProcessOwner[]; inventory: string[]; recovering?: boolean; bootStartedAt?: string
}
const scopeSchema = z.object({
  root: processOwnerSchema, argv: z.array(z.string()).max(256), contained: z.boolean(), directory: z.string(),
  jobs: z.array(z.object({ name: z.string(), processes: z.array(processOwnerSchema),
    roots: z.array(z.object({ pid: z.number().int().positive(), startedAt: z.string() })).optional() })).max(4096),
  helpers: z.array(processOwnerSchema).max(4096), inventory: z.array(z.string()).max(4096), recovering: z.boolean().optional(),
  bootStartedAt: z.string().regex(/^[0-9]{1,19}$/).optional()
}).strict()
const nativeReasonSchema = z.enum(['native-failure', 'identity-changed', 'scope-changed', 'unwitnessed-child', 'job-mismatch',
  'access-denied', 'root-alive', 'job-not-empty', 'helper-alive', 'command-unavailable'])
const responseSchema = z.object({ id: z.number().optional(), type: z.string().optional(), ok: z.boolean().optional(), line: z.number().int().optional(),
  exitedBeforeBoot: z.boolean().optional(),
  phase: z.enum(['capture', 'arm', 'disarm', 'dispose', 'terminate', 'verify', 'watchdog']).optional(),
  reason: nativeReasonSchema.optional(), nativeError: z.number().int().optional(),
  helpers: z.array(processOwnerSchema).max(4096).optional() }).passthrough()
type Response = z.infer<typeof responseSchema>
const nativeReasons: Record<z.infer<typeof nativeReasonSchema>, string> = {
  'native-failure': 'Windows 未能完成原生进程核验',
  'identity-changed': '原进程身份已变化，未接管其他进程',
  'scope-changed': '原后台的执行范围已变化，请重新核对',
  'unwitnessed-child': '原后台仍有缺少归属见证的子进程',
  'job-mismatch': '原进程与受控 Job 的归属见证不一致',
  'access-denied': 'Windows 拒绝访问原进程，请检查运行权限',
  'root-alive': '原后台进程尚未退出',
  'job-not-empty': '原后台的受控子进程尚未退出',
  'helper-alive': '原后台的传输或监护进程尚未退出',
  'command-unavailable': '无法读取原进程的启动参数，未采用未经核实的范围'
}
function nativeFailure(message: Response): DaemonError {
  const reason = message.reason ?? 'native-failure'
  return Object.assign(unavailable(`${nativeReasons[reason]}。${message.phase ? `（${message.phase}${message.nativeError !== undefined ? ` / Win32 ${message.nativeError}` : ''}）` : ''}`),
    { nativeDiagnostic: { phase: message.phase, reason, nativeError: message.nativeError, line: message.line } })
}
function unavailable(message: string): DaemonError { return new DaemonError('E_UNKNOWN', message, 'unknown') }
function children(directory: string): string[] {
  if (!existsSync(directory)) return []
  if (lstatSync(directory).isSymbolicLink()) throw new DaemonError('E_DENIED', 'Native ownership directory is redirected.')
  const entries = readdirSync(directory, { withFileTypes: true })
  if (entries.length > 4096) throw new DaemonError('E_UNAVAILABLE', 'Native ownership inventory exceeds its bounded limit.')
  return entries.filter(entry => {
    if (entry.isSymbolicLink()) throw new DaemonError('E_DENIED', 'Native ownership inventory is redirected.')
    return entry.isDirectory()
  }).map(entry => join(directory, entry.name))
}
function record(file: string): unknown { return JSON.parse(readBounded(file, 1024 * 1024)) }
function sameGeneration(a: ProcessOwner, b: ProcessOwner): boolean {
  const first = { ...a, startedAt: (BigInt(a.startedAt) / 10n).toString() }
  const second = { ...b, startedAt: (BigInt(b.startedAt) / 10n).toString() }
  if (sameOwner(first, second)) return true
  if (first.pid !== second.pid || first.startedAt !== second.startedAt || first.userId !== second.userId) return false
  return realpathSync.native(a.executable).toLowerCase() === realpathSync.native(b.executable).toLowerCase()
}
async function query(mode: 'inspect' | 'discover-gui', input: unknown): Promise<unknown> {
  return new Promise((accept, reject) => {
    const child = spawn(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      nativeResource('windows-lifecycle.ps1'), '-Mode', mode], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', failed = false
    const timer = setTimeout(() => {
      failed = true; child.stdin.destroy(); child.kill()
      reject(unavailable('Native process inspection exceeded its deadline.'))
    }, 7000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (text: string) => {
      output += text
      if (output.length > 1024 * 1024) { failed = true; child.kill(); reject(unavailable('Native process inspection exceeded its size bound.')) }
    })
    child.stderr.resume()
    child.stdin.on('error', () => {})
    child.once('error', error => { clearTimeout(timer); failed = true; reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      if (failed) return
      if (code !== 0) {
        try { reject(nativeFailure(responseSchema.parse(JSON.parse(output.replace(/^\uFEFF/, '').trim())))) }
        catch { reject(unavailable('Native process inspection could not establish the original scope.')) }
        return
      }
      try { accept(JSON.parse(output.replace(/^\uFEFF/, '').trim())) }
      catch { reject(unavailable('Native process inspection returned invalid evidence.')) }
    })
    child.stdin.end(JSON.stringify(input) + '\n')
  })
}
async function controller(scope: Scope): Promise<DaemonTermination> {
  const child = spawn(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    nativeResource('windows-lifecycle.ps1'), '-Mode', 'controller'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let sequence = 0, buffer = '', closed = false, disposed = false, exitedBeforeBoot = false
  const pending = new Map<number, { accept(): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
  let readyAccept: () => void = () => {}, readyReject: (error: Error) => void = () => {}
  const ready = new Promise<void>((accept, reject) => { readyAccept = accept; readyReject = reject })
  const startupTimer = setTimeout(() => { fail(unavailable('Native handle capture exceeded its deadline.')); child.stdin.end(); child.kill() }, 8000)
  function fail(error: Error): void {
    readyReject(error)
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error) }
    pending.clear()
  }
  function received(message: Response): void {
    if (message.type === 'ready') {
      exitedBeforeBoot = message.exitedBeforeBoot === true
      if (message.helpers) scope.helpers = message.helpers
      clearTimeout(startupTimer); readyAccept(); return
    }
    if (message.type === 'failed') { fail(nativeFailure(message)); return }
    if (message.id === undefined) return // Watchdog facts are reconciled by verify, never presumed successful.
    const call = pending.get(message.id)
    if (!call) return
    clearTimeout(call.timer); pending.delete(message.id)
    if (message.ok) call.accept()
    else call.reject(nativeFailure(message))
  }
  child.stdout.setEncoding('utf8'); child.stderr.resume()
  child.stdout.on('data', (text: string) => {
    buffer += text
    if (buffer.length > 1024 * 1024) { fail(unavailable('Native controller response exceeded its bound.')); child.stdin.end(); return }
    let boundary: number
    while ((boundary = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, boundary).replace(/^\uFEFF/, '').trim(); buffer = buffer.slice(boundary + 1)
      if (!line) continue
      try { received(responseSchema.parse(JSON.parse(line))) }
      catch { fail(unavailable('Native controller returned invalid evidence.')) }
    }
  })
  child.stdin.on('error', () => fail(unavailable('Native controller input was lost.')))
  child.once('error', () => { closed = true; clearTimeout(startupTimer); fail(unavailable('Native controller could not start.')) })
  child.once('close', () => { closed = true; clearTimeout(startupTimer); fail(unavailable('Native controller exited before acknowledging the operation.')) })
  child.stdin.write(JSON.stringify(scope) + '\n')
  try { await ready } catch (error) { child.stdin.end(); throw error }
  function command(operation: string, timeoutMs = 1000, graceMs?: number): Promise<void> {
    if (closed || disposed) return Promise.reject(unavailable('The captured native controller is no longer available.'))
    const id = ++sequence
    return new Promise<void>((accept, reject) => {
      // The native shared deadline includes all stop requests and verification.
      const timer = setTimeout(() => { pending.delete(id); reject(unavailable('Native operation acknowledgement exceeded its deadline.')) }, timeoutMs + 250)
      pending.set(id, { accept, reject, timer })
      child.stdin.write(JSON.stringify({ id, operation, timeoutMs, graceMs }) + '\n', error => {
        if (error) { clearTimeout(timer); pending.delete(id); reject(unavailable('Native controller input was lost.')) }
      })
    })
  }
  const budget = (value: number): number => z.number().int().min(1).max(10000).parse(value)
  return {
    ...(exitedBeforeBoot ? { exitedBeforeBoot: true as const } : {}),
    arm: (graceMs, timeoutMs) => command('arm', budget(timeoutMs), z.number().int().min(0).max(15000).parse(graceMs)),
    disarm: () => command('disarm'),
    terminate: timeoutMs => command('terminate', budget(timeoutMs)),
    verify: timeoutMs => command('verify', z.number().int().min(1).max(30000).parse(timeoutMs)),
    async dispose() {
      if (disposed || closed) return
      try { await command('dispose') } finally { disposed = true; child.stdin.end() }
    }
  }
}
function legacyJobs(context: DaemonContext, owner: ProcessOwner): Pick<Scope, 'jobs' | 'helpers' | 'inventory'> & { transports: string[] } {
  const jobs: Job[] = [], helpers: ProcessOwner[] = [], inventory: string[] = [], transports: string[] = []
  const ownerRecord = z.object({ host: processOwnerSchema, launches: z.array(uuid).max(256) }).passthrough()
  const launchRecord = z.object({ nonce: uuid, launchId: uuid, commandHash: z.string().length(64) }).passthrough()
  const launchSpec = z.object({
    executable: z.string(), args: z.array(z.string()), root: z.string(), jobName: z.string(),
    nonce: uuid.optional(), launchId: uuid.optional(), hostPid: z.number(), hostStart: z.string(),
    windowsVerbatimArguments: z.boolean().optional()
  }).passthrough()
  const proof = z.object({ nonce: uuid, launchId: uuid, rootPid: z.number().int(), rootStartedAt: z.string(), helperPid: z.number().int(), helperStartedAt: z.string() }).passthrough()
  for (const base of children(join(context.directory, 'acp-jobs'))) {
    const file = join(base, 'owner.json')
    if (!existsSync(file)) continue
    const stored = ownerRecord.parse(record(file))
    if (!sameGeneration(stored.host, owner)) continue
    inventory.push(`${file}|${stored.launches.join(',')}`)
    for (const launchId of stored.launches) {
      const directory = join(base, launchId), original = launchRecord.parse(record(join(directory, 'owner.json')))
      const spec = launchSpec.parse(record(join(directory, 'launch.json')))
      const digest = createHash('sha256').update(JSON.stringify([spec.executable, spec.args, spec.root, spec.windowsVerbatimArguments])).digest('hex')
      if (original.launchId !== launchId || spec.launchId !== launchId || spec.nonce !== original.nonce || spec.jobName !== `Global\\TrellisAcp-${original.nonce}`
        || spec.hostPid !== owner.pid || BigInt(spec.hostStart) / 10n !== BigInt(owner.startedAt) / 10n || digest !== original.commandHash) {
        throw new DaemonError('E_DENIED', 'Legacy Job launch evidence does not match its original host.')
      }
      const file = join(directory, 'proof.json')
      if (!existsSync(file)) throw unavailable('A legacy launch has no kernel witness; its cleanup cannot be certified.')
      const witness = proof.parse(record(file))
      if (witness.nonce !== original.nonce || witness.launchId !== launchId) throw new DaemonError('E_DENIED', 'Legacy Job nonce changed.')
      // Kernel image/SID for roots is supplied by a fresh native inspection below.
      jobs.push({ name: spec.jobName, processes: [], roots: [{ pid: witness.rootPid, startedAt: witness.rootStartedAt }] })
      helpers.push({ pid: witness.helperPid, startedAt: witness.helperStartedAt, userId: owner.userId, executable: powershellPath() })
    }
  }
  for (const base of children(join(context.directory, 'workcopy-commands'))) {
    const file = join(base, 'operation.json')
    if (!existsSync(file)) continue
    const original = z.object({ host: processOwnerSchema }).passthrough().parse(record(file))
    if (!sameGeneration(original.host, owner)) continue
    inventory.push(`${file}|`)
    const spec = launchSpec.parse(record(join(base, 'launch.json')))
    if (spec.hostPid !== owner.pid || BigInt(spec.hostStart) / 10n !== BigInt(owner.startedAt) / 10n || !/^Local\\TrellisWorkcopy-[a-f0-9-]{36}$/.test(spec.jobName)) throw new DaemonError('E_DENIED', 'Legacy command scope changed.')
    jobs.push({ name: spec.jobName, processes: [] })
    transports.push(join(base, 'launch.json'))
  }
  return { jobs, helpers, inventory, transports }
}
async function prepareScope(context: DaemonContext, owner: ProcessOwner, argv: string[], contained: boolean, jobs: Job[], helpers: ProcessOwner[], inventory: string[]): Promise<DaemonTermination> {
  return controller({ root: owner, argv, contained, directory: context.directory, jobs, helpers, inventory, recovering: contained })
}
export async function verifyGuiJobRoot(directory: string, proof: z.infer<typeof nativeJobProofSchema>): Promise<void> {
  const scope = await controller({ root: proof.root, argv: [], contained: true, directory,
    jobs: [{ name: proof.jobName, processes: [] }], helpers: [proof.guardian], inventory: [] })
  await scope.dispose()
}
async function prepareGuiJob(context: DaemonContext, owner: ProcessOwner): Promise<DaemonTermination | null> {
  for (const base of children(join(context.directory, 'gui-jobs'))) {
    const file = join(base, 'proof.json')
    if (!existsSync(file)) continue
    const proof = proofSchema.parse(record(file))
    if (!sameGeneration(proof.root, owner)) continue
    if (proof.identity.profileId !== context.identity.profileId || proof.identity.installationId !== context.identity.installationId ||
      proof.identity.mode !== context.identity.mode || proof.identity.userId !== context.identity.userId || proof.jobName !== `Global\\CruxGui-${proof.nonce}`) {
      throw new DaemonError('E_DENIED', '桌面 Job 见证不属于当前安装或配置。')
    }
    return prepareScope(context, owner, [], true, [{ name: proof.jobName, processes: [] }], [proof.guardian], [])
  }
  return null
}
function legacyCaptureFile(context: DaemonContext, owner: ProcessOwner): string {
  const key = createHash('sha256').update(JSON.stringify([context.identity.installationId, context.identity.profileId,
    owner.pid, (BigInt(owner.startedAt) / 10n).toString(), owner.userId, owner.executable.toLowerCase()])).digest('hex')
  return join(context.directory, `native-lifecycle-scope-${key}.json`)
}
async function guiScope(context: DaemonContext, owner: ProcessOwner, inspection: z.infer<typeof inspectionSchema>, recoverExitedLegacy: boolean): Promise<DaemonTermination> {
  const job = await prepareGuiJob(context, owner)
  if (job) return job
  const beforeBoot = inspection.bootStartedAt && BigInt(owner.startedAt) > 0n && BigInt(owner.startedAt) < BigInt(inspection.bootStartedAt)
  if (inspection.root || beforeBoot || existsSync(legacyCaptureFile(context, owner)) || !recoverExitedLegacy) {
    return legacyScope(context, owner, inspection)
  }
  // A dead old GUI is not the daemon's execution authority. Reconcile its
  // registered managed jobs; preserve the unrecorded legacy effects as unknown.
  const { transports: _transports, ...registered } = legacyJobs(context, owner)
  const scope = await controller({ root: owner, argv: [], contained: false, directory: context.directory, ...registered, recovering: true })
  const key = createHash('sha256').update(JSON.stringify(owner)).digest('hex')
  return {
    ...scope,
    legacyGuiRecovery: { owner, unmanagedDescendants: 'unknown', requiresConfirmation: registered.jobs.length > 0 },
    async verify(timeoutMs) {
      await scope.verify(timeoutMs)
      writeAtomic(join(context.directory, `legacy-gui-recovery-${key}.json`), JSON.stringify({
        version: 1, identity: context.identity, owner, rootExited: true, managedJobsVerifiedAt: Date.now(), unmanagedDescendants: 'unknown'
      }))
    }
  }
}
async function legacyScope(context: DaemonContext, owner: ProcessOwner, inspection: z.infer<typeof inspectionSchema>): Promise<DaemonTermination> {
  const captureFile = legacyCaptureFile(context, owner)
  if (!inspection.root) {
    if (inspection.bootStartedAt && BigInt(owner.startedAt) > 0n && BigInt(owner.startedAt) < BigInt(inspection.bootStartedAt)) {
      // The native controller independently checks this kernel boot witness.
      // A reboot ended the original tree; no current PID or Job is a target.
      return controller({ root: owner, argv: [], contained: false, directory: context.directory,
        jobs: [], helpers: [], inventory: [], recovering: true, bootStartedAt: inspection.bootStartedAt })
    }
    if (!existsSync(captureFile)) throw unavailable('原后台已退出，但缺少本次开机内的子进程归属记录，尚不能核实清理完成。请重新启动 Windows 后重试；已保存的会话和配置会保留。')
    const captured = z.object({ version: z.literal(1), identity: daemonIdentitySchema, scope: scopeSchema }).strict().parse(record(captureFile))
    if (captured.identity.profileId !== context.identity.profileId || captured.identity.installationId !== context.identity.installationId
      || !sameGeneration(captured.scope.root, owner) || captured.scope.directory !== context.directory || captured.scope.contained) throw new DaemonError('E_DENIED', 'Retained native scope belongs to another owner.')
    return controller({ ...captured.scope, recovering: true })
  }
  const { transports, ...scope } = legacyJobs(context, owner)
  for (const child of inspection.children) {
    if (scope.helpers.some(helper => sameGeneration(helper, child.owner))) continue
    const args = child.argv.slice(1)
    const target = context.lifecycleInstallation
    const pipePath = target ? join(dirname(target.appPath), 'daemon', 'windows-pipe.ps1') : nativeResource('windows-pipe.ps1')
    const pipe = args.length === 9 && child.owner.executable.toLowerCase() === powershellPath().toLowerCase()
      && args[0] === '-NoLogo' && args[1] === '-NoProfile' && args[2] === '-NonInteractive'
      && args[3] === '-ExecutionPolicy' && args[4] === 'Bypass' && args[5] === '-File'
      && args[6].toLowerCase() === pipePath.toLowerCase() && args[7] === '-Name'
      && [context.pipeName, `crux-gui-lifecycle-${context.identity.profileId}-${context.identity.installationId.slice(0, 16)}`].includes(args[8])
    const chromium = child.owner.executable.toLowerCase() === owner.executable.toLowerCase()
      && args.some(arg => /^--type=(renderer|gpu-process|utility|crashpad-handler)$/.test(arg))
    const runner = join(context.directory, `workcopy-command-${createHash('sha256').update(WINDOWS_WORKCOPY_COMMAND).digest('hex')}.ps1`)
    const workcopy = args.length === 11 && child.owner.executable.toLowerCase() === powershellPath().toLowerCase()
      && args[0] === '-NoLogo' && args[1] === '-NoProfile' && args[2] === '-NonInteractive' && args[3] === '-ExecutionPolicy'
      && args[4] === 'Bypass' && args[5] === '-File' && args[6].toLowerCase() === runner.toLowerCase()
      && args[7] === '-Mode' && args[8] === 'run' && args[9] === '-SpecPath' && transports.includes(args[10])
      && readBounded(runner, 64 * 1024) === WINDOWS_WORKCOPY_COMMAND
    if (child.owner.userId === owner.userId && (pipe || chromium || workcopy)) scope.helpers.push(child.owner)
    // Other children must belong to a captured named Job; the controller checks coverage.
  }
  const captured: Scope = { root: owner, argv: inspection.root.argv, contained: false, directory: context.directory, ...scope }
  const control = await controller(captured)
  try { writeAtomic(captureFile, JSON.stringify({ version: 1, identity: context.identity, scope: captured })) }
  catch (error) { await control.dispose(); throw error }
  return control
}
export async function prepareDaemonTermination(context: DaemonContext, lease: DaemonLease): Promise<DaemonTermination> {
  if (lease.identity.installationId !== context.identity.installationId || lease.identity.profileId !== context.identity.profileId
    || lease.identity.mode !== context.identity.mode || lease.owner.userId !== context.identity.userId) throw new DaemonError('E_DENIED', 'Daemon termination target belongs to another installation or profile.')
  const current = readLease(context)
  if (current && JSON.stringify(current) !== JSON.stringify(daemonLeaseSchema.parse(lease))) throw new DaemonError('E_CONFLICT', 'Daemon termination cannot capture a replacement owner.')
  for (const base of children(join(context.directory, 'daemon-jobs'))) {
    const file = join(base, 'proof.json')
    if (!existsSync(file)) continue
    const proof = proofSchema.parse(record(file))
    if (!sameGeneration(proof.root, lease.owner)) continue
    if (proof.identity.profileId !== lease.identity.profileId || proof.identity.installationId !== lease.identity.installationId
      || proof.identity.userId !== lease.identity.userId || proof.jobName !== `Global\\CruxDaemon-${proof.nonce}`) throw new DaemonError('E_DENIED', 'Daemon Job witness belongs to another launch.')
    // The pre-resume launch witness plus retained Job membership establishes
    // this generation without a WMI command-line round trip to a hung owner.
    return prepareScope(context, lease.owner, [], true,
      [{ name: proof.jobName, processes: [] }], [proof.guardian], [])
  }
  const inspection = inspectionSchema.parse(await query('inspect', { root: lease.owner }))
  return legacyScope(context, lease.owner, inspection)
}
/** Main-owned installation discovery only; no renderer paths/PIDs are accepted. */
export async function prepareGuiTermination(context: DaemonContext, options?: { recoverExitedLegacy?: boolean }): Promise<DaemonTermination | null> {
  const target = context.lifecycleInstallation
  const appPath = target?.appPath ?? realpathSync(app.getAppPath())
  const executable = target?.executable ?? realpathSync(process.execPath)
  const defaultProfile = join(app.getPath('appData'), app.getName())
  const ownerFile = join(context.directory, 'gui-lifecycle-owner.json')
  let guiOwner: ProcessOwner | undefined
  if (existsSync(ownerFile)) {
    const stored = z.object({ version: z.literal(1), identity: daemonIdentitySchema, owner: processOwnerSchema }).strict().parse(record(ownerFile))
    if (stored.identity.profileId !== context.identity.profileId || stored.identity.installationId !== context.identity.installationId
      || stored.identity.mode !== context.identity.mode || stored.identity.userId !== context.identity.userId
      || stored.owner.userId !== context.identity.userId) throw new DaemonError('E_DENIED', 'GUI owner belongs to another installation or profile.')
    if (!sameGeneration(stored.owner, context.owner)) guiOwner = stored.owner
  }
  const lease = readLease(context)
  if (lease && (lease.identity.installationId !== context.identity.installationId || lease.identity.profileId !== context.identity.profileId
    || lease.identity.mode !== context.identity.mode || lease.identity.userId !== context.identity.userId
    || lease.owner.userId !== context.identity.userId)) throw new DaemonError('E_DENIED', 'GUI discovery cannot use another installation or profile daemon owner.')
  // A branded dev host changes its physical path when its build inputs change.
  // Only these protected, same-scope owners may extend the current executable.
  const executables = [...new Map([executable, ...(guiOwner ? [guiOwner.executable] : []), ...(lease ? [lease.owner.executable] : [])]
    .map(path => { const canonical = realpathSync.native(path); return [canonical.toLowerCase(), canonical] as const })).values()]
  let ownLauncher: ProcessOwner | undefined
  const ownMarker = process.argv.find(value => value.startsWith('--trellis-gui-contained='))?.slice('--trellis-gui-contained='.length)
  if (ownMarker) {
    uuid.parse(ownMarker)
    const proof = proofSchema.parse(record(join(context.directory, 'gui-jobs', ownMarker, 'proof.json')))
    if (!sameGeneration(proof.root, context.owner) || proof.identity.profileId !== context.identity.profileId ||
      proof.identity.installationId !== context.identity.installationId || proof.identity.userId !== context.identity.userId) {
      throw new DaemonError('E_DENIED', '当前桌面启动器见证不属于本代次。')
    }
    ownLauncher = proof.controller
  }
  const discovered = z.object({ candidates: z.array(processDetailsSchema).max(8) }).parse(await query('discover-gui', {
    executables, appPath: target || app.isPackaged ? null : appPath, excludePid: process.pid,
    excludeOwner: ownLauncher,
    userId: context.identity.userId, userData: context.userData, guiOwner, daemonOwner: lease?.owner,
    allowDefaultProfile: existsSync(defaultProfile) && realpathSync.native(defaultProfile).toLowerCase() === realpathSync.native(context.userData).toLowerCase()
  }))
  const captureFile = join(context.directory, 'gui-lifecycle-capture.json')
  const captureSchema = z.object({ version: z.literal(1), identity: daemonIdentitySchema, owner: processOwnerSchema, state: z.enum(['captured', 'exited']) }).strict()
  const previous = existsSync(captureFile) ? captureSchema.parse(record(captureFile)) : null
  if (previous && (previous.identity.profileId !== context.identity.profileId || previous.identity.installationId !== context.identity.installationId
    || previous.identity.userId !== context.identity.userId)) throw new DaemonError('E_DENIED', 'Retained GUI scope belongs to another installation.')
  if (discovered.candidates.length > 1) throw new DaemonError('E_CONFLICT', 'Multiple exact GUI owners require explicit reconciliation.')
  const targetGui: ProcessDetails | undefined = discovered.candidates[0]
  if (guiOwner && targetGui && !sameGeneration(guiOwner, targetGui.owner) && (!previous || !sameGeneration(guiOwner, previous.owner))) {
    const registered = inspectionSchema.parse(await query('inspect', { root: guiOwner, recovering: true }))
    if (registered.root) throw new DaemonError('E_CONFLICT', '原登记桌面仍在运行，不能跳过它接管另一个桌面。')
    const registeredScope = await guiScope(context, guiOwner, registered, options?.recoverExitedLegacy === true)
    try { await registeredScope.verify(1000) } finally { await registeredScope.dispose() }
  }
  if (previous?.state === 'captured' && targetGui && !sameGeneration(previous.owner, targetGui.owner)) {
    const oldInspection = inspectionSchema.parse(await query('inspect', { root: previous.owner, recovering: true }))
    if (oldInspection.root) throw new DaemonError('E_CONFLICT', 'The original GUI scope is still active alongside another GUI.')
    const oldScope = await guiScope(context, previous.owner, oldInspection, options?.recoverExitedLegacy === true)
    try { await oldScope.verify(1000) } finally { await oldScope.dispose() }
    if (JSON.stringify(captureSchema.parse(record(captureFile))) !== JSON.stringify(previous)) throw new DaemonError('E_CONFLICT', 'The original GUI capture changed during reconciliation.')
    previous.state = 'exited'
    writeAtomic(captureFile, JSON.stringify(previous))
  }
  const owner = previous?.state === 'captured' ? previous.owner : targetGui?.owner ?? guiOwner
  if (!owner) return null
  const inspection = inspectionSchema.parse(await query('inspect', { root: owner, recovering: true }))
  if (targetGui && inspection.root && JSON.stringify(inspection.root.argv) !== JSON.stringify(targetGui.argv)) throw new DaemonError('E_CONFLICT', 'Original GUI changed during capture.')
  // A dead GUI root does not erase its previously captured renderer/transport
  // obligation. Reopen the original durable scope before permitting release.
  const scope = await guiScope(context, owner, inspection, options?.recoverExitedLegacy === true)
  if (scope.legacyGuiRecovery) return scope
  const capture = captureSchema.parse({ version: 1, identity: context.identity, owner, state: 'captured' })
  const original = JSON.stringify(capture)
  try { writeAtomic(captureFile, original) } catch (error) { await scope.dispose(); throw error }
  return {
    ...scope,
    async verify(timeoutMs) {
      await scope.verify(timeoutMs)
      const receipt = JSON.stringify({ ...capture, state: 'exited' })
      const current = readBounded(captureFile, 8192)
      if (current !== original && current !== receipt) throw new DaemonError('E_CONFLICT', 'The GUI verification target changed before its exit receipt.')
      if (current !== receipt) writeAtomic(captureFile, receipt)
    }
  }
}

/** The dev wrapper must re-exec with an absolute script argument before issuing
 * an intent. Environment-supplied cwd/root and a UUID are not launch evidence. */
export async function verifyDevelopmentLauncher(owner: ProcessOwner, appPath: string): Promise<void> {
  const inspection = inspectionSchema.parse(await query('inspect', { root: owner, children: false }))
  const script = inspection.root?.argv[1]
  if (!inspection.root || !sameGeneration(inspection.root.owner, owner) || !script || !isAbsolute(script)
    || realpathSync(script).toLowerCase() !== realpathSync(join(appPath, 'scripts', 'dev.mjs')).toLowerCase()) {
    throw new DaemonError('E_DENIED', 'Development restart requires the original absolute launcher script and native process identity.')
  }
}

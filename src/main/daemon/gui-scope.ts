import { app } from 'electron'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { cachedGuardianExecutable, nativeResource, powershellPath, processIdentity, protectDirectory } from './native'
import { readBounded, writeExclusiveAtomic } from './files'
import { nativeJobProofSchema } from './job-proof'
import { processOwnerSchema } from '../../shared/daemon'
import { DaemonError } from './errors'
import { verifyGuiJobRoot } from './lifecycle-native'
import { fastDetachProcess } from './win32-fast'

const markerPrefix = '--trellis-gui-contained='
const sameBirth = (a: string, b: string): boolean => BigInt(a) / 10n === BigInt(b) / 10n
function nativeLaunch(args: string[], timeout?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ...args],
      { windowsHide: true, ...(timeout ? { timeout } : {}), maxBuffer: 4096, encoding: 'utf8' },
      (error, stdout) => error ? reject(new DaemonError('E_UNKNOWN', '桌面原生范围未获确认，保留原启动见证。', 'unknown')) : resolve(stdout.trim()))
  })
}

/** A dev launcher stays headless while its atomically contained GUI lives. */
export async function runGuiProcessBootstrap(argumentsAtLaunch = process.argv.slice(1)): Promise<boolean> {
  const owner = await processIdentity(process.pid)
  if (!owner) throw new DaemonError('E_UNAVAILABLE', '无法核验当前桌面进程。')
  const userData = realpathSync(app.getPath('userData'))
  const mode = app.isPackaged ? 'production' : 'development'
  const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
  const identity = { userId: owner.userId, mode, appVersion: app.getVersion(),
    profileId: digest(`${owner.userId}\0${userData.toLowerCase()}\0${mode}`),
    installationId: digest(realpathSync(app.getAppPath()).toLowerCase()) }
  const base = join(userData, 'daemon-v1', mode, 'gui-jobs')
  mkdirSync(base, { recursive: true })
  if (lstatSync(base).isSymbolicLink()) throw new DaemonError('E_DENIED', '桌面进程范围目录不能重定向。')
  const markers = argumentsAtLaunch.filter(value => value.startsWith(markerPrefix))
  if (markers.length > 1) throw new DaemonError('E_INVALID_ARG', '桌面范围身份必须唯一。')
  const nonce = markers[0] ? z.string().uuid().parse(markers[0].slice(markerPrefix.length)) : randomUUID()
  const directory = join(base, nonce), proofFile = join(directory, 'proof.json')
  const validProof = (): z.infer<typeof nativeJobProofSchema> => {
    const proof = nativeJobProofSchema.parse(JSON.parse(readBounded(proofFile, 8192)))
    if (proof.nonce !== nonce || proof.jobName !== `Global\\CruxGui-${nonce}` ||
      Object.entries(identity).some(([key, value]) => proof.identity[key as keyof typeof identity] !== value)) {
      throw new DaemonError('E_DENIED', '桌面进程范围见证不属于当前安装与配置。')
    }
    return proof
  }
  if (markers[0]) {
    const proof = validProof()
    if (proof.root.pid !== owner.pid || proof.root.userId !== owner.userId || !sameBirth(proof.root.startedAt, owner.startedAt) ||
      realpathSync.native(proof.root.executable).toLowerCase() !== realpathSync.native(owner.executable).toLowerCase()) {
      throw new DaemonError('E_DENIED', '桌面进程范围见证不属于当前原生代次。')
    }
    await verifyGuiJobRoot(join(userData, 'daemon-v1', mode), proof)
    return true
  }
  const cacheDir = join(userData, 'daemon-v1', mode, 'native-cache')
  mkdirSync(directory); await protectDirectory(directory)
  const childArgs = argumentsAtLaunch.filter(value => !value.startsWith('--trellis-role='))
  childArgs.push('--trellis-role=gui', markerPrefix + nonce)
  const spec = { version: 1, nonce, jobName: `Global\\CruxGui-${nonce}`, identity, controller: owner,
    watchController: !app.isPackaged, executable: realpathSync(process.execPath), args: childArgs }
  const specPath = join(directory, 'launch.json')
  writeExclusiveAtomic(specPath, JSON.stringify(spec))
  let guardian: z.infer<typeof processOwnerSchema>
  const guardianExe = cachedGuardianExecutable(cacheDir)
  const fastGuardian = guardianExe
    ? fastDetachProcess(guardianExe, ['gui-guardian', specPath])
    : fastDetachProcess(
      powershellPath(),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        nativeResource('windows-lifecycle.ps1'), '-Mode', 'gui-guardian', '-SpecPath', specPath, '-CacheDir', cacheDir]
    )
  if (fastGuardian) {
    guardian = processOwnerSchema.parse(fastGuardian)
  } else {
    const reply = await nativeLaunch([nativeResource('windows-launch-gui.ps1'), '-SpecPath', specPath], 10_000)
    guardian = z.object({ guardian: processOwnerSchema }).strict().parse(JSON.parse(reply)).guardian
  }
  const deadline = Date.now() + 10_000
  while (!existsSync(proofFile)) {
    if (existsSync(join(directory, 'failure.json')) || Date.now() > deadline) throw new DaemonError('E_UNAVAILABLE', '桌面受管进程范围未能建立。')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const proof = validProof()
  if (!proof.controller || proof.controller.pid !== owner.pid || !sameBirth(proof.controller.startedAt, owner.startedAt) ||
    proof.guardian.pid !== guardian.pid || !sameBirth(proof.guardian.startedAt, guardian.startedAt)) {
    throw new DaemonError('E_DENIED', '桌面监护器与原启动身份不一致。')
  }
  if (!app.isPackaged) {
    const released = z.object({ nonce: z.literal(nonce), cleaned: z.literal(true) }).strict().parse(JSON.parse(
      await nativeLaunch([nativeResource('windows-lifecycle.ps1'), '-Mode', 'gui-wait', '-SpecPath', specPath, '-CacheDir', cacheDir])))
    if (!released.cleaned) throw new DaemonError('E_UNKNOWN', '桌面原范围尚未结束。', 'unknown')
  }
  return false
}

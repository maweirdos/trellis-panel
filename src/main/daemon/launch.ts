import { execFile } from 'node:child_process'
import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { cachedGuardianExecutable, nativeResource, powershellPath, processIdentity, protectDirectory } from './native'
import { DaemonError } from './errors'
import { readBounded, writeExclusiveAtomic } from './files'
import { fastDetachProcess } from './win32-fast'

const sameBirth = (a: string, b: string): boolean => {
  try { return BigInt(a) / 10n === BigInt(b) / 10n } catch { return false }
}

/** Private daemon bootstrap only; never an arbitrary renderer process launcher. */
export async function launchDaemonProcess(args: string[], env: NodeJS.ProcessEnv): Promise<{ pid: number }> {
  if ((args.length !== 2 && args.length !== 3) || args.at(-2) !== '--trellis-role=daemon'
    || !/^--trellis-user-data-base64=[A-Za-z0-9+/=]+$/.test(args.at(-1) ?? '') || args.some(arg => arg.includes('\0'))
    || (args.length === 3 && !isAbsolute(args[0]))) throw new DaemonError('E_INVALID_ARG', 'Invalid native daemon bootstrap arguments.')
  const userData = realpathSync(Buffer.from((args.at(-1) ?? '').slice('--trellis-user-data-base64='.length), 'base64').toString('utf8'))
  const mode = app.isPackaged ? 'production' : 'development'
  const owner = await processIdentity(process.pid)
  if (!owner) throw new DaemonError('E_UNAVAILABLE', 'Daemon launch requires the current native user identity.')
  const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
  const nonce = randomUUID(), directory = join(userData, 'daemon-v1', mode, 'daemon-jobs', nonce)
  const cacheDir = join(userData, 'daemon-v1', mode, 'native-cache')
  mkdirSync(directory, { recursive: true }); await protectDirectory(directory)
  const specPath = join(directory, 'launch.json')
  writeExclusiveAtomic(specPath, JSON.stringify({
    version: 1, nonce, jobName: `Global\\CruxDaemon-${nonce}`, executable: realpathSync(process.execPath), args,
    identity: { userId: owner.userId, mode, appVersion: app.getVersion(),
      profileId: hash(`${owner.userId}\0${userData.toLowerCase()}\0${mode}`), installationId: hash(realpathSync(app.getAppPath()).toLowerCase()) }
  }))
  const environment = { ...env }
  for (const key of Object.keys(environment)) {
    if (/^(CRUX|TRELLIS|TPANEL)_DEV_(LAUNCH|RESTART)/i.test(key)) delete environment[key]
  }
  // 优先直接通过 Win32 CreateProcessW(BREAKAWAY) 拉起受保护的 14KB 原生 guardian（~40ms），
  // 首次尚未生成缓存时回退至 windows-lifecycle.ps1（并在 Resume 后自动编译落盘供后续启动复用）。
  const guardianExe = cachedGuardianExecutable(cacheDir)
  const guardian = guardianExe
    ? fastDetachProcess(guardianExe, ['guardian', specPath], { breakaway: true, env: environment })
    : fastDetachProcess(
      powershellPath(),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        nativeResource('windows-lifecycle.ps1'), '-Mode', 'guardian', '-SpecPath', specPath, '-CacheDir', cacheDir],
      { breakaway: true, env: environment }
    )
  if (guardian) {
    const proofFile = join(directory, 'proof.json')
    const failureFile = join(directory, 'failure.json')
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      if (existsSync(proofFile)) {
        try {
          const proof = z.object({
            nonce: z.string(),
            guardian: z.object({ pid: z.number().int().positive(), startedAt: z.string() }).passthrough(),
            root: z.object({ pid: z.number().int().positive().safe() }).passthrough()
          }).passthrough().parse(JSON.parse(readBounded(proofFile, 8192)))
          if (proof.nonce !== nonce || proof.guardian.pid !== guardian.pid || !sameBirth(proof.guardian.startedAt, guardian.startedAt)) {
            throw new DaemonError('E_UNKNOWN', 'Native daemon launch witness mismatch.', 'unknown')
          }
          return { pid: proof.root.pid }
        } catch (error) {
          if (error instanceof DaemonError) throw error
        }
      }
      if (existsSync(failureFile)) {
        throw new DaemonError('E_UNKNOWN', 'Native daemon launch was not confirmed. Inspect its original lease and startup diagnostic before another start.', 'unknown')
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new DaemonError('E_UNKNOWN', 'Native daemon launch was not confirmed. Inspect its original lease and startup diagnostic before another start.', 'unknown')
  }
  return new Promise((resolve, reject) => {
    execFile(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', nativeResource('windows-launch-daemon.ps1'),
      '-SpecPath', specPath],
    { env: environment, windowsHide: true, timeout: 10000, maxBuffer: 4096, encoding: 'utf8' }, (error, stdout) => {
      if (!error) {
        const parsed = z.object({ pid: z.number().int().positive().safe() }).strict().safeParse((() => { try { return JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) } catch { return null } })())
        if (parsed.success) { resolve(parsed.data); return }
      }
      // Launch acknowledgement can be lost after creation. Never kill/relaunch.
      reject(new DaemonError('E_UNKNOWN', 'Native daemon launch was not confirmed. Inspect its original lease and startup diagnostic before another start.', 'unknown'))
    })
  })
}

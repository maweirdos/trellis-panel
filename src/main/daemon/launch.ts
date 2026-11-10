import { execFile } from 'node:child_process'
import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { nativeResource, powershellPath } from './native'
import { DaemonError } from './errors'
import { processIdentity, protectDirectory } from './native'
import { writeExclusiveAtomic } from './files'

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

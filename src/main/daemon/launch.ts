import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { nativeResource, powershellPath } from './native'
import { DaemonError } from './errors'

/** Private daemon bootstrap only; never an arbitrary renderer process launcher. */
export async function launchDaemonProcess(args: string[], env: NodeJS.ProcessEnv): Promise<{ pid: number }> {
  if ((args.length !== 2 && args.length !== 3) || args.at(-2) !== '--trellis-role=daemon'
    || !/^--trellis-user-data-base64=[A-Za-z0-9+/=]+$/.test(args.at(-1) ?? '') || args.some(arg => arg.includes('\0'))
    || (args.length === 3 && !isAbsolute(args[0]))) throw new DaemonError('E_INVALID_ARG', 'Invalid native daemon bootstrap arguments.')
  return new Promise((resolve, reject) => {
    execFile(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', nativeResource('windows-launch-daemon.ps1'),
      '-ExecutableBase64', Buffer.from(process.execPath).toString('base64'), '-ArgumentsBase64', Buffer.from(JSON.stringify(args)).toString('base64')],
    { env, windowsHide: true, timeout: 10000, maxBuffer: 4096, encoding: 'utf8' }, (error, stdout) => {
      if (!error) {
        const parsed = z.object({ pid: z.number().int().positive().safe() }).strict().safeParse((() => { try { return JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) } catch { return null } })())
        if (parsed.success) { resolve(parsed.data); return }
      }
      // Launch acknowledgement can be lost after creation. Never kill/relaunch.
      reject(new DaemonError('E_UNKNOWN', 'Native daemon launch was not confirmed. Inspect its original lease and startup diagnostic before another start.', 'unknown'))
    })
  })
}

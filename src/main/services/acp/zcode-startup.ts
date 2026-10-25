import { app } from 'electron'
import { execFile } from 'node:child_process'
import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { writeAtomic } from '../../daemon/files'
import { acpDataPath } from './metadata'

const preparations = new Map<string, Promise<void>>()
const resultSchema = z.object({ version: z.literal(1), status: z.enum(['prepared', 'unsupported', 'degraded', 'fallback']) }).passthrough()

export function zcodeStartupCacheDirectory(): string {
  try { return join(realpathSync.native(app.getPath('userData')), 'acp', 'runtime-cache', 'zcode') }
  catch { return acpDataPath('runtime-cache', 'zcode') }
}

function loaderPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'adapters', 'zcode-acp', 'src', 'managed-zcode-launch.cjs')
    : join(app.getAppPath(), 'adapters', 'zcode-acp', 'src', 'managed-zcode-launch.cjs')
}
function cacheDirectory(): string {
  const root = app.getPath('userData')
  const directory = zcodeStartupCacheDirectory()
  mkdirSync(directory, { recursive: true })
  for (const item of [root, join(root, 'acp'), join(root, 'acp', 'runtime-cache'), directory]) {
    const entry = lstatSync(item)
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw Error('Startup cache directory was redirected')
  }
  const expected = join(realpathSync.native(root), 'acp', 'runtime-cache', 'zcode')
  const key = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path
  if (key(realpathSync.native(directory)) !== key(expected)) throw Error('Startup cache left its owned profile')
  return directory
}

/** One automatic preparation after installation selection; never authenticates
 * or creates a native conversation. Cache failure preserves the official path. */
export function prepareBundledZcodeStartup(nodePath: string, cliPath: string): Promise<void> {
  if (!isAbsolute(nodePath) || !isAbsolute(cliPath) || !cliPath.toLowerCase().endsWith('.cjs')) return Promise.resolve()
  const key = `${nodePath}\0${cliPath}`
  const retained = preparations.get(key)
  if (retained) return retained
  const pending = (async (): Promise<void> => {
    let directory: string | undefined
    let status: 'prepared' | 'unsupported' | 'fallback' = 'fallback'
    let reason = 'preparation_unavailable'
    const startedAt = Date.now()
    try {
      const loader = loaderPath(), entry = lstatSync(loader)
      if (!entry.isFile() || entry.isSymbolicLink()) return
      directory = cacheDirectory()
      const env: NodeJS.ProcessEnv = { ...process.env, TRELLIS_ZCODE_STARTUP_CACHE_DIR: directory }
      delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.TPANEL_DEBUG_PORT
      const value: unknown = await new Promise((resolve, reject) => {
        execFile(nodePath, [loader, '--prepare', cliPath], { env, cwd: dirname(cliPath), windowsHide: true, timeout: 180_000, maxBuffer: 16 * 1024, encoding: 'utf8' }, (error, stdout) => {
          try {
            const parsed = resultSchema.parse(JSON.parse(stdout.replace(/^\uFEFF/, '').trim()))
            const expectedExit = parsed.status === 'unsupported' ? 2 : parsed.status === 'degraded' ? 1 : 0
            if (error && (error.killed || error.code !== expectedExit)) { reject(error); return }
            resolve(parsed)
          } catch { reject(Error('Invalid preparation result')) }
        })
      })
      const result = resultSchema.parse(value)
      status = result.status === 'degraded' ? 'fallback' : result.status
      reason = status === 'prepared' ? 'prepared' : 'official_fallback'
    } catch { /* No speculative installation repair or authorization fallback. */ }
    finally {
      if (directory) {
        try { writeAtomic(join(directory, 'preparation-status.json'), JSON.stringify({ version: 1, status, reason, startedAt, durationMs: Date.now() - startedAt })) }
        catch { /* Diagnostic publication cannot make a valid official install fail. */ }
      }
    }
  })()
  preparations.set(key, pending)
  void pending.finally(() => { if (preparations.get(key) === pending) preparations.delete(key) })
  return pending
}

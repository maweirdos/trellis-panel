import { spawn } from 'node:child_process'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'

const capabilitiesSchema = z.object({
  adapterVersion: z.literal(1), serviceOwnedState: z.literal(true), normalLocalHooks: z.literal(true),
  protectedMetadata: z.literal(true), rejectLocalArchive: z.literal(true), readOnlyProbe: z.literal(true)
}).passthrough()
export type TeamTrellisCapabilities = z.infer<typeof capabilitiesSchema>
export type TeamTrellisCapabilitiesErrorCode = 'TEAM_TRELLIS_UPGRADE_REQUIRED' | 'TEAM_TRELLIS_PROBE_FAILED' | 'TEAM_TRELLIS_PATH_INVALID'

function upgradeCommand(root: string): string {
  const resources = 'resourcesPath' in process && typeof process.resourcesPath === 'string' ? process.resourcesPath : null
  const packaged = resources ? join(resources, 'team-trellis', 'installer.mjs') : null
  const candidates = [resolve(__dirname, '../../scripts/install-team-trellis.mjs'), resolve(__dirname, '../../../../scripts/install-team-trellis.mjs'), resolve('scripts/install-team-trellis.mjs')]
  const installer = packaged && existsSync(packaged) ? packaged : candidates.find(existsSync) ?? candidates[0]
  const managedNode = resources ? join(resources, 'node-runtime', 'win-x64', 'node.exe') : null
  const node = managedNode && existsSync(managedNode) ? managedNode : 'node'
  const quote = (value: string): string => process.platform === 'win32'
    ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\\''")}'`
  return `${process.platform === 'win32' ? '& ' : ''}${quote(node)} ${quote(installer)} --root ${quote(root)} --apply`
}

export class TeamTrellisCapabilitiesError extends Error {
  readonly upgradeCommand: string
  constructor(readonly code: TeamTrellisCapabilitiesErrorCode, readonly root: string, detail: string) {
    const command = upgradeCommand(root)
    super(`${detail} 请先以 dry-run 核对团队适配器升级，再执行：${command}`)
    this.name = 'TeamTrellisCapabilitiesError'
    this.upgradeCommand = command
  }
}

const pathKey = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path
function checkedRoot(root: string): string {
  if (!isAbsolute(root) || root.includes('\0')) throw new Error('请选择工程的绝对路径')
  const canonical = realpathSync.native(root)
  if (pathKey(canonical) !== pathKey(resolve(root)) || !lstatSync(canonical).isDirectory()) throw new Error('工程根目录已重定向或不是目录')
  for (const part of ['.trellis', '.trellis/scripts', '.trellis/scripts/task.py']) {
    const candidate = resolve(canonical, part)
    const info = lstatSync(candidate)
    if (info.isSymbolicLink() || pathKey(realpathSync.native(candidate)) !== pathKey(candidate)
      || (part.endsWith('.py') ? !info.isFile() : !info.isDirectory())) throw new Error('所选工程的 task.py 路径已重定向或无效')
  }
  return canonical
}

type Probe = { code: number | null; stdout: Buffer; failed: boolean; timedOut: boolean; overflow: boolean }
const OUTPUT_LIMIT = 8 * 1024
const TIMEOUT_MS = 10_000
function probe(root: string): Promise<Probe> {
  return new Promise((done) => {
    const proc = spawn('python', ['-B', join(root, '.trellis/scripts/task.py'), 'team-capabilities', '--json'], {
      cwd: root, windowsHide: true, shell: false,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', NO_COLOR: '1', FORCE_COLOR: '0' }
    })
    let stdout = Buffer.alloc(0), stderrBytes = 0, settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (code: number | null, failed = false, timedOut = false, overflow = false): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      done({ code, stdout, failed, timedOut, overflow })
    }
    const stop = (): void => {
      if (process.platform === 'win32' && proc.pid) {
        const killer = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.on('error', () => { proc.kill() })
        killer.unref()
      } else proc.kill('SIGKILL')
      proc.stdin.destroy(); proc.stdout.destroy(); proc.stderr.destroy(); proc.unref()
    }
    proc.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      if (stdout.length + chunk.length > OUTPUT_LIMIT) { finish(null, false, false, true); stop(); return }
      stdout = Buffer.concat([stdout, chunk])
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      if (settled) return
      stderrBytes += chunk.length
      if (stderrBytes > OUTPUT_LIMIT) { finish(null, false, false, true); stop() }
    })
    proc.on('error', () => { finish(null, true) })
    proc.on('close', (code) => { finish(code) })
    timer = setTimeout(() => { finish(null, false, true); stop() }, TIMEOUT_MS)
  })
}

/** Executes only the selected engineering CLI's read-only capability command. */
export async function assertTeamTrellisCapabilities(root: string): Promise<TeamTrellisCapabilities> {
  let canonical: string
  try { canonical = checkedRoot(root) }
  catch { throw new TeamTrellisCapabilitiesError('TEAM_TRELLIS_PATH_INVALID', root, '工程根目录或 task.py 路径无法安全核实。') }
  let result: Probe
  try { result = await probe(canonical) }
  catch { throw new TeamTrellisCapabilitiesError('TEAM_TRELLIS_PROBE_FAILED', canonical, '无法启动 Python 能力探测，请确认 Python 3.10 或更新版本可用。') }
  if (result.failed || result.timedOut || result.overflow) throw new TeamTrellisCapabilitiesError('TEAM_TRELLIS_PROBE_FAILED', canonical, '工程 CLI 能力探测启动失败、超时或输出超限；未确认支持团队状态权威。')
  try {
    if (checkedRoot(canonical) !== canonical || result.code !== 0) throw new Error('unsupported')
    return capabilitiesSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.stdout)))
  } catch {
    throw new TeamTrellisCapabilitiesError('TEAM_TRELLIS_UPGRADE_REQUIRED', canonical, '所选工程的实际 task.py 未声明完整团队适配器 v1 能力；仅有 marker 不能安全运行团队任务。')
  }
}

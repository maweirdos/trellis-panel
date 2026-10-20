/** Legacy npm entry points delegate to the common, project-owned application runtime. */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ApplicationFailure, ApplicationSummary } from '../../shared/app-runtime'
import type { DevRunInfo } from '../../shared/types'
import { IpcErrorCode, ipcFail, type IpcFail } from '../../shared/ipc-errors'
import { appRuntime, type AppOperationOptions } from './app-runtime'
export type { DevRunInfo as DevRun } from '../../shared/types'

export interface DevScriptInfo {
  name: string
  command: string
}

export function listPackageScripts(dir: string): { ok: true; scripts: DevScriptInfo[] } | (IpcFail & { scripts: DevScriptInfo[] }) {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return { ...ipcFail(IpcErrorCode.NotFound, '该目录下没有 package.json'), scripts: [] }
  try {
    if (statSync(pkgPath).size > 1024 * 1024) return { ...ipcFail(IpcErrorCode.InvalidArg, 'package.json 超过读取限额'), scripts: [] }
    const pkg: { scripts?: Record<string, unknown> } = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    const scripts = Object.entries(pkg.scripts ?? {})
      .filter(([, cmd]) => typeof cmd === 'string')
      .map(([name, cmd]) => ({ name, command: String(cmd) }))
    return { ok: true, scripts }
  } catch {
    return { ...ipcFail(IpcErrorCode.Io, 'package.json 无法读取或格式无效'), scripts: [] }
  }
}

async function legacyRun(root: string, app: ApplicationSummary): Promise<DevRunInfo | null> {
  if (!app.run) return null
  const logs = await appRuntime.logs(root, app.definition.id)
  const launch = app.definition.launch
  return {
    id: app.run.id,
    dir: resolve(root, app.definition.cwd),
    command: launch.kind === 'npm-script' ? `npm run ${launch.script}` : launch.kind === 'argv' ? launch.executable : '脚本命令',
    script: launch.kind === 'npm-script' ? launch.script : app.definition.id,
    startedAt: app.run.startedAt,
    exitedAt: app.run.exitedAt,
    state: app.processState,
    exitCode: app.run.exitCode,
    pid: app.run.pid,
    output: logs.ok ? logs.output : '',
    outputTruncated: logs.ok ? logs.outputTruncated : false
  }
}

export async function devRunStart(root: string, dir: string, script: string, options: AppOperationOptions = {}): Promise<{ ok: true; run: DevRunInfo } | ApplicationFailure> {
  const imported = await appRuntime.importNpm(root, dir, script)
  if (imported.ok === false) return imported
  const result = await appRuntime.start(root, imported.app.definition.id, { ...options, expectedRevision: imported.app.definition.revision })
  if (result.ok === false) return result
  const run = await legacyRun(root, result.app)
  return run ? { ok: true, run } : ipcFail(IpcErrorCode.Io, '运行尚未建立')
}

export async function devRunStop(root: string, id: string): Promise<{ ok: true } | ApplicationFailure> {
  const listed = await appRuntime.list(root)
  if (listed.ok === false) return listed
  const app = listed.apps.find((item) => item.run?.id === id || item.definition.id === id)
  if (!app) return ipcFail(IpcErrorCode.NotFound, '当前项目中不存在该运行')
  const result = await appRuntime.stop(root, app.definition.id)
  return result.ok ? { ok: true } : result
}

export async function devRunStopAll(root: string): Promise<{ ok: boolean; stopped: number; error?: string }> {
  const listed = await appRuntime.list(root)
  if (listed.ok === false) return { ...listed, stopped: 0 }
  let stopped = 0
  let failed = false
  for (const app of listed.apps) {
    if (!['starting', 'running', 'stopping', 'unknown', 'cleanup-required'].includes(app.processState)) continue
    const result = await appRuntime.stop(root, app.definition.id)
    if (result.ok) stopped += 1
    else failed = true
  }
  return failed ? { ...ipcFail(IpcErrorCode.Io, '部分应用尚未停止，请在应用面板检查'), stopped } : { ok: true, stopped }
}

export async function devRunList(root: string): Promise<DevRunInfo[]> {
  const listed = await appRuntime.list(root)
  if (listed.ok === false) throw new Error(listed.error)
  const runs = await Promise.all(listed.apps.map((app) => legacyRun(root, app)))
  return runs.filter((run): run is DevRunInfo => run !== null).sort((a, b) => b.startedAt - a.startedAt)
}

export async function devRunGet(root: string, id: string): Promise<DevRunInfo | null> {
  return (await devRunList(root)).find((run) => run.id === id) ?? null
}

/**
 * C2/C3/PF-10：本机开发命令的有归属运行。
 * 边界：只管理面板自己启动的进程；停止只作用于自己的进程树，绝不触碰外部进程；
 * 脚本必须真实存在于目标目录 package.json（不改脚本、不拼 shell 命令）；
 * 输出有界（超出截断并如实标注）；退出码/信号/存活如实呈现——
 * 进程存活 ≠ 服务就绪，没有就绪检查时不宣称服务可用。
 */
import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { errorText } from '../../shared/errors'

export interface DevScriptInfo {
  name: string
  command: string
}

export function listPackageScripts(dir: string): { ok: boolean; error?: string; scripts: DevScriptInfo[] } {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return { ok: false, error: '该目录下没有 package.json', scripts: [] }
  try {
    const pkg: { scripts?: Record<string, unknown> } = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    const scripts = Object.entries(pkg.scripts ?? {})
      .filter(([, cmd]) => typeof cmd === 'string')
      .map(([name, cmd]) => ({ name, command: String(cmd) }))
    return { ok: true, scripts }
  } catch (e) {
    return { ok: false, error: `package.json 无法读取：${errorText(e, '未知错误')}`, scripts: [] }
  }
}

export type DevRunState = 'running' | 'exited' | 'failed' | 'killed'

export interface DevRun {
  id: string
  dir: string
  /** 展示用完整命令（= 实际执行的命令） */
  command: string
  script: string
  startedAt: number
  exitedAt: number | null
  state: DevRunState
  exitCode: number | null
  pid: number | null
  output: string
  outputTruncated: boolean
}

const OUT_CAP_BYTES = 256 * 1024
const MAX_RETAINED_RUNS = 30

const runs = new Map<string, DevRun & { child?: ChildProcess }>()

function append(run: { output: string; outputTruncated: boolean }, chunk: string): void {
  const overflow = run.output.length + chunk.length - OUT_CAP_BYTES
  if (overflow > 0) {
    run.output = run.output.slice(Math.min(run.output.length, overflow))
    run.outputTruncated = true
  }
  run.output += chunk
}

function pruneFinished(): void {
  const finished = [...runs.values()].filter((r) => r.state !== 'running')
  while (runs.size > MAX_RETAINED_RUNS && finished.length > 0) {
    const oldest = finished.shift()
    if (oldest) runs.delete(oldest.id)
  }
}

export function devRunStart(dir: string, script: string): { ok: boolean; error?: string; run?: DevRun } {
  if (!existsSync(dir)) return { ok: false, error: `目录不存在：${dir}` }
  const listed = listPackageScripts(dir)
  if (!listed.ok) return { ok: false, error: listed.error }
  if (!listed.scripts.some((s) => s.name === script)) {
    return { ok: false, error: `脚本 "${script}" 不在该工程 package.json 中——面板不代跑未声明脚本` }
  }
  const command = `npm run ${script}`
  const id = randomUUID().slice(0, 8)
  const isWin = process.platform === 'win32'
  let child: ChildProcess
  try {
    child = isWin
      ? spawn('cmd.exe', ['/d', '/s', '/c', command], { cwd: dir, windowsHide: true })
      : spawn('npm', ['run', script], { cwd: dir, windowsHide: true })
  } catch (e) {
    return { ok: false, error: `进程启动失败：${errorText(e, '未知错误')}` }
  }
  const run: DevRun & { child?: ChildProcess } = { id, dir, command, script, startedAt: Date.now(), exitedAt: null as number | null, state: 'running' as DevRunState, exitCode: null as number | null, pid: child.pid ?? null, output: '', outputTruncated: false, child }
  child.stdout?.on('data', (d: Buffer) => append(run, d.toString('utf-8')))
  child.stderr?.on('data', (d: Buffer) => append(run, d.toString('utf-8')))
  child.on('error', (e) => {
    run.state = 'failed'
    run.exitedAt = Date.now()
    append(run, `\n[dev-run] 进程启动失败：${e.message}\n`)
  })
  child.on('close', (code, signal) => {
    run.exitedAt = Date.now()
    if (signal) {
      run.state = 'killed'
      run.exitCode = null
      append(run, `\n[dev-run] 进程被终止（signal ${signal}）\n`)
    } else {
      run.state = code === 0 ? 'exited' : 'failed'
      run.exitCode = code
      append(run, `\n[dev-run] 进程退出，退出码 ${code ?? 'null'}\n`)
    }
    delete run.child
  })
  runs.set(id, run)
  pruneFinished()
  const { child: _c, ...summary } = run
  return { ok: true, run: summary }
}

/** 停止只作用于面板自己启动的运行：按 id 找到自己的子进程树再终止。 */
export function devRunStop(id: string): { ok: boolean; error?: string } {
  const run = runs.get(id)
  if (!run) return { ok: false, error: '运行不存在或已被清理' }
  if (run.state !== 'running') return { ok: false, error: `该运行已结束（${run.state}）` }
  if (!run.child || run.child.pid === undefined) return { ok: false, error: '进程句柄不可用' }
  const pid = run.child.pid
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    } else {
      run.child.kill('SIGTERM')
      setTimeout(() => {
        try {
          if (run.state === 'running') run.child?.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }, 3_000).unref()
    }
    append(run, `\n[dev-run] 已请求停止（pid ${pid}，仅限面板自己启动的进程树）\n`)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errorText(e, '停止失败') }
  }
}

/** 停止面板当前所有运行中的进程（组合运行的"全部停止"；同样只限自己的）。 */
export function devRunStopAll(): { stopped: number } {
  let stopped = 0
  for (const run of runs.values()) {
    if (run.state === 'running' && devRunStop(run.id).ok) stopped += 1
  }
  return { stopped }
}

export function devRunList(): DevRun[] {
  return [...runs.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(({ child: _c, ...r }) => r)
}

export function devRunGet(id: string): DevRun | null {
  const run = runs.get(id)
  if (!run) return null
  const { child: _c, ...r } = run
  return r
}

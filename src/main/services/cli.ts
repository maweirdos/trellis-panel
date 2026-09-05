import { spawn, type ChildProcess } from 'child_process'
import { BrowserWindow } from 'electron'

export interface CliRun {
  id: number
  proc: ChildProcess
}

const runs = new Map<number, CliRun>()
let nextId = 1

function quoteArg(a: string): string {
  return /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a
}

export function runCli(
  win: BrowserWindow,
  cwd: string,
  command: string,
  args: string[]
): number {
  const id = nextId++
  const cmdLine = `${command} ${args.map(quoteArg).join(' ')}`.trim()
  const proc = spawn(cmdLine, {
    cwd,
    shell: true,
    windowsHide: true,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', PYTHONIOENCODING: 'utf-8' }
  })
  runs.set(id, { id, proc })

  const send = (stream: 'stdout' | 'stderr', data: string) => {
    if (!win.isDestroyed()) win.webContents.send('cli:output', { runId: id, stream, data })
  }

  proc.stdout?.on('data', (d: Buffer) => send('stdout', d.toString('utf-8')))
  proc.stderr?.on('data', (d: Buffer) => send('stderr', d.toString('utf-8')))
  proc.on('error', (e) => {
    send('stderr', `启动命令失败: ${e.message}`)
  })
  proc.on('close', (code, signal) => {
    runs.delete(id)
    if (!win.isDestroyed()) {
      win.webContents.send('cli:done', { runId: id, code, aborted: signal === 'SIGTERM' })
    }
  })
  return id
}

export function abortCli(runId: number): void {
  const run = runs.get(runId)
  if (!run) return
  if (process.platform === 'win32') {
    // Kill the whole shell tree (cmd.exe -> trellis.cmd -> node/python).
    spawn('taskkill', ['/pid', String(run.proc.pid), '/T', '/F'], { windowsHide: true })
  } else {
    run.proc.kill('SIGTERM')
  }
}

export function abortAll(): void {
  for (const id of [...runs.keys()]) abortCli(id)
}

import { spawn, exec, type ChildProcess } from 'child_process'
import { BrowserWindow } from 'electron'

/**
 * AI 后台执行：把需求 prompt 通过 stdin 交给 codex exec / claude -p 非交互执行，
 * 输出流式广播到渲染端「AI 工作台」。任务建文件后由 watcher 自动刷新面板。
 */

export interface AiRunMeta {
  runId: number
  app: 'codex' | 'claude'
  label: string
  taskDir: string | null
  startedAt: number
}

const runs = new Map<number, { proc: ChildProcess }>()
const aborted = new Set<number>()
let nextId = 1

/** detect which AI CLIs are on PATH（Windows: where / 其它: which） */
export function detectAiClis(cb: (result: { codex: boolean; claude: boolean }) => void): void {
  const cmd = process.platform === 'win32' ? 'where' : 'which'
  let left = 2
  const result = { codex: false, claude: false }
  const check = (name: 'codex' | 'claude'): void => {
    exec(`${cmd} ${name}`, (_e, stdout) => {
      result[name] = Boolean(stdout && stdout.trim())
      if (--left === 0) cb(result)
    })
  }
  check('codex')
  check('claude')
}

export function launchAiRun(
  win: BrowserWindow,
  cwd: string,
  app: 'codex' | 'claude',
  prompt: string,
  meta: { label: string; taskDir: string | null }
): AiRunMeta {
  const runId = nextId++
  const args = app === 'codex' ? ['exec', '--full-auto', '-'] : ['-p', '--permission-mode', 'acceptEdits']
  // npm 全局 CLI 是 .cmd/.ps1 垫片，必须 shell:true 才能解析
  const proc = spawn(app, args, {
    cwd,
    shell: true,
    windowsHide: true,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
  })
  runs.set(runId, { proc })

  const send = (channel: string, payload: Record<string, unknown>): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, { runId, ...payload })
  }

  proc.stdout?.on('data', (d: Buffer) => send('ai:log', { stream: 'stdout', data: d.toString('utf-8') }))
  proc.stderr?.on('data', (d: Buffer) => send('ai:log', { stream: 'stderr', data: d.toString('utf-8') }))
  proc.on('error', (e) => {
    send('ai:log', { stream: 'stderr', data: `启动 ${app} 失败: ${e.message}` })
  })

  // prompt 走 stdin，彻底绕开命令行引号 / 换行 / 中文问题
  proc.stdin?.write(prompt)
  proc.stdin?.end()

  proc.on('close', (code) => {
    runs.delete(runId)
    send('ai:done', { code, aborted: aborted.delete(runId) })
  })

  return { runId, app, label: meta.label, taskDir: meta.taskDir, startedAt: Date.now() }
}

export function abortAiRun(runId: number): void {
  const run = runs.get(runId)
  if (!run) return
  aborted.add(runId)
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(run.proc.pid), '/T', '/F'], { windowsHide: true })
  } else {
    run.proc.kill('SIGTERM')
  }
}

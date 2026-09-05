import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync, copyFileSync } from 'fs'
import { join } from 'path'
import { watch, type FSWatcher } from 'chokidar'

/**
 * AI-tool bridge: lets codex / zcode / trellis hooks talk to the panel.
 *
 * Three channels:
 *  1. Deep link  trellis-panel://open-task?dir=... | notify?text=... | task-event?path=...
 *  2. tpanel.cmd shim on PATH (writes deep links / spawns them)
 *  3. Trellis config.yaml hooks calling `tpanel task-event`
 * A bridge inbox folder also accepts JSON events for tools that prefer files.
 */

export interface BridgeHandlers {
  onTaskEvent: (taskDir: string | null, text: string | undefined, source: string) => void
  onNotify: (text: string) => void
  onOpenTask: (taskDir: string) => void
}

let inboxWatcher: FSWatcher | null = null

export function bridgeDir(): string {
  return join(app.getPath('userData'), 'bridge')
}

export function inboxDir(): string {
  return join(bridgeDir(), 'inbox')
}

export function startInbox(handlers: BridgeHandlers): void {
  const dir = inboxDir()
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return
  }
  const processFile = (file: string): void => {
    if (!file.endsWith('.json')) return
    try {
      const evt = JSON.parse(readFileSync(file, 'utf-8'))
      dispatch(evt?.type, evt, handlers)
    } catch {
      // malformed event — drop it
    }
    try {
      unlinkSync(file)
    } catch {
      // best effort
    }
  }
  // drain leftovers first
  try {
    for (const f of readdirSync(dir)) processFile(join(dir, f))
  } catch {
    // ignore
  }
  inboxWatcher = watch(dir, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 250 } })
  inboxWatcher.on('add', processFile)
}

export function stopInbox(): void {
  if (inboxWatcher) {
    inboxWatcher.close().catch(() => undefined)
    inboxWatcher = null
  }
}

function dispatch(type: unknown, evt: any, handlers: BridgeHandlers): void {
  const text = typeof evt?.text === 'string' ? evt.text : undefined
  const taskDir = typeof evt?.taskDir === 'string' ? evt.taskDir : typeof evt?.dir === 'string' ? evt.dir : null
  switch (type) {
    case 'task-event':
    case 'task-update':
      handlers.onTaskEvent(taskDir, text, String(evt?.source ?? 'hook'))
      break
    case 'notify':
      handlers.onNotify(text ?? '收到桥接消息')
      break
    case 'open-task':
      if (taskDir) handlers.onOpenTask(taskDir)
      break
    default:
      handlers.onNotify(text ?? '收到未知桥接事件')
  }
}

/** Parse a trellis-panel:// URL from argv (Windows passes it as argv[1] on second instance). */
export function parseDeepLink(argv: string[]): { type: string; params: URLSearchParams } | null {
  for (const a of argv) {
    if (a.startsWith('trellis-panel://')) {
      try {
        // For non-special schemes `new URL` puts "open-task" (the part after //)
        // into hostname; some forms land in pathname instead — accept both.
        const url = new URL(a)
        const type = (url.hostname || url.pathname.replace(/^\//, '')).replace(/\/$/, '')
        return { type, params: url.searchParams }
      } catch {
        return null
      }
    }
  }
  return null
}

export function handleDeepLink(
  link: { type: string; params: URLSearchParams } | null,
  handlers: BridgeHandlers
): void {
  if (!link) return
  const { type, params } = link
  if (type === 'open-task' || type === 'task-event') {
    const dir = params.get('dir') ?? params.get('path') ?? ''
    const taskDir = dir.replace(/task\.json$/, '').replace(/[\\/]+$/, '')
    if (type === 'open-task') handlers.onOpenTask(taskDir)
    else handlers.onTaskEvent(taskDir, params.get('text') ?? undefined, 'deeplink')
  } else if (type === 'notify') {
    handlers.onNotify(params.get('text') ?? '收到通知')
  }
}

const TPANEL_CMD = `@echo off
rem Trellis Panel bridge CLI (codex / zcode / trellis hooks -> panel)
rem NOTE: keep this file ASCII-only; cmd.exe parses it in the OEM codepage.
if /i "%~1"=="notify" (
  if "%~2"=="" goto usage
  set "MSG=%~2"
  if not "%~3"=="" set "MSG=%MSG% %~3"
  set "MSG=%MSG: =+%"
  start "" "trellis-panel://notify?text=%MSG%"
  exit /b 0
)
if /i "%~1"=="open" (
  if not "%~2"=="" (
    set "DIR=%~2"
    set "DIR=!DIR:\\=/!"
    start "" "trellis-panel://open-task?dir=%DIR%"
  ) else (
    start "" "trellis-panel://open-task"
  )
  exit /b 0
)
if /i "%~1"=="task-event" (
  if defined TASK_JSON_PATH (
    set "P=%TASK_JSON_PATH:\\=/%"
    start "" "trellis-panel://task-event?path=%P%"
  )
  exit /b 0
)
:usage
echo Usage: tpanel notify "message" ^| tpanel open [taskDir] ^| tpanel task-event
exit /b 1
`

export function installTpanel(): { ok: boolean; error?: string; path?: string } {
  const npmDir = join(app.getPath('appData'), 'npm')
  try {
    mkdirSync(npmDir, { recursive: true })
    const p = join(npmDir, 'tpanel.cmd')
    writeFileSync(p, TPANEL_CMD, 'utf-8')
    return { ok: true, path: p }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? '写入失败' }
  }
}

const HOOK_BLOCK = `# --- Trellis Panel bridge (auto-generated) ---
hooks:
  after_create:
    - "tpanel task-event"
  after_start:
    - "tpanel task-event"
  after_finish:
    - "tpanel task-event"
  after_archive:
    - "tpanel task-event"
`

/** Append the panel bridge hooks to .trellis/config.yaml (idempotent). */
export function installTrellisHooks(projectRoot: string): { ok: boolean; error?: string; message?: string } {
  const cfgPath = join(projectRoot, '.trellis', 'config.yaml')
  try {
    let content = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf-8') : ''
    if (content.includes('tpanel task-event')) {
      return { ok: true, message: '桥接 hooks 已存在，无需重复写入' }
    }
    if (/^hooks:\s*$/m.test(content)) {
      // hooks section exists without our entries — append only missing sub-entries
      const lines = [
        '  after_create:',
        '    - "tpanel task-event"',
        '  after_start:',
        '    - "tpanel task-event"',
        '  after_finish:',
        '    - "tpanel task-event"',
        '  after_archive:',
        '    - "tpanel task-event"'
      ]
      content = content.replace(/^hooks:\s*$/m, 'hooks:\n' + lines.join('\n'))
    } else {
      content = content.replace(/# --- Trellis Panel bridge[^\n]*\n/, '') // cleanup stale marker
      content = content.trimEnd() + '\n\n' + HOOK_BLOCK
    }
    writeFileSync(cfgPath, content, 'utf-8')
    return { ok: true, message: '已写入 .trellis/config.yaml — AI 工具的任务事件将实时推送到面板' }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? '写入 config.yaml 失败' }
  }
}

export function broadcastToWindows(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

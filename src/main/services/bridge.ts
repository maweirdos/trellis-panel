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
  handlers: BridgeHandlers,
  bridgeToken: string
): void {
  if (!link) return
  const { type, params } = link
  // every deep link must carry the per-install bridge token
  if (params.get('t') !== bridgeToken) {
    handlers.onNotify('桥接请求被拒绝：令牌不匹配（请重新安装 tpanel 命令）')
    return
  }
  if (type === 'open-task' || type === 'task-event') {
    const dir = params.get('dir') ?? params.get('path') ?? ''
    const taskDir = dir.replace(/task\.json$/, '').replace(/[\\/]+$/, '')
    if (type === 'open-task') handlers.onOpenTask(taskDir)
    else handlers.onTaskEvent(taskDir, params.get('text') ?? undefined, 'deeplink')
  } else if (type === 'notify') {
    handlers.onNotify(params.get('text') ?? '收到通知')
  }
}

const TPANEL_MCP_MJS = String.raw`#!/usr/bin/env node
// Trellis Panel MCP stdio bridge: stdin JSON-RPC -> panel HTTP MCP endpoint.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const settingsPath = process.env.TPANEL_SETTINGS ?? join(process.env.APPDATA ?? '', 'trellis-panel', 'settings.json')
let port = 39573
let token = ''
try {
  const s = JSON.parse(readFileSync(settingsPath, 'utf-8'))
  port = s.httpApi?.port ?? port
  token = s.bridgeToken ?? ''
} catch {}

let buf = ''
let pending = 0
let sawEnd = false
process.stdin.setEncoding('utf-8')
process.stdin.on('data', (d) => {
  buf += d
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (line) {
      pending += 1
      dispatch(line).finally(() => {
        pending -= 1
        if (sawEnd && pending === 0) process.exit(0)
      })
    }
  }
})
process.stdin.on('end', () => {
  sawEnd = true
  if (pending === 0) process.exit(0)
})

async function dispatch(line) {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (!msg || msg.method?.startsWith?.('notifications/')) return // ignore notifications
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(15000)
    })
    const text = await res.text()
    if (text.trim()) process.stdout.write(text.trim() + '\n')
  } catch (e) {
    if (msg.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'panel unreachable: ' + e.message } }) + '\n')
    }
  }
}
`

export function installTpanel(token: string): { ok: boolean; error?: string; path?: string } {
  const npmDir = join(app.getPath('appData'), 'npm')
  try {
    mkdirSync(npmDir, { recursive: true })
    const urls = {
      notify: `trellis-panel://notify?text=%MSG%&t=${token}`,
      open: `trellis-panel://open-task?dir=%DIR%&t=${token}`,
      openEmpty: `trellis-panel://open-task&t=${token}`,
      taskEvent: `trellis-panel://task-event?path=%P%&t=${token}`
    }
    // NOTE: no parenthesized blocks — %VAR% set inside a block would expand
    // at parse time (classic batch pitfall). goto-flow keeps expansion correct.
    const cmd = `@echo off
rem Trellis Panel bridge CLI (codex / zcode / trellis hooks -> panel)
rem NOTE: keep this file ASCII-only; cmd.exe parses it in the OEM codepage.
if /i not "%~1"=="mcp" goto :try_notify
node "%~dp0tpanel-mcp.mjs"
exit /b %ERRORLEVEL%
:try_notify
if /i not "%~1"=="notify" goto :try_open
if "%~2"=="" goto :usage
set "MSG=%~2"
if not "%~3"=="" set "MSG=%MSG% %~3"
if "%MSG%"=="" goto :usage
set "MSG=%MSG: =+%"
start "" "${urls.notify}"
exit /b 0
:try_open
if /i not "%~1"=="open" goto :try_task_event
if "%~2"=="" goto :open_empty
set "DIR=%~2"
start "" "${urls.open}"
exit /b 0
:open_empty
start "" "${urls.openEmpty}"
exit /b 0
:try_task_event
if /i not "%~1"=="task-event" goto :usage
if not defined TASK_JSON_PATH exit /b 0
set "P=%TASK_JSON_PATH%"
start "" "${urls.taskEvent}"
exit /b 0
:usage
echo Usage: tpanel notify "message" ^| tpanel open [taskDir] ^| tpanel task-event ^| tpanel mcp
exit /b 1
`
    const p = join(npmDir, 'tpanel.cmd')
    writeFileSync(p, cmd, 'utf-8')
    writeFileSync(join(npmDir, 'tpanel-mcp.mjs'), TPANEL_MCP_MJS, 'utf-8')
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

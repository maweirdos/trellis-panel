import { BrowserWindow, nativeTheme } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { DaemonStatus } from '../../shared/daemon'
import type { DaemonQuitDecision, DaemonQuitState } from '../../shared/daemon-quit'
import { daemonManager } from './daemon-client/manager'
import { readDaemonLaunchPreferences } from './daemon-client/preferences'
import { APPLICATION_ICON } from './notifications'
import { getSettings } from './store'

type Pending = { state: DaemonQuitState; resolve: (decision: DaemonQuitDecision) => void }
let window: BrowserWindow | null = null, pending: Pending | null = null
let load: ((window: BrowserWindow) => void) | undefined
let parent: (() => BrowserWindow | null) | undefined
export function configureDaemonQuitDialog(ports: { load(window: BrowserWindow): void; getMain(): BrowserWindow | null }): void { load = ports.load; parent = ports.getMain }
export function quitDialogState(sender: Electron.WebContents, frame: Electron.WebFrameMain | null): DaemonQuitState | null {
  return window && !window.isDestroyed() && sender.id === window.webContents.id && frame === sender.mainFrame ? pending?.state ?? null : null
}
export function decideDaemonQuit(sender: Electron.WebContents, frame: Electron.WebFrameMain | null, decision: DaemonQuitDecision): boolean {
  const state = quitDialogState(sender, frame)
  if (!state || state.attemptId !== decision.attemptId || !pending) return false
  const settle = pending.resolve; pending = null
  const closing = window; window = null
  setImmediate(() => { if (closing && !closing.isDestroyed()) closing.destroy() })
  settle(decision); return true
}
/** A separate owned window remains visible when the panel is hidden in the tray. */
export async function showDaemonQuitDialog(error: string | null = null): Promise<{ decision: DaemonQuitDecision; status: DaemonStatus | null }> {
  if (window && !window.isDestroyed()) { window.show(); window.focus(); throw new Error('退出确认已打开') }
  if (!load) throw new Error('退出确认窗口尚未初始化')
  const result = await daemonManager.status(), status = result.ok ? result.data : null
  const preference = status?.preferences ?? await readDaemonLaunchPreferences()
  const state: DaemonQuitState = { attemptId: randomUUID(), keepRunning: preference.keepRunning, daemonAvailable: status !== null, activeJobs: status?.activeJobs ?? 0, error }
  const main = parent?.()
  const theme = getSettings().theme
  const isDark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors)
  const backgroundColor = isDark ? '#1d1d1d' : '#f7f7f7'
  window = new BrowserWindow({ icon: APPLICATION_ICON, width: 450, height: error ? 284 : 228, resizable: false, minimizable: false, maximizable: false, frame: false, show: false,
    ...(main?.isVisible() ? { parent: main, modal: true } : { alwaysOnTop: true }), backgroundColor, title: '确定退出 Crux？',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: false } })
  const decision = new Promise<DaemonQuitDecision>(resolve => { pending = { state, resolve } })
  const created = window
  window.once('closed', () => {
    if (window === created) window = null
    if (pending?.state.attemptId !== state.attemptId) return
    const current = pending; pending = null
    current?.resolve({ attemptId: state.attemptId, action: 'cancel', keepRunning: state.keepRunning })
  })
  window.once('ready-to-show', () => { if (!created.isDestroyed()) { created.show(); created.focus() } })
  load(window)
  return { decision: await decision, status }
}

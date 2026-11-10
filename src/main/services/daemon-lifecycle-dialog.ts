import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import {
  daemonLifecycleConfirmationSchema,
  daemonLifecycleDecisionSchema,
  type DaemonLifecycleAppearance,
  type DaemonLifecycleConfirmation,
  type DaemonLifecycleDialogState
} from '../../shared/daemon-lifecycle-dialog'
import { ipcInvoke } from '../../shared/ipc-channels'
import { ipcFail } from '../../shared/ipc-errors'
import { handle } from '../ipc/registry'
import { APPLICATION_ICON } from './notifications'
import { mainWindowAppearance } from './window-appearance'
import type { DaemonContext } from '../daemon/context'
import { LifecycleCancelled, runDaemonLifecycle, type LifecycleAttempt, type LifecycleOptions } from './daemon-client/lifecycle'

interface DialogPorts {
  load(window: BrowserWindow): void
  getMain(): BrowserWindow | null
  /** Restricted non-secret preferences only; never initialize the Settings store. */
  getAppearance?(): DaemonLifecycleAppearance
  /** Optional live owner/attempt fence supplied by the lifecycle coordinator. */
  isCurrentAttempt?(attemptId: string): boolean
}

interface PendingConfirmation {
  window: BrowserWindow
  state: DaemonLifecycleDialogState
  promise: Promise<boolean>
  resolve(confirmed: boolean): void
  loadDeadline: ReturnType<typeof setTimeout> | null
  recovery?: (retry: boolean) => void
}

let ports: DialogPorts | null = null
let registered = false
let pending: PendingConfirmation | null = null
// Deliberately never cache approval as authority. The coordinator owns its
// durable decision and exact owner binding; a repeated completed UI request fails closed.
const settledAttempts = new Set<string>()

function sessionTitle(title: string): string {
  const name = title.trim().replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
  return !name || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(name)
    ? '未命名会话'
    : name.slice(0, 160)
}

export function configureDaemonLifecycleDialog(next: DialogPorts): void {
  if (pending) throw new Error('生命周期确认尚未结束')
  ports = next
  if (registered) return
  handle(ipcInvoke.daemonLifecycleDialog.state, event => {
    const state = daemonLifecycleDialogState(event.sender, event.senderFrame)
    return state ? { ok: true, data: state } : ipcFail('E_DENIED', '确认窗口已失效')
  })
  handle(ipcInvoke.daemonLifecycleDialog.decide, (event, input: unknown) =>
    decideDaemonLifecycle(event.sender, event.senderFrame, input)
      ? { ok: true }
      : ipcFail('E_DENIED', '确认窗口已失效'))
  registered = true
}

export function daemonLifecycleDialogState(
  sender: Electron.WebContents,
  frame: Electron.WebFrameMain | null
): DaemonLifecycleDialogState | null {
  const active = pending
  if (!active || active.window.isDestroyed() || sender !== active.window.webContents ||
    frame !== sender.mainFrame || !frame ||
    (ports?.isCurrentAttempt && !ports.isCurrentAttempt(active.state.attemptId))) return null
  if (active.loadDeadline) clearTimeout(active.loadDeadline)
  active.loadDeadline = null
  return active.state
}

function settle(active: PendingConfirmation, confirmed: boolean): void {
  if (pending !== active) return
  if (active.state.phase !== 'confirmation') return
  settledAttempts.add(active.state.attemptId)
  if (active.loadDeadline) clearTimeout(active.loadDeadline)
  active.loadDeadline = null
  if (confirmed) {
    active.state = { ...active.state, phase: 'stopping' }
    active.window.setTitle(active.state.reason === 'upgrade' ? '正在准备更新…' : '正在重启…')
    active.resolve(true)
    return
  }
  closeDialog(active)
  active.resolve(false)
}

function closeDialog(active: PendingConfirmation): void {
  if (pending !== active) return
  pending = null
  if (active.loadDeadline) clearTimeout(active.loadDeadline)
  // Finish the invoke reply before destroying its WebContents.
  setImmediate(() => {
    if (!active.window.isDestroyed()) active.window.destroy()
    if (active.state.phase === 'confirmation' || active.state.phase === 'failed') {
      const main = ports?.getMain()
      if (main && !main.isDestroyed()) {
        if (main.isMinimized()) main.restore()
        main.show()
        main.focus()
      }
    }
  })
}

export function decideDaemonLifecycle(
  sender: Electron.WebContents,
  frame: Electron.WebFrameMain | null,
  input: unknown
): boolean {
  const decision = daemonLifecycleDecisionSchema.safeParse(input)
  const state = daemonLifecycleDialogState(sender, frame)
  if (!decision.success || !state || !pending || decision.data.attemptId !== state.attemptId) return false
  if (state.phase === 'confirmation' && ['cancel', 'confirm'].includes(decision.data.action)) {
    settle(pending, decision.data.action === 'confirm')
    return true
  }
  if (state.phase === 'failed' && pending.recovery && ['retry', 'close'].includes(decision.data.action)) {
    const active = pending, recover = active.recovery
    active.recovery = undefined
    if (decision.data.action === 'retry') active.state = { ...active.state, phase: 'stopping', failure: undefined }
    else closeDialog(active)
    recover?.(decision.data.action === 'retry')
    return true
  }
  return false
}

/** The caller binds attemptId to one original owner and rechecks it before stopping. */
export function showDaemonLifecycleConfirmation(input: DaemonLifecycleConfirmation): Promise<boolean> {
  const parsed = daemonLifecycleConfirmationSchema.parse(input)
  if (!ports) return Promise.reject(new Error('生命周期确认窗口尚未初始化'))
  if (settledAttempts.has(parsed.attemptId)) return Promise.resolve(false)
  if (pending) {
    if (pending.state.attemptId !== parsed.attemptId) return Promise.reject(new Error('另一次生命周期确认尚未结束'))
    if (pending.state.phase !== 'confirmation') {
      closeDialog(pending)
    } else {
      pending.window.show()
      pending.window.focus()
      return pending.promise
    }
  }
  if (ports.isCurrentAttempt && !ports.isCurrentAttempt(parsed.attemptId)) return Promise.resolve(false)
  return createDialog({ ...parsed, phase: 'confirmation' }).promise
}

function createDialog(input: DaemonLifecycleConfirmation & Pick<DaemonLifecycleDialogState, 'phase' | 'failure' | 'commandId'>): PendingConfirmation {
  if (!ports) throw new Error('生命周期窗口尚未初始化')
  const appearance = ports.getAppearance?.() ?? { theme: 'system' }
  const main = ports.getMain()
  const title = input.phase === 'confirmation'
    ? input.reason === 'upgrade' ? '停止会话并更新？' : '停止会话并重启？'
    : input.reason === 'upgrade' ? '正在准备更新…' : '正在重启…'
  const state: DaemonLifecycleDialogState = {
    ...input,
    sessionCount: input.sessions.length,
    sessions: input.sessions.slice(0, 5).map(session => ({
      title: sessionTitle(session.title)
    }))
  }
  const window = new BrowserWindow({
    icon: APPLICATION_ICON,
    width: 470,
    height: 248 + state.sessions.length * 32 + (state.sessionCount > 5 ? 24 : 0) + (state.uncertain ? 30 : 0),
    resizable: false,
    minimizable: false,
    maximizable: false,
    frame: false,
    show: false,
    ...(main && !main.isDestroyed() && main.isVisible() ? { parent: main, modal: true } : { alwaysOnTop: true }),
    ...mainWindowAppearance(appearance.theme),
    title,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      partition: `crux-lifecycle-${state.attemptId}`,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      additionalArguments: [
        '--daemon-lifecycle-dialog',
        `--daemon-lifecycle-theme=${appearance.theme}`,
        ...(appearance.fontSize ? [`--daemon-lifecycle-density=${appearance.fontSize}`] : [])
      ]
    }
  })
  let resolveDecision: (confirmed: boolean) => void = () => undefined
  const promise = new Promise<boolean>(resolve => { resolveDecision = resolve })
  const active: PendingConfirmation = { window, state, promise, resolve: resolveDecision, loadDeadline: null }
  pending = active
  const unavailable = (): void => {
    if (active.state.phase === 'confirmation') settle(active, false)
    else {
      active.recovery?.(false)
      closeDialog(active)
    }
  }
  active.loadDeadline = setTimeout(unavailable, 15_000)
  window.on('close', event => {
    if (pending === active && !['confirmation', 'failed'].includes(active.state.phase)) event.preventDefault()
  })
  window.once('closed', unavailable)
  window.webContents.once('render-process-gone', unavailable)
  window.webContents.on('did-fail-load', (_event, _code, _description, _url, isMainFrame) => {
    if (isMainFrame) unavailable()
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  window.webContents.on('before-input-event', (event, key) => {
    if (key.type === 'keyDown' && key.key === 'Escape' && !key.isComposing) {
      event.preventDefault()
      if (active.state.phase === 'confirmation') settle(active, false)
      else if (active.state.phase === 'failed' && active.recovery) {
        active.recovery(false)
        closeDialog(active)
      }
    }
  })
  window.once('ready-to-show', () => {
    if (pending === active && !window.isDestroyed()) { window.show(); window.focus() }
  })
  try {
    ports.load(window)
  } catch (error) {
    unavailable()
    throw error
  }
  return active
}

/** Presentation observes the same durable attempt; retry never issues a new
 * confirmation or command itself. Cleanup completes before retry becomes usable. */
export async function runDaemonLifecycleWithDialog(context: DaemonContext, options: LifecycleOptions): Promise<LifecycleAttempt> {
  let latest: LifecycleAttempt | undefined
  const progress = (attempt: LifecycleAttempt): void => {
    latest = attempt
    options.progress?.(attempt)
    if (!['stopping', 'terminating', 'verifying'].includes(attempt.phase)) return
    const state: DaemonLifecycleDialogState = {
      attemptId: attempt.attemptId, reason: attempt.reason, sessions: [], sessionCount: 0,
      uncertain: false, phase: attempt.phase as 'stopping' | 'terminating' | 'verifying',
      commandId: attempt.commandId
    }
    if (pending?.state.attemptId === attempt.attemptId) {
      pending.state = state
      pending.window.setTitle(state.reason === 'upgrade' ? '正在准备更新…' : '正在重启…')
    }
    else if (!pending) createDialog(state)
  }
  while (true) {
    try {
      const result = await runDaemonLifecycle(context, { ...options, progress })
      if (pending?.state.attemptId === result.attemptId) closeDialog(pending)
      return result
    } catch (error) {
      if (error instanceof LifecycleCancelled || !latest) {
        if (pending && latest && pending.state.attemptId === latest.attemptId) closeDialog(pending)
        throw error
      }
      const failed: DaemonLifecycleDialogState = {
        attemptId: latest.attemptId, reason: latest.reason, sessions: [], sessionCount: 0,
        uncertain: false, phase: 'failed', commandId: latest.commandId,
        failure: latest.failure ?? '退出结果尚未确认，请重试核验原请求。'
      }
      const active = pending?.state.attemptId === latest.attemptId ? pending : createDialog(failed)
      active.state = failed
      active.window.setTitle('退出未完成')
      const retry = await new Promise<boolean>(resolve => { active.recovery = resolve })
      if (!retry) throw Object.assign(error instanceof Error ? error : new Error('退出核验未完成'), { lifecycleDialogClosed: true })
    }
  }
}

export function lifecycleDialogWasClosed(error: unknown): boolean {
  return error instanceof Error && 'lifecycleDialogClosed' in error && error.lifecycleDialogClosed === true
}

import { dialog, type BrowserWindow, type MenuItemConstructorOptions, type MessageBoxOptions, type MessageBoxReturnValue } from 'electron'
import type { DaemonFailure, DaemonStatus } from '../../shared/daemon'
import { daemonIsAbsent, daemonManager } from './daemon-client/manager'

type Action = 'start' | 'stop' | 'restart'
type State = 'running' | 'stopping' | 'stopped' | 'unavailable'
interface Ports {
  getMain(): BrowserWindow | null
  changed(): void
  openSettings(): void
  isClosing(): boolean
}

/** Never parent a native confirmation to a hidden or minimized tray window. */
export function showDaemonTrayMessage(getMain: Ports['getMain'], options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
  const main = getMain()
  return main && !main.isDestroyed() && main.isVisible() && !main.isMinimized()
    ? dialog.showMessageBox(main, options)
    : dialog.showMessageBox(options)
}

/** Management-only projection. Refresh never starts a daemon or changes preferences. */
export function createDaemonTray(ports: Ports): {
  menu(): MenuItemConstructorOptions[]
  refresh(): Promise<void>
  run(action: Action): Promise<void>
  dispose(): void
} {
  let state: State = 'unavailable'
  let status: DaemonStatus | null = null
  let disposed = false
  let reading: Promise<void> | undefined
  let pending: Promise<void> | undefined
  let uncertain: DaemonFailure | undefined
  const changed = (): void => { if (!disposed) ports.changed() }
  const disabled = (): boolean => disposed || ports.isClosing() || pending !== undefined || uncertain !== undefined

  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve()
    if (reading) return reading
    const work = (async () => {
      let next: State = 'unavailable', actual: DaemonStatus | null = null
      try {
        const result = await daemonManager.status()
        if (result.ok) { actual = result.data; next = result.data.state }
        else if (await daemonIsAbsent()) next = 'stopped'
      } catch { /* An unverified owner is unavailable, never implicitly stopped. */ }
      if (disposed) return
      state = next; status = actual; changed()
    })()
    reading = work
    void work.finally(() => { if (reading === work) reading = undefined })
    return work
  }

  async function report(title: string, failure: DaemonFailure | string): Promise<void> {
    if (disposed) return
    const detail = typeof failure === 'string' ? failure
      : `${failure.error}${failure.commandId ? `\n原命令：${failure.commandId}` : ''}${failure.outcome === 'unknown' ? '\n结果尚未核实。请核对原命令与后台状态，勿重复停止或启动替代后台。' : ''}`
    try {
      await showDaemonTrayMessage(ports.getMain, { type: 'warning', title, message: title, detail, buttons: ['知道了'], noLink: true })
    } catch { console.error('后台操作提示无法显示；请打开后台设置核对原操作。') }
  }

  function run(action: Action): Promise<void> {
    if (pending) return pending
    if (disabled()) return Promise.resolve()
    let submitted = false
    const work = (async () => {
      await refresh()
      if (disposed || ports.isClosing() || uncertain) return
      if (action === 'start' ? state !== 'stopped' : state !== 'running') return
      if (action !== 'start') {
        const original = status
        const confirmed = await showDaemonTrayMessage(ports.getMain, {
          type: 'warning', title: action === 'stop' ? '停止后台服务？' : '重启后台服务？',
          message: '这会停止后台服务拥有的所有 Agent 与集成任务。',
          detail: action === 'restart' ? '任务停止并确认后台退出后，才会启动新的后台服务。' : '正在运行的后台任务也会停止。之后可从托盘手动启动。',
          buttons: ['取消', '停止所有后台任务并继续'], defaultId: 0, cancelId: 0, noLink: true
        })
        if (confirmed.response !== 1 || disposed || ports.isClosing()) return
        if (reading) await reading
        await refresh()
        // A confirmation is for the captured owner, including when activeJobs=0.
        if (!original || !status || status.state !== 'running' || original.epoch !== status.epoch || JSON.stringify(original.owner) !== JSON.stringify(status.owner)) {
          await report('后台所有者已改变', '请刷新状态后重新确认操作。此次未提交停止命令。')
          return
        }
      }
      if (disposed || ports.isClosing()) return
      submitted = true
      const result = await daemonManager[action]()
      if (!result.ok) {
        // Keep the original unknown receipt. No timer, repeated click or refresh
        // may issue another stop/restart with a new command identity.
        if (result.outcome === 'unknown') uncertain = result
        await report('后台操作未完成', result)
      }
    })().catch(async (error: unknown) => {
      const failure: DaemonFailure = { ok: false, code: 'E_UNKNOWN', outcome: submitted ? 'unknown' : 'not-admitted', error: error instanceof Error ? error.message : '后台操作结果尚未核实' }
      // A thrown mutation has no known receipt; retain uncertainty conservatively.
      if (submitted) uncertain = failure
      await report('后台操作未完成', failure)
    }).finally(async () => {
      await refresh()
      if (pending === work) pending = undefined
      changed()
    })
    pending = work; changed()
    return work
  }

  return {
    menu: () => [
      { label: `后台服务 · ${{ running: '运行中', stopping: '正在停止', stopped: '已停止', unavailable: '状态不可用' }[state]}`, enabled: false },
      ...(pending ? [{ label: '后台操作确认 / 处理中…', enabled: false }] : []),
      ...(uncertain ? [{ label: '原操作结果待核对', enabled: false }] : []),
      { label: '启动后台服务', enabled: !disabled() && state === 'stopped', click: () => { void run('start') } },
      { label: '停止后台服务…', enabled: !disabled() && state === 'running', click: () => { void run('stop') } },
      { label: '重启后台服务…', enabled: !disabled() && state === 'running', click: () => { void run('restart') } },
      { label: '刷新后台状态', enabled: !disposed && !ports.isClosing() && !pending, click: () => { void refresh() } },
      { label: '打开后台设置…', enabled: !disposed && !ports.isClosing(), click: ports.openSettings }
    ],
    refresh, run,
    dispose() { disposed = true }
  }
}

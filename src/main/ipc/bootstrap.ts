import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { bootstrapPaintSchema, legacyDaemonInspectionSchema, legacyDaemonStopInputSchema, type LegacyDaemonInspection, type LegacyDaemonStopInput } from '../../shared/bootstrap'
import type { DaemonFailure, DaemonResult } from '../../shared/daemon'
import { ipcInvoke } from '../../shared/ipc-channels'
import { ipcFail, IpcErrorCode } from '../../shared/ipc-errors'
import type { GuiBootstrap } from '../services/bootstrap'
import { DaemonError, daemonFailure } from '../daemon/errors'
import { handle } from './registry'

/** Available before native preparation. Every route is bound to the ordinary
 * main window's main frame, including read-only status and timing receipts. */
export function registerBootstrapIpc(deps: {
  getMain(): BrowserWindow | null
  bootstrap: GuiBootstrap
  legacyInspect(): Promise<DaemonResult<LegacyDaemonInspection>>
  legacyStop(input: LegacyDaemonStopInput): Promise<DaemonResult<{ stopped: true }>>
  legacyReconcile(input: LegacyDaemonStopInput): Promise<DaemonResult<{ stopped: true }>>
  exit(): Promise<void> | void
  attached(): void
  detached(): void
}): void {
  let legacyPending = false
  let inspected: { revision: number; data: LegacyDaemonInspection } | undefined
  let uncertainStop: DaemonFailure | undefined
  let originalStopInput: LegacyDaemonStopInput | undefined
  let originalStopCommandId: string | undefined
  const legacyAllowed = (): boolean => {
    const state = deps.bootstrap.state()
    return (state.phase === 'error' || state.phase === 'incompatible') &&
      state.failure?.stage === 'native' && state.failure.code === 'E_VERSION' &&
      state.marks.desktopReadyMs === undefined
  }
  const legacyDenied = (): DaemonFailure => daemonFailure(new DaemonError('E_DENIED', '旧后台切换仅供版本不兼容、尚未打开工作区的启动页使用。'))
  const legacyBusy = (): DaemonFailure => daemonFailure(new DaemonError('E_BUSY', '旧后台操作正在进行，请等待原操作结果。'))
  const guard = (event: IpcMainInvokeEvent): BrowserWindow | null => {
    const window = deps.getMain()
    return window && !window.isDestroyed() && !event.sender.isDestroyed() &&
      window.webContents === event.sender && event.senderFrame === window.webContents.mainFrame ? window : null
  }
  const denied = () => ipcFail(IpcErrorCode.Denied, '启动操作仅供主窗口使用')
  handle(ipcInvoke.bootstrap.status, event => guard(event) ? { ok: true, data: deps.bootstrap.state() } : denied())
  handle(ipcInvoke.bootstrap.retry, event => {
    if (!guard(event)) return denied()
    if (legacyPending || uncertainStop) return ipcFail(IpcErrorCode.Conflict, '旧后台停止尚未确认，请先核对原操作结果。')
    inspected = undefined
    // Return the connecting snapshot immediately; the subscriber observes the
    // result. A long migration must not disable the shell's exit controls.
    void deps.bootstrap.retry()
    return { ok: true, data: deps.bootstrap.state() }
  })
  handle(ipcInvoke.bootstrap.legacyInspect, async event => {
    if (!guard(event) || !legacyAllowed()) return legacyDenied()
    if (legacyPending) return legacyBusy()
    legacyPending = true
    inspected = undefined
    const revision = deps.bootstrap.state().revision
    try {
      const result = await deps.legacyInspect()
      if (!result.ok) return result
      const parsed = legacyDaemonInspectionSchema.safeParse(result.data)
      if (!parsed.success) return daemonFailure(new DaemonError('E_IO', '旧后台检查结果无效，请保留原后台并重新检查。'))
      if (!guard(event) || !legacyAllowed() || deps.bootstrap.state().revision !== revision) return legacyDenied()
      inspected = { revision, data: parsed.data }
      return { ok: true as const, data: parsed.data }
    } catch (error) { return daemonFailure(error) }
    finally { legacyPending = false }
  })
  handle(ipcInvoke.bootstrap.legacyStop, async (event, input: unknown) => {
    if (!guard(event) || !legacyAllowed()) return legacyDenied()
    if (uncertainStop) return uncertainStop
    if (legacyPending) return legacyBusy()
    const parsed = legacyDaemonStopInputSchema.safeParse(input)
    if (!parsed.success) return daemonFailure(new DaemonError('E_INVALID_ARG', '旧后台身份无效，请重新检查旧后台。'))
    const previous = inspected
    if (!previous || previous.revision !== deps.bootstrap.state().revision || !previous.data.canStop ||
      JSON.stringify(parsed.data) !== JSON.stringify({ epoch: previous.data.epoch, owner: previous.data.owner })) {
      return daemonFailure(new DaemonError('E_CONFLICT', '旧后台检查已失效，请重新检查后再切换。'))
    }
    legacyPending = true
    inspected = undefined
    originalStopInput = parsed.data
    originalStopCommandId = undefined
    try {
      const result = await deps.legacyStop(parsed.data)
      if (!result.ok) originalStopCommandId = result.commandId
      // Preserve backend command ID/error verbatim. Unknown delivery must never
      // become another stop command after a repeated invoke or renderer reload.
      if (!result.ok && result.outcome === 'unknown') uncertainStop = result
      if (result.ok && result.data.stopped !== true) {
        uncertainStop = daemonFailure(new DaemonError('E_UNKNOWN', '旧后台停止结果未获确认，请核对原操作。', 'unknown'))
        return uncertainStop
      }
      return result
    } catch (error) {
      uncertainStop = { ...daemonFailure(error), outcome: 'unknown' }
      return uncertainStop
    } finally { legacyPending = false }
  })
  handle(ipcInvoke.bootstrap.legacyReconcile, async (event, input: unknown) => {
    if (!guard(event) || !legacyAllowed()) return legacyDenied()
    if (legacyPending) return legacyBusy()
    const parsed = legacyDaemonStopInputSchema.optional().safeParse(input)
    if (!parsed.success) return daemonFailure(new DaemonError('E_INVALID_ARG', '原停止进程身份无效。'))
    if (!originalStopInput) return daemonFailure(new DaemonError('E_CONFLICT', '没有保留的原停止请求，无需核对。'))
    if (parsed.data && JSON.stringify(parsed.data) !== JSON.stringify(originalStopInput)) {
      return daemonFailure(new DaemonError('E_CONFLICT', '只能核对原停止请求的后台身份。'))
    }
    // The renderer may have lost a successful IPC reply. Keep the original
    // submitted input available for observation in that case too.
    const originalFailure = uncertainStop ?? daemonFailure(new DaemonError('E_UNKNOWN', '原停止结果尚未获桌面确认。', 'unknown'), originalStopCommandId)
    uncertainStop = originalFailure
    legacyPending = true
    try {
      // This injected backend operation only observes/joins the original stop;
      // it must never issue another daemon.stop or generate another command ID.
      const result = await deps.legacyReconcile(originalStopInput)
      if (result.ok && result.data.stopped === true) {
        uncertainStop = undefined; originalStopInput = undefined; originalStopCommandId = undefined; inspected = undefined
        return result
      }
      if (!result.ok) {
        const failure = { ...result, commandId: originalFailure.commandId ?? result.commandId }
        originalStopCommandId = failure.commandId
        // Trusted observation of this exact attempt can prove no stop was
        // submitted. Retain its identity, but require fresh inspection to stop.
        if (result.outcome === 'not-admitted') {
          uncertainStop = undefined; inspected = undefined
          return failure
        }
        uncertainStop = failure
      }
      return uncertainStop ?? originalFailure
    } catch {
      // A failed observation says nothing new about the original effect.
      return originalFailure
    } finally { legacyPending = false }
  })
  handle(ipcInvoke.bootstrap.exit, async event => {
    if (!guard(event)) return denied()
    try { await deps.exit(); return { ok: true } }
    catch { return ipcFail(IpcErrorCode.Unknown, '桌面清理尚未完成；请保留窗口，核对本机状态后重试退出。') }
  })
  handle(ipcInvoke.bootstrap.minimize, event => {
    const window = guard(event); if (!window) return denied()
    window.minimize(); return { ok: true }
  })
  handle(ipcInvoke.bootstrap.maximize, event => {
    const window = guard(event); if (!window) return denied()
    if (window.isMaximized()) window.unmaximize(); else window.maximize()
    return { ok: true }
  })
  handle(ipcInvoke.bootstrap.paint, (event, input: unknown) => {
    if (!guard(event)) return denied()
    const parsed = bootstrapPaintSchema.safeParse(input)
    if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '首次绘制记录无效')
    deps.bootstrap.firstPaint(parsed.data.startTimeMs); return { ok: true }
  })
  handle(ipcInvoke.bootstrap.rendered, event => {
    if (!guard(event)) return denied()
    deps.bootstrap.rendererReady()
    void deps.bootstrap.start()
    return { ok: true }
  })
  handle(ipcInvoke.bootstrap.attached, event => {
    if (!guard(event)) return denied()
    if (deps.bootstrap.state().phase !== 'ready') return ipcFail(IpcErrorCode.Unavailable, '完整桌面尚未就绪')
    try { deps.attached(); return { ok: true } }
    catch { return ipcFail(IpcErrorCode.Unavailable, '桌面事件接入未完成，请保留原后台状态并重载桌面。') }
  })
  handle(ipcInvoke.bootstrap.detached, event => {
    if (!guard(event)) return denied()
    deps.detached(); return { ok: true }
  })
}

import { daemonPayloads, daemonPreferencesSchema, type DaemonFailure, type DaemonResult } from '../../shared/daemon'
import { ipcInvoke } from '../../shared/ipc-channels'
import { ipcFail, IpcErrorCode } from '../../shared/ipc-errors'
import { daemonManager, daemonBuildFreshnessForCurrentOwner } from '../services/daemon-client/manager'
import type { WindowDeps } from './deps'
import { handle } from './registry'

export function registerDaemonIpc(deps: WindowDeps): void {
  const fail = (code: DaemonFailure['code'], error: string): DaemonFailure => ({ ...ipcFail(code, error), code, outcome: 'not-admitted' })
  const invoke = async <T>(event: Electron.IpcMainInvokeEvent, action: () => Promise<DaemonResult<T>>): Promise<DaemonResult<T>> => {
    if (deps.getMain()?.webContents.id !== event.sender.id || event.senderFrame !== event.sender.mainFrame) return fail(IpcErrorCode.Denied, 'Daemon management is available only in the native main window.')
    const result = await action()
    return result.ok ? result : { ...ipcFail(result.code, result.error), ...result }
  }
  handle(ipcInvoke.daemon.status, (event) => invoke(event, () => daemonManager.status()))
  handle(ipcInvoke.daemon.inspectRecovery, event => invoke(event, async () => {
    const status = await daemonManager.status()
    if (!status.ok) return status
    const freshness = await daemonBuildFreshnessForCurrentOwner(status.data)
    return { ok: true, data: { build: freshness?.state ?? 'unknown', epoch: status.data.epoch } }
  }))
  handle(ipcInvoke.daemon.start, (event) => invoke(event, () => daemonManager.start()))
  handle(ipcInvoke.daemon.stop, (event) => invoke(event, () => daemonManager.stop()))
  handle(ipcInvoke.daemon.restart, (event) => invoke(event, () => daemonManager.restart()))
  handle(ipcInvoke.daemon.preferences, (event) => invoke(event, () => daemonManager.preferences()))
  handle(ipcInvoke.daemon.setPreferences, (event, raw: unknown) => invoke(event, async () => {
    const input = daemonPreferencesSchema.safeParse(raw)
    return input.success ? daemonManager.setPreferences(input.data) : fail(IpcErrorCode.InvalidArg, 'Daemon preferences are invalid. Reload their current revision.')
  }))
  handle(ipcInvoke.daemon.logs, (event, raw: unknown) => invoke(event, async () => {
    const input = daemonPayloads['daemon.logs'].safeParse(raw)
    return input.success ? daemonManager.logs(input.data) : fail(IpcErrorCode.InvalidArg, 'Daemon log cursor/limit is invalid.')
  }))
  handle(ipcInvoke.daemon.reconcileStartup, (event, raw: unknown) => invoke(event, async () => {
    const input = daemonPayloads['daemon.startup.reconcile'].safeParse(raw)
    if (!input.success) return fail(IpcErrorCode.InvalidArg, '原启动注册命令标识无效，请刷新后台状态。')
    return daemonManager.reconcileStartup ? daemonManager.reconcileStartup(input.data.originalCommandId) : fail(IpcErrorCode.Unavailable, '当前原生版本未提供启动注册对账，请完整重启应用。')
  }))
}

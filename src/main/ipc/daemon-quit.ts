import { ipcInvoke } from '../../shared/ipc-channels'
import { ipcFail, IpcErrorCode } from '../../shared/ipc-errors'
import { daemonQuitDecisionSchema } from '../../shared/daemon-quit'
import { decideDaemonQuit, quitDialogState } from '../services/daemon-quit-dialog'
import { handle } from './registry'
export function registerDaemonQuitIpc(): void {
  handle(ipcInvoke.daemonQuit.state, event => {
    const state = quitDialogState(event.sender, event.senderFrame)
    return state ? { ok: true, data: state } : { ...ipcFail(IpcErrorCode.Denied, '退出确认仅可由当前原生确认窗口读取'), outcome: 'not-admitted' }
  })
  handle(ipcInvoke.daemonQuit.decide, (event, raw: unknown) => {
    const parsed = daemonQuitDecisionSchema.safeParse(raw)
    return parsed.success && decideDaemonQuit(event.sender, event.senderFrame, parsed.data) ? { ok: true, data: null } : { ...ipcFail(IpcErrorCode.Conflict, '退出确认已失效，请重新打开'), outcome: 'not-admitted' }
  })
}

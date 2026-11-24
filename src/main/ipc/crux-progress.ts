import { ipcInvoke } from '../../shared/ipc-channels'
import { IpcErrorCode, ipcFail } from '../../shared/ipc-errors'
import { CruxTaskProgressService } from '../services/crux/task-progress'
import { handle } from './registry'
import type { BrowserWindow } from 'electron'

/** Only the native application's top-level document gets the task-bound capability. */
export function registerCruxProgressIpc(getMain: () => BrowserWindow | null): CruxTaskProgressService {
  const service = new CruxTaskProgressService()
  const register = (channel: string, action: (input: unknown) => Promise<unknown>): void => {
    handle(channel, (event, input: unknown) => {
      const window = getMain()
      if (!window || window.isDestroyed() || event.sender.isDestroyed() || window.webContents !== event.sender || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) return ipcFail(IpcErrorCode.Denied, '任务执行只允许从原生主窗口操作')
      return action(input)
    })
  }
  register(ipcInvoke.cruxProgress.status, input => service.status(input))
  register(ipcInvoke.cruxProgress.report, input => service.report(input))
  register(ipcInvoke.cruxProgress.retry, input => service.retry(input))
  register(ipcInvoke.cruxProgress.detach, input => service.detach(input))
  return service
}

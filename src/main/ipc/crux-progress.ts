import { ipcInvoke } from '../../shared/ipc-channels'
import { IpcErrorCode, ipcFail } from '../../shared/ipc-errors'
import { CruxTaskProgressService } from '../services/crux/task-progress'
import type { CruxTaskWorkspaceService } from '../services/crux/task-workspace'
import { handle } from './registry'
import type { BrowserWindow } from 'electron'

/** Only the native application's top-level document gets the task-bound capability. */
export function registerCruxProgressIpc(workspace: CruxTaskWorkspaceService, getMain: () => BrowserWindow | null): CruxTaskProgressService {
  const service = new CruxTaskProgressService(workspace)
  const register = (channel: string, action: (input: unknown) => Promise<unknown>): void => {
    handle(channel, (event, input: unknown) => {
      const window = getMain()
      if (!window || window.isDestroyed() || event.sender.isDestroyed() || window.webContents !== event.sender || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) return ipcFail(IpcErrorCode.Denied, '任务执行只允许从原生主窗口操作')
      return action(input)
    })
  }
  register(ipcInvoke.cruxProgress.status, input => service.status(input))
  register(ipcInvoke.cruxProgress.start, input => service.start(input))
  register(ipcInvoke.cruxProgress.report, input => service.report(input))
  register(ipcInvoke.cruxProgress.retry, input => service.retry(input))
  register(ipcInvoke.cruxProgress.detach, input => service.detach(input))
  register(ipcInvoke.cruxProgress.conversation, input => service.conversation(input as Parameters<typeof service.conversation>[0]))
  register(ipcInvoke.cruxProgress.events, input => service.events(input as Parameters<typeof service.events>[0]))
  register(ipcInvoke.cruxProgress.send, input => service.send(input as Parameters<typeof service.send>[0]))
  register(ipcInvoke.cruxProgress.respond, input => service.respond(input as Parameters<typeof service.respond>[0]))
  register(ipcInvoke.cruxProgress.cancel, input => service.cancel(input as Parameters<typeof service.cancel>[0]))
  register(ipcInvoke.cruxProgress.resume, input => service.resumeSession(input as Parameters<typeof service.resumeSession>[0]))
  return service
}

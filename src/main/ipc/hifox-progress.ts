import { ipcInvoke } from '../../shared/ipc-channels'
import { IpcErrorCode, ipcFail } from '../../shared/ipc-errors'
import { HifoxTaskProgressService } from '../services/hifox/task-progress'
import type { HifoxTaskWorkspaceService } from '../services/hifox/task-workspace'
import { handle } from './registry'
import type { BrowserWindow } from 'electron'

/** Only the native application's top-level document gets the task-bound capability. */
export function registerHifoxProgressIpc(workspace: HifoxTaskWorkspaceService, getMain: () => BrowserWindow | null): HifoxTaskProgressService {
  const service = new HifoxTaskProgressService(workspace)
  const register = (channel: string, action: (input: unknown) => Promise<unknown>): void => {
    handle(channel, (event, input: unknown) => {
      const window = getMain()
      if (!window || window.isDestroyed() || event.sender.isDestroyed() || window.webContents !== event.sender || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) return ipcFail(IpcErrorCode.Denied, '任务执行只允许从原生主窗口操作')
      return action(input)
    })
  }
  register(ipcInvoke.hifoxProgress.status, input => service.status(input))
  register(ipcInvoke.hifoxProgress.start, input => service.start(input))
  register(ipcInvoke.hifoxProgress.report, input => service.report(input))
  register(ipcInvoke.hifoxProgress.retry, input => service.retry(input))
  register(ipcInvoke.hifoxProgress.detach, input => service.detach(input))
  register(ipcInvoke.hifoxProgress.conversation, input => service.conversation(input as Parameters<typeof service.conversation>[0]))
  register(ipcInvoke.hifoxProgress.events, input => service.events(input as Parameters<typeof service.events>[0]))
  register(ipcInvoke.hifoxProgress.send, input => service.send(input as Parameters<typeof service.send>[0]))
  register(ipcInvoke.hifoxProgress.respond, input => service.respond(input as Parameters<typeof service.respond>[0]))
  register(ipcInvoke.hifoxProgress.cancel, input => service.cancel(input as Parameters<typeof service.cancel>[0]))
  register(ipcInvoke.hifoxProgress.resume, input => service.resumeSession(input as Parameters<typeof service.resumeSession>[0]))
  return service
}

import { app, dialog, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { ipcInvoke } from '../../shared/ipc-channels'
import { ipcFail, IpcErrorCode } from '../../shared/ipc-errors'
import type { DesignResult } from '../../shared/design-workspace'
import { DesignWorkspace } from '../services/design-workspace/service'
import { DesignWorkspaceError } from '../services/design-workspace/types'
import type { PrivateConversations } from '../services/private-conversations/service'
import type { WindowDeps } from './deps'
import { handle } from './registry'

export function registerDesignWorkspaceIpc(deps: WindowDeps, conversations: PrivateConversations): DesignWorkspace {
  const service = new DesignWorkspace({
    directory: () => app.getPath('userData'), conversations,
    chooseSave: async input => {
      const main = deps.getMain()
      if (!main || main.isDestroyed()) throw new DesignWorkspaceError('主窗口不可用', IpcErrorCode.Unavailable)
      const choice = await dialog.showSaveDialog(main, {
        title: input.format === 'source' ? '导出设计源包' : '导出可运行原型', defaultPath: input.defaultName,
        filters: [{ name: input.format === 'source' ? '设计源包' : 'HTML 原型', extensions: [input.format === 'source' ? 'zip' : 'html'] }]
      })
      return choice.canceled || !choice.filePath ? null : choice.filePath
    }
  })
  const documents = new WeakMap<Electron.WebContents, object>(), watched = new WeakSet<Electron.WebContents>()
  function capture(event: IpcMainInvokeEvent): () => void {
    const main = deps.getMain(), sender = event.sender, frame = event.senderFrame
    if (!main || main.isDestroyed() || main.webContents !== sender || sender.isDestroyed() || !frame || frame !== sender.mainFrame || frame.parent) throw new DesignWorkspaceError('请从应用主页面操作个人设计', IpcErrorCode.Denied)
    if (!watched.has(sender)) {
      watched.add(sender)
      const release = (): void => { documents.delete(sender) }
      sender.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => { if (isMainFrame && !inPlace) release() })
      sender.on('render-process-gone', release); sender.once('destroyed', release)
    }
    let owner = documents.get(sender)
    if (!owner) { owner = Object.freeze({}); documents.set(sender, owner) }
    const normalize = (value: string): string => { const url = new URL(value); url.hash = ''; return url.href }
    const processId = frame.processId, routingId = frame.routingId, url = normalize(frame.url)
    return () => {
      if (deps.getMain() !== main || main.isDestroyed() || sender.isDestroyed() || frame.isDestroyed() || sender.mainFrame !== frame || frame.processId !== processId || frame.routingId !== routingId || normalize(frame.url) !== url || documents.get(sender) !== owner) throw new DesignWorkspaceError('原页面已变化；设计和原操作已保留')
    }
  }
  const wrapped = <T>(channel: string, action: (input: unknown, current: () => void) => Promise<T>): void => {
    handle(channel, async (event, input: unknown): Promise<DesignResult<T>> => {
      try {
        const current = capture(event); current()
        const value = await action(input, current); current()
        return { ok: true, value }
      } catch (error) {
        const code = error instanceof z.ZodError ? IpcErrorCode.InvalidArg : error && typeof error === 'object' && 'code' in error && Object.values(IpcErrorCode).includes(error.code as typeof IpcErrorCode.Io) ? error.code as typeof IpcErrorCode.Io : IpcErrorCode.Io
        const request = channel === ipcInvoke.designWorkspace.send ? z.object({ requestId: z.string().uuid() }).safeParse(input) : undefined
        const receipt = error instanceof DesignWorkspaceError && error.receipt ? error.receipt : request?.success ? { requestId: request.data.requestId, outcomeUnknown: true, outcome: 'unknown' } : undefined
        return ipcFail(code, error instanceof Error ? error.message : '设计操作未完成', receipt)
      }
    })
  }
  const channels = ipcInvoke.designWorkspace
  wrapped(channels.list, (_input, current) => service.list(current))
  wrapped(channels.get, (input, current) => service.get(input, current))
  wrapped(channels.listConversation, (input, current) => service.listConversation(input, current))
  wrapped(channels.sync, (input, current) => service.sync(input, current))
  wrapped(channels.createConversation, (input, current) => service.createConversation(input, current))
  wrapped(channels.save, (input, current) => service.save(input, current))
  wrapped(channels.send, (input, current) => service.send(input, current))
  wrapped(channels.status, (input, current) => service.status(input, current))
  wrapped(channels.respond, (input, current) => service.respond(input, current))
  wrapped(channels.adopt, (input, current) => service.adopt(input, current))
  wrapped(channels.discard, (input, current) => service.discard(input, current))
  wrapped(channels.export, (input, current) => service.export(input, current))
  app.once('will-quit', () => { void service.dispose().catch(error => { process.emitWarning(error instanceof Error ? error.message : '设计工作区关闭未确认') }) })
  return service
}

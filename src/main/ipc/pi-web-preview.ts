import { app, shell, webContents, type WebContents } from 'electron'
import { ipcInvoke } from '../../shared/ipc-channels'
import { IpcErrorCode, ipcFail } from '../../shared/ipc-errors'
import { PiWebPreviewService, type PiWebPreviewDependencies } from '../services/pi-web-preview'
import { installPiWebPreviewNavigation } from '../services/pi-web-preview/navigation'
import { handle } from './registry'

export function registerPiWebPreviewIpc(deps: PiWebPreviewDependencies): void {
  const service = new PiWebPreviewService(deps)
  const protect = (sender: WebContents): void => {
    if (!sender.isDestroyed() && sender.getType() === 'window') installPiWebPreviewNavigation(sender, service)
  }
  const created = (_event: Electron.Event, sender: WebContents): void => protect(sender)
  app.on('web-contents-created', created)
  for (const sender of webContents.getAllWebContents()) protect(sender)
  const owners = new Map<number, { sender: WebContents; epoch: number }>()
  const ownerFor = (sender: WebContents) => {
    let owner = owners.get(sender.id)
    if (!owner) {
      owner = { sender, epoch: 0 }
      owners.set(sender.id, owner)
      installPiWebPreviewNavigation(sender, service)
      const captured = owner
      sender.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (!isMainFrame || isInPlace) return
        captured.epoch += 1
        service.closeOwner(sender.id)
      })
      sender.on('render-process-gone', () => { captured.epoch += 1; service.closeOwner(sender.id) })
      sender.once('destroyed', () => { captured.epoch += 1; service.closeOwner(sender.id); owners.delete(sender.id) })
    }
    const captured = owner, epoch = owner.epoch
    return { id: sender.id, isCurrent: () => !sender.isDestroyed() && captured.epoch === epoch }
  }
  const trustedFrame = (event: Electron.IpcMainInvokeEvent): boolean => Boolean(event.senderFrame && !event.senderFrame.parent && !event.sender.isDestroyed())
  const denied = () => ipcFail(IpcErrorCode.Denied, '静态预览仅允许应用主文档调用。')
  handle(ipcInvoke.acp.piWebPreviewOpen, (event, input: unknown) => trustedFrame(event) ? service.open(ownerFor(event.sender), input) : denied())
  handle(ipcInvoke.acp.piWebPreviewStatus, (event, id: unknown) => trustedFrame(event) ? service.status(event.sender.id, id) : denied())
  handle(ipcInvoke.acp.piWebPreviewClose, (event, id: unknown) => trustedFrame(event) ? service.close(event.sender.id, id) : denied())
  handle(ipcInvoke.acp.piWebPreviewOpenExternal, async (event, id: unknown) => {
    if (!trustedFrame(event)) return denied()
    const owner = ownerFor(event.sender)
    const target = await service.externalUrl(event.sender.id, id)
    if (!target.ok) return target
    if (!owner.isCurrent() || !service.ownsCurrent(event.sender.id, id))
      return ipcFail(IpcErrorCode.Conflict, '项目或预览窗口已变化，未打开浏览器。')
    try { await shell.openExternal(target.url); return { ok: true } }
    catch { return ipcFail(IpcErrorCode.Io, '无法在本机浏览器打开预览，请检查默认浏览器后重试。') }
  })
  app.once('will-quit', () => { app.off('web-contents-created', created); service.dispose(); owners.clear() })
}

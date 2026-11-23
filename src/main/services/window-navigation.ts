import { Menu, shell, type BrowserWindow, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { externalHttpUrl } from '../../shared/external-url'

const trustedDocuments = new WeakMap<WebContents, { matches: (url: string) => boolean; generation: number }>()

export function captureAppWindowDocument(window: BrowserWindow, event: IpcMainInvokeEvent): (() => boolean) | null {
  const { sender, senderFrame: frame } = event
  const document = trustedDocuments.get(sender)
  if (!document || !frame) return null
  const generation = document.generation
  const isCurrent = (): boolean => !window.isDestroyed() && !sender.isDestroyed() && !frame.isDestroyed()
    && window.webContents === sender && sender.mainFrame === frame && !frame.parent
    && trustedDocuments.get(sender) === document && document.generation === generation && document.matches(frame.url)
  return isCurrent() ? isCurrent : null
}

/** Keep the existing Promise<void> IPC contract, including when the OS opener fails. */
export async function openExternalHttpUrl(value: unknown): Promise<void> {
  const url = externalHttpUrl(value)
  if (!url) return
  try {
    await shell.openExternal(url)
  } catch (error) {
    console.warn('Unable to open link in the system browser', error)
  }
}

/** Install before loading: only this exact app document (plus fragments) is trusted. */
export function installWindowNavigation(window: BrowserWindow, appDocumentUrl: string): void {
  window.webContents.on('context-menu', (_event, params) => {
    if (window.isDestroyed() || !params.isEditable && !params.selectionText) return
    const items: MenuItemConstructorOptions[] = []
    if (params.isEditable) items.push(
      { role: 'undo', label: '撤销', enabled: params.editFlags.canUndo },
      { role: 'redo', label: '重做', enabled: params.editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', label: '剪切', enabled: params.editFlags.canCut }
    )
    items.push({ role: 'copy', label: '复制', enabled: params.editFlags.canCopy })
    if (params.isEditable) items.push({ role: 'paste', label: '粘贴', enabled: params.editFlags.canPaste })
    items.push({ type: 'separator' }, { role: 'selectAll', label: '全选' })
    Menu.buildFromTemplate(items).popup({ window })
  })
  const documentKey = (value: string): string => {
    const url = new URL(value)
    url.hash = ''
    // loadFile uses %20 while URLSearchParams uses + for the same query value.
    url.search = url.searchParams.toString()
    return url.href
  }
  const trusted = documentKey(appDocumentUrl)
  const isAppDocument = (value: string): boolean => {
    try {
      return documentKey(value) === trusted
    } catch {
      return false
    }
  }
  const document = { matches: isAppDocument, generation: 0 }
  trustedDocuments.set(window.webContents, document)
  window.webContents.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument) document.generation++
  })
  window.webContents.on('render-process-gone', () => { document.generation++ })
  const guard = (event: Electron.Event<{ url: string; isMainFrame: boolean }>): void => {
    if (!event.isMainFrame || isAppDocument(event.url)) return
    event.preventDefault()
    void openExternalHttpUrl(event.url)
  }
  window.webContents.on('will-navigate', guard)
  // Covers redirects from trusted initial loadURL/reload, which bypass will-navigate.
  window.webContents.on('will-redirect', guard)
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAppDocument(url)) void openExternalHttpUrl(url)
    return { action: 'deny' }
  })
}

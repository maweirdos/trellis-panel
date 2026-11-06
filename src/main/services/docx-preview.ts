import { BrowserWindow, type IpcMainEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ipcEvent, ipcInvoke } from '../../shared/ipc-channels'
import { on } from '../ipc/registry'
import { DOCX_PREVIEW_ERRORS, isDocxPreviewErrorCode } from '../../shared/docx-preview'

export class DocxConversionError extends Error {}

const MAX_INPUT = 8 * 1024 * 1024
const MAX_OUTPUT = 2 * 1024 * 1024
const MAX_CONCURRENT = 2
const TIMEOUT = 12_000
const active = new Map<number, { id: string; complete(value: unknown): void }>()
let registered = false

/** Each request owns one restricted, disposable renderer and no filesystem bridge. */
export function convertDocx(bytes: Uint8Array, signal: AbortSignal): Promise<string> {
  if (!registered) {
    registered = true
    on(ipcInvoke.docxPreviewResult, (event: IpcMainEvent, value: unknown) => active.get(event.sender.id)?.complete(value))
  }
  if (signal.aborted) return Promise.reject(new DocxConversionError('预览已取消'))
  if (!bytes.length) return Promise.reject(new DocxConversionError(DOCX_PREVIEW_ERRORS['invalid-document']))
  if (bytes.length > MAX_INPUT) return Promise.reject(new DocxConversionError(DOCX_PREVIEW_ERRORS['input-limit']))
  if (active.size >= MAX_CONCURRENT) return Promise.reject(new DocxConversionError('预览任务过多，请稍后重试。'))
  const id = randomUUID()
  const window = new BrowserWindow({ show: false, webPreferences: {
    preload: join(__dirname, '../preload/docx-preview.js'), sandbox: true, contextIsolation: true,
    nodeIntegration: false, nodeIntegrationInWorker: false, spellcheck: false
  } })
  const contents = window.webContents
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', event => event.preventDefault())
  contents.on('will-redirect', event => event.preventDefault())
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (error?: Error, html?: string): void => {
      if (done) return
      done = true
      clearTimeout(timer); signal.removeEventListener('abort', cancel); active.delete(contents.id)
      if (!window.isDestroyed()) window.destroy()
      if (error) reject(error); else resolve(html ?? '')
    }
    const cancel = (): void => finish(new DocxConversionError('预览已取消'))
    const timer = setTimeout(() => finish(new DocxConversionError('DOCX 预览超时，请使用系统打开。')), TIMEOUT)
    signal.addEventListener('abort', cancel, { once: true })
    active.set(contents.id, { id, complete(value: unknown): void {
      if (!value || typeof value !== 'object') return
      const response = value as { id?: unknown; ok?: unknown; html?: unknown; code?: unknown }
      if (response.id !== id || typeof response.ok !== 'boolean') return
      if (!response.ok) { const code = isDocxPreviewErrorCode(response.code) ? response.code : 'invalid-document'; finish(new DocxConversionError(DOCX_PREVIEW_ERRORS[code])); return }
      if (typeof response.html !== 'string') { finish(new DocxConversionError(DOCX_PREVIEW_ERRORS['invalid-document'])); return }
      if (Buffer.byteLength(response.html, 'utf8') > MAX_OUTPUT) { finish(new DocxConversionError(DOCX_PREVIEW_ERRORS['output-size-limit'])); return }
      finish(undefined, response.html)
    } })
    contents.once('render-process-gone', () => finish(new DocxConversionError('DOCX 预览不可用，请使用系统打开。')))
    contents.once('destroyed', () => finish(new DocxConversionError('DOCX 预览已关闭。')))
    contents.once('did-finish-load', () => { if (!done) contents.send(ipcEvent.docxPreviewInput, { id, bytes }) })
    const dev = process.env.ELECTRON_RENDERER_URL
    const url = dev ? new URL('docx-preview.html', `${dev.replace(/\/$/, '')}/`).href : pathToFileURL(join(__dirname, '../renderer/docx-preview.html')).href
    void window.loadURL(url).catch(() => finish(new DocxConversionError('DOCX 预览不可用，请使用系统打开。')))
    if (signal.aborted) cancel()
  })
}

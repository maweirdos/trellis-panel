import { contextBridge, ipcRenderer } from 'electron'
import { ipcEvent, ipcInvoke } from '../shared/ipc-channels'
import { isDocxPreviewErrorCode, type DocxPreviewErrorCode } from '../shared/docx-preview'

type Input = { id: string; bytes: Uint8Array }
type Output = { id: string; ok: true; html: string } | { id: string; ok: false; code: DocxPreviewErrorCode }
let subscribed = false, completed = false
contextBridge.exposeInMainWorld('docxPreview', Object.freeze({
  receive(callback: (input: Input) => void): void {
    if (subscribed || typeof callback !== 'function') return
    subscribed = true
    ipcRenderer.once(ipcEvent.docxPreviewInput, (_event, input: Input) => callback(input))
  },
  complete(output: Output): void {
    if (completed || !output || typeof output.id !== 'string' || output.id.length > 64 || typeof output.ok !== 'boolean') return
    if (output.ok && (typeof output.html !== 'string' || output.html.length > 2 * 1024 * 1024)) return
    if (!output.ok && !isDocxPreviewErrorCode(output.code)) return
    completed = true
    ipcRenderer.send(ipcInvoke.docxPreviewResult, output)
  }
}))

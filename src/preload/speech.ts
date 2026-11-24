import { ipcRenderer } from 'electron'
import { ipcInvoke } from '../shared/ipc-channels'
import type { SpeechApi } from '../shared/speech'

export const speech: SpeechApi | undefined = process.platform === 'win32' && process.arch === 'x64' ? {
  status: () => ipcRenderer.invoke(ipcInvoke.speech.status),
  begin: id => ipcRenderer.invoke(ipcInvoke.speech.begin, id),
  transcribe: (id, pcm) => ipcRenderer.invoke(ipcInvoke.speech.transcribe, id, pcm),
  cancel: id => ipcRenderer.invoke(ipcInvoke.speech.cancel, id),
  importModel: id => ipcRenderer.invoke(ipcInvoke.speech.importModel, id),
  downloadModel: id => ipcRenderer.invoke(ipcInvoke.speech.downloadModel, id),
} : undefined

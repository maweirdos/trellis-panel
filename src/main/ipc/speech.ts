import { app, dialog, session, type BrowserWindow, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { ipcInvoke } from '../../shared/ipc-channels'
import { ipcFail, IpcErrorCode } from '../../shared/ipc-errors'
import { SPEECH_MAX_BYTES, SPEECH_MAX_SECONDS, type SpeechApi } from '../../shared/speech'
import { downloadSpeechModel, importSpeechModel, SpeechModelMissingError, speechModelPresent, speechRuntimeAvailable, transcribeSpeech } from '../services/speech/runtime'
import { captureAppWindowDocument } from '../services/window-navigation'
import { handle } from './registry'

type Owner = { window: BrowserWindow; sender: WebContents; isCurrent: () => boolean }
type Recording = {
  id: string
  owner: Owner
  controller: AbortController
  permissionUntil: number
  deadline: ReturnType<typeof setTimeout>
  transcribing: boolean
}

const denied = () => ipcFail(IpcErrorCode.Denied, '语音操作仅限当前 Crux 主窗口。')
const unavailable = () => ipcFail(IpcErrorCode.Unavailable, '本机语音运行资源不可用。')
const busy = () => ipcFail(IpcErrorCode.Busy, '有一项语音操作正在进行。')
const missingModel = () => ipcFail(IpcErrorCode.NotFound, '请下载或导入多语模型 Whisper Tiny。')
const invalidInput = () => ipcFail(IpcErrorCode.InvalidArg, '语音操作参数无效。')
const validId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)

export function registerSpeechIpc(getMain: () => BrowserWindow | null): void {
  if (process.platform !== 'win32' || process.arch !== 'x64') return
  let recording: Recording | undefined
  let installing: { id: string; owner: Owner; controller: AbortController } | undefined
  let closing = false
  const observed = new WeakSet<WebContents>()
  const release = (target: Recording): void => {
    clearTimeout(target.deadline)
    target.controller.abort()
    if (!target.transcribing && recording === target) recording = undefined
  }
  const revokeWindow = (sender: WebContents): void => {
    if (recording?.owner.sender === sender) release(recording)
    if (installing?.owner.sender === sender) installing.controller.abort()
  }
  const identify = (event: IpcMainInvokeEvent): Owner | null => {
    if (closing) return null
    const window = getMain()
    if (!window) return null
    const frameCurrent = captureAppWindowDocument(window, event)
    if (!frameCurrent) return null
    const sender = event.sender
    if (!observed.has(sender)) {
      observed.add(sender)
      sender.on('did-start-navigation', details => {
        if (details.isMainFrame && !details.isSameDocument) revokeWindow(sender)
      })
      sender.on('render-process-gone', () => revokeWindow(sender))
      sender.once('destroyed', () => revokeWindow(sender))
    }
    return { window, sender, isCurrent: () => !closing && getMain() === window && frameCurrent() }
  }
  const canCapture = (sender: WebContents | null, topFrame: boolean): boolean =>
    Boolean(sender && topFrame && recording?.owner.sender === sender && recording.owner.isCurrent() &&
      !recording.controller.signal.aborted && Date.now() < recording.permissionUntil)
  session.defaultSession.setPermissionCheckHandler((sender, permission, _origin, details) => {
    if (permission === 'media') return details.mediaType === 'audio' && canCapture(sender, details.isMainFrame)
    return permission !== 'display-capture'
  })
  session.defaultSession.setPermissionRequestHandler((sender, permission, done, details) => {
    if (permission === 'media') {
      const types = 'mediaTypes' in details ? details.mediaTypes : undefined
      done(types?.length === 1 && types[0] === 'audio' && canCapture(sender, details.isMainFrame))
      return
    }
    done(permission !== 'display-capture')
  })
  app.once('will-quit', () => {
    closing = true
    if (recording) release(recording)
    installing?.controller.abort()
  })

  handle(ipcInvoke.speech.status, async (event): ReturnType<SpeechApi['status']> => {
    if (!identify(event)) return denied()
    try {
      const state = !speechRuntimeAvailable() ? 'unavailable' : speechModelPresent() ? 'ready' : 'missing-model'
      return { ok: true, state }
    } catch { return unavailable() }
  })
  handle(ipcInvoke.speech.begin, async (event, id: unknown): ReturnType<SpeechApi['begin']> => {
    const owner = identify(event)
    if (!owner || !owner.window.isFocused()) return denied()
    if (!validId(id)) return invalidInput()
    if (recording || installing) return busy()
    try {
      if (!speechRuntimeAvailable()) return unavailable()
      if (!speechModelPresent()) return missingModel()
    } catch { return unavailable() }
    const controller = new AbortController()
    const current: Recording = {
      id, owner, controller, permissionUntil: Date.now() + 20_000, transcribing: false,
      deadline: setTimeout(() => release(current), (SPEECH_MAX_SECONDS + 30) * 1000),
    }
    recording = current
    return { ok: true }
  })
  handle(ipcInvoke.speech.cancel, async (event, id: unknown): ReturnType<SpeechApi['cancel']> => {
    const owner = identify(event)
    if (!owner) return denied()
    if (!validId(id)) return invalidInput()
    if (recording?.id === id && recording.owner.sender === owner.sender) release(recording)
    if (installing?.id === id && installing.owner.sender === owner.sender) installing.controller.abort()
    return { ok: true }
  })
  handle(ipcInvoke.speech.transcribe, async (event, id: unknown, pcm: unknown): ReturnType<SpeechApi['transcribe']> => {
    const owner = identify(event)
    const current = recording
    if (!owner || !current || current.id !== id || current.owner.sender !== owner.sender || !current.owner.isCurrent()) return denied()
    if (current.transcribing) return busy()
    if (!(pcm instanceof ArrayBuffer) || !pcm.byteLength || pcm.byteLength > SPEECH_MAX_BYTES ||
        pcm.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) return invalidInput()
    clearTimeout(current.deadline)
    current.permissionUntil = 0
    current.transcribing = true
    const signal = current.controller.signal
    try {
      const text = await transcribeSpeech(new Float32Array(pcm), signal)
      return current.owner.isCurrent() && !signal.aborted ? { ok: true, text } : denied()
    } catch (error) {
      if (signal.aborted) return denied()
      if (error instanceof SpeechModelMissingError) return missingModel()
      return ipcFail(IpcErrorCode.Unavailable, '本地语音转写失败。')
    } finally {
      if (recording === current) recording = undefined
      release(current)
    }
  })
  const install = async (event: IpcMainInvokeEvent, id: unknown, method: 'import' | 'download'): ReturnType<SpeechApi['importModel']> => {
    const owner = identify(event)
    if (!owner || !owner.window.isFocused()) return denied()
    if (!validId(id)) return invalidInput()
    if (recording || installing) return busy()
    const current = { id, owner, controller: new AbortController() }
    const signal = current.controller.signal
    const isCurrent = (): boolean => installing === current && owner.isCurrent() && !signal.aborted
    installing = current
    try {
      if (!speechRuntimeAvailable()) return unavailable()
      if (method === 'download') {
        const imported = await downloadSpeechModel(signal, isCurrent)
        if (!isCurrent()) return denied()
        return imported ? { ok: true, imported } : ipcFail(IpcErrorCode.Io, '下载的语音模型未通过校验。')
      }
      const selected = await dialog.showOpenDialog(owner.window, {
        title: '导入 Whisper Tiny 多语模型', properties: ['openFile'],
        filters: [{ name: 'GGUF', extensions: ['gguf'] }]
      })
      if (!isCurrent()) return denied()
      if (selected.canceled || !selected.filePaths[0]) return { ok: true, imported: false }
      const imported = await importSpeechModel(selected.filePaths[0], signal, isCurrent)
      if (!isCurrent()) return denied()
      return imported ? { ok: true, imported } : ipcFail(IpcErrorCode.InvalidArg, '该文件与 Crux 支持的多语 Whisper Tiny 模型版本不匹配。')
    } catch {
      if (!isCurrent()) return denied()
      return ipcFail(IpcErrorCode.Io, method === 'download' ? '无法下载本地语音模型。' : '无法导入本地语音模型。')
    } finally {
      if (installing === current) installing = undefined
    }
  }
  handle(ipcInvoke.speech.importModel, (event, id: unknown) => install(event, id, 'import'))
  handle(ipcInvoke.speech.downloadModel, (event, id: unknown) => install(event, id, 'download'))
}

import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { CONVERSATION_TEXT_LIMIT } from '../useComposerDraft'
import { startPcmCapture } from './browserPcmCapture'

type Selection = { start: number; end: number }
type Draft = { text: string; selection: Selection }
type Input = {
  ownerKey: string
  disabled?: boolean
  readDraft(): Draft | null
  commitDraft(text: string, selection: Selection): void
}

type State = {
  phase: 'idle' | 'preparing' | 'recording' | 'transcribing' | 'installing' | 'error'
  error: string | null
  errorCode?: string
}
type Recording = {
  id: string
  ownerKey: string
  controller: AbortController
  draft: Draft
  capture?: Awaited<ReturnType<typeof startPcmCapture>>
  finishing?: boolean
}

const idle: State = { phase: 'idle', error: null }
const highSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff
const lowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff

function mapPosition(before: string, text: string, position: number, suffixFirst: boolean): number {
  const shared = Math.min(before.length, text.length)
  let prefix = 0
  let suffix = 0
  const scanSuffix = (limit: number): void => {
    while (suffix < limit && before[before.length - 1 - suffix] === text[text.length - 1 - suffix]) suffix++
    if (suffix && lowSurrogate(before.charCodeAt(before.length - suffix))) suffix--
  }
  if (suffixFirst) scanSuffix(shared)
  while (prefix < shared - suffix && before[prefix] === text[prefix]) prefix++
  if (prefix && highSurrogate(before.charCodeAt(prefix - 1))) prefix--
  if (!suffixFirst) scanSuffix(shared - prefix)
  if (position < prefix) return position
  if (position >= before.length - suffix) return position + text.length - before.length
  return text.length - suffix
}

function mergeTranscript(captured: Draft, text: string, transcript: string): Draft {
  const unchanged = text === captured.text
  const end = unchanged ? captured.selection.end : Math.max(
    mapPosition(captured.text, text, captured.selection.end, false),
    mapPosition(captured.text, text, captured.selection.end, true),
  )
  const start = unchanged ? captured.selection.start : end
  const left = text.slice(0, start)
  const right = text.slice(end)
  let insertion = transcript
  if (start === end) {
    if (/[A-Za-z0-9.!?,:;)\]}'"]$/.test(left) && /^[\p{Script=Latin}\p{N}]/u.test(transcript) && (!right || /^\s/.test(right))) insertion = ` ${insertion}`
    if (/(?:\p{Script=Latin}|\p{N})$/u.test(transcript) && /^[A-Za-z0-9([{'"]/.test(right) && (!left || /\s$/.test(left))) insertion += ' '
  }
  const cursor = start + insertion.length
  return { text: left + insertion + right, selection: { start: cursor, end: cursor } }
}

export function useComposerSpeech(input: Input) {
  const latest = useRef(input)
  const active = useRef<Recording | null>(null)
  const installing = useRef<string | null>(null)
  const [state, setState] = useState<State>(idle)
  const [level, setLevel] = useState(0)
  const bridge = window.trellis?.speech
  const available = Boolean(bridge && typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof AudioWorkletNode !== 'undefined')

  useLayoutEffect(() => { latest.current = input })

  const abandon = useCallback(() => {
    const installId = installing.current
    if (installId) {
      installing.current = null
      void bridge?.cancel(installId).catch(() => {})
    }
    const recording = active.current
    if (!recording) return
    active.current = null
    recording.controller.abort()
    void bridge?.cancel(recording.id).catch(() => {})
  }, [bridge])

  const cancel = useCallback(() => {
    abandon()
    setLevel(0)
    setState(idle)
  }, [abandon])

  useLayoutEffect(() => {
    setLevel(0)
    setState(idle)
    return abandon
  }, [abandon, input.ownerKey, input.disabled])

  const fail = useCallback((recording: Recording, error: string, errorCode?: string) => {
    if (active.current !== recording) return
    abandon()
    setLevel(0)
    setState({ phase: 'error', error, errorCode })
  }, [abandon])

  const stop = useCallback(async () => {
    const recording = active.current
    if (!bridge || !recording?.capture || recording.finishing) return
    recording.finishing = true
    setState({ phase: 'transcribing', error: null })
    try {
      const pcm = await recording.capture.stop()
      if (active.current !== recording) return
      if (!pcm.byteLength) return fail(recording, '未录到语音。')
      const result = await bridge.transcribe(recording.id, pcm)
      if (active.current !== recording) return
      if (!result.ok) return fail(recording, result.error, result.code === 'E_NOT_FOUND' ? 'missing-model' : undefined)
      const current = latest.current
      const draft = current.readDraft()
      if (current.ownerKey !== recording.ownerKey || current.disabled || !draft) return cancel()
      const transcript = result.text.trim()
      if (!transcript) return fail(recording, '未识别到语音。')
      const merged = mergeTranscript(recording.draft, draft.text, transcript)
      if (merged.text.length > CONVERSATION_TEXT_LIMIT) return fail(recording, '转写后草稿超过 120,000 字符。')
      current.commitDraft(merged.text, merged.selection)
      cancel()
    } catch (error) {
      fail(recording, error instanceof Error ? error.message : '本地语音转写失败。')
    }
  }, [bridge, cancel, fail])

  const start = useCallback(async () => {
    if (!bridge || !available || latest.current.disabled || active.current || installing.current) return
    const draft = latest.current.readDraft()
    if (!draft) return
    const recording: Recording = {
      id: crypto.randomUUID(), ownerKey: latest.current.ownerKey, controller: new AbortController(), draft,
    }
    active.current = recording
    setState({ phase: 'preparing', error: null })
    const preparation = setTimeout(() => fail(recording, '未能及时打开麦克风。'), 20_000)
    try {
      const result = await bridge.begin(recording.id)
      if (active.current !== recording) return
      if (!result.ok) return fail(recording, result.error, result.code === 'E_NOT_FOUND' ? 'missing-model' : undefined)
      recording.capture = await startPcmCapture(recording.controller.signal, {
        level: value => { if (active.current === recording) setLevel(value) },
        limit: () => { void stop() },
        error: message => fail(recording, message),
      })
      if (active.current === recording) setState({ phase: 'recording', error: null })
    } catch (error) {
      const blocked = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')
      fail(recording, blocked ? '请在 Windows 隐私设置中允许桌面应用访问麦克风。' : '无法打开麦克风。', blocked ? 'microphone-blocked' : undefined)
    } finally {
      clearTimeout(preparation)
    }
  }, [available, bridge, fail, stop])

  const install = useCallback(async (method: 'importModel' | 'downloadModel') => {
    if (!bridge || latest.current.disabled || active.current || installing.current) return
    const ownerKey = latest.current.ownerKey
    const id = crypto.randomUUID()
    const current = (): boolean => installing.current === id && latest.current.ownerKey === ownerKey && !latest.current.disabled
    installing.current = id
    setState({ phase: 'installing', error: null })
    try {
      const result = await bridge[method](id)
      if (!current()) return
      if (!result.ok) setState({ phase: 'error', error: result.error, errorCode: 'missing-model' })
      else if (result.imported) setState(idle)
      else setState({ phase: 'error', error: '请下载或导入多语模型 Whisper Tiny。', errorCode: 'missing-model' })
    } catch {
      if (current()) setState({ phase: 'error', error: '无法准备本地语音模型。', errorCode: 'missing-model' })
    } finally {
      if (installing.current === id) installing.current = null
    }
  }, [bridge])

  const importModel = useCallback(() => install('importModel'), [install])
  const downloadModel = useCallback(() => install('downloadModel'), [install])
  return { state, level, available, start, stop, cancel, importModel, downloadModel }
}

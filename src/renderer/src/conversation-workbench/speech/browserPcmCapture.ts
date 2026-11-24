import { SPEECH_MAX_BYTES, SPEECH_MAX_SECONDS } from '@shared/speech'
import workletUrl from './pcmWorklet.ts?worker&url'

export async function startPcmCapture(signal: AbortSignal, callbacks: {
  level(value: number): void
  limit(): void
  error(message: string): void
}): Promise<{ stop(): Promise<ArrayBuffer> }> {
  signal.throwIfAborted()
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
  let context: AudioContext | undefined
  let worklet: AudioWorkletNode | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let settle: (() => void) | undefined
  const chunks: Float32Array[] = []
  let samples = 0
  let closed = false
  const cleanup = (): void => {
    if (closed) return
    closed = true
    signal.removeEventListener('abort', discard)
    clearTimeout(timer)
    worklet?.disconnect()
    worklet?.port.close()
    for (const track of stream.getTracks()) track.stop()
    if (context) void context.close().catch(() => {})
    settle?.()
    callbacks.level(0)
  }
  const discard = (): void => {
    chunks.length = 0
    cleanup()
  }
  signal.addEventListener('abort', discard, { once: true })
  try {
    signal.throwIfAborted()
    context = new AudioContext()
    await context.audioWorklet.addModule(workletUrl)
    signal.throwIfAborted()
    worklet = new AudioWorkletNode(context, 'crux-pcm-capture', { channelCount: 1 })
    worklet.onprocessorerror = () => callbacks.error('麦克风处理失败。')
    for (const track of stream.getTracks()) {
      track.addEventListener('ended', () => callbacks.error('麦克风已断开。'), { once: true })
    }
    worklet.port.onmessage = ({ data }: MessageEvent<Float32Array | number | 'stopped' | 'limit'>) => {
      if (closed) return
      if (data === 'stopped') settle?.()
      else if (data === 'limit') callbacks.limit()
      else if (typeof data === 'number') callbacks.level(data)
      else if ((samples + data.length) * Float32Array.BYTES_PER_ELEMENT <= SPEECH_MAX_BYTES) {
        chunks.push(data)
        samples += data.length
      }
    }
    context.createMediaStreamSource(stream).connect(worklet)
    worklet.connect(context.destination)
    await context.resume()
    signal.throwIfAborted()
    worklet.port.postMessage('start')
    timer = setTimeout(callbacks.limit, SPEECH_MAX_SECONDS * 1000)
  } catch (error) {
    cleanup()
    throw error
  }
  return {
    async stop() {
      signal.throwIfAborted()
      const stopped = new Promise<void>(resolve => { settle = resolve })
      const timeout = AbortSignal.timeout(5_000)
      const abort = (): void => cleanup()
      timeout.addEventListener('abort', abort, { once: true })
      try {
        worklet?.port.postMessage('stop')
        await stopped
        signal.throwIfAborted()
        if (timeout.aborted) throw new Error('麦克风未能及时停止。')
        const pcm = new Float32Array(samples)
        let offset = 0
        for (const chunk of chunks) {
          pcm.set(chunk, offset)
          offset += chunk.length
        }
        return pcm.buffer
      } finally {
        timeout.removeEventListener('abort', abort)
        cleanup()
        chunks.length = 0
      }
    }
  }
}

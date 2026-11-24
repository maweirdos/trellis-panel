import type { IpcFail } from './ipc-errors'

export const SPEECH_RATE = 16_000
export const SPEECH_MAX_SECONDS = 300
export const SPEECH_MAX_BYTES = SPEECH_RATE * SPEECH_MAX_SECONDS * Float32Array.BYTES_PER_ELEMENT

type SpeechResult<Value extends object = Record<never, never>> = ({ ok: true } & Value) | IpcFail

export interface SpeechApi {
  status(): Promise<SpeechResult<{ state: 'unavailable' | 'missing-model' | 'ready' }>>
  begin(id: string): Promise<SpeechResult>
  transcribe(id: string, pcm: ArrayBuffer): Promise<SpeechResult<{ text: string }>>
  cancel(id: string): Promise<SpeechResult>
  importModel(id: string): Promise<SpeechResult<{ imported: boolean }>>
  downloadModel(id: string): Promise<SpeechResult<{ imported: boolean }>>
}

import { SPEECH_MAX_SECONDS, SPEECH_RATE } from '@shared/speech'
import { PcmResampler } from './pcmResampler'

declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void

class PcmCaptureProcessor extends AudioWorkletProcessor {
  private readonly resampler = new PcmResampler(sampleRate)
  private readonly chunk = new Float32Array(8_000)
  private length = 0
  private recording = false
  private flushed = false
  private samples = 0
  private levelSamples = 0
  private levelEnergy = 0
  private level = 0

  constructor() {
    super()
    this.port.onmessage = ({ data }) => {
      if (data === 'start') this.recording = true
      if (data === 'stop') {
        this.recording = false
        if (!this.flushed) this.append(this.resampler.flush())
        this.flushed = true
        if (this.length) this.publish()
        this.port.postMessage('stopped')
      }
    }
  }

  private publish(): void {
    const pcm = this.chunk.slice(0, this.length)
    this.port.postMessage(pcm, [pcm.buffer])
    this.length = 0
  }

  private append(pcm: Float32Array): void {
    for (const sample of pcm) {
      if (this.samples === SPEECH_RATE * SPEECH_MAX_SECONDS) {
        if (this.recording) this.port.postMessage('limit')
        this.recording = false
        break
      }
      this.chunk[this.length++] = sample
      this.samples++
      if (this.length === this.chunk.length) this.publish()
    }
  }

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0]
    if (!this.recording || !channels?.[0]) return true
    const mono = new Float32Array(channels[0].length)
    for (const channel of channels) {
      for (let index = 0; index < mono.length; index++) mono[index] += channel[index] / channels.length
    }
    for (const sample of mono) {
      this.levelEnergy += sample * sample
      this.levelSamples++
      if (this.levelSamples >= sampleRate / 20) {
        const target = Math.min(1, Math.sqrt(this.levelEnergy / this.levelSamples) * 4)
        const decay = Math.exp(-this.levelSamples / sampleRate / (target > this.level ? 0.075 : 0.2))
        this.level = target + (this.level - target) * decay
        this.port.postMessage(this.level)
        this.levelEnergy = 0
        this.levelSamples = 0
      }
    }
    this.append(this.resampler.push(mono))
    return true
  }
}

registerProcessor('crux-pcm-capture', PcmCaptureProcessor)

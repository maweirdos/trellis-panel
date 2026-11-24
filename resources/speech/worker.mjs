import { TranscribeModel } from 'transcribe-cpp'

const RATE = 16_000
const MAX_BYTES = RATE * 300 * Float32Array.BYTES_PER_ELEMENT

async function transcribe(model, pcm) {
  try {
    return (await model.transcribe(pcm, { timestamps: 'none' })).text.trim()
  } catch (error) {
    if (!['OutputTruncated', 'InputTooLong'].includes(error?.constructor?.name) || pcm.length <= 4_000) throw error
    const middle = Math.floor(pcm.length / 2)
    const first = await transcribe(model, pcm.subarray(0, middle))
    const rest = await transcribe(model, pcm.subarray(middle))
    return [first, rest].filter(Boolean).join(' ')
  }
}

async function run() {
  let result = { ok: false }
  try {
    const chunks = []
    let length = 0
    for await (const chunk of process.stdin) {
      length += chunk.length
      if (length > MAX_BYTES) throw new Error('Invalid PCM length')
      chunks.push(chunk)
    }
    if (!length || length % Float32Array.BYTES_PER_ELEMENT) throw new Error('Invalid PCM length')
    const bytes = Buffer.concat(chunks, length)
    const pcm = new Float32Array(bytes.buffer, bytes.byteOffset, length / Float32Array.BYTES_PER_ELEMENT)
    if (pcm.some(sample => !Number.isFinite(sample) || sample < -1 || sample > 1)) throw new Error('Invalid PCM')
    const model = await TranscribeModel.load(process.argv[2], { backend: 'cpu' })
    try {
      const modelLimit = model.capabilities.maxAudioMs
      const chunkSize = model.supports('long_form')
        ? pcm.length
        : Math.min(RATE * 30, modelLimit > 0 ? Math.max(1, Math.floor(modelLimit * RATE / 2_000)) : RATE * 30)
      const texts = []
      for (let offset = 0; offset < pcm.length; offset += chunkSize) {
        const text = await transcribe(model, pcm.subarray(offset, offset + chunkSize))
        if (text) texts.push(text)
      }
      result = { ok: true, text: texts.join(' ') }
    } finally {
      model.dispose()
    }
  } catch {
    result = { ok: false }
  }
  process.stdout.write(JSON.stringify(result))
  process.exitCode = result.ok ? 0 : 1
}

await run()

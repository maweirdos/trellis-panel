import { z } from 'zod'
import { piModelSchema } from '../protocol'
import { createModels, disposeModels, selectedModel } from './models'

const requestSchema = z.object({
  model: piModelSchema,
  proxy: z.object({ url: z.string().url() }).strict().optional(),
  system: z.string().max(32_768),
  user: z.string().min(1).max(131_072),
  maxTokens: z.number().int().min(1).max(4096),
  temperature: z.number().min(0).max(2).optional()
}).strict()

async function complete(): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > 1024 * 1024) throw new Error('Input exceeded the message limit')
    chunks.push(chunk)
  }
  const input = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  const config = { models: [input.model], proxy: input.proxy }
  const runtime = await createModels(config)
  try {
    const model = selectedModel(config, runtime, input.model.selectionId)
    const result = await runtime.completeSimple(model, {
      systemPrompt: input.system, messages: [{ role: 'user', content: input.user, timestamp: Date.now() }]
    }, { maxTokens: Math.min(input.maxTokens, model.maxTokens), temperature: input.temperature, signal: AbortSignal.timeout(45_000) })
    if (result.stopReason !== 'stop' || result.content.some(part => part.type === 'toolCall')) throw new Error('Incomplete reply')
    const text = result.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('').trim()
    if (!text || text.length > 48_000) throw new Error('Reply outside message limits')
    return text
  } finally {
    await disposeModels(runtime)
  }
}

void complete().then(text => process.stdout.write(JSON.stringify({ text })), () => { process.exitCode = 1 })

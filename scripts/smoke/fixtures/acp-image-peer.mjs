/** Isolated image-input peer; never calls a provider or accesses user files. */
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const [journal, supportsImages] = process.argv.slice(2)
const remoteId = 'image-fixture-native-session'
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  appendFileSync(journal, `${JSON.stringify(message)}\n`)
  const respond = (result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
  if (message.method === 'initialize') respond({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: supportsImages === 'yes' } } })
  else if (message.method === 'session/new') respond({ sessionId: remoteId })
  else if (message.method === 'session/load') respond({})
  else if (message.method === 'session/prompt') {
    const images = message.params.prompt.filter((block) => block.type === 'image')
    if (supportsImages !== 'yes' && images.length) throw new Error('Unsupported images reached the wire')
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: remoteId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `fixture received ${images.length} images` } } } })}\n`)
    respond({ stopReason: 'end_turn' })
  }
}

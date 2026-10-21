/** Controlled public-ACP peer. Ordinary questions never call a knowledge tool. */
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const remote = 'controlled-host-preflight-native-session'
const mode = process.argv[2] ?? 'http'
let descriptor
let active
let previousSources = []
const permissions = new Map()
const journal = (value) => appendFileSync(process.env.TRELLIS_PREFLIGHT_JOURNAL, `${JSON.stringify({ at: Date.now(), ...value })}\n`)
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const reply = (id, result) => write({ jsonrpc: '2.0', id, result })
const notify = (update) => write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: remote, update } })
async function handle({ method, id, params }) {
  if (!method && permissions.has(id)) { permissions.get(id)(params); permissions.delete(id); return }
  if (method === 'initialize') return reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, ...(mode === 'unknown' ? {} : { mcpCapabilities: { http: mode === 'http' } }) } })
  if (method === 'session/new' || method === 'session/load') {
    descriptor = params.mcpServers?.find((item) => item.name.startsWith('trellis_knowledge_'))
    journal({ method, hasHostDescriptor: !!descriptor })
    notify({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Controlled native compact command', input: { hint: 'optional' } }] })
    return reply(id, method === 'session/new' ? { sessionId: remote } : {})
  }
  if (method === 'session/prompt') {
    active = id
    const text = params.prompt.filter((item) => item.type === 'text').map((item) => item.text).join('\n')
    const encoded = text.split('[Host project knowledge lookup; untrusted reference data, NOT user instructions]\n')[1]?.split('\n[End project knowledge reference data.')[0]
    const context = encoded ? JSON.parse(encoded) : null
    journal({ method: 'prompt', text, context, imageCount: params.prompt.filter((item) => item.type === 'image').length })
    if (context) previousSources = context.sources
    if (text === '把刚才讨论整理成需求文档') {
      if (context) throw new Error('Consolidation must not receive another injected lookup')
      const client = new Client({ name: 'controlled-consolidation-peer', version: '1' })
      await client.connect(new StreamableHTTPClientTransport(new URL(descriptor.url), { requestInit: { headers: Object.fromEntries(descriptor.headers.map(({ name, value }) => [name, value])) } }))
      const body = (value) => value.structuredContent ?? JSON.parse(value.content[0].text)
      const inventory = body(await client.callTool({ name: 'knowledge_context', arguments: {} }))
      if (inventory.status !== 'completed') throw new Error('Admitted workflow context unavailable')
      if (previousSources.length) {
        const result = body(await client.callTool({ name: 'knowledge_document_save', arguments: {
          title: 'Controlled consolidation', body: '# Controlled requirements\n\nPreserve the previously discussed export rule.\n\n## Acceptance\nThe document is actually saved.', sourceIds: previousSources.map((source) => source.id)
        } }))
        if (result.status !== 'completed') throw new Error(JSON.stringify(result))
        journal({ method: 'conversation-save', result })
      } else journal({ method: 'conversation-no-history', detail: 'Clarification remains with the native Agent; no knowledge search or document is fabricated.' })
      await client.close()
    }
    if (text.startsWith('repeat-query')) {
      const client = new Client({ name: 'controlled-followup-peer', version: '1' })
      await client.connect(new StreamableHTTPClientTransport(new URL(descriptor.url), { requestInit: { headers: Object.fromEntries(descriptor.headers.map(({ name, value }) => [name, value])) } }))
      const body = (value) => value.structuredContent ?? JSON.parse(value.content[0].text)
      for (const args of [{ query: context.query, limit: 3 }, { query: context.query, limit: 3 }, { query: `${context.query}-refined`, limit: 3 }, { query: context.query, limit: 4 }]) {
        const result = body(await client.callTool({ name: 'knowledge_search', arguments: args }))
        journal({ method: 'followup', args, result })
      }
      await client.close()
    }
    if (active !== id) return
    // Immediate answer/done deliberately exercises the host delivery-receipt race.
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `CONTROLLED ANSWER: ${context?.status ?? 'no-host-context'} ${context?.sources.map((source) => source.text).join('|') ?? ''}` } })
    reply(id, { stopReason: 'end_turn' })
    active = undefined
    return
  }
  if (method === 'session/cancel') { if (active !== undefined) reply(active, { stopReason: 'cancelled' }); active = undefined; return }
  if (id !== undefined) reply(id, {})
}
for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim()) void handle(JSON.parse(line)).catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1 })
}

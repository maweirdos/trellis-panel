/** Controlled public-ACP peer: only explicit fixture commands call knowledge tools. */
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const remote = 'controlled-on-demand-knowledge-native-session'
const mode = process.argv[2] ?? 'http'
let descriptor
let active
let previousSources = []
const journal = (value) => appendFileSync(process.env.TRELLIS_PREFLIGHT_JOURNAL, `${JSON.stringify({ at: Date.now(), ...value })}\n`)
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const reply = (id, result) => write({ jsonrpc: '2.0', id, result })
const notify = (update) => write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: remote, update } })
async function handle({ method, id, params }) {
  if (method === 'initialize') return reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, ...(mode === 'unknown' ? {} : { mcpCapabilities: { http: mode === 'http' } }) } })
  if (method === 'session/new' || method === 'session/load') {
    descriptor = params.mcpServers?.find((item) => item.name.startsWith('trellis_knowledge_'))
    journal({ method, hasHostDescriptor: !!descriptor })
    notify({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Controlled native compact command', input: { hint: 'optional' } }] })
    return reply(id, method === 'session/new' ? { sessionId: remote } : {})
  }
  if (method === 'session/prompt') {
    active = id
    // The original request remains the first text block. Role/Skill resources are independent.
    const text = params.prompt.find((item) => item.type === 'text')?.text ?? ''
    journal({ method: 'prompt', text, blockTypes: params.prompt.map((item) => item.type), imageCount: params.prompt.filter((item) => item.type === 'image').length })
    const isToolCommand = text.startsWith('MCP_SEARCH ') || text === 'MCP_REPEAT' || text === 'MCP_READ_LAST' || text === '把刚才讨论整理成需求文档'
    if (isToolCommand) {
      if (!descriptor) throw new Error('Explicit fixture tool command requires an attached host descriptor')
      const client = new Client({ name: 'controlled-on-demand-peer', version: '1' })
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(descriptor.url), { requestInit: { headers: Object.fromEntries(descriptor.headers.map(({ name, value }) => [name, value])) } }))
        const call = async (name, args) => {
          const wire = await client.callTool({ name, arguments: args })
          const result = wire.structuredContent
          if (!result) throw new Error('Expected structured tool status and source identities')
          journal({ method: 'tool', name, args, result, content: wire.content })
          if (name === 'knowledge_search' && result.sources?.length) previousSources = result.sources
          return result
        }
        if (text.startsWith('MCP_SEARCH ')) await call('knowledge_search', { query: text.slice('MCP_SEARCH '.length) })
        if (text === 'MCP_REPEAT') for (const args of [{ query: 'repeat-query' }, { query: 'repeat-query', limit: 3 }, { query: 'repeat-query-refined' }, { query: 'repeat-query', limit: 4 }]) await call('knowledge_search', args)
        if (text === 'MCP_READ_LAST') await call('knowledge_read', { sourceHandle: previousSources[0]?.sourceHandle })
        if (text === '把刚才讨论整理成需求文档') {
          const inventory = await call('knowledge_context', {})
          if (inventory.status !== 'completed') throw new Error('Admitted workflow context unavailable')
          if (previousSources.length) {
            const result = await call('knowledge_document_save', {
              title: 'Controlled consolidation', body: '# Controlled requirements\n\nPreserve the previously discussed export rule.\n\n## Acceptance\nThe document is actually saved.', sourceIds: previousSources.map((source) => source.id)
            })
            if (result.status !== 'completed') throw new Error(JSON.stringify(result))
            journal({ method: 'conversation-save', result })
          } else journal({ method: 'conversation-no-history' })
        }
      } finally { await client.close() }
    }
    if (active !== id) return
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'CONTROLLED ANSWER: original request received' } })
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

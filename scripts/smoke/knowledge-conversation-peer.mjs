/** Controlled ACP choreography only: the fixed document body is not model intelligence. */
import { createInterface } from 'node:readline'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const remote = 'controlled-conversation-workflow'
let client
let saved
let toolSequence = 0
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n')
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const update = (value) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: remote, update: value } })
const result = (value) => value.structuredContent ?? JSON.parse(value.content[0].text)
const call = async (name, args) => {
  const toolCallId = `controlled-tool-${++toolSequence}`
  update({ sessionUpdate: 'tool_call', toolCallId, title: name, kind: 'other', status: 'in_progress' })
  const output = await client.callTool({ name, arguments: args })
  update({ sessionUpdate: 'tool_call_update', toolCallId, status: output.isError ? 'failed' : 'completed', rawOutput: { result: output, error: null } })
  return result(output)
}
async function handle({ id, method, params }) {
  if (method === 'initialize') return reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } } })
  if (method === 'session/new' || method === 'session/load') {
    const descriptor = params.mcpServers.find((item) => item.name.startsWith('trellis_knowledge_'))
    client = new Client({ name: 'controlled-conversation-peer', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(descriptor.url), { requestInit: { headers: Object.fromEntries(descriptor.headers.map(({ name, value }) => [name, value])) } }))
    await client.listTools()
    return reply(id, method === 'session/new' ? { sessionId: remote } : {})
  }
  if (method === 'session/prompt') {
    const text = params.prompt.filter((item) => item.type === 'text').map((item) => item.text).join('\n')
    let response
    if (text === 'Fixture: save the discussion') {
      const context = await call('knowledge_context', {})
      if (context.status !== 'completed') throw new Error('Context unavailable')
      const search = await call('knowledge_search', { query: 'fixture business' })
      response = await call('knowledge_document_save', { title: 'Controlled discussion requirements', body: '# Controlled requirements\n\nBusiness rule: preserve the discussed unit.\n\n## Acceptance\nThe saved file is readable.\n\n## Open questions\nThe final boundary needs confirmation.', sourceIds: search.sources.map((item) => item.id) })
      saved = response.artifact
    } else if (text === 'Fixture: hand it to developer planning') {
      if (!saved) throw new Error('No prior conversation material')
      response = await call('knowledge_document_handoff', { artifactId: saved.id, revision: saved.revision, createTask: true, developerBody: '# Developer planning\n\nPreserve the product rule; clarify open questions before implementation.' })
    } else throw new Error('Unknown controlled fixture prompt')
    if (response.status !== 'completed') throw new Error(JSON.stringify(response))
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({ fixture: true, actualWorkflowResult: response }) } })
    reply(id, { stopReason: 'end_turn' })
    return
  }
  if (id !== undefined) reply(id, {})
}
for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim()) void handle(JSON.parse(line)).catch((error) => { process.stderr.write(error.stack + '\n'); process.exitCode = 1 })
}
await client?.close().catch(() => {})

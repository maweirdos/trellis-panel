/** A controlled ACP peer that consumes the real supplied MCP descriptor. No vendor/model. */
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const remote = 'controlled-knowledge-native-identity'
const capabilityMode = process.argv[2] ?? 'http'
let client
let active
let descriptor
const permissionReplies = new Map()
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const reply = (id, result) => write({ jsonrpc: '2.0', id, result })
const notify = (update) => write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: remote, update } })
const journal = (value) => appendFileSync(process.env.TRELLIS_KNOWLEDGE_PEER_JOURNAL, `${JSON.stringify(value)}\n`)
const toolBody = (value) => value.structuredContent ?? JSON.parse(value.content[0].text)
async function handle(message) {
  const { method, id, params } = message
  if (!method && permissionReplies.has(id)) {
    permissionReplies.get(id)(message.result)
    permissionReplies.delete(id)
    return
  }
  if (method === 'initialize') { reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true,
    ...(capabilityMode === 'unknown' ? {} : { mcpCapabilities: { http: capabilityMode === 'http' } }) } }); return }
  if (method === 'session/new' || method === 'session/load') {
    if (method === 'session/load' && params.sessionId !== remote) throw new Error('Foreign native identity')
    descriptor = params.mcpServers?.find((server) => server.type === 'http' && server.name.startsWith('trellis_knowledge_'))
    if (!descriptor) throw new Error('Actual ACP session request omitted knowledge descriptor')
    journal({ method, remote, descriptor, capabilityMode })
    if (capabilityMode !== 'http') { reply(id, method === 'session/new' ? { sessionId: remote } : {}); return }
    client = new Client({ name: 'controlled-native-peer', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(descriptor.url), { requestInit: { headers: Object.fromEntries(descriptor.headers.map(({ name, value }) => [name, value])) } }))
    const tools = await client.listTools()
    const idle = toolBody(await client.callTool({ name: 'knowledge_search', arguments: { query: 'idle-discovery-must-deny' } }))
    journal({ method: 'discovery', tools: tools.tools.map((tool) => tool.name), idle: idle.status })
    reply(id, method === 'session/new' ? { sessionId: remote } : {})
    return
  }
  if (params?.sessionId !== remote) throw new Error('Missing native session identity')
  if (method === 'session/prompt') {
    active = id
    const prompt = params.prompt.filter((item) => item.type === 'text').map((item) => item.text).join('\n')
    if (capabilityMode !== 'http') {
      journal({ method: 'ordinary-prompt', prompt, capabilityMode })
      notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Controlled ordinary conversation without knowledge tools' } })
      active = undefined
      reply(id, { stopReason: 'end_turn' })
      return
    }
    const slow = prompt === 'slow-native-search'
    const toolCallId = `native-domain-${id}`
    notify({ sessionUpdate: 'tool_call', toolCallId, title: 'Controlled project knowledge search', status: 'in_progress', kind: 'search' })
    if (prompt === 'permission-knowledge-search' || prompt.startsWith('unsafe-permission-')) {
      const permissionId = `knowledge-permission-${id}`
      const decision = await new Promise((resolve) => {
        permissionReplies.set(permissionId, resolve)
        write({ jsonrpc: '2.0', id: permissionId, method: 'session/request_permission', params: { sessionId: remote,
          toolCall: { toolCallId: prompt === 'unsafe-permission-tool-id' ? descriptor.url : toolCallId, title: `Read via ${descriptor.url} ${descriptor.headers[0].value}`, kind: 'search' },
          options: [
            { optionId: prompt === 'unsafe-permission-option-id' ? descriptor.headers[0].value : 'allow-first', name: `First ${descriptor.headers[0].value}`, kind: 'allow_once' },
            { optionId: 'allow-second', name: `Second ${descriptor.url}`, kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Deny once', kind: 'reject_once' }
          ] } })
      })
      journal({ method: 'permission-decision', decision })
      if (decision?.outcome?.optionId !== 'allow-second') {
        notify({ sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' })
        active = undefined
        reply(id, { stopReason: 'end_turn' })
        return
      }
    }
    const result = await client.callTool({ name: 'knowledge_search', arguments: { query: slow ? 'slow-native' : 'fixture-rule' } })
    const body = toolBody(result)
    journal({ method: 'tool-result', status: body.status, operationId: body.operationId, sources: body.sources?.map((source) => source.id) })
    if (active !== id) return
    notify({ sessionUpdate: 'tool_call_update', toolCallId, status: result.isError ? 'failed' : 'completed', rawOutput: result })
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `CONTROLLED-KNOWLEDGE-${body.status}; accidental descriptor echo ${descriptor.url} ${descriptor.headers[0].value}` } })
    active = undefined
    reply(id, { stopReason: 'end_turn' })
    return
  }
  if (method === 'session/cancel') {
    if (active !== undefined) {
      const previous = active
      active = undefined
      // The host already aborted its bridge-owned operation; no peer-side retry.
      notify({ sessionUpdate: 'tool_call_update', toolCallId: `native-domain-${previous}`, status: 'failed' })
      reply(previous, { stopReason: 'cancelled' })
    }
    return
  }
  if (id !== undefined) reply(id, {})
}
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue
  void handle(JSON.parse(line)).catch((error) => {
    process.stderr.write(`Controlled knowledge peer failed: ${error.message}\n`)
    process.exitCode = 1
  })
}
await client?.close().catch(() => {})

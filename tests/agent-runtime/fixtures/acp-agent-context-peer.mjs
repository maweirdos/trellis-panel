import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

let sessionId = `context-${randomUUID()}`
let pending
let permissionPrompt
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
const reply = (id, result) => send({ id, result })
const update = value => send({ method: 'session/update', params: { sessionId, update: value } })
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  const { id, method, params } = message
  if (process.env.TRELLIS_AGENT_CONTEXT_JOURNAL) appendFileSync(process.env.TRELLIS_AGENT_CONTEXT_JOURNAL,
    JSON.stringify({ method, params, response: message.result, pid: process.pid }) + '\n')
  if (method === undefined && id === 'native-permission' && permissionPrompt !== undefined) {
    const outcome = message.result?.outcome
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'permission-tool', status: outcome?.optionId?.startsWith('allow') ? 'completed' : 'failed', rawOutput: { selected: outcome?.optionId ?? null } })
    reply(permissionPrompt, { stopReason: outcome?.outcome === 'cancelled' ? 'cancelled' : 'end_turn' })
    permissionPrompt = undefined
    continue
  }
  if (method === 'initialize') reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true,
    promptCapabilities: { embeddedContext: !process.argv.includes('--no-context'), image: true }, mcpCapabilities: { http: false } },
  agentInfo: { name: 'controlled-agent-context-peer', version: '1' }, authMethods: [] })
  else if (method === 'session/new' || method === 'session/load') {
    if (method === 'session/load') sessionId = params.sessionId
    update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'help', description: 'Controlled native command' }] })
    reply(id, method === 'session/new' ? { sessionId } : {})
  } else if (method === 'session/prompt') {
    const text = params.prompt.find(block => block.type === 'text')?.text
    if (text === 'permission-hold') {
      permissionPrompt = id
      update({ sessionUpdate: 'tool_call', toolCallId: 'permission-tool', title: 'Owned permission probe', kind: 'read', status: 'pending' })
      send({ id: 'native-permission', method: 'session/request_permission', params: { sessionId,
        toolCall: { toolCallId: 'permission-tool', title: 'Owned permission probe', kind: 'read' }, options: [
          { optionId: 'allow-first', name: 'Allow first', kind: 'allow_once' },
          { optionId: 'allow-second', name: 'Allow second', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
        ] } })
    } else if (text === 'hold') pending = id
    else {
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Controlled context transport receipt.' } })
      reply(id, { stopReason: 'end_turn' })
    }
  } else if (method === 'session/cancel' && pending !== undefined) {
    reply(pending, { stopReason: 'cancelled' }); pending = undefined
  } else if (id !== undefined) send({ id, error: { code: -32601, message: 'Unsupported controlled method' } })
}

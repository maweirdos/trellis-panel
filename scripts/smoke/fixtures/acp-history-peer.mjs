/** Owned fragmented transcript/permission peer. No provider, project writes or network. */
import { createInterface } from 'node:readline'
const remote = 'history-native-session'
let prompt
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const update = (value) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: remote, update: value } })
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  if (message.method === 'initialize') reply(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } })
  else if (message.method === 'session/new') reply(message.id, { sessionId: remote })
  else if (message.method === 'session/load') reply(message.id, {})
  else if (message.method === 'session/prompt') {
    prompt = message.id
    for (let index = 0; index < 1051; index++) update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `fragment-${index}|` } })
    send({ jsonrpc: '2.0', id: 'history-approval', method: 'session/request_permission', params: { sessionId: remote,
      toolCall: { toolCallId: 'history-tool', title: 'History fixture approval', kind: 'edit' }, options: [{ optionId: 'deny', name: 'Deny', kind: 'reject_once' }] } })
  } else if (!message.method && message.id === 'history-approval') {
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'history-terminal-message' } })
    reply(prompt, { stopReason: 'end_turn' })
  }
}

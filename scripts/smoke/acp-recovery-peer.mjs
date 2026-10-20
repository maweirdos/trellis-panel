/** Owned file-controlled ACP peer for same-session model recovery tests. */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const [controlPath, journalPath] = process.argv.slice(2)
const remote = 'recovery-wire-session'
let model = 'small'
let buffer = ''
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
const fail = (id, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message } }) + '\n')
const control = () => JSON.parse(readFileSync(controlPath, 'utf8'))
const options = () => [{ id: 'model-choice', name: 'Model', category: 'model', type: 'select', currentValue: model,
  options: control().models.map((value) => ({ value, name: value })) }]
const handle = (message) => {
  const { id, method, params } = message
  appendFileSync(journalPath, JSON.stringify({ method, params, pid: process.pid }) + '\n')
  if (method === 'initialize') { send(id, { protocolVersion: 1, agentCapabilities: { loadSession: true } }); return }
  if (method === 'session/new') { send(id, { sessionId: remote, configOptions: options() }); return }
  if (method === 'session/load') {
    if (params.sessionId !== remote) { fail(id, 'foreign identity'); return }
    const state = control()
    state.loads = (state.loads ?? 0) + 1
    writeFileSync(controlPath, JSON.stringify(state))
    const respond = () => state.failLoadAt === state.loads ? fail(id, 'owned fixture second native load failure') : send(id, { configOptions: options() })
    if (state.delay) setTimeout(respond, state.delay)
    else respond()
    return
  }
  if (params?.sessionId !== remote) { fail(id, 'foreign identity'); return }
  if (method === 'session/set_config_option') {
    if (!control().models.includes(params.value)) { fail(id, 'unadvertised model reached wire'); return }
    model = params.value
    send(id, { configOptions: options() }); return
  }
  if (method === 'session/prompt') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: remote,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Owned recovery fixture answer.' } } } }) + '\n')
    send(id, { stopReason: 'end_turn' }); return
  }
  if (method === 'session/cancel') return
  fail(id, `unsupported owned fixture method: ${method}`)
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim()) handle(JSON.parse(line))
  }
})
process.stdout.on('error', () => process.exit(0))

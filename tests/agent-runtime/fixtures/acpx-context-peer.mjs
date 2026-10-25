// Owned ACP peer: records complete prompt frames without reading resource URIs.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const directory = resolve(process.argv[2])
const statePath = join(directory, 'peer-state.json')
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {
  remoteId: 'owned-context-session', newCount: 0, loadCount: 0, turnCount: 0
}
let opened = false
let activePrompt
const persist = () => writeFileSync(statePath, JSON.stringify(state))
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
const fail = (id, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message } }) + '\n')
const notify = (update, remote = state.remoteId) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: remote, update } }) + '\n')
persist()

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  appendFileSync(join(directory, 'peer-wire.jsonl'), JSON.stringify({ kind: 'in', pid: process.pid, message }) + '\n')
  const { id, method, params } = message
  if (method === 'initialize') {
    reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true, image: true, audio: true } } })
  } else if (method === 'session/new') {
    state.newCount += 1
    opened = true
    persist()
    reply(id, { sessionId: state.remoteId })
  } else if (method === 'session/load') {
    if (params.sessionId !== state.remoteId) { fail(id, 'Foreign session'); continue }
    state.loadCount += 1
    opened = true
    persist()
    reply(id, {})
  } else if (method === 'session/prompt') {
    if (!opened || params.sessionId !== state.remoteId || activePrompt) { fail(id, 'Unowned or overlapping prompt'); continue }
    if (!Array.isArray(params.prompt) || params.prompt.some(block => !['text', 'resource', 'image', 'audio'].includes(block.type))) { fail(id, 'Unsupported block'); continue }
    state.turnCount += 1
    persist()
    if (params.prompt[0]?.text === 'tool-output-deltas') {
      notify({ sessionUpdate: 'tool_call', toolCallId: 'owned-output', title: 'Owned native read', status: 'in_progress', kind: 'read' })
      notify({ sessionUpdate: 'tool_call_update', toolCallId: 'foreign-output', _meta: { terminal_output_delta: { data: 'FOREIGN-OUTPUT' } } }, 'foreign-session')
      for (const [key, data] of [['terminal_output_delta', 'first 😀\n'], ['mcp_output_delta', 'second\n'], ['terminal_output', 'x'.repeat(16383) + '😀tail']]) {
        notify({ sessionUpdate: 'tool_call_update', toolCallId: 'owned-output', _meta: { [key]: { data, terminal_id: 'producer-terminal' }, ignored_private_field: 'DO-NOT-COPY' } })
      }
      notify({ sessionUpdate: 'tool_call_update', toolCallId: 'owned-output', status: 'completed', rawOutput: { exit_code: 0 } })
    }
    if (params.prompt[0]?.text === 'hold-context') activePrompt = id
    else reply(id, { stopReason: 'end_turn' })
  } else if (method === 'session/cancel') {
    if (activePrompt !== undefined) reply(activePrompt, { stopReason: 'cancelled' })
    activePrompt = undefined
  } else if (method === 'session/close') {
    opened = false
    reply(id, {})
  } else if (id !== undefined) fail(id, 'Unsupported method')
}

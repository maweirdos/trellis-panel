// Clean-room ACP v1 peer, independently authored for bounded research only.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const directory = resolve(process.argv[2])
const scenario = process.argv[3] ?? 'normal'
const journal = join(directory, 'peer-wire.jsonl')
const stateFile = join(directory, 'peer-state.json')
let state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {
  remoteId: `opaque-agent-session:${scenario}:729`, newCount: 0, turnCount: 0,
  currentMode: 'safe', currentModel: 'small', quality: 'fast', appliedActions: 0
}
const pendingPermissions = new Map()
let initialized = false
let opened = false
let activePrompt = null
let nextPermission = 400

function log(kind, value) {
  appendFileSync(journal, `${JSON.stringify({ kind, pid: process.pid, ...value })}\n`)
}
function persist() { writeFileSync(stateFile, JSON.stringify(state, null, 2)) }
function send(message) {
  log('out', { message })
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}
function result(id, value) { send({ id, result: value }) }
function failure(id, message, code = -32602) { send({ id, error: { code, message } }) }
function update(value, sessionId = state.remoteId) {
  send({ method: 'session/update', params: { sessionId, update: value } })
}
function configOptions() {
  return [{ id: 'quality', name: 'Fixture quality', type: 'select', currentValue: state.quality,
    options: [{ value: 'fast', name: 'Fast' }, { value: 'careful', name: 'Careful' }] }]
}
function sessionMetadata() {
  return {
    modes: { currentModeId: state.currentMode, availableModes: [{ id: 'safe', name: 'Safe' }, { id: 'edit', name: 'Edit' }] },
    models: { currentModelId: state.currentModel, availableModels: [{ modelId: 'small', name: 'Small' }, { modelId: 'large', name: 'Large' }] },
    configOptions: configOptions()
  }
}
function ensureRemote(message) {
  if (!opened || message.params?.sessionId !== state.remoteId) {
    failure(message.id, 'Strict fixture: exact remote sessionId required')
    return false
  }
  return true
}
function finishPrompt(id, stopReason = 'end_turn') {
  if (activePrompt?.id !== id) return
  activePrompt = null
  persist()
  result(id, { stopReason })
}
function completePermission(message) {
  const pending = pendingPermissions.get(message.id)
  if (!pending) return
  pendingPermissions.delete(message.id)
  log('permission-answer', { requestId: message.id, response: message.result ?? message.error })
  const answer = message.result?.outcome
  if (answer?.outcome === 'selected') {
    const selected = pending.options.find(option => option.optionId === answer.optionId)
    if (!selected) return failure(pending.promptId, 'Strict fixture: unknown permission optionId')
    if (selected.kind.startsWith('allow')) state.appliedActions += 1
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `selected:${selected.optionId}` } })
  } else if (answer?.outcome !== 'cancelled') {
    return failure(pending.promptId, 'Strict fixture: expected selected or cancelled outcome')
  }
  finishPrompt(pending.promptId, pending.cancelled ? 'cancelled' : 'end_turn')
}

async function onMessage(message) {
  log('in', { message: message.method === 'authenticate' ? { id: message.id, method: message.method, params: '[not recorded]' } : message })
  if (message.method === undefined) return completePermission(message)
  const { method, id, params = {} } = message
  if (method === 'initialize') {
    if (params.protocolVersion !== 1 || !params.clientInfo || !params.clientCapabilities) {
      return failure(id, 'Strict fixture: protocolVersion, clientInfo and clientCapabilities required')
    }
    initialized = true
    if (scenario === 'malformed-init') return result(id, { protocolVersion: 'one', agentCapabilities: {} })
    return result(id, {
      protocolVersion: scenario === 'wrong-version' ? 999 : 1,
      agentInfo: { name: 'independent-strict-peer', version: '1.0.0' },
      agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: false }, mcpCapabilities: { http: false, sse: false } },
      authMethods: scenario === 'auth-required' ? [{ id: 'fixture-login', name: 'Fixture login' }] : []
    })
  }
  if (!initialized) return failure(id, 'Strict fixture: initialize required')
  if (method === 'authenticate') return failure(id, 'Fixture has no real authentication', -32000)
  if (method === 'session/new') {
    if (scenario === 'auth-required') return failure(id, 'Fixture authentication required', -32000)
    if (typeof params.cwd !== 'string' || !Array.isArray(params.mcpServers)) return failure(id, 'Strict fixture: cwd and mcpServers required')
    if (scenario === 'missing-new-id') return result(id, sessionMetadata())
    state.newCount += 1
    opened = true
    persist()
    return result(id, { sessionId: state.remoteId, ...sessionMetadata() })
  }
  if (method === 'session/load') {
    if (state.failLoad) return failure(id, 'Fixture saved session is unavailable', -32001)
    if (params.sessionId !== state.remoteId) return failure(id, 'Strict fixture: wrong load identity')
    opened = true
    return result(id, sessionMetadata())
  }
  if (method === 'session/set_mode') {
    if (!ensureRemote(message)) return
    if (!['safe', 'edit'].includes(params.modeId)) return failure(id, 'Fixture invalid mode')
    state.currentMode = params.modeId
    persist()
    update({ sessionUpdate: 'current_mode_update', currentModeId: state.currentMode })
    return result(id, {})
  }
  if (method === 'session/set_model') {
    if (!ensureRemote(message)) return
    if (!['small', 'large'].includes(params.modelId)) return failure(id, 'Fixture invalid model')
    state.currentModel = params.modelId
    persist()
    return result(id, {})
  }
  if (method === 'session/set_config_option') {
    if (!ensureRemote(message)) return
    if (params.configId !== 'quality' || !['fast', 'careful'].includes(params.value)) return failure(id, 'Fixture rejected config choice')
    state.quality = params.value
    persist()
    update({ sessionUpdate: 'config_option_update', configOptions: configOptions() })
    return result(id, { configOptions: configOptions() })
  }
  if (method === 'session/cancel') {
    if (!ensureRemote(message)) return
    log('cancel-received', { sessionId: params.sessionId })
    if (activePrompt) {
      const promptId = activePrompt.id
      for (const pending of pendingPermissions.values()) if (pending.promptId === promptId) pending.cancelled = true
      // An independent peer must finish cancellation even if the client never answers a permission.
      setTimeout(() => finishPrompt(promptId, 'cancelled'), 150)
    }
    return
  }
  if (method !== 'session/prompt') return failure(id, `Fixture method unsupported: ${method}`, -32601)
  if (!ensureRemote(message)) return
  if (activePrompt) return failure(id, 'Strict fixture: concurrent prompt rejected')
  if (!Array.isArray(params.prompt) || params.prompt.some(block => block.type !== 'text')) return failure(id, 'Strict fixture: text prompt required')
  const text = params.prompt.map(block => block.text).join('')
  activePrompt = { id, text }
  state.turnCount += 1
  persist()
  if (text.startsWith('permission:')) {
    const duplicate = text === 'permission:duplicate'
    const options = duplicate ? [
      { optionId: 'opaque-first-once', name: 'First permitted action', kind: 'allow_once' },
      { optionId: 'opaque-second-once', name: 'Second permitted action', kind: 'allow_once' },
      { optionId: 'opaque-deny', name: 'Deny', kind: 'reject_once' }
    ] : [
      { optionId: 'opaque-allow-once', name: 'Allow this action', kind: 'allow_once' },
      { optionId: 'opaque-allow-always', name: 'Always allow this action', kind: 'allow_always' },
      { optionId: 'opaque-reject-once', name: 'Deny this action', kind: 'reject_once' },
      { optionId: 'opaque-reject-always', name: 'Always deny this action', kind: 'reject_always' }
    ]
    const permissionId = `fixture-permission-${nextPermission++}`
    pendingPermissions.set(permissionId, { promptId: id, options, cancelled: false })
    send({ id: permissionId, method: 'session/request_permission', params: {
      sessionId: state.remoteId,
      toolCall: { toolCallId: `tool-${state.turnCount}`, title: 'Controlled fixture action', kind: 'edit', status: 'pending' }, options
    } })
    return
  }
  if (text === 'foreign-update') {
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WRONG-SESSION-MARKER' } }, 'foreign-unowned-session')
  }
  const unicode = { jsonrpc: '2.0', method: 'session/update', params: { sessionId: state.remoteId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好，协议✅' } } } }
  log('out', { message: unicode })
  const bytes = Buffer.from(`${JSON.stringify(unicode)}\n`)
  const cut = bytes.indexOf(Buffer.from('你')) + 1
  process.stdout.write(bytes.subarray(0, cut))
  await new Promise(resolve => setTimeout(resolve, 8))
  process.stdout.write(bytes.subarray(cut))
  update({ sessionUpdate: 'tool_call', toolCallId: 'fixed-tool', title: 'Fixture tool', kind: 'read', status: 'pending', locations: [{ path: join(directory, 'fixture.txt') }] })
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'fixed-tool', status: 'completed', rawOutput: { fixture: true }, content: [{ type: 'content', content: { type: 'text', text: 'controlled output' } }] })
  update({ sessionUpdate: 'plan', entries: [{ content: 'Inspect fixture', priority: 'medium', status: 'completed' }] })
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ` turn:${state.turnCount}` } })
  finishPrompt(id)
}

log('started', { scenario, directory })
const input = createInterface({ input: process.stdin, terminal: false })
input.on('line', line => {
  try { void onMessage(JSON.parse(line)).catch(error => log('peer-error', { message: error.message })) }
  catch (error) { log('peer-error', { message: error.message }) }
})
input.on('close', () => { log('stdin-closed', {}); process.exit(0) })
process.stdout.on('error', () => process.exit(0))

/** Original development diagnostic ACP fixture. Not a vendor acceptance substitute. */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
const SELF = fileURLToPath(import.meta.url)
const REMOTE = 'mock-remote-wire-id'

function serve() {
  let buffer = ''
  let active
  let currentModeId = 'read'
  const categorized = process.argv.includes('--categorized-config')
  let configModeId = 'read'
  let configModelId = 'small'
  const configOptions = () => [
    { id: 'fixture.mode-choice', name: 'Fixture mode', type: 'select', category: 'mode', currentValue: configModeId, options: [{ value: 'read', name: 'Read only' }, { value: 'edit', name: 'Edit with permission' }] },
    { id: 'fixture.model-choice', name: 'Fixture model', type: 'select', category: 'model', currentValue: configModelId, options: [{ value: 'small', name: 'Small' }, { value: 'large', name: 'Large' }] },
    { id: 'mode', name: 'Uncategorized unrelated setting', type: 'select', currentValue: 'irrelevant', options: [{ value: 'irrelevant', name: 'Not a session mode' }] }
  ]
  let permissionSeq = 0
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\n')
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
  const error = (id, message, code = -32602) => send({ jsonrpc: '2.0', id, error: { code, message } })
  const notify = (update) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: REMOTE, update } })
  const finish = (decision) => {
    if (!active) return
    const current = active
    active = undefined
    const allowed = decision?.outcome === 'selected' && ['allow-once', 'allow-second', 'allow-session'].includes(decision.optionId)
    notify({ sessionUpdate: 'tool_call_update', toolCallId: current.toolId, status: allowed ? 'completed' : 'failed',
      content: [{ type: 'content', content: { type: 'text', text: allowed ? '诊断操作已允许' : '诊断操作未执行' } }], rawOutput: { executed: allowed } })
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: allowed ? '你好，诊断完成✅' : '请求已拒绝或取消，未执行操作。' } })
    reply(current.id, { stopReason: decision?.outcome === 'cancelled' ? 'cancelled' : 'end_turn' })
  }
  const handle = (message) => {
    const { id, method, params } = message
    if (!method && active && id === active.permissionId) { finish(message.result?.outcome); return }
    if (method === 'initialize') {
      // acpx explicitly sends false rather than omitting unsupported capabilities.
      // A future accidental enablement must fail the product facade handshake.
      assert.notEqual(params?.clientCapabilities?.fs?.readTextFile, true, 'ACP read callback must not be advertised')
      assert.notEqual(params?.clientCapabilities?.fs?.writeTextFile, true, 'ACP write callback must not be advertised')
      assert.notEqual(params?.clientCapabilities?.terminal, true, 'ACP terminal callback must not be advertised')
      reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: 'acp-mock', version: '2.0.0' }, authMethods: [{ id: 'mock-local', name: 'Fixture local configuration' }] }); return
    }
    if (method === 'session/new' || method === 'session/load') {
      if (method === 'session/load' && params.sessionId !== REMOTE) { error(id, 'unknown remote session'); return }
      reply(id, { ...(method === 'session/new' ? { sessionId: REMOTE } : {}), modes: { currentModeId, availableModes: [{ id: 'read', name: 'Read only' }, { id: 'edit', name: 'Edit with permission' }] },
        ...(categorized ? { models: { currentModelId: 'small', availableModels: [{ modelId: 'small', name: 'Legacy Small' }, { modelId: 'large', name: 'Legacy Large' }] }, configOptions: configOptions() } : {}) }); return
    }
    if (params?.sessionId !== REMOTE) { if (id !== undefined) error(id, 'remote sessionId required'); return }
    if (method === 'session/set_mode') {
      if (!['read', 'edit'].includes(params.modeId)) { error(id, 'unsupported mode'); return }
      if (categorized) {
        configModeId = params.modeId
        notify({ sessionUpdate: 'config_option_update', configOptions: configOptions() })
      } else {
        currentModeId = params.modeId
        notify({ sessionUpdate: 'current_mode_update', currentModeId })
      }
      reply(id, {}); return
    }
    if (method === 'session/set_config_option' && categorized) {
      if (params.configId === 'fixture.mode-choice' && ['read', 'edit'].includes(params.value)) configModeId = params.value
      else if (params.configId === 'fixture.model-choice' && ['small', 'large'].includes(params.value)) configModelId = params.value
      else { error(id, 'unsupported config selection'); return }
      notify({ sessionUpdate: 'config_option_update', configOptions: configOptions() })
      reply(id, { configOptions: configOptions() }); return
    }
    if (method === 'session/cancel') { finish({ outcome: 'cancelled' }); return }
    if (method === 'session/prompt') {
      if (active) { error(id, 'prompt already active'); return }
      if (params.prompt?.some((content) => content.type === 'text' && content.text === 'review-unfinished-tool')) {
        notify({ sessionUpdate: 'tool_call', toolCallId: 'unfinished-review-tool', title: 'Unfinished fixture native tool', kind: 'execute', status: 'pending' })
        notify({ sessionUpdate: 'tool_call_update', toolCallId: 'unfinished-review-tool', status: 'in_progress' })
        notify({ sessionUpdate: 'tool_call_update', toolCallId: 'unfinished-review-tool', rawOutput: { fixture: 'partial without status' } })
        notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Model turn ended while native tool remains unfinished.' } })
        reply(id, { stopReason: 'end_turn' }); return
      }
      const permissionId = `request-${++permissionSeq}`
      const toolId = `tool-${permissionSeq}`
      active = { id, permissionId, toolId }
      notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '诊断：验证权限与工具流。' } })
      notify({ sessionUpdate: 'tool_call', toolCallId: toolId, title: '诊断操作（不写项目文件）', kind: 'edit', status: 'pending' })
      const ambiguous = params.prompt?.some((content) => content.type === 'text' && content.text === 'review-ambiguous-option-id')
      send({ jsonrpc: '2.0', id: permissionId, method: 'session/request_permission', params: { sessionId: REMOTE,
        toolCall: { toolCallId: toolId, title: '诊断操作（不写项目文件）', kind: 'edit' }, options: [
          { optionId: 'allow-once', name: '允许一次', kind: 'allow_once' },
          { optionId: 'allow-second', name: '另一个允许选项', kind: 'allow_once' },
          { optionId: 'allow-session', name: '允许此操作规则', kind: 'allow_always' },
          { optionId: 'reject', name: '拒绝一次', kind: 'reject_once' },
          { optionId: 'reject-always', name: '拒绝此操作规则', kind: 'reject_always' },
          ...(ambiguous ? [{ optionId: 'allow-once', name: 'Ambiguous duplicated ID', kind: 'reject_once' }] : [])
        ] } })
      return
    }
    if (id !== undefined) error(id, `method not found: ${method}`, -32601)
  }
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
      if (line.trim()) handle(JSON.parse(line))
    }
  })
  process.stdout.on('error', () => process.exit(0))
}

async function selfTest() {
  const child = spawn(process.execPath, [SELF, '--serve'], { stdio: ['pipe', 'pipe', 'inherit'] })
  const inbox = []
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) { inbox.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1) }
  })
  const send = (value) => child.stdin.write(JSON.stringify(value) + '\n')
  const next = async (predicate) => {
    const limit = Date.now() + 5000
    while (Date.now() < limit) {
      const index = inbox.findIndex(predicate)
      if (index >= 0) return inbox.splice(index, 1)[0]
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('Diagnostic fixture response timeout')
  }
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } })
    assert.equal((await next((value) => value.id === 1)).result.agentInfo.name, 'acp-mock')
    send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } })
    const remote = (await next((value) => value.id === 2)).result.sessionId
    for (const [index, optionId] of ['allow-second', 'reject-always'].entries()) {
      const id = 10 + index
      send({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId: remote, prompt: [{ type: 'text', text: randomUUID() }] } })
      const permission = await next((value) => value.method === 'session/request_permission')
      assert.equal(permission.params.options.length, 5)
      send({ jsonrpc: '2.0', id: permission.id, result: { outcome: { outcome: 'selected', optionId } } })
      assert.equal((await next((value) => value.id === id)).result.stopReason, 'end_turn')
      const update = await next((value) => value.params?.update?.sessionUpdate === 'tool_call_update')
      assert.equal(update.params.update.rawOutput.executed, index === 0)
    }
    send({ jsonrpc: '2.0', id: 99, method: 'session/prompt', params: { sessionId: 'local-panel-id' } })
    assert.equal((await next((value) => value.id === 99)).error.code, -32602)
    console.log('ACP diagnostic fixture: exact allow/deny and remote IDs passed')
  } finally { child.kill(); await new Promise((resolve) => child.once('exit', resolve)) }
}
if (process.argv.includes('--serve')) serve()
else await selfTest()

/** Owned ACP peer: configurable advertised models and acknowledgements, no inference/network. */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const [controlPath, journalPath, app] = process.argv.slice(2)
const remote = `model-fixture-${app}`
const read = () => JSON.parse(readFileSync(controlPath, 'utf8'))
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
const fail = (id, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message } }) + '\n')
const configs = (state) => [{ id: 'native.model', name: 'Model', type: 'select', category: 'model', currentValue: state.current,
  options: state.models.map(({ modelId, name }) => ({ value: modelId, name })) }]
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params = {} } = JSON.parse(line)
  appendFileSync(journalPath, JSON.stringify({ method, pid: process.pid, sessionId: params.sessionId, value: params.value ?? params.modelId }) + '\n')
  if (method === 'initialize') { send(id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: 'owned-model-peer', version: '1' } }); continue }
  const state = read()
  if (method === 'session/new' || method === 'session/load') {
    if (method === 'session/load' && params.sessionId !== remote) { fail(id, 'Wrong session'); continue }
    send(id, { ...(method === 'session/new' ? { sessionId: remote } : {}),
      models: { currentModelId: state.legacy ?? state.current, availableModels: state.legacyModels ?? state.models },
      ...(state.categorized === false ? {} : { configOptions: configs(state) }) })
    continue
  }
  if (params.sessionId !== remote) { if (id !== undefined) fail(id, 'Wrong session'); continue }
  if (method === 'session/set_config_option' || method === 'session/set_model') {
    const value = method === 'session/set_model' ? params.modelId : params.value
    if (!state.models.some(({ modelId }) => modelId === value) || value === state.reject) { fail(id, 'Owned model rejection'); continue }
    if (state.delay) await new Promise((resolve) => setTimeout(resolve, state.delay))
    state.current = value
    writeFileSync(controlPath, JSON.stringify(state))
    send(id, method === 'session/set_config_option' ? { configOptions: configs(state) } : {})
    continue
  }
  if (id !== undefined) fail(id, 'Only discovery/configuration supported by this fixture')
}

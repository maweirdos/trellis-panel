// Owned 0.16.9 protocol peer. No provider, network or user configuration access.
import assert from 'node:assert/strict'
import { createInterface } from 'node:readline'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

if (process.argv.includes('--version')) { console.log('0.16.9'); process.exit(0) }
assert.equal(process.argv[2], 'app-server')
const directory = process.argv[process.argv.indexOf('--cwd') + 1]
const inputLedger = join(directory, 'native-input-ids.json')
const seenInputs = new Set(existsSync(inputLedger) ? JSON.parse(readFileSync(inputLedger, 'utf8')) : [])
writeFileSync(join(directory, 'native-pid'), String(process.pid))
const wire = message => process.stdout.write(`${JSON.stringify(message)}\n`)
const note = value => appendFileSync(join(directory, 'native-wire.jsonl'), `${JSON.stringify(value)}\n`)
const sessionId = 'sess_owned_zcode'
let seq = 0
let revision = 0
let model = { providerId: 'p', modelId: 'unlisted' }
let mode = 'build'
let turn
let unrecoverableGap = false
let rpc = 0
const events = []
const permissionReplies = new Map()
const options = [
  { optionId: 'native-allow-a', name: 'Allow A', kind: 'allow_once', response: { decision: 'allow', reason: 'exact A' } },
  { optionId: 'native-allow-b', name: 'Allow B', kind: 'allow_once', response: { decision: 'allow', reason: 'exact B' } },
  { optionId: 'native-deny', name: 'Reject', kind: 'deny', response: { decision: 'deny', reason: 'exact reject' } }
]
const available = ['a', 'b', 'reject'].map(modelId => ({ ref: { providerId: 'p', modelId }, label: `model ${modelId}`, properties: {} }))
const snapshot = (full = true) => ({ protocol: { name: 'ZCode Protocol', version: 1 },
  session: { sessionId, mode, model }, settings: { mode: { current: mode }, model: { current: model, available: full ? available : available.filter(value => value.ref.modelId === model.modelId) } },
  runtime: { eventSeq: seq, stateRevision: revision }, messages: [] })
const event = (type, payload, emit = true, extra = {}) => {
  const value = { sessionId, eventId: `ev-${++seq}`, seq, type, payload, timestamp: Date.now(), ...(turn ? { turnId: turn.turnId } : {}), ...extra }
  events.push(value)
  if (emit) wire({ method: 'session/event', params: value })
  return value
}
const complete = resultType => {
  if (!turn) return
  event('turn.completed', { inputId: turn.inputId, resultType, response: '', tokenCount: 0, toolCallCount: 0, duration: 1 })
  turn = undefined
}
const answer = (id, result) => wire({ id, result })
const permission = (ordering, input) => {
  const params = { sessionId, turnId: turn.turnId, requestId: `permission-${rpc++}`, toolCallId: `tc-${rpc}`, toolName: 'Write',
    input: { path: 'owned.txt', text: input }, reason: 'fixture write', riskLevel: 'medium', options }
  const nativeRpcId = `server-permission-${rpc}`
  event('tool.updated', { kind: 'scheduled', toolCallId: params.toolCallId, toolName: 'Write', input: params.input })
  const emitRpc = () => wire({ id: nativeRpcId, method: 'interaction/requestPermission', params })
  permissionReplies.set(nativeRpcId, result => {
    note({ kind: 'permission-answer', requestId: params.requestId, result })
    if (ordering !== 'cancel') {
      // 0.16.9 Wfo/Uhr's actual native resolution shape. Denial may have no
      // later tool.updated error, while allow must still execute the tool.
      const payload = { requestId: params.requestId, toolCallId: params.toolCallId, decision: result.decision, reason: result.reason }
      const resolved = event('permission.resolved', payload, ordering !== 'resolution-gap')
      event('permission.resolved', { ...payload, toolName: 'Write', inputSummary: params.input }) // semantic duplicate
      wire({ method: 'session/event', params: resolved }) // replay, or fill the intentionally out-of-order resolution
      event('permission.resolved', { ...payload, toolCallId: 'never-declared' })
      event('permission.resolved', { ...payload, decision: 'deny' }, true, { turnId: 'foreign-turn' })
      wire({ method: 'session/event', params: { ...resolved, sessionId: 'foreign-session', seq: seq + 100 } })
      if (result.decision === 'allow') {
        event('tool.updated', { kind: 'started', toolCallId: params.toolCallId })
        event('tool.updated', { kind: 'result', toolCallId: params.toolCallId, result: { output: 'actually executed' } })
        event('permission.resolved', { ...payload, decision: 'deny' }) // cannot reopen an already settled tool
      }
      event('model.streaming', { kind: 'text_delta', delta: result.decision }); complete('success')
    }
  })
  const eventPayload = { ...params }
  delete eventPayload.sessionId
  delete eventPayload.turnId
  if (ordering === 'event-first' || ordering === 'resolution-gap') { event('permission.requested', eventPayload); setTimeout(emitRpc, 80) }
  else { emitRpc(); setTimeout(() => event('permission.requested', eventPayload), 20) }
}

wire({ method: 'startup/storageState', params: { phase: 'ready' } })
createInterface({ input: process.stdin }).on('line', line => {
  try {
    const message = JSON.parse(line)
    assert.equal(message.jsonrpc, undefined, 'Native framing must omit jsonrpc')
    if (!message.method) {
      const callback = permissionReplies.get(message.id)
      assert.ok(callback, 'Every server response correlates exactly once')
      permissionReplies.delete(message.id)
      callback(message.result)
      return
    }
    note({ kind: 'request', method: message.method, params: message.params })
    const p = message.params
    switch (message.method) {
      case 'session/create': answer(message.id, snapshot()); break
      case 'session/resume': {
        assert.equal(p.sessionId, sessionId)
        const restored = snapshot()
        restored.runtime.eventSeq += 1000 // Snapshot and desktop subscription use distinct sequence namespaces.
        answer(message.id, restored); break
      }
      case 'session/subscribe':
        assert.equal(p.sessionId, sessionId)
        answer(message.id, { sessionId, eventSeq: seq, events: events.filter(value => value.seq > p.afterSeq), snapshot: snapshot(false) }); break
      case 'session/events': answer(message.id, { events: unrecoverableGap ? [] : events.filter(value => value.seq > p.afterSeq) }); break
      case 'session/setModel':
        if (p.model.modelId === 'reject') wire({ id: message.id, error: { code: -32603, message: 'fixture model rejected', data: { reason: 'unavailable' } } })
        else {
          model = p.model; revision++
          wire({ method: 'state.updated', params: { type: 'state.updated', scope: 'session', sessionId, revision, patch: snapshot(false).settings } })
          answer(message.id, snapshot(false))
        }
        break
      case 'session/setMode': mode = p.mode; revision++; answer(message.id, snapshot(false)); break
      case 'session/stop': complete('cancelled'); answer(message.id, {}); break
      case 'session/send': {
        assert.equal(p.sessionId, sessionId)
        if (seenInputs.has(p.inputId)) { wire({ id: message.id, error: { code: -32010, message: 'Duplicate persisted native input ID' } }); break }
        seenInputs.add(p.inputId)
        writeFileSync(inputLedger, JSON.stringify([...seenInputs]))
        if (p.content === 'send-rejected') { wire({ id: message.id, error: { code: -32010, message: 'fixture admission rejected' } }); break }
        turn = { inputId: p.inputId, turnId: `turn-${p.inputId}` }
        event('turn.started', { inputId: p.inputId, input: p.content, turnNumber: 1 })
        if (p.content.startsWith('permission:')) permission(p.content.split(':')[1], p.content)
        else if (p.content.startsWith('error_')) complete(p.content)
        else if (p.content === 'turn-failed') {
          event('turn.failed', { inputId: p.inputId, error: { type: 'Error', message: 'fixture provider failure' }, turnPhase: 'model' }); turn = undefined
        } else if (p.content === 'wait-cancel') { /* stop is the only terminal */ }
        else {
          unrecoverableGap = p.content === 'unrecoverable-gap'
          const a = event('model.streaming', { kind: 'text_delta', delta: 'one ' }, p.content !== 'gap' && !unrecoverableGap)
          if (p.content === 'duplicates') {
            wire({ method: 'session/event', params: a })
            wire({ method: 'session/event', params: { ...a, sessionId: 'sess_foreign', seq: seq + 50, payload: { kind: 'text_delta', delta: 'FOREIGN' } } })
            event('turn.completed', { inputId: 'old-input', resultType: 'success' }, true, { turnId: 'old-turn' })
            event('model.streaming', { kind: 'text_delta', delta: 'STALE' }, true, { turnId: 'old-turn' })
          }
          event('tool.updated', { kind: 'scheduled', toolCallId: 'tc', toolName: 'Read', input: { path: 'nonce.txt' } })
          event('tool.updated', { kind: 'result', toolCallId: 'tc', result: { output: 'tool NONCE', nested: { ok: true } }, duration: 1 })
          event('model.streaming', { kind: 'text_delta', delta: 'two' })
          complete('success')
        }
        // Intentionally send acceptance after terminal events.
        answer(message.id, { accepted: true, sessionId, stateRevision: revision })
        break
      }
      default: wire({ id: message.id, error: { code: -32601, message: 'Unknown fixture method' } })
    }
  } catch (error) { console.error(error.stack); process.exit(9) }
})

// Owned delayed protocol peer; never accesses a native installation or provider.
import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.argv[process.argv.indexOf('--cwd') + 1]
const scenario = process.env.ZCODE_TIMING_FIXTURE
const sessionId = 'sess_timing_fixture'
const note = value => appendFileSync(join(directory, 'timing-peer.jsonl'), `${JSON.stringify(value)}\n`)
const wire = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const answer = (id, result) => wire({ id, result })
const fail = id => wire({ id, error: { code: -32000, message: 'SECRET-FIXTURE native failure' } })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let seq = 0
let turn
let mode = 'build'
note({ started: process.pid })
const model = { providerId: 'fixture', modelId: 'fixture' }
const snapshot = () => ({ session: { sessionId }, runtime: { eventSeq: seq + 1000, stateRevision: 0 },
  settings: { mode: { current: mode }, model: { current: model, available: [{ ref: model, label: 'Fixture' }] } } })
const event = (type, payload) => wire({ method: 'session/event', params: { sessionId, seq: ++seq, type, payload, turnId: turn?.turnId } })
const complete = resultType => {
  event('turn.completed', { inputId: turn?.inputId, resultType })
  turn = undefined
}

setTimeout(() => {
  if (scenario === 'exit-before-ready') process.exit(7)
  if (scenario !== 'never-ready') wire({ method: 'startup/storageState', params: { phase: 'ready' } })
}, 65)

createInterface({ input: process.stdin }).on('line', line => {
  void (async () => {
    const request = JSON.parse(line)
    const params = request.params ?? {}
    note({ method: request.method, sessionId: params.sessionId, afterSeq: params.afterSeq, includeSnapshot: params.includeSnapshot })
    if (request.method === 'provider/updateAccountConfig') {
      await pause(55)
      answer(request.id, { receivedRevision: scenario === 'account-rejected' ? 'wrong' : params.revision, status: 'received' })
    } else if (request.method === 'session/create' || request.method === 'session/resume') {
      await pause(65)
      if (scenario === 'session-failed') { fail(request.id); return }
      const value = snapshot()
      if (scenario === 'wrong-resume' && request.method === 'session/resume') value.session.sessionId = 'sess_foreign'
      answer(request.id, value)
    } else if (request.method === 'session/subscribe') {
      await pause(75)
      if (scenario === 'subscribe-failed') { fail(request.id); return }
      if (scenario === 'success' && !params.includeSnapshot) {
        mode = 'plan'
        wire({ method: 'state.updated', params: { scope: 'session', sessionId, revision: 1, patch: { mode: { current: mode } } } })
      }
      answer(request.id, { sessionId, eventSeq: scenario === 'bad-watermark' ? -1 : seq,
        events: [], ...(params.includeSnapshot ? { snapshot: snapshot() } : {}) })
    } else if (request.method === 'session/send') {
      turn = { turnId: `turn-${params.inputId}`, inputId: params.inputId }
      event('turn.started', { inputId: params.inputId })
      if (params.content !== 'wait-cancel') {
        event('model.streaming', { kind: 'text_delta', delta: 'fixture text' })
        complete('success')
      }
      answer(request.id, { accepted: true, sessionId })
    } else if (request.method === 'session/stop') {
      if (turn) complete('cancelled')
      answer(request.id, {})
    } else fail(request.id)
  })().catch(() => process.exit(9))
})

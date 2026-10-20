/** Recorded process segments must stay chronological and never consume future output. */
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundled = await build({ entryPoints: ['src/renderer/src/acp/run-progress.ts'], bundle: true, format: 'esm', platform: 'node', write: false })
const { projectRunProgress } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
const base = { type: 'activity', key: 'segment', events: [], projectRoot: 'D:/fixture', sessionId: 'session', turnId: 'turn', connectionGeneration: 'connection' }
const event = (id, ts, label, overrides = {}) => ({ id, ts, source: 'acp', projectRoot: base.projectRoot, sessionId: base.sessionId, turnId: base.turnId, connectionGeneration: base.connectionGeneration, kind: 'session-status', payload: { observation: { label, atMs: ts }, activityScope: 'turn' }, ...overrides })
const begin = event('begin', 1000, '开始处理')
const sent = event('sent', 1100, '指令已发送至引擎')
const model = event('model', 3000, '收到首次模型响应')
const usage = event('usage', 1200, '', { payload: { tag: 'usage_update', used: 10, size: 100 } })
const project = (facts, running = false, all = facts, extra = {}) => projectRunProgress({ ...base, events: facts, ...extra }, all, running, '等待模型回复')

assert.deepEqual(project([]), [])
assert.deepEqual(project([begin], true).map((step) => [step.id, step.state]), [['begin', 'running']])
assert.deepEqual(project([begin, sent], true).map((step) => [step.id, step.state]), [['begin', 'unknown'], ['sent', 'running']])
assert.equal(project([begin, sent], true).filter((step) => step.state === 'running').length, 1)
assert.deepEqual(project([begin, sent], false, [begin, sent, usage, model]).map((step) => [step.id, step.state]), [['begin', 'unknown'], ['sent', 'completed']])
assert.deepEqual(project([model]).map((step) => [step.id, step.state]), [['model', 'completed']])
assert.ok(project([begin, sent]).every((step) => step.startedAt === undefined && step.endedAt === undefined))
const latency = { ...model, payload: { observation: { label: '收到首次模型响应', durationMs: 1900 }, activityScope: 'turn' } }
assert.deepEqual(project([latency]).map((step) => [step.startedAt, step.endedAt]), [[1100, 3000]])
for (const outcome of ['completed', 'failed', 'cancelled']) {
  assert.deepEqual(project([begin, sent], false, [begin, sent, model], { outcome, endedAt: 4000 }), project([begin, sent]))
}
assert.deepEqual(project([usage, event('empty-thought', 1300, '', { kind: 'thought', text: '', payload: {} })]), [])
assert.deepEqual(project([event('connection', 800, '开始处理', { payload: { observation: { label: '开始处理' }, activityScope: 'connection' } })]), [])
const connection = event('prepare', 800, '开始准备会话', { turnId: undefined, payload: { observation: { label: '开始准备会话' }, activityScope: 'connection' } })
assert.deepEqual(project([connection], true, [connection], { scope: 'connection', turnId: undefined }).map((step) => [step.id, step.state]), [['prepare', 'running']])
for (const [field, value] of [['source', 'trellis'], ['projectRoot', 'D:/foreign'], ['sessionId', 'foreign-session'], ['turnId', 'foreign-turn'], ['connectionGeneration', 'foreign-generation']]) {
  assert.deepEqual(project([{ ...model, [field]: value }]), [])
}
const failure = event('failure', 4000, '执行失败', { payload: { observation: { label: '执行失败', status: 'failed' }, activityScope: 'turn' } })
assert.deepEqual(project([failure], true).map((step) => [step.label, step.state]), [['执行失败', 'failed']])
console.log('PASS segment observation order, one live current node, no future/terminal rewriting, recorded-only latency, metadata exclusion and full scope isolation')

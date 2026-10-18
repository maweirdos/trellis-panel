/** Pure projection regression for the reported premature-completion bug. */
import assert from 'node:assert/strict'
import { projectRunProgress } from '../../src/renderer/src/acp/run-progress.ts'

const item = { type: 'activity', key: 'run', events: [], turnId: 'turn', connectionGeneration: 'connection' }
const event = (id, ts, label, overrides = {}) => ({ id, ts, source: 'acp', projectRoot: 'fixture', turnId: 'turn', connectionGeneration: 'connection', kind: 'session-status', payload: { observation: { label, atMs: ts }, activityScope: 'turn' }, ...overrides })
const begin = event('begin', 1000, '开始处理')
const sent = event('sent', 1100, '指令已发送至引擎')
const usage = event('usage', 1200, '', { payload: { tag: 'usage_update', used: 10, size: 100 } })
const legacyMetadataResponse = event('legacy', 1200, '收到首次响应')
const model = event('model', 3000, '收到首次模型响应')

assert.deepEqual(projectRunProgress(item, [], true, '等待响应'), [])
assert.deepEqual(projectRunProgress(item, [begin], true, '等待响应').map((step) => [step.id, step.state]), [['dispatch', 'running']])
const waiting = projectRunProgress(item, [begin, sent, usage, legacyMetadataResponse, event('empty-thought', 1300, '', { kind: 'thought', text: '' })], true, '等待响应')
assert.deepEqual(waiting.map((step) => [step.id, step.state]), [['dispatch', 'completed'], ['response', 'running']])
assert.equal(waiting.filter((step) => step.state === 'running').length, 1)
const responding = projectRunProgress(item, [begin, sent, usage, model], true, '正在思考')
assert.deepEqual(responding.map((step) => [step.id, step.state]), [['dispatch', 'completed'], ['response', 'completed'], ['generation', 'running']])
assert.equal(responding[2].label, '正在思考')
assert.equal(responding[1].endedAt, 3000)
assert.ok(projectRunProgress({ ...item, outcome: 'completed', endedAt: 4000 }, [begin, sent, model], false, '').every((step) => step.state === 'completed'))
assert.deepEqual(projectRunProgress({ ...item, outcome: 'failed', endedAt: 2000 }, [begin, sent], false, '').map((step) => step.state), ['completed', 'failed'])
assert.deepEqual(projectRunProgress({ ...item, outcome: 'cancelled', endedAt: 2000 }, [begin, sent], false, '').map((step) => step.state), ['completed', 'cancelled'])
assert.deepEqual(projectRunProgress(item, [event('connection', 800, '开始处理', { payload: { observation: { label: '开始处理' }, activityScope: 'connection' } })], true, ''), [])
assert.deepEqual(projectRunProgress(item, [begin, sent, { ...model, connectionGeneration: 'foreign' }], true, '').map((step) => step.state), ['completed', 'running'])
console.log('PASS reached-stage ordering, one current node, metadata/connection exclusion, actual-response completion, failure/cancel and generation isolation')

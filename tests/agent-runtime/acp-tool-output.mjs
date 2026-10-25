import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const directory = mkdtempSync(join(tmpdir(), 'trellis-output-replay-'))
try {
  await build({ stdin: { contents: "export * from './src/renderer/src/acp/timeline'; export {nativeKnowledgeOperationId} from './src/renderer/src/acp/knowledge-operations';", resolveDir: process.cwd(), loader: 'ts' }, outfile: join(directory, 'timeline.mjs'), bundle: true, platform: 'node', format: 'esm' })
  const { compileItems, nativeKnowledgeOperationId } = await import(pathToFileURL(join(directory, 'timeline.mjs')).href)
  let sequence = 0
  const event = (payload, generation = 'one', turnId = 'turn') => ({ id: `event-${++sequence}`, ts: sequence, source: 'acp', kind: 'tool-call',
    projectRoot: 'D:/project', sessionId: 'owned', connectionGeneration: generation, turnId, payload: { toolCallId: 'read', tag: 'tool_call_update', ...payload } })
  const first = event({ title: 'Read project file', status: 'in_progress', kind: 'read' })
  const chunkA = event({ outputDelta: 'first 😀\n' })
  const between = { ...event({}), kind: 'message', text: 'An intervening answer.' }
  const chunkB = event({ outputDelta: 'second\n' })
  const finished = event({ title: 'tool call', status: 'completed', rawOutput: { exit_code: 0 } })
  const other = event({ title: 'Another connection', outputDelta: 'separate', status: 'completed' }, 'two')
  const tools = compileItems([first, chunkA, between, chunkB, finished, other]).filter(item => item.type === 'tool')
  assert.equal(tools.length, 2)
  assert.equal(tools[0].key, first.id)
  assert.equal(tools[0].tool.payload.outputText, 'first 😀\nsecond\n')
  assert.equal(tools[0].tool.status, 'completed')
  assert.equal(tools[1].tool.payload.outputText, 'separate')
  assert.deepEqual(compileItems([first, chunkA, between, chunkB, finished, other]).filter(item => ['tool', 'agent'].includes(item.type)).map(item => item.key), [first.id, between.id, other.id])
  const clipped = compileItems([first, event({ outputDelta: 'x'.repeat(200_000) }), event({ outputDelta: 'y'.repeat(100_000) }), finished]).find(item => item.type === 'tool')
  assert.equal(clipped.tool.payload.outputText.length, 256 * 1024)
  assert.equal(clipped.tool.payload.outputDeltaTruncated, true)
  const operationId = 'owned-search-operation'
  const marker = { ...event({}), kind: 'diagnostic', payload: { activityScope: 'turn', knowledgeOperation: { operationId, kind: 'search', phase: 'completed', detail: 'Actual host search', sourceIds: [] } } }
  const native = event({ status: 'completed', rawOutput: { result: { _meta: { trellisKnowledge: { operationId } } } } })
  assert.equal(nativeKnowledgeOperationId(native.payload), operationId)
  assert.equal(compileItems([marker, native]).filter(item => item.type === 'tool').length, 0, 'A returned host operation marker avoids duplicate search rows')
  assert.equal(compileItems([marker, { ...native, connectionGeneration: 'foreign' }]).filter(item => item.type === 'tool').length, 1)
  assert.equal(nativeKnowledgeOperationId({ rawOutput: { result: { _meta: { trellisKnowledge: { operationId } }, structuredContent: { status: 'ok', operationId: 'different-operation' } } } }), undefined)
  console.log('PASS exact ordered output replay, terminal correlation, chronology, generation isolation and explicit display cap')
} finally {
  assert.ok(directory.startsWith(join(tmpdir(), 'trellis-output-replay-')))
  rmSync(directory, { recursive: true, force: true })
}

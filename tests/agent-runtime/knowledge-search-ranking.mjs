/** Scoped provider requests and deterministic coverage; no relevance probabilities invented. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const directory = mkdtempSync(join(tmpdir(), 'trellis-search-coverage-'))
const calls = []
let mode = 'ranked'
let active = 0
let maximum = 0
const row = (id, content) => ({ knowledge_id: id, knowledge_filename: `${id}.md`, content })
globalThis.__SCOPED_SEARCH_FETCH__ = async (_url, options) => {
  const input = JSON.parse(options.body)
  calls.push(input)
  assert.equal(input.knowledge_base_ids.length, 1)
  active += 1; maximum = Math.max(maximum, active)
  await new Promise(done => setTimeout(done, input.knowledge_base_ids[0] === 'a' ? 15 : 2))
  active -= 1
  const collection = input.knowledge_base_ids[0]
  if (mode === 'partial' && collection === 'b') return new Response('', { status: 503 })
  if (mode === 'foreign') return new Response(JSON.stringify({ success: true, data: [{ ...row('foreign', 'foreign text'), knowledge_base_id: 'not-selected' }] }))
  const data = mode === 'unicode' ? [row('unicode', 'x'.repeat(5999) + '😀end')]
    : collection === 'a' ? [row('empty', ' \n '), row('a1', 'first a'), row('a1', 'first a'), row('a2', 'second a'), row('a3', 'third a')]
      : [row('b1', 'first b'), row('b2', 'second b')]
  return new Response(JSON.stringify({ success: true, data }))
}
try {
  mkdirSync(join(directory, 'entry'))
  await build({ entryPoints: ['src/main/services/integrations/providers/weknora.ts'], outfile: join(directory, 'provider.mjs'),
    bundle: true, format: 'esm', platform: 'node', plugins: [{ name: 'owned-net', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'net', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const net={fetch:(...args)=>globalThis.__SCOPED_SEARCH_FETCH__(...args)}', loader: 'js' }))
    } }] })
  const { weknoraKnowledgePort: provider } = await import(pathToFileURL(join(directory, 'provider.mjs')).href)
  const connection = { public: { config: { baseUrl: 'https://owned.invalid' } }, secrets: { apiKey: 'owned-provider-key' } }
  const result = await provider.search(connection, ['a', 'b'], 'business rule', 4)
  assert.deepEqual(result.items.map(item => item.documentId), ['a1', 'b1', 'a2', 'b2'])
  assert.equal(result.items[0].title, 'a1.md')
  assert.equal(result.partial, false)
  assert.equal(maximum, 2)
  assert.equal(calls.length, 2)
  mode = 'partial'
  const partial = await provider.search(connection, ['a', 'b'], 'rule', 4)
  assert.equal(partial.partial, true)
  assert.ok(partial.items.every(item => item.collectionId === 'a'))
  mode = 'unicode'
  const unicode = await provider.search(connection, ['a'], 'rule', 3)
  assert.equal(unicode.items[0].text.length, 5999)
  assert.equal(unicode.items[0].truncated, true)
  assert.ok(!/[\uD800-\uDBFF]$/u.test(unicode.items[0].text))
  mode = 'foreign'
  await assert.rejects(provider.search(connection, ['a'], 'rule', 3), /检索全部失败/)
  const abort = new AbortController(); abort.abort()
  const before = calls.length
  await assert.rejects(provider.search(connection, ['a', 'b', 'c'], 'rule', 3, abort.signal), /取消/)
  assert.equal(calls.length, before, 'Cancelled work must not enqueue a first remote request')
  console.log('PASS scoped two-request concurrency, stable interleaved native ranks, duplicate/blank removal, filename/Unicode bounds, partial and foreign provenance, pre-aborted zero requests')
} finally {
  delete globalThis.__SCOPED_SEARCH_FETCH__
  assert.ok(directory.startsWith(join(tmpdir(), 'trellis-search-coverage-')))
  rmSync(directory, { recursive: true, force: true })
}

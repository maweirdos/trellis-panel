/** Controlled SDK client/server only. Does not launch a vendor Agent or contact WeKnora. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { request } from 'node:http'
import { build } from 'esbuild'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const directory = mkdtempSync(join(tmpdir(), 'tpanel-knowledge-mcp-'))
const clients = []
let bridge
const wait = async (predicate, label) => {
  const deadline = Date.now() + 5000
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timeout: ${label}`); await new Promise((resolve) => setTimeout(resolve, 10)) }
}
const raw = (descriptor, { headers = {}, body = '{}', method = 'POST', path, onRequest } = {}) => new Promise((resolve, reject) => {
  const url = new URL(descriptor.url)
  const req = request({ hostname: url.hostname, port: url.port, path: path ?? url.pathname, method,
    headers: { Authorization: descriptor.headers[0].value, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers } }, (res) => {
    let text = ''
    res.on('data', (chunk) => { text += chunk })
    res.on('end', () => resolve({ status: res.statusCode, body: text }))
  })
  req.on('error', reject)
  onRequest?.(req)
  req.end(body)
})
const connect = async (descriptor) => {
  const client = new Client({ name: 'controlled-knowledge-peer', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(descriptor.url), { requestInit: { headers: Object.fromEntries(descriptor.headers.map(({ name, value }) => [name, value])) } })
  await client.connect(transport)
  clients.push(client)
  return client
}
const resultOf = (result) => result.structuredContent ?? JSON.parse(result.content[0].text)

try {
  await build({ entryPoints: { server: 'src/main/services/knowledge-mcp/server.ts', types: 'src/main/services/integrations/types.ts', knowledgeTypes: 'src/main/services/knowledge-access/types.ts' }, bundle: true, splitting: true, format: 'esm', platform: 'node',
    banner: { js: "import { createRequire as smokeRequire } from 'node:module'; const require = smokeRequire(import.meta.url);" },
    outdir: directory, outExtension: { '.js': '.mjs' } })
  const { KnowledgeMcpBridge } = await import(pathToFileURL(join(directory, 'server.mjs')).href)
  const { IntegrationError } = await import(pathToFileURL(join(directory, 'types.mjs')).href)
  const { KnowledgeReadVersionError } = await import(pathToFileURL(join(directory, 'knowledgeTypes.mjs')).href)
  const observations = []
  const calls = []
  const supplied = []
  let defaults = ['collection-a']
  let pending
  let failReceipt = false
  let readText = 'Verified fixture text'
  const readHandles = new Set(['opaque-owned-handle'])
  const source = (owner, scope) => ({ id: 'source-fixture', sourceHandle: 'opaque-owned-handle', title: 'Known source', text: 'Verified fixture text', contentHash: 'fixture-hash',
    kind: 'local', documentId: 'fixture-document', collectionId: null, relativePath: '.trellis/notes/fixture.md', instanceId: null, fetchedAt: 1,
    mode: 'excerpt', truncated: true, sessionId: owner.sessionId, turnId: owner.turnId, scopeRevision: scope.revision, suppliedToAgent: false, historical: false })
  const scope = (owner) => ({ id: 'scope-fixture', revision: defaults.join(','), root: owner.root, projectGeneration: owner.projectGeneration,
    sessionId: owner.sessionId, collectionIds: defaults, overridden: false, bindingId: 'binding', bindingRevision: 1, connectionId: 'connection', connectionRevision: 1,
    connectionName: 'Fixture', instanceId: 'instance', status: 'ok', detail: 'Fixture scope' })
  bridge = new KnowledgeMcpBridge({ capture: scope,
    search: async (owner, captured, input, signal) => {
      calls.push({ owner, captured, input, signal })
      if (input.query.startsWith('slow')) await new Promise((resolve) => { pending = resolve })
      if (input.query === 'throw') throw new Error('Do not expose fake upstream credentials')
      if (input.query === 'scope-conflict') throw new IntegrationError('Must not expose raw upstream credentials on conflict', 'conflict')
      let sources = [source(owner, captured)]
      if (input.query === 'bounds') sources = ['x'.repeat(40_000), 'Exact included excerpt\r\n```\n````\n😀', 'y'.repeat(40_000)].map((text, index) => ({ ...source(owner, captured), id: `bounded-${index}`, sourceHandle: `bounded-handle-${index}`, text }))
      if (input.query === 'redact') sources = [{ ...source(owner, captured), text: descriptor.url }]
      if (input.query === 'unsupported') sources = [{ ...source(owner, captured), mode: 'unsupported' }]
      return { operationId: input.requestId, status: 'ok', detail: 'Fixture retrieved', scope: captured, sources, elapsedMs: 1, persistence: input.query === 'degraded' ? 'degraded' : 'durable' }
    },
    markSupplied: async (owner, sourceIds) => { if (failReceipt) throw new Error('Fixture receipt write failure'); supplied.push({ owner, sourceIds }) },
    read: async (owner, captured, input) => {
      calls.push({ owner, captured, input })
      if (input.sourceHandle === 'changed-version') throw new KnowledgeReadVersionError()
      if (!readHandles.has(input.sourceHandle)) throw new IntegrationError('Must not expose upstream credentials on access denial', 'denied')
      const range = { offset: input.offset, length: Math.min(input.limit, 3000, readText.length - input.offset), total: readText.length, unit: 'utf16-code-units', totalIsComplete: true }
      if (range.offset > range.total) throw new IntegrationError('Read offset is outside the document', 'invalid')
      const page = { ...source(owner, captured), id: `read-${input.requestId}`, sourceHandle: `read-handle-${input.requestId}`, text: readText.slice(range.offset, range.offset + range.length), mode: 'excerpt', truncated: range.offset > 0 || range.length < range.total, range }
      readHandles.add(page.sourceHandle)
      return { operationId: input.requestId, status: 'ok', detail: 'Fixture read', source: page, range, nextOffset: range.offset + range.length < range.total ? range.offset + range.length : null, persistence: 'durable' }
    }
  })
  const connection = await bridge.connect({ root: 'project-a', sessionId: 'session-a', connectionGeneration: 'generation-a' }, (observation) => observations.push(observation))
  const descriptor = connection.servers()[0]
  assert.match(descriptor.name, /^trellis_knowledge_[a-f0-9]{24}$/)
  assert.equal(new URL(descriptor.url).hostname, '127.0.0.1')
  assert.equal(observations[0].state, 'attached')
  assert.equal((await raw(descriptor, { headers: { Authorization: 'Bearer wrong' } })).status, 401)
  assert.equal((await raw(descriptor, { headers: { Origin: 'http://localhost' } })).status, 401)
  assert.equal((await raw(descriptor, { headers: { Host: 'attacker.invalid' } })).status, 401)
  assert.equal((await raw(descriptor, { path: `${new URL(descriptor.url).pathname}?foreign=1` })).status, 401)
  assert.equal((await raw(descriptor, { method: 'GET' })).status, 405)
  assert.equal((await raw(descriptor, { headers: { 'Content-Type': 'text/plain' } })).status, 415)
  assert.equal((await raw(descriptor, { body: '[' })).status, 400)
  assert.equal((await raw(descriptor, { body: '[]' })).status, 400)
  assert.equal((await raw(descriptor, { body: JSON.stringify({ data: 'x'.repeat(1024 * 1024) }) })).status, 413)
  const client = await connect(descriptor)
  const tools = await client.listTools()
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['knowledge_read', 'knowledge_search'])
  assert.equal(tools.tools.every((tool) => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint), true)
  assert.match(client.getInstructions(), /Greetings, questions about your identity and general knowledge do not require/)
  assert.doesNotMatch(client.getInstructions(), /host performs a bounded first lookup|use this evidence first/)
  assert.match(tools.tools.find((tool) => tool.name === 'knowledge_search').description, /Default limit: 3/)
  assert.equal(observations.some((observation) => observation.state === 'discovered'), true)
  assert.equal(resultOf(await client.callTool({ name: 'knowledge_search', arguments: { query: 'before turn' } })).status, 'denied')
  assert.equal(calls.length, 0, 'Initialization and tools/list do not permit data reads')
  let current = true
  const owner = { root: 'project-a', projectGeneration: 7, sessionId: 'session-a', turnId: 'turn-a', isCurrent: () => current }
  assert.throws(() => connection.admit({ ...owner, root: 'project-b' }))
  assert.throws(() => connection.admit({ ...owner, connectionGeneration: 'foreign-generation' }))
  assert.equal('preflight' in connection, false, 'The host-first preflight API no longer exists')
  connection.admit(owner)
  defaults.push('collection-later')
  assert.equal(resultOf(await client.callTool({ name: 'knowledge_search', arguments: { query: 'changed-scope' } })).status, 'denied', 'Scope changes fence even cached host reads')
  defaults = ['collection-a']
  const invalid = await client.callTool({ name: 'knowledge_search', arguments: { query: 'foreign', root: 'project-b' } })
  assert.equal(invalid.isError, true)
  assert.equal((await client.callTool({ name: 'knowledge_search', arguments: { query: 'x'.repeat(2001) } })).isError, true)
  assert.equal(calls.length, 0, 'Model arguments cannot override owner or scope')
  const searchWire = await client.callTool({ name: 'knowledge_search', arguments: { query: 'known rule' } })
  const search = resultOf(searchWire)
  assert.equal(searchWire._meta.trellisKnowledge.operationId, calls[0].input.requestId)
  assert.equal(search.status, 'ok')
  assert.equal(search.sources[0].id, 'source-fixture')
  assert.equal(search.sources[0].truncated, true)
  assert.deepEqual(calls[0].captured.collectionIds, ['collection-a'], 'Effective collection scope is fixed for admitted turn')
  assert.equal(calls[0].owner.projectGeneration, 7)
  assert.equal(calls[0].input.limit, 3, 'On-demand search defaults to bounded initial coverage')
  assert.match(searchWire.content[0].text, /Verified fixture text/)
  assert.ok(!JSON.stringify(search).includes('fixture-hash') && !('scope' in search) && !('operationId' in search), 'Audit metadata stays host-side')
  await wait(() => supplied.length === 1, 'actual tool-result response delivery')
  assert.deepEqual(supplied[0].sourceIds, [search.sources[0].id])
  assert.equal(supplied[0].owner.turnId, 'turn-a')
  assert.equal(observations.find((observation) => observation.sourceIds?.length)?.operationId, calls[0].input.requestId)
  assert.equal('toolCallId' in search, false, 'MCP operation IDs are not fabricated native tool IDs')
  const read = resultOf(await client.callTool({ name: 'knowledge_read', arguments: { sourceHandle: search.sources[0].sourceHandle } }))
  assert.notEqual(read.source.id, search.sources[0].id)
  assert.deepEqual(calls.at(-1).input.offset, 0)
  assert.deepEqual(calls.at(-1).input.limit, 6000)
  assert.equal(read.range.offset, 0); assert.equal(read.nextOffset, null)
  await wait(() => supplied.length === 2, 'actual read response delivery')
  assert.deepEqual(supplied.at(-1).sourceIds, [read.source.id])
  readText = '大文档业务规则'.repeat(7000)
  let offset = 0; let receivedText = ''; let handle = search.sources[0].sourceHandle
  const beforePaged = supplied.length
  let pages = 0
  do {
    const wire = await client.callTool({ name: 'knowledge_read', arguments: { sourceHandle: handle, offset } })
    const page = resultOf(wire)
    assert.equal(page.status, 'ok'); assert.equal(page.omittedCount, 0)
    assert.equal(page.source.mode, 'excerpt'); assert.deepEqual(page.source.range, page.range)
    const exactText = readText.slice(page.range.offset, page.range.offset + page.range.length)
    assert.ok(wire.content[0].text.includes('\n```\n' + exactText + '\n```'))
    assert.equal(page.source.text, exactText, 'Clients preferring structured content must receive the same complete source bytes')
    assert.ok(Buffer.byteLength(JSON.stringify(wire)) <= 32 * 1024)
    assert.deepEqual(calls.at(-1).input.offset, offset); assert.deepEqual(calls.at(-1).input.limit, 6000)
    receivedText += exactText; pages++
    await wait(() => supplied.length === beforePaged + pages, 'exact native page response receipt')
    assert.deepEqual(supplied.at(-1).sourceIds, [page.source.id])
    handle = page.source.sourceHandle
    if (page.nextOffset === null) break
    assert.ok(page.nextOffset > offset); offset = page.nextOffset
  } while (pages < 20)
  assert.equal(receivedText, readText)
  const invalidPage = resultOf(await client.callTool({ name: 'knowledge_read', arguments: { sourceHandle: handle, offset: readText.length + 1 } }))
  assert.equal(invalidPage.code, 'E_INVALID_ARG')
  for (const args of [{ offset: -1 }, { offset: 1.5 }, { limit: 0 }, { limit: 6001 }]) assert.equal((await client.callTool({ name: 'knowledge_read', arguments: { sourceHandle: handle, ...args } })).isError, true)
  const beforeBounded = supplied.length
  const pageConflict = resultOf(await client.callTool({ name: 'knowledge_read', arguments: { sourceHandle: 'changed-version' } }))
  assert.equal(pageConflict.code, 'E_CONFLICT'); assert.match(pageConflict.detail, /细化查询.*第一页/)
  assert.equal(supplied.length, beforeBounded)
  const boundedWire = await client.callTool({ name: 'knowledge_search', arguments: { query: 'bounds' } })
  const bounded = resultOf(boundedWire)
  await wait(() => supplied.length === beforeBounded + 1, 'bounded response delivery')
  assert.equal(bounded.retrievedCount, 3)
  assert.equal(bounded.omittedCount, 2)
  assert.deepEqual(bounded.omittedSources.map((source) => source.sourceHandle), ['bounded-handle-0', 'bounded-handle-2'])
  assert.deepEqual(bounded.sources.map((item) => item.id), ['bounded-1'])
  assert.deepEqual(supplied.at(-1).sourceIds, ['bounded-1'], 'Never mark larger omitted snapshots supplied')
  assert.ok(boundedWire.content[0].text.includes(bounded.sources[0].text))
  assert.ok(boundedWire.content[0].text.includes('\n`````\nExact included excerpt\r\n```\n````\n😀\n`````'))
  assert.ok(Buffer.byteLength(JSON.stringify(boundedWire)) <= 32 * 1024)
  const beforeOmitted = supplied.length
  for (const query of ['degraded', 'redact', 'unsupported']) {
    const wire = await client.callTool({ name: 'knowledge_search', arguments: { query } })
    if (query !== 'degraded') assert.equal(resultOf(wire).sources.length, 0)
    assert.ok(!JSON.stringify(wire).includes(descriptor.url))
  }
  assert.equal(supplied.length, beforeOmitted, 'Non-durable, redacted and unsupported snapshots have no supplied receipt')
  failReceipt = true
  await client.callTool({ name: 'knowledge_search', arguments: { query: 'receipt-failure' } })
  await wait(() => observations.some((observation) => observation.persistence === 'degraded' && observation.knowledgeOperation?.query === 'receipt-failure'), 'failed receipt remains visibly degraded')
  failReceipt = false
  assert.equal(supplied.length, beforeOmitted)
  const foreign = resultOf(await client.callTool({ name: 'knowledge_read', arguments: { sourceHandle: 'foreign' } }))
  assert.equal(foreign.status, 'denied')
  assert.equal(foreign.code, 'E_DENIED')
  assert.equal(JSON.stringify(foreign).includes('upstream credentials'), false)
  const conflict = resultOf(await client.callTool({ name: 'knowledge_search', arguments: { query: 'scope-conflict' } }))
  assert.equal(conflict.status, 'denied')
  assert.equal(conflict.code, 'E_CONFLICT')
  assert.equal(JSON.stringify(conflict).includes('upstream credentials'), false)
  assert.equal(resultOf(await client.callTool({ name: 'knowledge_search', arguments: { query: 'throw' } })).status, 'unavailable')
  connection.admit({ ...owner, turnId: 'turn-transport' })
  const rawTool = { jsonrpc: '2.0', id: 'owned-rpc', method: 'tools/call', params: { name: 'knowledge_search', arguments: { query: 'slow' } } }
  const ownedRequest = raw(descriptor, { body: JSON.stringify(rawTool) })
  await wait(() => pending, 'raw MCP cancellation target')
  const original = calls.at(-1)
  const callsBeforeDuplicate = calls.length
  const beforeRawCancel = supplied.length
  const foreignConnection = await bridge.connect({ root: 'project-b', sessionId: 'session-b', connectionGeneration: 'generation-b' }, () => {})
  const foreignDescriptor = foreignConnection.servers()[0]
  const cancelBody = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: rawTool.id } })
  assert.equal((await raw(foreignDescriptor, { body: cancelBody })).status, 202)
  assert.equal(original.signal.aborted, false, 'Another authenticated grant cannot cancel this connection request ID')
  assert.equal((await raw(descriptor, { body: JSON.stringify(rawTool) })).status, 409)
  assert.equal(calls.length, callsBeforeDuplicate, 'Duplicate active MCP request IDs cannot replace a cancellation owner')
  await raw(descriptor, { body: JSON.stringify({ jsonrpc: '2.0', id: 'not-a-notification', method: 'notifications/cancelled', params: { requestId: rawTool.id } }) })
  assert.equal(original.signal.aborted, false, 'An invalid cancellation request is not admitted as a notification')
  assert.equal((await raw(descriptor, { body: cancelBody })).status, 202)
  assert.equal(resultOf(JSON.parse((await ownedRequest).body).result).status, 'cancelled')
  assert.equal(original.signal.aborted, true)
  pending(); pending = undefined
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(supplied.length, beforeRawCancel, 'Cancelled MCP operations are never marked supplied')
  foreignConnection.revoke()
  const disconnect = new AbortController()
  const abandoned = client.callTool({ name: 'knowledge_search', arguments: { query: 'slow-abandoned' } }, undefined, { signal: disconnect.signal })
  const rejected = assert.rejects(abandoned)
  await wait(() => pending, 'client-abandoned fake read')
  const abandonedCall = calls.at(-1)
  const suppliedBeforeDisconnect = supplied.length
  disconnect.abort()
  await rejected
  await wait(() => abandonedCall.signal.aborted, 'SDK cancellation notification cancels the owned upstream read')
  pending(); pending = undefined
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(supplied.length, suppliedBeforeDisconnect, 'No result is marked supplied after the native MCP request is cancelled')
  let droppedRequest
  const dropped = raw(descriptor, { body: JSON.stringify({ ...rawTool, id: 'dropped-response', params: { name: 'knowledge_search', arguments: { query: 'slow-write-failure' } } }), onRequest: (req) => { droppedRequest = req } })
  const droppedFailure = assert.rejects(dropped)
  await wait(() => pending, 'raw connection before failed response write')
  const droppedCall = calls.at(-1)
  const beforeDropped = supplied.length
  droppedRequest.destroy(new Error('Controlled HTTP response write failure'))
  await droppedFailure
  await wait(() => droppedCall.signal.aborted, 'dropped HTTP response aborts upstream')
  pending(); pending = undefined
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(supplied.length, beforeDropped, 'A response that was never written cannot supply evidence')
  const changedScope = client.callTool({ name: 'knowledge_search', arguments: { query: 'slow-changed-scope' } })
  await wait(() => pending, 'delayed scope conflict')
  const beforeScope = supplied.length
  defaults = ['new-collection']; pending(); pending = undefined
  assert.equal(resultOf(await changedScope).status, 'denied')
  assert.equal(supplied.length, beforeScope, 'Changed scope discards late evidence')
  defaults = ['collection-a']
  const staleOwner = client.callTool({ name: 'knowledge_search', arguments: { query: 'slow-root-generation' } })
  await wait(() => pending, 'delayed root-generation conflict')
  current = false; pending(); pending = undefined
  assert.equal(resultOf(await staleOwner).status, 'cancelled')
  assert.equal(supplied.length, beforeScope, 'Root A-to-B-to-A generation changes cannot supply late evidence')
  current = true
  connection.admit({ ...owner, turnId: 'turn-cancel' })
  const slow = client.callTool({ name: 'knowledge_search', arguments: { query: 'slow-end-turn' } })
  await wait(() => pending, 'slow fake read')
  const slowCall = calls.at(-1)
  const suppliedBeforeCancel = supplied.length
  connection.endTurn()
  const cancelled = resultOf(await slow)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(slowCall.signal.aborted, true)
  pending(); pending = undefined
  assert.equal(JSON.stringify(cancelled).includes('Verified fixture text'), false, 'Cancelled late source content is discarded')
  assert.equal(supplied.length, suppliedBeforeCancel, 'Cancelled results are not marked as supplied')
  connection.admit({ ...owner, turnId: 'turn-b' })
  current = false
  const beforeStale = calls.length
  assert.equal(resultOf(await client.callTool({ name: 'knowledge_search', arguments: { query: 'stale project' } })).status, 'denied')
  assert.equal(calls.length, beforeStale)
  current = true
  connection.endTurn()
  const rotated = connection.servers()[0]
  assert.notEqual(rotated.name, descriptor.name)
  assert.equal((await raw(descriptor)).status, 401, 'Reconnect revokes the prior descriptor')
  const resumed = await connect(rotated)
  assert.equal(resultOf(await resumed.callTool({ name: 'knowledge_search', arguments: { query: 'idle resumed' } })).status, 'denied')
  connection.admit({ ...owner, turnId: 'turn-c' })
  assert.equal(resultOf(await resumed.callTool({ name: 'knowledge_search', arguments: { query: 'next turn' } })).status, 'ok')
  const secretText = `${descriptor.headers[0].value} ${descriptor.url}`
  assert.equal(bridge.redactText(secretText).includes(descriptor.headers[0].value), false)
  assert.equal(bridge.redact({ nested: [secretText] }).nested[0].includes(descriptor.url), false)
  const rotating = await bridge.connect({ root: 'rotation-project', sessionId: 'rotation-session', connectionGeneration: 'rotation-generation' }, () => {})
  for (let index = 0; index < 140; index++) rotating.servers()
  assert.equal(bridge.redactText(`${rotated.headers[0].value} ${rotated.url}`).includes(rotated.headers[0].value), false, 'A still-active grant remains redacted after retired history reaches its bound')
  assert.equal(bridge.redactText(rotated.url).includes(rotated.url), false)
  rotating.revoke()
  const circular = { safe: true }; circular.self = circular
  assert.equal(bridge.redact(circular).self, '[circular reference omitted]')
  let deep = {}; for (let depth = 0; depth < 40; depth++) deep = { nested: deep }
  assert.throws(() => bridge.redact(deep), /redaction budget/)
  connection.revoke()
  assert.equal((await raw(rotated)).status, 401)
  await bridge.close(); bridge = undefined
  console.log('Knowledge MCP controlled SDK peer: loopback/auth/Origin/body guards, read-only tools, on-demand default3 search, paged large-document reads with exact bounded post-write receipts, active turn/scope ownership, cancellation/late discard/dropped response, host audit IDs, grant rotation/revocation and redaction passed. Native/vendor/WeKnora acceptance not run.')
} finally {
  await Promise.all(clients.map((client) => client.close().catch(() => {})))
  await bridge?.close()
  const target = join(tmpdir(), directory.split(/[\\/]/).at(-1))
  assert.equal(target, directory)
  rmSync(directory, { recursive: true, force: true })
}

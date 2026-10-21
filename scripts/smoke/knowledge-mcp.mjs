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
const raw = (descriptor, { headers = {}, body = '{}', method = 'POST', path } = {}) => new Promise((resolve, reject) => {
  const url = new URL(descriptor.url)
  const req = request({ hostname: url.hostname, port: url.port, path: path ?? url.pathname, method,
    headers: { Authorization: descriptor.headers[0].value, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers } }, (res) => {
    let text = ''
    res.on('data', (chunk) => { text += chunk })
    res.on('end', () => resolve({ status: res.statusCode, body: text }))
  })
  req.on('error', reject)
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
  await build({ entryPoints: { server: 'src/main/services/knowledge-mcp/server.ts', types: 'src/main/services/integrations/types.ts' }, bundle: true, splitting: true, format: 'esm', platform: 'node',
    banner: { js: "import { createRequire as smokeRequire } from 'node:module'; const require = smokeRequire(import.meta.url);" },
    outdir: directory, outExtension: { '.js': '.mjs' } })
  const { KnowledgeMcpBridge } = await import(pathToFileURL(join(directory, 'server.mjs')).href)
  const { IntegrationError } = await import(pathToFileURL(join(directory, 'types.mjs')).href)
  const observations = []
  const calls = []
  const supplied = []
  let defaults = ['collection-a']
  let pending
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
      return { operationId: input.requestId, status: 'ok', detail: 'Fixture retrieved', scope: captured, sources: [source(owner, captured)], elapsedMs: 1, persistence: 'durable' }
    },
    markSupplied: async (owner, sourceIds) => { supplied.push({ owner, sourceIds }) },
    read: async (owner, captured, input) => {
      calls.push({ owner, captured, input })
      if (input.sourceHandle !== 'opaque-owned-handle') throw new IntegrationError('Must not expose upstream credentials on access denial', 'denied')
      return { operationId: input.requestId, status: 'ok', detail: 'Fixture read', source: source(owner, captured), persistence: 'durable' }
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
  assert.equal(observations.some((observation) => observation.state === 'discovered'), true)
  assert.equal(resultOf(await client.callTool({ name: 'knowledge_search', arguments: { query: 'before turn' } })).status, 'denied')
  assert.equal(calls.length, 0, 'Initialization and tools/list do not permit data reads')
  let current = true
  const owner = { root: 'project-a', projectGeneration: 7, sessionId: 'session-a', turnId: 'turn-a', isCurrent: () => current }
  assert.throws(() => connection.admit({ ...owner, root: 'project-b' }))
  connection.admit(owner)
  defaults.push('collection-later')
  assert.equal(resultOf(await client.callTool({ name: 'knowledge_search', arguments: { query: 'changed-scope' } })).status, 'denied', 'Scope changes fence even cached host reads')
  defaults = ['collection-a']
  const invalid = await client.callTool({ name: 'knowledge_search', arguments: { query: 'foreign', root: 'project-b' } })
  assert.equal(invalid.isError, true)
  assert.equal((await client.callTool({ name: 'knowledge_search', arguments: { query: 'x'.repeat(2001) } })).isError, true)
  assert.equal(calls.length, 0, 'Model arguments cannot override owner or scope')
  const search = resultOf(await client.callTool({ name: 'knowledge_search', arguments: { query: 'known rule', limit: 2 } }))
  assert.equal(search.status, 'ok')
  assert.equal(search.sources[0].id, 'source-fixture')
  assert.equal(search.sources[0].truncated, true)
  assert.deepEqual(calls[0].captured.collectionIds, ['collection-a'], 'Effective collection scope is fixed for admitted turn')
  assert.equal(calls[0].owner.projectGeneration, 7)
  assert.equal(search.operationId, calls[0].input.requestId)
  await wait(() => supplied.length === 1, 'actual tool-result response delivery')
  assert.deepEqual(supplied[0].sourceIds, [search.sources[0].id])
  assert.equal(supplied[0].owner.turnId, 'turn-a')
  assert.equal('toolCallId' in search, false, 'MCP operation IDs are not fabricated native tool IDs')
  const read = resultOf(await client.callTool({ name: 'knowledge_read', arguments: { sourceHandle: search.sources[0].sourceHandle } }))
  assert.equal(read.source.id, search.sources[0].id)
  const foreign = resultOf(await client.callTool({ name: 'knowledge_read', arguments: { sourceHandle: 'foreign' } }))
  assert.equal(foreign.status, 'denied')
  assert.equal(foreign.code, 'E_DENIED')
  assert.equal(JSON.stringify(foreign).includes('upstream credentials'), false)
  const conflict = resultOf(await client.callTool({ name: 'knowledge_search', arguments: { query: 'scope-conflict' } }))
  assert.equal(conflict.status, 'denied')
  assert.equal(conflict.code, 'E_CONFLICT')
  assert.equal(JSON.stringify(conflict).includes('upstream credentials'), false)
  assert.equal(resultOf(await client.callTool({ name: 'knowledge_search', arguments: { query: 'throw' } })).status, 'unavailable')
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
  console.log('Knowledge MCP controlled SDK peer: loopback/auth/Origin/body guards, read-only tools, active turn/scope ownership, cancellation/late discard, source operation IDs, grant rotation/revocation and redaction passed. Native/vendor/WeKnora acceptance not run.')
} finally {
  await Promise.all(clients.map((client) => client.close().catch(() => {})))
  await bridge?.close()
  const target = join(tmpdir(), directory.split(/[\\/]/).at(-1))
  assert.equal(target, directory)
  rmSync(directory, { recursive: true, force: true })
}

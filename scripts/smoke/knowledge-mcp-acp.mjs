/** Actual ACP facade/runtime + controlled MCP-consuming peer. No native vendor or remote API. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { prepareAcpHistoryWorker } from './prepare-acp-history-worker.mjs'

const directory = mkdtempSync(join(tmpdir(), 'tpanel-knowledge-native-'))
const root = join(directory, 'project')
mkdirSync(join(root, '.trellis'), { recursive: true })
await prepareAcpHistoryWorker(directory)
const previousData = process.env.TPAP_SMOKE_DIR
const previousJournal = process.env.TRELLIS_KNOWLEDGE_PEER_JOURNAL
process.env.TPAP_SMOKE_DIR = directory
process.env.TRELLIS_KNOWLEDGE_PEER_JOURNAL = join(directory, 'peer.jsonl')
const journal = () => { try { return readFileSync(join(directory, 'peer.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) } catch { return [] } }
const events = () => (globalThis.__TPANEL_EVENTS__ ?? []).map((event) => event.payload)
const wait = async (predicate, label) => {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) { const found = predicate(); if (found) return found; await new Promise((resolve) => setTimeout(resolve, 15)) }
  throw new Error(`Timeout: ${label}`)
}
const fixture = { id: 'knowledge-native-fixture', name: 'Knowledge controlled peer', command: 'fixture', enabled: true, available: true,
  launchKind: 'custom', executable: process.execPath, args: [resolve('scripts/smoke/knowledge-mcp-peer.mjs')] }
const fixtures = [fixture, ...['no-http', 'unknown'].map((mode) => ({ ...fixture, id: `knowledge-${mode}-fixture`, args: [...fixture.args, mode] }))]
const setup = `
  const fixtures=${JSON.stringify(fixtures)};
  export const runtimeDefinitions=()=>fixtures.map(({available,...config})=>config);
  export const listAcpAgents=async()=>({ok:true,agents:fixtures});
  export const launchArgv=async(config)=>[config.executable,...config.args];
  export const resolveAcpRuntimeLaunch=async(id)=>{
    const status=fixtures.find(config=>config.id===id);
    if(!status?.enabled||!status.available)return {ok:false,code:'E_INVALID_ARG',error:'Fixture runtime unavailable'};
    const {available,...config}=status;return {config,argv:await launchArgv(config)};
  };
  export const NATIVE_TOOLS_DIAGNOSTIC='Fixture native tools';
  export const setupAcpRuntime=async()=>({ok:false});export const pickAcpNode=async()=>({ok:false});`
const core = `export const knowledgeAccess = globalThis.__KNOWLEDGE_NATIVE_PORT__;`
let acp
let releaseSlow
let current = true
const calls = []
const supplied = []
globalThis.__KNOWLEDGE_NATIVE_PORT__ = {
  capture: (owner) => ({ id: 'scope', revision: 'scope-r1', root: owner.root, projectGeneration: owner.projectGeneration, sessionId: owner.sessionId, collectionIds: [],
    overridden: false, bindingId: null, bindingRevision: null, connectionId: null, connectionRevision: null, connectionName: null, instanceId: null, status: 'ok', detail: 'Controlled local scope' }),
  search: async (owner, scope, input, signal) => {
    calls.push({ owner, scope, input, signal })
    if (input.query === 'slow-native') await new Promise((resolve) => { releaseSlow = resolve })
    return { operationId: input.requestId, status: 'ok', detail: 'Controlled actual bridge source', scope,
      sources: [{ id: `source-${input.requestId}`, sourceHandle: 'owned-source-handle', title: 'Fixture rule', text: 'fixture rule body', contentHash: 'fixture-hash', kind: 'local',
        documentId: 'fixture-rule', collectionId: null, relativePath: '.trellis/notes/rule.md', instanceId: null, fetchedAt: 1, mode: 'excerpt', truncated: true,
        sessionId: owner.sessionId, turnId: owner.turnId, scopeRevision: scope.revision, suppliedToAgent: false, historical: false }], elapsedMs: 1, persistence: 'durable' }
  },
  read: async () => { throw new Error('Not used by this ACP fixture') },
  markSupplied: async (owner, sourceIds) => supplied.push({ owner, sourceIds })
}
try {
  await build({ entryPoints: ['src/main/services/acp.ts'], bundle: true, format: 'esm', platform: 'node',
    banner: { js: "import { createRequire as fixtureRequire } from 'node:module'; const require = fixtureRequire(import.meta.url);" },
    alias: { electron: resolve('scripts/smoke/mock-electron.mjs') }, outfile: join(directory, 'service.mjs'),
    plugins: [{ name: 'controlled-knowledge-peer-only', setup(builder) {
      builder.onResolve({ filter: /^\.\/acp\/setup$/ }, () => ({ path: 'setup', namespace: 'fixture' }))
      builder.onResolve({ filter: /^\.\.\/knowledge-access\/service$/ }, () => ({ path: 'core', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'setup' ? setup : core, loader: 'js' }))
    } }] })
  acp = await import(pathToFileURL(join(directory, 'service.mjs')).href)
  const created = await acp.newAcpSession(root, { agentId: fixture.id })
  assert.equal(created.ok, true)
  const sessionId = created.sessionId
  const get = () => acp.listAcpSessions(root).sessions.find((session) => session.sessionId === sessionId)
  await wait(() => get()?.status === 'ready', 'native session with actual MCP descriptor')
  assert.equal(calls.length, 0, 'Idle descriptor discovery is not a data admission')
  assert.equal(journal().find((entry) => entry.method === 'discovery').idle, 'denied')
  const remote = get().backendSessionId
  const first = journal().find((entry) => entry.method === 'session/new').descriptor
  assert.equal(get().events.some((event) => event.payload?.knowledgeBridge?.state === 'discovered'), true)
  const turn = await acp.promptAcpSession(root, sessionId, 'ordinary knowledge conversation', undefined, () => current, 9)
  assert.equal(turn.ok, true)
  await wait(() => get()?.status === 'ready' && get()?.events.some((event) => event.kind === 'turn-done' && event.turnId === turn.turnId), 'actual tool turn')
  assert.equal(calls[0].owner.sessionId, sessionId)
  assert.equal(calls[0].owner.turnId, turn.turnId)
  assert.equal(calls[0].owner.projectGeneration, 9)
  assert.equal(supplied[0].owner.turnId, turn.turnId)
  assert.equal(get().events.some((event) => event.payload?.knowledgeBridge?.operationId === calls[0].input.requestId), true)
  assert.equal(get().events.some((event) => event.kind === 'tool-call' && event.payload.toolCallId?.startsWith('native-domain-')), true)
  const stored = () => readFileSync(join(directory, 'acp-sessions', `${sessionId}.json`), 'utf8')
  assert.equal(JSON.stringify(events()).includes(first.headers[0].value), false, 'Opaque grants are redacted from emitted history')
  assert.equal(stored().includes(first.url), false, 'Opaque endpoint is redacted from app snapshot')
  for (const name of readdirSync(join(directory, 'acp', 'runtime-store', 'sessions'))) {
    const body = readFileSync(join(directory, 'acp', 'runtime-store', 'sessions', name), 'utf8')
    assert.equal(body.includes(first.headers[0].value), false, 'Native runtime store wrapper redacts accidental descriptor echoes')
  }
  for (const optionId of ['allow-second', 'reject-once']) {
    const beforePermissions = events().filter((event) => event.requestId?.startsWith('perm-')).length
    const beforeCalls = calls.length
    const allowed = await acp.promptAcpSession(root, sessionId, 'permission-knowledge-search', undefined, () => current, 9)
    assert.equal(allowed.ok, true)
    const permission = await wait(() => events().filter((event) => event.requestId?.startsWith('perm-'))[beforePermissions], 'knowledge native permission')
    assert.deepEqual(permission.options.map(({ optionId, kind }) => ({ optionId, kind })), [
      { optionId: 'allow-first', kind: 'allow_once' }, { optionId: 'allow-second', kind: 'allow_once' }, { optionId: 'reject-once', kind: 'reject_once' }
    ], 'Redaction must not replace original native permission identities or same-kind options')
    assert.equal(JSON.stringify(permission).includes(first.url), false, 'Live permission display metadata redacts bridge endpoint')
    assert.equal(JSON.stringify(permission).includes(first.headers[0].value), false, 'Live permission display metadata redacts opaque bearer grant')
    assert.equal(stored().includes(first.url), false, 'Pending permission snapshots redact endpoint')
    assert.equal(stored().includes(first.headers[0].value), false, 'Pending permission snapshots redact bearer grant')
    assert.equal(acp.respondAcpPermission(root, permission.requestId, 'not-an-option').code, 'E_INVALID_ARG')
    assert.equal(acp.respondAcpPermission(root, permission.requestId, optionId).ok, true)
    await wait(() => get()?.status === 'ready' && get()?.events.some((event) => event.kind === 'turn-done' && event.turnId === allowed.turnId), 'knowledge native permission result')
    assert.equal(journal().filter((entry) => entry.method === 'permission-decision').at(-1).decision.outcome.optionId, optionId)
    assert.equal(calls.length, beforeCalls + (optionId === 'allow-second' ? 1 : 0), 'Denied native permission must not invoke knowledge read')
  }
  for (const prompt of ['unsafe-permission-tool-id', 'unsafe-permission-option-id']) {
    const beforePermissions = events().filter((event) => event.requestId?.startsWith('perm-')).length
    const beforeCalls = calls.length
    const unsafe = await acp.promptAcpSession(root, sessionId, prompt, undefined, () => current, 9)
    assert.equal(unsafe.ok, true)
    await wait(() => get()?.status === 'ready' && get()?.events.some((event) => event.kind === 'turn-done' && event.turnId === unsafe.turnId), 'unsafe native permission is cancelled')
    assert.equal(journal().filter((entry) => entry.method === 'permission-decision').at(-1).decision.outcome.outcome, 'cancelled', 'Unsafe machine IDs are cancelled, never remapped to another native choice')
    assert.equal(events().filter((event) => event.requestId?.startsWith('perm-')).length, beforePermissions, 'Unsafe IDs never enter live pending-permission IPC')
    assert.equal(get().pendingPermissions?.length ?? 0, 0)
    assert.equal(calls.length, beforeCalls)
    for (const value of [JSON.stringify(events()), JSON.stringify(get()), stored()]) {
      assert.equal(value.includes(first.url), false)
      assert.equal(value.includes(first.headers[0].value), false)
    }
  }
  assert.equal((await acp.killAcpSession(root, sessionId)).ok, true)
  assert.equal((await fetch(first.url, { method: 'POST', headers: { Authorization: first.headers[0].value, 'Content-Type': 'application/json' }, body: '{}' })).status, 401)
  assert.equal((await acp.resumeAcpSession(root, sessionId)).ok, true)
  assert.equal(get().backendSessionId, remote, 'Native restore retains the same backend identity')
  const loaded = journal().find((entry) => entry.method === 'session/load').descriptor
  assert.notEqual(loaded.name, first.name)
  const slow = await acp.promptAcpSession(root, sessionId, 'slow-native-search', undefined, () => current, 9)
  assert.equal(slow.ok, true)
  await wait(() => releaseSlow, 'native slow knowledge read')
  const slowCall = calls.at(-1)
  assert.equal((await acp.cancelAcpSession(root, sessionId)).ok, true)
  assert.equal(slowCall.signal.aborted, true)
  releaseSlow(); releaseSlow = undefined
  await wait(() => get()?.status === 'ready', 'cancelled native turn settles')
  const after = await acp.promptAcpSession(root, sessionId, 'next knowledge turn', undefined, () => current, 10)
  assert.equal(after.ok, true)
  await wait(() => get()?.status === 'ready' && get()?.events.some((event) => event.kind === 'turn-done' && event.turnId === after.turnId), 'next turn on retained native identity')
  assert.equal(get().backendSessionId, remote)
  current = false
  await acp.killAcpSession(root, sessionId)
  for (const mode of ['no-http', 'unknown']) {
    current = true
    const count = calls.length
    const next = await acp.newAcpSession(root, { agentId: `knowledge-${mode}-fixture` })
    assert.equal(next.ok, true)
    const selected = () => acp.listAcpSessions(root).sessions.find((session) => session.sessionId === next.sessionId)
    await wait(() => selected()?.status === 'ready', `${mode} native ordinary session`)
    if (mode === 'no-http') {
      assert.equal(selected().events.some((event) => event.payload?.knowledgeBridge?.state === 'unavailable' && event.payload.knowledgeBridge.detail.includes('HTTP')), true)
      const endpoint = journal().filter((entry) => entry.method === 'session/new' && entry.capabilityMode === mode).at(-1).descriptor
      assert.equal((await fetch(endpoint.url, { method: 'POST', headers: { Authorization: endpoint.headers[0].value, 'Content-Type': 'application/json' }, body: '{}' })).status, 401)
    } else {
      assert.equal(selected().events.some((event) => ['discovered', 'active'].includes(event.payload?.knowledgeBridge?.state)), false)
      assert.equal(selected().events.some((event) => event.payload?.knowledgeBridge?.state === 'attached'), true)
    }
    const ordinary = await acp.promptAcpSession(root, next.sessionId, 'knowledge request without verified knowledge', undefined, () => current, 10)
    assert.equal(ordinary.ok, true)
    await wait(() => selected()?.status === 'ready' && selected()?.events.some((event) => event.kind === 'turn-done' && event.turnId === ordinary.turnId), `${mode} ordinary turn`)
    const actual = journal().filter((entry) => entry.method === 'ordinary-prompt' && entry.capabilityMode === mode).at(-1)
    assert.equal(actual.prompt, 'knowledge request without verified knowledge', 'Bridge availability does not mutate user/native prompt commands')
    assert.equal(calls.length, count, `${mode} negotiation does not fabricate a knowledge read`)
    assert.equal((await acp.killAcpSession(root, next.sessionId)).ok, true)
  }
  console.log('Knowledge ACP controlled peer: actual new/load MCP delivery, no idle reads, captured project/turn generation, source operation records, supplied evidence after response, native IDs, cancel/next-turn, grant revocation and app/runtime history redaction passed. Real Codex/Claude/WeKnora/packaged acceptance remains untested.')
} finally {
  releaseSlow?.()
  await acp?.shutdownAcp()
  if (previousData === undefined) delete process.env.TPAP_SMOKE_DIR; else process.env.TPAP_SMOKE_DIR = previousData
  if (previousJournal === undefined) delete process.env.TRELLIS_KNOWLEDGE_PEER_JOURNAL; else process.env.TRELLIS_KNOWLEDGE_PEER_JOURNAL = previousJournal
  delete globalThis.__KNOWLEDGE_NATIVE_PORT__
  assert.ok(directory.startsWith(join(tmpdir(), 'tpanel-knowledge-native-')))
  rmSync(directory, { recursive: true, force: true })
}

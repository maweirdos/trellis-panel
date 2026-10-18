/** Focused lifecycle regression: local peer only; no UI or vendor/model calls. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { checkAcpxCompatibility } from '../check-acpx-compat.mjs'

await checkAcpxCompatibility()
const directory = mkdtempSync(join(tmpdir(), 'trellis-acp-continuity-'))
const root = join(directory, 'project')
mkdirSync(root)
const previousData = process.env.TPAP_SMOKE_DIR
const previousJournal = process.env.TRELLIS_ACP_FIXTURE_JOURNAL
const previousBlock = process.env.TRELLIS_ACP_FIXTURE_BLOCK_LOAD
process.env.TPAP_SMOKE_DIR = directory
process.env.TRELLIS_ACP_FIXTURE_JOURNAL = join(directory, 'wire.jsonl')
process.env.TRELLIS_ACP_FIXTURE_BLOCK_LOAD = join(directory, 'block-load')
const journal = () => existsSync(join(directory, 'wire.jsonl')) ? readFileSync(join(directory, 'wire.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
const calls = (method) => journal().filter((entry) => entry.method === method)
const events = (channel) => (globalThis.__TPANEL_EVENTS__ ?? []).filter((entry) => entry.channel === channel).map((entry) => entry.payload)
const wait = async (predicate, label) => {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) { const found = predicate(); if (found) return found; await new Promise((resolve) => setTimeout(resolve, 15)) }
  throw new Error(`Deadline: ${label}`)
}
const fixture = { id: 'continuity-fixture', name: 'Fixture', command: 'owned local peer', enabled: true, available: true,
  launchKind: 'custom', executable: process.execPath, args: [resolve('scripts/smoke/acp-mock-agent.mjs'), '--serve', '--categorized-config'] }
const setup = `export const listAcpAgents=async()=>({ok:true,agents:[${JSON.stringify(fixture)}]}); export const launchArgv=async(config)=>[config.executable,...config.args]; export const NATIVE_TOOLS_DIAGNOSTIC='Fixture native tools'; export const setupAcpRuntime=async()=>({ok:false}); export const pickAcpNode=async()=>({ok:false});`
let acp
try {
  await build({ entryPoints: ['src/main/services/acp.ts'], bundle: true, format: 'esm', platform: 'node',
    banner: { js: "import { createRequire as fixtureRequire } from 'node:module'; const require = fixtureRequire(import.meta.url);" },
    alias: { electron: resolve('scripts/smoke/mock-electron.mjs') }, outfile: join(directory, 'service.mjs'),
    plugins: [{ name: 'local-peer-only', setup(builder) {
      builder.onResolve({ filter: /^\.\/acp\/setup$/ }, () => ({ path: 'setup', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: setup, loader: 'js' }))
    } }] })
  acp = await import(pathToFileURL(join(directory, 'service.mjs')).href)
  const created = await acp.newAcpSession(root, { agentId: fixture.id })
  assert.equal(created.ok, true)
  const id = created.sessionId
  const current = () => acp.listAcpSessions(root).sessions.find((session) => session.sessionId === id)
  await wait(() => current()?.status === 'ready', 'new session')
  assert.ok(current().events.filter((event) => event.payload?.observation).every((event) => event.payload.activityScope === 'connection' && event.turnId === undefined))
  const remote = current().backendSessionId
  const firstGeneration = current().connectionGeneration
  const run = async (text, failure = false) => {
    const before = events('acp:permission').length
    const response = await acp.promptAcpSession(root, id, text)
    assert.equal(response.ok, true)
    if (!failure) {
      const permission = await wait(() => events('acp:permission')[before], 'permission')
      assert.equal(acp.respondAcpPermission(root, permission.requestId, 'reject').ok, true)
    }
    await wait(() => events('acp:done').some((event) => event.turnId === response.turnId), 'canonical completion')
    assert.equal(current().status, 'ready', 'Request completion must retain the persistent connection')
  }
  await run('first')
  await run('second')
  const measured = await acp.promptAcpSession(root, id, 'fixture-usage-before-reply')
  assert.equal(measured.ok, true)
  await wait(() => events('acp:done').some((event) => event.turnId === measured.turnId), 'measured model response')
  const measuredEvents = current().events.filter((event) => event.turnId === measured.turnId)
  const usageIndex = measuredEvents.findIndex((event) => event.payload?.tag === 'usage_update')
  const responseIndex = measuredEvents.findIndex((event) => event.payload?.observation?.label === '收到首次模型响应')
  assert.ok(usageIndex >= 0 && responseIndex > usageIndex, 'Usage metadata cannot establish first model response')
  assert.ok(measuredEvents.some((event) => event.text === '开始处理'))
  assert.ok(measuredEvents.some((event) => event.text === '指令已发送至引擎'))
  assert.equal(calls('initialize').length, 1)
  assert.equal(calls('session/load').length, 0)
  assert.equal(calls('session/new').length, 1)
  await run('fixture-provider-error', true)
  assert.ok(current().events.some((event) => event.kind === 'turn-done' && event.text.includes('403')))
  assert.equal((await acp.configureAcpSession(root, id, { kind: 'config', id: 'fixture.model-choice', value: 'large' })).ok, true)
  assert.equal(current().currentModelId, 'large', 'Only acknowledged model choice is displayed')
  await run('after provider rejection')
  assert.equal(calls('initialize').length, 1, 'Failed provider request must not restart the adapter')
  const promptCount = calls('session/prompt').length
  const historyIds = current().events.filter((event) => event.kind === 'message').map((event) => event.id)
  assert.equal((await acp.killAcpSession(root, id)).ok, true)
  const firstRestore = acp.resumeAcpSession(root, id)
  const joinedRestore = acp.resumeAcpSession(root, id)
  assert.equal(firstRestore, joinedRestore, 'Concurrent same-project callers join one connection operation')
  assert.equal((await acp.resumeAcpSession(root + '-foreign', id)).ok, false, 'A foreign root cannot join a trusted in-flight operation')
  const resumed = await Promise.all([firstRestore, joinedRestore])
  assert.ok(resumed.every((response) => response.ok))
  assert.equal(current().status, 'ready', 'Resume must complete native load before reporting success')
  assert.equal(current().restorePending, false)
  assert.equal(calls('session/load').length, 1, 'One eager load, not duplicate owners')
  assert.equal(calls('session/prompt').length, promptCount, 'Eager load must not dispatch a prompt')
  assert.equal(current().backendSessionId, remote)
  assert.notEqual(current().connectionGeneration, firstGeneration)
  assert.equal(current().turnId, undefined, 'Restore cannot inherit the previous user turn identity')
  const restoredConnection = current().events.filter((event) => event.connectionGeneration === current().connectionGeneration)
  assert.ok(restoredConnection.length > 0)
  assert.ok(restoredConnection.every((event) => event.payload?.activityScope === 'connection' && event.turnId === undefined), 'Restoring a process must not create a conversation turn')
  assert.ok(current().startup.every((entry) => !['收到首次响应', '收到首次模型响应'].includes(entry.label)), 'New connection observations do not inherit old turn timings')
  const restoredGeneration = current().connectionGeneration
  assert.equal((await acp.resumeAcpSession(root, id)).ok, true)
  assert.equal(current().connectionGeneration, restoredGeneration)
  assert.equal(calls('session/load').length, 1, 'A ready connection is reused across revisits')
  assert.ok(historyIds.every((eventId) => current().events.some((event) => event.id === eventId)))
  assert.equal(current().currentModelId, 'large', 'Eager restore replays acknowledged preferences')
  await run('resumed first')
  await run('resumed second')
  assert.equal(calls('session/load').length, 1)
  assert.equal(calls('session/new').length, 1, 'Restore never replaces the native conversation')
  assert.equal((await acp.promptAcpSession(root, id, 'stale', { expectedConnectionGeneration: firstGeneration })).ok, false)
  assert.equal((await acp.resumeAcpSession(root + '-foreign', id)).ok, false)
  assert.equal((await acp.killAcpSession(root, id)).ok, true)
  const beforeBlocked = calls('session/prompt').length
  writeFileSync(join(directory, 'block-load'), '')
  const blocked = await acp.resumeAcpSession(root, id)
  assert.equal(blocked.ok, false)
  assert.match(blocked.error, /in use by another/)
  assert.equal(current().backendSessionId, remote)
  assert.equal(calls('session/new').length, 1, 'Failed native load must never fall back to session/new')
  assert.equal(calls('session/prompt').length, beforeBlocked)
  unlinkSync(join(directory, 'block-load'))
  assert.equal((await acp.resumeAcpSession(root, id)).ok, true, 'Failed eager load must release its owned transport for explicit retry')
  await run('after external lock released')
  assert.equal((await acp.killAcpSession(root, id)).ok, true)
  console.log('PASS eager same-session load without prompt, continuous turns on one owner, provider-error recovery, acknowledged models, concurrent restore, blocked native load/retry without replacement, transcript/generation/root guards and cleanup')
} finally {
  if (acp) await acp.shutdownAcp()
  if (previousData === undefined) delete process.env.TPAP_SMOKE_DIR; else process.env.TPAP_SMOKE_DIR = previousData
  if (previousJournal === undefined) delete process.env.TRELLIS_ACP_FIXTURE_JOURNAL; else process.env.TRELLIS_ACP_FIXTURE_JOURNAL = previousJournal
  if (previousBlock === undefined) delete process.env.TRELLIS_ACP_FIXTURE_BLOCK_LOAD; else process.env.TRELLIS_ACP_FIXTURE_BLOCK_LOAD = previousBlock
  delete globalThis.__TPANEL_EVENTS__
  const target = resolve(directory)
  assert.ok(target.startsWith(resolve(tmpdir()) + '\\') || target.startsWith(resolve(tmpdir()) + '/'))
  rmSync(target, { recursive: true, force: true })
}

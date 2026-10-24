/** Actual facade + public acpx + ordinary admission. Only owned local stdio peers. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync, realpathSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createFileSessionStore } from 'acpx/runtime'
import { prepareAcpHistoryWorker } from './prepare-acp-history-worker.mjs'

const temporary = realpathSync.native(mkdtempSync(join(tmpdir(), 'tpanel-admission-recovery-')))
const oldData = process.env.TPAP_SMOKE_DIR
const oldJournal = process.env.TRELLIS_ACP_FIXTURE_JOURNAL
process.env.TPAP_SMOKE_DIR = temporary
const journal = join(temporary, 'peer-requests.jsonl')
process.env.TRELLIS_ACP_FIXTURE_JOURNAL = journal
const root = join(temporary, 'project'); mkdirSync(root)
const checks = [], check = async (name, work) => { await work(); checks.push({ name, status: 'passed' }) }
const wait = async (test, label) => {
  const end = Date.now() + 15000
  while (Date.now() < end) { if (test()) return; await new Promise(done => setTimeout(done, 15)) }
  throw Error('Timeout: ' + label)
}
let actual
try {
  await prepareAcpHistoryWorker(temporary)
  const unused = { './flow': 'export const listFlows=()=>[];', './document-views': 'export const getDocumentViews=()=>null;export const readerMaterialOwner=()=>({});' }
  const req = createRequire(import.meta.url)
  await build({ stdin: { contents: "export * from './src/main/services/acp';export * from './src/main/services/workflow-desktop';export * from './src/main/services/workflow-admission';export {acpDataPath} from './src/main/services/acp/metadata';", loader: 'ts', resolveDir: process.cwd() }, outfile: join(temporary, 'service.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', external: ['better-sqlite3'], alias: { electron: resolve('scripts/smoke/mock-electron.mjs') }, banner: { js: `import{createRequire as fixtureRequire}from'node:module';const require=fixtureRequire(${JSON.stringify(pathToFileURL(resolve('package.json')).href)});` }, plugins: [{ name: 'public-runtime-and-unused-desktop-readers', setup(builder) {
    builder.onResolve({ filter: /^acpx(?:\/.*)?$/ }, args => ({ path: pathToFileURL(req.resolve(args.path)).href, external: true }))
    builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(unused, args.path) ? { path: args.path, namespace: 'unused-desktop' } : null)
    builder.onLoad({ filter: /.*/, namespace: 'unused-desktop' }, args => ({ contents: unused[args.path], loader: 'js' }))
  } }] })
  actual = await import(pathToFileURL(join(temporary, 'service.mjs')).href)
  const facts = id => actual.listOwnedAcpSessionFacts().find(row => row.sessionId === id)
  const requests = () => readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const expectBlocker = process.argv.includes('--expect-blocker')
  let sessionId
  await check('connection and completed ordinary turns release admission for the next explicit turn', async () => {
    const created = await actual.withOrdinaryConnectionAdmission(root, {}, () => actual.newAcpSession(root, { agentId: 'mock' }))
    assert.equal(created.ok, true); sessionId = created.sessionId
    await wait(() => facts(sessionId)?.status === 'ready', 'initial ready')
    for (let i = 0; i < 2; i++) {
      const sent = await actual.withOrdinaryWorkflowAdmission(root, sessionId, facts(sessionId).connectionGeneration, admitted => actual.promptAcpSession(root, sessionId, 'fixture-usage-before-reply', undefined, admitted))
      assert.equal(sent.ok, true)
      await wait(() => facts(sessionId)?.status === 'ready' && !facts(sessionId)?.turnActive, 'turn settled')
    }
  })
  await check(expectBlocker ? 'baseline: actual peer exit deadlocks exact original resume despite released lease and confirmed cleanup' : 'actual peer exit retains protection but the exact original session can explicitly resume without replay', async () => {
    const before = actual.listAcpSessions(root).sessions.find(row => row.sessionId === sessionId)
    const record = await createFileSessionStore({ stateDir: actual.acpDataPath('runtime-store') }).load(before.acpxRecordId)
    assert.ok(record.pid && record.pid !== process.pid)
    process.kill(record.pid) // Only the owned local fixture's recorded peer.
    await wait(() => facts(sessionId)?.status === 'disconnected', 'actual process exit')
    assert.equal(facts(sessionId).leaseHeld, false)
    assert.equal(facts(sessionId).cleanupRequired, false)
    assert.throws(() => actual.claimWorkspaceAdmission(root, 'managed'), error => error.code === 'E_CONFLICT')
    const recover = () => actual.withOrdinaryConnectionAdmission(root, { sessionId }, () => actual.resumeAcpSession(root, sessionId))
    if (expectBlocker) {
      await assert.rejects(recover(), error => error.code === 'E_CONFLICT' && error.message.includes('此工作区已有原生指令或工作流'))
      return
    }
    const beforeRequests = requests()
    const resumed = await recover(); assert.equal(resumed.ok, true)
    assert.equal(facts(sessionId).status, 'ready')
    const after = actual.listAcpSessions(root).sessions.find(row => row.sessionId === sessionId)
    assert.equal(after.backendSessionId, before.backendSessionId)
    assert.notEqual(after.connectionGeneration, before.connectionGeneration)
    assert.equal(requests().filter(row => row.method === 'session/new').length, beforeRequests.filter(row => row.method === 'session/new').length)
    assert.equal(requests().filter(row => row.method === 'session/prompt').length, beforeRequests.filter(row => row.method === 'session/prompt').length)
    assert.ok(requests().filter(row => row.method === 'session/load').length > beforeRequests.filter(row => row.method === 'session/load').length)
    const sent = await actual.withOrdinaryWorkflowAdmission(root, sessionId, facts(sessionId).connectionGeneration, admitted => actual.promptAcpSession(root, sessionId, 'fixture-usage-before-reply', undefined, admitted))
    assert.equal(sent.ok, true)
    await wait(() => facts(sessionId)?.status === 'ready', 'post-recovery turn')
  })
  if (!expectBlocker) await check('a rejected new connection cannot strand a pre-existing disconnected owner behind a targetless token', async () => {
    // Prune only the previous already-idle fixture token before the peer exits.
    const idle = actual.claimWorkspaceAdmission(root, 'ordinary'); idle.release()
    const before = actual.listAcpSessions(root).sessions.find(row => row.sessionId === sessionId)
    const record = await createFileSessionStore({ stateDir: actual.acpDataPath('runtime-store') }).load(before.acpxRecordId)
    assert.ok(record.pid && record.pid !== process.pid)
    process.kill(record.pid)
    await wait(() => facts(sessionId)?.status === 'disconnected', 'second actual peer exit')
    const count = requests().filter(row => ['session/new', 'session/prompt'].includes(row.method)).length
    const rejected = await actual.withOrdinaryConnectionAdmission(root, {}, () => actual.newAcpSession(root, { agentId: 'missing-owned-fixture-runtime' }))
    assert.equal(rejected.ok, false)
    assert.throws(() => actual.claimWorkspaceAdmission(root, 'managed'), error => error.code === 'E_CONFLICT')
    const restored = await actual.withOrdinaryConnectionAdmission(root, { sessionId }, () => actual.resumeAcpSession(root, sessionId))
    assert.equal(restored.ok, true)
    assert.equal(facts(sessionId).status, 'ready')
    assert.equal(actual.listAcpSessions(root).sessions.find(row => row.sessionId === sessionId).backendSessionId, before.backendSessionId)
    assert.equal(requests().filter(row => ['session/new', 'session/prompt'].includes(row.method)).length, count)
    const released = actual.claimWorkspaceAdmission(root, 'managed'); released.release()
  })
  console.log(JSON.stringify({ status: 'passed', baselineBlockerExpected: expectBlocker, checks, scope: 'Actual ACP facade/public runtime/ordinary admission; owned local peer only, no vendor/model/production state.' }, null, 2))
} finally {
  if (actual) { await actual.shutdownAcp(); await actual.stopAcpHistory() }
  if (oldData === undefined) delete process.env.TPAP_SMOKE_DIR; else process.env.TPAP_SMOKE_DIR = oldData
  if (oldJournal === undefined) delete process.env.TRELLIS_ACP_FIXTURE_JOURNAL; else process.env.TRELLIS_ACP_FIXTURE_JOURNAL = oldJournal
  assert.equal(realpathSync.native(dirname(temporary)), realpathSync.native(tmpdir())); assert.ok(basename(temporary).startsWith('tpanel-admission-recovery-'))
  rmSync(temporary, { recursive: true, force: true })
}

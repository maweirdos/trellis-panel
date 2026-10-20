/** Actual public acpx runtime and app facade; temporary data, owned peer, no providers. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { checkAcpxCompatibility } from '../check-acpx-compat.mjs'

await checkAcpxCompatibility()
const temporary = mkdtempSync(join(tmpdir(), 'trellis-acp-recovery-'))
const root = join(temporary, 'project')
mkdirSync(root)
const previousData = process.env.TPAP_SMOKE_DIR
const previousWorker = process.env.TRELLIS_ACP_HISTORY_WORKER_FILE
process.env.TPAP_SMOKE_DIR = temporary
process.env.TRELLIS_ACP_HISTORY_WORKER_FILE = join(temporary, 'history-worker.cjs')
const controlPath = join(temporary, 'peer-control.json')
const journalPath = join(temporary, 'wire.jsonl')
const configurePeer = (changes) => writeFileSync(controlPath, JSON.stringify({ ...JSON.parse(readFileSync(controlPath, 'utf8')), ...changes }))
writeFileSync(controlPath, JSON.stringify({ models: ['small', 'large', 'old-model'], loads: 0 }))
const journal = () => existsSync(journalPath) ? readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
const calls = (method) => journal().filter((entry) => entry.method === method)
const wait = async (predicate, label) => {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  throw new Error(`Deadline: ${label}`)
}
const fixture = { id: 'recovery-fixture', name: 'Recovery fixture', command: 'owned local peer', enabled: true, available: true,
  launchKind: 'custom', executable: process.execPath, args: [resolve('scripts/smoke/acp-recovery-peer.mjs'), controlPath, journalPath] }
const setup = `export const listAcpAgents=async()=>({ok:true,agents:[${JSON.stringify(fixture)}]}); export const launchArgv=async(config)=>[config.executable,...config.args]; export const NATIVE_TOOLS_DIAGNOSTIC='Fixture native tools'; export const setupAcpRuntime=async()=>({ok:false}); export const pickAcpNode=async()=>({ok:false});`
let acp
try {
  await build({ entryPoints: ['src/main/services/acp/history-worker.ts'], bundle: true, format: 'cjs', platform: 'node', outfile: process.env.TRELLIS_ACP_HISTORY_WORKER_FILE })
  const runtimeUrl = pathToFileURL(createRequire(import.meta.url).resolve('acpx/runtime')).href
  await build({ entryPoints: ['src/main/services/acp.ts'], bundle: true, format: 'esm', platform: 'node',
    banner: { js: "import { createRequire as fixtureRequire } from 'node:module'; const require = fixtureRequire(import.meta.url);" },
    alias: { electron: resolve('scripts/smoke/mock-electron.mjs') }, outfile: join(temporary, 'service.mjs'),
    plugins: [{ name: 'local-recovery-fixture', setup(builder) {
      builder.onResolve({ filter: /^\.\/acp\/setup$/ }, () => ({ path: 'setup', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: setup, loader: 'js' }))
      builder.onResolve({ filter: /^acpx\/runtime$/ }, () => ({ path: 'runtime', namespace: 'recovery-runtime' }))
      builder.onResolve({ filter: /^file:/ }, (args) => ({ path: args.path, external: true }))
      builder.onLoad({ filter: /.*/, namespace: 'recovery-runtime' }, () => ({ loader: 'js', contents: `
        export * from ${JSON.stringify(runtimeUrl)};
        import { createAcpRuntime as upstream } from ${JSON.stringify(runtimeUrl)};
        export function createAcpRuntime(options) {
          const runtime = upstream(options), shutdown = runtime.shutdown.bind(runtime);
          runtime.shutdown = async () => {
            if (globalThis.__ACP_RECOVERY_FAIL_CLEANUP__) throw new Error('Owned recovery cleanup failure');
            return shutdown();
          };
          return runtime;
        }` }))
    } }] })
  acp = await import(pathToFileURL(join(temporary, 'service.mjs')).href)
  const created = await acp.newAcpSession(root, { agentId: fixture.id })
  assert.equal(created.ok, true)
  const id = created.sessionId
  const current = () => acp.listAcpSessions(root).sessions.find((session) => session.sessionId === id)
  await wait(() => current()?.status === 'ready', 'initial ready')
  const prompt = await acp.promptAcpSession(root, id, 'Only this explicit prompt may reach the wire')
  assert.equal(prompt.ok, true)
  await wait(() => current()?.status === 'ready', 'prompt completion')
  assert.equal((await acp.configureAcpSession(root, id, { kind: 'model', id: 'old-model' })).ok, true)
  assert.equal((await acp.killAcpSession(root, id)).ok, true)
  const remote = current().backendSessionId
  const promptCount = calls('session/prompt').length
  const newCount = calls('session/new').length
  const historyIds = current().events.filter((event) => event.kind === 'message').map((event) => event.id)
  configurePeer({ models: ['small', 'large'] })
  const failedRestore = await acp.resumeAcpSession(root, id)
  assert.equal(failedRestore.ok, false)
  assert.equal(current().recovery.kind, 'model-unavailable', 'Model classification survives the public cause chain')
  assert.equal(current().connectionOwned, false)
  assert.equal(current().cleanupRequired, false)
  const input = (modelId = 'large') => ({ modelId, expectedConnectionGeneration: current().connectionGeneration })
  assert.equal((await acp.recoverAcpSessionModel(root, id, { ...input(), expectedConnectionGeneration: 'stale' })).code, 'E_CONFLICT')
  assert.equal((await acp.recoverAcpSessionModel(root, id, input('invented-id'))).code, 'E_INVALID_ARG')
  assert.equal((await acp.configureAcpSession(root, id, { kind: 'model', id: 'large' })).ok, false, 'Normal configuration stays ready-only')
  const beforeRecovery = calls('session/load').length
  configurePeer({ delay: 100 })
  const intent = input()
  const recovering = acp.recoverAcpSessionModel(root, id, intent)
  assert.equal(acp.recoverAcpSessionModel(root, id, intent), recovering, 'Same intent joins the exact in-flight promise')
  assert.equal((await acp.recoverAcpSessionModel(root, id, { ...intent, modelId: 'small' })).code, 'E_CONFLICT')
  assert.equal((await acp.recoverAcpSessionModel(root + '-foreign', id, intent)).code, 'E_DENIED')
  assert.equal((await acp.resumeAcpSession(root, id)).code, 'E_CONFLICT')
  const recovered = await recovering
  assert.equal(recovered.ok, true)
  assert.equal(recovered.modelConfirmed, true)
  assert.equal(current().status, 'ready')
  assert.equal(current().currentModelId, 'large')
  assert.equal(current().backendSessionId, remote)
  assert.equal(calls('session/load').length - beforeRecovery, 2, 'Cold acknowledgement and retained connection load the original identity twice')
  assert.equal(current().connectionOwned, true)
  assert.equal(current().cleanupRequired, false)
  assert.ok(historyIds.every((eventId) => current().events.some((event) => event.id === eventId)))
  assert.equal((await acp.killAcpSession(root, id)).ok, true)
  console.log('PASS exact same-session model recovery, structured failure, ready-only normal config, same-intent joining, conflicting/root/stale guards')

  const loads = JSON.parse(readFileSync(controlPath, 'utf8')).loads
  configurePeer({ delay: 0, failLoadAt: loads + 2 })
  const secondFailed = await acp.recoverAcpSessionModel(root, id, input('small'))
  assert.equal(secondFailed.ok, false)
  assert.equal(secondFailed.modelConfirmed, true)
  assert.equal(secondFailed.session.recovery.modelConfirmed, true)
  assert.equal(current().currentModelId, 'small')
  assert.equal(current().status, 'error')
  assert.equal(current().connectionOwned, false)
  assert.equal(current().backendSessionId, remote)
  assert.equal(current().recovery.confirmedModelId, 'small')
  configurePeer({ failLoadAt: undefined })
  assert.equal((await acp.resumeAcpSession(root, id)).ok, true, 'Explicit reconnect reuses the acknowledged preference')
  assert.equal(current().currentModelId, 'small')
  console.log('PASS model acknowledgement survives second-load failure separately from connection readiness')

  // A native advertised ID disappearing is rejected before a replacement reaches the wire.
  assert.equal((await acp.killAcpSession(root, id)).ok, true)
  configurePeer({ models: ['small'] })
  const selections = calls('session/set_config_option').length
  const rejected = await acp.recoverAcpSessionModel(root, id, input('large'))
  assert.equal(rejected.ok, false)
  assert.equal(rejected.modelConfirmed, false)
  assert.equal(current().currentModelId, 'small')
  assert.equal(calls('session/set_config_option').length, selections)
  assert.equal(current().recovery.kind, 'model-unavailable')
  configurePeer({ models: ['small', 'large'] })
  assert.equal((await acp.resumeAcpSession(root, id)).ok, true)
  assert.equal((await acp.killAcpSession(root, id)).ok, true)
  console.log('PASS stale candidate cannot become an effective model or dispatch unadvertised control')

  const prelaunchLoads = calls('session/load').length
  const prelaunchRecovery = acp.recoverAcpSessionModel(root, id, input())
  assert.equal((await acp.killAcpSession(root, id)).ok, true, 'Stop owns recovery admission before a process exists')
  assert.equal((await prelaunchRecovery).ok, false)
  assert.equal(calls('session/load').length, prelaunchLoads)
  assert.equal(current().connectionOwned, false)
  configurePeer({ delay: 500 })
  const loadCount = calls('session/load').length
  const stoppedRecovery = acp.recoverAcpSessionModel(root, id, input())
  await wait(() => calls('session/load').length > loadCount, 'recovery native load started')
  assert.equal((await acp.killAcpSession(root, id)).ok, true)
  assert.equal((await stoppedRecovery).ok, false)
  assert.equal(current().status, 'closed')
  assert.equal(current().connectionOwned, false)
  assert.equal(current().cleanupRequired, false)
  let sourceCurrent = true
  const projectLoadCount = calls('session/load').length
  const projectRecovery = acp.recoverAcpSessionModel(root, id, input('small'), () => sourceCurrent)
  await wait(() => calls('session/load').length > projectLoadCount, 'project-bound recovery load started')
  sourceCurrent = false
  assert.equal((await projectRecovery).ok, false)
  assert.notEqual(current().status, 'ready')
  assert.equal(current().connectionOwned, false)
  console.log('PASS explicit stop and project-generation loss cannot revive a late recovery')

  configurePeer({ delay: 0 })
  assert.equal((await acp.resumeAcpSession(root, id)).ok, true)
  globalThis.__ACP_RECOVERY_FAIL_CLEANUP__ = true
  assert.equal((await acp.killAcpSession(root, id)).ok, false)
  assert.equal(current().connectionOwned, true)
  assert.equal(current().cleanupRequired, true)
  assert.equal((await acp.recoverAcpSessionModel(root, id, input())).ok, false, 'Failed cleanup cannot release ownership for replacement')
  assert.equal(current().connectionOwned, true)
  assert.equal(current().cleanupRequired, true)
  globalThis.__ACP_RECOVERY_FAIL_CLEANUP__ = false
  assert.equal((await acp.killAcpSession(root, id)).ok, true)
  assert.equal(current().connectionOwned, false)
  assert.equal(current().cleanupRequired, false)
  console.log('PASS actual failed cleanup retains ownership and an explicit canonical retry')

  const held = []
  for (let index = 0; index < 4; index++) {
    const next = await acp.newAcpSession(root, { agentId: fixture.id })
    assert.equal(next.ok, true)
    held.push(next.sessionId)
    await wait(() => acp.listAcpSessions(root).sessions.find((session) => session.sessionId === next.sessionId)?.status === 'ready', 'capacity owner ready')
  }
  const capLoads = calls('session/load').length
  assert.equal((await acp.recoverAcpSessionModel(root, id, input())).code, 'E_CONFLICT')
  assert.equal(calls('session/load').length, capLoads)
  assert.equal((await acp.killAcpSession(root, held.pop())).ok, true)
  configurePeer({ delay: 200 })
  const leasedRecovery = acp.recoverAcpSessionModel(root, id, input())
  await wait(() => current().status === 'starting', 'recovery acquired directory lease')
  assert.equal((await acp.promptAcpSession(root, held[0], 'must not dispatch while recovery owns directory')).code, 'E_CONFLICT')
  assert.equal((await leasedRecovery).ok, true)
  assert.equal((await acp.killAcpSession(root, id)).ok, true)
  for (const sessionId of held) assert.equal((await acp.killAcpSession(root, sessionId)).ok, true)
  assert.equal(calls('session/new').length, newCount + 4)
  assert.equal(calls('session/prompt').length, promptCount, 'Recovery dispatches zero prompts')
  assert.ok(calls('session/load').every((entry) => entry.params.sessionId === remote))
  console.log('PASS cap-four admission and recovery directory lease, original wire identity, zero replacement sessions and zero prompt replay')

  configurePeer({ delay: 0 })
  const empty = await acp.newAcpSession(root, { agentId: fixture.id })
  assert.equal(empty.ok, true)
  const emptyCurrent = () => acp.listAcpSessions(root).sessions.find((session) => session.sessionId === empty.sessionId)
  await wait(() => emptyCurrent()?.status === 'ready', 'empty startup ready')
  assert.equal((await acp.killAcpSession(root, empty.sessionId)).ok, true)
  const emptyLoads = calls('session/load').length
  const emptyNews = calls('session/new').length
  assert.equal((await acp.recoverAcpSessionModel(root, empty.sessionId, { modelId: 'large', expectedConnectionGeneration: emptyCurrent().connectionGeneration })).ok, false)
  assert.equal(calls('session/load').length, emptyLoads)
  assert.equal(calls('session/new').length, emptyNews, 'Unprompted startup cannot enter runtime fallback-new recovery')
  console.log('PASS unprompted startup is excluded from model recovery before any native load')
} finally {
  globalThis.__ACP_RECOVERY_FAIL_CLEANUP__ = false
  if (acp) await acp.shutdownAcp()
  if (previousData === undefined) delete process.env.TPAP_SMOKE_DIR
  else process.env.TPAP_SMOKE_DIR = previousData
  if (previousWorker === undefined) delete process.env.TRELLIS_ACP_HISTORY_WORKER_FILE
  else process.env.TRELLIS_ACP_HISTORY_WORKER_FILE = previousWorker
  delete globalThis.__ACP_RECOVERY_FAIL_CLEANUP__
  delete globalThis.__TPANEL_EVENTS__
  const target = resolve(temporary)
  assert.ok(target.startsWith(resolve(tmpdir()) + '\\') || target.startsWith(resolve(tmpdir()) + '/'))
  rmSync(target, { recursive: true, force: true })
}

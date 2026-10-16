/** Integration regressions discovered by review. Owned fixtures only; no vendor/network calls. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createFileSessionStore } from 'acpx/runtime'
import { build } from 'esbuild'

const temporary = mkdtempSync(join(tmpdir(), 'trellis-acp-review-'))
process.env.TPAP_SMOKE_DIR = temporary
const root = join(temporary, 'fixture project')
mkdirSync(root)
const wait = async (predicate, label) => {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timeout: ${label}`)
}
let acp
try {
  const runtimeUrl = pathToFileURL(createRequire(import.meta.url).resolve('acpx/runtime')).href
  const faultInjection = { name: 'owned-cleanup-fault', setup(builder) {
    builder.onResolve({ filter: /^acpx\/runtime$/ }, () => ({ path: 'runtime', namespace: 'review-runtime' }))
    builder.onResolve({ filter: /^file:/ }, args => ({ path: args.path, external: true }))
    builder.onLoad({ filter: /.*/, namespace: 'review-runtime' }, () => ({ loader: 'js', contents: `
      export * from ${JSON.stringify(runtimeUrl)};
      import { createAcpRuntime as upstream } from ${JSON.stringify(runtimeUrl)};
      export function createAcpRuntime(options) {
        const runtime = upstream(options), shutdown = runtime.shutdown.bind(runtime);
        runtime.shutdown = async () => {
          if (globalThis.__ACP_REVIEW_FAIL_CLEANUP__) { globalThis.__ACP_REVIEW_FAIL_CLEANUP__ = false; throw new Error('Owned review fixture cleanup failure'); }
          return shutdown();
        };
        return runtime;
      }` }))
  } }
  await build({ stdin: { contents: `export * from './src/main/services/acp'; export { launchArgv, runtimeDefinitions } from './src/main/services/acp/setup'; export { canonicalDirectory } from './src/main/services/acp/metadata'; export {setSettings} from './src/main/services/store';`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, format: 'esm', platform: 'node',
    banner: { js: "import { createRequire as smokeRequire } from 'node:module'; const require = smokeRequire(import.meta.url);" },
    alias: { electron: resolve('scripts/smoke/mock-electron.mjs') }, plugins: [faultInjection], outfile: join(temporary, 'review.mjs') })
  acp = await import(pathToFileURL(join(temporary, 'review.mjs')).href)
  acp.setSettings({ acp: { nodePath: process.execPath, agents: [] } })
  const managed = acp.runtimeDefinitions().find(item => item.id === 'codex')
  const packageDir = join(temporary, 'acp', 'runtimes', 'codex', '2.2.2', 'node_modules', '@agentclientprotocol', 'codex-acp')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@agentclientprotocol/codex-acp', version: '2.2.2', bin: 'fixture.mjs' }))
  writeFileSync(join(packageDir, 'fixture.mjs'), '// Never executed; managed discovery fixture only.\n')
  const custom = { id: 'codex', name: 'Custom Codex', command: 'user-owned launch', enabled: true, executable: process.execPath, args: ['custom path with spaces.mjs'], launchKind: 'custom' }
  acp.setSettings({ acp: { nodePath: process.execPath, agents: [custom] } })
  assert.deepEqual(await acp.launchArgv(managed), [process.execPath, join(packageDir, 'fixture.mjs')], 'Recorded managed definition ignores subsequent custom override')
  const { launchKind: _legacy, ...legacyManaged } = managed
  assert.deepEqual(await acp.launchArgv(legacyManaged), await acp.launchArgv(managed), 'Exact generated schema-2 definition remains recognized')
  acp.setSettings({ acp: { nodePath: process.execPath, agents: [] } })
  assert.deepEqual(await acp.launchArgv(custom), [process.execPath, ...custom.args], 'Recorded custom definition stays custom after override removal')
  await assert.rejects(acp.launchArgv({ ...managed, command: '@agentclientprotocol/codex-acp@99.0.0' }), /固定版本不可用/)
  console.log('PASS frozen managed/custom launch provenance and conservative legacy recognition')

  const profile = { id: 'review', name: 'Review', description: '', instructions: '', runtimeId: 'mock', cwd: root, maxTurnMinutes: 30 }
  assert.equal(acp.saveAcpProfile(root, profile).ok, true)
  assert.equal(acp.saveAcpProfile(root, { ...profile, cwd: './ambiguous-directory' }).code, 'E_INVALID_ARG')
  assert.equal(acp.listAcpProfiles(root).profiles.find(item => item.id === profile.id).cwd, root)
  const path = join(temporary, 'acp', 'profiles', `${createHash('sha256').update(acp.canonicalDirectory(root)).digest('hex')}.json`)
  const original = JSON.parse(readFileSync(path, 'utf8'))
  original.futureEnvelope = { keep: 'envelope' }
  original.profiles.find(item => item.id === profile.id).futureProfile = { keep: 'profile' }
  writeFileSync(path, JSON.stringify(original))
  assert.equal(acp.saveAcpProfile(root, { ...profile, name: 'Updated' }).ok, true)
  let persisted = JSON.parse(readFileSync(path, 'utf8'))
  assert.deepEqual(persisted.futureEnvelope, original.futureEnvelope)
  const updatedProfile = persisted.profiles.find(item => item.id === profile.id)
  assert.deepEqual(updatedProfile.futureProfile, original.profiles.find(item => item.id === profile.id).futureProfile)
  assert.equal(updatedProfile.name, 'Updated')
  persisted.schemaVersion = 2
  writeFileSync(path, JSON.stringify(persisted))
  const newer = readFileSync(path, 'utf8')
  assert.equal(acp.saveAcpProfile(root, profile).ok, false)
  assert.equal(acp.deleteAcpProfile(root, profile.id).ok, false)
  assert.equal(readFileSync(path, 'utf8'), newer)
  console.log('PASS compatible profile/envelope unknown fields survive updates; newer format remains untouched')

  const historyPath = join(temporary, 'acp-sessions')
  mkdirSync(historyPath, { recursive: true })
  const failedRecord = { schemaVersion: 2, sessionId: 'failed-start', agentId: 'mock', agentName: 'Mock', projectRoot: root, status: 'error', startedAt: 1, events: [], canResume: true, error: 'Owned fixture startup failed' }
  writeFileSync(join(historyPath, 'failed-start.json'), JSON.stringify(failedRecord))
  const failedHistory = acp.listAcpSessions(root).sessions.find(item => item.sessionId === failedRecord.sessionId)
  assert.equal(failedHistory.status, 'error')
  assert.equal(failedHistory.historyKind, 'transcript')
  assert.equal(failedHistory.canResume, false)
  assert.equal(failedHistory.error, failedRecord.error)
  console.log('PASS new failed startup without a wire ID remains failed transcript rather than legacy/resumable')

  const hybridConfig = { id: 'hybrid', name: 'Categorized acknowledgement fixture', command: 'owned fixture', enabled: true, executable: process.execPath, args: [resolve('scripts/smoke/acp-mock-agent.mjs'), '--serve', '--categorized-config'] }
  acp.setSettings({ acp: { nodePath: process.execPath, agents: [hybridConfig] } })
  const hybrid = await acp.newAcpSession(root, { agentId: 'hybrid' })
  assert.equal(hybrid.ok, true)
  const hybridCurrent = () => acp.listAcpSessions(root).sessions.find(item => item.sessionId === hybrid.sessionId)
  await wait(() => hybridCurrent()?.status === 'ready', 'categorized fixture ready')
  assert.equal(hybridCurrent().currentModeId, 'read')
  assert.equal(hybridCurrent().configOptions.find(option => option.id === 'fixture.mode-choice').category, 'mode')
  assert.equal((await acp.configureAcpSession(root, hybrid.sessionId, { kind: 'mode', id: 'edit' })).ok, true)
  assert.equal(hybridCurrent().currentModeId, 'edit')
  const hybridStore = createFileSessionStore({ stateDir: join(temporary, 'acp', 'runtime-store') })
  assert.equal((await hybridStore.load(hybridCurrent().acpxRecordId)).acpx.current_mode_id, 'read', 'Peer deliberately leaves legacy mode stale')
  assert.equal((await acp.configureAcpSession(root, hybrid.sessionId, { kind: 'mode', id: 'invalid' })).ok, false)
  assert.equal(hybridCurrent().currentModeId, 'edit')
  assert.equal((await acp.configureAcpSession(root, hybrid.sessionId, { kind: 'config', id: 'fixture.model-choice', value: 'large' })).ok, true)
  assert.equal(hybridCurrent().currentModelId, 'large')
  assert.equal((await acp.configureAcpSession(root, hybrid.sessionId, { kind: 'config', id: 'fixture.model-choice', value: 'invalid' })).ok, false)
  assert.equal(hybridCurrent().currentModelId, 'large')
  assert.equal(hybridCurrent().currentModeId, 'edit', 'Uncategorized arbitrary id=mode must not change effective mode')
  assert.equal((await acp.killAcpSession(root, hybrid.sessionId)).ok, true)
  acp.setSettings({ acp: { nodePath: process.execPath, agents: [] } })
  console.log('PASS categorized acknowledged mode/model override stale legacy fields, reject invalid changes and ignore arbitrary IDs')

  const created = await acp.newAcpSession(root, { agentId: 'mock' })
  assert.equal(created.ok, true)
  const id = created.sessionId
  const current = () => acp.listAcpSessions(root).sessions.find(item => item.sessionId === id)
  await wait(() => current()?.status === 'ready', 'initial ready')
  assert.equal(current().capabilities.agentInfo.name, 'acp-mock')
  assert.equal(current().capabilities.authMethods[0].id, 'mock-local')
  assert.deepEqual(current().modes.map(mode => mode.id), ['read', 'edit'])
  assert.equal(current().currentModeId, 'read')
  assert.equal((await acp.configureAcpSession(root, id, { kind: 'mode', id: 'edit' })).ok, true)
  assert.equal(current().currentModeId, 'edit')
  assert.equal((await acp.configureAcpSession(root, id, { kind: 'mode', id: 'unknown' })).ok, false)
  assert.equal(current().currentModeId, 'edit')
  console.log('PASS public agent/auth/mode metadata and acknowledged/rejected mode changes reach the application')
  const idlePeer = await acp.newAcpSession(root, { agentId: 'mock' })
  assert.equal(idlePeer.ok, true)
  await wait(() => acp.listAcpSessions(root).sessions.find(item => item.sessionId === idlePeer.sessionId)?.status === 'ready', 'idle lease contender')
  const unfinishedTurn = await acp.promptAcpSession(root, id, 'review-unfinished-tool')
  assert.equal(unfinishedTurn.ok, true)
  await wait(() => current().status === 'ready', 'model turn ended before tool completion')
  assert.match(current().directoryLeaseReason, /未报告完成的工具/)
  assert.equal((await acp.promptAcpSession(root, idlePeer.sessionId, 'must wait for unresolved tool')).code, 'E_CONFLICT')
  assert.equal((await acp.killAcpSession(root, id)).ok, true)
  const afterStop = await acp.promptAcpSession(root, idlePeer.sessionId, 'usable after owner stopped')
  assert.equal(afterStop.ok, true)
  const afterStopPermission = await wait(() => (globalThis.__TPANEL_EVENTS__ ?? []).find(item => item.channel === 'acp:permission' && item.payload.turnId === afterStop.turnId)?.payload, 'lease released after stop')
  acp.respondAcpPermission(root, afterStopPermission.requestId, 'reject')
  await wait(() => acp.listAcpSessions(root).sessions.find(item => item.sessionId === idlePeer.sessionId)?.status === 'ready', 'contender completed')
  assert.equal((await acp.killAcpSession(root, idlePeer.sessionId)).ok, true)
  assert.equal((await acp.resumeAcpSession(root, id)).ok, true)
  console.log('PASS unfinished tool survives partials and model completion, holds lease until canonical stop')
  const ambiguousTurn = await acp.promptAcpSession(root, id, 'review-ambiguous-option-id')
  assert.equal(ambiguousTurn.ok, true)
  const ambiguousPermission = await wait(() => (globalThis.__TPANEL_EVENTS__ ?? []).find(item => item.channel === 'acp:permission' && item.payload.turnId === ambiguousTurn.turnId)?.payload, 'ambiguous permission')
  assert.equal(ambiguousPermission.options.filter(option => option.optionId === 'allow-once').length, 2)
  assert.equal(acp.respondAcpPermission(root, ambiguousPermission.requestId, 'allow-once').code, 'E_INVALID_ARG')
  assert.equal(current().events.some(event => event.payload?.requestId === ambiguousPermission.requestId && event.payload.pending), true)
  await acp.cancelAcpSession(root, id)
  await wait(() => current().status === 'ready', 'ambiguous cancelled')
  console.log('PASS ambiguous duplicate permission ID cannot consume a live request')
  const remote = current().backendSessionId
  globalThis.__ACP_REVIEW_FAIL_CLEANUP__ = true
  assert.equal((await acp.killAcpSession(root, id)).ok, false)
  assert.equal(current().status, 'error')
  assert.equal(current().historyKind, 'live')
  assert.equal((await acp.killAcpSession(root, id)).ok, true)
  assert.equal(current().status, 'closed')
  console.log('PASS failed cleanup keeps its live owner and an explicit second stop retries successfully')
  const resumes = await Promise.all([acp.resumeAcpSession(root, id), acp.resumeAcpSession(root, id)])
  assert.equal(resumes.filter(result => result.ok).length, 1)
  assert.equal(resumes.find(result => !result.ok).code, 'E_CONFLICT')
  assert.equal(current().restorePending, true)
  assert.equal(current().backendSessionId, remote)
  assert.equal(current().capabilities.agentInfo.name, 'acp-mock')
  assert.deepEqual(current().modes.map(mode => mode.id), ['read', 'edit'])
  console.log('PASS concurrent resume reserves one runtime owner and preserves remote identity')

  // Restore a real fixture connection, then terminate only its recorded owned PID.
  const accepted = await acp.promptAcpSession(root, id, 'connect restored fixture')
  assert.equal(accepted.ok, true)
  const permission = await wait(() => (globalThis.__TPANEL_EVENTS__ ?? []).find(item => item.channel === 'acp:permission' && item.payload.turnId === accepted.turnId)?.payload, 'restored permission')
  acp.respondAcpPermission(root, permission.requestId, 'reject')
  await wait(() => current()?.status === 'ready', 'restored turn done')
  const store = createFileSessionStore({ stateDir: join(temporary, 'acp', 'runtime-store') })
  const record = await store.load(current().acpxRecordId)
  assert.ok(record.pid && record.pid !== process.pid)
  process.kill(record.pid)
  await wait(() => current()?.status === 'disconnected', 'idle process exit')
  assert.equal(current().restorePending, false)
  const oldGeneration = current().connectionGeneration
  assert.equal((await acp.resumeAcpSession(root, id)).ok, true)
  assert.equal(current().restorePending, true)
  assert.notEqual(current().connectionGeneration, oldGeneration)
  assert.equal(current().backendSessionId, remote)
  console.log('PASS explicit recovery after idle crash replaces stale owner and enables native continuation')
  await acp.killAcpSession(root, id)

  const raced = acp.resumeAcpSession(root, id)
  await wait(() => current()?.historyKind === 'live', 'restore admitted')
  const stopped = await acp.killAcpSession(root, id)
  await raced
  assert.equal(stopped.ok, true)
  assert.equal(current().status, 'closed')
  assert.equal(existsSync(join(temporary, 'acp-sessions', `${id}.json`)), true)
  console.log('PASS stop racing restore cannot resurrect a closed generation')

  const starting = await acp.newAcpSession(root, { agentId: 'mock' })
  assert.equal(starting.ok, true)
  assert.equal((await acp.cancelAcpSession(root, starting.sessionId)).ok, true)
  await wait(() => acp.listAcpSessions(root).sessions.find(item => item.sessionId === starting.sessionId)?.status === 'closed', 'cancel startup cleanup')
  assert.equal((globalThis.__TPANEL_EVENTS__ ?? []).filter(item => item.channel === 'acp:done' && item.payload.sessionId === starting.sessionId).length, 1)
  console.log('PASS immediate startup cancellation settles once and cannot become ready later')

  for (let index = 0; index < 3; index++) {
    const idle = await acp.newAcpSession(root, { agentId: 'mock' })
    assert.equal(idle.ok, true)
    await wait(() => acp.listAcpSessions(root).sessions.some(item => item.sessionId === idle.sessionId && item.status === 'ready'), 'idle capacity fixture')
  }
  const capped = await Promise.all([acp.resumeAcpSession(root, id), acp.newAcpSession(root, { agentId: 'mock' })])
  assert.equal(capped[0].ok, true)
  assert.equal(capped[1].code, 'E_CONFLICT')
  assert.equal(acp.listAcpSessions(root).sessions.filter(item => item.historyKind === 'live').length, 4)
  console.log('PASS pending restore counts toward managed connection cap before async discovery')
} finally {
  if (acp) await acp.shutdownAcp()
  delete globalThis.__ACP_REVIEW_FAIL_CLEANUP__
  rmSync(temporary, { recursive: true, force: true })
}

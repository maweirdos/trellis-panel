/** Real setup/facade/public acpx; owned peers and stalled discovery subprocesses only. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { prepareAcpHistoryWorker } from './prepare-acp-history-worker.mjs'

const directory = mkdtempSync(join(tmpdir(), 'trellis-runtime-selection-'))
const project = join(directory, 'project with spaces')
mkdirSync(project)
const previous = Object.fromEntries(['TPAP_SMOKE_DIR', 'TRELLIS_ACP_HISTORY_WORKER_FILE', 'NODE_OPTIONS'].map(key => [key, process.env[key]]))
process.env.TPAP_SMOKE_DIR = directory
if (!process.argv.includes('--trellis-role=daemon')) process.argv.push('--trellis-role=daemon')
const pause = ms => new Promise(done => setTimeout(done, ms))
async function until(predicate, label) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await pause(15) }
  throw new Error(`Deadline: ${label}`)
}
// Native session operations include real process ownership checks on Windows.
// Independence is asserted by the held discovery gates and exact call counts.
async function bounded(promise, label, timeoutMs = 15_000) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Deadline: ${label}`)), timeoutMs) })])
  } finally { clearTimeout(timer) }
}

// A genuine Node with an owned npm-cli path lets full discovery reach the registry
// branch even on hosts without npm. The CLI itself is never run/downloaded.
const nodePath = join(directory, 'node install', basename(process.execPath))
const npmCli = join(dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
mkdirSync(dirname(npmCli), { recursive: true })
copyFileSync(process.execPath, nodePath)
writeFileSync(npmCli, 'throw Error("Registry fixture must be intercepted")')
const nativePaths = Object.fromEntries(['opencode', 'dsh'].map(id => {
  const path = join(directory, `${id}.fixture`)
  writeFileSync(path, 'Owned deliberately stalled version executable')
  return [id, path]
}))
nativePaths.zcode = resolve('scripts/smoke/fixtures/zcode-native-peer.mjs')
const calls = []
const stalledNative = []
const stalledRegistry = []
const probePort = (executable, args, options, callback) => {
  calls.push({ executable, args: [...args] })
  if ([nativePaths.opencode, nativePaths.dsh].includes(executable)) {
    stalledNative.push(() => callback(null, '1.0.0', ''))
    return
  }
  if (args[0] === npmCli) {
    stalledRegistry.push(() => callback(new Error('Owned version registry unavailable'), '', ''))
    return
  }
  return execFile(executable, args, options, callback)
}
globalThis.__ACP_SELECTION_EXEC__ = probePort
const unrelatedCalls = () => calls.filter(call => [nativePaths.opencode, nativePaths.dsh].includes(call.executable) || call.args[0] === npmCli)
let acp
let refresh
try {
  await prepareAcpHistoryWorker(directory)
  await build({ stdin: { contents: `export * from './src/main/services/acp'; export {resolveAcpRuntimeLaunch,launchArgv,runtimeDefinitions} from './src/main/services/acp/setup'; export {setSettings} from './src/main/services/store';`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, format: 'esm', platform: 'node', outfile: join(directory, 'service.mjs'),
    banner: { js: "import {createRequire as smokeRequire} from 'node:module'; const require=smokeRequire(import.meta.url);" },
    alias: { electron: resolve('scripts/smoke/mock-electron.mjs') },
    plugins: [{ name: 'owned-discovery-stalls', setup(builder) {
      builder.onResolve({ filter: /^child_process$/ }, args => args.importer.endsWith('/acp/setup.ts') || args.importer.endsWith('\\acp\\setup.ts')
        ? { path: 'probe-exec', namespace: 'selection' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'selection' }, () => ({ contents: 'export const execFile=(...args)=>globalThis.__ACP_SELECTION_EXEC__(...args)' }))
    } }] })
  acp = await import(pathToFileURL(join(directory, 'service.mjs')).href)
  const settings = agents => acp.setSettings({ acp: { nodePath, nativePaths, agents } })
  settings([])

  const resolutionStarted = Date.now()
  const selected = await bounded(acp.resolveAcpRuntimeLaunch('zcode'), 'ZCode resolution', 5_000)
  const resolutionMs = Date.now() - resolutionStarted
  assert.ok(!('ok' in selected), selected.error)
  assert.equal(selected.config.launchKind, 'bundled')
  assert.equal(selected.argv[0], nodePath)
  assert.equal(selected.argv[selected.argv.indexOf('--zcode-bin') + 1], nativePaths.zcode)
  assert.equal(calls.filter(call => call.args[0] === '--version').length, 1, 'One real Node version check; no optional CLI version launch')
  assert.equal(calls.filter(call => call.args.includes('--input-type=module')).length, 1, 'Actual SQLite check runs once')
  assert.equal(unrelatedCalls().length, 0)
  assert.equal((await acp.resolveAcpRuntimeLaunch('missing-engine')).code, 'E_INVALID_ARG')
  assert.equal((await acp.resolveAcpRuntimeLaunch('codex')).code, 'E_INVALID_ARG', 'Missing pinned adapter remains rejected')
  assert.equal(existsSync(join(directory, 'acp', 'runtimes')), false, 'No hidden installation')
  console.log(`PASS fresh selected ZCode checks real Node/SQLite/entry/CLI once without unrelated probes or registry calls (${resolutionMs}ms fixture preflight)`)

  // The selected configuration is read on every request, even after successful resolution.
  acp.setSettings({ acp: { nodePath: join(directory, 'missing-node') } })
  assert.equal((await acp.newAcpSession(project, { agentId: 'zcode' })).code, 'E_INVALID_ARG')
  settings([])
  process.env.NODE_OPTIONS = '--no-experimental-sqlite'
  const sqliteFailure = await acp.newAcpSession(project, { agentId: 'zcode' })
  assert.equal(sqliteFailure.code, 'E_INVALID_ARG')
  assert.match(sqliteFailure.error, /node:sqlite/)
  if (previous.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS
  else process.env.NODE_OPTIONS = previous.NODE_OPTIONS
  const priorCwd = process.cwd()
  try {
    process.chdir(directory) // Mock Electron's app path now has no bundled adapter.
    const missingAdapter = await acp.resolveAcpRuntimeLaunch('zcode')
    assert.equal(missingAdapter.code, 'E_INVALID_ARG')
    assert.match(missingAdapter.error, /适配器文件缺失/)
  } finally { process.chdir(priorCwd) }
  const invalid = { id: 'invalid', name: 'Invalid', command: 'fixture', enabled: true, executable: join(directory, 'missing-executable') }
  settings([invalid, { ...invalid, id: 'disabled', enabled: false }, { id: 'empty-shell', name: 'Empty', command: ' ', enabled: true }])
  for (const agentId of ['invalid', 'disabled', 'empty-shell']) assert.equal((await acp.newAcpSession(project, { agentId })).code, 'E_INVALID_ARG')
  assert.equal(acp.listAcpSessions(project).sessions.length, 0, 'Failed selected preflight never publishes a session')
  assert.equal(unrelatedCalls().length, 0)
  console.log('PASS changed/missing selected Node, missing SQLite, missing adapter/executable, disabled and empty commands reject without fallback')

  settings([])
  // Prove that an already running full refresh (including unavailable registry)
  // cannot become a launch cache or a dependency of new/resume/recovery.
  let refreshed = false
  refresh = acp.listAcpAgents(true).then(result => { refreshed = true; return result })
  await until(() => stalledNative.length === 2, 'unrelated version processes deliberately stalled')
  assert.equal(refreshed, false)
  const beforeLaunch = unrelatedCalls().length
  const isolated = join(directory, 'isolated-zcode')
  const zcodeProfile = { id: 'zcode-isolated', name: 'Isolated ZCode', description: '', instructions: '', runtimeId: 'zcode', maxTurnMinutes: 30,
    args: [{ name: '--isolated', value: isolated }] }
  assert.equal(acp.saveAcpProfile(project, zcodeProfile).ok, true)
  const zcode = await bounded(acp.newAcpSession(project, { agentId: 'codex', profileId: zcodeProfile.id }), 'selected ZCode facade admission')
  assert.equal(zcode.ok, true, zcode.error)
  const current = id => acp.listAcpSessions(project).sessions.find(session => session.sessionId === id)
  await until(() => current(zcode.sessionId)?.status === 'ready', 'actual bundled adapter/native peer ready')
  assert.equal(current(zcode.sessionId).agentId, 'zcode', 'Profile runtime overrides the chooser')
  assert.equal(current(zcode.sessionId).backendSessionId, 'sess_owned_zcode')
  assert.equal(refreshed, false, 'Native readiness completed while unrelated versions remain stalled')
  assert.equal(unrelatedCalls().length, beforeLaunch)
  assert.equal((await acp.killAcpSession(project, zcode.sessionId)).ok, true)
  console.log('PASS actual facade/public acpx/bundled ZCode reaches native readiness while unrelated full refresh is stalled')

  // Release version probes into a deliberately unavailable registry, keeping the
  // full refresh pending across the following exact facade restore/recovery paths.
  while (stalledNative.length) stalledNative.shift()()
  await until(() => stalledRegistry.length === 2, 'unavailable registry requests held')
  const beforeCustom = unrelatedCalls().length
  const control = join(directory, 'control.json')
  const journal = join(directory, 'wire.jsonl')
  const capture = join(directory, 'profile.json')
  const entry = join(directory, 'custom peer.mjs')
  writeFileSync(control, JSON.stringify({ models: ['small', 'large'], loads: 0 }))
  writeFileSync(entry, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),marker:process.env.SELECTION_MARKER}));await import(${JSON.stringify(pathToFileURL(resolve('scripts/smoke/acp-recovery-peer.mjs')).href)})`)
  const custom = { id: 'custom-peer', name: 'Custom', command: 'owned peer', enabled: true, executable: process.execPath, args: [entry, control, journal] }
  const profile = { id: 'custom-profile', name: 'Custom profile', description: '', instructions: '', runtimeId: custom.id, maxTurnMinutes: 30,
    env: [{ key: 'SELECTION_MARKER', value: 'profile environment' }], args: [{ name: '--marker', value: 'argument with spaces' }] }
  assert.equal(acp.saveAcpProfile(project, profile).ok, true)
  settings([custom])
  const created = await bounded(acp.newAcpSession(project, { agentId: 'zcode', profileId: profile.id }), 'custom/profile launch')
  assert.equal(created.ok, true, created.error)
  const id = created.sessionId
  await until(() => current(id)?.status === 'ready', 'custom peer ready')
  const wire = () => readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), { args: [control, journal, '--marker', 'argument with spaces'], marker: 'profile environment' })
  const prompt = await acp.promptAcpSession(project, id, 'Only this explicit fixture prompt')
  assert.equal(prompt.ok, true)
  await until(() => current(id)?.events.some(event => event.kind === 'turn-done' && event.turnId === prompt.turnId), 'actual prompt completed')
  assert.equal((await acp.killAcpSession(project, id)).ok, true)
  // A changed current definition affects new sessions, never the saved launch snapshot.
  settings([{ ...custom, executable: join(directory, 'changed-missing-peer') }])
  assert.equal((await acp.newAcpSession(project, { agentId: custom.id })).code, 'E_INVALID_ARG')
  const backend = current(id).backendSessionId
  assert.equal((await bounded(acp.resumeAcpSession(project, id), 'same-native-session resume')).ok, true)
  assert.equal(current(id).backendSessionId, backend)
  assert.equal((await acp.killAcpSession(project, id)).ok, true)
  const generation = current(id).connectionGeneration
  const recovered = await bounded(acp.recoverAcpSessionModel(project, id, { modelId: 'large', expectedConnectionGeneration: generation }), 'same-native-session model recovery')
  assert.equal(recovered.ok, true, recovered.error)
  assert.equal(recovered.modelConfirmed, true)
  assert.equal(current(id).currentModelId, 'large')
  assert.equal(current(id).backendSessionId, backend)
  assert.equal(wire().filter(call => call.method === 'session/new').length, 1)
  assert.equal(wire().filter(call => call.method === 'session/prompt').length, 1, 'No automatic prompt replay')
  assert.ok(wire().some(call => call.method === 'session/load'))
  assert.equal(unrelatedCalls().length, beforeCustom, 'No additional native or registry discovery on new/resume/model recovery')
  assert.equal(refreshed, false)
  assert.equal((await acp.killAcpSession(project, id)).ok, true)
  console.log('PASS real custom/profile/env/argv launch, current-config invalidation and frozen same-session resume/model recovery without registry work')

  const brokenEntry = join(directory, 'broken-wire.mjs')
  writeFileSync(brokenEntry, 'process.exit(1)')
  settings([{ ...custom, id: 'zcode', args: [brokenEntry] }])
  const override = await acp.resolveAcpRuntimeLaunch('zcode')
  assert.ok(!('ok' in override), override.error)
  assert.equal(override.config.launchKind, 'custom', 'Explicit preset override keeps its own launch kind')
  assert.deepEqual(override.argv, [process.execPath, brokenEntry])
  const broken = await bounded(acp.newAcpSession(project, { agentId: 'zcode' }), 'invalid protocol admission')
  assert.equal(broken.ok, true, 'Executable preflight alone does not establish native readiness')
  await until(() => current(broken.sessionId)?.status === 'error', 'actual failed native startup')
  assert.equal(current(broken.sessionId).canResume, false)
  assert.equal(current(broken.sessionId).backendSessionId, undefined, 'No fallback native session')
  assert.equal(unrelatedCalls().length, beforeCustom)
  console.log('PASS explicit preset custom override and failed native startup remain truthful without fallback')

  while (stalledRegistry.length) stalledRegistry.shift()()
  const refreshedAgents = (await refresh).agents
  assert.equal(refreshed, true)
  for (const native of ['opencode', 'dsh']) {
    const status = refreshedAgents.find(agent => agent.id === native)
    assert.equal(status.adapterVersion, '1.0.0')
    assert.equal(status.latestVersion, undefined, 'Unavailable registry stays unknown')
  }
  const cached = await acp.listAcpAgents()
  assert.deepEqual(cached.agents, refreshedAgents, 'Settings full-discovery cache remains independent')
  const legacy = { ...custom, executable: undefined, args: undefined, command: 'owned command "argument with spaces"' }
  const argv = await acp.launchArgv(legacy)
  assert.equal(argv.at(-1), legacy.command, 'Legacy command remains one shell expression')
  console.log('PASS explicit full refresh/version diagnostics/cache and legacy shell command boundaries remain functional')
} finally {
  // Release only owned injected callbacks before draining runtime/history workers.
  while (stalledNative.length) stalledNative.shift()()
  await pause(20)
  while (stalledRegistry.length) stalledRegistry.shift()()
  await refresh?.catch(() => {})
  await acp?.shutdownAcp()
  delete globalThis.__ACP_SELECTION_EXEC__
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  const target = resolve(directory)
  assert.ok(target.startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')) && basename(target).startsWith('trellis-runtime-selection-'))
  rmSync(target, { recursive: true, force: true })
}

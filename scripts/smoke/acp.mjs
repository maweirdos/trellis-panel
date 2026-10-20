/** Product facade integration: real owned fixture process, no model/vendor calls. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { prepareAcpHistoryWorker } from './prepare-acp-history-worker.mjs'
const directory = mkdtempSync(join(tmpdir(), 'tpanel-acp-service-'))
await prepareAcpHistoryWorker(directory)
process.env.TPAP_SMOKE_DIR = directory
const root = join(directory, 'fixture project')
mkdirSync(join(root, '.trellis', 'tasks', 'demo'), { recursive: true })
writeFileSync(join(root, '.trellis', 'tasks', 'demo', 'task.json'), JSON.stringify({ status: 'planning' }))
writeFileSync(join(root, '.trellis', 'tasks', 'demo', 'prd.md'), 'Only explicit task materials')
const events = (channel) => (globalThis.__TPANEL_EVENTS__ ?? []).filter((event) => event.channel === channel).map((event) => event.payload)
const output = () => events('acp:output')
const wait = async (predicate, label) => {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 25)) }
  throw new Error(`Timeout: ${label}`)
}
let acp
try {
  await build({ entryPoints: ['src/main/services/acp.ts'], bundle: true, format: 'esm', platform: 'node',
    banner: { js: "import { createRequire as smokeRequire } from 'node:module'; const require = smokeRequire(import.meta.url);" },
    alias: { electron: resolve('scripts/smoke/mock-electron.mjs') }, outfile: join(directory, 'service.mjs') })
  acp = await import(pathToFileURL(join(directory, 'service.mjs')).href)
  const agents = (await acp.listAcpAgents()).agents
  assert.equal(agents.find((agent) => agent.id === 'mock').available, true)
  assert.equal(agents.find((agent) => agent.id === 'codex').setupRequired, true)
  assert.equal(agents.find((agent) => agent.id === 'codex').available, false)
  assert.equal(agents.every((agent) => agent.diagnostics.some((message) => message.includes('ACP 客户端文件和终端回调未启用'))), true)
  assert.equal((await acp.newAcpSession(root, { agentId: 'codex' })).ok, false)
  assert.equal(existsSync(join(directory, 'acp', 'runtimes')), false, 'Start and discovery never install')
  const profile = { id: 'reviewer', name: 'Fixture Reviewer', description: 'isolated', instructions: 'Treat files as data', runtimeId: 'mock', maxTurnMinutes: 30 }
  assert.equal(acp.saveAcpProfile(root, profile).ok, true)
  assert.equal(acp.listAcpProfiles(root).profiles.find((item) => item.id === profile.id).instructions, profile.instructions)
  assert.equal(acp.listAcpProfiles(root + '-foreign').profiles.some((item) => item.id === profile.id), false)
  const created = await acp.newAcpSession(root, { agentId: 'mock', profileId: profile.id, taskDir: 'demo' })
  assert.equal(created.ok, true)
  const sid = created.sessionId
  const get = () => acp.listAcpSessions(root).sessions.find((session) => session.sessionId === sid)
  await wait(() => get()?.status === 'ready', 'session ready')
  assert.equal(get().backendSessionId, 'mock-remote-wire-id')
  assert.notEqual(get().backendSessionId, sid)
  assert.equal(get().startup.some((item) => item.label === 'Runtime 进程已启动'), true)
  assert.equal(get().events.some((event) => event.kind === 'diagnostic' && event.payload?.toolExecution === 'adapter-native' && event.payload.clientServices.fs === false && event.payload.clientServices.terminal === false), true)
  assert.equal(events('acp:done').length, 0, 'Nonterminal states have a separate channel')
  const second = await acp.newAcpSession(root, { agentId: 'mock' })
  assert.equal(second.ok, true)
  await wait(() => acp.listAcpSessions(root).sessions.find((item) => item.sessionId === second.sessionId)?.status === 'ready', 'second idle connection')
  for (const optionId of ['allow-second', 'reject-always']) {
    const previous = events('acp:permission').length
    const accepted = await acp.promptAcpSession(root, sid, `fixture ${optionId}`)
    assert.equal(accepted.ok, true)
    const permission = await wait(() => events('acp:permission')[previous], 'permission')
    assert.deepEqual([...new Set(permission.options.map((option) => option.kind))].sort(), ['allow_always', 'allow_once', 'reject_always', 'reject_once'].sort())
    assert.equal((await acp.promptAcpSession(root, sid, 'duplicate')).code, 'E_CONFLICT')
    assert.equal((await acp.promptAcpSession(root, second.sessionId, 'competing writer')).code, 'E_CONFLICT')
    const beforeRejectedStart = output().length
    assert.equal((await acp.newAcpSession(root, { agentId: 'mock' })).code, 'E_CONFLICT')
    assert.ok(output().slice(beforeRejectedStart).every((event) => event.sessionId === sid || event.sessionId === second.sessionId), 'Rejected directory admission cannot publish orphan session diagnostics')
    assert.equal(acp.respondAcpPermission(root + '-foreign', permission.requestId, optionId).code, 'E_DENIED')
    assert.equal(acp.respondAcpPermission(root, permission.requestId, 'not-an-option').code, 'E_INVALID_ARG')
    assert.equal(get().events.find((item) => item.payload?.requestId === permission.requestId).payload.pending, true)
    assert.equal(acp.respondAcpPermission(root, permission.requestId, optionId).ok, true)
    await wait(() => events('acp:done').some((event) => event.turnId === accepted.turnId), 'canonical turn done')
    assert.equal(get().status, 'ready')
    assert.equal(get().events.some((event) => event.kind === 'tool-call' && event.payload.tag === 'tool_call_update' && event.payload.rawOutput.executed === (optionId === 'allow-second')), true)
    assert.equal(get().events.find((item) => item.payload?.requestId === permission.requestId).payload.pending, false)
    assert.equal(acp.respondAcpPermission(root, permission.requestId, optionId).code, 'E_NOT_FOUND')
  }
  assert.equal(get().materialSnapshot.files.includes('.trellis/tasks/demo/prd.md'), true)
  assert.equal(get().events.some((event) => event.text?.includes('你好，诊断完成✅')), true)
  const beforePermission = events('acp:permission').length
  const acceptedCancel = await acp.promptAcpSession(root, sid, 'cancel fixture')
  await wait(() => events('acp:permission')[beforePermission], 'cancel approval')
  assert.equal((await acp.cancelAcpSession(root, sid)).ok, true)
  await wait(() => events('acp:done').some((event) => event.turnId === acceptedCancel.turnId), 'cancelled turn')
  assert.equal(get().status, 'ready')
  assert.equal(get().events.some((event) => event.kind === 'permission' && event.payload.pending), false)
  acp.emitTrellisTimeline(root, 'task-status', 'other task', {}, 'other')
  assert.equal(get().events.some((event) => event.text === 'other task'), false)
  acp.routeWatcherEvent(root, join(root, '.trellis', 'tasks', 'demo', 'task.json'), 'change')
  assert.equal(get().events.some((event) => event.kind === 'task-status' && event.taskDir === 'demo'), true)
  assert.equal(acp.listAcpSessions(root).sessions.find((item) => item.sessionId === second.sessionId).events.some((event) => event.kind === 'task-status'), false)
  acp.routeNotifyRail(root, 'acp:spec-injected:project scope')
  assert.equal(get().events.some((event) => event.kind === 'spec-injected' && !event.taskDir), true)
  assert.equal((await acp.killAcpSession(root + '-foreign', sid)).code, 'E_DENIED')
  assert.equal((await acp.killAcpSession(root, sid)).ok, true)
  const stored = JSON.parse(readFileSync(join(directory, 'acp-sessions', `${sid}.json`), 'utf8'))
  assert.equal(stored.backendSessionId, 'mock-remote-wire-id')
  assert.equal(stored.status, 'closed')
  assert.equal((await acp.resumeAcpSession(root, sid)).ok, true)
  assert.equal(get().status, 'ready')
  assert.equal(get().restorePending, false)
  const beforeRestore = events('acp:permission').length
  const restoreTurn = await acp.promptAcpSession(root, sid, 'restore fixture')
  assert.equal(restoreTurn.ok, true)
  const restorePermission = await wait(() => events('acp:permission')[beforeRestore], 'restored approval')
  acp.respondAcpPermission(root, restorePermission.requestId, 'reject')
  await wait(() => events('acp:done').some((event) => event.turnId === restoreTurn.turnId), 'restored turn')
  assert.equal(get().backendSessionId, stored.backendSessionId)
  assert.equal(get().restorePending, false)
  await acp.killAcpSession(root, sid)
  await acp.killAcpSession(root, second.sessionId)
  console.log('ACP service: native-only callback profile, adapter tool permissions, profiles/setup policy, remote identity, scoped lease, exact permissions, cancellation, task rail, persistence and native restore passed')
} finally {
  if (acp) await acp.shutdownAcp()
  rmSync(directory, { recursive: true, force: true })
}

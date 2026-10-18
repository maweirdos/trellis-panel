/** Main-boundary project isolation. Renderer async/early-event coverage lives in acp-ui.mjs. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const directory = mkdtempSync(join(tmpdir(), 'tpanel-acp-scope-'))
process.env.TPAP_SMOKE_DIR = directory
const projectA = join(directory, 'project-a')
const projectB = join(directory, 'project-b')
for (const root of [projectA, projectB]) {
  mkdirSync(join(root, '.trellis', 'tasks', 'same-task'), { recursive: true })
  writeFileSync(join(root, '.trellis', 'tasks', 'same-task', 'task.json'), '{}')
}
const wait = async (predicate, label) => {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 25)) }
  throw new Error(`Timeout: ${label}`)
}
const events = (channel) => (globalThis.__TPANEL_EVENTS__ ?? []).filter((event) => event.channel === channel).map((event) => event.payload)
let acp
try {
  await build({ entryPoints: ['src/main/services/acp.ts'], bundle: true, format: 'esm', platform: 'node',
    banner: { js: "import { createRequire as smokeRequire } from 'node:module'; const require = smokeRequire(import.meta.url);" },
    alias: { electron: resolve('scripts/smoke/mock-electron.mjs') }, outfile: join(directory, 'service.mjs') })
  acp = await import(pathToFileURL(join(directory, 'service.mjs')).href)
  const a = await acp.newAcpSession(projectA, { agentId: 'mock', taskDir: 'same-task' })
  const b = await acp.newAcpSession(projectB, { agentId: 'mock', taskDir: 'same-task' })
  assert.equal(a.ok, true); assert.equal(b.ok, true)
  const current = (root, id) => acp.listAcpSessions(root).sessions.find((session) => session.sessionId === id)
  await wait(() => current(projectA, a.sessionId)?.status === 'ready' && current(projectB, b.sessionId)?.status === 'ready', 'both sessions ready')
  const historyDir = join(directory, 'acp-sessions')
  const record = (sessionId, projectRoot, startedAt = 1, events = [], status = 'closed') => ({ sessionId, projectRoot, startedAt, events, taskDir: 'same-task', agentId: 'mock', agentName: 'Mock', status })
  writeFileSync(join(historyDir, 'old-a.json'), JSON.stringify(record('old-a', projectA)))
  for (let i = 0; i < 25; i++) writeFileSync(join(historyDir, `new-b-${i}.json`), JSON.stringify(record(`new-b-${i}`, projectB, 100 + i)))
  assert.ok(acp.listAcpSessions(projectA).sessions.some((session) => session.sessionId === 'old-a'))
  assert.ok(acp.listAcpSessions(projectA).sessions.every((session) => session.projectRoot === projectA))
  assert.equal(acp.listAcpSessions(projectB, 1).sessions.length, 2)
  assert.equal(acp.listAcpSessions('').sessions.length, 0)
  assert.equal(acp.listAcpSessions(projectA + '-extra').sessions.length, 0)
  if (process.platform === 'win32') assert.equal(acp.listAcpSessions(projectA.replaceAll('\\', '/').toUpperCase() + '/').sessions.length, acp.listAcpSessions(projectA).sessions.length)
  assert.equal((await acp.promptAcpSession(projectB, a.sessionId, 'foreign')).code, 'E_DENIED')
  assert.equal((await acp.cancelAcpSession(projectB, a.sessionId)).code, 'E_DENIED')
  assert.equal((await acp.killAcpSession(projectB, a.sessionId)).code, 'E_DENIED')
  assert.equal((await acp.configureAcpSession(projectB, a.sessionId, { kind: 'mode', id: 'edit' })).code, 'E_DENIED')
  assert.equal((await acp.resumeAcpSession(projectB, a.sessionId)).code, 'E_DENIED')
  assert.equal((await acp.newAcpSession(projectA, { agentId: 'mock', taskDir: '..' })).code, 'E_INVALID_ARG')
  assert.equal((await acp.newAcpSession(projectA, { agentId: 'mock', taskDir: 'foreign-task' })).code, 'E_INVALID_ARG')
  const accepted = await acp.promptAcpSession(projectA, a.sessionId, 'scope fixture')
  assert.equal(accepted.ok, true)
  const permission = await wait(() => events('acp:permission').find((entry) => entry.sessionId === a.sessionId), 'approval')
  const pending = current(projectA, a.sessionId).events.find((event) => event.payload?.requestId === permission.requestId)
  assert.equal(pending.payload.pending, true)
  assert.equal(acp.respondAcpPermission(projectB, permission.requestId, 'allow-once').code, 'E_DENIED')
  assert.equal(acp.respondAcpPermission(projectA, permission.requestId, 'invalid').code, 'E_INVALID_ARG')
  assert.equal(current(projectA, a.sessionId).events.find((event) => event.id === pending.id).payload.pending, true)
  assert.equal(acp.respondAcpPermission(projectA, permission.requestId, 'reject-always').ok, true)
  await wait(() => events('acp:done').some((event) => event.turnId === accepted.turnId), 'turn done')
  assert.equal(current(projectA, a.sessionId).events.find((event) => event.id === pending.id).payload.pending, false)
  writeFileSync(join(historyDir, 'stale-a.json'), JSON.stringify(record('stale-a', projectA, 2, [{ ...pending, payload: { ...pending.payload, pending: true }, sessionId: 'stale-a' }], 'busy')))
  const stale = current(projectA, 'stale-a')
  assert.equal(stale.status, 'legacy')
  assert.equal(stale.historyKind, 'legacy')
  assert.equal(stale.events[0].payload.pending, false)
  assert.equal(stale.canResume, false)
  assert.equal((await acp.resumeAcpSession(projectA, 'stale-a')).ok, false)
  const nativeSetTimeout = globalThis.setTimeout
  const timers = []
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = nativeSetTimeout(callback, delay, ...args)
    if (delay === 120000) timers.push({ callback, timer })
    return timer
  }
  try {
    const timeout = await acp.promptAcpSession(projectA, a.sessionId, 'timeout fixture')
    await wait(() => timers[0], 'approval timer')
    clearTimeout(timers[0].timer); timers[0].callback()
    await wait(() => events('acp:done').some((event) => event.turnId === timeout.turnId), 'timeout canonical completion')
    assert.equal(current(projectA, a.sessionId).events.some((event) => event.payload?.outcome === 'timeout'), true)
    assert.equal(current(projectA, a.sessionId).events.some((event) => event.kind === 'permission' && event.payload?.pending), false)
  } finally { globalThis.setTimeout = nativeSetTimeout; for (const item of timers) clearTimeout(item.timer) }
  await acp.killAcpSession(projectA, a.sessionId)
  assert.equal(current(projectB, b.sessionId).status, 'ready', 'Unrelated project remains connected')
  await acp.killAcpSession(projectB, b.sessionId)

  const handlers = new Map()
  globalThis.__ACP_IPC_SCOPE__ = { root: projectA, handlers, calls: [] }
  const methodNames = ['listAcpSessions', 'cancelAcpSession', 'killAcpSession', 'listAcpAgents', 'newAcpSession', 'promptAcpSession', 'respondAcpPermission', 'listAcpProfiles', 'saveAcpProfile', 'deleteAcpProfile', 'setupAcpRuntime', 'pickAcpNode', 'resumeAcpSession', 'configureAcpSession', 'bindAcpSessionTask']
  const mocks = {
    '../state': 'export const getProjectRoot = () => globalThis.__ACP_IPC_SCOPE__.root; export const getProjectGeneration = () => globalThis.__ACP_IPC_SCOPE__.generation ?? 1;',
    './registry': 'export const handle = (key, fn) => globalThis.__ACP_IPC_SCOPE__.handlers.set(key, fn)',
    '../services/acp': methodNames.map((name) => `export const ${name} = (...args) => {globalThis.__ACP_IPC_SCOPE__.calls.push({name:'${name}',args});return {ok:true}};`).join('\n')
  }
  await build({ entryPoints: ['src/main/ipc/acp.ts'], bundle: true, format: 'esm', platform: 'node', outfile: join(directory, 'ipc.mjs'), plugins: [{ name: 'scope-mocks', setup(builder) {
    builder.onResolve({ filter: /.*/ }, (args) => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'mock' } : undefined)
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({ contents: mocks[args.path], loader: 'js' }))
  } }] })
  const ipc = await import(pathToFileURL(join(directory, 'ipc.mjs')).href)
  ipc.registerAcpIpc()
  for (const [channel, args] of [
    ['acp:sessions', [7]], ['acp:session.new', [{ agentId: 'mock' }]], ['acp:session.prompt', ['s', 'text']],
    ['acp:session.cancel', ['s']], ['acp:session.kill', ['s']], ['acp:permission.respond', ['p', 'allow']],
    ['acp:profiles', []], ['acp:profile.save', [{}]], ['acp:profile.delete', ['id']], ['acp:session.resume', ['s']], ['acp:session.configure', ['s', {}]], ['acp:session.bind-task', ['s', { taskDir: null, expectedConnectionGeneration: 'g' }]]
  ]) {
    handlers.get(channel)(null, ...args)
    assert.equal(globalThis.__ACP_IPC_SCOPE__.calls.at(-1).args[0], projectA, `Current root injected for ${channel}`)
  }
  globalThis.__ACP_IPC_SCOPE__.root = null
  assert.equal(handlers.get('acp:sessions')(null).code, 'E_NO_PROJECT')
  handlers.get('acp:session.prompt')(null, 's', 'text')
  assert.equal(globalThis.__ACP_IPC_SCOPE__.calls.at(-1).args[0], '')
  console.log('ACP project scope: canonical lists/history, all action ownership, stale/invalid/timed-out approvals, task validation and IPC injection passed')
} finally {
  if (acp) await acp.shutdownAcp()
  delete globalThis.__ACP_IPC_SCOPE__
  rmSync(directory, { recursive: true, force: true })
}

import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const work = mkdtempSync(join(tmpdir(), 'tpanel-app-access-'))
const profile = join(work, 'profile')
const project = join(work, 'project with spaces-应用')
const install = join(work, 'appData')
mkdirSync(profile, { recursive: true })
mkdirSync(project, { recursive: true })
mkdirSync(install, { recursive: true })
const bundle = join(work, 'access.cjs')
const resolveSource = (path) => resolve(path)
const mockElectron = join(work, 'electron.cjs')
writeFileSync(mockElectron, `module.exports = {
  app: { getPath: (name) => name === 'appData' ? ${JSON.stringify(install)} : ${JSON.stringify(profile)}, getAppPath: () => ${JSON.stringify(process.cwd())}, getVersion: () => 'test', isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] }
}`)
const replacements = new Map([
  [resolveSource('src/main/state.ts'), `export const getSnapshot = () => ({ meta: { root: globalThis.__APP_FIXTURE_ROOT ?? ${JSON.stringify(project)}, name: 'Access fixture' } });`],
  [resolveSource('src/main/services/gateway/manager.ts'), 'export const GatewayManager = { getDeferredCatalog: () => [], getStandardTools: () => [], searchTools: () => [], executeTool: async () => ({ok:true}) };'],
  [resolveSource('src/main/services/chat-store.ts'), 'export const listSessions = () => []; export const openSession = () => null;']
])
await build({
  stdin: { contents: `export { accessServer } from './src/main/services/access/server'; export { appRuntime } from './src/main/services/app-runtime'; export { installTpanel } from './src/main/services/bridge'; export { appCliScript, appCliPowerShell } from './src/main/services/access/app-cli'; export { MutationCache } from './src/main/services/access/mutation-cache'; export { setSettings } from './src/main/services/store';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', outfile: bundle,
  plugins: [{ name: 'isolate-unrelated-domains', setup(plugin) {
    plugin.onResolve({ filter: /^electron$/ }, () => ({ path: mockElectron }))
    plugin.onResolve({ filter: /state$|manager$|chat-store$/ }, (args) => {
      const absolute = resolve(args.resolveDir, args.path) + '.ts'
      return replacements.has(absolute) ? { path: absolute, namespace: 'fixture' } : null
    })
    plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ contents: replacements.get(args.path), loader: 'ts' }))
  }}]
})
const module = require(bundle)
const { appRuntime, accessServer, installTpanel, appCliScript, appCliPowerShell, setSettings, MutationCache } = module
let checks = 0
const check = (name, value) => { assert.ok(value, name); checks += 1; console.log('PASS ' + name) }
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function eventually(fn, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await fn()) return; await pause(75) }
  throw new Error('Timed out waiting for fixture state')
}
async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}
function command(executable, args, env = process.env, extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, env, ...extra })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI fixture timeout')) }, 65000)
    child.stdout.on('data', (data) => { stdout += data })
    child.stderr.on('data', (data) => { stderr += data })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => { clearTimeout(timer); let json; try { json = JSON.parse(stdout.trim()) } catch { reject(new Error('CLI did not return one JSON result: ' + stdout + stderr)); return }; resolve({ code, json, stdout, stderr }) })
  })
}
let blocker
let slow
let originalDescriptor
let cleanupSucceeded = false
try {
  const cache = new MutationCache()
  let calls = 0
  const operation = async () => { calls += 1; await pause(30); return { ok: true } }
  const concurrent = await Promise.all([cache.execute('same', 'payload', operation), cache.execute('same', 'payload', operation)])
  check('concurrent idempotency reserves before invoking', calls === 1 && concurrent.some((entry) => entry.replay))
  await assert.rejects(cache.execute('same', 'different', operation), (error) => error.code === 'E_CONFLICT')
  check('request ID mismatch is rejected', calls === 1)

  const servicePort = await freePort()
  const accessPort = await freePort()
  const source = join(project, 'service.cjs')
  const counter = join(project, 'starts.txt')
  const secret = 'fixture-secret-never-in-cli-output'
  writeFileSync(join(project, '.env'), `APP_PORT=${servicePort}\nAPP_VALUE=first\nAPP_SECRET=${secret}\n`)
  writeFileSync(source, `const http=require('node:http'),fs=require('node:fs'); const file=${JSON.stringify(counter)}; let count=0;try{count=Number(fs.readFileSync(file,'utf8'))}catch{}fs.writeFileSync(file,String(count+1)); const server=http.createServer((req,res)=>res.end(process.env.APP_VALUE));server.listen(Number(process.env.APP_PORT),'127.0.0.1',()=>console.log('started '+process.env.APP_SECRET));`)
  setSettings({ recentProjects: [project], access: { enabled: true, port: accessPort } })
  accessServer.syncFromSettings()
  await eventually(() => accessServer.status().running)
  const descriptor = join(profile, 'access-endpoint.json')
  const tokenFile = join(profile, 'access-token')
  let token = readFileSync(tokenFile, 'utf8').trim()
  const base = `http://127.0.0.1:${accessPort}/tpap/v1`
  const request = async (method, route, body, auth = token) => {
    const res = await fetch(base + route, { method, headers: { ...(auth ? { Authorization: 'Bearer ' + auth } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, json: await res.json() }
  }
  check('endpoint discovery excludes credentials', !readFileSync(descriptor, 'utf8').includes(token))
  check('authentication precedes unknown app routing', (await request('GET', '/apps/does-not-exist', undefined, '')).status === 401)
  const unknown = await request('GET', '/apps/list?project=' + encodeURIComponent(join(work, 'unopened')))
  check('unknown project is not opened or adopted', unknown.status === 404)
  const malformed = await fetch(base + '/apps/start', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{"secret":"must-not-be-echoed"' })
  const malformedText = await malformed.text()
  check('malformed request errors omit raw input values', malformed.status === 422 && !malformedText.includes('must-not-be-echoed'))

  const saved = await appRuntime.save(project, { config: { id: 'fixture', name: 'Fixture', cwd: '.', launch: { kind: 'argv', executable: process.execPath, args: [source] }, envFiles: ['.env'], ports: [{ host: '127.0.0.1', port: servicePort }], readiness: { kind: 'http', url: `http://127.0.0.1:${servicePort}/`, timeoutMs: 10000 }, stopTimeoutMs: 15000 } })
  check('application saved without launch', saved.ok === true && !saved.app.run)
  const baselineEvents = await request('GET', '/events')
  const eventCursor = baselineEvents.json.nextCursor.epoch + ':' + baselineEvents.json.nextCursor.seq
  const body = { project, appId: 'fixture', requestId: 'first-start', confirm: true }
  check('missing confirmation denies mutation', (await request('POST', '/apps/start', { ...body, confirm: false })).status === 422)
  check('arbitrary command and authority fields are rejected', (await request('POST', '/apps/start', { ...body, approved: true, command: 'anything' })).status === 422)
  const denied = await request('POST', '/apps/start', body)
  check('agent first launch requires human approval', denied.status === 403 && denied.json.reason === 'APPROVAL_REQUIRED')
  check('denied launch created no child', !existsSync(counter))
  const approved = await appRuntime.start(project, 'fixture', { confirm: async () => true })
  check('shared runtime accepts simulated human fixture decision', approved.ok === true)
  await eventually(async () => (await appRuntime.list(project)).apps?.find((app) => app.definition.id === 'fixture')?.readiness.state === 'ready')
  check('real service is reachable without IDEA', await (await fetch(`http://127.0.0.1:${servicePort}/`)).text() === 'first')
  const changes = await request('GET', '/events?cursor=' + encodeURIComponent(eventCursor))
  const applicationEvents = changes.json.events.filter((event) => event.type.startsWith('application.'))
  check('application event stream contains summaries without secrets or config', applicationEvents.length > 0 && applicationEvents.every((event) => !('output' in event.payload) && !('definition' in event.payload)) && !JSON.stringify(changes.json).includes(secret))

  const client = join(work, 'client.cjs')
  writeFileSync(client, appCliScript())
  const electron = require('electron')
  const cli = (args) => command(electron, [client, '--descriptor', descriptor, 'app', ...args, '--project', project], { ...process.env, ELECTRON_RUN_AS_NODE: '1' })
  const cliList = await cli(['list'])
  check('bundled Electron Node CLI lists same application', cliList.code === 0 && cliList.json.data.apps.some((app) => app.definition.id === 'fixture'))
  const cliLogs = await cli(['logs', 'fixture'])
  check('CLI output remains bounded and redacts known values', cliLogs.code === 0 && !cliLogs.stdout.includes(secret) && typeof cliLogs.json.data.cursor === 'number')
  const status = await cli(['status', 'fixture'])
  check('CLI status distinguishes readiness from process state', status.json.data.app.processState === 'running' && status.json.data.app.readiness.state === 'ready')
  globalThis.__APP_FIXTURE_ROOT = join(work, 'another-project')
  const explicitRoot = await cli(['status', 'fixture'])
  check('explicit project requests do not follow the active project switch', explicitRoot.code === 0 && explicitRoot.json.data.root === saved.root)
  delete globalThis.__APP_FIXTURE_ROOT
  const sameStarts = await Promise.all([request('POST', '/apps/start', { ...body, requestId: 'duplicate-start' }), request('POST', '/apps/start', { ...body, requestId: 'duplicate-start' })])
  check('concurrent starts replay one real instance', sameStarts.every((result) => result.json.ok === true) && new Set(sameStarts.map((result) => result.json.data.app.run.id)).size === 1 && readFileSync(counter, 'utf8') === '1')
  check('request ID cannot change action', (await request('POST', '/apps/stop', { ...body, requestId: 'duplicate-start' })).status === 409)

  writeFileSync(join(project, '.env'), `APP_PORT=${servicePort}\nAPP_VALUE=second\nAPP_SECRET=${secret}\n`)
  const restarts = await Promise.all([request('POST', '/apps/restart', { ...body, requestId: 'restart-once' }), request('POST', '/apps/restart', { ...body, requestId: 'restart-once' })])
  check('concurrent restart executes once', restarts.every((result) => result.json.ok === true) && new Set(restarts.map((result) => result.json.data.app.run.id)).size === 1)
  await eventually(async () => { try { return await (await fetch(`http://127.0.0.1:${servicePort}/`)).text() === 'second' } catch { return false } })
  check('restart rereads env and releases prior service', readFileSync(counter, 'utf8') === '2')

  const oldToken = token
  check('token rotation request succeeds', (await request('POST', '/token/rotate', { confirm: true, requestId: 'rotate-access' })).json.ok === true)
  token = readFileSync(tokenFile, 'utf8').trim()
  check('old token no longer authorizes app reads', (await request('GET', '/apps/list?project=' + encodeURIComponent(project), undefined, oldToken)).status === 401)
  check('CLI rereads rotated token without reinstall', (await cli(['status', 'fixture'])).code === 0)

  if (process.platform === 'win32') {
    const installed = installTpanel('test-bridge-token')
    check('CLI installer preserves legacy commands and creates app shim', installed.ok && /try_notify/.test(readFileSync(installed.path, 'utf8')) && /try_app/.test(readFileSync(installed.path, 'utf8')))
    const ps = join(install, 'npm', 'tpanel-app.ps1')
    // Exercise the real shipped runtime, including Unicode argument/path handling.
    writeFileSync(ps, appCliPowerShell(electron, client, descriptor), 'ascii')
    const psResult = await command(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps, 'app', 'status', 'fixture', '--project', project])
    check('installed ASCII shim supports bundled runtime and Unicode roots', psResult.code === 0 && psResult.json.data.app.definition.id === 'fixture')
    const cmdResult = await command(join(process.env.SystemRoot, 'System32', 'cmd.exe'), ['/d', '/s', '/c', `""${installed.path}" app status fixture --project "${project}""`], process.env, { windowsVerbatimArguments: true })
    check('actual tpanel.cmd forwards arguments and JSON exit status', cmdResult.code === 0 && cmdResult.json.data.app.definition.id === 'fixture')
  }

  const stopped = await cli(['stop', 'fixture', '--request-id', 'stop-fixture'])
  check('CLI stops the owned service', stopped.code === 0 && stopped.json.data.app.processState === 'stopped')
  blocker = createServer((_req, res) => res.end('external'))
  await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen(servicePort, '127.0.0.1', resolve) })
  const blocked = await cli(['start', 'fixture', '--request-id', 'blocked-start'])
  check('external occupied port blocks launch without stopping owner', blocked.code !== 0 && blocked.json.reason === 'PORT_CONFLICT' && await (await fetch(`http://127.0.0.1:${servicePort}/`)).text() === 'external')
  await new Promise((resolve) => blocker.close(resolve)); blocker = undefined

  originalDescriptor = readFileSync(descriptor, 'utf8')
  writeFileSync(descriptor, JSON.stringify({ version: 1, enabled: true, running: true, endpoint: 'http://10.0.0.2:4000/tpap/v1' }))
  check('CLI refuses a non-loopback descriptor', (await cli(['list'])).json.error.code === 'E_DENIED')
  writeFileSync(descriptor, originalDescriptor)
  let timedOutMutationId
  slow = createServer(async (req, res) => {
    if (req.method === 'POST') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      timedOutMutationId = JSON.parse(Buffer.concat(chunks).toString('utf8')).requestId
    }
    setTimeout(() => res.end(JSON.stringify({ ok: true })), 300)
  })
  await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve))
  writeFileSync(descriptor, JSON.stringify({ version: 1, enabled: true, running: true, endpoint: `http://127.0.0.1:${slow.address().port}/tpap/v1` }))
  check('CLI has a bounded deadline', (await cli(['list', '--timeout', '100'])).json.error.code === 'E_TIMEOUT')
  const mutationTimeout = await cli(['restart', 'fixture', '--timeout', '100'])
  check('timed-out mutation exposes its actual request ID for safe retry', mutationTimeout.json.error.code === 'E_TIMEOUT' && typeof timedOutMutationId === 'string' && mutationTimeout.json.error.message.includes('--request-id ' + timedOutMutationId))
  writeFileSync(descriptor, originalDescriptor)
  await new Promise((resolve) => slow.close(resolve)); slow = undefined

  accessServer.stop()
  const disabled = await cli(['list'])
  check('stop clears discovery and reports setup without auto-enable', disabled.code !== 0 && disabled.json.error.code === 'E_SETUP_REQUIRED' && !JSON.parse(readFileSync(descriptor, 'utf8')).running)
  setSettings({ access: { enabled: false, port: accessPort } })
  accessServer.syncFromSettings()
  check('access remains disabled until explicitly enabled', !accessServer.status().running && !JSON.parse(readFileSync(descriptor, 'utf8')).enabled)
  const cleanup = await appRuntime.shutdown()
  if (cleanup?.ok === false) throw new Error('Runtime fixture cleanup not confirmed')
  cleanupSucceeded = true
  console.log(`Application access smoke: ${checks} checks passed (real local service/protocol/CLI; simulated human approval, not native dialog evidence).`)
} finally {
  blocker?.close()
  slow?.close()
  accessServer.stop()
  try { const result = await appRuntime.shutdown(); if (result?.ok !== false) cleanupSucceeded = true } catch {}
  if (cleanupSucceeded) rmSync(work, { recursive: true, force: true })
  else console.error('Fixture state retained for unconfirmed cleanup: ' + work)
}

// Clean-room bounded public daemon + SDK experiment. No vendors/private imports.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const ownRoot = dirname(fileURLToPath(import.meta.url))
const runRoot = join(ownRoot, 'daemon-runs', new Date().toISOString().replace(/[:.]/g, '-'))
mkdirSync(runRoot, { recursive: true })
const safe = {}
for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT']) if (process.env[key]) safe[key] = process.env[key]
for (const [key, leaf] of Object.entries({ HOME: 'home', USERPROFILE: 'home', LOCALAPPDATA: 'local', APPDATA: 'roaming', TEMP: 'tmp', TMP: 'tmp', PATH: 'empty-path' })) {
  safe[key] = join(runRoot, leaf); mkdirSync(safe[key], { recursive: true })
}
safe.PASEO_HOME = join(runRoot, 'paseo-home'); mkdirSync(safe.PASEO_HOME, { recursive: true })
safe.PASEO_LISTEN = '127.0.0.1:0'; safe.OTEL_SDK_DISABLED = 'true'; safe.DO_NOT_TRACK = '1'
process.env = safe
const modules = resolve(process.argv[2] ?? 'C:/Users/Maweirdos/.codex/visualizations/2026/10/16/01a143cf-354c-7ce0-a351-45db825fc514/paseo-validation/node_modules')
const peer = resolve(ownRoot, '..', 'protocol', 'strict-peer.mjs')
const peerDirectory = join(runRoot, 'peer'); mkdirSync(peerDirectory, { recursive: true })
const result = { cleanRoom: true, package: '@getpaseo/server+client@0.11.4', node: process.version, pid: process.pid, runRoot, events: [], observations: [] }
const note = (kind, detail = {}) => { result.observations.push({ kind, ...detail }); console.log(JSON.stringify({ kind, ...detail })) }
const errorView = error => ({ message: error?.message, code: error?.code, stack: error?.stack?.split('\n').slice(0, 12) })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function bounded(promise, label, timeout = 12000) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Research deadline: ${label}`)), timeout) })]) }
  finally { clearTimeout(timer) }
}
let daemon
let client
let unsubscribe
const watchdog = setTimeout(() => {
  writeFileSync(join(runRoot, 'watchdog.json'), JSON.stringify(result, null, 2))
  process.exit(2)
}, 70000)
try {
  const server = await import(pathToFileURL(join(modules, '@getpaseo/server/dist/server/server/exports.js')).href)
  const sdk = await import(pathToFileURL(join(modules, '@getpaseo/client/dist/index.js')).href)
  const providers = Object.fromEntries(server.BUILTIN_PROVIDER_IDS.map(id => [id, { enabled: false }]))
  providers['research-strict'] = { enabled: true, label: 'Original research peer', command: [process.execPath, peer, peerDirectory, 'normal'],
    models: [{ id: 'small', label: 'Fixture small', isDefault: true }], paseoTools: { enabled: false } }
  const persisted = {
    version: 1,
    daemon: { listen: '127.0.0.1:0', relay: { enabled: false }, serviceProxy: { enabled: false },
      mcp: { enabled: false, injectIntoAgents: false }, browserTools: { enabled: false }, enableTerminalAgentHooks: false },
    pluginsEnabled: false, plugins: {},
    agents: { providers, metadataGeneration: { providers: [] }, skills: { selection: { mode: 'custom', skills: [] } } },
    features: { dictation: { enabled: false }, voiceMode: { enabled: false }, webUi: { enabled: false } }, log: { level: 'error', format: 'json' }
  }
  writeFileSync(join(safe.PASEO_HOME, 'config.json'), JSON.stringify(persisted, null, 2))
  const config = server.resolveConfigFromPersisted(safe.PASEO_HOME, persisted, { env: safe, relayEnabledFallback: false,
    cli: { listen: '127.0.0.1:0', relayEnabled: false, mcpEnabled: false, mcpInjectIntoAgents: false, webUiEnabled: false } })
  note('resolved-isolation', { listen: config.listen, relay: config.relayEnabled, plugins: config.pluginsEnabled,
    clients: Object.keys(config.agentClients), speech: config.speech.providers, metadataGeneration: config.metadataGeneration })
  const logger = server.createRootLogger({ level: 'error', format: 'json' }, { paseoHome: safe.PASEO_HOME, file: false })
  daemon = await bounded(server.createPaseoDaemon(config, logger), 'create public daemon')
  note('daemon-created')
  await bounded(daemon.start(), 'start loopback daemon')
  const target = daemon.getListenTarget()
  note('daemon-started', { target })
  if (target?.type !== 'tcp' || !['127.0.0.1', '::1', 'localhost'].includes(target.host)) throw new Error('Refuse non-loopback target')
  client = sdk.createPaseoClient({ url: `ws://127.0.0.1:${target.port}/ws`, reconnect: { enabled: false }, connectTimeoutMs: 3000 })
  await bounded(client.connect(), 'public client connect', 5000)
  note('client-connected', { state: client.getConnectionState() })
  const handle = await bounded(client.agents.create({ cwd: peerDirectory, config: { provider: 'research-strict/small', modeId: 'safe' } }), 'create original fake agent')
  note('agent-created', { id: handle.id, cwd: handle.cwd, status: handle.status })
  unsubscribe = handle.timeline.subscribe(event => result.events.push(event))
  await bounded(unsubscribe.ready, 'timeline subscription')
  const waiting = await bounded(handle.run('permission:duplicate', { timeoutMs: 5000 }), 'run controlled permission', 8000)
  await handle.refresh()
  note('permission-wait', { waiting, pendingPermissions: handle.pendingPermissions })
  const permission = handle.pendingPermissions?.[0]
  if (!permission) throw new Error('No permission surfaced through public SDK')
  await bounded(handle.respondToPermission({ requestId: permission.id, response: { behavior: 'allow', selectedActionId: 'opaque-second-once' } }), 'exact action response')
  const finished = await bounded(handle.waitForFinish(5000), 'permission result')
  note('permission-finished', { finished })
  const wire = readFileSync(join(peerDirectory, 'peer-wire.jsonl'), 'utf8').trim().split('\n').map(row => JSON.parse(row))
  note('exact-option-wire', { response: wire.filter(row => row.kind === 'permission-answer').at(-1)?.response })
  const timeline = await handle.timeline.refetch({ limit: 25 })
  note('timeline-refetched', { agentId: handle.id, timeline })
  note('public-controls', { stop: typeof handle.stop, cancel: typeof handle.cancel, setModel: typeof handle.setModel, setMode: typeof handle.setMode, setConfigOption: typeof handle.setConfigOption })
  await handle.run('foreign-update', { timeoutMs: 5000 })
  note('foreign-timeline-observation', { events: result.events, snapshot: handle.current() })
  result.verdict = 'isolated-public-daemon-compatibility-observed'
} catch (error) { result.error = errorView(error); result.verdict = 'blocked-at-recorded-public-boundary'; note('experiment-error', result.error) }
finally {
  try { if (unsubscribe) unsubscribe() } catch {}
  try { if (client) { await bounded(client.close(), 'SDK close', 5000); note('SDK-closed') } } catch (error) { result.clientCloseError = errorView(error) }
  try { if (daemon) { await bounded(daemon.stop(), 'public daemon stop', 12000); note('daemon-stopped') } } catch (error) { result.daemonStopError = errorView(error) }
  clearTimeout(watchdog)
  const peerJournal = join(peerDirectory, 'peer-wire.jsonl')
  result.peerLaunched = existsSync(peerJournal)
  result.harnessExitPolicy = 'Standalone owned harness exits after public cleanup; this is not proof that public stop releases every Node handle'
  writeFileSync(join(runRoot, 'result.json'), JSON.stringify(result, null, 2))
  writeFileSync(join(ownRoot, 'latest-daemon-run.json'), JSON.stringify({ runRoot, results: join(runRoot, 'result.json') }, null, 2))
  console.log(`RESULTS ${join(runRoot, 'result.json')}`)
  process.exitCode = result.error || result.daemonStopError ? 1 : 0
  // Do not let unrelated library timers make this bounded research process linger.
  setTimeout(() => process.exit(process.exitCode), 100)
}

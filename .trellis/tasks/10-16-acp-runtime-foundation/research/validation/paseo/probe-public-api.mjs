// Clean-room bounded inspection using only published package-root APIs.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const ownRoot = dirname(fileURLToPath(import.meta.url))
const runRoot = join(ownRoot, 'runs', new Date().toISOString().replace(/[:.]/g, '-'))
mkdirSync(runRoot, { recursive: true })
const cleanEnvironment = {}
for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT']) if (process.env[key]) cleanEnvironment[key] = process.env[key]
for (const [key, leaf] of Object.entries({ HOME: 'home', USERPROFILE: 'home', LOCALAPPDATA: 'local', APPDATA: 'roaming', TEMP: 'tmp', TMP: 'tmp', PATH: 'empty-path' })) {
  cleanEnvironment[key] = join(runRoot, leaf)
  mkdirSync(cleanEnvironment[key], { recursive: true })
}
cleanEnvironment.PASEO_HOME = join(runRoot, 'paseo-home')
cleanEnvironment.PASEO_LISTEN = '127.0.0.1:0'
mkdirSync(cleanEnvironment.PASEO_HOME, { recursive: true })
process.env = cleanEnvironment
const modules = resolve(process.argv[2] ?? 'C:/Users/Maweirdos/.codex/visualizations/2026/10/16/01a143cf-354c-7ce0-a351-45db825fc514/paseo-validation/node_modules')
const result = { cleanRoom: true, node: process.version, runRoot, imports: {}, client: {}, server: {}, daemonStarted: false }
const clientRoot = join(modules, '@getpaseo/client')
const serverRoot = join(modules, '@getpaseo/server')
assert.equal(JSON.parse(readFileSync(join(clientRoot, 'package.json'), 'utf8')).version, '0.11.4')
assert.equal(JSON.parse(readFileSync(join(serverRoot, 'package.json'), 'utf8')).version, '0.11.4')
try {
  const api = await import(pathToFileURL(join(clientRoot, 'dist/index.js')).href)
  result.imports.client = { ok: true, exports: Object.keys(api) }
  const client = api.createPaseoClient({ url: 'ws://127.0.0.1:1/ws', reconnect: { enabled: false }, connectTimeoutMs: 500 })
  const handle = client.agents.ref('owned-research-agent')
  result.client = {
    agentMethods: Object.fromEntries(['respondToPermission', 'send', 'run', 'stop', 'cancel', 'setModel', 'setMode', 'setConfigOption', 'refresh', 'waitForFinish'].map(key => [key, typeof handle[key]])),
    agentActionKeys: Object.keys(client.agents),
    timelineMethods: Object.keys(handle.timeline),
    configMethods: Object.keys(client.config),
    initialAgentId: handle.id,
    initialPendingPermissions: handle.pendingPermissions
  }
  await client.close()
} catch (error) { result.imports.client = { ok: false, message: error.message, code: error.code } }
try {
  const api = await import(pathToFileURL(join(serverRoot, 'dist/server/server/exports.js')).href)
  result.imports.server = { ok: true, exports: Object.keys(api).filter(key => /Daemon|Config|Provider|Logger/.test(key)) }
  const providers = Object.fromEntries(api.BUILTIN_PROVIDER_IDS.map(id => [id, { enabled: false }]))
  const persisted = {
    version: 1,
    daemon: { listen: '127.0.0.1:0', relay: { enabled: false }, serviceProxy: { enabled: false },
      mcp: { enabled: false, injectIntoAgents: false }, browserTools: { enabled: false }, enableTerminalAgentHooks: false },
    pluginsEnabled: false, plugins: {},
    agents: { providers, metadataGeneration: { providers: [] }, skills: { selection: { mode: 'custom', skills: [] } } },
    features: { dictation: { enabled: false }, voiceMode: { enabled: false }, webUi: { enabled: false } },
    log: { level: 'error', format: 'json' }
  }
  writeFileSync(join(cleanEnvironment.PASEO_HOME, 'config.json'), JSON.stringify(persisted, null, 2))
  const config = api.resolveConfigFromPersisted(cleanEnvironment.PASEO_HOME, persisted, {
    env: cleanEnvironment, relayEnabledFallback: false,
    cli: { listen: '127.0.0.1:0', relayEnabled: false, mcpEnabled: false, mcpInjectIntoAgents: false, webUiEnabled: false }
  })
  result.server = {
    configResolved: true, listen: config.listen, paseoHome: config.paseoHome,
    relayEnabled: config.relayEnabled, pluginsEnabled: config.pluginsEnabled,
    speech: config.speech, voiceLlmProvider: config.voiceLlmProvider,
    agentClientKeys: Object.keys(config.agentClients), mcpEnabled: config.mcpEnabled,
    browserToolsEnabled: config.browserToolsEnabled, webUi: config.webUi,
    publicCreateDaemon: typeof api.createPaseoDaemon
  }
  // Probe ends before daemon startup; the separate foreground experiment is conditional.
} catch (error) { result.imports.server = { ok: false, message: error.message, code: error.code, stack: error.stack?.split('\n').slice(0, 10) } }
writeFileSync(join(runRoot, 'result.json'), JSON.stringify(result, null, 2))
writeFileSync(join(ownRoot, 'latest-run.json'), JSON.stringify({ runRoot, results: join(runRoot, 'result.json') }, null, 2))
console.log(JSON.stringify(result, null, 2))
process.exitCode = result.imports.client.ok && result.imports.server.ok ? 0 : 1

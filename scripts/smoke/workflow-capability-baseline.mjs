/** Clean-room, opt-in diagnostics. No configuration or remote business writes. */
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { connect as tcpConnect } from 'node:net'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { cpus, platform, release, totalmem, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkAcpxCompatibility } from '../check-acpx-compat.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const requireProject = createRequire(join(root, 'package.json'))
const defaultUserData = process.env.APPDATA ? join(process.env.APPDATA, 'trellis-panel') : undefined
const digest = (value) => createHash('sha256').update(value).digest('hex')
const knownSecrets = new Set()
const json = async (file) => {
  if ((await stat(file)).size > 2 * 1024 * 1024) throw new Error('Metadata/config JSON exceeds the 2MiB read budget')
  return JSON.parse(await readFile(file, 'utf8'))
}
const now = () => new Date().toISOString()
const fact = (status, evidence, reason) => ({ status, ...(evidence ? { evidence } : {}), ...(reason ? { reason } : {}) })
const scopedEngineReady = (row) => ['start', 'promptWrite', 'readMaterial', 'cancel', 'sameSessionLoad', 'afterCancel'].every((name) => row.capabilities[name]?.status === 'supported') && row.cleanup.unconfirmedPids.length === 0

function safeError(error) {
  let message = String(error?.message ?? error).slice(0, 800)
  for (const secret of knownSecrets) if (secret) message = message.replaceAll(secret, '[redacted]')
  message = message.replace(/(?:sk[-_])[A-Za-z0-9_-]{8,}/g, '[redacted-key]').replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]')
    .replace(/(Basic\s+)[A-Za-z0-9+/=]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|authorization|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/https?:\/\/[^\s"']+/g, (url) => { try { const parsed = new URL(url); return parsed.origin + parsed.pathname } catch { return '[redacted-url]' } })
  return { name: error?.name ?? 'Error', ...(error?.code ? { code: String(error.code).slice(0, 80) } : {}), ...(error?.cause?.code ? { causeCode: String(error.cause.code).slice(0, 80) } : {}), ...(error?.cause?.socket ? { socket: { remoteAddress: error.cause.socket.remoteAddress, remotePort: error.cause.socket.remotePort, bytesWritten: error.cause.socket.bytesWritten, bytesRead: error.cause.socket.bytesRead } } : {}), message: message.slice(0, 300) }
}

function parseArgs(argv) {
  const opts = { engine: 'none', jira: false, project: 'HONSKY', userData: defaultUserData, reportDir: undefined, selfTest: false, turnTimeoutMs: 60000, model: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === '--jira') { opts.jira = true; continue }
    if (key === '--self-test') { opts.selfTest = true; continue }
    if (key === '--help') { opts.help = true; continue }
    const fields = { '--engine': 'engine', '--project': 'project', '--user-data': 'userData', '--report-dir': 'reportDir', '--turn-timeout-ms': 'turnTimeoutMs', '--model': 'model' }
    if (!fields[key] || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`Invalid argument ${key}`)
    opts[fields[key]] = argv[++index]
  }
  if (!['none', 'codex', 'claude', 'all'].includes(opts.engine)) throw new Error('--engine must be none, codex, claude or all')
  opts.turnTimeoutMs = Number(opts.turnTimeoutMs)
  if (!Number.isSafeInteger(opts.turnTimeoutMs) || opts.turnTimeoutMs < 5000 || opts.turnTimeoutMs > 120000) throw new Error('--turn-timeout-ms must be 5000—120000')
  if (!/^[A-Z][A-Z0-9_]{1,39}$/i.test(opts.project)) throw new Error('Project must be a simple Jira project key')
  if (opts.model && (opts.model.length > 512 || /[\u0000-\u001f]/.test(opts.model) || !['codex', 'claude'].includes(opts.engine))) throw new Error('--model needs one selected engine and a bounded advertised identifier')
  return opts
}

async function commandVersion(script) {
  if (!existsSync(script)) return fact('unavailable', null, 'Global CLI entry is not installed at the recorded npm prefix')
  return await new Promise((done) => {
    let output = ''; let settled = false
    const native = /\.exe$/i.test(script)
    const child = spawn(native ? script : process.execPath, native ? ['--version'] : [script, '--version'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); done(result) } }
    const timer = setTimeout(() => { child.kill(); finish(fact('unknown', null, 'Version command exceeded ten seconds; owned child stop requested')) }, 10000)
    child.stdout.on('data', (chunk) => { if (output.length < 4096) output += chunk.toString() })
    child.stderr.on('data', () => {})
    child.once('error', (error) => finish({ status: 'unavailable', error: safeError(error) }))
    child.once('close', (code) => finish({ status: code === 0 ? 'observed' : 'unavailable', exitCode: code, version: output.trim().split(/\r?\n/).filter(Boolean).at(-1)?.slice(0, 160) ?? null }))
  })
}

async function installed(userData) {
  const globalRoot = process.env.APPDATA ? join(process.env.APPDATA, 'npm/node_modules') : ''
  const result = { node: process.version, nodeExecutable: process.execPath, platform: `${platform()} ${release()}`, acpx: await checkAcpxCompatibility(root), agents: {} }
  for (const [agent, name, expected, globalEntry] of [
    ['codex', '@agentclientprotocol/codex-acp', '2.2.2', '@openai/codex/bin/codex.js'],
    ['claude', '@agentclientprotocol/claude-agent-acp', '0.91.0', '@anthropic-ai/claude-code/bin/claude.exe']
  ]) {
    const packageRoot = userData ? join(userData, 'acp/runtimes', agent, expected, 'node_modules', ...name.split('/')) : null
    try {
      if (!packageRoot) throw new Error('User data location is unavailable')
      const metadata = await json(join(packageRoot, 'package.json'))
      const bin = typeof metadata.bin === 'string' ? metadata.bin : Object.values(metadata.bin)[0]
      const sdkFile = agent === 'claude' ? join(packageRoot, '../../@anthropic-ai/claude-agent-sdk/package.json') : null
      result.agents[agent] = { adapter: { name: metadata.name, version: metadata.version, license: metadata.license ?? 'not_declared', entry: resolve(packageRoot, bin), ...(sdkFile && existsSync(sdkFile) ? { sdkVersion: (await json(sdkFile)).version } : {}) }, cli: { ...await commandVersion(join(globalRoot, globalEntry)), note: 'Installed global CLI; the probe invokes the managed adapter entry, whose own engine selection is recorded separately.' } }
    } catch (error) { result.agents[agent] = { adapter: { status: 'unavailable', error: safeError(error) }, cli: await commandVersion(join(globalRoot, globalEntry)) } }
  }
  return result
}

async function bounded(operation, timeoutMs, label) {
  let timer
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs) })]) }
  finally { clearTimeout(timer) }
}

async function probeEngine(agent, installation, reportDir, turnTimeoutMs, requestedModel) {
  const row = { agent, evidenceKind: 'real-installed-adapter', startedAt: now(), turnTimeoutMs, requestedModel: requestedModel ?? null, selectionPolicy: requestedModel ? 'explicit isolated session model; no global change or automatic fallback' : 'inherited adapter default; no model change', runtime: await checkAcpxCompatibility(root), adapter: installation.adapter, cli: installation.cli, protocol: {}, turns: [], capabilities: {}, cleanup: {}, errors: [] }
  for (const name of ['start', 'promptWrite', 'readMaterial', 'cancel', 'sameSessionLoad', 'afterCancel', 'usage', 'internalChildAgents', 'nativeCompaction']) row.capabilities[name] = fact('unknown', null, 'Not observed by this diagnostic')
  if (!installation.adapter.entry) {
    row.errors.push({ code: 'ADAPTER_UNAVAILABLE' }); row.readiness = 'unavailable'; row.finishedAt = now()
    row.cleanup = { shutdown: 'not-started', launches: [], exits: [], unconfirmedPids: [] }
    await writeFile(join(reportDir, `engine-${agent}.json`), JSON.stringify(row, null, 2) + '\n')
    return row
  }
  const { createAcpRuntime, createFileSessionStore, createAgentRegistry } = await import(pathToFileURL(requireProject.resolve('acpx/runtime')).href)
  const fixture = resolve(tmpdir(), `trellis-workflow-baseline-${agent}-${randomUUID()}`)
  if (dirname(fixture) !== resolve(tmpdir()) || !fixture.includes('trellis-workflow-baseline-')) throw new Error('Unsafe owned fixture path')
  await mkdir(fixture)
  const stateDir = join(fixture, 'runtime-store')
  let nonce = `baseline-${randomUUID()}`
  await writeFile(join(fixture, 'README.md'), `# Isolated capability baseline\n\nEvidence token: ${nonce}\n`)
  const sessionKey = `workflow-baseline-${agent}-${randomUUID()}`
  const launches = []; const exits = []; const permissions = []
  let runtime; let handle; let stage = 'construct'
  // This is a child process policy, not a provider/token/configuration mutation.
  if (agent === 'claude') process.env.ACPX_CLAUDE_INCLUDE_USER_SETTINGS = '1'
  const store = createFileSessionStore({ stateDir })
  function makeRuntime() {
    return createAcpRuntime({ cwd: fixture, sessionStore: store, agentRegistry: createAgentRegistry({ overrides: { [agent]: [process.execPath, installation.adapter.entry] } }),
      permissionMode: 'deny-all', nonInteractivePermissions: 'deny', timeoutMs: 30000, fs: false, terminal: false,
      ...(agent === 'codex' ? { agentProcessEnv: { INITIAL_AGENT_MODE: 'read-only' } } : {}),
      processLifecycle: { onSpawned: (event) => launches.push({ pid: event.pid, launchId: event.launchId }), onExit: (event) => exits.push({ pid: event.pid, code: event.exitCode, signal: event.signal }) },
      onPermissionRequest: async (request) => {
        // Permit only an explicitly offered read/search choice for the owned README.
        const kind = request.inferredKind ?? request.raw?.toolCall?.kind
        const paths = (request.raw?.toolCall?.locations ?? []).map((location) => location.path).filter((path) => typeof path === 'string')
        const readOnlyFixture = ['read', 'search'].includes(kind) && paths.length > 0 && paths.every((path) => resolve(fixture, path).toLowerCase() === join(fixture, 'README.md').toLowerCase())
        const option = request.raw?.options?.find((item) => item.kind === (readOnlyFixture ? 'allow_once' : 'reject_once'))
        permissions.push({ kind: kind ?? 'unknown', decision: readOnlyFixture ? 'allow_once' : 'reject_once', offeredKinds: (request.raw?.options ?? []).map((item) => item.kind) })
        return option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancel' }
      }
    })
  }
  async function turn(label, text, expected, cancel = false) {
    stage = label
    const started = performance.now(); const seen = {}; const tags = {}; const toolKinds = {}; let textOut = ''; let wrote = false; let cancelReceipt = null
    const controller = new AbortController(); const deadline = setTimeout(() => controller.abort(), turnTimeoutMs + 5000)
    try {
      const active = runtime.startTurn({ handle, text, mode: 'prompt', requestId: randomUUID(), signal: controller.signal, timeoutMs: turnTimeoutMs })
      const acceptance = active.promptStarted.then(() => { wrote = true }, () => {})
      const cancellation = cancel ? active.promptStarted.then(async () => { await active.cancel({ reason: 'Owned baseline cancellation after acknowledged prompt write' }); cancelReceipt = 'resolved' }, () => { cancelReceipt = 'not-written' }).catch((error) => { cancelReceipt = 'rejected'; row.errors.push({ stage: label, error: safeError(error) }) }) : Promise.resolve()
      for await (const event of active.events) {
        seen[event.type] = (seen[event.type] ?? 0) + 1
        if (event.tag) tags[event.tag] = (tags[event.tag] ?? 0) + 1
        if (event.type === 'text_delta' && event.stream !== 'thought') textOut += event.text
        if (event.type === 'tool_call') toolKinds[event.kind ?? 'unknown'] = (toolKinds[event.kind ?? 'unknown'] ?? 0) + 1
      }
      const result = await active.result; await acceptance; await cancellation
      const observed = { label, elapsedMs: Math.round((performance.now() - started) * 100) / 100, promptWritten: wrote, status: result.status, stopReason: result.stopReason ?? null, expectedMatched: expected ? textOut.includes(expected) : null, events: seen, tags, toolKinds, ...(cancel ? { cancelReceipt } : {}) }
      row.turns.push(observed)
      process.stdout.write(JSON.stringify({ agent, stage: label, status: observed.status, expectedMatched: observed.expectedMatched }) + '\n')
      if (result.status === 'failed') row.errors.push({ stage: label, error: safeError(result.error) })
      return observed
    } finally { clearTimeout(deadline) }
  }
  try {
    runtime = makeRuntime(); stage = 'ensure-session'
    const started = performance.now()
    handle = await bounded(runtime.ensureSession({ sessionKey, agent, mode: 'persistent' }), 40000, stage)
    row.sessionReadyMs = Math.round((performance.now() - started) * 100) / 100
    row.protocol.backendSessionId = handle.backendSessionId ?? null
    const initialStatus = await runtime.getStatus({ handle })
    const initialRecord = await store.load(handle.acpxRecordId ?? sessionKey)
    row.protocol.protocolVersion = initialRecord?.protocolVersion ?? null
    row.protocol.agentInfo = initialRecord?.agentInfo ?? null
    row.protocol.advertisedAgentCapabilities = initialRecord?.agentCapabilities ? { loadSession: initialRecord.agentCapabilities.loadSession ?? null, promptCapabilities: initialRecord.agentCapabilities.promptCapabilities ?? null, sessionCapabilities: initialRecord.agentCapabilities.sessionCapabilities ?? null } : null
    row.protocol.initialModels = initialStatus.models ?? null
    if (requestedModel) {
      stage = 'explicit-advertised-model-selection'
      if (!initialStatus.models?.availableModelIds?.includes(requestedModel)) throw new Error('Requested isolated model is not advertised by this actual session')
      await bounded(runtime.setModel({ handle, model: requestedModel }), 30000, stage)
      row.protocol.selectedModel = (await runtime.getStatus({ handle })).models?.currentModelId ?? null
      if (row.protocol.selectedModel !== requestedModel) throw new Error('The isolated model selection was not confirmed')
    }
    row.capabilities.start = fact(handle.backendSessionId ? 'supported' : 'unknown', 'ensureSession returned an actual remote identity')
    const greeting = await turn('greeting', 'This is an isolated integration baseline. Reply exactly WORKFLOW_BASELINE_READY. Do not use tools or external resources.', 'WORKFLOW_BASELINE_READY')
    row.capabilities.promptWrite = fact(greeting.promptWritten ? 'supported' : 'unknown', 'Actual runtime promptStarted acknowledgement')
    if (greeting.status !== 'completed' || !greeting.expectedMatched) throw new Error('Greeting did not complete with the expected synthetic token')
    const read = await turn('read-fixture', 'Use an available read-only tool to read README.md in this isolated working directory. Reply only with its Evidence token. Do not modify files or read other files, use child agents, web or external resources.', nonce)
    row.capabilities.readMaterial = fact(read.status === 'completed' && read.expectedMatched ? 'supported' : 'unknown', 'Fresh synthetic file token; actual observed tool-event counts are retained separately')
    const cancelled = await turn('cancel-admitted', 'This is the cancellation control. Reply WORKFLOW_CANCEL_CONTROL. Do not use tools or external resources.', null, true)
    row.capabilities.cancel = fact(cancelled.status === 'cancelled' ? 'supported' : 'unknown', 'Cancellation after actual prompt write; not a long-running tool cancellation test', cancelled.status !== 'cancelled' ? 'Completion/cancellation race or unavailable control' : undefined)
    const beforeId = handle.backendSessionId
    stage = 'shutdown-before-load'; await bounded(runtime.shutdown(), 20000, stage)
    runtime = makeRuntime(); stage = 'find-stored-session'
    const found = await runtime.findSession({ sessionKey, agent })
    if (!found || found.backendSessionId !== beforeId) throw new Error('Stored same-session identity was unavailable; no replacement or prompt replay attempted')
    handle = found; stage = 'same-session-load'
    await bounded(runtime.connectSession({ handle }), 40000, stage)
    const after = await runtime.getStatus({ handle })
    row.protocol.loadedBackendSessionId = after.backendSessionId ?? handle.backendSessionId ?? null
    row.protocol.sameBackendIdentity = row.protocol.loadedBackendSessionId === beforeId
    row.capabilities.sameSessionLoad = fact(row.protocol.sameBackendIdentity ? 'supported' : 'unknown', 'Actual connectSession/load on the previously recorded remote ID, without a replacement session')
    nonce = `baseline-${randomUUID()}`
    await writeFile(join(fixture, 'README.md'), `# Isolated capability baseline\n\nEvidence token: ${nonce}\n`)
    const resumed = await turn('fresh-read-after-load', 'Read the Evidence token from README.md again using a read-only tool; the host changed it after the prior turn. Reply only with that current token. Do not modify or read other files, spawn agents or access external resources.', nonce)
    row.capabilities.afterCancel = fact(resumed.status === 'completed' && resumed.expectedMatched ? 'supported' : 'unknown', 'Fresh file token after cancellation and same-session load')
    const status = await runtime.getStatus({ handle }); const record = await store.load(handle.acpxRecordId ?? handle.runtimeSessionName)
    row.protocol.protocolVersion = record?.protocolVersion ?? row.protocol.protocolVersion
    row.protocol.agentInfo = record?.agentInfo ?? row.protocol.agentInfo
    row.protocol.advertisedControls = (await runtime.getCapabilities({ handle })).controls
    row.protocol.currentModelId = status.models?.currentModelId ?? null
    row.usage = status.usage ?? null
    row.capabilities.usage = fact(status.usage && Object.keys(status.usage).length ? 'supported' : 'unknown', 'Actual getStatus usage fields; missing fields are not zero usage')
  } catch (error) { row.errors.push({ stage, error: safeError(error) }) }
  finally {
    if (runtime) { try { await bounded(runtime.shutdown(), 20000, 'owned-runtime-shutdown'); row.cleanup.shutdown = 'resolved' } catch (error) { row.cleanup.error = safeError(error) } }
    row.cleanup.launches = launches; row.cleanup.exits = exits
    row.cleanup.unconfirmedPids = launches.filter((launch) => !exits.some((exit) => exit.pid === launch.pid)).map((launch) => launch.pid)
    row.cleanup.fixtureRetained = fixture
    row.permissions = permissions; row.finishedAt = now()
    row.readiness = scopedEngineReady(row) ? 'ready_for_scoped_stage_adapter' : 'partial'
    await writeFile(join(reportDir, `engine-${agent}.json`), JSON.stringify(row, null, 2) + '\n')
  }
  return row
}

async function configuredJira(userData) {
  if (!userData) return { available: false, reason: 'User data path unavailable' }
  const integrationFile = join(userData, 'integrations.json')
  if (existsSync(integrationFile)) {
    const integrations = await json(integrationFile)
    if (![1, 2].includes(integrations.version)) return { available: false, reason: 'Unsupported integration config version; no fallback selected' }
    const jira = integrations.connections?.filter((connection) => connection.providerId === 'jira' && !connection.deleted) ?? []
    if (jira.length) return { available: false, reason: 'Protected connector configuration exists; use the owning application adapter for decryption. No legacy fallback or plaintext interpretation attempted.' }
  }
  const file = join(userData, 'settings.json')
  if (!existsSync(file)) return { available: false, reason: 'Existing settings are unavailable; no defaults were persisted' }
  const settings = await json(file); const config = settings.jira
  if (!config?.enabled || typeof config.baseUrl !== 'string') return { available: false, reason: 'Existing legacy Jira configuration is disabled or absent' }
  if (config.passwordEncrypted) return { available: false, reason: 'Legacy Jira secret is encrypted; Node diagnostic has no safeStorage and will not treat ciphertext as plaintext' }
  if (settings.proxy?.enabled) return { available: false, reason: 'Application proxy enabled; use the owning application transport so the diagnostic cannot bypass it' }
  const url = new URL(config.baseUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid configured Jira base URL')
  const user = typeof config.user === 'string' ? config.user : ''; const password = typeof config.password === 'string' ? config.password : ''
  knownSecrets.add(password)
  const authorization = user && password ? 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64') : null
  if (authorization) knownSecrets.add(authorization)
  return { available: true, base: url.href.replace(/\/$/, ''), authorization, source: 'existing enabled legacy Jira configuration, read without getSettings persistence', transport: { applicationProxyEnabled: false, dispatcher: 'undefined, matching proxy.ts getDispatcher for disabled proxy', request: 'Node global fetch, matching proxy.ts proxiedFetch disabled-proxy branch; redirect:error and 12s signal. This diagnostic uses external Node, not the live Electron process.', source: 'src/main/services/proxy.ts and integrations/transport.ts', environmentProxyPresent: Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NODE_USE_ENV_PROXY'].map((key) => [key, Boolean(process.env[key])])) } }
}

async function noCredentialReachability(base) {
  const url = new URL(base); const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  const tcp = await new Promise((done) => {
    const start = performance.now(); const socket = tcpConnect({ host: url.hostname, port }); let settled = false
    const finish = (value) => { if (!settled) { settled = true; socket.destroy(); done({ host: url.hostname, port, elapsedMs: Math.round((performance.now() - start) * 100) / 100, ...value }) } }
    socket.setTimeout(5000); socket.once('connect', () => finish({ status: 'connected' })); socket.once('timeout', () => finish({ status: 'timeout' })); socket.once('error', (error) => finish({ status: 'failed', error: safeError(error) }))
  })
  const anonymousHttp = await new Promise((done) => {
    const start = performance.now(); let settled = false
    const finish = (result) => { if (!settled) { settled = true; done({ method: 'GET', path: '/rest/api/2/serverInfo', authorizationSent: false, followRedirects: false, transport: 'Node http/https diagnostic control, distinct from production fetch', elapsedMs: Math.round((performance.now() - start) * 100) / 100, ...result }) } }
    const request = (url.protocol === 'https:' ? httpsGet : httpGet)(base + '/rest/api/2/serverInfo', { headers: { Accept: 'application/json' }, timeout: 6000, agent: false }, (response) => {
      const chunks = []; let size = 0
      response.on('data', (chunk) => { size += chunk.length; if (size > 1024 * 1024) { response.destroy(); finish({ status: response.statusCode, error: { code: 'RESPONSE_LIMIT' } }) } else chunks.push(chunk) })
      response.once('error', (error) => finish({ status: response.statusCode, error: safeError(error) }))
      response.once('end', () => {
        let server = null
        try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); server = { version: body?.version ?? null, deploymentType: body?.deploymentType ?? null, buildNumber: body?.buildNumber ?? null } } catch { /* Raw HTML/body never enters a report. */ }
        finish({ status: response.statusCode, contentType: response.headers['content-type'] ?? null, server })
      })
    })
    request.once('timeout', () => { request.destroy(); finish({ status: 'timeout' }) }); request.once('error', (error) => finish({ status: 'failed', error: safeError(error) }))
  })
  return { tcp, anonymousHttp }
}

async function discoverJira(userData, project) {
  const report = { evidenceKind: 'real-read-only-http', startedAt: now(), project, requests: [], readiness: 'partial', writesPerformed: false }
  let config
  try { config = await configuredJira(userData) } catch (error) { report.error = safeError(error); return report }
  if (!config.available) { report.environment = config.reason; return report }
  report.baseUrl = config.base; report.configurationSource = config.source; report.authConfigured = Boolean(config.authorization); report.transport = config.transport
  async function get(path) {
    const start = performance.now(); const request = { method: 'GET', path, status: null, elapsedMs: null }
    report.requests.push(request)
    try {
      const response = await fetch(config.base + path, { headers: { Accept: 'application/json', ...(config.authorization ? { Authorization: config.authorization } : {}) }, redirect: 'error', signal: AbortSignal.timeout(12000) })
      request.status = response.status
      if (!response.ok) return { ok: false, status: response.status }
      const reader = response.body?.getReader(); const chunks = []; let size = 0
      if (reader) try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Jira response exceeded 2MiB diagnostic budget') } chunks.push(part.value) } } finally { reader.releaseLock() }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const arrayExpected = /\/field$|\/project\/[^/]+\/versions$/.test(path)
      if (arrayExpected ? !Array.isArray(body) : !body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Jira returned an unexpected JSON shape; no empty-success substitution')
      return { ok: true, body }
    } catch (error) { request.error = safeError(error); return { ok: false, error: request.error } }
    finally { request.elapsedMs = Math.round((performance.now() - start) * 100) / 100 }
  }
  const server = await get('/rest/api/2/serverInfo')
  if (!server.ok && server.error) { report.transportFailure = server.error; report.noCredentialReachability = await noCredentialReachability(config.base); report.remainingReads = 'not_run after initial transport failure'; report.finishedAt = now(); return report }
  if (server.ok) report.server = { version: server.body.version, deploymentType: server.body.deploymentType, buildNumber: server.body.buildNumber }
  const permission = await get(`/rest/api/2/mypermissions?projectKey=${encodeURIComponent(project)}&permissions=BROWSE_PROJECTS,CREATE_ISSUES,EDIT_ISSUES,ASSIGN_ISSUES,TRANSITION_ISSUES`)
  if (permission.ok) report.permissions = Object.fromEntries(Object.entries(permission.body.permissions ?? {}).map(([key, value]) => [key, { havePermission: value.havePermission === true }]))
  const projectInfo = await get(`/rest/api/2/project/${encodeURIComponent(project)}`)
  if (projectInfo.ok) report.projectMetadata = { id: projectInfo.body.id, key: projectInfo.body.key, projectTypeKey: projectInfo.body.projectTypeKey, issueTypes: (projectInfo.body.issueTypes ?? []).map((item) => ({ id: item.id, name: item.name, subtask: item.subtask === true })) }
  const fields = await get('/rest/api/2/field')
  if (fields.ok && Array.isArray(fields.body)) report.fields = fields.body.map((field) => ({ id: field.id, name: field.name, custom: field.custom === true, schema: field.schema ? { type: field.schema.type, items: field.schema.items, system: field.schema.system, custom: field.schema.custom } : null }))
  const create = await get(`/rest/api/2/issue/createmeta?projectKeys=${encodeURIComponent(project)}&expand=projects.issuetypes.fields`)
  if (create.ok) report.createMetadata = (create.body.projects ?? []).map((item) => ({ id: item.id, key: item.key, issueTypes: (item.issuetypes ?? []).map((type) => ({ id: type.id, name: type.name, fields: Object.entries(type.fields ?? {}).map(([id, field]) => ({ id, name: field.name, required: field.required === true, schemaType: field.schema?.type ?? null, allowedValueCount: Array.isArray(field.allowedValues) ? field.allowedValues.length : null })) })) }))
  const versions = await get(`/rest/api/2/project/${encodeURIComponent(project)}/versions`)
  if (versions.ok && Array.isArray(versions.body)) report.versions = { kind: 'Server project versions array', count: versions.body.length, values: versions.body.map((version) => ({ id: version.id, name: version.name, released: version.released === true, archived: version.archived === true })) }
  const query = `project = "${project}" ORDER BY key ASC`
  const issues = new Map(); const totals = new Set(); let duplicateCount = 0; let malformedCount = 0; let offset = 0; let total = null; let complete = false; let pages = 0
  for (; pages < 20;) {
    const path = `/rest/api/2/search?jql=${encodeURIComponent(query)}&startAt=${offset}&maxResults=100&fields=status,issuetype,fixVersions`
    const page = await get(path)
    if (!page.ok || !Array.isArray(page.body.issues)) break
    pages += 1
    if (Number.isSafeInteger(page.body.total) && page.body.total >= 0) { total = page.body.total; totals.add(total) }
    for (const item of page.body.issues) {
      if (!item || typeof item.id !== 'string' || !Array.isArray(item.fields?.fixVersions ?? [])) { malformedCount += 1; continue }
      if (issues.has(item.id)) duplicateCount += 1
      issues.set(item.id, { id: item.id, key: item.key, statusId: item.fields?.status?.id ?? null, issueTypeId: item.fields?.issuetype?.id ?? null, versionIds: (item.fields?.fixVersions ?? []).filter(Boolean).map((version) => version.id) })
    }
    offset += page.body.issues.length
    if (total !== null && offset >= total) { complete = totals.size === 1 && duplicateCount === 0 && malformedCount === 0 && issues.size === total; break }
    if (page.body.issues.length === 0) break
  }
  report.issueScope = { query, queriedAt: now(), pages, sourceTotal: total, observedSourceTotals: [...totals], changedTotalDuringCollection: totals.size > 1, duplicateCount, malformedCount, retrievedUnique: issues.size, complete, sample: !complete, limitPages: 20, snapshotGuarantee: 'none; detects observed total/duplicate/shape changes but Jira query is not a frozen snapshot', values: [...issues.values()] }
  const first = [...issues.values()][0]
  if (first) {
    const transitions = await get(`/rest/api/2/issue/${encodeURIComponent(first.id)}/transitions?expand=transitions.fields`)
    if (transitions.ok) report.transitionSample = { issueId: first.id, statusId: first.statusId, onlyCurrentIssueState: true, values: (transitions.body.transitions ?? []).map((value) => ({ id: value.id, name: value.name, targetStatusId: value.to?.id ?? null, requiredFieldIds: Object.entries(value.fields ?? {}).filter(([, field]) => field.required).map(([id]) => id) })) }
  }
  report.readiness = report.projectMetadata && report.createMetadata?.length && report.fields?.length && report.versions && report.permissions?.BROWSE_PROJECTS?.havePermission && report.issueScope.complete && report.transitionSample ? 'ready_for_read_based_design' : 'partial'
  report.writeAcceptance = fact('not_run', null, 'No approved business mutation target used; available transitions vary by issue state and identity')
  report.finishedAt = now()
  return report
}

async function treeBytes(path) {
  if (!existsSync(path)) return { available: false }
  let bytes = 0; let files = 0; let latestMtimeMs = 0
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const file = join(directory, entry.name)
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile()) { const info = await stat(file); bytes += info.size; files += 1; latestMtimeMs = Math.max(latestMtimeMs, info.mtimeMs) }
    }
  }
  const info = await stat(path)
  if (info.isDirectory()) await visit(path)
  else { bytes = info.size; files = 1; latestMtimeMs = info.mtimeMs }
  return { available: true, bytes, files, latestMtimeMs }
}

async function measurePerformance() {
  const startedAt = now()
  const { build } = await import('esbuild')
  const bundled = await build({ stdin: { contents: "export * from './src/shared/workflow/index.ts'", resolveDir: root }, bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
  const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
  const asset = (id) => ({ assetId: id, version: 'baseline-v1', digest: 'a'.repeat(64) })
  const executor = { bindingId: 'benchmark', engineId: 'synthetic-no-engine', engineVersion: '0', adapterVersion: '0', configuration: asset('benchmark-config'), capabilities: {} }
  const context = { scope: { projectId: 'benchmark', repositoryId: 'benchmark', workspaceId: 'benchmark', taskRef: 'benchmark' }, instruction: 'Deterministic synthetic performance input; no model call', inputs: {}, materials: [], engineeringBaseline: asset('baseline'), outputContract: asset('output'), budgetBytes: 1024, complete: true }
  const samples = []
  for (const count of [100, 1000, 5000]) {
    const times = []
    let outputBytes = null
    const definition = { contractVersion: 1, ref: { definitionId: 'benchmark', revision: 1 }, flow: { version: 1, id: 'benchmark', name: 'Synthetic benchmark', description: 'Measured pure compiler, not a rendered graph', inputs: [], phases: [{ id: 'implement', name: 'Implementation', steps: Array.from({ length: count }, (_, i) => ({ id: `step-${i}`, name: `Step ${i}`, kind: 'agent', instruction: 'synthetic' })) }] }, defaultExecutor: executor, nodeBindings: [], trellisPhases: { implement: 'implement' } }
    for (let index = 0; index < 4; index += 1) {
      const start = performance.now(); const output = await api.compileWorkflowDefinition(definition, context, digest)
      const elapsed = performance.now() - start
      if (index > 0) times.push(Math.round(elapsed * 100) / 100)
      outputBytes = Buffer.byteLength(JSON.stringify(output))
    }
    samples.push({ nodes: count, warmupRuns: 1, sampleCount: 3, elapsedMs: times, medianMs: [...times].sort((a, b) => a - b)[1], outputBytes })
  }
  const document = '# Synthetic long document\n\n' + 'Field: quantity. Expected validation and state transitions.\n'.repeat(40000)
  const documentSamples = []
  for (let i = 0; i < 5; i += 1) { const start = performance.now(); digest(Buffer.from(document)); documentSamples.push(Math.round((performance.now() - start) * 100) / 100) }
  const artifacts = {}; const packageVersion = (await json(join(root, 'package.json'))).version
  const builderConfig = await readFile(join(root, 'electron-builder.yml'), 'utf8')
  const outputDir = builderConfig.match(/^\s*output:\s*([^\s#]+)/m)?.[1] ?? null
  for (const name of ['out', ...(outputDir ? [`${outputDir}/win-unpacked`, `${outputDir}/TrellisPanel-Setup-${packageVersion}.exe`, `${outputDir}/TrellisPanel-Setup-${packageVersion}.exe.blockmap`] : [])]) {
    const target = resolve(root, name); const within = relative(root, target)
    artifacts[name] = isAbsolute(within) || within === '..' || within.startsWith('..' + sep) || resolve(target) === resolve(sep) ? { available: false, reason: 'Artifact directory escapes the explicit project workspace' } : await treeBytes(target)
  }
  const artifactDigests = {}
  for (const name of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']) if (existsSync(join(root, name))) artifactDigests[name] = digest(await readFile(join(root, name)))
  const workingTreeHead = await new Promise((done) => {
    let value = ''; const child = spawn('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const timer = setTimeout(() => { child.kill(); done(null) }, 5000)
    child.stdout.on('data', (chunk) => { if (value.length < 100) value += chunk.toString() }); child.once('error', () => { clearTimeout(timer); done(null) }); child.once('close', (code) => { clearTimeout(timer); done(code === 0 && /^[a-f0-9]{40}\s*$/.test(value) ? value.trim() : null) })
  })
  return { evidenceKind: 'measured-local-node-and-artifacts', startedAt, finishedAt: now(), machine: { platform: platform(), release: release(), architecture: process.arch, logicalCpus: cpus().length, cpu: cpus()[0]?.model ?? null, physicalMemoryBytes: totalmem(), node: process.version }, build: { workingTreeHead, artifactBuildCommit: 'unknown: existing artifacts do not encode a verifiable build commit', packageVersion, artifactDigests, artifacts, note: 'Existing artifact timestamps, bytes and selected content digests only; no new packaging performed and artifacts may predate workingTreeHead.' }, graphCompilation: { method: 'Real shared compiler with explicitly synthetic definitions; excludes renderer layout/paint/interaction and model calls', samples }, longDocumentDigest: { method: 'Real Node SHA-256 over synthetic UTF-8 bytes; excludes Markdown rendering/diff/window interaction', bytes: Buffer.byteLength(document), sampleCount: 5, elapsedMs: documentSamples }, diagnosticProcessMemory: process.memoryUsage(), readiness: 'partial', nativeColdStart: fact('not_run', null, 'No visible app launch or replacement of the active user app; a controlled packaged run remains required'), nativeIdleMemory: fact('not_run', null, 'Node diagnostic memory is not Electron application idle memory'), renderedGraphAndDocument: fact('not_run', null, 'Pure compiler/hash measurements cannot prove native rendering or frame/interaction performance'), proposedBudgets: { status: 'proposal_not_acceptance_threshold', pureCompilerRegressionRatio: 1.5, longDocumentDigestRegressionRatio: 1.5, nativeColdStartMs: null, nativeIdleMemoryBytes: null, renderedInteractionMs: null, note: 'Compare same machine/build method and repeated samples. Native budgets await real controlled measurements and team targets.' } }
}

async function selfTest() {
  const assert = await import('node:assert/strict')
  assert.equal(parseArgs(['--engine', 'none', '--project', 'HONSKY']).jira, false)
  assert.throws(() => parseArgs(['--engine', 'other']))
  assert.throws(() => parseArgs(['--project', 'X" OR 1=1']))
  assert.throws(() => parseArgs(['--turn-timeout-ms', '999999']))
  assert.throws(() => parseArgs(['--engine', 'all', '--model', 'not-common-to-both']))
  knownSecrets.add('synthetic-secret-value')
  const redacted = safeError(new Error('password=synthetic-secret-value Bearer abcdef https://user:pass@example.invalid/test?token=secret'))
  assert.equal(JSON.stringify(redacted).includes('synthetic-secret-value'), false)
  assert.equal(JSON.stringify(redacted).includes('user:pass'), false)
  assert.equal(JSON.stringify(redacted).includes('?token'), false)
  assert.equal(JSON.stringify(safeError(new Error('Authorization: Basic YWJjOmRlZg=='))).includes('YWJjOmRlZg=='), false)
  assert.equal(fact('unknown', null, 'No event observed').status, 'unknown')
  const engine = { capabilities: Object.fromEntries(['start', 'promptWrite', 'readMaterial', 'cancel', 'sameSessionLoad', 'afterCancel'].map((name) => [name, { status: 'supported' }])), cleanup: { unconfirmedPids: [] } }
  assert.equal(scopedEngineReady(engine), true)
  engine.capabilities.cancel.status = 'unknown'; assert.equal(scopedEngineReady(engine), false)
  engine.capabilities.cancel.status = 'supported'; engine.cleanup.unconfirmedPids.push(1); assert.equal(scopedEngineReady(engine), false)
  process.stdout.write('workflow-capability-baseline: bounded argument/redaction/unknown-state checks passed\n')
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) { process.stdout.write('node scripts/smoke/workflow-capability-baseline.mjs --report-dir <new-directory> [--engine none|codex|claude|all] [--model <advertised-id>] [--turn-timeout-ms 60000] [--jira] [--project HONSKY] [--user-data <existing-dir>] [--self-test]\nDefaults perform no model/network probe. Credentials are read only from the existing enabled legacy configuration, never command-line arguments.\n'); return }
  if (opts.selfTest) await selfTest()
  if (!opts.reportDir) { if (opts.selfTest) return; throw new Error('--report-dir is required') }
  const reportDir = resolve(opts.reportDir)
  if (existsSync(join(reportDir, 'readiness.json'))) throw new Error('A completed report already exists; choose a new report directory to preserve prior evidence')
  await mkdir(reportDir, { recursive: true })
  const installation = await installed(opts.userData)
  await writeFile(join(reportDir, 'installed.json'), JSON.stringify(installation, null, 2) + '\n')
  const engines = {}
  for (const agent of opts.engine === 'all' ? ['codex', 'claude'] : opts.engine === 'none' ? [] : [opts.engine]) engines[agent] = await probeEngine(agent, installation.agents[agent], reportDir, opts.turnTimeoutMs, opts.model)
  let jira = { readiness: 'not_run', reason: 'Explicit --jira not supplied; no network request performed' }
  if (opts.jira) try { jira = await discoverJira(opts.userData, opts.project) } catch (error) { jira = { readiness: 'partial', error: safeError(error), writesPerformed: false, reason: 'Jira diagnostic failed; independent Engine/Performance evidence is retained' } }
  await writeFile(join(reportDir, 'jira.json'), JSON.stringify(jira, null, 2) + '\n')
  const perf = await measurePerformance()
  await writeFile(join(reportDir, 'performance.json'), JSON.stringify(perf, null, 2) + '\n')
  const summary = { schemaVersion: 1, capturedAt: now(), source: relative(root, fileURLToPath(import.meta.url)).split(sep).join('/'), installation: 'installed.json', readiness: { Engine: { status: Object.keys(engines).length && Object.values(engines).every((row) => row.readiness === 'ready_for_scoped_stage_adapter') ? 'ready_for_scoped_stage_adapter' : 'partial_or_not_run', agents: Object.fromEntries(Object.entries(engines).map(([agent, row]) => [agent, { status: row.readiness, report: `engine-${agent}.json` }])) }, Jira: { status: jira.readiness, report: 'jira.json', remoteWrites: 'not_run' }, Performance: { status: perf.readiness, report: 'performance.json', native: 'not_run' } }, fixtureClassification: 'Graph/document inputs are explicit synthetic performance fixtures. Engine requests use real installed adapters/providers and owned synthetic files. Jira uses actual configured read-only HTTP. None substitutes for full product integration.', existingLiveAcceptance: { report: '.trellis/tasks/10-16-acp-runtime-foundation/research/ui-redesign/production-vendor-regression.md', capturedDate: '2026-10-17', compatibilityRevision: 1, note: 'Historical built-app evidence is retained, not promoted to current compatibility-revision-2 acceptance.' } }
  await writeFile(join(reportDir, 'readiness.json'), JSON.stringify(summary, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ reportDir, readiness: summary.readiness }) + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { process.stderr.write(JSON.stringify({ status: 'failed', error: safeError(error) }) + '\n'); process.exitCode = 1 })

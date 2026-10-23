/** Actual electron-builder resources -> public acpx -> installed ZCode.
 * This proves package-resource execution, not the packaged GUI/preload/daemon.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAcpRuntime, createFileSessionStore, TRELLIS_ACPX_COMPAT_VERSION } from 'acpx/runtime'
import { createAgentRegistry } from 'acpx/agent-registry'

const flag = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
if (!flag('--package-dir')) {
  console.log('Usage: node scripts/smoke/acp-zcode-packaged.mjs --package-dir <win-unpacked> [--live --zcode-bin <installed CLI>] [--report <JSON>]')
  process.exit(0)
}
const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const packaged = realpathSync.native(resolve(flag('--package-dir')))
const resources = join(packaged, 'resources')
const archive = join(resources, 'app.asar')
const entry = join(resources, 'adapters/zcode-acp/src/index.mjs')
const model = 'account:bigmodel-individual-coding-plan/GLM-5.3-Flash'
const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const archivePath = path => join(...path.split('/'))
const archiveFile = path => asar.extractFile(archive, archivePath(path))
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'trellis-zcode-packaged-')))
const workspace = join(root, 'workspace with spaces')
mkdirSync(workspace)
const report = flag('--report') ? resolve(flag('--report')) : join(root, 'packaged-acceptance.json')
const previousEvidence = existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) : undefined
if (previousEvidence) writeFileSync(join(root, 'previous-packaged-acceptance.json'), JSON.stringify(previousEvidence, null, 2) + '\n')
const evidence = {
  scope: 'actual-electron-builder-adapter-resources-public-acpx-installed-zcode',
  startedAt: new Date().toISOString(), packageDirectory: packaged, retainedTemporaryDirectory: root,
  budgets: { startupMs: 45_000, inferenceMs: 120_000, shutdownMs: 6000, processExitMs: 4000 },
  actualExecutableGuiProof: false,
  qualifications: [
    'Runs the actual copied adapter from resources/adapters; no package or shared out files are rebuilt or replaced.',
    'Public acpx is imported by the Node smoke host; acpx/SDK package bytes are compared against app.asar, allowing only electron-builder removal of package.json scripts/keywords/bugs/devDependencies.',
    'Uses the current native ZCode source/account via the adapter; no alternate provider or configuration writes.',
    'No packaged GUI, renderer, preload, daemon startup, restricted GUI PATH, or human permission acceptance is claimed.'
  ], observations: [],
  ...(previousEvidence ? { previousAttempts: [previousEvidence] } : {}),
  ...(flag('--startup-evidence') ? { packagedStartupEvidence: resolve(flag('--startup-evidence')) } : {})
}
const safeError = value => String(value ?? '').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
  .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\s*[:=]\s*[^\s,;}]+/gi, '$1=[redacted]').slice(0, 700)
const emit = (stage, detail) => { const row = { stage, ...detail }; evidence.observations.push(row); console.log(JSON.stringify(row)) }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(item => item.isDirectory() ? files(join(directory, item.name)) : [join(directory, item.name)])
const pause = ms => new Promise(done => setTimeout(done, ms))
async function bounded(promise, label, milliseconds) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Deadline: ${label}`)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
function execute(command, args, milliseconds = 4000) {
  return new Promise((done, reject) => execFile(command, args, { windowsHide: true, timeout: milliseconds, maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : done(stdout)))
}
const ownedPids = new Set()
const adapterPids = new Set()
let runtime
let stage = 'package-layout'
let cleanupPassed = false
let currentTurnSnapshot
async function recordNativePids() {
  if (process.platform !== 'win32') return
  const literal = workspace.replace(/'/g, "''")
  const script = `Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${literal}') } | Select-Object -ExpandProperty ProcessId`
  const output = await execute(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script])
  for (const line of output.split(/\r?\n/)) if (/^\d+$/.test(line.trim())) ownedPids.add(Number(line))
}
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
try {
  assert.ok(existsSync(archive) && existsSync(join(packaged, 'Trellis Panel.exe')), 'Use the actual electron-builder Windows directory')
  const source = join(project, 'adapters/zcode-acp')
  const adapterHashes = files(source).filter(file => file === join(source, 'package.json') || relative(source, file).startsWith('src'))
    .map(file => {
      const path = relative(source, file)
      const sourceHash = digest(readFileSync(file))
      const packageHash = digest(readFileSync(join(resources, 'adapters/zcode-acp', path)))
      assert.equal(packageHash, sourceHash, `Packaged adapter differs: ${path}`)
      return { path: path.replaceAll('\\', '/'), sha256: packageHash }
    })
  const dependencyFiles = asar.listPackage(archive).map(path => path.replaceAll('\\', '/').replace(/^\//, ''))
    .filter(path => path.startsWith('node_modules/acpx/') && !asar.statFile(archive, archivePath(path)).files)
  assert.ok(dependencyFiles.includes('node_modules/acpx/dist/runtime.js'))
  const dependencyHashes = dependencyFiles.map(path => {
    const packedBytes = archiveFile(path)
    const sourceBytes = readFileSync(join(project, path))
    const packageHash = digest(packedBytes)
    const sourceHash = digest(sourceBytes)
    if (packageHash !== sourceHash && path.endsWith('/package.json')) {
      const packedMetadata = JSON.parse(packedBytes)
      const sourceMetadata = JSON.parse(sourceBytes)
      for (const key of ['scripts', 'keywords', 'bugs', 'devDependencies']) {
        if (!(key in packedMetadata)) delete sourceMetadata[key]
      }
      assert.deepEqual(packedMetadata, sourceMetadata, `Public runtime metadata differs beyond packaging normalization: ${path}`)
    } else assert.equal(packageHash, sourceHash, `Public runtime dependency differs: ${path}`)
    return { path, sha256: packageHash, ...(packageHash !== sourceHash ? { sourceSha256: sourceHash, packagingMetadataNormalized: true } : {}) }
  })
  assert.equal(TRELLIS_ACPX_COMPAT_VERSION, 2)
  evidence.packageIdentity = { appAsarSha256: digest(readFileSync(archive)), executableSha256: digest(readFileSync(join(packaged, 'Trellis Panel.exe'))), adapterHashes,
    acpxVersion: JSON.parse(archiveFile('node_modules/acpx/package.json')).version,
    sdkVersion: JSON.parse(archiveFile('node_modules/acpx/node_modules/@agentclientprotocol/sdk/package.json')).version,
    dependencyHashes }
  emit(stage, { passed: true, adapterFiles: adapterHashes.length, dependencyFiles: dependencyHashes.length, acpxCompatibility: TRELLIS_ACPX_COMPAT_VERSION })
  if (process.argv.includes('--live')) {
    const bin = flag('--zcode-bin')
    assert.ok(bin && existsSync(bin), 'Pass the actual installed ZCode CLI explicitly')
    const deadline = Date.now() + 45_000
    const remaining = () => Math.max(1, deadline - Date.now())
    const store = createFileSessionStore({ stateDir: join(root, 'runtime-store') })
    const nativeEnv = { TRELLIS_ZCODE_DIAGNOSTICS_DIR: root }
    runtime = createAcpRuntime({ cwd: workspace, sessionStore: store,
      agentRegistry: createAgentRegistry({ overrides: { 'packaged-zcode': [process.execPath, '--experimental-strip-types', entry, '--zcode-bin', resolve(bin)] } }),
      agentProcessEnv: nativeEnv, permissionMode: 'deny-all', nonInteractivePermissions: 'deny', fs: false, terminal: false, timeoutMs: 120_000,
      processLifecycle: {
        onBeforeSpawn(info) { assert.equal(resolve(info.command), resolve(process.execPath)); assert.ok(info.args.includes(entry)) },
        onSpawned(info) { ownedPids.add(info.pid); adapterPids.add(info.pid) }
      }
    })
    stage = 'packaged-adapter-native-startup'
    const record = await bounded(runtime.ensureSession({ sessionKey: randomUUID(), agent: 'packaged-zcode', mode: 'persistent' }), stage, remaining())
    const handle = { sessionKey: record.sessionKey, backend: record.backend, runtimeSessionName: record.runtimeSessionName,
      acpxRecordId: record.acpxRecordId, backendSessionId: record.backendSessionId, cwd: workspace }
    await recordNativePids()
    emit(stage, { passed: true, nativeSessionId: record.backendSessionId })
    stage = 'exact-model-acknowledgement'
    const before = await bounded(runtime.getStatus({ handle }), stage, remaining())
    assert.ok(before.models?.availableModelIds.includes(model), 'The exact subscription model must be advertised')
    await bounded(runtime.setModel({ handle, model }), stage, remaining())
    const selected = await bounded(runtime.getStatus({ handle }), stage, remaining())
    assert.equal(selected.models?.currentModelId, model)
    emit(stage, { passed: true, modelId: selected.models.currentModelId })
    stage = 'fresh-file-tool-and-assistant'
    const nonce = randomUUID()
    const nonceFile = join(workspace, 'package-nonce.txt')
    writeFileSync(nonceFile, nonce)
    const events = []
    let permissions = 0
    const permissionDecisions = []
    let observedResult
    let promptWritten = false
    const turn = runtime.startTurn({ handle, mode: 'prompt', requestId: randomUUID(),
      timeoutMs: 120_000,
      text: 'Use only the Read tool to read package-nonce.txt in this workspace. Reply with only the exact file content. Do not modify files or use any other tools.',
      onPermissionRequest: async request => {
        permissions += 1
        const raw = request.raw
        const tool = events.findLast(event => event.type === 'tool_call' && event.toolCallId === raw.toolCall?.toolCallId && event.rawInput)
        const input = tool?.rawInput
        const path = input && typeof input === 'object' ? input.file_path ?? input.path : undefined
        const allow = raw.sessionId === handle.backendSessionId && tool?.title === 'Read' && typeof path === 'string' && resolve(workspace, path) === nonceFile
        const options = raw.options.filter(option => option.kind === (allow ? 'allow_once' : 'reject_once'))
        assert.equal(options.length, 1, 'Require an exact unambiguous native option ID')
        permissionDecisions.push({ toolCallId: raw.toolCall?.toolCallId, kind: options[0].kind, exactScratchRead: allow })
        return { outcome: 'selected', optionId: options[0].optionId }
      }
    })
    const stream = (async () => { for await (const event of turn.events) events.push(event) })()
    currentTurnSnapshot = () => ({ status: observedResult?.status ?? 'no-result-received', stopReason: observedResult?.stopReason, promptWritten,
      ...(observedResult?.error ? { error: { message: safeError(observedResult.error.message), code: observedResult.error.code, detailCode: observedResult.error.detailCode, retryable: observedResult.error.retryable } } : {}),
      errorEvents: events.filter(event => event.type === 'error').slice(-8).map(event => ({ message: safeError(event.message), code: event.code, detailCode: event.detailCode })),
      toolEvents: events.filter(event => event.type === 'tool_call').slice(-32).map(event => ({ toolCallId: event.toolCallId, title: safeError(event.title), status: event.status })),
      assistantCharacters: events.filter(event => event.type === 'text_delta' && event.stream !== 'thought').reduce((count, event) => count + event.text.length, 0),
      thoughtCharacters: events.filter(event => event.type === 'text_delta' && event.stream === 'thought').reduce((count, event) => count + event.text.length, 0),
      permissionDecisions: permissionDecisions.slice(-16) })
    const observedCompletion = turn.result.then(result => { observedResult = result; return result })
    const receipt = turn.promptStarted.then(() => { promptWritten = true })
    const [result] = await bounded(Promise.all([observedCompletion, stream, receipt]), stage, 120_000)
    emit('native-turn-result', currentTurnSnapshot())
    assert.equal(result.status, 'completed', 'Provider errors/cancellation are not successful inference')
    const assistant = events.filter(event => event.type === 'text_delta' && event.stream !== 'thought').map(event => event.text).join('')
    assert.ok(assistant.includes(nonce), 'Fresh unseen file nonce must occur in actual assistant output')
    const completed = events.find(event => event.type === 'tool_call' && event.status === 'completed' && JSON.stringify(event).includes(nonce))
    assert.ok(completed, 'A real completed native tool must return the fresh file nonce')
    emit(stage, { passed: true, assistantText: true, completedFileTool: true, toolCallId: completed.toolCallId, nonceSha256: digest(nonce), nativeSessionId: record.backendSessionId, modelId: model, observedPermissions: permissions, permissionAllowDenyProof: false })
    evidence.liveResourceProof = true
  } else evidence.liveResourceProof = 'not-run: requires --live --zcode-bin'
  evidence.passed = true
} catch (error) {
  evidence.passed = false
  emit('failure', { failedStage: stage, error: safeError(error.message) })
  if (currentTurnSnapshot) emit('native-turn-observation', currentTurnSnapshot())
  process.exitCode = 1
} finally {
  try {
    if (runtime) {
      try { await recordNativePids() }
      catch (error) { emit('cleanup-inventory-error', { error: safeError(error.message) }) }
      await bounded(runtime.shutdown(), 'canonical shutdown', 6000)
    }
    const deadline = Date.now() + 4000
    while ([...ownedPids].some(alive) && Date.now() < deadline) await pause(50)
    assert.ok([...ownedPids].every(pid => !alive(pid)), 'Canonical shutdown must end every observed owned process')
    cleanupPassed = true
  } catch (error) {
    emit('cleanup-failure', { error: safeError(error.message) })
    evidence.passed = false; process.exitCode = 1
    // A timed-out owner may still be alive. Only terminate exact observed PIDs
    // from this scratch workspace; never enumerate/kill unrelated vendor apps.
    for (const pid of [...ownedPids].filter(alive)) {
      try {
        if (process.platform === 'win32') await execute('taskkill.exe', ['/PID', String(pid), '/T', '/F'])
        else process.kill(pid, 'SIGTERM')
      } catch (fallback) { emit('cleanup-fallback-error', { pid, error: safeError(fallback.message) }) }
    }
  }
  emit('owned-process-cleanup', { passed: cleanupPassed, canonical: cleanupPassed, observedProcesses: ownedPids.size, adapterProcesses: adapterPids.size, remainingPids: [...ownedPids].filter(alive) })
  evidence.finishedAt = new Date().toISOString()
  writeFileSync(report, JSON.stringify(evidence, null, 2) + '\n')
  console.log(`EVIDENCE ${report}`)
}

/**
 * node tests/agent-runtime/zcode-startup.mjs
 * node tests/agent-runtime/zcode-startup.mjs --live --zcode-bin <installed zcode.cjs> [--project <cwd>]
 * node tests/agent-runtime/zcode-startup.mjs --live --isolated-matrix --zcode-bin <installed zcode.cjs> [--fs-probe]
 *
 * Live mode creates native sessions with the current account, sends no prompts,
 * and stops only its owned children. Native logs live in a temporary directory
 * and are removed after bounded, allowlisted numeric startup facts are read.
 * These are fresh-process measurements; they do not establish a cold disk cache.
 * --isolated-matrix uses only a temporary home/project: fresh profile create,
 * seeded profile create, and the exact second session resumed in a new process.
 * It also compares snapshot/no-snapshot subscription costs on that owned session.
 * A same-process resume is reported separately from a fresh-process restore.
 * --fs-probe adds observation overhead; compare its counts, not its latency,
 * with ordinary uninstrumented runs. It never changes the installed bundle.
 * --subscription-snapshot restores the previous new-session subscription for
 * comparison. Bundle fingerprint/source locations are read after measurements.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { finished } from 'node:stream/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { ZcodeBackend } from '../../adapters/zcode-acp/src/zcode-backend.mjs'
import { createAccountContext } from '../../adapters/zcode-acp/src/account-context.mjs'
import { createConnectionTimings } from '../../adapters/zcode-acp/src/connection-timings.mjs'

const MAX_LOG_BYTES = 32 * 1024 * 1024
const MAX_LINE_BYTES = 64 * 1024
const MAX_DURATION_MS = 10 * 60_000
const PHASES = new Map([
  ['bootstrap.app.startup.config.completed', 'config'],
  ['bootstrap.app.startup.plugins.completed', 'plugins'],
  ['bootstrap.app.startup.runtime_config.completed', 'runtime-config'],
  ['bootstrap.app.startup.storage.completed', 'storage'],
  ['bootstrap.app.startup.mcp.completed', 'mcp-adapter'],
  ['bootstrap.app.startup.runtime.completed', 'runtime'],
  ['bootstrap.app.startup.completed', 'app-total']
])
const COUNT_KEYS = ['enabledPluginCount', 'pluginCount', 'skillRootCount', 'commandRootCount', 'hookCount', 'mcpServerCount', 'diagnosticCount']
const SNAPSHOT_KEYS = ['contextUsageBreakdownEvents', 'eventSeq', 'goalVerificationEvents', 'persistedMessages', 'persistedSession', 'rewindEvents', 'target', 'todos', 'buildSnapshot']
const duration = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_DURATION_MS
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const numeric = (value, keys) => Object.fromEntries(keys.filter(key => duration(value?.[key])).map(key => [key, value[key]]))

function projectStartup(entry, sessionId) {
  if (!object(entry) || !sessionId || (entry.sessionId ?? entry.context?.sessionId) !== sessionId) return
  const context = object(entry.context) ? entry.context : {}
  if (context.sessionId !== undefined && context.sessionId !== sessionId) return
  const phase = PHASES.get(entry.event)
  if (phase && duration(entry.durationMs)) return { phase, durationMs: entry.durationMs,
    ...(phase === 'plugins' ? { counts: numeric(context, COUNT_KEYS) } : {}),
    ...(phase === 'mcp-adapter' ? { counts: numeric(context, ['mcpServerCount', 'trustedMcpServerCount']) } : {}) }
  if (entry.event === 'zcode_protocol.session_create.completed' && duration(entry.durationMs)) {
    return { phase: 'session-create-total', durationMs: entry.durationMs,
      ...numeric(context, ['recordCreateDurationMs', 'snapshotDurationMs']),
      snapshotPhases: numeric(context.snapshotPhaseDurationsMs, SNAPSHOT_KEYS) }
  }
  if (entry.event === 'zcode_protocol.session.resume_completed' && duration(entry.durationMs)) {
    return { phase: 'session-resume-total', durationMs: entry.durationMs }
  }
}

async function readStartup(directory, sessionId) {
  const phases = new Map()
  let incomplete = false
  let bytes = 0
  for (const name of readdirSync(directory).sort()) {
    if (!/^zcode-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue
    const path = join(directory, name)
    const stat = statSync(path)
    if (!stat.isFile() || realpathSync(path) !== path || bytes + stat.size > MAX_LOG_BYTES) { incomplete = true; continue }
    bytes += stat.size
    // Bound the actual stream too: another native child can grow its log after stat.
    const input = createReadStream(path, { start: 0, end: Math.max(0, stat.size - 1) })
    const lines = createInterface({ input, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) { incomplete = true; continue }
        let entry
        try { entry = JSON.parse(line) } catch { incomplete = true; continue }
        const phase = projectStartup(entry, sessionId)
        if (!phase) continue
        if (phases.has(phase.phase)) { incomplete = true; continue }
        phases.set(phase.phase, phase)
      }
    } finally { lines.close(); input.destroy(); await finished(input).catch(() => {}) }
  }
  return { status: phases.size ? 'observed' : 'unavailable', incomplete, phases: [...phases.values()] }
}

function removeOwned(directory, parent) {
  const actual = realpathSync.native(directory)
  const inside = relative(realpathSync.native(parent), actual)
  assert.ok(inside && !isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`), 'Cleanup must stay within the owned temporary parent')
  assert.ok(basename(directory).startsWith('trellis-zcode-startup-'))
  rmSync(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

async function selfTest() {
  const context = { sessionId: 'owned', recordCreateDurationMs: 38927, snapshotDurationMs: 548,
    snapshotPhaseDurationsMs: { buildSnapshot: 543, unknown: 'SECRET' }, secret: 'SECRET' }
  const complete = { event: 'zcode_protocol.session_create.completed', durationMs: 39491, context }
  assert.equal(projectStartup(complete, 'foreign'), undefined)
  assert.equal(projectStartup({ ...complete, sessionId: 'foreign' }, 'owned'), undefined)
  assert.equal(projectStartup({ ...complete, sessionId: 'owned', context: { sessionId: 'foreign' } }, 'owned'), undefined)
  assert.equal(projectStartup({ ...complete, durationMs: Infinity }, 'owned'), undefined)
  assert.equal(projectStartup({ ...complete, durationMs: -1 }, 'owned'), undefined)
  assert.equal(projectStartup({ ...complete, event: 'model.request.completed' }, 'owned'), undefined)
  assert.equal(projectStartup(complete, undefined), undefined)
  assert.deepEqual(projectStartup(complete, 'owned'), { phase: 'session-create-total', durationMs: 39491,
    recordCreateDurationMs: 38927, snapshotDurationMs: 548, snapshotPhases: { buildSnapshot: 543 } })
  const plugin = { event: 'bootstrap.app.startup.plugins.completed', durationMs: 38645,
    context: { sessionId: 'owned', pluginCount: 17, enabledPluginCount: 13, pluginStorageRoot: 'SECRET', credential: 'SECRET' } }
  assert.deepEqual(projectStartup(plugin, 'owned'), { phase: 'plugins', durationMs: 38645, counts: { enabledPluginCount: 13, pluginCount: 17 } })
  assert.deepEqual(projectStartup({ event: 'zcode_protocol.session.resume_completed', sessionId: 'owned', durationMs: 91 }, 'owned'),
    { phase: 'session-resume-total', durationMs: 91 })
  const io = Object.fromEntries(FS_KEYS.map(key => [key, 0]))
  assert.deepEqual(projectIo({ version: 1, ...io, sourceReadBytes: 900_000_000, secret: 'SECRET',
    firstSeedCheck: { sourceReadCalls: 41, secret: 'SECRET' } }),
  { status: 'observed', ...io, sourceReadBytes: 900_000_000, firstSeedCheck: { sourceReadCalls: 41 } })
  for (const invalid of [NaN, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
    assert.deepEqual(projectIo({ version: 1, ...io, sourceReadBytes: invalid }), { status: 'unavailable' })
  }
  const source = nativeSourceFacts('// fixture\nfunction Coc(e) {}')
  assert.match(source.sha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(source.symbols[0], { symbol: 'function Coc(', utf16Offset: 11, line: 2, column: 1 })
  assert.deepEqual(source.symbols[1], { symbol: 'function Aoc(', status: 'unavailable' })
  const directory = mkdtempSync(join(tmpdir(), 'trellis-zcode-startup-test-'))
  try {
    const path = join(directory, 'zcode-2026-10-24.jsonl')
    writeFileSync(path, [plugin, complete, { ...plugin, context: { sessionId: 'foreign' } },
      { ...plugin, event: 'tool.updated', payload: 'SECRET' }].map(JSON.stringify).join('\n'))
    const result = await readStartup(directory, 'owned')
    assert.equal(result.incomplete, false)
    assert.deepEqual(result.phases.map(item => item.phase), ['plugins', 'session-create-total'])
    assert.ok(!JSON.stringify(result).includes('SECRET'))
    writeFileSync(path, [JSON.stringify(plugin), 'malformed', JSON.stringify(plugin), 'x'.repeat(MAX_LINE_BYTES + 1)].join('\n'))
    assert.equal((await readStartup(directory, 'owned')).incomplete, true)
    writeFileSync(path, '')
    assert.equal((await readStartup(directory, 'owned')).status, 'unavailable')
    assert.throws(() => removeOwned(dirname(directory), directory))
  } finally { removeOwned(directory, tmpdir()) }
  process.stdout.write('PASS startup log ownership, exact numeric subphases, bounded I/O facts, duplicate/malformed logs, no secrets and owned cleanup\n')
}

const FS_KEYS = ['sourceReadCalls', 'sourceReadBytes', 'sourceReadMs', 'sourceReaddirCalls', 'sourceReaddirMs',
  'sourceStatCalls', 'sourceStatMs', 'seedMetadataChecks', 'seedMetadataReads', 'seedMetadataWrites',
  'seedCopyWriteCalls', 'seedCopyWriteBytes', 'seedCopyWriteMs',
  'fileHashCalls', 'fileHashBytes', 'fileHashMs', 'manifestHashCalls', 'manifestHashBytes', 'manifestHashMs',
  'seedVerificationHashCalls', 'seedVerificationHashBytes', 'seedVerificationHashMs']
function projectIo(value) {
  const count = value => Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
  const fields = (value, keys) => Object.fromEntries(keys.filter(key => count(value?.[key])).map(key => [key, value[key]]))
  if (!object(value) || value.version !== 1 || !FS_KEYS.every(key => count(value[key]))) return { status: 'unavailable' }
  return { status: 'observed', ...fields(value, FS_KEYS),
    ...(object(value.firstSeedCheck) ? { firstSeedCheck: fields(value.firstSeedCheck, ['sourceReadCalls', 'sourceReadBytes', 'sourceReaddirCalls', 'sourceReadMs', 'sourceReaddirMs', 'sourceStatMs']) } : {}) }
}

function projectManagedIo(value) {
  const keys = ['sourceReadCalls', 'sourceReadBytes', 'packReadCalls', 'packReadBytes']
  if (!object(value) || !keys.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)) return { status: 'unavailable' }
  return { status: 'observed', ...Object.fromEntries(keys.map(key => [key, value[key]])) }
}

function nativeSourceFacts(source) {
  const signatures = ['function Coc(', 'function Aoc(', 'function Roc(', 'function Moc(', 'function*aoi(', 'function pFn(',
    'function V4n(', 'function lBn(', 'function rBn(', 'function mmi(']
  const symbols = signatures.map(signature => {
    const offset = source.indexOf(signature)
    if (offset < 0) return { symbol: signature, status: 'unavailable' }
    const prefix = source.slice(0, offset)
    return { symbol: signature, utf16Offset: offset, line: prefix.split('\n').length, column: offset - prefix.lastIndexOf('\n') }
  })
  return { sha256: createHash('sha256').update(source).digest('hex'), symbols }
}

async function measure(condition, workspacePath, zcodeBin, directory, { isolatedDir, resumeId, fsProbe = false,
  subscriptionAb = false, subscriptionSnapshot = !!resumeId, startupCacheDir } = {}) {
  mkdirSync(directory)
  const logs = join(directory, 'logs')
  mkdirSync(logs)
  const previous = Object.fromEntries(['ZCODE_LOG_DIR', 'NODE_OPTIONS', 'TRELLIS_ZCODE_STARTUP_FS_FILE', 'TRELLIS_ZCODE_STARTUP_FS_BIN', 'MANAGED_CACHE_TEST_CLI', 'MANAGED_CACHE_TEST_COUNTS'].map(key => [key, process.env[key]]))
  process.env.ZCODE_LOG_DIR = logs
  if (fsProbe) {
    assert.ok(isolatedDir, 'Filesystem observation is restricted to the owned isolated matrix')
    const preload = fileURLToPath(new URL(startupCacheDir
      ? '../../adapters/zcode-acp/test/fixtures/managed-plugin-cache-reads.cjs'
      : '../../adapters/zcode-acp/test/startup-fs-probe.cjs', import.meta.url))
    process.env.NODE_OPTIONS = `${previous.NODE_OPTIONS ?? ''} --require ${JSON.stringify(preload.replace(/\\/g, '/'))}`.trim()
    process.env.TRELLIS_ZCODE_STARTUP_FS_FILE = join(directory, 'fs-counts.json')
    process.env.TRELLIS_ZCODE_STARTUP_FS_BIN = zcodeBin
    if (startupCacheDir) {
      process.env.MANAGED_CACHE_TEST_CLI = realpathSync(zcodeBin)
      process.env.MANAGED_CACHE_TEST_COUNTS = join(directory, 'fs-counts.json')
    }
  }
  const timings = createConnectionTimings(resumeId ? 'load' : 'new', false, directory)
  const storage = []
  const callbacks = { runtimePreferences: 0, accountHeaders: 0, unsupported: 0 }
  let account
  let sessionId
  let nativePid
  let nativeClosed
  let cleanupConfirmed = false
  let failureCode
  let watermarkValid = false
  let accountStatus
  let identityPreserved = false
  let nativeIo
  const subscriptions = []
  let sameProcessResume
  const backend = new ZcodeBackend({ nodePath: process.execPath, zcodeBin, workspacePath, isolatedDir, startupCacheDir, connectionTimings: timings,
    onNotice(method, params) {
      if (method === 'startup/storageState' && storage.length < 24 &&
        ['checking', 'waiting_for_lock', 'migrating', 'committing', 'ready', 'failed'].includes(params.phase)) {
        storage.push({ phase: params.phase, ...(duration(params.elapsedMs) ? { elapsedMs: params.elapsedMs } : {}) })
      }
    },
    onServerRequest(method, params, reply, replyError) {
      if (account?.handleRequest(method, params, reply, replyError)) { callbacks.accountHeaders++; return true }
      callbacks.unsupported++
      replyError(-32601, 'Unsupported connection probe callback')
      return true
    }
  })
  // This callback is handled by the backend itself; observe only the fixed method.
  const handleLine = backend.handleLine.bind(backend)
  backend.handleLine = line => {
    try { if (JSON.parse(line)?.method === 'session/requestRuntimePreferences') callbacks.runtimePreferences++ } catch { /* Non-protocol output. */ }
    handleLine(line)
  }
  try {
    const ready = backend.waitReady()
    nativePid = backend.child?.pid
    if (backend.child) nativeClosed = new Promise(done => backend.child.once('close', done))
    await ready
    assert.ok(backend.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, 'Live probe requires the selected native builtin registry')
    if (isolatedDir) timings.skip('account-sync', 'isolated')
    else {
      account = createAccountContext({ dataBaseDir: backend.providerSource.dataBaseDir,
        builtinPath: backend.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, env: backend.env })
      accountStatus = await timings.measure('account-sync', () => account.sync(backend))
      assert.equal(accountStatus.status, 'verified', 'Live probe requires the current verified account')
    }
    backend.providerSource.assertCurrent()
    const workspace = { workspacePath, workspaceKey: workspacePath.replace(/\\/g, '/').replace(/\/+$/, '') }
    // Profile seeding can exceed the production request deadline on a blank
    // profile. The diagnostic has its own finite deadline and claims no ready
    // result until the actual response and subscription have both arrived.
    const snapshot = await timings.measure('session-create-or-resume', () => backend.request(resumeId ? 'session/resume' : 'session/create', {
      workspace, ...(resumeId ? { sessionId: resumeId } : { persistence: 'immediate' }), mcpServers: []
    }, isolatedDir ? 180_000 : 60_000))
    sessionId = snapshot?.session?.sessionId
    assert.ok(typeof sessionId === 'string' && sessionId.length > 0)
    identityPreserved = !resumeId || sessionId === resumeId
    assert.ok(identityPreserved, 'Resume must retain the original native identity')
    account?.bindSession(sessionId, workspace)
    await timings.measure('subscribe', async () => {
      const subscribed = await backend.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous', includeSnapshot: subscriptionSnapshot,
        ...(resumeId ? {} : { afterSeq: 0 }) })
      watermarkValid = subscribed?.sessionId === sessionId && Number.isSafeInteger(subscribed.eventSeq) && subscribed.eventSeq >= 0
      assert.ok(watermarkValid)
    })
    timings.finish('completed')
    if (fsProbe) {
      try { nativeIo = (startupCacheDir ? projectManagedIo : projectIo)(JSON.parse(readFileSync(join(directory, 'fs-counts.json'), 'utf8'))) }
      catch { nativeIo = { status: 'unavailable' } }
    }
    if (subscriptionAb) {
      // ABBA ordering limits the impact of increasingly warm filesystem pages.
      for (const includeSnapshot of [true, false, false, true]) {
        const began = performance.now()
        const value = await backend.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous', includeSnapshot })
        assert.equal(value.sessionId, sessionId)
        assert.ok(Number.isSafeInteger(value.eventSeq) && value.eventSeq >= 0)
        assert.equal(!!value.snapshot, includeSnapshot)
        subscriptions.push({ includeSnapshot, durationMs: Math.round(performance.now() - began) })
      }
      const began = performance.now()
      const restored = await backend.request('session/resume', { sessionId, workspace, mcpServers: [] })
      assert.equal(restored?.session?.sessionId, sessionId)
      sameProcessResume = { backendReused: true, identityPreserved: true, durationMs: Math.round(performance.now() - began) }
    }
  } catch (error) {
    failureCode = typeof error?.code === 'number' ? error.code : 'probe_failed'
    timings.finish('failed')
  } finally {
    account?.dispose()
    try {
      // Native session/close deletes the persisted session/event record. The
      // isolated matrix retains its identity until its temporary profile is
      // removed, so terminate only this owned process between matrix samples.
      if (sessionId && backend.child && !isolatedDir) await backend.request('session/close', { sessionId }).catch(() => {})
      await backend.killTree()
      if (nativeClosed) await nativeClosed
      cleanupConfirmed = !backend.child
      if (nativePid) {
        try { process.kill(nativePid, 0); cleanupConfirmed = false } catch (error) { if (error.code !== 'ESRCH') cleanupConfirmed = false }
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }
  const nativeStartup = await readStartup(logs, sessionId)
  if (fsProbe && !nativeIo) nativeIo = { status: 'unavailable' }
  // Installed 0.16.9 may keep a no-prompt session only in RAM, even with
  // persistence=immediate. Retain the failed native response as an observation;
  // do not materialize history or send a prompt to make resume appear to work.
  const unavailableResume = !!isolatedDir && !!resumeId && failureCode === -32004
  const result = { condition, freshProcess: true, diskCache: 'uncontrolled', promptsSent: 0, persistence: 'immediate',
    profile: isolatedDir ? 'owned-isolated' : 'current-account', accountVerified: accountStatus?.status === 'verified', managedStartup: !!startupCacheDir,
    identityPreserved, watermarkValid, cleanupConfirmed, callbacks, subscriptionSnapshot,
    storage, timings: timings.finish('failed'), nativeStartup, ...(nativeIo ? { nativeIo, instrumented: true } : {}),
    ...(subscriptions.length ? { subscriptionAb: subscriptions } : {}), ...(failureCode === undefined ? {} : { failureCode }),
    ...(sameProcessResume ? { sameProcessResume } : {}),
    ...(unavailableResume ? { emptySessionResume: 'native-unavailable' } : {}) }
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 8192)
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if ((failureCode !== undefined && !unavailableResume) || !cleanupConfirmed) process.exitCode = 1
  return failureCode === undefined && cleanupConfirmed ? sessionId : undefined
}

await selfTest()
if (process.argv.includes('--live')) {
  const argument = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined }
  const zcodeBin = argument('--zcode-bin')
  assert.ok(isAbsolute(zcodeBin ?? '') && statSync(zcodeBin).isFile(), 'Pass the installed CLI as --zcode-bin with an absolute file path')
  const isolated = process.argv.includes('--isolated-matrix')
  const managed = process.argv.includes('--managed')
  assert.ok(!managed || isolated, '--managed benchmark requires its owned isolated matrix')
  assert.ok(!process.argv.includes('--fs-probe') || isolated, '--fs-probe requires --isolated-matrix')
  assert.ok(!isolated || argument('--project') === undefined, 'The isolated matrix uses only its owned temporary project')
  const project = isolated ? undefined : realpathSync(resolve(argument('--project') ?? process.cwd()))
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'trellis-zcode-startup-live-')))
  try {
    const empty = join(directory, 'workspace')
    mkdirSync(empty)
    const startupCacheDir = managed ? join(directory, 'managed-cache') : undefined
    if (managed) {
      const profile = join(directory, 'profile')
      mkdirSync(profile)
      const launcher = fileURLToPath(new URL('../../adapters/zcode-acp/src/managed-zcode-launch.cjs', import.meta.url))
      const began = performance.now()
      const env = { ...process.env, HOME: profile, USERPROFILE: profile, APPDATA: profile, LOCALAPPDATA: profile,
        ZCODE_HOME: profile, ZCODE_DATA_BASE_DIR: profile, TRELLIS_ZCODE_STARTUP_CACHE_DIR: startupCacheDir }
      const prepared = await promisify(execFile)(process.execPath, [launcher, '--prepare', zcodeBin],
        { env, cwd: empty, windowsHide: true, timeout: 180_000, maxBuffer: 16 * 1024 })
      const report = JSON.parse(prepared.stdout)
      assert.equal(report.status, 'prepared')
      process.stdout.write(`${JSON.stringify({ condition: 'managed-cache-prepare', promptsSent: 0, diskCache: 'uncontrolled', durationMs: Math.round(performance.now() - began), ...report })}\n`)
      assert.deepEqual(readdirSync(profile), [], 'Managed preparation must not initialize or change native profile state')
    }
    // Sequential to avoid measuring contention from the other probe's plugin seeding.
    if (isolated) {
      const options = { isolatedDir: join(directory, 'profile'), fsProbe: process.argv.includes('--fs-probe'), startupCacheDir,
        subscriptionSnapshot: process.argv.includes('--subscription-snapshot') }
      if (await measure('fresh-profile-create', empty, zcodeBin, join(directory, 'fresh'), options)) {
        const sessionId = await measure('seeded-profile-create', empty, zcodeBin, join(directory, 'seeded'), { ...options, subscriptionAb: true })
        if (sessionId) await measure('seeded-profile-resume', empty, zcodeBin, join(directory, 'resume'),
          { ...options, resumeId: sessionId, subscriptionSnapshot: true })
      }
    } else {
      const options = { subscriptionSnapshot: process.argv.includes('--subscription-snapshot') }
      await measure('project', project, zcodeBin, join(directory, 'project'), options)
      await measure('empty', empty, zcodeBin, join(directory, 'empty'), options)
    }
    // Read only after timing: fingerprinting the installed bundle beforehand
    // would itself warm the executable's filesystem pages.
    if (statSync(zcodeBin).size <= MAX_LOG_BYTES) {
      const source = readFileSync(zcodeBin, 'utf8')
      if (Buffer.byteLength(source) <= MAX_LOG_BYTES) process.stdout.write(`${JSON.stringify({ nativeBundle: nativeSourceFacts(source) })}\n`)
    }
  } finally { removeOwned(directory, tmpdir()) }
}

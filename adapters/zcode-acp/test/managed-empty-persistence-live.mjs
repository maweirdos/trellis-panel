import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { CLI_SHA256, sha256, transformVerifiedSource } = require('../src/managed-cache-compat.cjs')
const originalCli = process.argv[2]
if (!originalCli) throw new Error('Pass the installed original CLI as the only argument')
assert.equal(sha256(fs.readFileSync(originalCli)), CLI_SHA256)
const launcher = fileURLToPath(new URL('../src/managed-zcode-launch.cjs', import.meta.url))
const noAssets = fileURLToPath(new URL('./fixtures/managed-empty-persistence-no-assets.cjs', import.meta.url))
const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-empty-persist-live-')))
const evidence = { nativeSha256: CLI_SHA256, modelPromptsSent: 0, cases: [] }
const save = () => fs.writeFileSync(path.join(temporary, 'evidence.json'), JSON.stringify(evidence, null, 2))

class OwnedServer {
  constructor(args, cwd, env, result) {
    this.args = args
    this.cwd = cwd
    this.env = env
    this.result = result
    this.pending = new Map()
    this.id = 1
  }

  async start() {
    const child = spawn(process.execPath, this.args, { cwd: this.cwd, env: this.env,
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    this.closed = once(child, 'close')
    const processResult = { pid: child.pid }
    this.processResult = processResult
    this.result.processes.push(processResult)
    // Native stderr may contain private runtime state; retain no raw output.
    child.stderr.resume()
    let readyResolve, readyReject
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
    const timeout = setTimeout(() => readyReject(new Error('owned storage-ready timeout')), 30_000)
    child.once('error', readyReject)
    child.once('exit', code => {
      readyReject(new Error(`owned app-server exited (${code})`))
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('owned process exited')) }
      this.pending.clear()
    })
    createInterface({ input: child.stdout }).on('line', line => {
      let frame
      try { frame = JSON.parse(line) } catch { return }
      if (frame.method) {
        if (frame.id !== undefined) {
          if (frame.method === 'session/requestRuntimePreferences') this.write({ id: frame.id, result: { nativeSearchEnhancementsEnabled: false } })
          else this.write({ id: frame.id, error: { code: -32601, message: 'No host capability' } })
        } else if (frame.method === 'startup/storageState' && frame.params?.phase === 'ready') readyResolve()
      } else if (this.pending.has(frame.id)) {
        const request = this.pending.get(frame.id)
        clearTimeout(request.timer)
        this.pending.delete(frame.id)
        request.resolve(frame)
      }
    })
    try { await ready } finally { clearTimeout(timeout) }
  }

  write(frame) { this.child.stdin.write(JSON.stringify(frame) + '\n') }

  async request(method, params) {
    assert.ok(['session/create', 'session/resume'].includes(method), 'no prompt, goal or other mutation is permitted')
    const id = this.id++
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timeout`)) }, 60_000)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ id, method, params })
    })
    this.result.requests.push({ method, errorCode: response.error?.code,
      sessionId: response.result?.session?.sessionId, title: response.result?.session?.title,
      messageCount: response.result?.messages?.length })
    return response
  }

  async stop() {
    const child = this.child
    if (!child) return
    let deadline
    let graceful = true
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end()
      graceful = await Promise.race([this.closed.then(() => true), new Promise(resolve => { deadline = setTimeout(() => resolve(false), 12_000) })])
      clearTimeout(deadline)
      if (!graceful) child.kill('SIGKILL') // Only this harness's newly spawned child.
    }
    await this.closed
    Object.assign(this.processResult, { graceful, exitCode: child.exitCode })
    save()
    assert.equal(graceful, true, 'acceptance requires normal stdin-EOF shutdown')
    assert.equal(child.exitCode, 0)
  }
}

function readDatabase(profile) {
  const filename = path.join(profile, '.zcode', 'cli', 'db', 'db.sqlite')
  const db = new DatabaseSync(filename, { readOnly: true })
  try {
    const counts = {}
    for (const table of ['session', 'message', 'part', 'session_input', 'input_history', 'session_target']) {
      counts[table] = db.prepare(`select count(*) as n from ${table}`).get().n
    }
    const sessions = db.prepare('select id, title, title_source, title_message_id from session').all().map(row => ({ ...row }))
    return { counts, sessions }
  } finally { db.close() }
}

try {
  for (const variant of ['managed', 'no-cache-dir', 'bad-cache-dir', 'no-assets', 'stock']) {
    const root = path.join(temporary, variant)
    const profile = path.join(root, 'profile'), cwd = path.join(root, 'workspace')
    const env = {}
    for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'PATH', 'SystemDrive', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) {
      if (process.env[key]) env[key] = process.env[key]
    }
    Object.assign(env, { HOME: profile, USERPROFILE: profile, APPDATA: path.join(profile, 'AppData/Roaming'),
      LOCALAPPDATA: path.join(profile, 'AppData/Local'), TEMP: path.join(profile, 'tmp'), TMP: path.join(profile, 'tmp'),
      XDG_CONFIG_HOME: path.join(profile, 'xdg-config'), XDG_CACHE_HOME: path.join(profile, 'xdg-cache'), XDG_STATE_HOME: path.join(profile, 'xdg-state'),
      ZCODE_HOME: profile, ZCODE_DATA_BASE_DIR: profile, ZCODE_BIN: originalCli, ZCODE_LOG_DIR: path.join(root, 'logs'),
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: path.resolve(path.dirname(originalCli), '../config/provider/zcode-builtin.json') })
    for (const directory of [profile, cwd, env.APPDATA, env.LOCALAPPDATA, env.TEMP, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME, env.ZCODE_LOG_DIR]) fs.mkdirSync(directory, { recursive: true })
    if (variant !== 'no-cache-dir' && variant !== 'stock') env.TRELLIS_ZCODE_STARTUP_CACHE_DIR = path.join(root, 'cache')
    if (variant === 'bad-cache-dir') fs.writeFileSync(env.TRELLIS_ZCODE_STARTUP_CACHE_DIR, 'not-a-directory')
    const args = [...(variant === 'no-assets' ? ['--require', noAssets] : []), ...(variant === 'stock' ? [] : [launcher]), originalCli, 'app-server', '--stdio', '--cwd', cwd]
    const result = { variant, processes: [], requests: [] }
    evidence.cases.push(result)
    const workspace = { workspacePath: cwd, workspaceKey: cwd.split(path.sep).join('/') }
    let immediateId, deferredId
    let server = new OwnedServer(args, cwd, env, result)
    try {
      await server.start()
      const immediate = await server.request('session/create', { workspace, persistence: 'immediate', mcpServers: [] })
      assert.equal(immediate.error, undefined)
      immediateId = immediate.result.session.sessionId
      assert.ok(immediateId)
      assert.equal(immediate.result.messages.length, 0)
      if (variant !== 'stock') assert.equal(immediate.result.session.title, 'Untitled session')
      const deferred = await server.request('session/create', { workspace, persistence: 'deferred', mcpServers: [] })
      assert.equal(deferred.error, undefined)
      deferredId = deferred.result.session.sessionId
      assert.equal(deferred.result.messages.length, 0)
    } finally { await server.stop() }
    const beforeResume = readDatabase(profile)
    assert.deepEqual(beforeResume.counts, { session: variant === 'stock' ? 0 : 1, message: 0, part: 0, session_input: 0, input_history: 0, session_target: 0 })
    if (variant !== 'stock') assert.deepEqual(beforeResume.sessions, [{ id: immediateId, title: 'Untitled session', title_source: 'first_input', title_message_id: null }])
    server = new OwnedServer(args, cwd, env, result)
    try {
      await server.start()
      const resumed = await server.request('session/resume', { sessionId: immediateId, workspace, mcpServers: [] })
      if (variant === 'stock') assert.equal(resumed.error?.code, -32004)
      else {
        assert.equal(resumed.error, undefined)
        assert.equal(resumed.result.session.sessionId, immediateId)
        assert.equal(resumed.result.session.title, 'Untitled session')
        assert.equal(resumed.result.messages.length, 0)
      }
      const deferred = await server.request('session/resume', { sessionId: deferredId, workspace, mcpServers: [] })
      assert.equal(deferred.error?.code, -32004)
    } finally { await server.stop() }
    result.database = readDatabase(profile)
    assert.deepEqual(result.database, beforeResume, 'reopen must not add inputs, targets or rewrite titles')
    assert.equal(sha256(fs.readFileSync(originalCli)), CLI_SHA256, 'original installation is unchanged')
    save()
    process.stdout.write(JSON.stringify({ variant, ...result.database.counts, resume: variant === 'stock' ? -32004 : 'same-id', processes: result.processes }) + '\n')
  }
  // Preparation is tested separately: its transformed entry must never enter mSc.
  const source = fs.readFileSync(originalCli, 'utf8')
  const prepareSource = transformVerifiedSource(source, true)
  assert.ok(prepareSource.includes('bQe();hEt();{let s=module.__trellisManagedCache.prepareReport(Roc());'))
  assert.ok(!prepareSource.includes('Immediate session persistence requires'))
  evidence.complete = true
  save()
  process.stdout.write(JSON.stringify({ evidence: path.join(temporary, 'evidence.json'), nativeSha256: CLI_SHA256, modelPromptsSent: 0 }) + '\n')
} catch (error) {
  evidence.failure = error.message
  save()
  process.stderr.write(`Owned evidence: ${path.join(temporary, 'evidence.json')}\n`)
  throw error
}

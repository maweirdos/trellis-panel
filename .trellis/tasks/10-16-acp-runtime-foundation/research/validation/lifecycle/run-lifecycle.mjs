// Original public-API Windows experiment. No upstream implementation is copied.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const ownRoot = dirname(fileURLToPath(import.meta.url))
const fixture = join(ownRoot, 'agent fixture.mjs')
const self = fileURLToPath(import.meta.url)
const runtimePath = 'C:/Users/Maweirdos/.codex/visualizations/2026/10/16/01a143cf-354c-7ce0-a351-45db825fc514/acpx-validation/node_modules/acpx/dist/runtime.js'
const registryPath = 'C:/Users/Maweirdos/.codex/visualizations/2026/10/16/01a143cf-354c-7ce0-a351-45db825fc514/acpx-validation/node_modules/acpx/dist/agent-registry.js'
const powershell = 'C:/Program Files/PowerShell/7/pwsh.exe'
const systemRoot = process.env.SystemRoot ?? 'C:/WINDOWS'
const taskkill = join(systemRoot, 'System32', 'taskkill.exe')
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const jsonLines = (path) => existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean) : []
const errorView = (error) => ({ name: error?.name, code: error?.code, message: String(error?.message ?? error), cause: error?.cause ? { code: error.cause.code, message: String(error.cause.message ?? error.cause) } : undefined })
const deadline = async (promise, ms, label) => {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms) })]) } finally { clearTimeout(timer) }
}
async function waitUntil(check, ms = 2500) {
  const end = Date.now() + ms
  while (Date.now() < end) { const value = check(); if (value) return value; await sleep(40) }
  throw new Error(`condition did not arrive within ${ms}ms`)
}
function inspectPid(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null
  const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($p){ $p | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress }`
  const value = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 3500 }).trim()
  return value ? JSON.parse(value) : null
}
function isAlive(pid) { try { process.kill(pid, 0); return true } catch { return false } }

if (process.argv.includes('--worker')) {
  const [caseName, nonce, caseRoot, nodeAlias] = process.argv.slice(process.argv.indexOf('--worker') + 1)
  const startedAt = Date.now()
  const lifecycle = []
  const runtimes = []
  const observations = []
  const resultFile = join(caseRoot, 'result.json')
  const lifecycleFile = join(caseRoot, 'lifecycle.jsonl')
  const hostPath = process.env.PATH ?? process.env.Path ?? ''
  const allowEnv = new Set(['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS'])
  const isolatedEnv = {}
  for (const key of Object.keys(process.env)) if (allowEnv.has(key)) isolatedEnv[key] = process.env[key]
  // This process owns the isolated test profile; the invoking shell is unchanged.
  for (const key of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP']) isolatedEnv[key] = join(caseRoot, key.toLowerCase())
  isolatedEnv.PATH = hostPath
  process.env = isolatedEnv
  for (const key of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP']) mkdirSync(process.env[key], { recursive: true })
  mkdirSync(join(caseRoot, 'empty path'), { recursive: true })
  const { createAcpRuntime, createFileSessionStore } = await import(pathToFileURL(runtimePath).href)
  const { createAgentRegistry } = await import(pathToFileURL(registryPath).href)
  const logHook = (kind, info) => {
    const safe = { at: Date.now(), kind, ...info, error: info.error ? errorView(info.error) : undefined }
    lifecycle.push(safe)
    appendFileSync(lifecycleFile, `${JSON.stringify(safe)}\n`)
  }
  const newRuntime = (mode = 'normal', stage = 'main') => {
    let argv = [nodeAlias, fixture, '--root', caseRoot, '--nonce', nonce, '--mode', mode, '--stage', stage, '--extra', 'literal spaces & metacharacters']
    if (caseName === 'original_node') argv[0] = process.execPath
    if (caseName === 'spawn_failure') argv[0] = join(caseRoot, 'deliberately-missing-runtime.exe')
    if (caseName === 'plain_baseline') argv = [process.execPath, join(ownRoot, 'agent-entry.mjs'), '--root', caseRoot, '--nonce', nonce, '--mode', mode, '--stage', stage]
    if (caseName === 'cmd_launcher') {
      const launcher = join(caseRoot, 'bounded launcher.cmd')
      writeFileSync(launcher, `@echo off\r\n"${nodeAlias}" "${fixture}" --root "${caseRoot}" --nonce "${nonce}" --mode normal --stage main\r\n`)
      argv = [launcher, nonce]
    }
    const registry = createAgentRegistry({ overrides: { 'fixture-local': argv } })
    observations.push({ kind: 'registry', stage, requestedArgv: argv, resolvedArgv: registry.resolve('fixture-local') })
    const runtime = createAcpRuntime({
      cwd: caseRoot,
      sessionStore: createFileSessionStore({ stateDir: join(caseRoot, 'state') }),
      agentRegistry: registry,
      agentProcessEnv: ['no_child_env', 'plain_baseline'].includes(caseName) ? undefined : { PATH: join(caseRoot, 'empty path'), TPANEL_LIFECYCLE_MARKER: nonce },
      permissionMode: 'deny-all', nonInteractivePermissions: 'deny', fs: false, terminal: false, verbose: true,
      timeoutMs: 8000,
      processLifecycle: caseName === 'no_lifecycle' ? undefined : {
        onBeforeSpawn(info) { logHook('before', info); if (caseName === 'before_hook_reject') throw new Error('deliberate before-hook rejection') },
        onSpawned(info) { logHook('spawned', info); if (caseName === 'spawned_hook_reject') throw new Error('deliberate spawned-hook rejection') },
        onSpawnFailed(info) { logHook('spawn_failed', info) },
        onExit(info) { logHook('exit', info) }
      }
    })
    runtimes.push(runtime)
    return runtime
  }
  const ensure = (runtime) => runtime.ensureSession({ sessionKey: `lifecycle-${nonce}`, agent: 'fixture-local', mode: 'persistent' })
  const fixtureLogs = () => jsonLines(join(caseRoot, 'fixture.jsonl'))
  const turn = (runtime, handle, signal) => {
    const active = runtime.startTurn({ handle, text: 'local fixture only', mode: 'prompt', requestId: `request-${nonce}`, timeoutMs: 6000, signal })
    active.promptStarted.catch(() => {})
    const events = []
    const stream = (async () => { for await (const event of active.events) events.push(event) })()
    return { active, events, stream }
  }
  const report = { caseName, nonce, startedAt, observations, lifecycle, outcome: 'unsettled' }
  try {
    if (['init_failure', 'spawn_failure', 'before_hook_reject', 'spawned_hook_reject', 'cmd_launcher'].includes(caseName)) {
      const runtime = newRuntime(caseName === 'init_failure' ? 'init-error' : 'normal')
      try { report.handle = await deadline(ensure(runtime), 16000, 'ensure'); report.outcome = 'ensure-resolved' }
      catch (error) { report.error = errorView(error); report.outcome = 'ensure-rejected' }
    } else if (caseName === 'shutdown_startup') {
      const runtime = newRuntime('slow-init')
      const ensuring = ensure(runtime).then((handle) => ({ handle }), (error) => ({ error: errorView(error) }))
      await waitUntil(() => fixtureLogs().some((entry) => entry.method === 'initialize'))
      report.shutdownAt = Date.now()
      await deadline(runtime.shutdown(), 12000, 'shutdown during initialization')
      report.ensureAfterShutdown = await deadline(ensuring, 1000, 'ensure settlement')
      report.outcome = 'shutdown-settled'
    } else if (caseName === 'cancel_reconnect_startup') {
      const initial = newRuntime('normal', 'seed')
      const seedHandle = await ensure(initial)
      await initial.shutdown()
      const reconnectAt = Date.now()
      writeFileSync(join(caseRoot, 'slow-initialize'), 'fixture-controlled reconnect delay')
      const runtime = newRuntime('slow-init', 'reconnect')
      const handle = await runtime.findSession({ sessionKey: `lifecycle-${nonce}`, agent: 'fixture-local' }) ?? seedHandle
      const task = turn(runtime, handle)
      await waitUntil(() => fixtureLogs().some((entry) => entry.at >= reconnectAt && entry.method === 'initialize'))
      report.cancelAt = Date.now()
      await deadline(task.active.cancel({ reason: 'fixture startup cancellation' }), 10000, 'turn startup cancel')
      report.turnResult = await deadline(task.active.result, 8000, 'startup turn result')
      await deadline(task.stream, 1000, 'startup stream settlement')
      report.events = task.events
      report.outcome = 'turn-settled'
    } else {
      const mode = caseName === 'peer_control' ? 'protocol-control' : ['cancel_turn', 'shutdown_busy'].includes(caseName) ? 'busy' : caseName === 'shutdown_grandchild' ? 'grandchild' : 'normal'
      const runtime = newRuntime(mode)
      const handle = await ensure(runtime)
      report.handle = handle
      if (caseName === 'explicit_paths_restricted_path') {
        const task = turn(runtime, handle)
        await task.active.promptStarted
        report.turnResult = await task.active.result
        await task.stream
        report.events = task.events
      } else if (['cancel_turn', 'shutdown_busy'].includes(caseName)) {
        const task = turn(runtime, handle)
        await deadline(task.active.promptStarted, 2500, 'prompt accepted')
        await waitUntil(() => fixtureLogs().some((entry) => entry.method === 'session/prompt'))
        report.actionAt = Date.now()
        if (caseName === 'cancel_turn') await deadline(task.active.cancel({ reason: 'fixture turn cancel' }), 8000, 'turn cancel')
        else await deadline(runtime.shutdown(), 12000, 'busy shutdown')
        report.turnResult = await deadline(task.active.result, 8000, 'turn result')
        await deadline(task.stream, 1000, 'turn stream')
        report.events = task.events
      }
      if (caseName === 'shutdown_grandchild') await waitUntil(() => fixtureLogs().some((entry) => entry.kind === 'grandchild_started'))
      report.shutdownAt = Date.now()
      await deadline(runtime.shutdown(), 12000, 'final shutdown')
      await sleep(250)
      report.aliveAfterRuntimeShutdown = [...new Set(fixtureLogs().filter((entry) => ['agent_started', 'grandchild_started'].includes(entry.kind)).map((entry) => entry.pid))].map((pid) => ({ pid, alive: isAlive(pid) }))
      report.outcome = 'case-settled'
    }
  } catch (error) { report.outcome = 'case-error'; report.error = errorView(error) }
  finally {
    report.cleanup = []
    for (const runtime of runtimes) {
      try { await deadline(runtime.shutdown(), 6000, 'finally shutdown'); report.cleanup.push({ shutdown: 'settled' }) }
      catch (error) { report.cleanup.push({ shutdown: 'failed', error: errorView(error) }) }
    }
    await sleep(150)
    report.fixture = fixtureLogs()
    report.finishedAt = Date.now()
    report.durationMs = report.finishedAt - startedAt
    writeFileSync(resultFile, JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ caseName, outcome: report.outcome, durationMs: report.durationMs, result: report.turnResult, error: report.error }))
  }
} else {
  if (process.platform !== 'win32') throw new Error('This experiment is Windows-only')
  const runRoot = join(ownRoot, 'runs', new Date().toISOString().replace(/[:.]/g, '-'))
  mkdirSync(runRoot, { recursive: true })
  // Runtime alias is an owned local copy, under ignored node_modules; no install occurs.
  const aliasDir = join(ownRoot, 'node_modules', 'Node Runtime With Spaces')
  mkdirSync(aliasDir, { recursive: true })
  const nodeAlias = join(aliasDir, 'node.exe')
  if (!existsSync(nodeAlias)) copyFileSync(process.execPath, nodeAlias)
  const onlyAt = process.argv.indexOf('--only')
  const cases = onlyAt < 0 ? ['explicit_paths_restricted_path', 'init_failure', 'before_hook_reject', 'spawned_hook_reject', 'cancel_turn', 'shutdown_ready', 'shutdown_busy', 'shutdown_startup', 'cancel_reconnect_startup', 'shutdown_grandchild', 'cmd_launcher'] : process.argv[onlyAt + 1].split(',')
  const summaries = []
  for (const caseName of cases) {
    const nonce = randomUUID()
    const caseRoot = process.argv.includes('--plain-cwd') ? join(ownRoot, 'plain', `${Date.now().toString(36)}-${cases.indexOf(caseName)}`) : process.argv.includes('--short') ? join(ownRoot, 'short runs', `${Date.now().toString(36)} ${cases.indexOf(caseName)}`) : join(runRoot, `${caseName} with spaces`)
    mkdirSync(caseRoot, { recursive: true })
    const output = []
    const child = spawn(process.execPath, [self, '--worker', caseName, nonce, caseRoot, nodeAlias], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdout.on('data', (part) => output.push(String(part)))
    child.stderr.on('data', (part) => output.push(String(part)))
    const exit = new Promise((done) => child.once('exit', (code, signal) => done({ code, signal })))
    let completed
    try { completed = await deadline(exit, 30_000, 'outer case') }
    catch (error) { completed = { outerError: errorView(error) } }
    const ownership = []
    const fixtureRecords = jsonLines(join(caseRoot, 'fixture.jsonl'))
    const hookRecords = jsonLines(join(caseRoot, 'lifecycle.jsonl'))
    const candidates = new Set([child.pid, ...fixtureRecords.map((entry) => entry.pid), ...hookRecords.map((entry) => entry.pid)].filter(Number.isInteger))
    for (const pid of candidates) {
      let identity
      try { identity = inspectPid(pid) } catch (error) { ownership.push({ pid, inspectError: errorView(error) }); continue }
      if (!identity) { ownership.push({ pid, alive: false }); continue }
      const command = identity.CommandLine ?? ''
      const expectedScripts = pid === child.pid ? [self] : [fixture, join(ownRoot, 'agent-entry.mjs')]
      const verified = command.includes(nonce) && expectedScripts.some((path) => command.toLowerCase().includes(path.toLowerCase()))
      const row = { pid, alive: true, identity, ownershipVerified: verified }
      if (verified) {
        try { row.cleanup = execFileSync(taskkill, ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true, timeout: 3500 }).trim() }
        catch (error) { row.cleanupError = errorView(error) }
      }
      ownership.push(row)
    }
    await sleep(150)
    const afterCleanup = [...candidates].map((pid) => ({ pid, alive: isAlive(pid) }))
    writeFileSync(join(caseRoot, 'supervisor.json'), JSON.stringify({ caseName, nonce, workerPid: child.pid, completed, ownership, afterCleanup, output }, null, 2))
    const result = existsSync(join(caseRoot, 'result.json')) ? JSON.parse(readFileSync(join(caseRoot, 'result.json'), 'utf8')) : null
    const summary = { caseName, root: caseRoot, completed, outcome: result?.outcome ?? 'no-result', error: result?.error, turnResult: result?.turnResult, hooks: result?.lifecycle.map((entry) => ({ kind: entry.kind, scope: entry.scope, pid: entry.pid, command: entry.command })), aliveAfterRuntimeShutdown: result?.aliveAfterRuntimeShutdown, supervisorCleanup: ownership.filter((entry) => entry.alive), afterCleanup }
    summaries.push(summary)
    console.log(JSON.stringify(summary))
  }
  writeFileSync(join(runRoot, 'summary.json'), JSON.stringify({ version: 'acpx@0.19.5', node: process.version, platform: process.platform, execPath: process.execPath, runRoot, cases: summaries }, null, 2))
  console.log(JSON.stringify({ runRoot, cases: summaries.length }))
}

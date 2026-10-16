// Clean-room validation harness: original code using only published acpx exports.
// Installs, credential changes and application-code modifications are not performed.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const [vendor, dependencyRootArg, adapterRootArg, artifactRootArg] = process.argv.slice(2)
if (!['codex', 'claude'].includes(vendor) || !artifactRootArg) {
  throw new Error('Usage: node run.mjs codex|claude <dependency-root> <adapter-root> <artifact-root>')
}
const dependencyRoot = resolve(dependencyRootArg)
const adapterRoot = resolve(adapterRootArg)
const artifactRoot = resolve(artifactRootArg, vendor, new Date().toISOString().replaceAll(':', '-'))
const fixtureRoot = join(artifactRoot, 'fixture project')
await mkdir(fixtureRoot, { recursive: true })
const nonce = `fixture-${randomUUID()}`
await writeFile(join(fixtureRoot, 'README.md'), `# Isolated ACP validation\n\nEvidence token: ${nonce}\n`, 'utf8')
const requireDependency = createRequire(join(dependencyRoot, 'package.json'))
const { createAcpRuntime, createFileSessionStore, createAgentRegistry } = await import(pathToFileURL(requireDependency.resolve('acpx/runtime')).href)
const adapterPackage = vendor === 'codex' ? '@agentclientprotocol/codex-acp' : '@agentclientprotocol/claude-agent-acp'
const adapterPackageRoot = join(adapterRoot, 'node_modules', ...adapterPackage.split('/'))
const adapterManifest = JSON.parse(await readFile(join(adapterPackageRoot, 'package.json'), 'utf8'))
const adapterEntry = resolve(adapterPackageRoot, typeof adapterManifest.bin === 'string' ? adapterManifest.bin : Object.values(adapterManifest.bin)[0])
const runtimeManifest = JSON.parse(await readFile(join(dependencyRoot, 'node_modules/acpx/package.json'), 'utf8'))
const report = {
  vendor, runtime: runtimeManifest.version, adapter: `${adapterPackage}@${adapterManifest.version}`,
  node: process.version, fixtureRoot, startedAt: new Date().toISOString(),
  acquisition: 'exact installed package; explicit node argv; no npx',
  launches: [], exits: [], turns: [], capabilities: null, status: null, error: null, cleanup: null,
  claudeExecutableOverride: vendor === 'claude' && Boolean(process.env.ACP_VALIDATION_CLAUDE_EXECUTABLE),
  explicitModel: process.env.ACP_VALIDATION_MODEL || null,
  nativeTools: process.env.ACP_VALIDATION_NATIVE_TOOLS === '1',
  includeClaudeUserSettings: process.env.ACPX_CLAUDE_INCLUDE_USER_SETTINGS === '1',
}
const redact = (value) => String(value)
  .replace(/(?:sk-|sk_)[A-Za-z0-9_-]{8,}/g, '[redacted-key]')
  .replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]')
  .replace(/((?:api[_-]?key|access[_-]?token|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
const abortController = new AbortController()
const hardTimer = setTimeout(() => abortController.abort(new Error('validation deadline')), 180_000)
let runtime
let caught
try {
  runtime = createAcpRuntime({
    cwd: fixtureRoot,
    sessionStore: createFileSessionStore({ stateDir: join(artifactRoot, 'runtime-store') }),
    agentRegistry: createAgentRegistry({ overrides: { [vendor]: [process.execPath, adapterEntry] } }),
    permissionMode: 'deny-all',
    timeoutMs: 60_000,
    ...(report.nativeTools ? { fs: false, terminal: false } : {}),
    ...(vendor === 'codex' ? { agentProcessEnv: { INITIAL_AGENT_MODE: 'read-only' } } : {}),
    ...(vendor === 'claude' && process.env.ACP_VALIDATION_CLAUDE_EXECUTABLE
      ? { agentProcessEnv: { CLAUDE_CODE_EXECUTABLE: process.env.ACP_VALIDATION_CLAUDE_EXECUTABLE } } : {}),
    processLifecycle: {
      onSpawned: (event) => { report.launches.push({ pid: event.pid, launchId: event.launchId, startedAt: event.startedAt }); process.stdout.write(JSON.stringify({ stage: 'spawned', vendor, pid: event.pid }) + '\n') },
      onExit: (event) => { report.exits.push({ pid: event.pid, launchId: event.launchId, exitCode: event.exitCode, signal: event.signal, exitedAt: event.exitedAt }) },
    },
    onPermissionRequest: async (request) => {
      const kind = request.inferredKind ?? request.raw?.toolCall?.kind
      const choice = kind === 'read' || kind === 'search' ? 'allow_once' : 'reject_once'
      report.permissions ??= []
      report.permissions.push({ kind, title: redact(request.raw?.toolCall?.title ?? ''), options: request.raw.options.map(({ kind, optionId }) => ({ kind, optionId })), choice })
      return { outcome: choice }
    },
  })
  const handle = await runtime.ensureSession({ sessionKey: `trellis-${vendor}-${randomUUID()}`, agent: vendor, mode: 'persistent', ...(process.env.ACP_VALIDATION_MODEL ? { sessionOptions: { model: process.env.ACP_VALIDATION_MODEL } } : {}) })
  report.handle = { ...handle }
  process.stdout.write(JSON.stringify({ stage: 'session', vendor, hasAgentSessionId: Boolean(handle.agentSessionId) }) + '\n')
  const prompts = [
    { label: 'first-turn', text: 'This is an isolated client integration validation. Reply exactly ACP_VALIDATION_READY and do not use any tools or external resources.', expected: 'ACP_VALIDATION_READY' },
    { label: 'second-turn-context', text: 'What exact token did I ask you to return in the immediately preceding message? Reply with that token only and do not use tools.', expected: 'ACP_VALIDATION_READY' },
    { label: 'read-fixture', text: 'Use an available read-only tool to read README.md in the current working directory. Reply with the Evidence token from that file. Do not modify files, browse the web, or read unrelated files.', expected: nonce },
  ]
  for (const prompt of prompts) {
    const row = { label: prompt.label, events: [], text: '', tools: [], result: null, accepted: false, expectedMatched: false }
    report.turns.push(row)
    const turn = runtime.startTurn({ handle, text: prompt.text, mode: 'prompt', requestId: randomUUID(), signal: abortController.signal, timeoutMs: 60_000 })
    const accepted = turn.promptStarted.then(() => { row.accepted = true }, (error) => { row.acceptError = redact(error?.message ?? error) })
    for await (const event of turn.events) {
      row.events.push({ type: event.type, tag: event.tag })
      if (event.type === 'text_delta' && event.stream !== 'thought') row.text += event.text
      if (event.type === 'tool_call') row.tools.push({ toolCallId: event.toolCallId, status: event.status, title: redact(event.title ?? ''), kind: event.kind })
    }
    row.result = await turn.result
    await accepted
    row.text = redact(row.text)
    row.expectedMatched = row.text.includes(prompt.expected)
    process.stdout.write(JSON.stringify({ stage: 'turn', vendor, label: row.label, accepted: row.accepted, result: row.result, expectedMatched: row.expectedMatched, toolEvents: row.tools.length }) + '\n')
    if (row.result.status !== 'completed' || !row.expectedMatched) throw new Error(`Vendor validation failed at ${prompt.label}`)
  }
  report.capabilities = await runtime.getCapabilities({ handle })
  const status = await runtime.getStatus({ handle })
  report.status = { agentSessionId: status.agentSessionId, backendSessionId: status.backendSessionId, models: status.models, availableCommands: status.availableCommands?.map((entry) => entry.name) }
} catch (error) {
  caught = error
  report.error = { name: error?.name, message: redact(error?.message ?? error), code: error?.code }
  process.stdout.write(JSON.stringify({ stage: 'failed', vendor, error: report.error }) + '\n')
} finally {
  clearTimeout(hardTimer)
  if (runtime) {
    let cleanupTimer
    try {
      await Promise.race([runtime.shutdown(), new Promise((_, reject) => { cleanupTimer = setTimeout(() => reject(new Error('shutdown exceeded 20s')), 20_000) })])
      report.cleanup = 'shutdown-resolved'
    } catch (error) {
      report.cleanup = redact(error?.message ?? error)
    } finally { clearTimeout(cleanupTimer) }
  }
  report.finishedAt = new Date().toISOString()
  await writeFile(join(artifactRoot, 'result.json'), JSON.stringify(report, null, 2), 'utf8')
  process.stdout.write(JSON.stringify({ stage: 'report', vendor, path: join(artifactRoot, 'result.json'), cleanup: report.cleanup, ownedPids: report.launches.map((item) => item.pid), exitPids: report.exits.map((item) => item.pid) }) + '\n')
}
process.exitCode = caught ? 1 : 0

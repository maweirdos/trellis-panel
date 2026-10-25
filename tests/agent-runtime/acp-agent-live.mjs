/** Opt-in installed-vendor evaluation against an owned local knowledge service. */
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { prepareAcpHistoryWorker } from './prepare-acp-history-worker.mjs'

const flag = name => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1)
if (!process.argv.includes('--live')) {
  console.log('NOT RUN: opt-in vendor evaluation: --live --vendor=codex|claude|zcode [--adapter=<installed-entry>] [--zcode-bin=<installed-CLI>]')
  process.exit(0)
}
const vendor = flag('--vendor')
assert.ok(['codex', 'claude', 'zcode'].includes(vendor))
const adapters = {
  codex: { version: '2.2.2', package: '@agentclientprotocol/codex-acp' },
  claude: { version: '0.91.0', package: '@agentclientprotocol/claude-agent-acp' }
}
let args
if (vendor === 'zcode') {
  const cli = flag('--zcode-bin') ?? join(process.env.LOCALAPPDATA ?? '', 'Programs/ZCode/resources/glm/zcode.cjs')
  assert.ok(existsSync(cli), 'An installed ZCode CLI is required; no installation or credential changes occur')
  args = ['--experimental-strip-types', resolve('adapters/zcode-acp/src/index.mjs'), '--zcode-bin', resolve(cli)]
} else {
  const spec = adapters[vendor]
  const packageRoot = join(process.env.APPDATA ?? '', 'trellis-panel/acp/runtimes', vendor, spec.version, 'node_modules', spec.package)
  const metadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(metadata.version, spec.version)
  const bin = typeof metadata.bin === 'string' ? metadata.bin : Object.values(metadata.bin)[0]
  args = [flag('--adapter') ?? join(packageRoot, bin)]
  assert.ok(existsSync(args[0]))
}

const directory = mkdtempSync(join(tmpdir(), `trellis-${vendor}-agent-live-`))
const root = join(directory, 'workspace')
mkdirSync(join(root, '.agents/skills/controlled-policy'), { recursive: true })
mkdirSync(join(root, 'notes'))
process.env.TPAP_SMOKE_DIR = directory
if (!process.argv.includes('--trellis-role=daemon')) process.argv.push('--trellis-role=daemon')
const nonce = { role: `ROLE-${randomUUID()}`, skill: `SKILL-${randomUUID()}`, file: `FILE-${randomUUID()}`, rule: `RULE-${randomUUID()}` }
const skillPath = '.agents/skills/controlled-policy/SKILL.md'
writeFileSync(join(root, skillPath), `---\nname: controlled-policy\ndescription: Use when the user asks about the controlled project policy. Read this skill before explaining that project policy.\n---\nWhen explaining the controlled project policy, read the project file at ${JSON.stringify(join(root, 'notes/nonce.txt'))} and include this workflow verification marker: ${nonce.skill}.\nUse project knowledge tools for the policy itself.\n`)
writeFileSync(join(root, 'notes/nonce.txt'), nonce.file)
const calls = []
const supplied = []
const handles = new Map()
const policyText = `Controlled project policy: records require two independent approvals. Evidence verification marker: ${nonce.rule}.`
const persistKnowledge = () => writeFileSync(join(directory, 'knowledge-evidence.json'), JSON.stringify({ sources: [...handles.values()], supplied }, null, 2))
let currentOwner = true
const hash = value => createHash('sha256').update(value).digest('hex')
globalThis.__AGENT_LIVE_KNOWLEDGE__ = {
  capture: owner => ({ id: 'owned-scope', revision: 'owned-revision', root, projectGeneration: owner.projectGeneration,
    sessionId: owner.sessionId, collectionIds: ['controlled-project-library'], overridden: false, bindingId: 'owned-binding',
    bindingRevision: 1, connectionId: 'owned-connection', connectionRevision: 1, connectionName: 'Controlled local knowledge',
    instanceId: 'controlled-local', status: 'ok', detail: 'Owned local acceptance scope' }),
  search: async (owner, scope, input, signal) => {
    assert.equal(signal.aborted, false)
    assert.equal(owner.root, root)
    assert.equal(owner.isCurrent(), true)
    assert.deepEqual(scope.collectionIds, ['controlled-project-library'])
    calls.push({ kind: 'search', query: input.query, turnId: owner.turnId })
    const text = policyText
    const source = { id: randomUUID(), sourceHandle: randomUUID(), title: 'Controlled project approval policy', text, contentHash: hash(text),
      kind: 'weknora', documentId: 'controlled-policy', collectionId: 'controlled-project-library', relativePath: null, instanceId: 'controlled-local',
      fetchedAt: Date.now(), mode: 'excerpt', truncated: false, sessionId: owner.sessionId, turnId: owner.turnId,
      scopeRevision: scope.revision, suppliedToAgent: false, historical: false }
    handles.set(source.sourceHandle, source); persistKnowledge()
    return { operationId: input.requestId, status: 'ok', detail: 'Controlled project policy found', scope, sources: [source], elapsedMs: 0, persistence: 'durable' }
  },
  read: async (owner, scope, input, signal) => {
    assert.equal(signal.aborted, false); assert.equal(owner.isCurrent(), true)
    const original = handles.get(input.sourceHandle)
    assert.equal(original?.sessionId, owner.sessionId)
    assert.equal(original?.scopeRevision, scope.revision)
    const offset = input.offset ?? 0
    assert.ok(offset <= policyText.length)
    const text = policyText.slice(offset, offset + (input.limit ?? 6000))
    const range = { offset, length: text.length, total: policyText.length, unit: 'utf16-code-units', totalIsComplete: true }
    const source = { ...original, id: randomUUID(), sourceHandle: randomUUID(), text, contentHash: hash(text), mode: 'excerpt',
      truncated: offset > 0 || text.length < policyText.length, range, turnId: owner.turnId, suppliedToAgent: false }
    calls.push({ kind: 'read', turnId: owner.turnId })
    handles.set(source.sourceHandle, source); persistKnowledge()
    return { operationId: input.requestId, status: 'ok', detail: 'Controlled policy text read', source, range,
      nextOffset: offset + text.length < policyText.length ? offset + text.length : null, persistence: 'durable' }
  },
  markSupplied: async (owner, ids) => { assert.equal(owner.isCurrent(), true); supplied.push({ turnId: owner.turnId, count: ids.length }); persistKnowledge() }
}
const report = { vendor, adapterVersion: adapters[vendor]?.version ?? 'bundled', scope: 'live-vendor-with-owned-local-knowledge',
  cases: [], observations: [], permissions: [], directory }
globalThis.__AGENT_LIVE_MCP_NAMES__ = new Map()
let acp
let sessionId
const pause = ms => new Promise(done => setTimeout(done, ms))
const record = () => acp.listAcpSessions(root).sessions.find(value => value.sessionId === sessionId)
const outputEvents = () => (globalThis.__TPANEL_EVENTS__ ?? []).filter(value => value.channel === 'acp:output'
  && value.payload.sessionId === sessionId && value.payload.projectRoot === root).map(value => value.payload)
const permissionSeen = new Set()
const permissionSince = new Map()
async function answerPermissions() {
  const state = sessionId ? record() : undefined
  if (!state) return
  for (const request of state.pendingPermissions ?? []) {
    if (permissionSeen.has(request.requestId)) continue
    permissionSince.set(request.requestId, permissionSince.get(request.requestId) ?? Date.now())
    const events = outputEvents().filter(event => event.kind === 'tool-call' && event.turnId === request.turnId
      && event.connectionGeneration === request.connectionGeneration && event.payload?.toolCallId === request.toolCall?.toolCallId)
    const raw = events.findLast(event => event.payload?.rawInput && typeof event.payload.rawInput === 'object' && !Array.isArray(event.payload.rawInput))?.payload.rawInput
    if (!raw && Date.now() - permissionSince.get(request.requestId) < 2000) continue
    const owned = request.projectRoot === root && request.turnId === state.turnId && request.connectionGeneration === state.connectionGeneration
    const title = request.toolCall?.title ?? ''
    const servers = globalThis.__AGENT_LIVE_MCP_NAMES__.get(sessionId) ?? []
    const knowledge = owned && servers.some(name => title.includes(name)) && /knowledge_(search|read)$/.test(title)
      && raw && (typeof raw.query === 'string' || typeof raw.sourceHandle === 'string')
    let localRead = false
    const path = raw?.file_path ?? raw?.path ?? raw?.filePath
    if (owned && request.toolCall?.kind === 'read' && typeof path === 'string') {
      try {
        const within = relative(realpathSync(root), realpathSync(resolve(root, path)))
        localRead = !isAbsolute(within) && within !== '..' && !within.startsWith('..\\') && !within.startsWith('../')
      } catch { /* Missing/unverifiable targets are not approved. */ }
    }
    const kind = knowledge || localRead ? 'allow_once' : 'reject_once'
    const choices = request.options.filter(option => option.kind === kind)
    assert.equal(choices.length, 1, 'Live harness requires one unambiguous original one-shot permission option')
    assert.equal(acp.respondAcpPermission(root, request.requestId, choices[0].optionId).ok, true)
    permissionSeen.add(request.requestId)
    report.permissions.push({ kind: request.toolCall?.kind, allowed: kind === 'allow_once', optionId: choices[0].optionId })
  }
}
async function until(predicate, label, milliseconds = 180_000) {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) {
    await answerPermissions()
    const found = predicate(); if (found) return found
    await pause(100)
  }
  throw new Error(`Live evaluation deadline: ${label}`)
}
try {
  await prepareAcpHistoryWorker(directory)
  await build({ stdin: { contents: "export * from './src/main/services/acp'; export {setSettings} from './src/main/services/store';", resolveDir: process.cwd(), loader: 'ts' },
    outfile: join(directory, 'service.mjs'), bundle: true, format: 'esm', platform: 'node', alias: { electron: resolve('tests/agent-runtime/mock-electron.mjs') },
    banner: { js: "import {createRequire as liveRequire} from 'node:module'; const require=liveRequire(import.meta.url);" },
    plugins: [{ name: 'owned-live-knowledge', setup(builder) {
      builder.onResolve({ filter: /^file:/ }, ({ path }) => ({ path, external: true }))
      builder.onResolve({ filter: /^acpx\/runtime$/ }, ({ importer }) => /[/\\]services[/\\]acp\.ts$/.test(importer) ? { path: 'runtime', namespace: 'live' } : undefined)
      builder.onResolve({ filter: /^\.\.\/knowledge-access\/service$/ }, () => ({ path: 'knowledge', namespace: 'live' }))
      builder.onLoad({ filter: /.*/, namespace: 'live' }, ({ path }) => ({ contents: path === 'knowledge'
        ? 'export const knowledgeAccess=globalThis.__AGENT_LIVE_KNOWLEDGE__'
        : `export * from ${JSON.stringify(pathToFileURL(resolve('node_modules/acpx/dist/runtime.js')).href)};
          import {createAcpRuntime as actual} from ${JSON.stringify(pathToFileURL(resolve('node_modules/acpx/dist/runtime.js')).href)};
          export const createAcpRuntime=options=>actual({...options,mcpServers:context=>{
            const servers=typeof options.mcpServers==='function'?options.mcpServers(context):options.mcpServers??[];
            globalThis.__AGENT_LIVE_MCP_NAMES__.set(context.sessionKey,servers.map(server=>server.name));return servers;
          }});`, loader: 'js' }))
    } }] })
  acp = await import(pathToFileURL(join(directory, 'service.mjs')).href)
  const runtimeId = `live-${vendor}`
  acp.setSettings({ acp: { agents: [{ id: runtimeId, name: `Installed ${vendor}`, enabled: true, command: 'explicit installed vendor',
    launchKind: 'custom', executable: process.execPath, args }] } })
  const profile = { id: 'live-role', name: 'Controlled live role', description: 'Vendor acceptance only', runtimeId, maxTurnMinutes: 3,
    ...(vendor === 'zcode' ? { env: [{ key: 'TRELLIS_ZCODE_DIAGNOSTICS_DIR', value: join(directory, 'zcode-diagnostics') }] } : {}),
    instructions: `Answer briefly. Use this role verification marker in every final reply: ${nonce.role}. `
      + 'Use project knowledge tools only when project evidence is needed, never for greetings, identity or general knowledge. '
      + 'For the controlled project policy use the controlled-policy skill and the host-scoped knowledge_search tool. Do not use global knowledge connections.', skillPaths: [skillPath] }
  assert.equal(acp.saveAcpProfile(root, profile).ok, true)
  const started = Date.now()
  const created = await acp.newAcpSession(root, { agentId: runtimeId, profileId: profile.id })
  assert.equal(created.ok, true, created.error); sessionId = created.sessionId
  await until(() => ['ready', 'error'].includes(record()?.status), 'connection', 90_000)
  assert.equal(record().status, 'ready', record().error)
  report.observations.push({ phase: 'ready', durationMs: Date.now() - started, capabilities: record().capabilities?.promptCapabilities })
  console.log(JSON.stringify({ vendor, phase: 'ready', durationMs: Date.now() - started }))
  if (vendor === 'zcode') {
    const timing = JSON.parse(readFileSync(join(directory, 'zcode-diagnostics/zcode-adapter-connection-timings.json'), 'utf8'))
    report.observations.push({ phase: 'adapter-timings', ...timing })
    console.log(JSON.stringify({ vendor, phase: 'adapter-timings', ...timing }))
  }
  async function turn(name, text, expectKnowledge) {
    const before = calls.length
    const began = Date.now()
    const sent = await acp.promptAcpSession(root, sessionId, text, undefined, () => currentOwner)
    assert.equal(sent.ok, true, sent.error)
    const event = await until(() => record()?.events.find(value => value.kind === 'turn-done' && value.turnId === sent.turnId), name)
    assert.equal(event.payload.result.status, 'completed', JSON.stringify(event.payload.result))
    await until(() => record()?.status === 'ready', 'retained connection')
    // The live metadata cache intentionally retains only800 rows; evaluate the
    // complete captured transport stream rather than mistaking eviction for loss.
    const events = outputEvents().filter(value => value.turnId === sent.turnId && value.connectionGeneration === record().connectionGeneration)
    const answer = events.filter(value => value.kind === 'message' && value.payload?.role !== 'user').map(value => value.text ?? '').join('')
    assert.ok(answer.includes(nonce.role), 'Role marker must be learned from the independent role resource')
    assert.equal(record().agentContext.state, 'sent')
    assert.equal(events.find(value => value.kind === 'message' && value.payload?.role === 'user').text, text)
    if (expectKnowledge) {
      assert.ok(calls.length > before)
      assert.ok(answer.includes(nonce.rule), 'Answer must use the unseen value returned by the actual knowledge tool')
      assert.ok(answer.includes(nonce.skill), 'Answer must use the unseen marker inside SKILL.md, not its manifest')
      assert.ok(answer.includes(nonce.file), 'Answer must use the unseen scratch-file marker')
      const completed = new Set(events.filter(value => value.kind === 'tool-call' && value.payload?.status === 'completed').map(value => value.payload.toolCallId))
      assert.ok(events.some(value => value.kind === 'tool-call' && completed.has(value.payload?.toolCallId)
        && JSON.stringify(value.payload).includes(nonce.skill)), 'A completed native tool must have emitted the skill marker')
      assert.ok(events.some(value => value.kind === 'tool-call' && completed.has(value.payload?.toolCallId)
        && JSON.stringify(value.payload).includes(nonce.file)), 'A completed native tool must have emitted the scratch marker')
      await until(() => supplied.some(value => value.turnId === sent.turnId && value.count > 0), 'real knowledge delivery receipt')
    } else assert.equal(calls.length, before, `${name} must not query project knowledge`)
    report.cases.push({ name, status: 'passed', durationMs: Date.now() - began, knowledgeCalls: calls.length - before })
    console.log(JSON.stringify({ vendor, ...report.cases.at(-1) }))
  }
  if (!process.argv.includes('--connection-only')) {
    await turn('greeting', '你好，请用一句话打招呼。', false)
    await turn('identity', '你是谁？请简短回答。', false)
    await turn('general-knowledge', '请用一句话介绍火影忍者。', false)
    await turn('project-evidence-and-skill', '请根据当前项目知识库说明 controlled project policy，按适用技能执行，并给出角色、技能流程、文件和知识证据的验证标记。', true)
  }
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = String(error.message).replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]+/gi, '[redacted]').slice(0, 1500)
  console.error(JSON.stringify({ vendor, status: 'failed', error: report.error }))
  process.exitCode = 1
} finally {
  currentOwner = false
  await acp?.shutdownAcp()
  writeFileSync(join(directory, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(`EVIDENCE ${join(directory, 'acceptance.json')}`)
}

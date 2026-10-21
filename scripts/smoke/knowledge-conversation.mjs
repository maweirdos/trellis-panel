/** Actual service/file/MCP/ACP acceptance with isolated fixtures. No vendor model or live remote writes. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { build } from 'esbuild'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { prepareAcpHistoryWorker } from './prepare-acp-history-worker.mjs'

const directory = mkdtempSync(join(tmpdir(), 'tpanel-knowledge-conversation-'))
const root = join(directory, 'project')
const rootB = join(directory, 'other')
const beforeData = process.env.TPAP_SMOKE_DIR
process.env.TPAP_SMOKE_DIR = directory
for (const path of [root, rootB]) {
  mkdirSync(join(path, '.trellis', 'tasks'), { recursive: true })
  mkdirSync(join(path, '.trellis', 'spec'), { recursive: true })
  writeFileSync(join(path, '.trellis', 'spec', 'business.md'), '# Fixture business\nA confirmed business rule for controlled evidence.')
}
await prepareAcpHistoryWorker(directory)
const hash = (text) => createHash('sha256').update(text).digest('hex')
const fixture = { id: 'conversation-native-fixture', name: 'Controlled workflow peer', enabled: true, available: true, launchKind: 'custom', command: 'fixture', executable: process.execPath, args: [resolve('scripts/smoke/knowledge-conversation-peer.mjs')] }
const setup = `export const listAcpAgents=async()=>({ok:true,agents:[${JSON.stringify(fixture)}]});export const launchArgv=async(config)=>[config.executable,...config.args];export const NATIVE_TOOLS_DIAGNOSTIC='Controlled native tools';export const setupAcpRuntime=async()=>({ok:false});export const pickAcpNode=async()=>({ok:false});`
const electronPath = join(directory, 'electron.mjs')
writeFileSync(electronPath, `export * from ${JSON.stringify(pathToFileURL(resolve('scripts/smoke/mock-electron.mjs')).href)};
export const net={fetch:(...args)=>globalThis.__CONVERSATION_FETCH__(...args)};
export const safeStorage={isEncryptionAvailable:()=>true,encryptString:(s)=>Buffer.from('fixture:'+s),decryptString:(s)=>s.toString().slice(8)};`)
let posts = 0
let publishMode = 'success'
let collectionsUnavailable = false
let releasePublish
const respond = (data) => new Response(JSON.stringify({ success: true, data }), { headers: { 'content-type': 'application/json' } })
globalThis.__CONVERSATION_FETCH__ = async (url, options) => {
  assert.equal(new URL(url).hostname, 'fixture.invalid', 'No authenticated real endpoint is used')
  if (String(url).endsWith('/knowledge-bases')) {
    if (collectionsUnavailable) throw Error('Controlled unavailable project library')
    return respond([{ id: 'a', name: 'Library A' }, { id: 'b', name: 'Library B' }])
  }
  if (String(url).endsWith('/knowledge/manual')) { posts++; if (publishMode === 'lost') throw Error('Controlled lost result'); if (publishMode === 'wait') await new Promise((resolve) => { releasePublish = resolve }); return respond({ id: `remote-fixture-${posts}` }) }
  throw new Error('Unexpected remote fixture request: ' + url)
}
const wait = async (predicate, label) => { const until = Date.now() + 15000; while (Date.now() < until) { const value = predicate(); if (value) return value; await new Promise((r) => setTimeout(r, 15)) } throw Error('Timeout: ' + label) }
const clients = []
let host
let bridge
try {
  await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `export * from './src/main/services/knowledge-access/service';export * from './src/main/services/knowledge-access/repository';export * from './src/main/services/integrations/service';export * from './src/main/services/acp';export * from './src/main/state';export {KnowledgeMcpBridge} from './src/main/services/knowledge-mcp/server';export {compileItems} from './src/renderer/src/acp/timeline';` },
    bundle: true, format: 'esm', platform: 'node', outfile: join(directory, 'host.mjs'),
    banner: { js: "import {createRequire as fixtureRequire} from 'node:module';const require=fixtureRequire(import.meta.url);" },
    plugins: [{ name: 'isolated-conversation-fixtures', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: electronPath }))
      builder.onResolve({ filter: /^\.\/acp\/setup$/ }, () => ({ path: 'setup', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: setup, loader: 'js' }))
      builder.onResolve({ filter: /^file:/ }, (args) => ({ path: new URL(args.path).pathname.replace(/^\/([A-Za-z]:)/, '$1') }))
    } }] })
  host = await import(pathToFileURL(join(directory, 'host.mjs')).href)
  assert.equal(host.openProjectAt(root).ok, true)
  let current = true
  let turn = 'direct-turn-a'
  const owner = () => ({ root, projectGeneration: host.getProjectGeneration(), sessionId: 'direct-session', connectionGeneration: 'direct-generation', turnId: turn, originalUserText: 'Save our discussion; perform only requested subsequent steps.', isCurrent: () => current })
  const access = host.knowledgeAccess
  const observations = []
  bridge = new host.KnowledgeMcpBridge(access)
  const connection = await bridge.connect({ root, sessionId: 'direct-session', connectionGeneration: 'direct-generation' }, (event) => observations.push(event))
  const descriptor = connection.servers()[0]
  const client = new Client({ name: 'actual-workflow-test', version: '1.0.0' })
  clients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL(descriptor.url), { requestInit: { headers: Object.fromEntries(descriptor.headers.map(({ name, value }) => [name, value])) } }))
  const call = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); return result.structuredContent ?? JSON.parse(result.content[0].text) }
  const tools = (await client.listTools()).tools
  assert.equal(tools.some((item) => item.name === 'knowledge_document_save' && item.annotations.readOnlyHint === false), true)
  assert.equal((await call('knowledge_document_save', { title: 'Denied', body: 'No active user turn' })).status, 'failed')
  connection.admit(owner())
  assert.equal((await call('knowledge_context')).context.remoteStatus, 'not_configured')
  const saveArgs = { title: '讨论后的需求', body: '# 需求说明\n\n目标：按讨论约定保留单位。\n\n## 待确认\n数量上限尚待业务确认。' }
  const saved = await call('knowledge_document_save', saveArgs)
  assert.equal(saved.status, 'completed')
  assert.equal(readFileSync(join(root, saved.artifact.relativePath), 'utf8'), saveArgs.body)
  assert.equal(saved.artifact.confirmed, false)
  assert.equal(saved.artifact.origin.review, 'not_asserted')
  assert.equal(saved.artifact.origin.userRequestHash, hash(owner().originalUserText))
  const replay = await call('knowledge_document_save', saveArgs)
  assert.equal(replay.artifact.id, saved.artifact.id)
  assert.equal(host.readKnowledgeState(root).artifacts.length, 1)
  assert.equal(readdirSync(join(root, '.trellis', 'notes')).length, 1)
  host.updateConversationActions(root, (actions) => { const action = actions.find((item) => item.operationId === saved.operationId); action.state = 'pending' })
  const recoveredSave = await new host.KnowledgeAccessService().conversation(owner(), access.capture(owner()), { kind: 'save_document', ...saveArgs })
  assert.equal(recoveredSave.artifact.id, saved.artifact.id, 'Recover an action receipt after the file/version already committed')
  assert.equal(host.readKnowledgeState(root).artifacts.length, 1)
  // The larger transport bound accepts a complete Chinese document, not a clipped answer.
  const large = await call('knowledge_document_save', { title: 'Large fixture', body: '业务规则\n'.repeat(15000) })
  assert.equal(large.status, 'completed')
  assert.equal(large.artifact.body.length, 75000)
  const noDestination = await call('knowledge_document_publish', { artifactId: saved.artifact.id, revision: saved.artifact.revision })
  assert.equal(noDestination.status, 'needs_clarification'); assert.equal(posts, 0)
  const externalBody = saveArgs.body + '\n\nExternal business edit.'
  writeFileSync(join(root, saved.artifact.relativePath), externalBody)
  const stale = await call('knowledge_document_save', { ...saveArgs, artifactId: saved.artifact.id, expectedRevision: saved.artifact.revision, body: saveArgs.body + '\nChanged without rereading.' })
  assert.equal(stale.status, 'failed')
  assert.equal(readFileSync(join(root, saved.artifact.relativePath), 'utf8'), externalBody)
  const read = await call('knowledge_document_read', { artifactId: saved.artifact.id })
  assert.equal(read.document.externallyChanged, true)
  assert.equal(read.document.body, externalBody)
  assert.equal(read.document.revision, hash(externalBody))
  turn = 'direct-turn-revise'; connection.admit(owner())
  const revised = await call('knowledge_document_save', { title: saveArgs.title, artifactId: saved.artifact.id, expectedRevision: read.document.revision, body: externalBody + '\nAI clarified the earlier discussion.' })
  assert.equal(revised.status, 'completed')
  assert.equal(host.readKnowledgeState(root).artifacts.filter((item) => item.id === saved.artifact.id).length, 2)
  const handoffArgs = { artifactId: revised.artifact.id, revision: revised.artifact.revision, createTask: true, developerBody: '# Developer requirements\nKeep unresolved questions and unit rule.' }
  const handed = await call('knowledge_document_handoff', handoffArgs)
  assert.equal(handed.status, 'completed')
  assert.equal(handed.handoff.codingStarted, false)
  const task = JSON.parse(readFileSync(join(root, '.trellis', 'tasks', handed.handoff.taskDir, 'task.json'), 'utf8'))
  assert.equal(task.status, 'planning')
  assert.match(readFileSync(join(root, '.trellis', 'tasks', handed.handoff.taskDir, 'prd.md'), 'utf8'), new RegExp(revised.artifact.revision))
  assert.equal((await call('knowledge_document_handoff', handoffArgs)).handoff.taskDir, handed.handoff.taskDir)
  const count = host.readConversationActions(root).length
  const newService = new host.KnowledgeAccessService()
  const recovered = await newService.conversation(owner(), newService.capture(owner()), { kind: 'handoff', ...handoffArgs })
  assert.equal(recovered.handoff.taskDir, handed.handoff.taskDir)
  assert.equal(host.readConversationActions(root).length, count, 'Durable operation identity survives service reconstruction')
  host.updateConversationActions(root, (actions) => { const action = actions.find((item) => item.operationId === handed.operationId); action.state = 'pending'; delete action.taskDir; delete action.prdRevision })
  const recoveredPending = await new host.KnowledgeAccessService().conversation(owner(), access.capture(owner()), { kind: 'handoff', ...handoffArgs })
  assert.equal(recoveredPending.handoff.taskDir, handed.handoff.taskDir, 'Recover the host-created task from its real on-disk identity after a receipt gap')
  assert.equal(readdirSync(join(root, '.trellis', 'tasks')).length, 1)
  assert.equal((await call('knowledge_task_read', { taskDir: handed.handoff.taskDir })).taskPrd.body.includes('Developer requirements'), true)
  assert.equal((await call('knowledge_task_read', { taskDir: '../outside' })).status, 'failed')
  const ambiguous = await call('knowledge_document_handoff', { artifactId: revised.artifact.id, revision: revised.artifact.revision, developerBody: '# Different planning' })
  assert.equal(ambiguous.status, 'needs_clarification')
  const connectionRecord = host.saveConnection({ providerId: 'weknora', name: 'Isolated fixture', enabled: true, config: { baseUrl: 'https://fixture.invalid' }, secrets: { apiKey: { op: 'replace', value: 'fixture-secret' } } })
  const binding = host.saveBinding({ expectedRoot: root, connectionId: connectionRecord.id, connectionRevision: connectionRecord.revision, enabled: true, label: 'Libraries', scope: '', knowledge: { defaultCollectionIds: ['a', 'b'] } })
  turn = 'direct-publish'; connection.admit(owner())
  const pubArgs = { artifactId: revised.artifact.id, revision: revised.artifact.revision }
  collectionsUnavailable = true
  const unavailable = await call('knowledge_document_publish', pubArgs)
  assert.equal(unavailable.status, 'failed')
  assert.match(unavailable.detail, /无需重新绑定/)
  assert.equal(posts, 0, 'A temporary library outage must not send a publication or request a new binding')
  collectionsUnavailable = false
  assert.equal((await call('knowledge_document_publish', pubArgs)).status, 'needs_clarification')
  assert.equal(posts, 0)
  const published = await call('knowledge_document_publish', { ...pubArgs, collectionId: 'a' })
  assert.equal(published.status, 'completed'); assert.equal(published.publication.body, revised.artifact.body); assert.equal(posts, 1)
  assert.equal((await call('knowledge_document_publish', { ...pubArgs, collectionId: 'a' })).publication.remoteDocumentId, published.publication.remoteDocumentId)
  assert.equal(posts, 1)
  publishMode = 'lost'; turn = 'direct-lost'; connection.admit(owner())
  const lost = await call('knowledge_document_publish', { ...pubArgs, collectionId: 'b' })
  assert.equal(lost.status, 'uncertain'); assert.equal(posts, 2)
  assert.equal((await call('knowledge_document_publish', { ...pubArgs, collectionId: 'b' })).status, 'uncertain'); assert.equal(posts, 2)
  publishMode = 'wait'; turn = 'direct-cancel'; connection.admit(owner())
  const pending = call('knowledge_document_publish', { artifactId: large.artifact.id, revision: large.artifact.revision, collectionId: 'a' })
  await wait(() => releasePublish, 'pending persisted before publication')
  const receipt = host.readKnowledgeState(root).publications.find((item) => item.artifactId === large.artifact.id)
  assert.equal(receipt.state, 'pending')
  connection.endTurn(); releasePublish(); releasePublish = undefined
  const committed = await pending
  assert.equal(committed.status, 'completed', 'Cancellation cannot undo an acknowledged committed publication')
  assert.equal(host.readKnowledgeState(root).publications.find((item) => item.requestId === receipt.requestId).state, 'published')
  assert.equal(observations.some((item) => item.knowledgeOperation?.kind === 'save_document' && item.knowledgeOperation.phase === 'completed'), true)
  current = false
  await assert.rejects(newService.conversation(owner(), newService.capture({ ...owner(), isCurrent: () => true }), { kind: 'save_document', ...saveArgs }))
  current = true
  // Disable remote scope for actual ACP, proving local synthesis/save/handoff works without a service binding.
  host.saveBinding({ expectedRoot: root, id: binding.id, revision: binding.revision, connectionId: connectionRecord.id, connectionRevision: connectionRecord.revision, label: 'Libraries', scope: '', enabled: false, knowledge: { defaultCollectionIds: ['a', 'b'] } })
  const native = await host.newAcpSession(root, { agentId: fixture.id })
  assert.equal(native.ok, true)
  const session = () => host.listAcpSessions(root).sessions.find((item) => item.sessionId === native.sessionId)
  await wait(() => session()?.status === 'ready', 'actual ACP session')
  const nativeTurn = await host.promptAcpSession(root, native.sessionId, 'Fixture: save the discussion', undefined, () => true, host.getProjectGeneration())
  assert.equal(nativeTurn.ok, true)
  await wait(() => session()?.status === 'ready' && session()?.events.some((event) => event.kind === 'turn-done' && event.turnId === nativeTurn.turnId), 'actual ACP document save')
  const nativeArtifact = host.readKnowledgeState(root).artifacts.find((item) => item.sessionId === native.sessionId)
  assert.ok(nativeArtifact)
  assert.equal(readFileSync(join(root, nativeArtifact.relativePath), 'utf8'), nativeArtifact.body)
  assert.equal(nativeArtifact.turnId, nativeTurn.turnId)
  assert.equal(nativeArtifact.origin.userRequestHash, hash('Fixture: save the discussion'))
  assert.ok(nativeArtifact.sourceIds.length > 0, 'The controlled conversation used real persisted local evidence')
  const activities = session().events.filter((item) => item.payload?.knowledgeOperation)
  assert.equal(activities.every((item) => item.payload.activityScope === 'turn' && item.turnId === nativeTurn.turnId), true)
  assert.equal(activities.some((item) => item.payload.knowledgeOperation.kind === 'search' && item.payload.knowledgeOperation.phase === 'running'), true)
  assert.equal(activities.some((item) => item.payload.knowledgeOperation.kind === 'save_document' && item.payload.knowledgeOperation.phase === 'completed'), true)
  const projected = host.compileItems(session().events)
  assert.equal(projected.some((item) => item.type === 'knowledge-operation' && item.operation.kind === 'save_document' && item.operation.phase === 'completed'), true, 'Real host events reach the production renderer projection')
  assert.equal(session().events.some((item) => item.kind === 'tool-call' && item.payload?.rawOutput?.result?.structuredContent?.operationId), true, 'The peer supplies the actual Codex MCP result envelope, not prose')
  assert.equal(projected.some((item) => item.type === 'tool' || item.type === 'activity' && item.children?.some((child) => child.type === 'tool')), false, 'Only the corresponding structured native tools are replaced by real operation rows')
  const nativeHandoff = await host.promptAcpSession(root, native.sessionId, 'Fixture: hand it to developer planning', undefined, () => true, host.getProjectGeneration())
  await wait(() => session()?.status === 'ready' && session()?.events.some((event) => event.kind === 'turn-done' && event.turnId === nativeHandoff.turnId), 'actual ACP developer handoff')
  assert.equal(host.readKnowledgeState(root).handoffs.some((item) => item.artifactId === nativeArtifact.id), true)
  const handoffActivity = session().events.find((item) => item.turnId === nativeHandoff.turnId && item.payload?.knowledgeOperation?.kind === 'handoff' && item.payload.knowledgeOperation.phase === 'completed')
  assert.deepEqual(handoffActivity.payload.knowledgeOperation.sourceIds, nativeArtifact.sourceIds, 'Handoff exposes the actual saved document evidence from the earlier discussion turn')
  assert.equal((await host.killAcpSession(root, native.sessionId)).ok, true)
  const stateBefore = host.readKnowledgeState(root)
  host.updateKnowledgeState(root, () => {})
  assert.equal(host.readConversationActions(root).length > 0, true, 'Independent action ledger survives legacy knowledge-state writers')
  assert.equal(host.readKnowledgeState(root).artifacts.length, stateBefore.artifacts.length)
  host.closeProjectAt(); host.openProjectAt(rootB)
  await assert.rejects(newService.conversation(owner(), { ...access.capture({ ...owner(), root: rootB }) }, { kind: 'context' }))
  console.log('knowledge-conversation: PASS (actual scoped MCP + real service/files/creator; CAS/external-edit read; durable replay; ambiguous targets; exact publication/uncertainty/cancel; actual ACP peer saves and hands off with owned timeline facts). Controlled peer body is not intelligence; vendor/live WeKnora remain separate.')
} finally {
  releasePublish?.()
  await Promise.all(clients.map((client) => client.close().catch(() => {})))
  await bridge?.close()
  await host?.shutdownAcp()
  host?.closeProjectAt(); host?.stopTimers()
  delete globalThis.__CONVERSATION_FETCH__
  if (beforeData === undefined) delete process.env.TPAP_SMOKE_DIR; else process.env.TPAP_SMOKE_DIR = beforeData
  assert.equal(directory.startsWith(join(tmpdir(), 'tpanel-knowledge-conversation-')), true)
  rmSync(directory, { recursive: true, force: true })
}

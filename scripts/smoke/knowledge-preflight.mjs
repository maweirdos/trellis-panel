/** Actual facade + pinned public runtime; synthetic read-only service and controlled ACP peer. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, appendFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { prepareAcpHistoryWorker } from './prepare-acp-history-worker.mjs'

const directory = mkdtempSync(join(tmpdir(), 'tpanel-knowledge-preflight-'))
const root = join(directory, 'project')
mkdirSync(join(root, '.trellis'), { recursive: true })
mkdirSync(join(root, '.trellis', 'tasks'), { recursive: true })
await prepareAcpHistoryWorker(directory)
const previous = { data: process.env.TPAP_SMOKE_DIR, journal: process.env.TRELLIS_PREFLIGHT_JOURNAL }
process.env.TPAP_SMOKE_DIR = directory
process.env.TRELLIS_PREFLIGHT_JOURNAL = join(directory, 'peer.jsonl')
const journal = () => { try { return readFileSync(process.env.TRELLIS_PREFLIGHT_JOURNAL, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) } catch { return [] } }
const wait = async (predicate, label) => {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) { const found = predicate(); if (found) return found; await new Promise((resolve) => setTimeout(resolve, 10)) }
  throw new Error(`Timeout: ${label}`)
}
const hash = (text) => createHash('sha256').update(text).digest('hex')
const calls = []
const supplied = []
const conversationCalls = []
let selected = ['project-library']
let revision = 'scope-1'
let current = true
let slow
let failReceipt = false
let acp
let repository
let workflow
const fixtures = ['http', 'no-http', 'unknown'].map((mode) => ({ id: `preflight-${mode}`, name: 'Preflight controlled peer', command: 'fixture', enabled: true, available: true, launchKind: 'custom', executable: process.execPath, args: [resolve('scripts/smoke/knowledge-preflight-peer.mjs'), mode] }))
globalThis.__PREFLIGHT_PORT__ = {
  capture: (owner) => ({ id: 'scope', revision, root: owner.root, projectGeneration: owner.projectGeneration, sessionId: owner.sessionId, collectionIds: selected, overridden: false, bindingId: 'binding', bindingRevision: 1, connectionId: 'connection', connectionRevision: 1, connectionName: 'Fixture', instanceId: 'fixture', status: selected.length ? 'ok' : 'not_configured', detail: 'Controlled selected scope' }),
  search: async (owner, scope, input, signal) => {
    calls.push({ owner, scope, input, signal })
    appendFileSync(process.env.TRELLIS_PREFLIGHT_JOURNAL, `${JSON.stringify({ method: 'host-search', at: Date.now(), query: input.query, turnId: owner.turnId })}\n`)
    if (input.query.startsWith('slow')) await new Promise((resolve) => { slow = resolve })
    if (input.query === 'unavailable') throw new Error('synthetic private upstream failure')
    const texts = input.query === 'mixed-bounds' ? Array.from({ length: 6 }, (_, index) => (index < 3 ? '本' : '库').repeat(5000)) : input.query === 'bounds' ? ['x'.repeat(40_000), '项目业务规则，准确片段。'.repeat(400), 'second exact excerpt', 'y'.repeat(30_000), 'fifth excerpt'] : ['PROJECT-RULE: approved rows only; reports.export permission']
    const sources = input.query === 'no-match' ? [] : texts.map((text, index) => {
      const local = input.query === 'mixed-bounds' && index < 3
      return { id: `source-${input.requestId}-${index}`, sourceHandle: `handle-${input.requestId}-${index}`, title: `Fixture ${index}`, text, contentHash: hash(text), kind: local ? 'local' : 'weknora', documentId: `document-${index}`, collectionId: local ? null : 'project-library', relativePath: local ? `.trellis/spec/local-${index}.md` : null, instanceId: local ? null : 'fixture', fetchedAt: Date.now(), mode: 'excerpt', truncated: true, sessionId: owner.sessionId, turnId: owner.turnId, scopeRevision: scope.revision, suppliedToAgent: false, historical: false }
    })
    if (!signal.aborted && owner.isCurrent()) repository.updateKnowledgeState(root, (state) => { state.sources.push(...sources.map((source) => ({ source, scope }))) })
    return { operationId: input.requestId, status: input.query === 'partial' ? 'partial' : sources.length ? 'ok' : 'empty', detail: input.query === 'partial' ? 'One library unavailable; successful coverage only' : 'Controlled lookup complete', scope, sources, elapsedMs: 1, persistence: 'durable' }
  },
  read: async () => { throw new Error('No full read in this test') },
  markSupplied: async (owner, sourceIds) => {
    if (failReceipt) throw new Error('Synthetic receipt persistence failure')
    await new Promise((resolve) => setTimeout(resolve, 25)); assert.equal(owner.isCurrent(), true)
    repository.updateKnowledgeState(root, (state) => { for (const entry of state.sources) if (sourceIds.includes(entry.source.id)) entry.source.suppliedToAgent = true })
    supplied.push({ owner, sourceIds })
  },
  conversation: async (owner, scope, input, signal) => {
    conversationCalls.push({ owner, scope, input })
    return workflow.run(owner, scope, input, signal)
  }
}
try {
  const setup = `export const listAcpAgents=async()=>({ok:true,agents:${JSON.stringify(fixtures)}}); export const launchArgv=async(config)=>[config.executable,...config.args]; export const NATIVE_TOOLS_DIAGNOSTIC='Controlled native tools'; export const setupAcpRuntime=async()=>({ok:false}); export const pickAcpNode=async()=>({ok:false});`
  const runtime = `export * from ${JSON.stringify(pathToFileURL(resolve('node_modules/acpx/dist/runtime.js')).href)}; import {createAcpRuntime as actual} from ${JSON.stringify(pathToFileURL(resolve('node_modules/acpx/dist/runtime.js')).href)}; export const createAcpRuntime=(options)=>{const runtime=actual(options);const start=runtime.startTurn.bind(runtime);runtime.startTurn=(input)=>{if(globalThis.__PREFLIGHT_WRITE_FAIL__) throw new Error('Controlled writer rejection before promptStarted'); return start(input)};return runtime}`
  await build({ entryPoints: { service: 'src/main/services/acp.ts', preflight: 'src/main/services/knowledge-mcp/preflight.ts', workflow: 'src/main/services/knowledge-access/conversation.ts', repository: 'src/main/services/knowledge-access/repository.ts' }, bundle: true, format: 'esm', platform: 'node',
    banner: { js: "import { createRequire as fixtureRequire } from 'node:module'; const require=fixtureRequire(import.meta.url);" }, alias: { electron: resolve('scripts/smoke/mock-electron.mjs') }, outdir: directory, outExtension: { '.js': '.mjs' },
    plugins: [{ name: 'controlled-read-only-preflight', setup(builder) {
      builder.onResolve({ filter: /^file:/ }, ({ path }) => ({ path, external: true }))
      builder.onResolve({ filter: /^\.\/acp\/setup$/ }, () => ({ path: 'setup', namespace: 'fixture' }))
      builder.onResolve({ filter: /^\.\.\/knowledge-access\/service$/ }, () => ({ path: 'port', namespace: 'fixture' }))
      builder.onResolve({ filter: /^\.\.\/\.\.\/state$/ }, ({ importer }) => /knowledge-access[/\\]conversation\.ts$/.test(importer) ? { path: 'workflow-state', namespace: 'fixture' } : undefined)
      builder.onResolve({ filter: /^acpx\/runtime$/ }, ({ importer }) => importer.endsWith('/services/acp.ts') || importer.endsWith('\\services\\acp.ts') ? { path: 'runtime', namespace: 'fixture' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'setup' ? setup : path === 'runtime' ? runtime : path === 'workflow-state' ? 'export const createTaskRecord=()=>{throw new Error("No developer task is created by this fixture")}' : 'export const knowledgeAccess=globalThis.__PREFLIGHT_PORT__', loader: 'js' }))
    } }] })
  acp = await import(pathToFileURL(join(directory, 'service.mjs')).href)
  const pure = await import(pathToFileURL(join(directory, 'preflight.mjs')).href)
  repository = await import(pathToFileURL(join(directory, 'repository.mjs')).href)
  const { KnowledgeConversationWorkflow } = await import(pathToFileURL(join(directory, 'workflow.mjs')).href)
  const assertOwner = (owner) => { assert.equal(owner.root, root); assert.equal(owner.isCurrent(), true) }
  workflow = new KnowledgeConversationWorkflow({ collections: async () => ({ items: [{ id: 'project-library', name: 'Controlled project library' }], hasMore: false }) }, assertOwner, (owner, scope) => {
    assertOwner(owner); assert.equal(scope.revision, revision); assert.equal(scope.sessionId, owner.sessionId)
  })
  const actionRequests = [
    '把刚才讨论整理成需求文档', '请把刚才的讨论整理成一份需求说明，并保存', '总结一下上面的对话',
    '帮我润色刚才的回复', '将之前的结论汇总为文档', '把上面的回答翻译为英文',
    '不要查知识库，把刚才讨论整理成需求文档', '别检索项目知识库',
    '别查知识库，按刚才讨论整理成需求文档',
    'Please summarize our discussion into a requirements document.', 'Shorten the previous answer'
  ]
  const evidenceRequests = [
    '皮试医嘱的业务流程是什么', '需求文档模板是什么', '知识库里有没有需求文档模板',
    '先不要整理，查一下皮试规则', '把刚才讨论整理成需求文档，并查知识库核对规则',
    '先核对皮试规则，再整理需求', '“把刚才讨论整理成需求文档”是什么意思',
    '把刚才讨论整理成需求文档需要哪些业务规则', '不要查知识库的规则是什么', '“不要查知识库”，这句话是什么意思',
    '不要查知识库，这句话是什么意思？', '不用查知识库，是不是会漏掉业务规则？',
    '不要查知识库，这不是我的要求，请查知识库核对规则', '不要查知识库，但先核对最新皮试规则',
    'Summarize our discussion and search for the latest rules', 'Explain how to summarize our discussion',
    '把刚才讨论整理成需求文档\n另外查询知识库核对规则'
  ]
  for (const request of actionRequests) assert.equal(pure.skipConversationActionLookup(request), true, request)
  for (const request of evidenceRequests) assert.equal(pure.skipConversationActionLookup(request), false, request)
  const make = async (mode = 'http') => {
    const created = await acp.newAcpSession(root, { agentId: `preflight-${mode}` }); assert.equal(created.ok, true)
    const session = () => acp.listAcpSessions(root).sessions.find((item) => item.sessionId === created.sessionId)
    await wait(() => session()?.status === 'ready', 'native ready')
    return { id: created.sessionId, session }
  }
  let target = await make()
  const send = async (text, options) => {
    const result = await acp.promptAcpSession(root, target.id, text, options, () => current, 7)
    assert.equal(result.ok, true, JSON.stringify(result))
    await wait(() => target.session()?.status === 'ready' && target.session().events.some((event) => event.kind === 'turn-done' && event.turnId === result.turnId), 'settled actual native turn')
    return result
  }
  const first = await send('How can I export approved reports?')
  const received = journal().find((entry) => entry.method === 'prompt')
  assert.equal(calls.length, 1, 'Ordinary peer never voluntarily calls a tool; host still searches')
  assert.ok(journal().findIndex((entry) => entry.method === 'host-search') < journal().findIndex((entry) => entry.method === 'prompt'))
  assert.equal(received.context.sources[0].text, 'PROJECT-RULE: approved rows only; reports.export permission')
  assert.equal(calls[0].owner.originalUserText, 'How can I export approved reports?')
  assert.equal(supplied[0].owner.turnId, first.turnId, 'Immediate answer/done cannot clear the delivery receipt owner')
  assert.deepEqual(supplied[0].sourceIds, received.context.sources.map((source) => source.id))
  const transcript = target.session().events.filter((event) => event.turnId === first.turnId)
  assert.equal(transcript.filter((event) => event.payload?.role === 'user').length, 1)
  assert.equal(transcript.find((event) => event.payload?.role === 'user').payload.delivery, 'preparing')
  assert.ok(transcript.findIndex((event) => event.payload?.role === 'user') < transcript.findIndex((event) => event.payload?.knowledgeOperation?.phase === 'running'))
  assert.ok(transcript.some((event) => event.payload?.promptDelivery?.state === 'sent'))
  assert.equal(transcript.findLast((event) => event.payload?.knowledgeOperation)?.payload.knowledgeOperation.query, 'How can I export approved reports?')
  const beforeAction = { searches: calls.length, supplied: supplied.length, sources: repository.readKnowledgeState(root).sources.length }
  const actionText = '把刚才讨论整理成需求文档'
  const actionTurn = await send(actionText)
  const actionPrompt = journal().filter((entry) => entry.method === 'prompt').at(-1)
  assert.equal(calls.length, beforeAction.searches, 'Consolidation dispatches no content-search port call, including fixture local/remote branches')
  assert.equal(supplied.length, beforeAction.supplied, 'Consolidation does not fabricate another evidence delivery')
  assert.equal(repository.readKnowledgeState(root).sources.length, beforeAction.sources, 'Consolidation adds no new source snapshot')
  assert.equal(actionPrompt.text, actionText, 'Actual ACP input retains the exact original action, not a host lookup packet')
  assert.equal(actionPrompt.context, null)
  const actionEvents = target.session().events.filter((event) => event.turnId === actionTurn.turnId)
  assert.equal(actionEvents.some((event) => event.payload?.knowledgeOperation?.kind === 'search'), false, 'No search operation can generate a knowledge-search spinner')
  assert.equal(actionEvents.filter((event) => event.payload?.role === 'user').length, 1)
  assert.equal(actionEvents.find((event) => event.payload?.role === 'user').text, actionText)
  assert.deepEqual(conversationCalls.map((call) => call.input.kind), ['context', 'save_document'], 'Native scoped workflow tools remain admitted after skipping preflight')
  assert.ok(conversationCalls.every((call) => call.owner.originalUserText === actionText && call.owner.turnId === actionTurn.turnId))
  const saved = journal().find((entry) => entry.method === 'conversation-save').result.artifact
  assert.deepEqual(saved.sourceIds, received.context.sources.map((source) => source.id), 'Saving can reference actually supplied evidence from the preceding turn')
  assert.equal(saved.origin.userRequestHash, hash(actionText))
  assert.equal(readFileSync(join(root, saved.relativePath), 'utf8'), saved.body, 'The actual conversation workflow saved the returned document body')
  assert.ok(actionEvents.some((event) => event.payload?.knowledgeOperation?.kind === 'save_document' && event.payload.knowledgeOperation.phase === 'completed'))
  for (const text of ['把上面的回答翻译为英文', '别检索项目知识库', '别查知识库，按刚才讨论整理成需求文档', '需求文档模板是什么', '先不要整理，查一下皮试规则', '把刚才讨论整理成需求文档，并查知识库核对规则', '不要查知识库，这句话是什么意思？', '不用查知识库，是不是会漏掉业务规则？', '不要查知识库，这不是我的要求，请查知识库核对规则']) {
    const before = calls.length
    await send(text)
    assert.equal(calls.length - before, pure.skipConversationActionLookup(text) ? 0 : 1, 'Actual facade honors the bounded guard: ' + text)
  }
  const beforeCommand = calls.length
  await send('/compact preserve accepted decisions')
  assert.equal(calls.length, beforeCommand, 'A real advertised native command is not an ordinary project question')
  assert.equal(journal().filter((entry) => entry.method === 'prompt').at(-1).text, '/compact preserve accepted decisions', 'Native command arguments remain untouched')
  const beforeRepeat = calls.length
  await send('repeat-query')
  assert.equal(calls.length, beforeRepeat + 3, 'Exact repeat twice reuses preflight; changed query/limit perform distinct lookup')
  const repeats = journal().filter((entry) => entry.method === 'followup')
  assert.equal(repeats[0].result.operationId, repeats[1].result.operationId)
  const repeatingTurn = target.session().events.filter((event) => event.payload?.knowledgeOperation?.query === 'repeat-query' && event.payload.knowledgeOperation.phase === 'running')
  assert.equal(repeatingTurn.length, 2, 'Only preflight limit3 and real increased limit4 start rows; cached calls do not orphan rows')
  for (const query of ['no-match', 'unavailable', 'partial', 'bounds']) await send(query)
  const prompts = journal().filter((entry) => entry.method === 'prompt')
  assert.equal(prompts.find((entry) => entry.text.startsWith('no-match')).context.status, 'empty')
  assert.equal(prompts.find((entry) => entry.text.startsWith('unavailable')).context.status, 'unavailable')
  assert.equal(prompts.find((entry) => entry.text.startsWith('partial')).context.status, 'partial')
  const bounded = prompts.find((entry) => entry.text.startsWith('bounds')).context
  assert.ok(Buffer.byteLength(prompts.find((entry) => entry.text.startsWith('bounds')).text) < 33 * 1024)
  assert.ok(bounded.omittedCount > 0)
  assert.ok(bounded.sources.every((source) => source.contentHash === hash(source.text)))
  assert.ok(!bounded.sources.some((source) => source.text.length === 40_000), 'Oversized snapshot omitted, never clipped under old evidence identity')
  assert.deepEqual(supplied.at(-1).sourceIds, bounded.sources.map((source) => source.id))
  const mixedTurn = await send('mixed-bounds')
  const mixedPrompt = journal().filter((entry) => entry.method === 'prompt').at(-1)
  const mixed = mixedPrompt.context
  assert.equal(mixed.retrievedCount, 6)
  assert.equal(mixed.omittedByKind.local, 3, 'Project-library evidence gets the byte budget before local supplement')
  assert.ok(mixed.omittedCount > 0)
  assert.equal(mixed.sources.length, 2)
  assert.ok(mixed.sources.every((source) => source.kind === 'weknora' && source.contentHash === hash(source.text)))
  assert.deepEqual(mixed.sources.map((source) => source.id), [3, 4].map((index) => `source-${mixed.operationId}-${index}`), 'Stable remote order is preserved without mutating source snapshots')
  assert.ok(Buffer.byteLength(mixedPrompt.text) < 33 * 1024)
  assert.deepEqual(supplied.find((item) => item.owner.turnId === mixedTurn.turnId).sourceIds, mixed.sources.map((source) => source.id), 'Only the actually delivered remote snapshots are marked supplied')
  failReceipt = true
  const degraded = await send('receipt-degraded')
  failReceipt = false
  const degradedRow = target.session().events.findLast((event) => event.turnId === degraded.turnId && event.payload?.knowledgeOperation)
  assert.equal(degradedRow.payload.knowledgeBridge.persistence, 'degraded')
  assert.match(degradedRow.payload.knowledgeOperation.detail, /未能持久化确认/)
  assert.equal(pure.preflightQuery('a'.repeat(1999) + '😀 trailing').query.length, 1999)
  await send('a'.repeat(2001))
  assert.equal(journal().filter((entry) => entry.method === 'prompt').at(-1).context.queryTruncated, true)
  const timedOut = await send('slow-timeout')
  const timeoutContext = journal().filter((entry) => entry.method === 'prompt').at(-1).context
  assert.equal(timeoutContext.status, 'unavailable')
  assert.equal(calls.at(-1).signal.aborted, true)
  assert.match(timeoutContext.detail, /超过等待时限/)
  assert.equal(supplied.some((item) => item.owner.turnId === timedOut.turnId), false)
  slow(); slow = undefined
  const beforeCancel = { prompts: journal().filter((entry) => entry.method === 'prompt').length, supplied: supplied.length }
  const cancelledSend = acp.promptAcpSession(root, target.id, 'slow-cancel', undefined, () => current, 7)
  await wait(() => slow, 'host lookup before native send')
  assert.equal((await acp.cancelAcpSession(root, target.id)).ok, true)
  assert.equal((await cancelledSend).ok, false)
  assert.equal(target.session().status, 'ready')
  assert.equal(calls.at(-1).signal.aborted, true)
  slow(); slow = undefined
  assert.equal(journal().filter((entry) => entry.method === 'prompt').length, beforeCancel.prompts)
  assert.equal(supplied.length, beforeCancel.supplied)
  assert.ok(target.session().events.some((event) => event.payload?.promptDelivery?.state === 'not_sent'))
  assert.equal(target.session().events.filter((event) => event.turnId === calls.at(-1).owner.turnId && event.payload?.knowledgeOperation).at(-1).payload.knowledgeOperation.phase, 'cancelled')
  await send('next actual turn')
  const old = calls.at(-1)
  const stale = acp.promptAcpSession(root, target.id, 'slow-scope', undefined, () => current, 7)
  await wait(() => slow, 'scope-change lookup')
  revision = 'scope-2'; slow(); slow = undefined
  assert.equal((await stale).ok, false)
  assert.equal(supplied.some((item) => item.owner.turnId === calls.at(-1).owner.turnId), false)
  assert.notEqual(old.owner.turnId, calls.at(-1).owner.turnId)
  await acp.killAcpSession(root, target.id)
  target = await make()
  const beforeFailure = supplied.length
  globalThis.__PREFLIGHT_WRITE_FAIL__ = true
  const failed = await acp.promptAcpSession(root, target.id, 'writer-failure', undefined, () => current, 7)
  delete globalThis.__PREFLIGHT_WRITE_FAIL__
  assert.equal(failed.ok, false)
  assert.equal(supplied.length, beforeFailure, 'Rejected startTurn/writer has no delivery acknowledgement')
  assert.ok(target.session().events.some((event) => event.payload?.promptDelivery?.state === 'not_sent'))
  await acp.killAcpSession(root, target.id)
  for (const mode of ['no-http', 'unknown']) {
    target = await make(mode)
    const before = calls.length
    await send(`ordinary domain question ${mode}`)
    assert.equal(calls.length, before + 1, 'Plain-text evidence is independent of native HTTP tool transport')
    assert.equal(journal().filter((entry) => entry.method === 'prompt').at(-1).context.status, 'ok')
    await acp.killAcpSession(root, target.id)
  }
  target = await make()
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1cAAAAASUVORK5CYII='
  const beforeImage = calls.length
  await send('', { images: [{ id: 'image-1', name: 'one.png', mimeType: 'image/png', data: png }] })
  assert.equal(calls.length, beforeImage)
  assert.equal(journal().filter((entry) => entry.method === 'prompt').at(-1).imageCount, 1)
  selected = []
  await send('ordinary unbound question')
  assert.equal(calls.length, beforeImage, 'No selected project libraries preserve ordinary native behavior')
  assert.equal(journal().filter((entry) => entry.method === 'prompt').at(-1).text, 'ordinary unbound question')
  await acp.killAcpSession(root, target.id)
  selected = ['project-library']; target = await make()
  const beforeEmptyAction = { searches: calls.length, saves: journal().filter((entry) => entry.method === 'conversation-save').length, sources: repository.readKnowledgeState(root).sources.length }
  const emptyAction = await send(actionText)
  assert.equal(calls.length, beforeEmptyAction.searches, 'A missing preceding discussion does not turn the consolidation command into a topic search')
  assert.equal(repository.readKnowledgeState(root).sources.length, beforeEmptyAction.sources)
  assert.equal(journal().filter((entry) => entry.method === 'conversation-save').length, beforeEmptyAction.saves, 'The controlled peer does not manufacture a document without preceding discussion')
  assert.equal(journal().filter((entry) => entry.method === 'prompt').at(-1).text, actionText)
  assert.ok(journal().some((entry) => entry.method === 'conversation-no-history'))
  assert.equal(target.session().events.some((event) => event.turnId === emptyAction.turnId && event.payload?.knowledgeOperation?.kind === 'search'), false)
  console.log('knowledge-preflight: PASS actual facade/public-runtime controlled peer; narrow conversation actions skip eager search and keep exact native input; real workflow save reuses earlier evidence; ordinary evidence still precedes first answer; same-turn exact reuse; changed query/limit/scope; exact bounded sources; timeout/abort-ready cleanup; no-match/unavailable/partial; image-only/unbound/HTTP-independent delivery. Controlled document body/writer seam are not semantic model or vendor acceptance.')
} finally {
  slow?.()
  await acp?.shutdownAcp()
  if (previous.data === undefined) delete process.env.TPAP_SMOKE_DIR; else process.env.TPAP_SMOKE_DIR = previous.data
  if (previous.journal === undefined) delete process.env.TRELLIS_PREFLIGHT_JOURNAL; else process.env.TRELLIS_PREFLIGHT_JOURNAL = previous.journal
  delete globalThis.__PREFLIGHT_PORT__; delete globalThis.__PREFLIGHT_WRITE_FAIL__
  assert.ok(directory.startsWith(join(tmpdir(), 'tpanel-knowledge-preflight-')))
  rmSync(directory, { recursive: true, force: true })
}

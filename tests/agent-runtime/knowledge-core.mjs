/** Controlled storage/provider fixtures only. No native model or authenticated remote traffic. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { build } from 'esbuild'

const temporary = mkdtempSync(join(tmpdir(), 'trellis-knowledge-core-'))
process.env.TPAP_SMOKE_DIR = temporary
const rootA = join(temporary, 'project-a'); const rootB = join(temporary, 'project-b')
for (const root of [rootA, rootB]) {
  mkdirSync(join(root, '.trellis', 'tasks', 'developer'), { recursive: true })
  mkdirSync(join(root, '.trellis', 'spec'), { recursive: true })
  writeFileSync(join(root, '.trellis', 'tasks', 'developer', 'task.json'), JSON.stringify({ id: 'developer', status: 'planning' }))
  writeFileSync(join(root, '.trellis', 'tasks', 'developer', 'prd.md'), '# Developer\nOld body')
  writeFileSync(join(root, '.trellis', 'spec', 'known.md'), '# Local knowledge\nfixture business rule')
}
globalThis.__KNOWLEDGE_ROOT__ = rootA; globalThis.__KNOWLEDGE_GENERATION__ = 1
globalThis.__KNOWLEDGE_ENCRYPTION__ = true
let calls = []; let posts = 0; let mode = 'ok'; let liveText = 'Exact remote source text'; let releasePublish; let releaseRead
const respond = (data) => new Response(JSON.stringify({ success: true, data }), { headers: { 'content-type': 'application/json' } })
globalThis.__KNOWLEDGE_FETCH__ = async (url, options) => {
  assert.equal(options.redirect, 'error'); assert.equal(options.headers['X-API-Key'], 'fixture-secret')
  const path = new URL(url).pathname; calls.push({ path, options })
  if (path.endsWith('/knowledge-bases')) return respond([{ id: 'collection-a', name: 'A', knowledge_count: 1 }, { id: 'collection-b', name: 'B', knowledge_count: 1 }])
  if (path.endsWith('/knowledge-search')) {
    const body = JSON.parse(options.body); assert.equal(body.knowledge_base_ids.length, 1)
    if (mode === 'wait') return new Promise((_resolve, reject) => { const aborted = () => reject(new DOMException('cancelled', 'AbortError')); options.signal.addEventListener('abort', aborted, { once: true }); if (options.signal.aborted) aborted() })
    if (mode === 'malformed') return respond({ not: 'an array' })
    if (mode === 'oversized') return new Response('x'.repeat(2 * 1024 * 1024 + 1))
    if (mode === 'empty') return respond([])
    const id = body.knowledge_base_ids[0]
    if (mode === 'partial' && id === 'collection-b') return new Response('', { status: 503 })
    if (mode === 'denied') return new Response('', { status: 403 })
    return respond([{ knowledge_id: `document-${id}`, knowledge_title: `Remote ${id}`, content: liveText }])
  }
  if (path.endsWith('/knowledge/manual')) { posts++; if (mode === 'publish-wait') await new Promise((resolve) => { releasePublish = resolve }); if (mode === 'lost') throw new Error('fixture-secret network loss'); if (mode === 'reject') return new Response('', { status: 403 }); return respond(mode === 'missing-id' ? {} : { id: `created-${posts}` }) }
  if (/\/knowledge\/[^/]+\/preview$/.test(path)) { if (mode === 'read-wait') await new Promise((resolve) => { releaseRead = resolve }); return respond(liveText) }
  if (/\/knowledge\/[^/]+$/.test(path)) return respond({ id: mode === 'wrong-document' ? 'foreign-document' : path.split('/').pop(), title: mode === 'fence-stress' ? '😀'.repeat(300) : 'Live text', file_type: mode === 'unsupported' ? 'pdf' : 'txt', knowledge_base_id: mode === 'moved' ? 'foreign-collection' : path.includes('collection-b') ? 'collection-b' : 'collection-a' })
  if (path.includes('/knowledge?')) return respond([])
  if (path.endsWith('/knowledge')) return respond([{ id: 'document-collection-a', title: 'Listed', file_type: 'txt', knowledge_base_id: mode === 'wrong-list-collection' ? 'foreign-collection' : 'collection-a' }])
  throw new Error(`Unexpected fixture request: ${path}`)
}
const stateFixture = join(temporary, 'state-fixture.mjs')
writeFileSync(stateFixture, `import {join} from 'node:path'; import {readFileSync} from 'node:fs';
export const getProjectRoot=()=>globalThis.__KNOWLEDGE_ROOT__;
export const getProjectGeneration=()=>globalThis.__KNOWLEDGE_GENERATION__;
export const getSnapshot=()=>({tasks:[],archived:[]});
export const findTask=(name)=>{const path=join(getProjectRoot(),'.trellis','tasks',name);try{return {path,dirName:name,record:JSON.parse(readFileSync(join(path,'task.json'),'utf8'))}}catch{return null}};`)
const electronFixture = join(temporary, 'electron-fixture.mjs')
writeFileSync(electronFixture, `export * from ${JSON.stringify(pathToFileURL(resolve('tests/agent-runtime/mock-electron.mjs')).href)};
export const app={getPath:()=>process.env.TPAP_SMOKE_DIR};
export const safeStorage={isEncryptionAvailable:()=>globalThis.__KNOWLEDGE_ENCRYPTION__,encryptString:(v)=>{if(!globalThis.__KNOWLEDGE_ENCRYPTION__)throw Error('fixture');return Buffer.from('protected:'+v)},decryptString:(v)=>{if(!globalThis.__KNOWLEDGE_ENCRYPTION__)throw Error('fixture');const text=v.toString();if(!text.startsWith('protected:'))throw Error('invalid');return text.slice(10)}};
export const net={fetch:(...args)=>globalThis.__KNOWLEDGE_FETCH__(...args)};`)
const localTaskFixture = join(temporary, 'local-task-fixture.mjs')
writeFileSync(localTaskFixture, `export class LocalControlStore{};export const localRuntimeDirOf=(root)=>root;export const workspaceIdForRoot=(root)=>root;`)
const changeProject = (root) => { globalThis.__KNOWLEDGE_ROOT__ = root; globalThis.__KNOWLEDGE_GENERATION__++ }
const input = (root = rootA, sessionId = 'session-a') => ({ expectedRoot: root, sessionId })
let service
try {
  await build({ stdin: { contents: `export * from './src/main/services/knowledge-access/service';export * from './src/main/services/knowledge-access/repository';export * from './src/main/services/knowledge-mcp/results';export * from './src/main/services/integrations/repository';export * from './src/main/services/integrations/service';export {installKnowledgeWorkspaceHost} from './src/main/services/knowledge-access/workspace-host';export {installIntegrationWorkspaceHost} from './src/main/services/integrations/workspace-host';export {setSettings,getSettings} from './src/main/services/store';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, format: 'esm', platform: 'node', outfile: join(temporary, 'core.mjs'),
    banner: { js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);" },
    plugins: [{ name: 'knowledge-fixtures', setup(builder) {
      builder.onResolve({ filter: /(^|\/)state$/ }, () => ({ path: stateFixture }))
      builder.onResolve({ filter: /(^|\/)local-task$/ }, () => ({ path: localTaskFixture }))
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: electronFixture }))
      builder.onResolve({ filter: /^file:/ }, (args) => ({ path: new URL(args.path).pathname.replace(/^\/([A-Za-z]:)/, '$1') }))
    } }] })
  service = await import(pathToFileURL(join(temporary, 'core.mjs')).href)
  service.installKnowledgeWorkspaceHost({ root: () => globalThis.__KNOWLEDGE_ROOT__, generation: () => globalThis.__KNOWLEDGE_GENERATION__, createTask: () => { throw new Error('This fixture does not create tasks') } })
  service.installIntegrationWorkspaceHost({ root: () => globalThis.__KNOWLEDGE_ROOT__, snapshot: () => ({ tasks: [], archived: [] }) })
  const configPath = join(temporary, 'integrations.json')
  const old = { version: 1, connections: [{ id: 'prior', providerId: 'github', name: 'prior', enabled: false, revision: 1, config: { baseUrl: 'https://api.github.com' }, secrets: {}, checkedAt: null, check: 'unverified', detail: '', deleted: false }], bindings: [], receipts: [] }
  writeFileSync(configPath, JSON.stringify(old))
  assert.equal(service.readIntegrationState().version, 2)
  assert.deepEqual(service.readIntegrationState().connections[0], old.connections[0])
  assert.equal(JSON.parse(readFileSync(configPath + '.v1.bak', 'utf8')).version, 1)
  const migrated = readFileSync(configPath, 'utf8')
  writeFileSync(configPath, '{broken'); assert.throws(() => service.readIntegrationState()); assert.equal(readFileSync(configPath, 'utf8'), '{broken')
  writeFileSync(configPath, JSON.stringify({ version: 999 })); assert.throws(() => service.readIntegrationState()); assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).version, 999)
  writeFileSync(configPath, migrated)
  const connectionInput = { providerId: 'weknora', name: 'Fixture knowledge', enabled: true, config: { baseUrl: 'https://fixture.invalid/api/v1' }, secrets: { apiKey: { op: 'replace', value: 'fixture-secret' } } }
  globalThis.__KNOWLEDGE_ENCRYPTION__ = false
  assert.throws(() => service.saveConnection(connectionInput), /加密/)
  globalThis.__KNOWLEDGE_ENCRYPTION__ = true
  const connection = service.saveConnection(connectionInput)
  assert.equal(connection.config.baseUrl, 'https://fixture.invalid'); assert.equal(JSON.stringify(connection).includes('fixture-secret'), false)
  const bind = (root, ids) => service.saveBinding({ expectedRoot: root, connectionId: connection.id, connectionRevision: connection.revision, label: 'Project knowledge', scope: '', enabled: true, knowledge: { defaultCollectionIds: ids } })
  const bindingA = bind(rootA, ['collection-a'])
  const owner = () => ({ root: rootA, projectGeneration: globalThis.__KNOWLEDGE_GENERATION__, sessionId: 'session-a', turnId: 'turn-a' })
  const access = service.knowledgeAccess
  const scopeA = access.capture(owner()); let result = await access.search(owner(), scopeA, { requestId: randomUUID(), query: 'fixture business', limit: 4 })
  assert.equal(result.status, 'ok'); assert(result.sources.some((s) => s.kind === 'local')); const remote = result.sources.find((s) => s.kind === 'weknora'); assert(remote)
  assert.equal(remote.suppliedToAgent, false); assert.equal(remote.collectionId, 'collection-a')
  assert.equal(calls.filter((call) => call.path.endsWith('knowledge-search')).length, 1)
  assert.equal((await access.source({ ...input(), sourceId: remote.id })).historical, true)
  await assert.rejects(access.source({ ...input(rootA, 'foreign-session'), sourceId: remote.id }), /会话/)
  assert.equal((await access.source({ expectedRoot: rootA, sourceId: remote.id })).historical, true, 'Deliberately project-scoped historical browsing remains available without a selected session')
  assert.equal((await access.sources(input(rootA, 'foreign-session'))).length, 0)
  await access.markSupplied(owner(), [remote.id]); assert.equal((await access.source({ ...input(), sourceId: remote.id })).suppliedToAgent, true)
  const read = await access.read(owner(), scopeA, { requestId: randomUUID(), sourceHandle: remote.sourceHandle }); assert.equal(read.source.text, liveText); assert.notEqual(read.source.id, remote.id)
  liveText = 'Changed remote source'; const reread = await access.read(owner(), scopeA, { requestId: randomUUID(), sourceHandle: remote.sourceHandle }); assert.equal(reread.source.text, liveText); assert.equal((await access.source({ ...input(), sourceId: remote.id })).text, 'Exact remote source text')
  const largeText = '首'.repeat(5999) + '😀' + '业务规则'.repeat(12_000) + '𠮷末尾'
  liveText = largeText
  const fullLegacy = await access.read(owner(), scopeA, { requestId: randomUUID(), sourceHandle: remote.sourceHandle })
  assert.equal(fullLegacy.source.text, largeText, 'No-window UI reads preserve their existing full-body behavior')
  assert.equal(fullLegacy.source.mode, 'full'); assert.equal(fullLegacy.source.range, undefined); assert.equal(fullLegacy.nextOffset, undefined)
  let pageOffset = 0; let assembled = ''; let pageHandle = remote.sourceHandle; let pageCount = 0
  do {
    const page = await access.read(owner(), scopeA, { requestId: randomUUID(), sourceHandle: pageHandle, offset: pageOffset, limit: 6000 })
    assert.equal(page.status, 'ok'); assert.equal(page.persistence, 'durable'); assert.ok(page.source)
    assert.deepEqual(page.range, page.source.range)
    assert.deepEqual(page.range, { offset: pageOffset, length: page.source.text.length, total: largeText.length, unit: 'utf16-code-units', totalIsComplete: true })
    assert.equal(page.source.text, largeText.slice(pageOffset, pageOffset + page.range.length))
    assert.equal(page.source.contentHash, service.knowledgeHash(page.source.text))
    assert.equal(page.source.mode, 'excerpt'); assert.equal(page.source.truncated, true)
    assert.equal(page.source.suppliedToAgent, false, 'Retrieval does not establish native delivery')
    for (const key of ['documentId', 'collectionId', 'instanceId', 'relativePath', 'sessionId', 'scopeRevision']) assert.equal(page.source[key], remote[key])
    assert.notEqual(page.source.id, remote.id)
    const formattedPage = service.formatKnowledgeResult(page, (text) => text)
    assert.strictEqual(formattedPage.sources[0], page.source)
    assert.equal(formattedPage.structuredContent.omittedCount, 0)
    assert.equal(formattedPage.structuredContent.nextOffset, page.nextOffset)
    assert.ok(Buffer.byteLength(JSON.stringify({ content: formattedPage.content, structuredContent: formattedPage.structuredContent, isError: false })) <= service.KNOWLEDGE_RESULT_BYTES)
    assert.deepEqual(service.readKnowledgeState(rootA).sources.find((entry) => entry.source.id === page.source.id).source.range, page.range, 'Page provenance survives durable schema parsing')
    assert.ok(!/[\uD800-\uDBFF]$/u.test(page.source.text) && !/^[\uDC00-\uDFFF]/u.test(page.source.text))
    if (pageCount === 0) assert.ok(page.nextOffset > 0 && page.nextOffset <= 5999, 'The byte budget may shorten a page without splitting Unicode')
    assembled += page.source.text; pageHandle = page.source.sourceHandle; pageCount++
    assert.ok(pageCount < 30)
    if (page.nextOffset === null) break
    assert.equal(page.nextOffset, pageOffset + page.source.text.length); assert.ok(page.nextOffset > pageOffset)
    pageOffset = page.nextOffset
  } while (true)
  assert.equal(assembled, largeText, 'Repeated reads through page handles finish the original document, without nested slicing or omitted bytes')
  const edge = await access.read(owner(), scopeA, { requestId: randomUUID(), sourceHandle: remote.sourceHandle, offset: 5998, limit: 3 })
  assert.equal(edge.source.text, '首😀')
  assert.ok(service.readKnowledgeState(rootA).sources.find((entry) => entry.source.sourceHandle === remote.sourceHandle).readRevision)
  const fullFromPageHandle = await access.read(owner(), scopeA, { requestId: randomUUID(), sourceHandle: pageHandle })
  assert.equal(fullFromPageHandle.source.text, largeText); assert.equal(fullFromPageHandle.source.range, undefined)
  for (const window of [{ offset: -1 }, { offset: 1.5 }, { offset: null }, { offset: NaN }, { offset: Infinity }, { offset: largeText.length + 1 }, { offset: 6000 }, { offset: 5999, limit: 1 }, { offset: 0, limit: 0 }, { offset: 0, limit: null }, { offset: 0, limit: 6001 }]) await assert.rejects(access.read(owner(), scopeA, { requestId: randomUUID(), sourceHandle: remote.sourceHandle, ...window }), /offset|limit/)
  const terminalPage = await access.read(owner(), scopeA, { requestId: randomUUID(), sourceHandle: pageHandle, offset: largeText.length })
  assert.equal(terminalPage.nextOffset, null); assert.equal(terminalPage.range.length, 0); assert.equal(terminalPage.source.text, '')
  assert.throws(() => service.updateKnowledgeState(rootA, (state) => { const entry = state.sources.find((entry) => entry.source.range?.length); entry.source.range.length++ }), /存储失败/)
  const freshHandle = async () => (await access.read(owner(), scopeA, { requestId: randomUUID(), sourceHandle: remote.sourceHandle })).source.sourceHandle
  liveText = 'A'.repeat(6000) + 'X'.repeat(6000)
  const pinnedOrigin = await freshHandle()
  const pinnedFirst = await access.read(owner(), scopeA, { requestId: randomUUID(), sourceHandle: pinnedOrigin, offset: 0 })
  const pinnedCount = service.readKnowledgeState(rootA).sources.length
  liveText = 'B'.repeat(6000) + 'Y'.repeat(6000)
  const reopenedReader = new service.KnowledgeAccessService()
  for (const sourceHandle of [pinnedOrigin, pinnedFirst.source.sourceHandle]) {
    for (const reader of [access, reopenedReader]) await assert.rejects(reader.read(owner(), scopeA, { requestId: randomUUID(), sourceHandle, offset: pinnedFirst.nextOffset }), /分页读取期间已改变/)
  }
  assert.equal(service.readKnowledgeState(rootA).sources.length, pinnedCount, 'Changed continuations must neither return nor save mixed-version pages')
  liveText = '远'.repeat(120_000)
  const upstreamTail = await access.read(owner(), scopeA, { requestId: randomUUID(), sourceHandle: await freshHandle(), offset: 98_000 })
  assert.equal(upstreamTail.range.total, 100_000); assert.equal(upstreamTail.range.totalIsComplete, false); assert.equal(upstreamTail.nextOffset, null)
  assert.match(upstreamTail.detail, /上游正文仍有截断/)
  liveText = 'S'.repeat(99_999) + '😀tail'
  const cappedPair = await access.read(owner(), scopeA, { requestId: randomUUID(), sourceHandle: await freshHandle(), offset: 96_000 })
  assert.equal(cappedPair.range.total, 99_999); assert.equal(cappedPair.range.totalIsComplete, false); assert.ok(!/[\uD800-\uDBFF]$/u.test(cappedPair.source.text))
  liveText = '\u0000'.repeat(7000)
  const escapedPage = await access.read(owner(), scopeA, { requestId: randomUUID(), sourceHandle: await freshHandle(), offset: 0 })
  assert.ok(escapedPage.range.length > 0 && escapedPage.range.length < 6000); assert.equal(escapedPage.nextOffset, escapedPage.range.length)
  assert.ok(Buffer.byteLength(JSON.stringify(escapedPage.source.text)) <= 10_000, 'Both legacy text and structured output must contain the exact same page within the wire budget')
  const escapedOutput = service.formatKnowledgeResult(escapedPage, (text) => text)
  assert.equal(escapedOutput.structuredContent.omittedCount, 0); assert.strictEqual(escapedOutput.sources[0], escapedPage.source)
  mode = 'fence-stress'
  for (const body of ['`'.repeat(5360) + '\u0000'.repeat(640), '`'.repeat(3000) + '~'.repeat(3000)]) {
    liveText = body
    const fencePage = await access.read(owner(), scopeA, { requestId: randomUUID(), sourceHandle: await freshHandle(), offset: 0 })
    const formatted = service.formatKnowledgeResult(fencePage, (text) => text)
    assert.equal(formatted.structuredContent.omittedCount, 0, 'Valid default pages must survive long fence runs and maximal titles')
    assert.equal(formatted.structuredContent.source.text, body)
    assert.ok(Buffer.byteLength(JSON.stringify({ content: formatted.content, structuredContent: formatted.structuredContent, _meta: formatted._meta, isError: false })) <= service.KNOWLEDGE_RESULT_BYTES)
  }
  mode = 'ok'
  liveText = 'Storage checkpoint body'
  const storageHandle = await freshHandle()
  const savedSources = service.readKnowledgeState(rootA).sources
  const originEntry = savedSources.find((entry) => entry.source.sourceHandle === storageHandle)
  service.updateKnowledgeState(rootA, (state) => {
    state.sources = [originEntry, ...Array.from({ length: 1499 }, (_, index) => ({ ...originEntry,
      source: { ...originEntry.source, id: `capacity-${index}`, sourceHandle: `capacity-handle-${index}` } }))]
  })
  const unpinned = await access.read(owner(), scopeA, { requestId: randomUUID(), sourceHandle: storageHandle, offset: 0 })
  assert.equal(unpinned.status, 'unavailable'); assert.equal(unpinned.persistence, 'degraded'); assert.equal(unpinned.source, null)
  assert.equal(service.readKnowledgeState(rootA).sources[0].readRevision, undefined, 'Failed checkpoint write must not publish an unpinned page')
  service.updateKnowledgeState(rootA, (state) => { state.sources = savedSources })
  const localSource = result.sources.find((source) => source.kind === 'local')
  const localPath = join(rootA, localSource.relativePath); const originalLocal = readFileSync(localPath, 'utf8')
  const localLarge = 'L'.repeat(100_003) + '😀tail'; writeFileSync(localPath, localLarge)
  const localPage = await access.read(owner(), scopeA, { requestId: randomUUID(), sourceHandle: localSource.sourceHandle, offset: 100_000 })
  assert.equal(localPage.source.text, localLarge.slice(100_000)); assert.equal(localPage.range.total, localLarge.length); assert.equal(localPage.nextOffset, null); assert.equal(localPage.range.totalIsComplete, true)
  const localLegacy = await access.read(owner(), scopeA, { requestId: randomUUID(), sourceHandle: localSource.sourceHandle })
  assert.equal(localLegacy.source.text.length, 100_000); assert.equal(localLegacy.source.truncated, true); assert.equal(localLegacy.source.range, undefined)
  writeFileSync(localPath, originalLocal)
  liveText = 'Paged cancellation fixture'
  const beforeReadCancel = service.readKnowledgeState(rootA).sources.length
  const alreadyAborted = new AbortController(); alreadyAborted.abort(); const beforeAbortedCalls = calls.length
  assert.equal((await access.read(owner(), scopeA, { requestId: randomUUID(), sourceHandle: remote.sourceHandle, offset: 0 }, alreadyAborted.signal)).status, 'cancelled')
  assert.equal(calls.length, beforeAbortedCalls)
  mode = 'read-wait'; const readAbort = new AbortController()
  const pendingPage = access.read(owner(), scopeA, { requestId: randomUUID(), sourceHandle: remote.sourceHandle, offset: 0 }, readAbort.signal)
  while (!releaseRead) await new Promise((resolve) => setTimeout(resolve, 5))
  readAbort.abort(); releaseRead(); releaseRead = undefined
  assert.equal((await pendingPage).status, 'cancelled'); assert.equal(service.readKnowledgeState(rootA).sources.length, beforeReadCancel)
  let pageCurrent = true
  const stalePage = access.read({ ...owner(), isCurrent: () => pageCurrent }, scopeA, { requestId: randomUUID(), sourceHandle: remote.sourceHandle, offset: 0 })
  while (!releaseRead) await new Promise((resolve) => setTimeout(resolve, 5))
  pageCurrent = false; releaseRead(); releaseRead = undefined
  await assert.rejects(stalePage, /变化/); assert.equal(service.readKnowledgeState(rootA).sources.length, beforeReadCancel)
  mode = 'ok'; liveText = 'Changed remote source'
  await assert.rejects(access.read({ ...owner(), sessionId: 'foreign' }, { ...scopeA, sessionId: 'foreign' }, { requestId: randomUUID(), sourceHandle: remote.sourceHandle }), /句柄/)
  mode = 'unsupported'; const unsupported = await access.read(owner(), scopeA, { requestId: randomUUID(), sourceHandle: remote.sourceHandle }); assert.equal(unsupported.source.mode, 'unsupported'); assert.equal(unsupported.status, 'unavailable')
  mode = 'moved'; await assert.rejects(access.read(owner(), scopeA, { requestId: randomUUID(), sourceHandle: remote.sourceHandle }), /范围/)
  mode = 'wrong-document'; const wrongDocument = await access.read(owner(), scopeA, { requestId: randomUUID(), sourceHandle: remote.sourceHandle }); assert.equal(wrongDocument.status, 'unavailable'); assert.equal(wrongDocument.source, null)
  mode = 'wrong-list-collection'; await assert.rejects(access.documents({ ...input(), collectionId: 'collection-a' }), /范围/)
  mode = 'malformed'; result = await access.search(owner(), scopeA, { requestId: randomUUID(), query: 'no-local-hit' }); assert.equal(result.status, 'unavailable')
  mode = 'empty'; result = await access.search(owner(), scopeA, { requestId: randomUUID(), query: 'no-local-hit' }); assert.equal(result.status, 'empty')
  mode = 'denied'; result = await access.search(owner(), scopeA, { requestId: randomUUID(), query: 'no-local-hit' }); assert.equal(result.status, 'denied')
  mode = 'oversized'; result = await access.search(owner(), scopeA, { requestId: randomUUID(), query: 'no-local-hit' }); assert.equal(result.status, 'unavailable')
  mode = 'ok'; await access.updateScope({ ...input(), collectionIds: [] }); const beforeEmpty = calls.length; result = await access.search(owner(), access.capture(owner()), { requestId: randomUUID(), query: 'no-local-hit' }); assert.equal(result.status, 'not_configured'); assert.equal(calls.length, beforeEmpty)
  assert.equal(scopeA.collectionIds[0], 'collection-a'); await access.updateScope({ ...input(), collectionIds: null })
  mode = 'wait'; const abort = new AbortController(); const pendingRead = access.search(owner(), scopeA, { requestId: randomUUID(), query: 'no-local-hit' }, abort.signal); abort.abort(); assert.equal((await pendingRead).status, 'cancelled'); mode = 'ok'
  changeProject(rootB); bind(rootB, ['collection-b']); const bOwner = { root: rootB, projectGeneration: globalThis.__KNOWLEDGE_GENERATION__, sessionId: 'session-b', turnId: 'turn-b' }; const b = await access.search(bOwner, access.capture(bOwner), { requestId: randomUUID(), query: 'no-local-hit' }); assert.equal(b.sources[0].collectionId, 'collection-b')
  await assert.rejects(access.source({ ...input(), sourceId: remote.id }), /切换/)
  changeProject(rootA); await assert.rejects(access.search(owner(), scopeA, { requestId: randomUUID(), query: 'fixture' }), /变化/)
  await assert.rejects(access.read(owner(), scopeA, { requestId: randomUUID(), sourceHandle: remote.sourceHandle, offset: 0, limit: 6000 }), /变化/, 'A stale-generation page cannot reuse an old handle')
  service.removeBinding({ expectedRoot: rootA, bindingId: bindingA.id, bindingRevision: bindingA.revision, connectionRevision: connection.revision }); const unboundCalls = calls.length; const unbound = await access.search(owner(), access.capture(owner()), { requestId: randomUUID(), query: 'no-local-hit' }); assert.equal(unbound.status, 'not_configured'); assert.equal(calls.length, unboundCalls)
  bind(rootA, ['collection-a', 'collection-b']); mode = 'partial'; const partial = await access.search(owner(), access.capture(owner()), { requestId: randomUUID(), query: 'no-local-hit' }); assert.equal(partial.status, 'partial'); mode = 'ok'
  const artifact = await access.saveArtifact({ ...input(), title: 'Confirmed product', body: '# Product\nExact confirmed body', kind: 'product-requirements', sourceIds: [remote.id], expectedRevision: null })
  assert.equal(readFileSync(join(rootA, artifact.relativePath), 'utf8'), artifact.body)
  writeFileSync(join(rootA, artifact.relativePath), 'External edit')
  await assert.rejects(access.saveArtifact({ ...input(), id: artifact.id, expectedRevision: artifact.revision, title: artifact.title, body: 'Replacement', kind: artifact.kind }), /修改/)
  await assert.rejects(access.previewPublication({ ...input(), artifactId: artifact.id, revision: artifact.revision, collectionId: 'collection-a', requestId: randomUUID() }), /修改/)
  writeFileSync(join(rootA, artifact.relativePath), artifact.body)
  const prd = await access.taskPrd({ ...input(), taskDir: 'developer' }); const handed = await access.handoff({ ...input(), artifactId: artifact.id, revision: artifact.revision, taskDir: 'developer', developerBody: '# Developer\nConfirmed implementation scope', expectedPrdRevision: prd.revision }); assert.equal(handed.productRevision, artifact.revision); assert(readFileSync(join(rootA, '.trellis/tasks/developer/prd.md'), 'utf8').includes(artifact.revision))
  await assert.rejects(access.handoff({ ...input(), artifactId: artifact.id, revision: artifact.revision, taskDir: 'developer', developerBody: 'Stale', expectedPrdRevision: prd.revision }), /修改/)
  const previewInput = (requestId = randomUUID()) => ({ ...input(), artifactId: artifact.id, revision: artifact.revision, collectionId: 'collection-a', requestId })
  await access.updateScope({ ...input(), collectionIds: ['collection-b'] })
  const overridePreview = await access.previewPublication({ ...previewInput(), collectionId: 'collection-b' })
  assert.equal(overridePreview.scope.overridden, true); assert.deepEqual(overridePreview.scope.collectionIds, ['collection-b']); assert.equal(overridePreview.scope.sessionId, 'session-a')
  await assert.rejects(access.previewPublication(previewInput()), /范围/)
  await assert.rejects(access.confirmPublication({ ...input(rootA, 'foreign-session'), requestId: overridePreview.requestId }), /会话/)
  await access.updateScope({ ...input(), collectionIds: null })
  await assert.rejects(access.confirmPublication({ ...input(), requestId: overridePreview.requestId }), /变化/)
  const stalePreview = await access.previewPublication(previewInput()); mode = 'publish-wait'
  const stalePublisher = access.confirmPublication({ ...input(), requestId: stalePreview.requestId })
  const staleJoiner = access.confirmPublication({ ...input(), requestId: stalePreview.requestId })
  assert.equal(service.readKnowledgeState(rootA).publications.find((item) => item.requestId === stalePreview.requestId).state, 'pending', 'Attempt must be durable before transport settles')
  changeProject(rootB); changeProject(rootA); releasePublish(); releasePublish = undefined
  const staleOutcomes = await Promise.allSettled([stalePublisher, staleJoiner])
  assert(staleOutcomes.every((item) => item.status === 'rejected' && /变化/.test(item.reason.message)), 'All duplicate-confirm waiters reject cross-generation late results')
  assert.equal(service.readKnowledgeState(rootA).publications.find((item) => item.requestId === stalePreview.requestId).state, 'published', 'Captured original-project attempt still records its remote outcome')
  mode = 'ok'
  const preview = await access.previewPublication(previewInput()); const beforePosts = posts
  const [first, duplicate] = await Promise.all([access.confirmPublication({ ...input(), requestId: preview.requestId }), access.confirmPublication({ ...input(), requestId: preview.requestId })])
  assert.equal(first.state, 'published'); assert.equal(duplicate.remoteDocumentId, first.remoteDocumentId); assert.equal(posts, beforePosts + 1); assert.equal(first.indexing, 'unknown')
  assert.deepEqual(JSON.parse(calls.filter((call) => call.path.endsWith('/knowledge/manual')).at(-1).options.body), { title: preview.title, content: preview.body, status: 'published', channel: 'trellis-panel' }, 'Transport sends exactly previewed bytes and disclosed fixed fields')
  assert.equal((await access.previewPublication(previewInput(preview.requestId))).state, 'published'); await access.confirmPublication({ ...input(), requestId: preview.requestId }); assert.equal(posts, beforePosts + 1)
  mode = 'missing-id'; const uncertainPreview = await access.previewPublication(previewInput()); const uncertain = await access.confirmPublication({ ...input(), requestId: uncertainPreview.requestId }); assert.equal(uncertain.state, 'uncertain')
  const restarted = new service.KnowledgeAccessService(); await restarted.confirmPublication({ ...input(), requestId: uncertain.requestId }); assert.equal(posts, beforePosts + 2)
  await assert.rejects(access.previewPublication(previewInput()), /核实/)
  await access.resolvePublication({ ...input(), requestId: uncertain.requestId, outcome: 'verified_absent', acknowledgeDuplicateRisk: true }); mode = 'ok'
  const crashed = await access.previewPublication(previewInput()); service.updateKnowledgeState(rootA, (s) => { s.publications.find((p) => p.requestId === crashed.requestId).state = 'pending' }); const afterCrash = await restarted.confirmPublication({ ...input(), requestId: crashed.requestId }); assert.equal(afterCrash.state, 'uncertain'); assert.equal(posts, beforePosts + 2)
  await access.resolvePublication({ ...input(), requestId: crashed.requestId, outcome: 'verified_absent', acknowledgeDuplicateRisk: true })
  mode = 'lost'; const lostPreview = await access.previewPublication(previewInput()); const lost = await access.confirmPublication({ ...input(), requestId: lostPreview.requestId }); assert.equal(lost.state, 'uncertain'); assert(!lost.detail.includes('fixture-secret')); assert.equal(posts, beforePosts + 3)
  await access.resolvePublication({ ...input(), requestId: lost.requestId, outcome: 'verified_absent', acknowledgeDuplicateRisk: true })
  mode = 'reject'; const rejectedPreview = await access.previewPublication(previewInput()); const rejected = await access.confirmPublication({ ...input(), requestId: rejectedPreview.requestId }); assert.equal(rejected.state, 'failed'); assert.equal(posts, beforePosts + 4)
  await access.confirmPublication({ ...input(), requestId: rejected.requestId }); assert.equal(posts, beforePosts + 4); mode = 'ok'
  const changedPreview = await access.previewPublication(previewInput()); const updatedConnection = service.saveConnection({ ...connectionInput, id: connection.id, revision: connection.revision, secrets: { apiKey: { op: 'keep' } } }); await assert.rejects(access.confirmPublication({ ...input(), requestId: changedPreview.requestId }), /变化/); assert.equal(posts, beforePosts + 4)
  const olderUncertain = randomUUID()
  service.updateKnowledgeState(rootA, (state) => {
    const template = state.publications[0]
    state.publications.unshift(...Array.from({ length: 61 }, (_, index) => ({ ...template, requestId: index === 60 ? olderUncertain : randomUUID(), state: index === 60 ? 'uncertain' : 'published', detail: 'pagination fixture' })))
  })
  assert(!(await access.publications(input())).some((item) => item.requestId === olderUncertain), 'Regression fixture lies beyond the legacy fifty-receipt view')
  const pagedIds = new Set(); let publicationCursor
  do {
    const page = await access.publicationPage({ ...input(), cursor: publicationCursor, limit: 7 })
    assert(page.items.length <= 7); assert(Buffer.byteLength(JSON.stringify(page)) < 2 * 1024 * 1024)
    assert.notEqual(page.nextCursor, publicationCursor)
    for (const item of page.items) { assert(!pagedIds.has(item.requestId)); pagedIds.add(item.requestId) }
    publicationCursor = page.nextCursor ?? undefined
  } while (publicationCursor)
  assert(pagedIds.has(olderUncertain)); assert.equal(pagedIds.size, service.readKnowledgeState(rootA).publications.length)
  await assert.rejects(access.publicationPage({ ...input(), cursor: randomUUID() }), /游标/)
  changeProject(rootB); await assert.rejects(access.publicationPage({ ...input(rootB), cursor: olderUncertain }), /游标/); changeProject(rootA)
  await access.resolvePublication({ ...input(), requestId: olderUncertain, outcome: 'verified_absent', acknowledgeDuplicateRisk: true })
  assert.equal(service.readKnowledgeState(rootA).publications.find((item) => item.requestId === olderUncertain).state, 'failed'); assert.equal(posts, beforePosts + 4)
  const beforeClear = service.readKnowledgeState(rootA).sources.length; const cleared = await access.clearHistory(input()); assert(cleared.removed > 0); assert(cleared.retained < beforeClear); assert.equal((await access.source({ ...input(), sourceId: remote.id })).text, 'Exact remote source text'); assert(service.readKnowledgeState(rootA).publications.length >= 4)
  const settingsBefore = { ...service.getSettings().weknora, enabled: true, baseUrl: 'https://fixture.invalid', apiKey: 'fixture-secret', apiKeyEncrypted: false, searchKbIds: ['collection-a'], syncSpec: true, autoPushArchive: true }
  service.setSettings({ weknora: settingsBefore }, true); const imported = await access.importLegacy({ ...input(), bindProject: false }); await access.importLegacy({ ...input(), bindProject: false }); assert.equal(service.readIntegrationState().connections.filter((c) => c.name === 'WeKnora (imported)').length, 1); assert.deepEqual(service.getSettings().weknora, settingsBefore); assert(imported.scope.connectionId !== service.readIntegrationState().legacyImports['settings.weknora'])
  const privateState = join(temporary, 'knowledge', service.knowledgeHash(process.platform === 'win32' ? resolve(rootA).toLowerCase() : resolve(rootA)), 'state.json'); assert(existsSync(privateState)); assert(!readFileSync(privateState, 'utf8').includes('fixture-secret')); assert.equal(existsSync(join(rootA, '.trellis/.panel/runtime/knowledge')), false)
  const savedPrivate = readFileSync(privateState, 'utf8'); writeFileSync(privateState, '{broken'); result = await access.search(owner(), access.capture(owner()), { requestId: randomUUID(), query: 'no-local-hit' }); assert.equal(result.persistence, 'degraded'); assert.equal(readFileSync(privateState, 'utf8'), '{broken'); writeFileSync(privateState, savedPrivate)
  const rootC = join(temporary, 'project-c'); const outside = join(temporary, 'outside-project'); mkdirSync(join(rootC, '.trellis'), { recursive: true }); mkdirSync(outside); symlinkSync(outside, join(rootC, '.trellis', 'notes'), process.platform === 'win32' ? 'junction' : 'dir'); changeProject(rootC)
  await assert.rejects(access.saveArtifact({ ...input(rootC), title: 'No escape', kind: 'product-requirements', body: 'Must not escape', expectedRevision: null }), /越界/); assert.equal(existsSync(join(outside, 'state.json')), false)
  console.log('knowledge-core: PASS (migration, protected import, per-project scope, overrides, handles, immutable sources, native large-document paging with exact persisted ranges/nextOffset, surrogate and invalid-window guards, no-window compatibility, paged cancellation/stale/partial upstream, CAS, explicit handoff, exact publication, duplicate/restart/uncertain ledger, retained evidence)')
} finally {
  delete globalThis.__KNOWLEDGE_FETCH__; delete globalThis.__KNOWLEDGE_ROOT__; delete globalThis.__KNOWLEDGE_GENERATION__; delete globalThis.__KNOWLEDGE_ENCRYPTION__
  const absolute = resolve(temporary)
  if (!absolute.startsWith(resolve(tmpdir()))) throw new Error('unsafe fixture cleanup target')
  rmSync(absolute, { recursive: true, force: true })
}

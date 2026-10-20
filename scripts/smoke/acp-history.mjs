import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { prepareAcpHistoryWorker } from './prepare-acp-history-worker.mjs'

const temporary = mkdtempSync(join(tmpdir(), 'trellis-acp-history-'))
const hash = (value) => createHash('sha256').update(value).digest('hex')
const digestJson = (value, localeOrder = false) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => digestJson(item, localeOrder)).join(',')}]`
  return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => localeOrder ? a.localeCompare(b) : a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${digestJson(item, localeOrder)}`).join(',')}}`
}
const root = join(temporary, 'project')
mkdirSync(root)
process.env.TPAP_SMOKE_DIR = temporary
const workerFile = await prepareAcpHistoryWorker(temporary)
const canonical = (path) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const projectKey = canonical(root)
let acp
let core
const wait = async (predicate, label) => {
  const until = Date.now() + 15000
  while (Date.now() < until) { const value = await predicate(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 15)) }
  throw new Error(`Deadline: ${label}`)
}
const record = (id, events = []) => ({ schemaVersion: 2, sessionId: id, projectRoot: root, agentId: 'history', agentName: 'Archive fixture', title: id, startedAt: 100, status: 'closed', events })
const event = (id, text = id, ts = 100) => ({ id, ts, projectRoot: root, sessionId: 'fixture', source: 'acp', kind: 'message', text, payload: { role: 'assistant' } })
const pageBytes = 2 * 1024 * 1024
const turn = (sessionId, name, count, options = {}) => {
  const identity = options.legacy ? {} : { connectionGeneration: options.generation ?? 'generation-1', turnId: options.turnId ?? name }
  const item = (suffix, kind, text, payload) => ({ ...event(`${sessionId}-${name}-${suffix}`, text), sessionId, ...identity, kind, payload })
  return [
    ...(options.preprompt ? [item('started', 'session-status', 'processing', { activityScope: 'turn' }), item('diagnostic', 'diagnostic', 'preparing prompt', { activityScope: 'turn' })] : []),
    item('user', 'message', `Question ${name}`, { role: 'user', ...(options.images ? { images: options.images } : {}) }),
    item('thought', 'thought', 'private reasoning', {}),
    ...Array.from({ length: count }, (_, index) => item(`fragment-${index}`, 'message', options.text?.(index) ?? `fragment-${index}|`, { role: 'assistant', messageId: `${name}-answer` })),
    item('tool', 'tool-call', 'Fixture tool', { toolCallId: `${name}-tool`, status: 'completed' }),
    item('permission', 'permission', 'Historical approval', { requestId: `${name}-permission`, pending: true }),
    ...(options.open ? [] : [item('done', 'turn-done', '回合已结束', { result: { status: 'completed', stopReason: 'end_turn' } })])
  ]
}
const historical = ({ historySeq, ...item }) => item.kind === 'permission' ? { ...item, payload: { ...item.payload, pending: false } } : item
// Expected groups come from fixture construction, independently of the pager's boundary detection.
const verifyTurnPaging = async (read, fixture, limit, sequence = true) => {
  const expected = fixture.groups.flat()
  const byId = new Map(expected.map((item, index) => [item.id, index]))
  const check = (page) => {
    assert.equal(page?.ok, true, `${fixture.id}: ${page?.error ?? 'page unavailable'}`)
    assert.ok(page.events.length, `${fixture.id}: a page must make progress`)
    const ids = new Set(page.events.map((item) => item.id))
    assert.equal(ids.size, page.events.length, `${fixture.id}: duplicate within page`)
    for (const group of fixture.groups) {
      const included = group.filter((item) => ids.has(item.id)).length
      if (included) assert.equal(included, group.length, `${fixture.id}: page split group beginning ${group[0].id}`)
    }
    const first = byId.get(page.events[0].id)
    const last = byId.get(page.events.at(-1).id)
    assert.notEqual(first, undefined, `${fixture.id}: unexpected event`)
    assert.deepEqual(page.events.map(historical), expected.slice(first, last + 1).map(historical), `${fixture.id}: exact chronological page bytes`)
    assert.ok(page.events.every((item) => item.kind !== 'permission' || item.payload.pending === false), `${fixture.id}: archive approvals are nonactionable`)
    assert.equal(page.hasEarlier, first > 0)
    assert.equal(page.hasLater, last < expected.length - 1)
    assert.equal(!!page.beforeCursor, page.hasEarlier)
    assert.equal(!!page.afterCursor, page.hasLater)
    assert.equal(page.startsMidTurn, fixture.missingPrefix === page.events[0].id, `${fixture.id}: honest missing-prefix marker`)
    const bytes = expected.slice(first, last + 1).reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item)), 0)
    assert.equal(page.oversized, page.events.length > (limit ?? 200) || bytes > pageBytes, `${fixture.id}: count and bytes are soft targets`)
    if (limit === 1) assert.ok(fixture.groups.filter((group) => ids.has(group[0].id) && group.some((item) => item.kind === 'message')).length <= 1, `${fixture.id}: distinct turns remain separately pageable`)
  }
  let page = await read(limit === undefined ? {} : { limit })
  check(page)
  const backward = [...page.events]
  let reads = 1
  while (page.beforeCursor) {
    assert.ok(reads++ <= expected.length, `${fixture.id}: backward cursor did not advance`)
    page = await read({ limit, before: page.beforeCursor })
    check(page)
    backward.unshift(...page.events)
  }
  const forward = [...page.events]
  reads = 1
  while (page.afterCursor) {
    assert.ok(reads++ <= expected.length, `${fixture.id}: forward cursor did not advance`)
    page = await read({ limit, after: page.afterCursor })
    check(page)
    forward.push(...page.events)
  }
  for (const [direction, observed] of [['backward', backward], ['forward', forward]]) {
    assert.equal(observed.length, expected.length, `${fixture.id}: ${direction} event count`)
    assert.equal(new Set(observed.map((item) => item.id)).size, expected.length, `${fixture.id}: ${direction} has no duplicates`)
    assert.deepEqual(observed.map(historical), expected.map(historical), `${fixture.id}: ${direction} loses no bytes`)
    if (sequence) assert.ok(observed.every((item, index) => Number.isSafeInteger(item.historySeq) && (!index || item.historySeq > observed[index - 1].historySeq)), `${fixture.id}: immutable sequence orders tied timestamps`)
  }
  if (sequence) assert.deepEqual(forward.map((item) => item.historySeq), backward.map((item) => item.historySeq))
}
const markdownFragment = (index) => index === 0 ? '# Complete answer\n\n```js\n' : index === 236 ? '```\n\n**All fragments preserved.**\n' : `const fragment${index} = "原样-${index}";\n`
const pagingFixtures = [
  { id: 'paging-stream', groups: [turn('paging-stream', 'older', 2), turn('paging-stream', 'middle', 219), turn('paging-stream', 'latest', 237, { text: markdownFragment })] },
  { id: 'paging-text-bytes', groups: [turn('paging-text-bytes', 'older', 1), turn('paging-text-bytes', 'large', 8, { text: (index) => `${index}:` + '界'.repeat(100000) }), turn('paging-text-bytes', 'latest', 1)] },
  { id: 'paging-image', groups: [turn('paging-image', 'older', 1), turn('paging-image', 'large', 3, { images: [{ id: 'paging-image', name: 'large.png', mimeType: 'image/png', data: Buffer.alloc(2 * 1024 * 1024, 1).toString('base64') }] }), turn('paging-image', 'latest', 1)] },
  { id: 'paging-legacy', groups: [turn('paging-legacy', 'older', 2, { legacy: true, open: true }), turn('paging-legacy', 'long', 223, { legacy: true }), turn('paging-legacy', 'latest', 2, { legacy: true })] },
  { id: 'paging-startup', groups: [[{ ...event('startup-diagnostic', 'connection diagnostic'), sessionId: 'paging-startup', kind: 'diagnostic', connectionGeneration: 'generation-1', payload: { activityScope: 'connection' } }], turn('paging-startup', 'first', 3, { preprompt: true }), turn('paging-startup', 'second', 3, { preprompt: true })] },
  { id: 'paging-generations', groups: [turn('paging-generations', 'interrupted', 4, { turnId: 'reused-turn', generation: 'generation-1', open: true }), turn('paging-generations', 'reconnected', 4, { turnId: 'reused-turn', generation: 'generation-2' })] },
  { id: 'paging-trailing-metadata', groups: [turn('paging-trailing-metadata', 'older', 2), turn('paging-trailing-metadata', 'latest', 3), [{ ...event('trailing-ready', 'connection ready'), sessionId: 'paging-trailing-metadata', kind: 'session-status', connectionGeneration: 'generation-1', payload: { activityScope: 'connection' } }]] },
  { id: 'paging-open', groups: [turn('paging-open', 'closed', 3), turn('paging-open', 'open', 231, { open: true })] },
  { id: 'paging-missing-prefix', groups: [turn('paging-missing-prefix', 'suffix', 5).slice(2), turn('paging-missing-prefix', 'complete', 3)] }
]
pagingFixtures.at(-1).missingPrefix = pagingFixtures.at(-1).groups[0][0].id
const startupTurn = pagingFixtures.find((fixture) => fixture.id === 'paging-startup').groups[1]
startupTurn.splice(2, 0, { ...event('restore-before-user', 'native restore verified'), sessionId: 'paging-startup', kind: 'session-status', connectionGeneration: 'generation-1', payload: { activityScope: 'connection' } })
const { sessionId: _railSession, ...projectRail } = event('rail-between-fragments', 'spec changed')
startupTurn.splice(6, 0, { ...projectRail, source: 'trellis', kind: 'spec-updated', payload: {} })
try {
  await build({ entryPoints: ['src/main/services/acp/history-core.ts'], bundle: true, format: 'esm', platform: 'node', outfile: join(temporary, 'core.mjs'), logLevel: 'silent' })
  const { AcpHistoryCore, HistoryCursorError } = await import(pathToFileURL(join(temporary, 'core.mjs')).href)
  const coreDir = join(temporary, 'core')
  core = new AcpHistoryCore(coreDir)
  const fragments = Array.from({ length: 2103 }, (_, index) => event(`fragment-${index}`, `${index}:原样\nbytes`))
  core.append([{ root: projectKey, record: record('fixture'), events: fragments }])
  core.close(); core = new AcpHistoryCore(coreDir)
  let page = core.events(projectKey, 'fixture', { limit: 173 })
  let all = [...page.events]
  while (page.beforeCursor) { page = core.events(projectKey, 'fixture', { before: page.beforeCursor, limit: 173 }); all = [...page.events, ...all] }
  assert.deepEqual(all.map(({ historySeq, ...item }) => item), fragments)
  assert.equal(page.coverage.state, 'complete')
  assert.equal(core.events(projectKey, 'fixture').startsMidTurn, true)
  assert.throws(() => core.append([{ root: projectKey, record: record('fixture'), events: [event('never-committed'), event('fragment-0', 'mutated')] }]), /identity conflict/)
  assert.equal(core.session(projectKey, 'fixture').eventCount, fragments.length, 'conflict rolls the transaction back')
  console.log('PASS >800 fragmented events, reopen, exact complete content and atomic identity conflict')

  for (const fixture of pagingFixtures) core.append([{ root: projectKey, record: record(fixture.id), events: fixture.groups.flat(),
    ...(fixture.missingPrefix ? { coverage: { state: 'partial', capturedFrom: 100, reason: 'Fixture retains only the original turn suffix' } } : {}) }])
  for (const fixture of pagingFixtures) {
    for (const limit of [undefined, 1, 7]) await verifyTurnPaging((input) => core.events(projectKey, fixture.id, input), fixture, limit)
    console.log(`PASS complete-turn archive paging ${fixture.id}: latest/before/after, soft count/bytes, exact sequence and readonly permissions`)
  }
  await build({ entryPoints: ['src/renderer/src/acp/timeline.ts'], bundle: true, format: 'esm', platform: 'node', outfile: join(temporary, 'timeline.mjs'), logLevel: 'silent' })
  const { compileItems } = await import(pathToFileURL(join(temporary, 'timeline.mjs')).href)
  const streamFixture = pagingFixtures[0]
  const latestTurn = streamFixture.groups.at(-1)
  const latestPage = core.events(projectKey, streamFixture.id)
  const answer = compileItems(latestPage.events).filter((item) => item.type === 'agent')
  assert.equal(answer.length, 1, 'initial history page projects one complete assistant answer')
  assert.equal(answer[0].key, latestTurn.find((item) => item.payload?.role === 'assistant').id, 'rendered answer starts at fragment 0')
  assert.deepEqual(Buffer.from(answer[0].text), Buffer.from(latestTurn.filter((item) => item.payload?.role === 'assistant').map((item) => item.text).join('')), 'Markdown reaches the renderer with every original byte')
  assert.ok(answer[0].text.startsWith(markdownFragment(0)))
  console.log('PASS initial >200-fragment history page renders full Markdown from fragment 0 through compileItems')

  const expected = Array.from({ length: 57 }, (_, index) => `catalogue-${String(index).padStart(2, '0')}`)
  core.append(expected.map((id) => ({ root: projectKey, record: { ...record(id), title: id === expected[0] ? 'Unloaded older searchable title' : id }, events: [] })))
  let list = core.list(projectKey, { limit: 7 })
  const listed = list.sessions.map((item) => item.sessionId)
  core.append([{ root: projectKey, record: record('concurrent-added'), events: [event('new-activity', 'activity', 500)] }, { root: projectKey, record: record(expected[0]), events: [event('changed-activity', 'activity', 600)] }])
  const firstCursor = list.nextCursor
  assert.throws(() => core.list('foreign', { cursor: firstCursor, limit: 7 }), HistoryCursorError)
  assert.throws(() => core.list(projectKey, { cursor: firstCursor, query: 'different' }), HistoryCursorError)
  assert.throws(() => core.list(projectKey, { cursor: 'malformed' }), HistoryCursorError)
  while (list.nextCursor) { list = core.list(projectKey, { cursor: list.nextCursor, limit: 7 }); listed.push(...list.sessions.map((item) => item.sessionId)) }
  assert.equal(new Set(listed).size, listed.length)
  assert.deepEqual(new Set(listed), new Set([...expected, 'fixture', ...pagingFixtures.map((fixture) => fixture.id)]))
  core.append([{ root: projectKey, record: { ...record(expected[0]), title: 'Unloaded older searchable title' }, events: [] }])
  assert.equal(core.list(projectKey, { query: 'older searchable' }).sessions[0].sessionId, expected[0])
  assert.equal(core.session(projectKey, expected[0]).sessionId, expected[0])
  const clock = Date.now
  const future = clock() + 300_001
  try { Date.now = () => future; assert.throws(() => core.list(projectKey, { cursor: firstCursor, limit: 7 }), HistoryCursorError) }
  finally { Date.now = clock }
  const newest = core.events(projectKey, streamFixture.id, { limit: 1 })
  assert.ok(newest.beforeCursor)
  assert.throws(() => core.events(projectKey, expected[0], { before: newest.beforeCursor }), HistoryCursorError)
  assert.equal(core.events('foreign', streamFixture.id, { before: newest.beforeCursor }), null, 'cursor cannot expose another project')
  const foreignRoot = canonical(join(temporary, 'other-project'))
  core.append([{ root: foreignRoot, record: { ...record(streamFixture.id), projectRoot: foreignRoot }, events: [] }])
  assert.throws(() => core.events(foreignRoot, streamFixture.id, { before: newest.beforeCursor }), HistoryCursorError, 'cursor remains root scoped when both projects have the same session ID')
  const otherArchive = new AcpHistoryCore(join(temporary, 'other-archive'))
  try {
    otherArchive.append([{ root: projectKey, record: record(streamFixture.id), events: [] }])
    assert.throws(() => otherArchive.events(projectKey, streamFixture.id, { before: newest.beforeCursor }), HistoryCursorError, 'cursor cannot cross archive epochs')
  } finally { otherArchive.close() }
  assert.throws(() => core.events(projectKey, streamFixture.id, { before: 'malformed' }), HistoryCursorError)
  assert.throws(() => core.events(projectKey, streamFixture.id, { before: newest.beforeCursor, after: newest.beforeCursor }), HistoryCursorError)
  console.log('PASS full metadata search/direct ID, equal-key catalogue, frozen pagination under mutation, scoped cursors')

  const appendFixture = { id: 'paging-appended-tail', groups: [turn('paging-appended-tail', 'older', 2), turn('paging-appended-tail', 'running', 5, { open: true })] }
  core.append([{ root: projectKey, record: record(appendFixture.id), events: appendFixture.groups.flat() }])
  const openPage = core.events(projectKey, appendFixture.id, { limit: 1 })
  // Simulate a previously saved event cursor at the then-current open tail.
  const openTailCursor = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(openPage.beforeCursor, 'base64url').toString('utf8')), seq: openPage.events.at(-1).historySeq })).toString('base64url')
  assert.deepEqual(core.events(projectKey, appendFixture.id, { after: openTailCursor }).events, [], 'open-tail cursor is a valid boundary before append')
  const continuation = [
    { ...event('appended-answer', 'newly captured continuation'), sessionId: appendFixture.id, connectionGeneration: 'generation-1', turnId: 'running', payload: { role: 'assistant', messageId: 'running-answer' } },
    { ...event('appended-done', '回合已结束'), sessionId: appendFixture.id, connectionGeneration: 'generation-1', turnId: 'running', kind: 'turn-done', payload: { result: { status: 'completed' } } }
  ]
  core.append([{ root: projectKey, record: record(appendFixture.id), events: continuation }])
  appendFixture.groups[1].push(...continuation)
  assert.throws(() => core.events(projectKey, appendFixture.id, { after: openTailCursor }), HistoryCursorError, 'append inside the same turn requires refresh instead of silently skipping or cutting it')
  await verifyTurnPaging((input) => core.events(projectKey, appendFixture.id, input), appendFixture, 1)
  assert.deepEqual(core.events(projectKey, appendFixture.id, { limit: 1 }).events.map((item) => item.id), appendFixture.groups[1].map((item) => item.id), 'refresh includes the original prompt and the complete appended tail')
  console.log('PASS append-to-open-tail invalidates the old event edge with a typed conflict; refresh and both paging directions retain all bytes')

  const previewEvent = (id, text, extra = {}) => ({ ...event(id, text), sessionId: 'preview', connectionGeneration: 'preview-generation', turnId: 'preview-turn', payload: { role: 'assistant', messageId: 'preview-message' }, ...extra })
  const previewFragments = Array.from({ length: 370 }, (_, index) => previewEvent(`preview-${index}`, `${index} `))
  core.append([{ root: projectKey, record: record('preview'), events: previewFragments.slice(0, 200) }])
  core.append([{ root: projectKey, record: record('preview'), events: [...previewFragments.slice(200), previewEvent('preview-thought', 'SECRET THOUGHT', { kind: 'thought' })] }])
  const preview = core.session(projectKey, 'preview')
  assert.equal(preview.conversationPreview, previewFragments.map((item) => item.text).join('').trim().slice(0, 180))
  assert.ok(!('events' in preview), 'catalogue summaries do not carry transcript or attachment bodies')
  core.append([{ root: projectKey, record: record('preview'), events: [previewEvent('preview-next', 'Actual next message', { payload: { role: 'assistant', messageId: 'second-message' } })] }])
  assert.equal(core.session(projectKey, 'preview').conversationPreview, 'Actual next message', 'producer message identity starts a new coherent preview')
  assert.equal(core.session(projectKey, 'preview').hasConversation, true)
  core.append([{ root: projectKey, record: record('metadata-only'), events: [{ ...event('metadata-only', 'startup failed'), sessionId: 'metadata-only', kind: 'diagnostic' }, { ...event('whitespace-only', '\t\n\r '), sessionId: 'metadata-only' }] }])
  assert.equal(core.session(projectKey, 'metadata-only').eventCount, 2)
  assert.equal(core.session(projectKey, 'metadata-only').hasConversation, false, 'a diagnostic event count cannot manufacture a conversation')
  console.log('PASS persisted coherent catalogue preview across batches and more than 200 fragments, no thought/body hydration')

  const digestDir = join(temporary, 'digest-compat')
  const digestSources = join(temporary, 'digest-sources'); mkdirSync(digestSources)
  const digestEvent = (sessionId) => ({ ...event(`${sessionId}-done`), sessionId, kind: 'turn-done',
    payload: { result: { stopReason: 'end_turn', _meta: { A: 'upper', a: 'lower', 'a-key': [{ Z: 1, z: 2 }], _marker: 'punctuation' } } } })
  const digestRecords = ['locale-same', 'locale-changed', 'digest-corrupt', 'payload-corrupt', 'canonical', 'already-imported']
    .map((id) => record(id, [digestEvent(id)]))
  const alreadyImported = join(digestSources, 'already-imported.json')
  const alreadyImportedBytes = JSON.stringify(digestRecords.at(-1))
  writeFileSync(alreadyImported, alreadyImportedBytes)
  let digestCore = new AcpHistoryCore(digestDir)
  const originalRows = new Map()
  try {
    digestCore.append(digestRecords.map((item) => ({ root: projectKey, record: item, events: item.events })))
    digestCore.close(); digestCore = undefined
    const fixtureDb = new DatabaseSync(join(digestDir, 'history.sqlite'))
    try {
      assert.equal(fixtureDb.prepare("SELECT value FROM archive_meta WHERE key='version'").get().value, '1')
      for (const item of digestRecords) {
        const original = item.events[0]
        const ordinalDigest = hash(digestJson(original))
        const localeDigest = hash(digestJson(original, true))
        const row = fixtureDb.prepare('SELECT seq,digest,payload,bytes FROM events WHERE root=? AND sessionId=?').get(projectKey, item.sessionId)
        assert.equal(row.digest, ordinalDigest, 'new events retain ordinal key canonicalization')
        assert.notEqual(localeDigest, ordinalDigest, 'fixture exercises case/punctuation and nested locale-sort differences')
        if (item.sessionId !== 'canonical') {
          fixtureDb.prepare('UPDATE events SET digest=? WHERE seq=?').run(item.sessionId === 'digest-corrupt' ? '0'.repeat(64) : localeDigest, row.seq)
        }
        if (item.sessionId === 'payload-corrupt') {
          fixtureDb.prepare('UPDATE events SET payload=? WHERE seq=?').run(JSON.stringify({ ...original, text: 'damaged stored payload' }), row.seq)
        }
        originalRows.set(item.sessionId, fixtureDb.prepare('SELECT seq,digest,payload,bytes FROM events WHERE seq=?').get(row.seq))
      }
      fixtureDb.prepare('INSERT INTO imports VALUES(?,?,?,?,?,?)').run(alreadyImported, hash(alreadyImportedBytes), projectKey, 'already-imported', 1, 100)
    } finally { fixtureDb.close() }

    digestCore = new AcpHistoryCore(digestDir)
    const same = digestEvent('locale-same')
    const reordered = { ...same, historySeq: 99999, payload: { result: { _meta: { _marker: 'punctuation', 'a-key': [{ z: 2, Z: 1 }], a: 'lower', A: 'upper' }, stopReason: 'end_turn' } } }
    const appended = digestCore.append([{ root: projectKey, record: record('locale-same'), events: [reordered] }])
    assert.equal(appended[0].seq, originalRows.get('locale-same').seq)
    assert.equal(digestCore.session(projectKey, 'locale-same').eventCount, 1, 'legacy duplicate retains its immutable sequence')
    for (const id of ['locale-changed', 'digest-corrupt', 'payload-corrupt']) {
      const incoming = digestEvent(id)
      if (id === 'locale-changed') incoming.payload.result._meta.A = 'actually changed'
      assert.throws(() => digestCore.append([{ root: projectKey, record: record(id), events: [incoming] }]), /identity conflict/,
        'legacy compatibility cannot accept changed content, unexplained digests or damaged stored payloads')
    }
    digestCore.append([{ root: projectKey, record: record('canonical'), events: [digestEvent('canonical')] }])
    const sameTail = { ...event('locale-safe-tail', 'new snapshot-only tail'), sessionId: 'locale-same' }
    writeFileSync(join(digestSources, 'same.json'), JSON.stringify(record('locale-same', [same, sameTail])))
    writeFileSync(join(digestSources, 'changed.json'), JSON.stringify(record('locale-changed', [{ ...digestEvent('locale-changed'), text: 'genuinely changed' }])))
    writeFileSync(join(digestSources, 'corrupt.json'), JSON.stringify(record('digest-corrupt', [digestEvent('digest-corrupt')])))
    digestCore.importDirectory(digestSources, canonical)
    digestCore.importDirectory(digestSources, canonical)
    const compatiblePage = digestCore.events(projectKey, 'locale-same')
    assert.deepEqual(compatiblePage.events.map((item) => item.id), [same.id, sameTail.id])
    assert.equal(compatiblePage.events[0].historySeq, originalRows.get('locale-same').seq)
    const conflicts = digestCore.list(projectKey).diagnostics.filter((item) => item.code === 'source_event_conflict')
    assert.deepEqual(conflicts.map((item) => item.source).sort(), ['changed.json', 'corrupt.json'])
    assert.equal(digestCore.events(projectKey, 'locale-changed').events[0].text, digestEvent('locale-changed').text)
    assert.equal(digestCore.session(projectKey, 'already-imported').eventCount, 1, 'existing import markers remain idempotent')
    digestCore.close(); digestCore = new AcpHistoryCore(digestDir)
    digestCore.importDirectory(digestSources, canonical)
    assert.equal(digestCore.list(projectKey).diagnostics.length, 0, 'restart recognizes committed source markers')
    assert.equal(digestCore.session(projectKey, 'locale-same').eventCount, 2)
    digestCore.close(); digestCore = undefined
    const unchangedDb = new DatabaseSync(join(digestDir, 'history.sqlite'), { readOnly: true })
    try {
      for (const [id, originalRow] of originalRows) {
        assert.deepEqual(unchangedDb.prepare('SELECT seq,digest,payload,bytes FROM events WHERE root=? AND sessionId=? ORDER BY seq LIMIT 1').get(projectKey, id), originalRow,
          'compatibility never rewrites original payload, sequence, bytes or digest')
      }
    } finally { unchangedDb.close() }
    console.log('PASS v1 locale-digest read compatibility for append/startup import, immutable originals, restart markers and genuine/corrupt conflict rejection')
  } finally { digestCore?.close() }

  const source = join(temporary, 'sources'); mkdirSync(source)
  const legacy = { ...record('legacy', [event('legacy-event')]), schemaVersion: 1, unknownSupported: { preserved: 'yes' } }
  const bytes = Buffer.from(JSON.stringify(legacy))
  writeFileSync(join(source, 'legacy.json'), bytes)
  writeFileSync(join(source, 'future.json'), JSON.stringify({ ...record('future'), schemaVersion: 90 }))
  writeFileSync(join(source, 'broken.json'), '{bad json')
  core.importDirectory(source, canonical); core.importDirectory(source, canonical)
  assert.equal(core.session(projectKey, 'legacy').eventCount, 1)
  assert.equal(core.session(projectKey, 'legacy').unknownSupported.preserved, 'yes')
  assert.equal(core.session(projectKey, 'legacy').historyCoverage.state, 'unknown')
  assert.deepEqual(readFileSync(join(source, 'legacy.json')), bytes)
  assert.deepEqual(readFileSync(join(coreDir, 'history-originals', `${hash(bytes)}.json`)), bytes)
  assert.equal(core.session(projectKey, 'future'), null)
  assert.ok(core.list(projectKey).diagnostics.some((item) => item.source === 'future.json'))
  assert.ok(core.list(projectKey).diagnostics.some((item) => item.source === 'broken.json'))
  console.log('PASS non-destructive/idempotent legacy import, unknown metadata, explicit future/damaged source diagnostics')

  const legacySnapshot = join(source, 'legacy.json')
  writeFileSync(legacySnapshot, JSON.stringify({ ...legacy, events: [{ ...legacy.events[0], text: 'conflicting projected text' }, { ...event('snapshot-only-tail', 'survived only in compatibility snapshot'), sessionId: 'legacy' }] }))
  core.importDirectory(source, canonical)
  core.importDirectory(source, canonical)
  const backfilled = core.events(projectKey, 'legacy')
  assert.deepEqual(backfilled.events.map((item) => item.id), ['legacy-event', 'snapshot-only-tail'])
  assert.equal(backfilled.events[0].text, legacy.events[0].text, 'snapshot conflicts preserve first original event')
  assert.ok(core.list(projectKey).diagnostics.some((item) => item.code === 'source_event_conflict'))
  assert.equal(core.session(projectKey, 'legacy').historyCoverage.state, 'unknown')
  console.log('PASS changed compatibility snapshot safely backfills missing tail once while retaining original conflicts and coverage')
  writeFileSync(legacySnapshot, JSON.stringify({ ...legacy, events: [{ ...event('unordered-prefix', 'original source retained'), sessionId: 'legacy' }, ...backfilled.events.map(({ historySeq, ...item }) => item)] }))
  core.importDirectory(source, canonical)
  assert.equal(core.session(projectKey, 'legacy').eventCount, 2, 'older snapshot-only prefix must not be appended after the canonical suffix')
  assert.equal(core.session(projectKey, 'legacy').historyCoverage.state, 'partial')
  assert.ok(core.list(projectKey).diagnostics.some((item) => item.code === 'source_event_order_unknown'))
  console.log('PASS uncertain snapshot prefix preserves source and marks partial coverage without reordering immutable sequence')

  const recoverySource = join(temporary, 'native-source.jsonl'); writeFileSync(recoverySource, 'verified-source-fixture')
  const suffix = record('recovery', [{ ...event('suffix', 'retained', 500), sessionId: 'recovery' }])
  const prefix = [{ ...event('native-prefix', 'proven earlier', 200), sessionId: 'recovery', turnId: undefined, payload: { role: 'user', recoverySource: { nativeId: 'native-prefix' } } }]
  core.importRecovery(projectKey, suffix, { sourcePath: recoverySource, sourceDigest: hash(readFileSync(recoverySource)), events: prefix })
  core.importRecovery(projectKey, suffix, { sourcePath: recoverySource, sourceDigest: hash(readFileSync(recoverySource)), events: prefix })
  assert.deepEqual(core.events(projectKey, 'recovery').events.map((item) => item.id), ['native-prefix', 'suffix'])
  assert.equal(core.events(projectKey, 'recovery').coverage.state, 'partial')
  console.log('PASS proven prefix before suffix, repeat recovery idempotency and partial coverage')

  core.close(); core = undefined
  const unsupported = join(temporary, 'future-db'); mkdirSync(unsupported)
  const database = new DatabaseSync(join(unsupported, 'history.sqlite')); database.exec("CREATE TABLE archive_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO archive_meta VALUES('version','900')"); database.close()
  const before = readFileSync(join(unsupported, 'history.sqlite'))
  assert.throws(() => new AcpHistoryCore(unsupported), /Unsupported/)
  assert.deepEqual(readFileSync(join(unsupported, 'history.sqlite')), before)
  const damaged = join(temporary, 'damaged-db'); mkdirSync(damaged); writeFileSync(join(damaged, 'history.sqlite'), 'damaged database')
  assert.throws(() => new AcpHistoryCore(damaged))
  assert.equal(readFileSync(join(damaged, 'history.sqlite'), 'utf8'), 'damaged database')
  console.log('PASS damaged/future archive is retained without recreation or downgrade writes')

  const request = createRequire(import.meta.url)
  await build({ stdin: { contents: `export * from './src/main/services/acp'; export * from './src/main/services/acp/history-service'; export { setSettings } from './src/main/services/store'; export { promptImagesSchema } from './src/main/services/acp/images';`, resolveDir: process.cwd(), loader: 'ts' },
    outfile: join(temporary, 'facade.mjs'), bundle: true, format: 'esm', platform: 'node', external: ['acpx', 'acpx/*'],
    banner: { js: `import {createRequire} from 'node:module'; const require=createRequire(${JSON.stringify(pathToFileURL(resolve('package.json')).href)});` },
    alias: { electron: resolve('scripts/smoke/mock-electron.mjs') }, plugins: [{ name: 'public-runtime', setup(builder) { builder.onResolve({ filter: /^acpx\// }, (args) => ({ path: pathToFileURL(request.resolve(args.path)).href, external: true })) } }], logLevel: 'silent' })
  acp = await import(pathToFileURL(join(temporary, 'facade.mjs')).href)
  acp.setSettings({ acp: { nodePath: process.execPath, agents: [{ id: 'history-peer', name: 'History fixture', command: 'owned peer', enabled: true, executable: process.execPath, args: [resolve('scripts/smoke/fixtures/acp-history-peer.mjs')] }] } })
  const created = await acp.newAcpSession(root, { agentId: 'history-peer' }); assert.equal(created.ok, true, created.error)
  const current = () => acp.listAcpSessions(root).sessions.find((session) => session.sessionId === created.sessionId)
  await wait(() => current()?.status === 'ready', 'ready')
  const png = Buffer.alloc(10 * 1024 * 1024); Buffer.from('89504e470d0a1a0a', 'hex').copy(png)
  const images = Array.from({ length: 2 }, (_, index) => ({ id: `max-image-${index}`, name: `${index}.png`, mimeType: 'image/png', data: png.toString('base64') }))
  assert.equal(acp.promptImagesSchema.safeParse(images).success, true, 'maximum admitted image representation')
  const sent = await acp.promptAcpSession(root, created.sessionId, '', { images }); assert.equal(sent.ok, true, sent.error)
  await wait(() => current()?.status === 'awaiting_permission', 'permission after >800 streamed fragments')
  const pending = current().pendingPermissions[0]
  assert.ok(pending)
  for (let index = 0; index < 900; index++) acp.emitTrellisTimeline(root, 'spec-updated', `rail-${index}`)
  assert.equal(current().events.length, 800)
  let stored = await acp.getAcpHistoryEvents(root, created.sessionId); assert.equal(stored.ok, true, stored.error)
  assert.equal(stored.session.pendingPermissions[0].requestId, pending.requestId, 'history page cannot replace the current actionable approval snapshot')
  assert.ok(stored.events.every((item) => item.kind !== 'permission' || item.payload.pending === false))
  const observed = [...stored.events]
  let imagePage
  if (stored.events.some((item) => item.payload?.images)) imagePage = stored
  while (stored.beforeCursor) {
    stored = await acp.getAcpHistoryEvents(root, created.sessionId, { before: stored.beforeCursor }); assert.equal(stored.ok, true, stored.error)
    if (stored.events.some((item) => item.payload?.images)) imagePage = stored
    observed.push(...stored.events)
  }
  assert.ok(imagePage, 'history contains the original image prompt')
  assert.equal(imagePage.oversized, true)
  assert.equal(imagePage.startsMidTurn, false, 'turn-scoped observations before the image prompt are not a missing prefix')
  assert.deepEqual(imagePage.events.find((item) => item.payload?.images).payload.images, images)
  for (const index of [0, 525, 1050]) assert.ok(imagePage.events.some((item) => item.text === `fragment-${index}|`), 'image prompt and every response fragment share the page')
  assert.ok(imagePage.events.some((item) => item.kind === 'permission' && item.payload.requestId === pending.requestId && item.payload.pending === false))
  assert.equal(new Set(observed.map((item) => item.id)).size, observed.length)
  for (const index of [0, 525, 1050]) assert.ok(observed.some((item) => item.text === `fragment-${index}|`))
  assert.equal((await acp.respondAcpPermission(root, pending.requestId, 'deny')).ok, true)
  await wait(() => current()?.status === 'ready', 'settled')
  assert.equal(current().pendingPermissions.length, 0)
  assert.equal(acp.respondAcpPermission(root, pending.requestId, 'deny').ok, false)
  const afterPermission = await acp.getAcpHistorySession(root, created.sessionId); assert.equal(afterPermission.ok, true); assert.equal(afterPermission.session.pendingPermissions.length, 0)
  assert.equal(afterPermission.session.historyPersistence.state, 'saved')
  const id = created.sessionId
  assert.equal((await acp.killAcpSession(root, id)).ok, true)
  assert.equal(acp.listAcpSessions(root).sessions.find((item) => item.sessionId === id).events.length, 800)
  await acp.stopAcpHistory()
  const reopened = await acp.getAcpHistorySession(root, id); assert.equal(reopened.ok, true, reopened.error)
  assert.ok(reopened.session.eventCount > 1950)
  console.log('PASS real facade >800 ACP fragments + Trellis rail, 20MiB images intact, bounded cache, live approvals independent of pages and fresh worker reopen')

  const lock = new DatabaseSync(join(temporary, 'acp', 'history.sqlite')); lock.exec('BEGIN IMMEDIATE')
  const bufferedRecord = record('write-failure')
  acp.archiveAcpEvent(bufferedRecord, { ...event('uncommitted'), sessionId: 'write-failure' })
  await assert.rejects(() => acp.flushAcpHistory(), /locked/)
  assert.equal(acp.historyPersistence('write-failure').state, 'degraded')
  assert.equal(acp.historyPersistence('write-failure').committedThroughSeq, null)
  assert.equal(acp.historyPersistence('write-failure').pendingCount, 1)
  lock.exec('ROLLBACK'); lock.close()
  await acp.retryAcpHistory()
  assert.equal(acp.historyPersistence('write-failure').state, 'saved')
  assert.equal((await acp.getAcpHistoryEvents(root, 'write-failure')).events[0].id, 'uncommitted')
  console.log('PASS write failure keeps buffered data and committed marker honest; explicit retry commits it once')

  const concurrentRecord = record('concurrent-flush')
  acp.archiveAcpEvent(concurrentRecord, { ...event('concurrent-first'), sessionId: 'concurrent-flush' })
  const flushing = acp.flushAcpHistory()
  acp.archiveAcpEvent(concurrentRecord, { ...event('concurrent-tail'), sessionId: 'concurrent-flush' })
  await Promise.all([flushing, acp.flushAcpHistory(), acp.flushAcpHistory()])
  assert.equal((await acp.getAcpHistorySession(root, 'concurrent-flush')).session.eventCount, 2)
  console.log('PASS concurrent drain callers share ordered queue without removing uncommitted tail events')

  await acp.stopAcpHistory()
  const exitWorker = join(temporary, 'exit-worker.cjs')
  writeFileSync(exitWorker, `const {parentPort}=require('node:worker_threads'); parentPort.on('message',m=>{if(m.op==='append')process.exit(9);else parentPort.postMessage({requestId:m.requestId,ok:true,result:{ready:true}})});`)
  process.env.TRELLIS_ACP_HISTORY_WORKER_FILE = exitWorker
  acp.archiveAcpEvent(record('worker-exit'), { ...event('exit-pending'), sessionId: 'worker-exit' })
  await assert.rejects(() => acp.flushAcpHistory(), /exited/)
  assert.equal(acp.historyPersistence('worker-exit').pendingCount, 1)
  assert.equal(acp.historyPersistence('worker-exit').committedThroughSeq, null)
  process.env.TRELLIS_ACP_HISTORY_WORKER_FILE = workerFile
  await acp.retryAcpHistory()
  assert.equal(acp.historyPersistence('worker-exit').state, 'saved')
  console.log('PASS worker exit preserves pending queue; fresh worker retry deduplicates and commits')

  const queueLock = new DatabaseSync(join(temporary, 'acp', 'history.sqlite')); queueLock.exec('BEGIN IMMEDIATE')
  const overflowRecord = record('queue-limit')
  acp.archiveAcpEvent(overflowRecord, { ...event('limit-0'), sessionId: 'queue-limit' })
  await assert.rejects(() => acp.flushAcpHistory(), /locked/)
  for (let index = 1; index < 10051; index++) acp.archiveAcpEvent(overflowRecord, { ...event(`limit-${index}`), sessionId: 'queue-limit' })
  assert.equal(acp.historyPersistence('queue-limit').unarchivedCount, 51)
  queueLock.exec('ROLLBACK'); queueLock.close()
  await acp.retryAcpHistory()
  assert.equal(acp.historyPersistence('queue-limit').state, 'degraded', 'retry cannot claim overflowed events were saved')
  const partial = await acp.getAcpHistorySession(root, 'queue-limit')
  assert.equal(partial.session.eventCount, 10000)
  assert.equal(partial.session.historyCoverage.state, 'partial')
  assert.equal(partial.session.historyCoverage.unarchivedCount, 51)
  await acp.stopAcpHistory()
  assert.equal((await acp.getAcpHistorySession(root, 'queue-limit')).session.historyPersistence.state, 'degraded')
  console.log('PASS bounded failure queue, explicit unarchived count, sticky partial coverage after retry/reopen')

  await acp.stopAcpHistory()
  for (const fixture of pagingFixtures) writeFileSync(join(temporary, 'acp-sessions', `${fixture.id}.json`), JSON.stringify(record(fixture.id, fixture.groups.flat())))
  for (let index = 0; index < 27; index++) writeFileSync(join(temporary, 'acp-sessions', `fallback-${index}.json`), JSON.stringify({ ...record(`fallback-${index}`, [event(`fallback-message-${index}`)]), title: `fallback searchable ${index}` }))
  const databasePath = join(temporary, 'acp', 'history.sqlite')
  const archiveBytes = readFileSync(databasePath)
  writeFileSync(databasePath, 'damaged fixture archive')
  for (const fixture of pagingFixtures) {
    const read = async (input) => {
      const page = await acp.getAcpHistoryEvents(root, fixture.id, input)
      assert.equal(page.ok, true, page.error)
      assert.equal(page.historyPersistence.state, 'degraded')
      assert.equal(page.coverage.state, 'unknown', 'snapshot fallback cannot claim a complete archive')
      assert.deepEqual(page.session.pendingPermissions, [])
      return page
    }
    for (const limit of [undefined, 1, 7]) await verifyTurnPaging(read, fixture, limit, false)
    console.log(`PASS complete-turn snapshot fallback ${fixture.id}: both directions, exact content, honest boundaries and readonly approvals`)
  }
  const fallbackCursor = (await acp.getAcpHistoryEvents(root, 'paging-stream', { limit: 1 })).beforeCursor
  assert.ok(fallbackCursor)
  assert.equal((await acp.getAcpHistoryEvents(root, 'paging-legacy', { before: fallbackCursor })).ok, false, 'fallback cursor is session scoped')
  assert.equal((await acp.getAcpHistoryEvents(root, 'paging-stream', { before: 'malformed' })).ok, false)
  assert.equal((await acp.getAcpHistoryEvents(root, 'paging-stream', { before: fallbackCursor, after: fallbackCursor })).ok, false)
  const changedSnapshot = join(temporary, 'acp-sessions', 'paging-stream.json')
  writeFileSync(changedSnapshot, JSON.stringify(record('paging-stream', [...pagingFixtures[0].groups.flat(), ...turn('paging-stream', 'changed-after-cursor', 1)])))
  assert.equal((await acp.getAcpHistoryEvents(root, 'paging-stream', { before: fallbackCursor })).ok, false, 'snapshot mutation invalidates old fallback cursor')
  const fallback = await acp.getAcpHistorySession(root, id)
  assert.equal(fallback.ok, true, fallback.error)
  assert.equal(fallback.session.historyPersistence.state, 'degraded')
  assert.equal(fallback.session.historyCoverage.state, 'unknown')
  let fallbackPage = await acp.getAcpHistoryEvents(root, id, { limit: 73 })
  let fallbackCount = fallbackPage.events.length
  while (fallbackPage.beforeCursor) { fallbackPage = await acp.getAcpHistoryEvents(root, id, { limit: 73, before: fallbackPage.beforeCursor }); assert.equal(fallbackPage.ok, true, fallbackPage.error); fallbackCount += fallbackPage.events.length }
  assert.equal(fallbackCount, 800, 'archive failure retains readable bounded snapshot with honest coverage')
  let fallbackList = await acp.listAcpHistorySessions(root, { query: 'fallback searchable', limit: 7 })
  const fallbackIds = fallbackList.sessions.map((session) => session.sessionId)
  while (fallbackList.nextCursor) { fallbackList = await acp.listAcpHistorySessions(root, { query: 'fallback searchable', limit: 7, cursor: fallbackList.nextCursor }); fallbackIds.push(...fallbackList.sessions.map((session) => session.sessionId)) }
  assert.equal(new Set(fallbackIds).size, 27)
  assert.equal(readFileSync(databasePath, 'utf8'), 'damaged fixture archive')
  writeFileSync(databasePath, archiveBytes)
  console.log('PASS archive corruption preserves source/database, full fallback catalogue and explicitly bounded readable transcript')
} finally {
  core?.close()
  await acp?.shutdownAcp()
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
  assert.ok(basename(temporary).startsWith('trellis-acp-history-'))
  rmSync(temporary, { recursive: true, force: true })
}

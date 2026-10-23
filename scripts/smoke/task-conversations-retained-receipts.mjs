/** Real observation schema + native metadata + isolated durable conversation store. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { createFixture, database } from './fixtures/task-conversations-data.mjs'

const directory = mkdtempSync(join(tmpdir(), 'trellis-retained-receipts-'))
const oldLocal = process.env.LOCALAPPDATA, oldReceipts = process.env.TRELLIS_RECEIPTS
let checks = 0, service
const check = (condition, message) => { assert.ok(condition, message); checks++ }
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
try {
  const bundle = join(directory, 'retained.cjs')
  await build({ stdin: { contents: `
    export {readRetainedReceiptEvidence,RETAINED_RECEIPT_LIMITS} from './src/main/services/task-conversations/lib/retained-receipts';
    export {TaskConversationsService} from './src/main/services/task-conversations';
    export {ObservationStoreCore,stableStringify} from './src/main/services/observability/store-core';
    export {ensureInstallationIdentity,createOrVerifyBinding,installationDir} from './src/main/services/observability/identity';
    export {readCodex} from './src/main/services/task-conversations/lib/codex';
    export {canonicalRoot} from './src/main/services/task-conversations/lib/paths';
    export {knownTasks} from './src/main/services/task-conversations/lib/identity';
    export {importHistory} from './src/main/services/task-conversations/lib/history-import';`, resolveDir: process.cwd(), loader: 'ts' },
    outfile: bundle, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  const api = createRequire(import.meta.url)(bundle)
  if (process.argv.includes('--local')) {
    // Exact production readers/importer; the persistence port records only in memory.
    const root = api.canonicalRoot(resolve(process.argv[process.argv.indexOf('--local') + 1] || process.cwd()))
    const evidence = api.readRetainedReceiptEvidence(root)
    const native = api.readCodex(process.env.CODEX_HOME || join(homedir(), '.codex'), root, evidence)
    const owners = [], accepted = new Map()
    api.importHistory(root, api.knownTasks(root), native, evidence, {
      owners: () => owners,
      owner: task => {
        const owner = { key: randomUUID(), taskRef: task.trellisTaskId ? `task:${task.trellisTaskId}` : `dir:${task.dir}`, trellisId: task.trellisTaskId, currentDir: task.dir, priorDirs: [] }
        owners.push(owner); return owner
      },
      bind: (owner, item) => accepted.set(JSON.stringify([owner.key, item.source, item.sessionId]), { taskRef: owner.taskRef, taskDir: owner.currentDir, source: item.source, sessionId: item.sessionId, title: item.title })
    }, Date.now())
    console.log(JSON.stringify({ scope: 'read-only existing observations/native metadata; in-memory importer; no control DB or client writes', candidates: evidence.length, accepted: [...accepted.values()] }, null, 2))
  } else {
    process.env.LOCALAPPDATA = join(directory, 'local-installation')
    delete process.env.TRELLIS_RECEIPTS
    const installation = api.ensureInstallationIdentity()
    const f = createFixture(join(directory, 'project'))
    const runtime = join(f.root, '.trellis', '.panel', 'runtime'), observation = join(runtime, 'observations.sqlite')
    check(api.readRetainedReceiptEvidence(f.root).length === 0 && !existsSync(runtime), 'missing optional store is skipped without creating runtime/binding/database')
    service = new api.TaskConversationsService(f.options)
    await service.list(f.root)
    f.task('old-manual', 'old-manual')
    const oldManual = (await service.discover(f.root)).items.find(item => item.sessionId === f.codexOther)
    await service.bind(f.root, 'old-manual', oldManual.id)
    check(!existsSync(observation) && !existsSync(join(runtime, 'binding.json')), 'ordinary conversation service never initializes observation collection')
    service.close(); service = undefined
    const bound = api.createOrVerifyBinding({ root: f.root, runtimeDir: runtime, installation, gitFacts: { gitCommonDir: null, worktreeRoot: null } })
    assert.equal(bound.status, 'bound')
    const binding = bound.binding, bindingFile = join(runtime, 'binding.json')
    const core = new api.ObservationStoreCore(runtime)
    core.setBinding({ repositoryId: binding.repositoryId, workspaceId: binding.workspaceId, collectionEnabled: true, collectionBlocked: false, blockReason: null })
    core.open()
    const pairs = [
      ['R1-01', 'wf-durable-control'], ['R1-02', 'wf-engine-materials'], ['R1-03', 'wf-conversation-graph'],
      ['R1-04', 'wf-reading-windows'], ['R1-05', 'wf-runtime-revisions']
    ]
    const event = (name, id, overrides = {}) => ({
      schemaVersion: 1, eventId: randomUUID(), injectionId: randomUUID(), kind: 'context.emitted', occurredAtMs: Date.now(),
      producer: { host: 'codex', hook: 'SubagentStart', version: '0.6.17', capability: 'context.v1' },
      scope: { repositoryId: binding.repositoryId, workspaceId: binding.workspaceId, taskRef: name,
        trellisTaskId: id, taskPath: `.trellis/tasks/${name}`, association: 'resolved' },
      session: { parentId: f.codexId, childId: null, runId: null }, materials: [],
      totals: { expectedEntries: 0, recordedEntries: 0, omittedEntries: 0, contextUtf8Bytes: 0, stdoutUtf8Bytes: 0, budgetBytes: null, completeness: 'complete' },
      outputDigest: 'a'.repeat(64), diagnosticCode: null, ...overrides
    })
    const insert = value => { assert.equal(core.insertEvent(value, Date.now()).status, 'inserted') }
    for (const [name, id] of pairs) {
      f.task(name, id)
      const emitted = event(name, id)
      insert({ ...emitted, eventId: randomUUID(), kind: 'context.assembled', outputDigest: null })
      insert(emitted)
    }
    for (const name of ['assembled-only', 'unresolved', 'wrong-host', 'invalid-native', 'foreign-native', 'child-native', 'copy-a', 'copy-b', 'reused', 'bad-digest', 'foreign-binding']) f.task(name, name)
    f.task('copy-a', 'copied-id'); f.task('copy-b', 'copied-id')
    f.task('reused', 'replacement-id'); f.task('archive/2026-10/original', 'old-reused-id')
    f.task('archive/2026-10/unique-archive', 'archived-stable-id')
    insert(event('assembled-only', 'assembled-only', { kind: 'context.assembled' }))
    const unresolved = event('unresolved', 'unresolved'); unresolved.scope.association = 'unresolved'; insert(unresolved)
    const wrongHost = event('wrong-host', 'wrong-host'); wrongHost.producer.host = 'zcode'; insert(wrongHost)
    const invalid = event('invalid-native', 'invalid-native'); invalid.session.parentId = 'not-a-native-uuid'; insert(invalid)
    const foreignNativeId = randomUUID(), childId = randomUUID()
    const foreignNative = event('foreign-native', 'foreign-native'); foreignNative.session.parentId = foreignNativeId; insert(foreignNative)
    const child = event('child-native', 'child-native'); child.session.parentId = childId; insert(child)
    insert(event('copy-a', 'copied-id')); insert(event('reused', 'old-reused-id'))
    insert(event('missing-original', 'archived-stable-id'))
    const badDigest = event('bad-digest', 'bad-digest'); insert(badDigest)
    core.close()
    database(f.codexFile, 'ALTER TABLE threads ADD COLUMN thread_source TEXT', db => {
      db.prepare('UPDATE threads SET thread_source=? WHERE id=?').run('user', f.codexId)
      const add = db.prepare('INSERT INTO threads(id,cwd,title,updated_at_ms,thread_source) VALUES(?,?,?,?,?)')
      add.run(foreignNativeId, f.foreign, 'foreign', 1900000000000, 'user')
      add.run(childId, f.root, 'explicit native child', 1900000000000, 'subagent')
      // The real native parent is older than the normal discovery page.
      for (let n = 0; n < 505; n++) add.run(randomUUID(), f.root, 'newer native user history', 1900000001000 + n, 'user')
    })
    database(observation, null, db => {
      db.prepare('UPDATE events SET payloadDigest=? WHERE eventId=?').run('0'.repeat(64), badDigest.eventId)
      const foreign = event('foreign-binding', 'foreign-binding'); foreign.scope.workspaceId = 'foreign-workspace'
      const payload = JSON.stringify(foreign)
      db.prepare('INSERT INTO events(eventId,payloadDigest,injectionId,kind,repositoryId,workspaceId,taskRef,occurredAtMs,receivedAtMs,payloadBytes,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(foreign.eventId, createHash('sha256').update(api.stableStringify(foreign)).digest('hex'), foreign.injectionId, foreign.kind,
          foreign.scope.repositoryId, foreign.scope.workspaceId, foreign.scope.taskRef, foreign.occurredAtMs, Date.now(), Buffer.byteLength(payload), payload)
    })
    const before = hash(observation), candidates = api.readRetainedReceiptEvidence(f.root)
    check(candidates.filter(item => pairs.some(([, id]) => id === item.trellisId)).length === 5, 'actual emitted/resolved stable IDs produce the five retained R1 candidates once')
    for (const name of ['assembled-only', 'unresolved', 'wrong-host', 'invalid-native', 'bad-digest', 'foreign-binding']) check(!candidates.some(item => item.taskDir.endsWith(`/${name}`)), `reject ${name} receipt evidence`)
    service = new api.TaskConversationsService(f.options)
    let snapshot = await service.list(f.root)
    for (const [name, id] of pairs) check(snapshot.bindings.some(item => item.taskDir === name && item.taskRef === `task:${id}` && item.conversation.sessionId === f.codexId), `recover ${name} through native verification despite absent runtime/unsupported JS history and >500 newer sessions`)
    for (const name of ['foreign-native', 'child-native', 'copy-a', 'copy-b', 'reused']) check(!snapshot.bindings.some(item => item.taskDir === name), `existing importHistory rejects ${name} association`)
    check(snapshot.bindings.some(item => item.taskDir === 'archive/2026-10/unique-archive'), 'explicit retained stable ID follows one unique archive target')
    check(hash(observation) === before, 'optional reader and conversation imports do not change the observation database')
    check(!('evidence' in snapshot) && !('retained' in snapshot), 'retained payload/evidence remains outside IPC snapshots')
    const r1 = snapshot.bindings.find(item => item.taskDir === 'R1-01')
    const claude = (await service.discover(f.root)).items.find(item => item.source === 'claude-code')
    snapshot = await service.bind(f.root, 'R1-01', claude.id)
    check(snapshot.bindings.find(item => item.taskDir === 'R1-01' && item.primary).conversation.source === 'claude-code', 'manual primary survives repeated retained-receipt import')
    snapshot = await service.unbind(f.root, 'R1-01', r1.id)
    check(!snapshot.bindings.some(item => item.id === r1.id), 'explicit unlink suppresses an otherwise retained relation')
    const previousSequence = database(observation, null, db => db.prepare('SELECT max(seq) AS seq FROM events').get().seq)
    database(observation, null, db => {
      db.exec('BEGIN')
      const add = db.prepare('INSERT INTO events(eventId,payloadDigest,injectionId,kind,repositoryId,workspaceId,taskRef,occurredAtMs,receivedAtMs,payloadBytes,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      for (let n = 0; n < api.RETAINED_RECEIPT_LIMITS.rows; n++) {
        const value = event(`optional-padding-${n}`, `optional-padding-${n}`), payload = JSON.stringify(value)
        add.run(value.eventId, createHash('sha256').update(api.stableStringify(value)).digest('hex'), value.injectionId, value.kind,
          binding.repositoryId, binding.workspaceId, value.scope.taskRef, value.occurredAtMs, Date.now(), Buffer.byteLength(payload), payload)
      }
      db.exec('COMMIT')
    })
    check(api.readRetainedReceiptEvidence(f.root).length === api.RETAINED_RECEIPT_LIMITS.rows, 'full optional page can contain repeated parent IDs for distinct tasks')
    snapshot = await service.list(f.root)
    check(snapshot.bindings.find(item => item.taskDir === 'old-manual')?.conversation.capability === 'session', 'optional repeated IDs cannot hide an older saved native binding behind the 500-item lookup limit')
    database(observation, null, db => db.prepare('DELETE FROM events WHERE seq>?').run(previousSequence))
    service.close(); service = undefined
    for (const change of [{ collectionEnabled: false }, { schemaVersion: 2 }, { canonicalRoot: f.foreign }, { installationId: randomUUID() }, { workspaceId: 'copied-foreign-workspace' }, { repositoryId: 'copied-foreign-repo' }]) {
      writeFileSync(bindingFile, JSON.stringify({ ...binding, ...change }))
      check(api.readRetainedReceiptEvidence(f.root).length === 0, `invalid/disabled project binding skips optional feed: ${Object.keys(change)[0]}`)
    }
    writeFileSync(bindingFile, JSON.stringify(binding))
    process.env.TRELLIS_RECEIPTS = 'off'; check(api.readRetainedReceiptEvidence(f.root).length === 0, 'disabled producer feed is not enabled implicitly'); delete process.env.TRELLIS_RECEIPTS
    for (const [key, value] of [['dbVersion', '2'], ['protocolMax', '2'], ['migrationState', 'running']]) {
      const previous = database(observation, null, db => db.prepare('SELECT value FROM schema_meta WHERE key=?').get(key).value)
      database(observation, null, db => db.prepare('UPDATE schema_meta SET value=? WHERE key=?').run(value, key))
      check(api.readRetainedReceiptEvidence(f.root).length === 0, `unsupported database state skips optional feed: ${key}`)
      database(observation, null, db => db.prepare('UPDATE schema_meta SET value=? WHERE key=?').run(previous, key))
    }
    const locker = new DatabaseSync(observation)
    try { locker.exec('BEGIN EXCLUSIVE'); check(api.readRetainedReceiptEvidence(f.root).length === 0, 'locked optional observation database cannot block or break ordinary history') }
    finally { locker.exec('ROLLBACK'); locker.close() }
    const validBytes = readFileSync(observation)
    writeFileSync(observation, 'corrupt observation database')
    check(api.readRetainedReceiptEvidence(f.root).length === 0, 'corrupt retained DB is skipped without repair')
    writeFileSync(observation, validBytes)
    // Remove the exact optional source path before unlinking: Windows may keep an opened
    // SQLite inode pending deletion until all native statements have been collected.
    const removedObservation = join(runtime, 'removed-observations.sqlite')
    assert.equal(resolve(observation, '..'), runtime); assert.equal(resolve(removedObservation, '..'), runtime)
    renameSync(observation, removedObservation)
    rmSync(removedObservation)
    check(!existsSync(observation), 'fixture observation deletion completes before restart')
    check(api.readRetainedReceiptEvidence(f.root).length === 0 && !existsSync(observation), 'missing-store collector does not recreate its source')
    service = new api.TaskConversationsService(f.options); snapshot = await service.list(f.root)
    check(pairs.slice(1).every(([name]) => snapshot.bindings.some(item => item.taskDir === name && item.conversation.sessionId === f.codexId)), 'accepted links survive observation cleanup and service restart')
    check(!snapshot.bindings.some(item => item.taskDir === 'R1-01' && item.conversation.sessionId === f.codexId), 'unlink tombstone survives later observation deletion and restart')
    check(!existsSync(observation), 'cleared optional store is not recreated')
    check(f.calls.length === 0, 'automatic receipt backfill never activates a client or sends a prompt')
    console.log(JSON.stringify({ ok: true, checks, scope: 'real observation/native formats and isolated persistence; no real source writes or client activation' }))
  }
} finally {
  service?.close()
  if (oldLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = oldLocal
  if (oldReceipts === undefined) delete process.env.TRELLIS_RECEIPTS; else process.env.TRELLIS_RECEIPTS = oldReceipts
  rmSync(directory, { recursive: true, force: true })
}

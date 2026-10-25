/** Real worker/SQLite fault and migration checks. Internal verified-identity seed is NOT OIDC proof. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, symlinkSync, renameSync, readdirSync, cpSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createTeamService, restoreTeamBackup } from '../dist/index.mjs'

const config = (dataDir) => ({ dataDir, publicOrigin: 'https://team-owned.invalid', oidc: { issuer: 'https://issuer-owned.invalid', clientId: 'owned-fixture' }, bootstrapSubject: 'alice' })
const hash = (value) => createHash('sha256').update(value).digest('hex')
async function seed(service) {
  const credentialHash = hash('owned-internal-session')
  await service.store.call('completeLogin', { issuer: 'https://issuer-owned.invalid', subject: 'alice', displayName: 'Alice migration fixture', sessionHash: credentialHash, csrfToken: 'owned-csrf-token-which-is-long-enough' })
  const actor = { kind: 'session', credentialHash }
  const team = await service.store.call('createTeam', { actor, body: { commandId: randomUUID(), name: 'Historical team' } })
  const project = await service.store.call('createProject', { actor, body: { commandId: randomUUID(), teamId: team.result.teamId, name: 'Historical project' } })
  const source = { kind: 'authored', sourceId: 'source-1', version: 'source-v1' }
  const publication = { commandId: randomUUID(), materialId: randomUUID(), projectId: project.result.projectId, visibility: 'project', title: 'Historical material', kind: 'design', text: '# Actual retained body\n', source, expectedVersion: null }
  await service.store.call('publish', { actor, body: publication })
  const enrollment = await service.store.call('enrollDevice', { deviceName: 'Historical desktop', projectId: project.result.projectId, capabilityClaims: [] })
  await service.store.call('approveDevice', { actor, pairingId: enrollment.pairingId, body: { commandId: randomUUID(), expectedProjectId: project.result.projectId, userCode: enrollment.userCode } })
  return { actor, publication, enrollment, identity: await service.store.call('health', {}) }
}

for (const legacyVersion of [1, 2]) test(`real schema${legacyVersion} migration preserves identities, bodies, command results and approved credentials`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-team-migration-'))
  let service = await createTeamService(config(join(directory, 'store')))
  try {
    const seeded = await seed(service); await service.close()
    const database = new DatabaseSync(join(directory, 'store/team.sqlite'))
    try {
      database.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;')
      for (const { name } of database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'hifox_workspace_%'").all()) {
        assert.match(name, /^hifox_workspace_[a-z_]+$/)
        database.exec(`DROP TRIGGER ${name};`)
      }
      for (const table of ['collaboration_dispositions', 'collaboration_reports', 'collaboration_replies', 'collaboration_history', 'collaboration_scope', 'collaboration', 'hifox_inbox_preferences', 'hifox_workspaces', 'invitations', 'local_credentials']) database.exec(`DROP TABLE IF EXISTS ${table};`)
      if (legacyVersion === 1) {
        const definition = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='devices'").get().sql
        database.exec('ALTER TABLE devices RENAME TO devices_newer;')
        database.exec(definition.replace('projectId TEXT REFERENCES', 'projectId TEXT NOT NULL REFERENCES'))
        database.exec('INSERT INTO devices SELECT * FROM devices_newer; DROP TABLE devices_newer;')
      }
      database.exec('ALTER TABLE people DROP COLUMN revision;')
      database.exec(`PRAGMA user_version=${legacyVersion}; COMMIT;`)
    } finally { database.close() }
    service = await createTeamService(config(join(directory, 'store')))
    const identity = await service.store.call('health', {}); assert.equal(identity.schemaVersion, seeded.identity.schemaVersion); assert.equal(identity.instanceId, seeded.identity.instanceId); assert.equal(identity.epoch, seeded.identity.epoch)
    const document = await service.store.call('document', { actor: seeded.actor, materialId: seeded.publication.materialId, version: 1 }); assert.equal(document.text, seeded.publication.text)
    assert.equal((await service.store.call('publish', { actor: seeded.actor, body: seeded.publication })).status, 'duplicate')
    const device = await service.store.call('authenticate', { actor: { kind: 'device', credentialHash: hash(seeded.enrollment.deviceToken) } }); assert.equal(device.projectId, seeded.publication.projectId)
    const candidate = await service.store.call('enrollDevice', { deviceName: 'New projectless desktop', capabilityClaims: [] })
    assert.equal((await service.store.call('pairingStatus', { pairingId: candidate.pairingId, credentialHash: hash(candidate.deviceToken) })).projectId, null)
  } finally { await service.close().catch(() => {}); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('trellis-team-migration-')); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})

for (const legacyVersion of [6, 7]) for (const partial of [false, true]) test(`schema${legacyVersion} with ${partial ? 'partial' : 'missing'} workspace triggers upgrades without replacing retained tables`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-team-trigger-migration-'))
  const dataDir = join(directory, 'store'); let service = await createTeamService(config(dataDir))
  try {
    const seeded = await seed(service), projectId = seeded.publication.projectId
    await service.store.call('hifoxCommand', { actor: seeded.actor, projectId, body: { commandId: randomUUID(), expectedEpoch: seeded.identity.epoch, expectedRevision: 0, operation: 'createSpace', input: { name: 'Retained workspace', key: 'KEEP' } } })
    const before = await service.store.call('hifoxSnapshot', { actor: seeded.actor, projectId })
    await service.close()
    const database = new DatabaseSync(join(dataDir, 'team.sqlite'))
    try {
      const triggers = database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'hifox_workspace_%' ORDER BY name").all()
      assert.equal(triggers.length, 7)
      for (const { name } of triggers.slice(partial ? 1 : 0)) { assert.match(name, /^hifox_workspace_[a-z_]+$/); database.exec(`DROP TRIGGER ${name};`) }
      database.prepare('INSERT INTO hifox_inbox_preferences(projectId,userId,inboxId,read,cleared,snoozedUntil) VALUES(?,?,?,1,0,NULL)').run(projectId, before.actor.id, 'retained-inbox-preference')
      if (legacyVersion === 6) database.exec('DROP TABLE local_credentials;')
      database.exec(`PRAGMA user_version=${legacyVersion};`)
    } finally { database.close() }
    service = await createTeamService(config(dataDir))
    const identity = await service.store.call('health', {})
    assert.equal(identity.schemaVersion, 9); assert.equal(identity.instanceId, seeded.identity.instanceId); assert.equal(identity.epoch, seeded.identity.epoch)
    const retained = await service.store.call('hifoxSnapshot', { actor: seeded.actor, projectId })
    assert.deepEqual(retained, { ...before, serverTime: retained.serverTime })
    assert.equal((await service.store.call('document', { actor: seeded.actor, materialId: seeded.publication.materialId, version: 1 })).text, seeded.publication.text)
    assert.equal((await service.store.call('authenticate', { actor: { kind: 'device', credentialHash: hash(seeded.enrollment.deviceToken) } })).projectId, projectId)
    await service.store.call('setProjectMember', { actor: seeded.actor, projectId, body: { commandId: randomUUID(), userId: before.actor.id, roles: ['pm'], active: true, expectedRevision: 1 } })
    const changed = await service.store.call('hifoxSnapshot', { actor: seeded.actor, projectId })
    assert.equal(changed.revision, retained.revision + 1)
    await service.close(); service = await createTeamService(config(dataDir))
    assert.equal((await service.store.call('hifoxSnapshot', { actor: seeded.actor, projectId })).revision, changed.revision)
    await service.close()
    const migrated = new DatabaseSync(join(dataDir, 'team.sqlite'), { readOnly: true })
    try {
      assert.equal(migrated.prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE type='trigger' AND name LIKE 'hifox_workspace_%'").get().total, 7)
      assert.equal(migrated.prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE type='table' AND name IN ('hifox_workspaces','hifox_inbox_preferences','invitations','local_credentials')").get().total, 4)
      assert.equal(migrated.prepare('SELECT read FROM hifox_inbox_preferences WHERE inboxId=?').get('retained-inbox-preference').read, 1)
    } finally { migrated.close() }
  } finally { await service.close().catch(() => {}); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('trellis-team-trigger-migration-')); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})

test('verified restore rotates staged cursor identities, preserves accounts and original backup, and rejects invalid identities before publication', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-team-restore-identity-'))
  const service = await createTeamService(config(join(directory, 'store')))
  const meta = (db) => Object.fromEntries(db.prepare('SELECT key,value FROM team_meta').all().map(({ key, value }) => [key, value]))
  try {
    const seeded = await seed(service), backup = join(directory, 'backup')
    await service.store.backup(backup)
    const sourceDatabase = readFileSync(join(backup, 'team.sqlite')), sourceManifest = readFileSync(join(backup, 'backup.json'))
    const original = new DatabaseSync(join(backup, 'team.sqlite'), { readOnly: true })
    let originalMeta
    try { originalMeta = meta(original) } finally { original.close() }
    for (const suffix of ['first', 'second']) {
      const restored = restoreTeamBackup(backup, join(directory, suffix)), db = new DatabaseSync(join(restored.destination, 'team.sqlite'), { readOnly: true })
      try {
        const actual = meta(db)
        assert.equal(actual.instanceId, originalMeta.instanceId); assert.equal(actual.epoch, restored.epoch); assert.notEqual(actual.epoch, originalMeta.epoch)
        assert.match(actual.cursorSecret, /^[a-f0-9]{64}$/); assert.notEqual(actual.cursorSecret, originalMeta.cursorSecret)
        assert.equal(Number(actual.authorizationRevision), Number(originalMeta.authorizationRevision) + 1)
      } finally { db.close() }
      const recovered = await createTeamService(config(restored.destination))
      try {
        assert.equal((await recovered.store.call('authenticate', { actor: seeded.actor })).person.userId, (await service.store.call('authenticate', { actor: seeded.actor })).person.userId)
        assert.equal((await recovered.store.call('authenticate', { actor: { kind: 'device', credentialHash: hash(seeded.enrollment.deviceToken) } })).projectId, seeded.publication.projectId)
        const document = await recovered.store.call('document', { actor: seeded.actor, materialId: seeded.publication.materialId, version: 1 })
        assert.equal(document.text, seeded.publication.text); assert.equal(document.material.ownerId, (await recovered.store.call('authenticate', { actor: seeded.actor })).person.userId)
      } finally { await recovered.close() }
    }
    assert.deepEqual(readFileSync(join(backup, 'team.sqlite')), sourceDatabase); assert.deepEqual(readFileSync(join(backup, 'backup.json')), sourceManifest)
    for (const [index, [key, value]] of [['epoch', randomUUID()], ['authorizationRevision', 'NaN'], ['authorizationRevision', '0'], ['authorizationRevision', String(Number.MAX_SAFE_INTEGER)], ['cursorSecret', 'invalid']].entries()) {
      const invalid = join(directory, `invalid-${index}`); cpSync(backup, invalid, { recursive: true })
      const db = new DatabaseSync(join(invalid, 'team.sqlite'))
      try { db.prepare('UPDATE team_meta SET value=? WHERE key=?').run(value, key) } finally { db.close() }
      const manifest = JSON.parse(readFileSync(join(invalid, 'backup.json'), 'utf8')); manifest.databaseDigest = hash(readFileSync(join(invalid, 'team.sqlite'))); writeFileSync(join(invalid, 'backup.json'), JSON.stringify(manifest))
      const target = join(directory, `rejected-${index}`)
      assert.throws(() => restoreTeamBackup(invalid, target), (error) => error.code === 'CORRUPT_BACKUP')
      assert.equal(existsSync(target), false)
    }
    const blob = join(backup, 'blobs', hash(seeded.publication.text)); writeFileSync(blob, 'corrupted original blob')
    const before = new Set(readdirSync(directory))
    assert.throws(() => restoreTeamBackup(backup, join(directory, 'corrupt-blob')), /verification/)
    assert.equal(existsSync(join(directory, 'corrupt-blob')), false)
    const staged = readdirSync(directory).filter((name) => !before.has(name) && name.startsWith('.team-restore-'))
    assert.equal(staged.length, 1)
    const unchanged = new DatabaseSync(join(directory, staged[0], 'team.sqlite'), { readOnly: true })
    try { assert.deepEqual(meta(unchanged), originalMeta) } finally { unchanged.close() }
  } finally { await service.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('trellis-team-restore-identity-')); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})

test('single live writer, unsupported future schema and corrupt data fail closed without replacing originals', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-team-store-fault-'))
  const dataDir = join(directory, 'store'); let service = await createTeamService(config(dataDir))
  try {
    const seeded = await seed(service)
    await assert.rejects(createTeamService(config(dataDir)), /owns this data directory|lock/)
    assert.equal((await service.store.call('health', {})).schemaVersion, seeded.identity.schemaVersion)
    await service.close()
    const path = join(dataDir, 'team.sqlite'); const db = new DatabaseSync(path); db.exec('PRAGMA user_version=99'); db.close()
    const before = readFileSync(path)
    await assert.rejects(createTeamService(config(dataDir)), /newer service version/)
    assert.equal(hash(readFileSync(path)), hash(before))
    const foreign = join(directory, 'foreign'); mkdirSync(foreign)
    const foreignPath = join(foreign, 'team.sqlite'); const other = new DatabaseSync(foreignPath); other.exec('CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES(\'retain me\');'); other.close()
    const foreignHash = hash(readFileSync(foreignPath))
    await assert.rejects(createTeamService(config(foreign)), /no supported team schema/)
    assert.equal(hash(readFileSync(foreignPath)), foreignHash)
    const corrupt = join(directory, 'corrupt'); mkdirSync(corrupt); writeFileSync(join(corrupt, 'team.sqlite'), 'owned invalid database bytes')
    await assert.rejects(createTeamService(config(corrupt)), /storage failed/)
    assert.equal(readFileSync(join(corrupt, 'team.sqlite'), 'utf8'), 'owned invalid database bytes')
  } finally { await service.close().catch(() => {}); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('trellis-team-store-fault-')); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})

test('blob corruption and failed backup preserve actual metadata and refuse false content', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-team-blob-fault-'))
  const dataDir = join(directory, 'store'); const service = await createTeamService(config(dataDir))
  try {
    const seeded = await seed(service)
    const bodyHash = hash(seeded.publication.text); const blob = join(dataDir, 'blobs', bodyHash)
    writeFileSync(blob, 'different bytes')
    await assert.rejects(service.store.call('document', { actor: seeded.actor, materialId: seeded.publication.materialId, version: 1 }), /digest failed/)
    const sameCommand = await service.store.call('publish', { actor: seeded.actor, body: seeded.publication }); assert.equal(sameCommand.status, 'duplicate')
    // The command receipt is historical metadata; no content read can claim the corrupt body.
    await assert.rejects(service.store.backup(join(directory, 'broken-backup')), /digest failed/)
    assert.equal(existsSync(join(directory, 'broken-backup/backup.json')), false)
    assert.equal(existsSync(join(dataDir, 'team.sqlite')), true)
  } finally { await service.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('trellis-team-blob-fault-')); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})

test('real directory junctions cannot redirect active blob reads or backup targets into protected source', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-team-junction-'))
  const dataDir = join(directory, 'store'); let service = await createTeamService(config(dataDir))
  try {
    const seeded = await seed(service)
    symlinkSync(dataDir, join(directory, 'source-link'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(service.store.backup(join(directory, 'source-link/not-a-backup')), /outside the active store/)
    assert.equal(existsSync(join(dataDir, 'not-a-backup')), false)
    await service.close()
    const outside = join(directory, 'owned-outside-blobs'); renameSync(join(dataDir, 'blobs'), outside)
    symlinkSync(outside, join(dataDir, 'blobs'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(createTeamService(config(dataDir)), /redirected filesystem path/)
    assert.equal(readFileSync(join(outside, hash(seeded.publication.text)), 'utf8'), seeded.publication.text)
  } finally { await service.close().catch(() => {}); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('trellis-team-junction-')); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})

test('HTTP JSON and immutable UTF8 limits are distinct and oversized writer requests are rejected before mutation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-team-bounds-'))
  const service = await createTeamService(config(join(directory, 'store')))
  try {
    const seeded = await seed(service)
    const tooLarge = { ...seeded.publication, commandId: randomUUID(), materialId: randomUUID(), text: '汉'.repeat(400_000) }
    await assert.rejects(service.store.call('publish', { actor: seeded.actor, body: tooLarge }), /one MiB UTF-8/)
    await assert.rejects(service.store.call('publish', { actor: seeded.actor, body: { ...tooLarge, text: 'x'.repeat(2 * 1024 * 1024) } }), /queue is full/)
    assert.equal((await service.store.call('document', { actor: seeded.actor, materialId: seeded.publication.materialId, version: 1 })).text, seeded.publication.text)
  } finally { await service.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('trellis-team-bounds-')); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})

test('portable configuration never downgrades a non-loopback public or identity endpoint to HTTP', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-team-config-'))
  try {
    await assert.rejects(createTeamService({ ...config(join(directory, 'a')), publicOrigin: 'http://company-owned.invalid', allowLoopbackHttp: true }), /HTTPS is required/)
    await assert.rejects(createTeamService({ ...config(join(directory, 'b')), oidc: { issuer: 'http://company-issuer.invalid', clientId: 'fixture' }, allowLoopbackHttp: true }), /HTTPS is required/)
    assert.equal(existsSync(join(directory, 'a/team.sqlite')), false); assert.equal(existsSync(join(directory, 'b/team.sqlite')), false)
  } finally { assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('trellis-team-config-')); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})

test('actual writer exit makes readiness fail without pretending the service process is healthy storage', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-team-writer-exit-'))
  const service = await createTeamService(config(join(directory, 'store')))
  try {
    await seed(service)
    assert.equal((await service.app.inject({ method: 'GET', url: '/ready' })).statusCode, 200)
    await service.store.worker.terminate()
    assert.equal((await service.app.inject({ method: 'GET', url: '/health' })).statusCode, 200)
    assert.equal((await service.app.inject({ method: 'GET', url: '/ready' })).statusCode, 503)
    assert.equal(existsSync(join(directory, 'store/team.sqlite')), true)
    assert.equal(existsSync(join(directory, 'store/service.lock')), true)
    await assert.rejects(createTeamService(config(join(directory, 'store'))), /owns this data directory|lock/)
  } finally { await service.close().catch(() => {}); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('trellis-team-writer-exit-')); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})

test('committed mutation followed by actual writer exit before acknowledgement stays explicitly unknown', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-team-ack-review-'))
  const dataDir = join(directory, 'store'); const service = await createTeamService(config(dataDir))
  try {
    const seeded = await seed(service); const commandId = randomUUID()
    const worker = service.store.worker; const emit = worker.emit.bind(worker)
    let committedReplyLost = false
    worker.emit = (event, ...args) => {
      const response = args[0]
      if (event === 'message' && response?.ok && response.value?.commandId === commandId) {
        committedReplyLost = true
        void worker.terminate() // Actual SQLite commit occurred; discard its IPC receipt.
        return true
      }
      return emit(event, ...args)
    }
    await assert.rejects(service.store.call('createTeam', { actor: seeded.actor, body: { commandId, name: 'Commit before actual writer exit' } }), (error) => error.code === 'ACKNOWLEDGEMENT_UNKNOWN')
    assert.equal(committedReplyLost, true)
    const db = new DatabaseSync(join(dataDir, 'team.sqlite'), { readOnly: true })
    try { assert.equal(db.prepare('SELECT COUNT(*) AS total FROM commands WHERE commandId=?').get(commandId).total, 1) }
    finally { db.close() }
    await assert.rejects(service.store.call('health', {}), (error) => error.code === 'STORE_UNAVAILABLE')
    assert.equal(existsSync(join(dataDir, 'service.lock')), true)
  } finally {
    await service.close().catch(() => {})
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('trellis-team-ack-review-'))
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('actual competing SQLite lock fills the bounded worker queue without losing pending requests or admitting a 65th', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-team-queue-review-'))
  const dataDir = join(directory, 'store'); const service = await createTeamService(config(dataDir))
  let lock
  const requests = []
  try {
    const seeded = await seed(service); const commandId = randomUUID()
    // The competing writer's COMMIT must wait for brief reads on the real worker.
    lock = new DatabaseSync(join(dataDir, 'team.sqlite')); lock.exec('PRAGMA busy_timeout=2000; BEGIN IMMEDIATE')
    requests.push(service.store.call('createTeam', { actor: seeded.actor, body: { commandId, name: 'Bounded queued mutation' } }))
    for (let index = 0; index < 63; index++) requests.push(service.store.call('health', {}))
    assert.equal(service.store.pending.size, 64)
    await assert.rejects(service.store.call('health', {}), (error) => error.code === 'CAPACITY_EXCEEDED')
    assert.equal(service.store.pending.size, 64)
    lock.exec('COMMIT'); lock.close(); lock = null
    const results = await Promise.all(requests); assert.equal(results[0].status, 'committed')
    assert.equal(service.store.pending.size, 0); assert.equal(service.store.pendingBytes, 0)
    assert.equal((await service.store.call('command', { actor: seeded.actor, commandId })).result.name, 'Bounded queued mutation')
  } finally {
    if (lock) { lock.exec('ROLLBACK'); lock.close() }
    // Releasing the competing lock lets every admitted request finish before the close request needs a queue slot.
    await Promise.allSettled(requests)
    try { await service.close() } catch (error) { await service.store.worker.terminate(); throw error }
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('trellis-team-queue-review-'))
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('a rejected close keeps admission fenced and permits a deliberate retry after the real writer queue drains', { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-team-close-retry-'))
  const service = await createTeamService(config(join(directory, 'store'))), requests = []
  try {
    for (let index = 0; index < 64; index++) requests.push(service.store.call('health', {}))
    assert.equal(service.store.pending.size, 64)
    const closing = service.store.close(), joined = service.store.close()
    await Promise.all([closing, joined].map((attempt) => assert.rejects(attempt, (error) => error.code === 'CAPACITY_EXCEEDED')))
    await Promise.all(requests)
    assert.equal(service.store.pending.size, 0); assert.equal(service.store.pendingBytes, 0)
    await assert.rejects(service.store.call('health', {}), (error) => error.code === 'STORE_UNAVAILABLE')
    const beforeClose = service.store.nextId
    await Promise.all([service.store.close(), service.store.close()])
    assert.equal(service.store.worker.threadId, -1)
    assert.equal(service.store.nextId, beforeClose + 1, 'concurrent retries must send only one close request')
    assert.equal(service.store.pending.size, 0); assert.equal(service.store.pendingBytes, 0)
    assert.equal(existsSync(join(directory, 'store/service.lock')), false)
    await service.store.close()
    assert.equal(service.store.nextId, beforeClose + 1)
  } finally {
    await Promise.allSettled(requests)
    try { await service.close() } finally {
      if (service.store.worker.threadId !== -1) await service.store.worker.terminate()
      assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('trellis-team-close-retry-'))
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createFixture, database } from './task-conversations-data.mjs'

export async function exerciseCodexRoles(Service, base) {
  let checks = 0
  const check = (condition, message) => { assert.ok(condition, message); checks++ }
  const f = createFixture(join(base, 'roles'))
  const fieldChild = randomUUID(), jsonChild = randomUUID(), conflictingChild = randomUUID(), malformed = randomUUID()
  const jsonParent = JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: f.codexId } } })
  database(f.codexFile, 'ALTER TABLE threads ADD COLUMN thread_source TEXT; ALTER TABLE threads ADD COLUMN source TEXT; ALTER TABLE threads ADD COLUMN has_user_event INTEGER', db => {
    db.prepare('UPDATE threads SET thread_source=?,source=?,has_user_event=0,title=? WHERE id=?')
      .run('user', '"cli"', 'subagent and worker words do not classify this title', f.codexId)
    db.prepare('UPDATE threads SET thread_source=NULL,source=NULL,has_user_event=1 WHERE id=?').run(f.codexOther)
    const insert = db.prepare('INSERT INTO threads(id,cwd,title,updated_at_ms,source) VALUES(?,?,?,?,?)')
    insert.run(fieldChild, f.root, 'Saved child A', 1800000000100, null)
    insert.run(jsonChild, f.root, 'Saved child B', 1800000000200, null)
    insert.run(conflictingChild, f.root, 'New child', 1800000000300, null)
    insert.run(malformed, f.root, 'Unspecified malformed source', 1800000000400, '{malformed-json')
  })
  let service = new Service(f.options)
  try {
    // Save associations before native role metadata is populated, as in an older index.
    const oldCandidates = await service.discover(f.root)
    const childA = oldCandidates.items.find(item => item.sessionId === fieldChild)
    const childB = oldCandidates.items.find(item => item.sessionId === jsonChild)
    check(childA.role === 'unknown' && childB.role === 'unknown', 'unspecified roles remain unknown')
    await service.bind(f.root, 'task-a', childA.id)
    let snapshot = await service.bind(f.root, 'task-a', childB.id)
    const savedA = snapshot.bindings.find(item => item.conversation.sessionId === fieldChild)
    const savedB = snapshot.bindings.find(item => item.conversation.sessionId === jsonChild)
    await service.setPrimary(f.root, 'task-a', savedA.id)
    service.close()
    database(f.codexFile, null, db => {
      db.prepare('UPDATE threads SET thread_source=?,source=? WHERE id=?').run('subagent', '"cli"', fieldChild)
      db.prepare('UPDATE threads SET thread_source=NULL,source=? WHERE id=?').run(jsonParent, jsonChild)
      db.prepare('UPDATE threads SET thread_source=?,source=? WHERE id=?').run('user', jsonParent, conflictingChild)
    })
    f.runtimeRecord('field-child.json', { platform: 'codex', session_id: fieldChild, current_task: '.trellis/tasks/task-b' })
    f.runtimeRecord('json-child.json', { platform: 'codex', session_id: jsonChild, current_task: '.trellis/tasks/task-b' })
    f.runtimeRecord('new-child.json', { platform: 'codex', session_id: conflictingChild, current_task: '.trellis/tasks/task-b' })
    f.runtimeRecord('parent.json', { platform: 'codex', session_id: f.codexId, current_task: '.trellis/tasks/task-a' })
    f.runtimeRecord('unknown.json', { platform: 'codex', session_id: f.codexOther, current_task: '.trellis/tasks/task-b' })
    service = new Service(f.options)
    const candidates = await service.discover(f.root)
    const codex = candidates.items.filter(item => item.source === 'codex')
    check(codex.length === 3, 'default discovery contains user and unspecified sessions only')
    check(codex.find(item => item.sessionId === f.codexId)?.role === 'user', 'native user role is retained when has_user_event is zero')
    check(codex.find(item => item.sessionId === f.codexOther)?.role === 'unknown', 'has_user_event one never promotes unspecified role to user')
    check(codex.find(item => item.sessionId === malformed)?.role === 'unknown', 'malformed source JSON stays unknown without losing other sources')
    check(!codex.some(item => [fieldChild, jsonChild, conflictingChild].includes(item.sessionId)), 'both native role fields exclude explicit subagents, including conflicting user labels')
    await assert.rejects(() => service.bind(f.root, 'task-b', childA.id), error => error.code === 'E_NOT_FOUND'); checks++
    snapshot = await service.list(f.root)
    check(snapshot.bindings.length === 4, 'requested old children are retained while automatic child imports are skipped')
    check(snapshot.bindings.filter(item => item.taskDir === 'task-b').every(item => item.conversation.sessionId === f.codexOther), 'runtime import separately skips children read to validate saved associations')
    const retainedA = snapshot.bindings.find(item => item.id === savedA.id)
    const retainedB = snapshot.bindings.find(item => item.id === savedB.id)
    check(retainedA?.conversation.role === 'subagent' && retainedA.conversation.capability === 'session' && retainedA.primary, 'manual child primary survives refresh/restart and parent runtime import')
    check(retainedB?.conversation.role === 'subagent' && retainedB.conversation.parentSessionId === f.codexId, 'requested JSON-child read retains explicit parent metadata')
    check(retainedA.conversation.id === childA.id && retainedB.conversation.id === childB.id, 'role changes never change opaque candidate identity or rebind a child to a parent')
    check(snapshot.bindings.find(item => item.conversation.sessionId === f.codexId)?.origin === 'runtime', 'verified parent runtime import remains supported')
    await service.open(f.root, 'task-a', savedA.id)
    check(f.calls.pop()?.url === `codex://threads/${fieldChild}`, 'stored field-child opens its own exact native ID')
    await service.open(f.root, 'task-a', savedB.id)
    check(f.calls.pop()?.url === `codex://threads/${jsonChild}`, 'stored JSON-child opens its own exact native ID rather than its parent')
    database(f.codexFile, null, db => db.prepare('UPDATE threads SET name=? WHERE id=?').run('Renamed saved child', jsonChild))
    snapshot = await service.list(f.root)
    check(snapshot.bindings.find(item => item.id === savedB.id)?.conversation.title === 'Renamed saved child', 'saved child title still refreshes from requested-ID native reads')
    database(f.codexFile, null, db => db.prepare('UPDATE threads SET cwd=? WHERE id=?').run(f.foreign, jsonChild))
    await assert.rejects(() => service.open(f.root, 'task-a', savedB.id), error => error.code === 'E_NOT_FOUND'); checks++
    check(f.calls.length === 0, 'saved child ownership mismatch never launches a replacement parent')
    // A worker-heavy index cannot use the default page budget to hide a real user parent.
    database(f.codexFile, null, db => {
      db.exec('BEGIN')
      const insert = db.prepare('INSERT INTO threads(id,cwd,title,updated_at_ms,thread_source,source) VALUES(?,?,?,?,?,?)')
      for (let i = 0; i < 510; i++) insert.run(randomUUID(), f.root, 'worker', 1900000000000 + i, 'subagent', jsonParent)
      db.exec('COMMIT')
    })
    const busy = await service.discover(f.root)
    check(busy.items.some(item => item.sessionId === f.codexId) && !busy.truncated, 'explicit child filtering occurs before the bounded discovery LIMIT')
    check(!busy.items.some(item => item.role === 'subagent'), 'default discovery remains child-free in a worker-heavy index')
  } finally { service.close() }
  {
    const legacy = createFixture(join(base, 'older-schema'))
    const reader = new Service(legacy.options)
    try {
      const result = await reader.discover(legacy.root)
      check(result.items.filter(item => item.source === 'codex').every(item => item.role === 'unknown'), 'old schemas without role fields remain discoverable and explicitly unknown')
    } finally { reader.close() }
  }
  return checks
}

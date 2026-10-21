import assert from 'node:assert/strict'
import { existsSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createFixture, database } from './task-conversations-data.mjs'

/** Identity changes and native path boundaries use disposable projects only. */
export async function exerciseIntegrity(Service, base) {
  let checks = 0
  const check = (value, message) => { assert.ok(value, message); checks++ }
  const archivedDir = 'archive/2026-10/task-a'
  const moveAndReuse = (f) => {
    const archive = join(f.root, '.trellis', 'tasks', archivedDir)
    mkdirSync(dirname(archive), { recursive: true })
    renameSync(join(f.root, '.trellis', 'tasks', 'task-a'), archive)
    f.task('task-a', 'different-replacement-task')
  }
  {
    const f = createFixture(join(base, 'unlink-path-reuse'))
    let service = new Service(f.options)
    try {
      f.runtimeRecord('live.json', { platform: 'codex', session_id: f.codexId, current_task: '.trellis/tasks/task-a', cwd: f.root })
      const binding = (await service.list(f.root)).bindings[0]
      await service.unbind(f.root, 'task-a', binding.id)
      moveAndReuse(f)
      f.runtimeRecord('live.json', { platform: 'codex', session_id: f.codexId, current_task: `.trellis/tasks/${archivedDir}`, cwd: f.root })
      check((await service.list(f.root)).bindings.length === 0, 'directory reuse cannot bypass an existing unlink tombstone')
      service.close()
      service = new Service(f.options)
      check((await service.list(f.root)).bindings.length === 0, 'suppression survives restart while historical ownership remains unresolved')
      const candidate = (await service.discover(f.root)).items.find(item => item.sessionId === f.codexId)
      const rebound = await service.bind(f.root, archivedDir, candidate.id)
      check(rebound.bindings.length === 1 && rebound.bindings[0].origin === 'manual', 'an explicit rebind can resolve the archived relationship')
    } finally { service.close() }
  }
  {
    const f = createFixture(join(base, 'primary-path-reuse'))
    const service = new Service(f.options)
    try {
      const candidate = (await service.discover(f.root)).items.find(item => item.sessionId === f.codexId)
      const manual = (await service.bind(f.root, 'task-a', candidate.id)).bindings[0]
      moveAndReuse(f)
      f.runtimeRecord('live.json', { platform: 'codex', session_id: f.codexOther, current_task: `.trellis/tasks/${archivedDir}`, cwd: f.root })
      const snapshot = await service.list(f.root)
      check(snapshot.bindings.length === 1 && snapshot.bindings[0].id === manual.id && snapshot.bindings[0].primary,
        'unresolved archive identity does not acquire a new runtime primary')
      const replacement = await service.bind(f.root, 'task-a', candidate.id)
      check(replacement.bindings.find(item => item.id === manual.id).currentTaskRef === null,
        'orphan relationship retains history but exposes no current ownership at a reused directory')
      check(replacement.bindings.some(item => item.taskRef === 'task:different-replacement-task' && item.currentTaskRef === item.taskRef),
        'new task at the same directory exposes its own authoritative current identity')
    } finally { service.close() }
  }
  {
    const f = createFixture(join(base, 'large-task-identity'))
    writeFileSync(join(f.root, '.trellis', 'tasks', 'task-a', 'task.json'), JSON.stringify({ id: 'large-file-visible-id', title: 'large metadata', description: 'x'.repeat(270000) }))
    const service = new Service(f.options)
    try {
      const candidate = (await service.discover(f.root)).items.find(item => item.sessionId === f.codexId)
      const binding = (await service.bind(f.root, 'task-a', candidate.id)).bindings[0]
      check(binding.taskRef === 'dir:.trellis/tasks/task-a' && binding.currentTaskRef === binding.taskRef,
        'authoritative projection preserves directory-only identity when task JSON exceeds identity read budget')
    } finally { service.close() }
  }
  {
    const f = createFixture(join(base, 'changed-task-during-read'))
    f.runtimeRecord('live.json', { platform: 'codex', session_id: f.codexId, current_task: '.trellis/tasks/task-a', cwd: f.root })
    const service = new Service(f.options)
    try {
      f.setOnCapability(async () => { f.task('task-a', 'replacement-seen-during-native-read') })
      const snapshot = await service.list(f.root)
      check(snapshot.bindings.length === 1 && snapshot.bindings[0].taskRef === 'task:replacement-seen-during-native-read',
        'runtime imports use task identity re-read after asynchronous native preflight')
    } finally { service.close() }
  }
  {
    const f = createFixture(join(base, 'control-directory-junction'))
    const target = join(f.base, 'outside-project')
    mkdirSync(target)
    symlinkSync(target, join(f.root, '.trellis', '.panel'), process.platform === 'win32' ? 'junction' : 'dir')
    const service = new Service(f.options)
    try {
      await assert.rejects(() => service.list(f.root), error => error.code === 'E_UNAVAILABLE'); checks++
      check(!existsSync(join(target, 'runtime')), 'reject foreign control-directory ancestors before creating any directory')
    } finally { service.close() }
  }
  {
    const f = createFixture(join(base, 'cwd-junction-before-launch'))
    const original = join(f.root, 'original-cwd')
    const replacement = join(f.root, 'replacement-cwd')
    mkdirSync(original); mkdirSync(replacement)
    database(f.codexFile, null, db => db.prepare('UPDATE threads SET cwd=? WHERE id=?').run(original, f.codexId))
    const service = new Service(f.options)
    try {
      const candidate = (await service.discover(f.root)).items.find(item => item.sessionId === f.codexId)
      const binding = (await service.bind(f.root, 'task-a', candidate.id)).bindings[0]
      let changed = false
      const isCurrent = () => {
        if (!changed) {
          changed = true
          renameSync(original, join(f.root, 'prior-cwd'))
          symlinkSync(replacement, original, process.platform === 'win32' ? 'junction' : 'dir')
        }
        return true
      }
      await assert.rejects(() => service.open(f.root, 'task-a', binding.id, isCurrent), error => error.code === 'E_NOT_FOUND'); checks++
      check(f.calls.length === 0, 'final cwd verification rejects an in-project junction retarget without a native launch')
    } finally { service.close() }
  }
  return checks
}

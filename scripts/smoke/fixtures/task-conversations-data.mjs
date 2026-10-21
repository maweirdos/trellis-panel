import { DatabaseSync } from 'node:sqlite'
import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export function database(file, sql, run) {
  const db = new DatabaseSync(file)
  try { if (sql) db.exec(sql); return run?.(db) } finally { db.close() }
}
export function createFixture(base) {
  const root = join(base, 'project 中文 & dollar $ with spaces')
  const foreign = join(base, 'foreign')
  const roots = { codex: join(base, 'codex'), 'claude-code': join(base, 'claude'), zcode: join(base, 'zcode') }
  for (const dir of [root, foreign, ...Object.values(roots)]) mkdirSync(dir, { recursive: true })
  const task = (name, id) => {
    const directory = join(root, '.trellis', 'tasks', name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'task.json'), JSON.stringify({ id, status: 'in_progress', title: name }))
    return directory
  }
  const codexId = randomUUID(), codexOther = randomUUID(), claudeId = randomUUID(), zcodeId = randomUUID()
  const codexFile = join(roots.codex, 'state_5.sqlite')
  const zcodeFile = join(roots.zcode, 'tasks-index.sqlite')
  database(codexFile, 'CREATE TABLE threads(id TEXT PRIMARY KEY,cwd TEXT,title TEXT,name TEXT,updated_at INTEGER,updated_at_ms INTEGER)', db => {
    const insert = db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)')
    insert.run(codexId, process.platform === 'win32' ? `\\\\?\\${root}` : root, 'Original Codex title', null, 1700000000, 1700000000123)
    insert.run(codexOther, process.platform === 'win32' ? root.toUpperCase().replace(/\\/g, '/') + '/' : root, 'Second Codex', null, 1700000001, 1700000001123)
    insert.run(randomUUID(), foreign, 'Foreign secret title', null, 1700000002, 1700000002123)
    insert.run('new', root, 'Not a technical thread ID', null, 1700000003, 1700000003123)
  })
  database(zcodeFile, 'CREATE TABLE tasks(task_id TEXT,workspace_path TEXT,title TEXT,updated_at INTEGER,deleted INTEGER,acp_session_id TEXT)', db => {
    db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run(zcodeId, root, 'Real ZCode task title', 1700000000123, 0, 'not-the-native-id')
    db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run(randomUUID(), root, 'Deleted ZCode', 1700000000123, 1, null)
  })
  const partition = join(roots['claude-code'], 'projects', resolve(root).replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(partition, { recursive: true })
  const claudeFile = join(partition, `${claudeId}.jsonl`)
  writeFileSync(claudeFile, [
    { type: 'mode', sessionId: claudeId },
    { type: 'system', sessionId: claudeId, cwd: root, timestamp: '2026-10-20T00:00:00Z' },
    { type: 'summary', summary: 'Native summary' },
    { type: 'custom-title', sessionId: claudeId, customTitle: 'Named Claude session' }
  ].map(item => JSON.stringify(item)).join('\n') + '\n')
  const foreignId = randomUUID()
  writeFileSync(join(partition, `${foreignId}.jsonl`), JSON.stringify({ type: 'system', cwd: foreign, sessionId: foreignId }))
  const runtime = join(root, '.trellis', '.runtime', 'sessions')
  mkdirSync(runtime, { recursive: true })
  const runtimeRecord = (name, value) => writeFileSync(join(runtime, name), JSON.stringify(value))
  const calls = []
  const capabilities = new Map()
  let onCapability
  const launch = {
    async capability(source) {
      await onCapability?.(source)
      return capabilities.get(source) ?? { available: true, executable: join(base, 'native', 'claude.exe') }
    },
    async launch(target) { calls.push(target) }
  }
  task('task-a', 'stable-task-a'); task('task-b', 'stable-task-b')
  return { base, root, foreign, roots, task, codexId, codexOther, claudeId, zcodeId, codexFile, zcodeFile,
    claudeFile, partition, runtime, runtimeRecord, calls, capabilities, launch, setOnCapability(fn) { onCapability = fn },
    options: { nativeRoots: roots, launch },
    digest() { return [codexFile, zcodeFile, claudeFile].map(file => createHash('sha256').update(readFileSync(file)).digest('hex')) }
  }
}

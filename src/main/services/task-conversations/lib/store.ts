import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync, existsSync, lstatSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { externalConversationSchema, type ExternalConversation, type TaskConversationBinding } from '../../../../shared/task-conversations'
import { CONTROL_SCHEMA_V1_DDL, STORE_DB_VERSION } from '../../observability/store-core'
import { runtimeDirOf, taskRefFor, type KnownTaskDir } from '../../task-identity'
import { aliasTarget, sameTask, type TaskOwner } from './identity'
import { TaskConversationError } from '../types'
import { inside, ownedPath } from './paths'

const DDL = `
CREATE TABLE IF NOT EXISTS task_conversation_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS task_conversation_owners(
  ownerKey TEXT PRIMARY KEY, taskRef TEXT NOT NULL, trellisId TEXT, currentDir TEXT NOT NULL,
  priorDirsJson TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS task_conversation_links(
  id TEXT PRIMARY KEY, ownerKey TEXT NOT NULL, source TEXT NOT NULL, sessionId TEXT NOT NULL,
  conversationJson TEXT NOT NULL, primaryFlag INTEGER NOT NULL, linkedAt INTEGER NOT NULL,
  origin TEXT NOT NULL, UNIQUE(ownerKey,source,sessionId));
CREATE UNIQUE INDEX IF NOT EXISTS task_conversation_primary ON task_conversation_links(ownerKey) WHERE primaryFlag=1;
CREATE TABLE IF NOT EXISTS task_conversation_ignored(ownerKey TEXT NOT NULL, source TEXT NOT NULL,
  sessionId TEXT NOT NULL, PRIMARY KEY(ownerKey,source,sessionId));`
type Link = { id: string; ownerKey: string; source: string; sessionId: string; conversationJson: string; primaryFlag: number; linkedAt: number; origin: 'manual' | 'runtime' }
type OwnerRow = { ownerKey: string; taskRef: string; trellisId: string | null; currentDir: string; priorDirsJson: string }
export type StoredBinding = { owner: TaskOwner; binding: Omit<TaskConversationBinding, 'taskDir' | 'taskRef' | 'currentTaskRef'> }

export class ConversationStore {
  private readonly db: DatabaseSync
  constructor(root: string) {
    const directory = runtimeDirOf(root)
    let ancestor = directory
    while (!lstatSync(ancestor, { throwIfNoEntry: false })) ancestor = dirname(ancestor)
    // Validate existing junctions/ancestors before mkdir can write outside the project.
    ownedPath(root, ancestor)
    mkdirSync(directory, { recursive: true })
    if (!inside(root, realpathSync(directory))) throw new TaskConversationError('E_CONFLICT', '控制库目录不属于当前项目')
    const path = join(directory, 'control.sqlite')
    if (existsSync(path)) ownedPath(root, path)
    this.db = new DatabaseSync(path)
    try {
      this.db.exec('PRAGMA busy_timeout=50;')
      const base = this.version('control_schema_meta', 'dbVersion')
      const own = this.version('task_conversation_meta', 'schemaVersion')
      if (base > STORE_DB_VERSION || own > 1) throw new TaskConversationError('E_UNAVAILABLE', '控制库由更新版本创建，拒绝写入')
      if (String(this.db.prepare('PRAGMA journal_mode').get()?.journal_mode).toLowerCase() !== 'delete') {
        throw new TaskConversationError('E_UNAVAILABLE', '控制库日志模式不兼容')
      }
      this.db.exec('PRAGMA synchronous=FULL;')
      this.transaction(() => {
        if (base < STORE_DB_VERSION) {
          this.db.exec(CONTROL_SCHEMA_V1_DDL)
          this.db.prepare("INSERT OR REPLACE INTO control_schema_meta(key,value) VALUES('dbVersion',?)").run(String(STORE_DB_VERSION))
        }
        this.db.exec(DDL)
        this.db.prepare("INSERT OR REPLACE INTO task_conversation_meta(key,value) VALUES('schemaVersion','1')").run()
      })
    } catch (error) { this.db.close(); throw error }
  }
  private version(table: 'control_schema_meta' | 'task_conversation_meta', key: string): number {
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) return 0
    const row = this.db.prepare(`SELECT value FROM ${table} WHERE key=?`).get(key)
    const version = Number(row?.value ?? 0)
    if (!Number.isSafeInteger(version) || version < 0) throw new TaskConversationError('E_UNAVAILABLE', '控制库版本无效')
    return version
  }
  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = run(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  owners(): TaskOwner[] {
    return (this.db.prepare('SELECT * FROM task_conversation_owners').all() as OwnerRow[]).map(row => ({
      key: row.ownerKey, taskRef: row.taskRef, trellisId: row.trellisId,
      currentDir: row.currentDir, priorDirs: JSON.parse(row.priorDirsJson) as string[]
    }))
  }
  reconcile(known: KnownTaskDir[]): void {
    const owners = this.owners()
    this.transaction(() => {
      for (const owner of owners) {
        const target = aliasTarget(owner, owners, known)
        if (!target) continue
        this.db.prepare('UPDATE task_conversation_owners SET currentDir=?,priorDirsJson=? WHERE ownerKey=?')
          .run(target.dir, JSON.stringify([...owner.priorDirs, owner.currentDir]), owner.key)
      }
    })
  }
  owner(task: KnownTaskDir): TaskOwner {
    const existing = this.owners().find(owner => sameTask(owner, task))
    if (existing) return existing
    const owner: TaskOwner = { key: randomUUID(), taskRef: taskRefFor(task.trellisTaskId, task.dir), trellisId: task.trellisTaskId, currentDir: task.dir, priorDirs: [] }
    this.db.prepare('INSERT INTO task_conversation_owners(ownerKey,taskRef,trellisId,currentDir,priorDirsJson) VALUES(?,?,?,?,?)')
      .run(owner.key, owner.taskRef, owner.trellisId, owner.currentDir, '[]')
    return owner
  }
  bindings(): StoredBinding[] {
    const owners = this.owners()
    const links = this.db.prepare('SELECT * FROM task_conversation_links ORDER BY linkedAt,id').all() as Link[]
    return links.flatMap(row => {
      const owner = owners.find(item => item.key === row.ownerKey)
      if (!owner) throw new TaskConversationError('E_UNAVAILABLE', '会话关联缺少任务身份')
      return [{ owner, binding: { id: row.id, conversation: externalConversationSchema.parse(JSON.parse(row.conversationJson)), primary: row.primaryFlag === 1, linkedAt: row.linkedAt, origin: row.origin } }]
    })
  }
  bind(owner: TaskOwner, conversation: ExternalConversation, origin: 'manual' | 'runtime', now: number): void {
    this.transaction(() => {
      if (origin === 'runtime' && this.db.prepare('SELECT 1 FROM task_conversation_ignored WHERE ownerKey=? AND source=? AND sessionId=?').get(owner.key, conversation.source, conversation.sessionId)) return
      const existing = this.db.prepare('SELECT id FROM task_conversation_links WHERE ownerKey=? AND source=? AND sessionId=?').get(owner.key, conversation.source, conversation.sessionId)
      const id = typeof existing?.id === 'string' ? existing.id : randomUUID()
      const hasPrimary = this.db.prepare('SELECT 1 FROM task_conversation_links WHERE ownerKey=? AND primaryFlag=1').get(owner.key)
      const primary = origin === 'manual' || !hasPrimary
      if (primary) this.db.prepare('UPDATE task_conversation_links SET primaryFlag=0 WHERE ownerKey=?').run(owner.key)
      if (!existing) this.db.prepare('INSERT INTO task_conversation_links VALUES(?,?,?,?,?,?,?,?)')
        .run(id, owner.key, conversation.source, conversation.sessionId, JSON.stringify(conversation), Number(primary), now, origin)
      else if (origin === 'manual') this.db.prepare("UPDATE task_conversation_links SET primaryFlag=1,origin='manual',conversationJson=? WHERE id=?").run(JSON.stringify(conversation), id)
      // Existing runtime links must retain their previous primary flag after a repeat import.
      else if (primary) this.db.prepare('UPDATE task_conversation_links SET primaryFlag=1 WHERE id=?').run(id)
      this.db.prepare('DELETE FROM task_conversation_ignored WHERE ownerKey=? AND source=? AND sessionId=? AND ?=1').run(owner.key, conversation.source, conversation.sessionId, Number(origin === 'manual'))
    })
  }
  refresh(updates: { id: string; conversation: ExternalConversation }[]): void {
    if (updates.length === 0) return
    this.transaction(() => {
      const update = this.db.prepare('UPDATE task_conversation_links SET conversationJson=? WHERE id=?')
      for (const item of updates) update.run(JSON.stringify(item.conversation), item.id)
    })
  }
  setPrimary(owner: TaskOwner, id: string): void {
    this.requireLink(owner, id)
    this.transaction(() => {
      this.db.prepare('UPDATE task_conversation_links SET primaryFlag=0 WHERE ownerKey=?').run(owner.key)
      this.db.prepare('UPDATE task_conversation_links SET primaryFlag=1 WHERE id=? AND ownerKey=?').run(id, owner.key)
    })
  }
  unbind(owner: TaskOwner, id: string): void {
    const link = this.requireLink(owner, id)
    this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO task_conversation_ignored VALUES(?,?,?)').run(owner.key, link.source, link.sessionId)
      this.db.prepare('DELETE FROM task_conversation_links WHERE ownerKey=? AND id=?').run(owner.key, id)
      if (link.primaryFlag) {
        const next = this.db.prepare("SELECT id FROM task_conversation_links WHERE ownerKey=? ORDER BY origin='manual' DESC,linkedAt DESC,id LIMIT 1").get(owner.key)
        if (next) this.db.prepare('UPDATE task_conversation_links SET primaryFlag=1 WHERE id=?').run(next.id)
      }
    })
  }
  private requireLink(owner: TaskOwner, id: string): Link {
    const row = this.db.prepare('SELECT * FROM task_conversation_links WHERE ownerKey=? AND id=?').get(owner.key, id) as Link | undefined
    if (!row) throw new TaskConversationError('E_NOT_FOUND', '会话关联不存在或不属于该任务')
    return row
  }
  close(): void { this.db.close() }
}

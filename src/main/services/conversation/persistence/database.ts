import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { CONVERSATION_DDL, CONVERSATION_SCHEMA_VERSION } from './schema'

export interface ConversationDatabase extends DatabaseSync {}

export function openConversationDatabase(directory: string): DatabaseSync {
  const resolved = join(directory, 'conversation-v2')
  mkdirSync(resolved, { recursive: true })
  const database = new DatabaseSync(join(resolved, 'conversation.sqlite'))
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA foreign_keys = ON')
  database.exec('PRAGMA busy_timeout = 5000')
  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec('CREATE TABLE IF NOT EXISTS conversation_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
    const version = database.prepare("SELECT value FROM conversation_meta WHERE key = 'schema_version'").get() as { value: string } | undefined
    if (version && Number(version.value) !== 1 && Number(version.value) !== CONVERSATION_SCHEMA_VERSION) {
      throw new Error(`Conversation database schema ${version.value} is unsupported; expected ${CONVERSATION_SCHEMA_VERSION}.`)
    }
    database.exec(CONVERSATION_DDL)
    const bindingColumns = database.prepare('PRAGMA table_info(conversation_v2_native_bindings)').all()
    if (!bindingColumns.some(column => column.name === 'configuration_fingerprint')) {
      database.exec('ALTER TABLE conversation_v2_native_bindings ADD COLUMN configuration_fingerprint TEXT')
    }
    const threadColumns = database.prepare('PRAGMA table_info(conversation_v2_projection_threads)').all()
    if (!threadColumns.some(column => column.name === 'last_visited_sequence')) {
      database.exec('ALTER TABLE conversation_v2_projection_threads ADD COLUMN last_visited_sequence INTEGER NOT NULL DEFAULT 0')
    }
    if (!threadColumns.some(column => column.name === 'title_source')) {
      database.exec("ALTER TABLE conversation_v2_projection_threads ADD COLUMN title_source TEXT NOT NULL DEFAULT 'placeholder'")
    }
    if (!threadColumns.some(column => column.name === 'snoozed_until')) {
      database.exec('ALTER TABLE conversation_v2_projection_threads ADD COLUMN snoozed_until TEXT')
    }
    try {
      database.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS conversation_v2_message_fts USING fts5(
        thread_id UNINDEXED,
        message_id UNINDEXED,
        role UNINDEXED,
        title,
        body,
        tokenize='unicode61'
      )`)
    } catch {
      // 如果宿主机 SQLite 未编入 FTS5 扩展，搜索服务会自动退化到作用域子串索引。
    }
    database.prepare("INSERT INTO conversation_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(CONVERSATION_SCHEMA_VERSION))
    database.prepare("INSERT OR IGNORE INTO conversation_meta (key, value) VALUES ('storage_id', ?)").run(randomUUID())
    database.exec('COMMIT')
    return database
  } catch (error) {
    database.exec('ROLLBACK')
    database.close()
    throw error
  }
}

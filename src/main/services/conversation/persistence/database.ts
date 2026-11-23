import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { CONVERSATION_DDL, CONVERSATION_SCHEMA_VERSION } from './schema'

export interface ConversationDatabase extends DatabaseSync {}

export function openConversationDatabase(directory: string): DatabaseSync {
  const resolved = join(directory, 'conversation-v2')
  mkdirSync(resolved, { recursive: true })
  const database = new DatabaseSync(join(resolved, 'conversation.sqlite'))
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA foreign_keys = ON')
  database.exec('PRAGMA busy_timeout = 5000')
  database.exec(CONVERSATION_DDL)
  const version = database.prepare('SELECT value FROM conversation_meta WHERE key = ?').get('schema_version') as { value: string } | undefined
  if (!version) database.prepare('INSERT INTO conversation_meta (key, value) VALUES (?, ?)').run('schema_version', String(CONVERSATION_SCHEMA_VERSION))
  else if (Number(version.value) !== CONVERSATION_SCHEMA_VERSION) throw new Error(`Conversation database schema ${version.value} is unsupported; expected ${CONVERSATION_SCHEMA_VERSION}.`)
  return database
}

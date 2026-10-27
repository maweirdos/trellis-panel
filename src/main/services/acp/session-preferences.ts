/** Human metadata has one authority, independent of native records and SQLite health.
 * This module is shared with the history worker; keep it free of Electron imports. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import type { AcpSessionMeta } from '../../../shared/types'
import { acpHistoryUpdateInputSchema, type AcpHistorySummary, type AcpTitleProvenance } from '../../../shared/acp-history'
import { readHistoryDeletion } from './history-deletion'

const preferenceSchema = z.object({
  customTitle: z.string().min(1).max(200).refine((value) => value === value.trim()).optional(),
  automaticTitle: z.string().min(1).max(200).optional(),
  titleProvenance: z.object({ source: z.enum(['manual', 'generated', 'fallback']), revision: z.string(), state: z.enum(['pending', 'ready', 'failed']),
    sourceDigest: z.string().optional(), model: z.string().optional(), generatedAt: z.number().optional(), error: z.string().optional() }).strict().optional(),
  pinnedAt: z.number().int().positive().safe().optional(),
  archivedAt: z.number().int().positive().safe().optional()
}).strict()
const envelopeSchema = z.object({
  schemaVersion: z.literal(1), projectRoot: z.string(), revision: z.string().min(1),
  sessions: z.record(z.string().min(1).max(200).regex(/^[\w.-]+$/), preferenceSchema)
}).strict()
export type SessionPreferences = z.infer<typeof envelopeSchema>

function canonicalRoot(root: string): string {
  let value: string
  try { value = realpathSync(resolve(root)) } catch { value = resolve(root) }
  return process.platform === 'win32' ? value.replace(/[\\/]+$/, '').toLowerCase() : value
}
export function sessionPreferencesPath(directory: string, root: string): string {
  return join(directory, 'session-preferences', `${createHash('sha256').update(canonicalRoot(root)).digest('hex')}.json`)
}
export function readSessionPreferences(directory: string, root: string): SessionPreferences {
  const projectRoot = canonicalRoot(root)
  let bytes: string
  try { bytes = readFileSync(sessionPreferencesPath(directory, root), 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, projectRoot, revision: 'missing', sessions: {} }
    throw error
  }
  // Unsupported or damaged files must fail without replacing the original bytes.
  const value = envelopeSchema.parse(JSON.parse(bytes))
  if (value.projectRoot !== projectRoot) throw new Error('Conversation preferences belong to another project; original file retained')
  return value
}
export function updateSessionPreferences(directory: string, root: string, sessionId: string, input: unknown): SessionPreferences {
  const patch = acpHistoryUpdateInputSchema.parse(input)
  z.string().min(1).max(200).regex(/^[\w.-]+$/).parse(sessionId)
  const previous = readSessionPreferences(directory, root)
  const old = Object.hasOwn(previous.sessions, sessionId) ? previous.sessions[sessionId] : undefined
  const next = { ...old }
  if (readHistoryDeletion(directory, root, sessionId)) throw new Error('此会话已进入永久删除，请完成清理')
  if (patch.title !== undefined) { next.customTitle = patch.title; next.titleProvenance = { source: 'manual', state: 'ready', revision: randomUUID() } }
  if (patch.pinned !== undefined) next.pinnedAt = patch.pinned ? old?.pinnedAt ?? Date.now() : undefined
  if (patch.archived !== undefined) next.archivedAt = patch.archived ? old?.archivedAt ?? Date.now() : undefined
  const value = { ...previous, revision: randomUUID(), sessions: { ...previous.sessions, [sessionId]: next } }
  writePreferences(directory, root, value)
  return value
}
function writePreferences(directory: string, root: string, value: SessionPreferences): void {
  const path = sessionPreferencesPath(directory, root)
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' })
  renameSync(temp, path)
}
/** Per-session CAS: unrelated pin/archive edits do not discard a title, human renames always do. */
export function compareAndSetSessionTitle(directory: string, root: string, sessionId: string, expected: string | undefined,
  title: string | undefined, provenance: AcpTitleProvenance): boolean {
  if (readHistoryDeletion(directory, root, sessionId)) return false
  const previous = readSessionPreferences(directory, root)
  const old = Object.hasOwn(previous.sessions, sessionId) ? previous.sessions[sessionId] : undefined
  if (old?.customTitle || old?.titleProvenance?.revision !== expected) return false
  const next = preferenceSchema.parse({ ...old, ...(title ? { automaticTitle: title } : {}), titleProvenance: provenance })
  writePreferences(directory, root, { ...previous, revision: randomUUID(), sessions: { ...previous.sessions, [sessionId]: next } })
  return true
}
export function removeSessionPreferences(directory: string, root: string, sessionId: string): void {
  const previous = readSessionPreferences(directory, root)
  if (!Object.hasOwn(previous.sessions, sessionId)) return
  const sessions = { ...previous.sessions }
  delete sessions[sessionId]
  writePreferences(directory, root, { ...previous, revision: randomUUID(), sessions })
}
export function applySessionPreferences<T extends AcpSessionMeta>(meta: T, preferences: SessionPreferences): T {
  const value = Object.hasOwn(preferences.sessions, meta.sessionId) ? preferences.sessions[meta.sessionId] : undefined
  return { ...meta, title: value?.customTitle ?? value?.automaticTitle ?? meta.title ?? '新对话', customTitle: value?.customTitle,
    titleProvenance: value?.titleProvenance ?? meta.titleProvenance,
    pinnedAt: value?.pinnedAt, archivedAt: value?.archivedAt }
}
export function matchesHistorySummary(item: AcpHistorySummary, query: string, filter: string, archive: string): boolean {
  const haystack = [item.title, item.agentName, item.agentId, item.taskDir, item.profileSnapshot?.name].filter(Boolean).join(' ').toLocaleLowerCase()
  return haystack.includes(query) && (filter === 'all' || (filter === 'resumable' ? item.canResume === true : !item.canResume))
    && (archive === 'all' || (archive === 'archived' ? item.archivedAt !== undefined : item.archivedAt === undefined))
}
export function compareHistorySummaries(a: AcpHistorySummary, b: AcpHistorySummary): number {
  return Number(b.pinnedAt !== undefined) - Number(a.pinnedAt !== undefined)
    || b.lastActivityAt - a.lastActivityAt || b.sessionId.localeCompare(a.sessionId)
}

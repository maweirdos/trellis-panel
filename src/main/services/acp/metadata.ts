import { app } from 'electron'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, renameSync } from 'fs'
import { dirname, join, resolve } from 'path'
import type { AcpAgentProfile, AcpSessionRecord } from '../../../shared/types'
import { idSchema, objectValue, profileSchema } from './types'
import { readHistoryDeletion } from './history-deletion'
import { isRecoverableRuntimeRecord } from './runtime-definitions'
import { getSettings } from '../store'
import { ACP_RECOVERY_COMMIT_PENDING_MESSAGE } from '../../../shared/acp-recovery'

export function canonicalDirectory(directory: string): string {
  let value: string
  try { value = realpathSync(resolve(directory)) } catch { value = resolve(directory) }
  return process.platform === 'win32' ? value.replace(/[\\/]+$/, '').toLowerCase() : value
}

export function acpDataPath(...parts: string[]): string { return join(app.getPath('userData'), 'acp', ...parts) }

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(temp, path)
}

function profilesPath(root: string): string {
  return acpDataPath('profiles', `${createHash('sha256').update(canonicalDirectory(root)).digest('hex')}.json`)
}

export function readProfiles(root: string): AcpAgentProfile[] {
  const path = profilesPath(root)
  if (!existsSync(path)) return ['codex', 'claude'].map((runtimeId) => ({
    id: `default-${runtimeId}`, name: runtimeId === 'codex' ? 'Codex' : 'Claude Code', description: '',
    instructions: '', runtimeId, maxTurnMinutes: 30
  }))
  const value = objectValue(JSON.parse(readFileSync(path, 'utf8')))
  if (value.schemaVersion !== 1 || !Array.isArray(value.profiles)) throw new Error('Agent 配置格式不可读取，原文件已保留')
  return value.profiles.map((profile) => profileSchema.passthrough().parse(profile))
}

export function saveProfiles(root: string, profiles: AcpAgentProfile[]): void {
  const path = profilesPath(root)
  const previous = existsSync(path) ? objectValue(JSON.parse(readFileSync(path, 'utf8'))) : {}
  if (previous.schemaVersion !== undefined && previous.schemaVersion !== 1) throw new Error('Agent 配置版本不可写入，原文件已保留')
  writeJson(path, { ...previous, schemaVersion: 1, projectRoot: root, profiles })
}

export function persistRecord(record: AcpSessionRecord): void {
  idSchema.parse(record.sessionId)
  if (readHistoryDeletion(acpDataPath(), record.projectRoot, record.sessionId)) throw new Error('此会话已永久删除或正在清理，不能重新写入')
  const path = join(app.getPath('userData'), 'acp-sessions', `${record.sessionId}.json`)
  if (!backedUp.has(path) && existsSync(path)) {
    const bytes = readFileSync(path)
    const sha = createHash('sha256').update(bytes).digest('hex')
    const directory = acpDataPath('history-originals')
    mkdirSync(directory, { recursive: true })
    const backup = join(directory, `${sha}.json`)
    if (!existsSync(backup)) writeFileSync(backup, bytes, { flag: 'wx' })
    if (createHash('sha256').update(readFileSync(backup)).digest('hex') !== sha) throw new Error('历史原始记录备份校验失败')
    backedUp.add(path)
  }
  writeJson(path, record)
}
const backedUp = new Set<string>()

export function readRecords(): AcpSessionRecord[] {
  const dir = join(app.getPath('userData'), 'acp-sessions')
  if (!existsSync(dir)) return []
  const records: AcpSessionRecord[] = []
  const legacyIds = (getSettings().acp?.agents ?? []).map(item => item.id)
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = objectValue(JSON.parse(readFileSync(join(dir, name), 'utf8')))
      if (!idSchema.safeParse(raw.sessionId).success || typeof raw.projectRoot !== 'string' || !Array.isArray(raw.events)) continue
      // Unknown/newer records are never overwritten by this reader.
      const record = raw as unknown as AcpSessionRecord
      if (readHistoryDeletion(acpDataPath(), record.projectRoot, record.sessionId)) continue
      const legacy = record.schemaVersion !== 2
      const canResume = !legacy && isRecoverableRuntimeRecord(record, legacyIds)
        && typeof record.backendSessionId === 'string' && record.backendSessionId.trim().length > 0 && record.canResume === true
      records.push({ ...record, status: legacy ? 'legacy' : record.status === 'closed' || record.status === 'error' ? record.status : 'disconnected',
        error: record.recovery?.commitPending ? ACP_RECOVERY_COMMIT_PENDING_MESSAGE : record.error,
        historyKind: legacy ? 'legacy' : canResume ? 'resumable' : 'transcript',
        canResume, restorePending: false, connectionOwned: false, cleanupRequired: false, pendingPermissions: [],
        events: record.events.map((event) => event.kind === 'permission' ? { ...event, payload: { ...event.payload, pending: false } } : event)
      })
    } catch { /* One damaged historical record must not hide other conversations. */ }
  }
  return records
}

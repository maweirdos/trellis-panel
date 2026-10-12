import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'
import { OBSERVABILITY_SCHEMA_VERSION, parseContextEvent, type ContextEventV1 } from '../../../shared/observability/schema'
import {
  OBSERVATION_DIAGNOSTICS_LIMIT_BYTES,
  OBSERVATION_EVENT_ENCODE_LIMIT_BYTES,
  OBSERVATION_PHYSICAL_SOFT_LIMIT_BYTES,
  OBSERVATION_QUERY_PAGE_MAX,
  OBSERVATION_RETENTION_DAYS,
  OBSERVATION_RETENTION_MAX_EVENTS,
  OBSERVATION_RETENTION_MAX_PAYLOAD_BYTES,
  type ObservationHealth,
  type ObservationInsertOutcome,
  type ObservationItem
} from '../../../shared/observability/store'

/**
 * 观测/控制存储核心（design §4，S0 G3 第一片；D-SQLITE 登记，backend/database.md）。
 *
 * 本模块只依赖 Node 内置（node:sqlite/crypto/fs）+ shared 契约，不 import electron：
 * 在专用 worker 线程内运行（observation-worker.ts 包消息循环），冒烟亦可直接调用。
 *
 * 语义红线（design §4.2/§4.3）：
 * - 事件 INSERT 与 store_usage 变更同一事务提交；重复 eventId+同 digest 幂等返回已有
 *   结果；同 ID 异内容 → 冲突诊断不覆盖。
 * - journal=DELETE + synchronous=FULL；两个库独立版本/连接/事务，不假装跨库原子。
 * - 库损坏：保留原文件、停写、上报不可用；重建（用户显式确认）生成新 storeEpoch，
 *   旧 cursor → resetRequired；显式清理只删事件/诊断并更新 epoch，不触碰 control。
 * - 提交失败不得发布"已持久化"；诊断有界轮换且不含绝对路径/原始上下文/密钥。
 * - 时间一律 Unix 毫秒；seq 单调只做游标，不表达跨进程因果。
 */

export const OBSERVATIONS_DB_FILE = 'observations.sqlite'
export const CONTROL_DB_FILE = 'control.sqlite'
/** 当前程序理解的库结构版本；高于此版本的库只读不写（禁止降级写入）。 */
export const STORE_DB_VERSION = 1

/** 配额/保留限额（design §4.3 试验初值；可被构造参数修订——冒烟用小阈值验证路径）。 */
export interface StoreLimits {
  encodeLimitBytes: number
  retentionDays: number
  maxEvents: number
  maxPayloadBytes: number
  physicalSoftLimitBytes: number
  diagnosticsLimitBytes: number
}

export const DEFAULT_STORE_LIMITS: StoreLimits = {
  encodeLimitBytes: OBSERVATION_EVENT_ENCODE_LIMIT_BYTES,
  retentionDays: OBSERVATION_RETENTION_DAYS,
  maxEvents: OBSERVATION_RETENTION_MAX_EVENTS,
  maxPayloadBytes: OBSERVATION_RETENTION_MAX_PAYLOAD_BYTES,
  physicalSoftLimitBytes: OBSERVATION_PHYSICAL_SOFT_LIMIT_BYTES,
  diagnosticsLimitBytes: OBSERVATION_DIAGNOSTICS_LIMIT_BYTES
}

/** 绑定门禁：主进程身份层校验结果（不符 → 采集停止，读取/清理照常）。 */
export interface StoreBindingContext {
  repositoryId: string
  workspaceId: string
  collectionEnabled: boolean
  /** installationId/canonical root 不符 → true；原因字符串入库为暂停理由。 */
  collectionBlocked: boolean
  blockReason: string | null
}

export type StoreDbState = 'not_initialized' | 'active' | 'paused' | 'corrupted' | 'future_version' | 'closed'
/** 控制库没有采集暂停态（配额/门禁只作用于观测库；见 ObservationHealth.controlState）。 */
export type ControlDbState = Exclude<StoreDbState, 'paused'>

/* ---------------- schema（表/列名以 backend/database.md D-SQLITE 节为准） ---------------- */

const OBS_SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  eventId TEXT NOT NULL UNIQUE,
  payloadDigest TEXT NOT NULL,
  injectionId TEXT NOT NULL,
  kind TEXT NOT NULL,
  repositoryId TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  taskRef TEXT,
  occurredAtMs INTEGER NOT NULL,
  receivedAtMs INTEGER NOT NULL,
  payloadBytes INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_injection ON events(injectionId);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
CREATE INDEX IF NOT EXISTS idx_events_scope ON events(workspaceId, taskRef);
CREATE INDEX IF NOT EXISTS idx_events_occurred ON events(occurredAtMs);
CREATE TABLE IF NOT EXISTS store_usage (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  logicalCount INTEGER NOT NULL,
  logicalPayloadBytes INTEGER NOT NULL,
  collectionMode TEXT NOT NULL,
  pauseReason TEXT,
  updatedAtMs INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS store_diagnostics (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  dataJson TEXT,
  totalBytes INTEGER NOT NULL,
  occurredAtMs INTEGER NOT NULL
);
`

const CTRL_SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS control_schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_aliases (
  taskRef TEXT PRIMARY KEY,
  trellisTaskId TEXT,
  currentDir TEXT NOT NULL,
  priorDirsJson TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  pendingCandidatesJson TEXT,
  firstSeenMs INTEGER NOT NULL,
  updatedAtMs INTEGER NOT NULL
);
-- source_links / local_operations：G4 才有业务；本片仅建表（清理观测不得触碰）。
CREATE TABLE IF NOT EXISTS source_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspaceId TEXT NOT NULL,
  sourceKind TEXT NOT NULL,
  sourceKey TEXT NOT NULL,
  taskRef TEXT,
  payloadJson TEXT NOT NULL,
  createdAtMs INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS local_operations (
  operationId TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  stage TEXT NOT NULL,
  payloadJson TEXT NOT NULL,
  createdAtMs INTEGER NOT NULL,
  updatedAtMs INTEGER NOT NULL
);
`

/** 迁移框架：登记表 + 迁移期间暂停采集（design §4.3「迁移暂停采集」）。 */
const OBS_MIGRATIONS: Array<{ toVersion: number; up: (db: DatabaseSync) => void }> = [
  { toVersion: 1, up: (db) => db.exec(OBS_SCHEMA_V1) }
]
const CTRL_MIGRATIONS: Array<{ toVersion: number; up: (db: DatabaseSync) => void }> = [
  { toVersion: 1, up: (db) => db.exec(CTRL_SCHEMA_V1) }
]

/* ---------------- 工具 ---------------- */

/** 稳定序列化（递归键排序）：同内容事件跨进程得到同 digest，幂等核对才可靠。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex')
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf-8')
}

/** 诊断/错误文本脱敏：剥离本机绝对路径形态（盘符/根路径）与控制字符，只留可读说明。 */
export function redactText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[A-Za-z]:\\[^\s"']*/g, '<path>').replace(/\/(?:[\w.-]+\/)+/g, '<path>/').replace(/[\u0000-\u001f]/g, '')
}

export interface StoreQueryRequest {
  after?: number
  before?: number
  limit: number
  /** 调用方 cursor 的 epoch（resetRequired 判定用）。 */
  cursorEpoch?: string
}

export interface StoreQueryResult {
  items: ObservationItem[]
  highWatermark: number
  nextCursor: { storeEpoch: string; seq: number }
  retainedFrom: number | null
  resetRequired: boolean
}

export interface TaskAliasRecord {
  taskRef: string
  trellisTaskId: string | null
  currentDir: string
  priorDirs: string[]
  status: 'verified' | 'pending_confirmation' | 'missing'
  pendingCandidates: string[]
  firstSeenMs: number
  updatedAtMs: number
}

export interface VerifyAliasesInput {
  /** 仓库内相对目录（正斜杠，如 .trellis/tasks/10-01-a 或 .trellis/tasks/archive/2026-10/10-01-a）。 */
  dir: string
  /** task.json.id；缺失/不可读为 null（此时只做存在性续接，不做同 ID 归并）。 */
  trellisTaskId: string | null
}

export interface VerifyAliasesResult {
  moved: number
  verified: number
  pending: Array<{ taskRef: string; candidates: string[] }>
  missing: number
}

/* ---------------- 核心 ---------------- */

export class ObservationStoreCore {
  private readonly runtimeDir: string
  private readonly limits: StoreLimits
  private binding: StoreBindingContext | null = null

  private obs: DatabaseSync | null = null
  private ctrl: DatabaseSync | null = null
  private obsState: StoreDbState = 'not_initialized'
  private obsPauseReason: string | null = null
  private ctrlState: ControlDbState = 'not_initialized'
  private storeEpoch: string | null = null
  private dbVersion: number | null = null
  private inTx = false
  private pendingDiagnostics: Array<{ code: string; message: string; data?: Record<string, unknown> }> = []

  constructor(runtimeDir: string, limits: Partial<StoreLimits> = {}) {
    this.runtimeDir = runtimeDir
    this.limits = { ...DEFAULT_STORE_LIMITS, ...limits }
  }

  observationsDbPath(): string {
    return join(this.runtimeDir, OBSERVATIONS_DB_FILE)
  }

  controlDbPath(): string {
    return join(this.runtimeDir, CONTROL_DB_FILE)
  }

  setBinding(binding: StoreBindingContext | null): void {
    this.binding = binding
  }

  /* ---------------- open / close ---------------- */

  /** 打开两个库（独立初始化：观测失败不拖垮控制，反之亦然）。 */
  open(): void {
    mkdirSync(this.runtimeDir, { recursive: true })
    this.openObservations()
    this.openControl()
  }

  private openObservations(): void {
    const path = this.observationsDbPath()
    const fresh = !existsSync(path)
    let db: DatabaseSync | null = null
    try {
      db = new DatabaseSync(path)
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;')
    } catch (e) {
      // 打开/PRAGMA 即失败：必须关闭句柄（Windows 上残留句柄会让重建 rename 报 EBUSY）
      if (db !== null) {
        try {
          db.close()
        } catch {
          /* already broken */
        }
      }
      this.obsState = 'corrupted'
      this.recordDiagnostic('store_open_failed', `观测库打开失败：${redactText(errText(e))}`, { fresh })
      return
    }
    try {
      this.migrateObservations(db, fresh)
      if (this.obsState === 'future_version') {
        // 未来版本：只显示不兼容，禁止降级写入（连 store_usage 也不写）
        this.obs = db
        return
      }
      const check = db.prepare('PRAGMA quick_check(1)').get() as { quick_check?: unknown } | undefined
      if (check?.quick_check !== 'ok') throw new Error('quick_check failed')
      this.obs = db
      this.obsState = 'active'
      this.obsPauseReason = null
      this.applyBindingGateToUsage()
      this.flushPendingDiagnostics()
    } catch (e) {
      try {
        db.close()
      } catch {
        /* already broken */
      }
      this.obsState = 'corrupted'
      this.obsPauseReason = null
      this.pendingDiagnostics.push({
        code: 'store_corrupted',
        message: `观测库损坏或不可识别（原文件保留，等待用户选择重建）：${redactText(errText(e))}`
      })
      // 损坏诊断也要落库只能在重建后的新库里；这里保存在内存，rebuild 后 flush
    }
  }

  /** 迁移（暂停采集执行迁移；未来版本只读不写）。fresh=文件首次创建。 */
  private migrateObservations(db: DatabaseSync, fresh: boolean): void {
    const hasMeta = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'").get() as
        | { name: string }
        | undefined
    ) !== undefined
    if (!hasMeta) {
      const anyTable = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table'").get() as { c: number }
      if (anyTable.c > 0 && !fresh) {
        // 有表但没有 schema_meta：不是 Panel 建的库（或已损坏）——不猜、不覆盖
        throw new Error('unrecognized database (no schema_meta)')
      }
    }
    let current = 0
    if (hasMeta) {
      const row = db.prepare("SELECT value FROM schema_meta WHERE key='dbVersion'").get() as { value: string } | undefined
      current = row ? Number(row.value) : 0
    }
    if (current > STORE_DB_VERSION) {
      // 未来版本：只显示不兼容，禁止降级写入（design §4.3）
      this.dbVersion = current
      this.storeEpoch = this.readMetaValue(db, 'storeEpoch')
      this.obsState = 'future_version'
      return
    }
    if (current < STORE_DB_VERSION) {
      // 迁移状态标记只在 schema_meta 已存在时可写（fresh 库由首个迁移建表；
      // 标记先于建表写入会在全新库上抛 no-such-table —— 每个迁移本身是单事务，
      // 中断由 journal 回滚，标记仅服务于升级失败的可见性）
      if (hasMeta) this.setMetaValue(db, 'migrationState', 'running')
      for (const m of OBS_MIGRATIONS) {
        if (m.toVersion <= current) continue
        db.exec('BEGIN IMMEDIATE')
        try {
          m.up(db)
          db.exec('COMMIT')
        } catch (e) {
          db.exec('ROLLBACK')
          if (hasMeta) this.setMetaValue(db, 'migrationState', 'failed')
          throw e
        }
        current = m.toVersion
      }
      this.setMetaValue(db, 'dbVersion', String(current))
      this.setMetaValue(db, 'protocolMin', String(OBSERVABILITY_SCHEMA_VERSION))
      this.setMetaValue(db, 'protocolMax', String(OBSERVABILITY_SCHEMA_VERSION))
      this.setMetaValue(db, 'migrationState', 'applied')
      const epoch = this.readMetaValue(db, 'storeEpoch')
      if (epoch === null) this.setMetaValue(db, 'storeEpoch', randomUUID())
    }
    this.dbVersion = current
    this.storeEpoch = this.readMetaValue(db, 'storeEpoch')
    // store_usage 单行初始化
    db.prepare(
      "INSERT OR IGNORE INTO store_usage(id, logicalCount, logicalPayloadBytes, collectionMode, pauseReason, updatedAtMs) VALUES(1, 0, 0, 'active', NULL, ?)"
    ).run(Date.now())
  }

  private openControl(): void {
    const path = this.controlDbPath()
    const fresh = !existsSync(path)
    let db: DatabaseSync | null = null
    try {
      db = new DatabaseSync(path)
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;')
    } catch (e) {
      if (db !== null) {
        try {
          db.close()
        } catch {
          /* already broken */
        }
      }
      this.ctrlState = 'corrupted'
      this.pendingDiagnostics.push({ code: 'control_open_failed', message: `控制库打开失败：${redactText(errText(e))}` })
      return
    }
    try {
      const hasMeta = (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='control_schema_meta'").get() as
          | { name: string }
          | undefined
        ) !== undefined
      let current = 0
      if (hasMeta) {
        const row = db.prepare("SELECT value FROM control_schema_meta WHERE key='dbVersion'").get() as
          | { value: string }
          | undefined
        current = row ? Number(row.value) : 0
      }
      if (current > STORE_DB_VERSION) {
        this.ctrlState = 'future_version'
        this.ctrl = db
        return
      }
      for (const m of CTRL_MIGRATIONS) {
        if (m.toVersion <= current) continue
        db.exec('BEGIN IMMEDIATE')
        try {
          m.up(db)
          db.exec('COMMIT')
        } catch (e) {
          db.exec('ROLLBACK')
          throw e
        }
        current = m.toVersion
      }
      db.prepare("INSERT OR REPLACE INTO control_schema_meta(key, value) VALUES('dbVersion', ?)").run(String(current))
      this.ctrl = db
      this.ctrlState = 'active'
    } catch (e) {
      try {
        db.close()
      } catch {
        /* already broken */
      }
      this.ctrlState = 'corrupted'
      this.pendingDiagnostics.push({ code: 'control_corrupted', message: `控制库损坏（任务别名续接暂不可用）：${redactText(errText(e))}` })
    }
  }

  close(): void {
    for (const db of [this.obs, this.ctrl]) {
      if (db === null) continue
      try {
        db.close()
      } catch {
        /* closing a broken db is best-effort */
      }
    }
    this.obs = null
    this.ctrl = null
    this.obsState = 'closed'
    this.ctrlState = 'closed'
  }

  /* ---------------- meta helpers ---------------- */

  private readMetaValue(db: DatabaseSync, key: string): string | null {
    try {
      const row = db.prepare('SELECT value FROM schema_meta WHERE key=?').get(key) as { value: string } | undefined
      return row ? row.value : null
    } catch {
      return null
    }
  }

  private setMetaValue(db: DatabaseSync, key: string, value: string): void {
    db.prepare('INSERT OR REPLACE INTO schema_meta(key, value) VALUES(?, ?)').run(key, value)
  }

  /* ---------------- usage / gate ---------------- */

  private usageRow(): { logicalCount: number; logicalPayloadBytes: number; collectionMode: string; pauseReason: string | null } | null {
    if (this.obs === null) return null
    const row = this.obs
      .prepare('SELECT logicalCount, logicalPayloadBytes, collectionMode, pauseReason FROM store_usage WHERE id=1')
      .get() as { logicalCount: number; logicalPayloadBytes: number; collectionMode: string; pauseReason: string | null } | undefined
    return row ?? null
  }

  /** 仅由库自身状态/配额导致的暂停原因（绑定门禁恢复不得解除这些；只能由清理/重建处理）。 */
  private static readonly NON_BINDING_PAUSE_REASONS = new Set([
    'quota_retention',
    'physical_limit',
    'store_corrupted',
    'future_version',
    'store_unavailable'
  ])

  /** 绑定门禁（不含库状态）：binding 为 null（未设置/直驱冒烟）时视为不设门禁。 */
  private bindingGate(): { blocked: boolean; reason: string | null } {
    if (this.binding !== null && this.binding.collectionBlocked) {
      return { blocked: true, reason: this.binding.blockReason ?? 'binding_mismatch' }
    }
    if (this.binding !== null && !this.binding.collectionEnabled) {
      return { blocked: true, reason: 'collection_disabled' }
    }
    return { blocked: false, reason: null }
  }

  private collectionGate(): { ok: boolean; reason: string | null } {
    const binding = this.bindingGate()
    if (binding.blocked) return { ok: false, reason: binding.reason }
    if (this.obsState === 'paused') return { ok: false, reason: this.obsPauseReason }
    if (this.obsState === 'corrupted') return { ok: false, reason: 'store_corrupted' }
    if (this.obsState === 'future_version') return { ok: false, reason: 'future_version' }
    if (this.obsState !== 'active' || this.obs === null) return { ok: false, reason: 'store_unavailable' }
    return { ok: true, reason: null }
  }

  /** 绑定门禁/库状态变化时同步 store_usage 的采集模式（读取口径单一来源）。 */
  private applyBindingGateToUsage(): void {
    if (this.obs === null) return
    const binding = this.bindingGate()
    if (binding.blocked && this.obsState === 'active') {
      this.obsState = 'paused'
      this.obsPauseReason = binding.reason
    } else if (
      !binding.blocked &&
      this.obsState === 'paused' &&
      this.obsPauseReason !== null &&
      !ObservationStoreCore.NON_BINDING_PAUSE_REASONS.has(this.obsPauseReason)
    ) {
      // 门禁解除（重新启用采集/确认迁移）：仅恢复门禁类暂停；配额/物理/损坏不在此恢复
      this.obsState = 'active'
      this.obsPauseReason = null
    }
    const row = this.usageRow()
    if (row === null) return
    const wantMode = this.obsState === 'active' ? 'active' : 'paused'
    const wantReason = this.obsState === 'active' ? null : this.obsPauseReason ?? 'unknown'
    if (row.collectionMode !== wantMode || row.pauseReason !== wantReason) {
      this.obs
        .prepare('UPDATE store_usage SET collectionMode=?, pauseReason=?, updatedAtMs=? WHERE id=1')
        .run(wantMode, wantReason, Date.now())
    }
  }

  /* ---------------- 事件写入 ---------------- */

  /**
   * 写入一条观测事件（Panel 侧唯一写入口；Hook 的 Python 直写路径属 G1-C）。
   * 返回口径见 ObservationInsertOutcome：rejected/invalid 一律未落账。
   */
  insertEvent(rawEvent: unknown, receivedAtMs: number): ObservationInsertOutcome {
    const gate = this.collectionGate()
    if (!gate.ok) {
      return { status: 'rejected', reason: gate.reason ?? 'store_unavailable', diagnosticCode: null }
    }
    const db = this.obs
    if (db === null) return { status: 'rejected', reason: 'store_unavailable', diagnosticCode: null }

    const parsed = parseContextEvent(rawEvent)
    if (parsed.success !== true) {
      this.recordDiagnostic(
        parsed.reason === 'unsupported_schema_version' ? 'event_unsupported_version' : 'event_malformed',
        parsed.reason === 'unsupported_schema_version'
          ? '事件 schema 主版本不支持（进入有界诊断，不按旧格式解释）'
          : '事件结构非法（缺证据≠故障；跳过并留诊断）',
        { issues: parsed.reason === 'malformed' ? parsed.issues.slice(0, 4) : undefined }
      )
      return { status: 'invalid', reason: parsed.reason }
    }
    const event = parsed.event

    // 绑定范围守卫：不收其他绑定/工作区的事件（Hook 只读匹配 cwd 的绑定）
    if (this.binding !== null && (event.scope.workspaceId !== this.binding.workspaceId || event.scope.repositoryId !== this.binding.repositoryId)) {
      this.recordDiagnostic('event_scope_mismatch', '事件 scope 与当前绑定不符（拒绝落库，不改原始事件）')
      return { status: 'rejected', reason: 'scope_mismatch', diagnosticCode: 'event_scope_mismatch' }
    }

    // 64KiB 编码预算：先删减明细标 partial/遗漏数；汇总仍超限则跳过并记诊断
    const { event: stored, omitted, trimmed } = trimEventForStore(event, this.limits.encodeLimitBytes)
    const payloadJson = JSON.stringify(stored)
    const payloadBytes = utf8Bytes(payloadJson)
    if (payloadBytes > this.limits.encodeLimitBytes) {
      this.recordDiagnostic('event_skipped_too_large', '事件汇总超过单事件编码上限（未观测，不落半截数据）', {
        eventId: event.eventId,
        bytes: payloadBytes,
        limitBytes: this.limits.encodeLimitBytes
      })
      return { status: 'rejected', reason: 'event_too_large', diagnosticCode: 'event_skipped_too_large' }
    }
    const payloadDigest = sha256Hex(stableStringify(stored))

    // 物理软保护（只 stat 固定文件；超限不写新观测）
    const physical = this.physicalBytes()
    if (physical >= this.limits.physicalSoftLimitBytes) {
      this.pauseUsage('physical_limit')
      return { status: 'rejected', reason: 'physical_limit', diagnosticCode: null }
    }

    db.exec('BEGIN IMMEDIATE')
    this.inTx = true
    try {
      const usage = this.usageRow()
      if (usage === null) throw new Error('store_usage missing')
      if (
        usage.logicalCount >= this.limits.maxEvents ||
        usage.logicalPayloadBytes + payloadBytes > this.limits.maxPayloadBytes
      ) {
        // 逻辑配额满：暂停新增（usage 变更与判定同事务提交）
        db.prepare('UPDATE store_usage SET collectionMode=?, pauseReason=?, updatedAtMs=? WHERE id=1').run(
          'paused',
          'quota_retention',
          Date.now()
        )
        db.exec('COMMIT')
        this.inTx = false
        this.obsState = 'paused'
        this.obsPauseReason = 'quota_retention'
        return { status: 'rejected', reason: 'quota_paused', diagnosticCode: null }
      }

      const existing = db.prepare('SELECT seq, payloadDigest FROM events WHERE eventId=?').get(event.eventId) as
        | { seq: number; payloadDigest: string }
        | undefined
      if (existing !== undefined) {
        db.exec('ROLLBACK')
        this.inTx = false
        if (existing.payloadDigest === payloadDigest) {
          return { status: 'duplicate', seq: existing.seq, eventId: event.eventId }
        }
        this.recordDiagnostic('event_id_conflict', '同 eventId 异内容：保留首见记录，不覆盖', {
          eventId: event.eventId,
          expectedDigest: existing.payloadDigest.slice(0, 16),
          gotDigest: payloadDigest.slice(0, 16)
        })
        return { status: 'conflict', eventId: event.eventId }
      }

      const info = db
        .prepare(
          `INSERT INTO events(eventId, payloadDigest, injectionId, kind, repositoryId, workspaceId, taskRef, occurredAtMs, receivedAtMs, payloadBytes, payload)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          event.eventId,
          payloadDigest,
          event.injectionId,
          event.kind,
          event.scope.repositoryId,
          event.scope.workspaceId,
          event.scope.taskRef,
          event.occurredAtMs,
          receivedAtMs,
          payloadBytes,
          payloadJson
        )
      const seq = Number(info.lastInsertRowid)
      // 事件 INSERT 与 usage 变更同一事务（design §4.2）
      db.prepare('UPDATE store_usage SET logicalCount=logicalCount+1, logicalPayloadBytes=logicalPayloadBytes+?, updatedAtMs=? WHERE id=1').run(
        payloadBytes,
        Date.now()
      )
      db.exec('COMMIT')
      this.inTx = false
      if (trimmed) {
        this.recordDiagnostic('event_materials_dropped', '事件明细超过编码预算：删减明细标 partial 并记遗漏数', {
          eventId: event.eventId,
          omittedMaterials: omitted
        })
      }
      this.flushPendingDiagnostics()
      return { status: 'inserted', seq, eventId: event.eventId, trimmed, omittedMaterials: omitted }
    } catch (e) {
      if (this.inTx) {
        try {
          db.exec('ROLLBACK')
        } catch {
          /* rollback best-effort */
        }
        this.inTx = false
      }
      this.handleObsWriteError(e)
      return { status: 'rejected', reason: 'write_failed', diagnosticCode: null }
    }
  }

  private handleObsWriteError(e: unknown): void {
    const msg = errText(e)
    // 明确锁冲突（双生产者并发）不算损坏：G1-B 已证 Hook 侧预算耗尽即失败
    if (/locked|busy/i.test(msg)) {
      this.recordDiagnostic('store_write_busy', `写入遇锁冲突（双生产者并发，本侧放弃）：${redactText(msg)}`)
      return
    }
    // 其余错误需要鉴别是否损坏
    if (this.obs !== null) {
      try {
        const check = this.obs.prepare('PRAGMA quick_check(1)').get() as { quick_check?: unknown } | undefined
        if (check?.quick_check === 'ok') {
          this.recordDiagnostic('store_write_failed', `写入失败（库仍完好）：${redactText(msg)}`)
          return
        }
      } catch {
        /* quick_check 本身失败 → 按损坏处理 */
      }
    }
    this.obsState = 'corrupted'
    this.obsPauseReason = null
    this.pendingDiagnostics.push({ code: 'store_corrupted', message: `观测库写入时判定损坏（停写、保留原文件）：${redactText(msg)}` })
  }

  private pauseUsage(reason: string): void {
    this.obsState = 'paused'
    this.obsPauseReason = reason
    if (this.obs === null) return
    try {
      this.obs.prepare('UPDATE store_usage SET collectionMode=?, pauseReason=?, updatedAtMs=? WHERE id=1').run(
        'paused',
        reason,
        Date.now()
      )
    } catch {
      /* usage 写失败不影响判定结果 */
    }
  }

  /* ---------------- 查询 ---------------- */

  queryEvents(scope: { workspaceId: string; taskRef?: string }, req: StoreQueryRequest): StoreQueryResult {
    // future_version 只显示不兼容：不按 v1 格式硬解释未知 schema 的行（design §4.3）
    if (this.obs === null || (this.obsState !== 'active' && this.obsState !== 'paused')) {
      // 库不可用时的稳定哨兵 epoch（不能用随机值——否则每次查询 cursor 都失效）
      const unavailable = this.storeEpoch ?? 'store-unavailable'
      return {
        items: [],
        highWatermark: 0,
        nextCursor: { storeEpoch: unavailable, seq: 0 },
        retainedFrom: null,
        resetRequired: req.cursorEpoch !== undefined && req.cursorEpoch !== unavailable
      }
    }
    const db = this.obs
    // epoch 每次查询实时读库：另一连接（Hook/另一 Panel 实例）清理/重建换 epoch 时，
    // 本实例的 cursor 失效判定必须能看到（双生产者契约，design §4.2）
    const epoch = this.readMetaValue(db, 'storeEpoch') ?? 'store-unavailable'
    if (epoch !== this.storeEpoch) this.storeEpoch = epoch
    const limit = Math.max(1, Math.min(Math.floor(req.limit) || 0, OBSERVATION_QUERY_PAGE_MAX))
    try {
      const after = req.after ?? 0
      const rows = (
        scope.taskRef !== undefined
          ? db
              .prepare(
                'SELECT * FROM events WHERE workspaceId=? AND taskRef=? AND seq>? AND (? IS NULL OR seq<=?) ORDER BY seq ASC LIMIT ?'
              )
              .all(scope.workspaceId, scope.taskRef, after, req.before ?? null, req.before ?? null, limit)
          : db
              .prepare('SELECT * FROM events WHERE workspaceId=? AND seq>? AND (? IS NULL OR seq<=?) ORDER BY seq ASC LIMIT ?')
              .all(scope.workspaceId, after, req.before ?? null, req.before ?? null, limit)
      ) as unknown as Array<EventRow>
      const items: ObservationItem[] = []
      for (const row of rows) {
        const parsed = parseContextEvent(JSON.parse(row.payload))
        if (parsed.success !== true) {
          this.recordDiagnostic('event_row_unparsable', '存储行 payload 不符合契约（读取时跳过，不改写）', { seq: row.seq })
          continue
        }
        items.push({
          seq: row.seq,
          eventId: row.eventId,
          injectionId: row.injectionId,
          kind: row.kind,
          occurredAtMs: row.occurredAtMs,
          receivedAtMs: row.receivedAtMs,
          event: parsed.event
        })
      }
      const hw = (db.prepare('SELECT COALESCE(MAX(seq),0) m FROM events').get() as { m: number }).m
      const oldest = (db.prepare('SELECT MIN(occurredAtMs) m FROM events').get() as { m: number | null }).m
      const lastSeq = items.length > 0 ? items[items.length - 1].seq : after
      return {
        items,
        highWatermark: hw,
        nextCursor: { storeEpoch: epoch, seq: lastSeq },
        retainedFrom: oldest,
        resetRequired: req.cursorEpoch !== undefined && req.cursorEpoch !== epoch
      }
    } catch (e) {
      this.handleObsWriteError(e)
      return {
        items: [],
        highWatermark: 0,
        nextCursor: { storeEpoch: epoch, seq: 0 },
        retainedFrom: null,
        resetRequired: req.cursorEpoch !== undefined && req.cursorEpoch !== epoch
      }
    }
  }

  /* ---------------- 清理 / 保留 / 重建 ---------------- */

  /** 保留清理（Panel 侧显式/空闲触发）：过期/超条数/超字节删最旧；满足条件恢复采集。 */
  cleanupRetention(): { removed: number; resumed: boolean } {
    if (this.obs === null) return { removed: 0, resumed: false }
    const db = this.obs
    const cutoff = Date.now() - this.limits.retentionDays * 24 * 60 * 60 * 1000
    let removed = 0
    db.exec('BEGIN IMMEDIATE')
    this.inTx = true
    try {
      const expired = db.prepare('DELETE FROM events WHERE occurredAtMs<?').run(cutoff)
      removed += Number(expired.changes)
      // 超条数：保留最新 maxEvents 条
      const overflow = db
        .prepare(
          'DELETE FROM events WHERE seq IN (SELECT seq FROM events ORDER BY seq DESC LIMIT -1 OFFSET ?)'
        )
        .run(this.limits.maxEvents)
      removed += Number(overflow.changes)
      // 超 payload 字节：从最旧删起，直到回到预算内（分批删，避免单巨语句）
      for (let round = 0; round < 64; round += 1) {
        const total = (db.prepare('SELECT COALESCE(SUM(payloadBytes),0) s FROM events').get() as { s: number }).s
        if (total <= this.limits.maxPayloadBytes) break
        const batch = db
          .prepare(
            'DELETE FROM events WHERE seq IN (SELECT seq FROM events ORDER BY seq ASC LIMIT 500)'
          )
          .run()
        removed += Number(batch.changes)
        if (batch.changes === 0) break
      }
      const count = (db.prepare('SELECT COUNT(*) c FROM events').get() as { c: number }).c
      const bytes = (db.prepare('SELECT COALESCE(SUM(payloadBytes),0) s FROM events').get() as { s: number }).s
      db.prepare('UPDATE store_usage SET logicalCount=?, logicalPayloadBytes=?, updatedAtMs=? WHERE id=1').run(
        count,
        bytes,
        Date.now()
      )
      db.exec('COMMIT')
      this.inTx = false
    } catch (e) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* best-effort */
      }
      this.inTx = false
      this.handleObsWriteError(e)
      return { removed, resumed: false }
    }
    // 清理后若回到预算内且此前因配额/物理暂停 → 恢复（绑定门禁与损坏不自动恢复）
    const row = this.usageRow()
    const physical = this.physicalBytes()
    const underQuota =
      row !== null && row.logicalCount < this.limits.maxEvents && row.logicalPayloadBytes <= this.limits.maxPayloadBytes
    const resumed =
      this.obsState === 'paused' &&
      (this.obsPauseReason === 'quota_retention' || this.obsPauseReason === 'physical_limit') &&
      underQuota &&
      physical < this.limits.physicalSoftLimitBytes &&
      this.binding !== null &&
      !this.binding.collectionBlocked &&
      this.binding.collectionEnabled
    if (resumed) {
      this.obsState = 'active'
      this.obsPauseReason = null
      try {
        db.prepare('UPDATE store_usage SET collectionMode=?, pauseReason=NULL, updatedAtMs=? WHERE id=1').run(
          'active',
          Date.now()
        )
      } catch {
        /* usage 写失败不回退判定 */
      }
    }
    this.flushPendingDiagnostics()
    return { removed, resumed }
  }

  /**
   * 显式清理（用户确认）：只删观测事件与观测诊断并更新 storeEpoch；
   * 不触碰 control.sqlite / 绑定 / 来源关联（design §4.2）。
   */
  clearAllObservations(): { storeEpoch: string } {
    const epoch = randomUUID()
    if (this.obs === null) {
      this.storeEpoch = epoch
      return { storeEpoch: epoch }
    }
    const db = this.obs
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec('DELETE FROM events; DELETE FROM store_diagnostics;')
      db.prepare('UPDATE store_usage SET logicalCount=0, logicalPayloadBytes=0, collectionMode=?, pauseReason=NULL, updatedAtMs=? WHERE id=1').run(
        'active',
        Date.now()
      )
      this.setMetaValue(db, 'storeEpoch', epoch)
      db.exec('COMMIT')
    } catch (e) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* rollback best-effort（BEGIN 本身失败时无事务可回滚） */
      }
      this.handleObsWriteError(e)
      return { storeEpoch: this.storeEpoch ?? epoch }
    }
    this.storeEpoch = epoch
    // 清理本身即是恢复动作：配额类暂停解除（绑定门禁另算）
    this.applyBindingGateToUsage()
    return { storeEpoch: epoch }
  }

  /**
   * 损坏重建（用户显式确认）：原文件改名保留（不删证据），新库新 storeEpoch；
   * 旧 cursor 因 epoch 更换 → resetRequired。不触碰控制库。
   */
  rebuildObservations(): { storeEpoch: string; preservedFile: string | null } {
    const path = this.observationsDbPath()
    let preserved: string | null = null
    if (this.obs !== null) {
      try {
        this.obs.close()
      } catch {
        /* broken db close is best-effort */
      }
      this.obs = null
    }
    if (existsSync(path)) {
      preserved = `${path}.corrupt-${Date.now().toString(36)}`
      renameSync(path, preserved)
    }
    for (const suffix of ['-journal', '-wal', '-shm']) {
      const side = path + suffix
      if (existsSync(side)) {
        const sidePreserved = `${preserved ?? path}.corrupt-side-${Date.now().toString(36)}`
        try {
          renameSync(side, sidePreserved)
        } catch {
          /* sidecar 清理尽力而为；主文件已保留 */
        }
      }
    }
    this.obsState = 'not_initialized'
    this.openObservations()
    // 损坏期间积压的诊断（store_corrupted 等）落进新库：重建原因留痕；
    // openObservations 成功路径本身会 flush，此处兜底（如 quick_check 后续失败的场景）。
    this.flushPendingDiagnostics()
    return { storeEpoch: this.storeEpoch ?? randomUUID(), preservedFile: preserved === null ? null : basename(preserved) }
  }

  /* ---------------- 诊断（有界轮换） ---------------- */

  /** 记录观测诊断：不含绝对路径/原始上下文/密钥；写失败可不可见（不抛出）。 */
  recordDiagnostic(code: string, message: string, data?: Record<string, unknown>): void {
    // 损坏期间无法落库：内存缓冲有界（超限丢最旧），rebuild 后 flush
    if (this.pendingDiagnostics.length >= 64 && this.obs === null) {
      this.pendingDiagnostics.shift()
    } else if (this.pendingDiagnostics.length >= 256) {
      this.pendingDiagnostics.shift()
    }
    this.pendingDiagnostics.push({ code, message, data })
    if (!this.inTx) this.flushPendingDiagnostics()
  }

  private flushPendingDiagnostics(): void {
    if (this.pendingDiagnostics.length === 0 || this.obs === null || this.inTx) return
    const batch = this.pendingDiagnostics
    this.pendingDiagnostics = []
    const db = this.obs
    for (const d of batch) {
      try {
        const redactedMsg = redactText(d.message).slice(0, 512)
        let dataJson: string | null = null
        if (d.data !== undefined) {
          const encoded = redactText(JSON.stringify(d.data))
          dataJson = encoded.length > 2048 ? JSON.stringify({ truncated: true, bytes: utf8Bytes(encoded) }) : encoded
        }
        const totalBytes = utf8Bytes(redactedMsg) + (dataJson !== null ? utf8Bytes(dataJson) : 0)
        db.prepare('INSERT INTO store_diagnostics(code, message, dataJson, totalBytes, occurredAtMs) VALUES(?,?,?,?,?)').run(
          d.code,
          redactedMsg,
          dataJson,
          totalBytes,
          Date.now()
        )
      } catch {
        /* 诊断写失败可不可见 */
      }
    }
    try {
      // 1MiB 有界轮换：保留最近的摘要与计数
      for (let round = 0; round < 64; round += 1) {
        const total = (db.prepare('SELECT COALESCE(SUM(totalBytes),0) s FROM store_diagnostics').get() as { s: number }).s
        if (total <= this.limits.diagnosticsLimitBytes) break
        const batchDel = db.prepare('DELETE FROM store_diagnostics WHERE seq IN (SELECT seq FROM store_diagnostics ORDER BY seq ASC LIMIT 32)').run()
        if (batchDel.changes === 0) break
      }
    } catch {
      /* best-effort */
    }
  }

  listDiagnostics(limit = 50): Array<{ seq: number; code: string; message: string; occurredAtMs: number }> {
    if (this.obs === null) return []
    try {
      return this.obs
        .prepare('SELECT seq, code, message, occurredAtMs FROM store_diagnostics ORDER BY seq DESC LIMIT ?')
        .all(Math.max(1, Math.min(limit, 200))) as Array<{ seq: number; code: string; message: string; occurredAtMs: number }>
    } catch {
      return []
    }
  }

  /* ---------------- 健康 ---------------- */

  physicalBytes(): number {
    const base = this.observationsDbPath()
    let total = 0
    for (const p of [base, `${base}-journal`, `${base}-wal`, `${base}-shm`]) {
      try {
        const st = statSync(p)
        if (st.isFile()) total += st.size
      } catch {
        /* 缺失不计 */
      }
    }
    return total
  }

  health(): ObservationHealth {
    const usage = this.obsState === 'active' || this.obsState === 'paused' ? this.usageRow() : null
    // epoch 实时读库（另一连接清理/重建后本实例不应报告过期值；读失败回退内存缓存）
    let storeEpoch = this.storeEpoch
    if (this.obs !== null) {
      const live = this.readMetaValue(this.obs, 'storeEpoch')
      if (live !== null) {
        storeEpoch = live
        this.storeEpoch = live
      }
    }
    return {
      state: this.obsState,
      pauseReason: this.obsState === 'paused' ? this.obsPauseReason : null,
      dbVersion: this.dbVersion,
      storeEpoch,
      logicalCount: usage?.logicalCount ?? 0,
      logicalPayloadBytes: usage?.logicalPayloadBytes ?? 0,
      physicalBytes: this.physicalBytes(),
      controlState: this.ctrlState
    }
  }

  /* ---------------- 控制库：task_aliases ---------------- */

  /** 记录/刷新已核实目录（调用方断言的明确移动关系：旧目录进 priorDirs）。 */
  recordTaskAlias(taskRef: string, trellisTaskId: string | null, dir: string): TaskAliasRecord {
    if (this.ctrl === null) throw new Error('control store unavailable')
    const now = Date.now()
    const existing = this.ctrl.prepare('SELECT * FROM task_aliases WHERE taskRef=?').get(taskRef) as
      | (Omit<TaskAliasRecord, 'priorDirs' | 'pendingCandidates'> & { priorDirsJson: string; pendingCandidatesJson: string | null })
      | undefined
    if (existing === undefined) {
      this.ctrl
        .prepare(
          'INSERT INTO task_aliases(taskRef, trellisTaskId, currentDir, priorDirsJson, status, pendingCandidatesJson, firstSeenMs, updatedAtMs) VALUES(?,?,?,?,?,?,?,?)'
        )
        .run(taskRef, trellisTaskId, dir, '[]', 'verified', null, now, now)
    } else if (existing.currentDir !== dir) {
      const prior = JSON.parse(existing.priorDirsJson) as string[]
      if (!prior.includes(existing.currentDir)) prior.push(existing.currentDir)
      this.ctrl
        .prepare('UPDATE task_aliases SET trellisTaskId=?, currentDir=?, priorDirsJson=?, status=?, pendingCandidatesJson=NULL, updatedAtMs=? WHERE taskRef=?')
        .run(trellisTaskId, dir, JSON.stringify(prior), 'verified', now, taskRef)
    } else {
      this.ctrl
        .prepare('UPDATE task_aliases SET trellisTaskId=?, status=?, pendingCandidatesJson=NULL, updatedAtMs=? WHERE taskRef=?')
        .run(trellisTaskId, 'verified', now, taskRef)
    }
    const record = this.getTaskAlias(taskRef)
    if (record === null) throw new Error('control store unavailable')
    return record
  }

  getTaskAlias(taskRef: string): TaskAliasRecord | null {
    if (this.ctrl === null) return null
    const row = this.ctrl.prepare('SELECT * FROM task_aliases WHERE taskRef=?').get(taskRef) as
      | (Omit<TaskAliasRecord, 'priorDirs' | 'pendingCandidates'> & { priorDirsJson: string; pendingCandidatesJson: string | null })
      | undefined
    if (row === undefined) return null
    return {
      taskRef: row.taskRef,
      trellisTaskId: row.trellisTaskId,
      currentDir: row.currentDir,
      priorDirs: JSON.parse(row.priorDirsJson) as string[],
      status: row.status,
      pendingCandidates: row.pendingCandidatesJson ? (JSON.parse(row.pendingCandidatesJson) as string[]) : [],
      firstSeenMs: row.firstSeenMs,
      updatedAtMs: row.updatedAtMs
    }
  }

  listTaskAliases(): TaskAliasRecord[] {
    if (this.ctrl === null) return []
    const rows = this.ctrl.prepare('SELECT taskRef FROM task_aliases').all() as Array<{ taskRef: string }>
    return rows.map((r) => this.getTaskAlias(r.taskRef)).filter((x): x is TaskAliasRecord => x !== null)
  }

  /**
   * 归档续接核验（design §3.1）：原路径消失且唯一同 ID 目标 → 续接；
   * 多候选/复制目录/重复 task ID → 待确认不自动合并；无目标 → missing（数据保留）。
   */
  verifyTaskAliases(known: VerifyAliasesInput[]): VerifyAliasesResult {
    const result: VerifyAliasesResult = { moved: 0, verified: 0, pending: [], missing: 0 }
    if (this.ctrl === null) return result
    const now = Date.now()
    const knownDirs = new Set(known.map((k) => k.dir))
    for (const alias of this.listTaskAliases()) {
      const stillThere = knownDirs.has(alias.currentDir)
      // 同 ID 候选：目录不同于当前、task.json.id 与别名一致（不凭目录名猜）
      const candidates = alias.trellisTaskId === null
        ? []
        : known.filter((k) => k.trellisTaskId === alias.trellisTaskId && k.dir !== alias.currentDir).map((k) => k.dir)
      if (stillThere && candidates.length === 0) {
        result.verified += 1
        continue
      }
      if (!stillThere && candidates.length === 1) {
        // 原路径消失 + 唯一同 ID 目标 → 续接（旧目录留痕）
        const prior = [...alias.priorDirs]
        if (!prior.includes(alias.currentDir)) prior.push(alias.currentDir)
        this.ctrl
          .prepare('UPDATE task_aliases SET currentDir=?, priorDirsJson=?, status=?, pendingCandidatesJson=NULL, updatedAtMs=? WHERE taskRef=?')
          .run(candidates[0], JSON.stringify(prior), 'verified', now, alias.taskRef)
        result.moved += 1
        continue
      }
      if (candidates.length > 0) {
        // 多候选或复制目录（原目录仍在但出现重复 ID）→ 待确认，不自动合并
        this.ctrl
          .prepare('UPDATE task_aliases SET status=?, pendingCandidatesJson=?, updatedAtMs=? WHERE taskRef=?')
          .run('pending_confirmation', JSON.stringify(candidates), now, alias.taskRef)
        result.pending.push({ taskRef: alias.taskRef, candidates })
        continue
      }
      if (!stillThere) {
        this.ctrl.prepare('UPDATE task_aliases SET status=?, updatedAtMs=? WHERE taskRef=?').run('missing', now, alias.taskRef)
        result.missing += 1
      }
    }
    return result
  }
}

/* ---------------- 内部 ---------------- */

interface EventRow {
  seq: number
  eventId: string
  injectionId: string
  kind: string
  occurredAtMs: number
  receivedAtMs: number
  payload: string
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i === -1 ? p : p.slice(i + 1)
}

/**
 * 单事件编码预算删减（design §4.3）：丢弃 materials 明细、遗漏数并入 totals、
 * 完整性标 partial（not_applicable 保持）；汇总仍超限由调用方跳过并记诊断。
 */
export function trimEventForStore(
  event: ContextEventV1,
  limitBytes: number
): { event: ContextEventV1; omitted: number; trimmed: boolean } {
  const direct = JSON.stringify(event)
  if (utf8Bytes(direct) <= limitBytes) return { event, omitted: 0, trimmed: false }
  const omitted = event.materials.length
  const trimmedEvent: ContextEventV1 = {
    ...event,
    materials: [],
    totals: {
      ...event.totals,
      omittedEntries: event.totals.omittedEntries + omitted,
      completeness: event.totals.completeness === 'not_applicable' ? 'not_applicable' : 'partial'
    }
  }
  return { event: trimmedEvent, omitted, trimmed: true }
}

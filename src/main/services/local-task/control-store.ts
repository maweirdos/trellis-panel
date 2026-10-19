import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import {
  CONTROL_SCHEMA_V1_DDL,
  STORE_DB_VERSION,
  readTaskAliasRecord,
  redactText,
  upsertTaskAliasRecord,
  type TaskAliasRecord
} from '../observability/store-core'
import type { LocalOperationKey, LocalOperationPayload, LocalOperationRow, LocalTaskStage } from './types'

/**
 * LocalTaskService 的控制库连接（design §7.2，复用 G3 control.sqlite 骨架）。
 *
 * 通道选择（与 observability worker 二选一，本片取独立连接）：
 * 1. LocalTaskService 必须在观测未绑定/未启用的项目可用（G3 铁律：观测禁用不影响
 *    LocalTaskService）；observation worker 只在有绑定的项目打开时存在，且其 init 会
 *    顺带打开/创建 observations.sqlite——未绑定项目经 worker 通道会制造观测库文件，
 *    或需要为 worker 增加 control-only 引导模式（更大的 G3 协议改动）。
 * 2. 控制库操作都是用户显式动作触发的单行短事务（synchronous=FULL 下毫秒级 fsync），
 *    频度低、时长有界，不构成 G1-B 关注的主进程长事务；busy_timeout=2000 与
 *    observation worker 的控制库连接共存（journal=DELETE 双连接短锁）。
 * 3. schema 复用 store-core 导出的 CONTROL_SCHEMA_V1_DDL：单一建表权威，跨版本时
 *    高于本程序理解的版本只读拒绝（与 G3 口径一致）。
 *
 * 语义红线：控制库打开/提交失败 → 上层不得调用 CLI（不产生创建副作用）。
 */
export class LocalControlStore {
  private readonly runtimeDir: string
  private db: DatabaseSync | null = null
  private state: 'not_initialized' | 'active' | 'future_version' | 'corrupted' | 'closed' = 'not_initialized'

  constructor(runtimeDir: string) {
    this.runtimeDir = runtimeDir
  }

  controlDbPath(): string {
    return join(this.runtimeDir, 'control.sqlite')
  }

  get currentState(): typeof this.state {
    return this.state
  }

  open(): void {
    mkdirSync(this.runtimeDir, { recursive: true })
    const path = this.controlDbPath()
    let db: DatabaseSync | null = null
    try {
      db = new DatabaseSync(path)
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000;')
    } catch (e) {
      this.closeQuietly(db)
      this.state = 'corrupted'
      throw new Error(`控制库打开失败：${redactText(e instanceof Error ? e.message : String(e))}`)
    }
    try {
      // 版本读取前先探表：全新库尚无 control_schema_meta（与 G3 openControl 同口径）
      const hasMeta = (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='control_schema_meta'").get() as
          | { name: string }
          | undefined
      ) !== undefined
      let current = 0
      if (hasMeta) {
        const row = db
          .prepare("SELECT value FROM control_schema_meta WHERE key='dbVersion'")
          .get() as { value: string } | undefined
        current = row ? Number(row.value) : 0
      }
      if (current > STORE_DB_VERSION) {
        // 未来版本：只读拒绝（不降级写入）
        this.closeQuietly(db)
        this.state = 'future_version'
        throw new Error('控制库由更新版本的 Panel 创建（版本不兼容），本版本拒绝写入')
      }
      if (current < STORE_DB_VERSION) {
        db.exec('BEGIN IMMEDIATE')
        try {
          db.exec(CONTROL_SCHEMA_V1_DDL)
          db.exec('COMMIT')
        } catch (e) {
          db.exec('ROLLBACK')
          throw e
        }
        db.prepare("INSERT OR REPLACE INTO control_schema_meta(key, value) VALUES('dbVersion', ?)").run(String(STORE_DB_VERSION))
      }
      this.db = db
      this.state = 'active'
    } catch (e) {
      this.closeQuietly(db)
      if (this.state === 'future_version') throw e
      this.state = 'corrupted'
      throw new Error(`控制库初始化失败：${redactText(e instanceof Error ? e.message : String(e))}`)
    }
  }

  private closeQuietly(db: DatabaseSync | null): void {
    if (db === null) return
    try {
      db.close()
    } catch {
      /* already broken */
    }
  }

  close(): void {
    this.closeQuietly(this.db)
    this.db = null
    this.state = 'closed'
  }

  private requireDb(): DatabaseSync {
    if (this.db === null || this.state !== 'active') throw new Error(`控制库不可用（${this.state}）`)
    return this.db
  }

  getOperation(operationId: string): LocalOperationRow | null {
    const db = this.requireDb()
    const row = db
      .prepare('SELECT operationId, workspaceId, stage, payloadJson, createdAtMs, updatedAtMs FROM local_operations WHERE operationId=?')
      .get(operationId) as
      | { operationId: string; workspaceId: string; stage: string; payloadJson: string; createdAtMs: number; updatedAtMs: number }
      | undefined
    if (row === undefined) return null
    return {
      operationId: row.operationId,
      workspaceId: row.workspaceId,
      stage: row.stage as LocalTaskStage,
      payload: JSON.parse(row.payloadJson) as LocalOperationPayload,
      createdAtMs: row.createdAtMs,
      updatedAtMs: row.updatedAtMs
    }
  }

  /** 按操作键取全部操作记录（同键不同新增序号）。 */
  findOperationsByKey(key: Omit<LocalOperationKey, 'ordinal'>): LocalOperationRow[] {
    const db = this.requireDb()
    const rows = db
      .prepare('SELECT operationId FROM local_operations WHERE workspaceId=?')
      .all(key.workspaceId) as Array<{ operationId: string }>
    const out: LocalOperationRow[] = []
    for (const r of rows) {
      const row = this.getOperation(r.operationId)
      if (row === null) continue
      const p = row.payload.operationKey
      if (p.instanceId === key.instanceId && p.issueIdentifier === key.issueIdentifier) out.push(row)
    }
    return out.sort((a, b) => a.payload.operationKey.ordinal - b.payload.operationKey.ordinal)
  }

  maxOrdinal(key: Omit<LocalOperationKey, 'ordinal'>): number {
    const rows = this.findOperationsByKey(key)
    return rows.length === 0 ? 0 : Math.max(...rows.map((r) => r.payload.operationKey.ordinal))
  }

  /** 提交操作记录（控制库提交成功是调用 CLI 的前置，design §7.2）。 */
  insertOperation(operationId: string, workspaceId: string, stage: LocalTaskStage, payload: LocalOperationPayload): LocalOperationRow {
    const db = this.requireDb()
    const now = Date.now()
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('INSERT INTO local_operations(operationId, workspaceId, stage, payloadJson, createdAtMs, updatedAtMs) VALUES(?,?,?,?,?,?)').run(
        operationId,
        workspaceId,
        stage,
        JSON.stringify(payload),
        now,
        now
      )
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    const row = this.getOperation(operationId)
    if (row === null) throw new Error('控制库提交后读取失败')
    return row
  }

  /** 阶段推进/预备目录原子更新（单语句单事务）。 */
  updateOperation(operationId: string, stage: LocalTaskStage, patch: Partial<LocalOperationPayload>): LocalOperationRow {
    const db = this.requireDb()
    const existing = this.getOperation(operationId)
    if (existing === null) throw new Error(`操作记录不存在: ${operationId}`)
    const next: LocalOperationPayload = { ...existing.payload, ...patch }
    const now = Date.now()
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('UPDATE local_operations SET stage=?, payloadJson=?, updatedAtMs=? WHERE operationId=?').run(
        stage,
        JSON.stringify(next),
        now,
        operationId
      )
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    const row = this.getOperation(operationId)
    if (row === null) throw new Error('控制库更新后读取失败')
    return row
  }

  /** 来源关联登记（source_links；清理观测不得触碰，design §4.2）。 */
  insertSourceLink(input: {
    workspaceId: string
    sourceKind: string
    sourceKey: string
    taskRef: string
    payload: Record<string, unknown>
  }): void {
    const db = this.requireDb()
    db.prepare('INSERT INTO source_links(workspaceId, sourceKind, sourceKey, taskRef, payloadJson, createdAtMs) VALUES(?,?,?,?,?,?)').run(
      input.workspaceId,
      input.sourceKind,
      input.sourceKey,
      input.taskRef,
      JSON.stringify(input.payload),
      Date.now()
    )
  }

  /** TPD-025: integration links share stable task aliases, never observation retention. */
  listIntegrationLinks(workspaceId: string, taskRef: string): Array<{ id: number; payload: unknown; createdAt: number }> {
    return this.requireDb().prepare("SELECT id, payloadJson, createdAtMs FROM source_links WHERE workspaceId=? AND taskRef=? AND sourceKind='integration.pull_request' ORDER BY id DESC LIMIT 100").all(workspaceId, taskRef).map((row) => {
      let payload: unknown = null
      try { payload = JSON.parse(String(row.payloadJson)) } catch { /* malformed entries remain on disk */ }
      return { id: Number(row.id), payload, createdAt: Number(row.createdAtMs) }
    })
  }

  upsertIntegrationLink(workspaceId: string, taskRef: string, sourceKey: string, payload: Record<string, unknown>): void {
    const db = this.requireDb()
    db.exec('BEGIN IMMEDIATE')
    try {
      const found = db.prepare("SELECT id FROM source_links WHERE workspaceId=? AND taskRef=? AND sourceKind='integration.pull_request' AND sourceKey=? LIMIT 1").get(workspaceId, taskRef, sourceKey)
      if (found) db.prepare('UPDATE source_links SET payloadJson=? WHERE id=?').run(JSON.stringify(payload), found.id)
      else {
        const count = db.prepare("SELECT count(*) AS n FROM source_links WHERE workspaceId=? AND taskRef=? AND sourceKind='integration.pull_request'").get(workspaceId, taskRef)
        if (Number(count?.n ?? 0) >= 100) throw new Error('一个工作项最多关联 100 个远端对象')
        this.insertSourceLink({ workspaceId, taskRef, sourceKind: 'integration.pull_request', sourceKey, payload })
      }
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }

  removeIntegrationLink(workspaceId: string, taskRef: string, id: number): void {
    this.requireDb().prepare("DELETE FROM source_links WHERE id=? AND workspaceId=? AND taskRef=? AND sourceKind='integration.pull_request'").run(id, workspaceId, taskRef)
  }

  upsertAlias(taskRef: string, trellisTaskId: string | null, dir: string): TaskAliasRecord | null {
    const db = this.requireDb()
    return upsertTaskAliasRecord(db, taskRef, trellisTaskId, dir)
  }

  getAlias(taskRef: string): TaskAliasRecord | null {
    const db = this.requireDb()
    return readTaskAliasRecord(db, taskRef)
  }
}

/** 项目 runtime 目录（<root>/.trellis/.panel/runtime；与 observability/identity.ensureRuntimeDir 同规则）。 */
export function localRuntimeDirOf(root: string): string {
  return join(root, '.trellis', '.panel', 'runtime')
}

/** 控制库文件是否已存在（不创建）。 */
export function controlDbExists(root: string): boolean {
  return existsSync(join(localRuntimeDirOf(root), 'control.sqlite'))
}

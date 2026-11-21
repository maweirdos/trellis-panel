/** Only the owned worker opens this private team-client database. */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { TEAM_MAX_DOCUMENT_BYTES, TEAM_MAX_REQUEST_BYTES, publicationInputSchema, teamDeviceSchema, teamFeedbackInputSchema, teamFeedbackSchema, teamMaterialVersionSchema, teamPublishedDocumentSchema } from '../../../shared/team-platform'
import { desktopTeamAccountIdSchema } from '../../../shared/team-desktop-account'
import { teamInvitationSchema } from '../../../shared/team-invitations'
import { type DesktopTeamOutboxPage, type DesktopTeamSnapshot } from '../../../shared/team-desktop'
import { DesktopTeamError, MAX_CACHE_BYTES, MAX_OUTBOX_BYTES, accountRecordSchema, bindingSchema, connectionRecordSchema, invitationIntentRecordSchema, organizationIntentRecordSchema, outboxInputSchema, publicOutbox, type AccountRecord, type CachedDocument, type ConnectionRecord, type InvitationIntentRecord, type OrganizationIntentRecord, type OutboxBinding, type OutboxRecord, type WorkerOperation } from './types'
import { canonicalTeamJson, verifyTeamDocument } from './codec'
import { desktopExecutionIntentSchema, desktopExecutionPendingInputSchema, desktopExecutionPendingPageSchema, DESKTOP_EXECUTION_PENDING_MAX_BYTES, teamTaskIdentity } from '../../../shared/team-task-execution'

const id = z.string().uuid(), timestamp = z.number().int().nonnegative().safe()
const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
const bindingFor = (c: ConnectionRecord): OutboxBinding => bindingSchema.parse({ origin: c.origin, pairingId: c.pairingId, deviceId: c.deviceId, projectId: c.projectId, ownerId: c.ownerId })
const active = (c: ConnectionRecord): void => { if (c.state !== 'active' || c.accessLocked) throw new DesktopTeamError('ACCESS_LOCKED', '原设备绑定未处于可用状态，不能更换身份发送历史操作') }
const states = ['queued', 'dispatching', 'acknowledgement-unknown', 'committed', 'conflict', 'access-revoked', 'cancelled-before-dispatch'] as const
const recordSchema = z.object({
  commandId: id, connectionId: id, kind: z.enum(['publication', 'feedback']), state: z.enum(states), materialId: id, version: z.number().int().positive().nullable(), title: z.string().max(300).nullable(), createdAt: timestamp, updatedAt: timestamp,
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/), lastErrorCode: z.string().max(200).nullable(), attempts: z.number().int().nonnegative().safe(), reconciliation: z.enum(['not-checked', 'missing-at-read-point', 'committed']), reconciledAt: timestamp.nullable(),
  outcomeUnknown: z.boolean(),
  receipt: z.union([teamMaterialVersionSchema, teamFeedbackSchema]).nullable(), binding: bindingSchema, payload: z.union([publicationInputSchema, teamFeedbackInputSchema])
}).strict()
const syncSchema = z.object({ cursor: z.string().max(2048).nullable(), resetRequired: z.boolean(), resetCursor: z.string().max(2048).nullable(), hasMore: z.boolean().default(true), snapshot: z.object({ items: z.array(teamMaterialVersionSchema).max(1000), fetchedAt: timestamp }).strict().nullable() }).strict()
const cachedSchema = z.object({ document: teamPublishedDocumentSchema, fetchedAt: timestamp }).strict()
type Sync = z.infer<typeof syncSchema>
const emptySync = (): Sync => ({ cursor: null, resetRequired: true, resetCursor: null, hasMore: true, snapshot: null })

export class DesktopTeamStoreCore {
  private readonly db: DatabaseSync
  private readonly storeId: string
  constructor(dataDir: string) {
    const directory = resolve(dataDir)
    if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new DesktopTeamError('STORE_PATH', '团队本地存储目录不能是重定向路径')
    mkdirSync(directory, { recursive: true })
    const path = join(realpathSync.native(directory), 'team-desktop.sqlite'), fresh = !existsSync(path)
    for (const file of [path, path + '-journal', path + '-wal', path + '-shm']) if (existsSync(file) && (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile())) throw new DesktopTeamError('STORE_PATH', '团队本地存储文件无法核实')
    this.db = new DatabaseSync(path)
    try {
      this.db.exec('PRAGMA busy_timeout=50')
      const storedVersion = fresh ? 0 : Number(this.db.prepare('PRAGMA user_version').get()?.user_version)
      if (!fresh) {
        if (this.db.prepare('PRAGMA application_id').get()?.application_id !== 0x54445431 || ![1, 2, 3, 4, 5, 6].includes(storedVersion)) throw new DesktopTeamError('STORE_VERSION', '团队本地存储版本未知，原文件已保留')
        if (this.db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new DesktopTeamError('CORRUPT_STORE', '团队本地存储完整性检查失败，原文件已保留')
      }
      this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON')
      if (fresh) this.transaction(() => {
        this.db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE accounts(id TEXT PRIMARY KEY,origin TEXT NOT NULL,userId TEXT NOT NULL,updatedAt INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(origin,userId)); CREATE TABLE invitation_intents(commandId TEXT PRIMARY KEY,accountId TEXT NOT NULL,createdAt INTEGER NOT NULL,data TEXT NOT NULL); CREATE TABLE connections(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE commands(id TEXT PRIMARY KEY,connectionId TEXT NOT NULL,createdAt INTEGER NOT NULL,data TEXT NOT NULL,bytes INTEGER NOT NULL); CREATE INDEX commands_owner ON commands(connectionId,createdAt,id); CREATE TABLE aliases(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE documents(key TEXT PRIMARY KEY,connectionId TEXT NOT NULL,data TEXT NOT NULL,bytes INTEGER NOT NULL); CREATE TABLE sync(connectionId TEXT PRIMARY KEY,data TEXT NOT NULL); PRAGMA application_id=1413764145; PRAGMA user_version=3')
        this.db.prepare('INSERT INTO meta VALUES(?,?)').run('storeId', randomUUID())
      })
      if (storedVersion === 1) this.transaction(() => {
        this.db.exec('CREATE TABLE accounts(id TEXT PRIMARY KEY,origin TEXT NOT NULL,userId TEXT NOT NULL,updatedAt INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(origin,userId)); CREATE TABLE invitation_intents(commandId TEXT PRIMARY KEY,accountId TEXT NOT NULL,createdAt INTEGER NOT NULL,data TEXT NOT NULL); PRAGMA user_version=3')
      })
      if (storedVersion === 2) this.transaction(() => {
        this.db.exec('CREATE TABLE invitation_intents(commandId TEXT PRIMARY KEY,accountId TEXT NOT NULL,createdAt INTEGER NOT NULL,data TEXT NOT NULL); PRAGMA user_version=3')
      })
      this.storeId = id.parse(this.db.prepare('SELECT value FROM meta WHERE key=?').get('storeId')?.value)
      if (storedVersion < 4) this.transaction(() => {
        this.db.exec('CREATE TABLE execution_intents(commandId TEXT PRIMARY KEY,connectionId TEXT NOT NULL,data TEXT NOT NULL); CREATE INDEX execution_intents_owner ON execution_intents(connectionId); PRAGMA user_version=4')
      })
      if (storedVersion < 5) this.transaction(() => {
        this.db.exec("CREATE INDEX execution_intents_pending ON execution_intents(connectionId) WHERE json_extract(data,'$.state')<>'committed'; PRAGMA user_version=5")
      })
      if (storedVersion < 6) this.transaction(() => {
        this.db.exec("CREATE TABLE organization_intents(intentKey TEXT PRIMARY KEY,accountId TEXT NOT NULL,data TEXT NOT NULL); PRAGMA user_version=6")
      })
      this.db.prepare("UPDATE execution_intents SET data=json_set(data,'$.state','acknowledgement-unknown') WHERE json_extract(data,'$.state')='dispatching'").run()
      this.transaction(() => {
        for (const row of this.db.prepare('SELECT id FROM commands').all()) {
          const record = this.command(String(row.id))
          if (record.state === 'dispatching') this.saveCommand({ ...record, state: 'acknowledgement-unknown', outcomeUnknown: true, updatedAt: Date.now(), lastErrorCode: 'PROCESS_RESTART_AFTER_DISPATCH' })
        }
      })
    } catch (error) { this.db.close(); throw error }
  }
  close(): void { this.db.close() }
  private transaction<T>(work: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = work(); this.db.exec('COMMIT'); return result } catch (error) { this.db.exec('ROLLBACK'); throw error } }
  private parseCommand(raw: unknown): OutboxRecord {
    const value = recordSchema.parse(JSON.parse(z.string().parse(raw)))
    if (value.commandId !== value.payload.commandId || value.materialId !== value.payload.materialId || digest(canonicalTeamJson(value.payload)) !== value.payloadDigest || (value.kind === 'publication') !== ('projectId' in value.payload)) throw new DesktopTeamError('CORRUPT_STORE', '团队操作的固定载荷与身份不匹配')
    return value
  }
  private saveCommand(value: OutboxRecord, admitting = false): void {
    recordSchema.parse(value)
    const data = JSON.stringify(value), bytes = Buffer.byteLength(data), previous = Number(this.db.prepare('SELECT bytes FROM commands WHERE id=?').get(value.commandId)?.bytes ?? 0)
    const used = Number(this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS used FROM commands').get()?.used ?? 0)
    // New payload admission leaves a separate bounded receipt/status reserve.
    // Filling the queue must never prevent recording an already-sent outcome.
    const limit = admitting ? MAX_OUTBOX_BYTES : MAX_OUTBOX_BYTES * 2 + 8 * 1024 * 1024
    if (used - previous + bytes > limit) throw new DesktopTeamError('CAPACITY_EXCEEDED', '团队操作记录容量已满，请保留记录并处理归档，不能丢弃未知操作')
    this.db.prepare('INSERT INTO commands VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,bytes=excluded.bytes').run(value.commandId, value.connectionId, value.createdAt, data, bytes)
  }
  private account(accountId: string): AccountRecord {
    const row = this.db.prepare('SELECT origin,userId,updatedAt,data FROM accounts WHERE id=?').get(id.parse(accountId))
    if (!row) throw new DesktopTeamError('NOT_FOUND', '未找到原桌面账号')
    const value = accountRecordSchema.parse(JSON.parse(String(row.data)))
    if (value.accountId !== accountId || value.origin !== row.origin || value.person.userId !== row.userId || value.updatedAt !== row.updatedAt) throw new DesktopTeamError('CORRUPT_STORE', '桌面账号与持久化查询键不一致；原记录已保留')
    return value
  }
  private invitationIntent(commandId: string): InvitationIntentRecord {
    const row = this.db.prepare('SELECT accountId,createdAt,data FROM invitation_intents WHERE commandId=?').get(id.parse(commandId))
    if (!row) throw new DesktopTeamError('NOT_FOUND', '未找到原邀请创建意图')
    const value = invitationIntentRecordSchema.parse(JSON.parse(String(row.data)))
    if (value.commandId !== commandId || value.accountId !== row.accountId || value.createdAt !== row.createdAt) throw new DesktopTeamError('CORRUPT_STORE', '邀请创建意图与持久化查询键不一致；原记录已保留')
    return value
  }
  private organizationIntent(intentKey: string): OrganizationIntentRecord {
    const key = z.string().regex(/^[a-f0-9]{64}$/).parse(intentKey)
    const row = this.db.prepare('SELECT accountId,data FROM organization_intents WHERE intentKey=?').get(key)
    if (!row) throw new DesktopTeamError('NOT_FOUND', '未找到原组织创建意图')
    const value = organizationIntentRecordSchema.parse(JSON.parse(String(row.data)))
    if (value.intentKey !== key || value.accountId !== row.accountId) throw new DesktopTeamError('CORRUPT_STORE', '组织创建意图与持久化查询键不一致；原记录已保留')
    return value
  }
  private connection(connectionId: string): ConnectionRecord {
    const row = this.db.prepare('SELECT data FROM connections WHERE id=?').get(id.parse(connectionId))
    if (!row) throw new DesktopTeamError('NOT_FOUND', '未找到原设备绑定')
    const value = connectionRecordSchema.parse(JSON.parse(String(row.data)))
    if (value.connectionId !== connectionId) throw new DesktopTeamError('CORRUPT_STORE', '团队绑定身份不一致')
    return value
  }
  private command(commandId: string): OutboxRecord {
    const row = this.db.prepare('SELECT connectionId,createdAt,data FROM commands WHERE id=?').get(id.parse(commandId))
    if (!row) throw new DesktopTeamError('NOT_FOUND', '未找到原团队操作')
    const record = this.parseCommand(row.data)
    if (record.commandId !== commandId || record.connectionId !== row.connectionId || record.createdAt !== row.createdAt) throw new DesktopTeamError('CORRUPT_STORE', '团队操作载荷与持久化查询键或设备范围不一致；原记录已保留')
    return record
  }
  private saveConnection(c: ConnectionRecord): void { this.db.prepare('INSERT INTO connections VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(c.connectionId, JSON.stringify(connectionRecordSchema.parse(c))) }
  private sync(connectionId: string): Sync {
    const row = this.db.prepare('SELECT data FROM sync WHERE connectionId=?').get(connectionId)
    const value = row ? syncSchema.parse(JSON.parse(String(row.data))) : emptySync()
    if (value.snapshot) {
      const c = this.connection(connectionId)
      if (value.snapshot.items.some((item) => item.projectId !== c.projectId || (item.visibility === 'personal' && item.ownerId !== c.ownerId))) throw new DesktopTeamError('CORRUPT_STORE', '共享快照缓存不属于原设备的项目或人员范围；原记录已保留')
    }
    return value
  }
  private saveSync(connectionId: string, value: Sync): void { this.db.prepare('INSERT INTO sync VALUES(?,?) ON CONFLICT(connectionId) DO UPDATE SET data=excluded.data').run(connectionId, JSON.stringify(syncSchema.parse(value))) }
  private executionIntent(connectionId: string, commandId: string): z.infer<typeof desktopExecutionIntentSchema> | null {
    const row = this.db.prepare('SELECT data FROM execution_intents WHERE connectionId=? AND commandId=?').get(connectionId, commandId)
    if (!row) return null
    const record = desktopExecutionIntentSchema.parse(JSON.parse(String(row.data)))
    if (record.connectionId !== connectionId || record.command.commandId !== commandId) throw new DesktopTeamError('CORRUPT_STORE', '执行恢复记录与原查询身份不一致')
    return record
  }
  private executionPending(raw: unknown): z.infer<typeof desktopExecutionPendingPageSchema> {
    const input = desktopExecutionPendingInputSchema.parse(raw), connection = this.connection(input.connectionId); active(connection)
    if (connection.projectId !== input.task.projectId) throw new DesktopTeamError('BINDING_CHANGED', '执行恢复任务不属于原连接项目')
    const scope = { connectionId: input.connectionId, task: input.task }, taskKey = teamTaskIdentity(input.task)
    const cursorFor = (after: number): string => Buffer.from(JSON.stringify({ store: this.storeId, connection: input.connectionId, task: taskKey, after })).toString('base64url')
    let after = 0
    if (input.cursor) {
      try {
        const cursor = z.object({ store: id, connection: id, task: z.string(), after: timestamp.positive() }).strict().parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')))
        if (cursor.store !== this.storeId || cursor.connection !== input.connectionId || cursor.task !== taskKey) throw new Error('Foreign cursor')
        after = cursor.after
      } catch { throw new DesktopTeamError('CURSOR_CONFLICT', '执行恢复游标不属于原存储、连接或任务，请重新加载') }
    }
    const taskFilter = "connectionId=? AND json_extract(data,'$.command.task.instanceId')=? AND json_extract(data,'$.command.task.projectId')=? AND json_extract(data,'$.command.task.spaceId')=? AND json_extract(data,'$.command.task.taskId')=? AND json_extract(data,'$.command.task.taskCreatedAt')=?"
    const parameters = [input.connectionId, input.task.instanceId, input.task.projectId, input.task.spaceId, input.task.taskId, input.task.taskCreatedAt]
    if (after && !this.db.prepare(`SELECT rowid FROM execution_intents WHERE ${taskFilter} AND rowid=?`).get(...parameters, after)) throw new DesktopTeamError('CURSOR_CONFLICT', '执行恢复游标的原任务记录不可用')
    // SQL excludes committed history and foreign tasks before any DTO hydration.
    const rows = this.db.prepare(`SELECT rowid,commandId,data FROM execution_intents WHERE ${taskFilter} AND json_extract(data,'$.state')<>'committed' AND rowid>? ORDER BY rowid LIMIT ?`).iterate(...parameters, after, input.limit + 1)
    const items: Array<z.infer<typeof desktopExecutionIntentSchema>> = []
    let lastRow = after, hasMore = false, itemBytes = 0
    for (const row of rows) {
      if (items.length >= input.limit) { hasMore = true; break }
      const record = desktopExecutionIntentSchema.parse(JSON.parse(String(row.data)))
      if (record.connectionId !== input.connectionId || record.command.commandId !== row.commandId || teamTaskIdentity(record.command.task) !== taskKey || record.state === 'committed') throw new DesktopTeamError('CORRUPT_STORE', '执行恢复记录与原任务不一致')
      const rowId = timestamp.positive().parse(row.rowid)
      const recordBytes = Buffer.byteLength(JSON.stringify(record))
      const envelopeBytes = Buffer.byteLength(JSON.stringify({ ...scope, contractVersion: 2, items: [], hasMore: true, nextCursor: cursorFor(rowId) }))
      if (envelopeBytes + itemBytes + recordBytes + items.length > DESKTOP_EXECUTION_PENDING_MAX_BYTES) {
        if (items.length === 0) throw new DesktopTeamError('CAPACITY_EXCEEDED', '单条待核对执行记录超过分页字节限界；原命令已保留，需按原 UUID 核对')
        hasMore = true; break
      }
      items.push(record); lastRow = rowId; itemBytes += recordBytes
    }
    return desktopExecutionPendingPageSchema.parse({ ...scope, contractVersion: 2, items, hasMore, nextCursor: hasMore ? cursorFor(lastRow) : null })
  }
  dispatch(operation: WorkerOperation): unknown {
    const raw = operation.input
    if (operation.op === 'health') return { schemaVersion: 6, storeId: this.storeId }
    if (operation.op === 'execution-intent') {
      const input = z.object({ connectionId: id, commandId: id }).strict().parse(raw); active(this.connection(input.connectionId))
      return this.executionIntent(input.connectionId, input.commandId)
    }
    if (operation.op === 'execution-pending') return this.executionPending(raw)
    if (operation.op === 'save-execution-intent') return this.transaction(() => {
      const input = z.object({ record: desktopExecutionIntentSchema, binding: bindingSchema }).strict().parse(raw), record = input.record
      const connection = this.connection(record.connectionId); active(connection)
      if (canonicalTeamJson(bindingFor(connection)) !== canonicalTeamJson(input.binding) || record.command.expectedActorId !== connection.ownerId || record.command.expectedDeviceId !== connection.deviceId || record.command.task.projectId !== connection.projectId) throw new DesktopTeamError('BINDING_CHANGED', '原执行身份已变化')
      const row = this.db.prepare('SELECT data FROM execution_intents WHERE commandId=?').get(record.command.commandId)
      if (row) {
        const previous = desktopExecutionIntentSchema.parse(JSON.parse(String(row.data)))
        if (previous.connectionId !== record.connectionId || canonicalTeamJson(previous.command) !== canonicalTeamJson(record.command) || teamTaskIdentity(previous.command.task) !== teamTaskIdentity(record.command.task)) throw new DesktopTeamError('COMMAND_CONFLICT', '执行命令不能改换原目标或载荷')
        if (previous.receipt && canonicalTeamJson(previous.receipt) !== canonicalTeamJson(record.receipt)) throw new DesktopTeamError('COMMAND_CONFLICT', '执行回执不可替换')
      } else if (Number(this.db.prepare('SELECT count(*) AS count FROM execution_intents').get()?.count) >= 10000 || Number(this.db.prepare('SELECT COALESCE(SUM(length(CAST(data AS BLOB))),0) AS used FROM execution_intents').get()?.used) + Buffer.byteLength(JSON.stringify(record)) > MAX_OUTBOX_BYTES) throw new DesktopTeamError('CAPACITY_EXCEEDED', '执行恢复记录已达限界')
      this.db.prepare('INSERT INTO execution_intents VALUES(?,?,?) ON CONFLICT(commandId) DO UPDATE SET data=excluded.data').run(record.command.commandId, record.connectionId, JSON.stringify(record))
      return record
    })
    if (operation.op === 'accounts') return this.db.prepare('SELECT id FROM accounts ORDER BY updatedAt DESC,id').all().map((row) => this.account(String(row.id)))
    if (operation.op === 'account') return this.account(id.parse(raw))
    if (operation.op === 'save-account') return this.transaction(() => {
      const input = z.object({ record: accountRecordSchema, expectedRevision: z.number().int().positive().safe().nullable() }).strict().parse(raw)
      const record = input.record, byId = this.db.prepare('SELECT id FROM accounts WHERE id=?').get(record.accountId), byOwner = this.db.prepare('SELECT id FROM accounts WHERE origin=? AND userId=?').get(record.origin, record.person.userId)
      if (byOwner && String(byOwner.id) !== record.accountId) throw new DesktopTeamError('ACCOUNT_CONFLICT', '该服务账号已由另一条本地账号记录持有')
      if (!byId) {
        if (input.expectedRevision !== null || record.revision !== 1) throw new DesktopTeamError('ACCOUNT_CHANGED', '桌面账号版本已变化，请重新加载')
        if (Number(this.db.prepare('SELECT COUNT(*) AS count FROM accounts').get()?.count) >= 50) throw new DesktopTeamError('CAPACITY_EXCEEDED', '桌面团队账号数量已达限界')
      } else {
        const previous = this.account(record.accountId)
        if (input.expectedRevision === null || previous.revision !== input.expectedRevision || record.revision !== previous.revision + 1 || previous.origin !== record.origin || previous.person.userId !== record.person.userId || previous.createdAt !== record.createdAt) throw new DesktopTeamError('ACCOUNT_CHANGED', '桌面账号版本或固定身份已变化，请重新加载')
      }
      this.db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updatedAt=excluded.updatedAt,data=excluded.data').run(record.accountId, record.origin, record.person.userId, record.updatedAt, JSON.stringify(record))
      return record
    })
    if (operation.op === 'invitation-intent') {
      try { return this.invitationIntent(id.parse(raw)) }
      catch (error) { if (error instanceof DesktopTeamError && error.code === 'NOT_FOUND') return null; throw error }
    }
    if (operation.op === 'organization-intent') {
      const input = z.object({ intentKey: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(raw)
      try { return this.organizationIntent(input.intentKey) }
      catch (error) { if (error instanceof DesktopTeamError && error.code === 'NOT_FOUND') return null; throw error }
    }
    if (operation.op === 'save-organization-intent') return this.transaction(() => {
      const record = organizationIntentRecordSchema.parse(raw), account = this.account(record.accountId)
      if (account.origin !== record.origin) throw new DesktopTeamError('BINDING_CHANGED', '组织创建意图不属于原服务账号')
      const existing = this.db.prepare('SELECT intentKey FROM organization_intents WHERE intentKey=?').get(record.intentKey)
      if (existing) {
        const previous = this.organizationIntent(record.intentKey)
        if (previous.accountId !== record.accountId || previous.origin !== record.origin || previous.commandId !== record.commandId || previous.payloadDigest !== record.payloadDigest) throw new DesktopTeamError('COMMAND_CONFLICT', '同一组织创建意图不能更换账号、命令或名称摘要')
        if (previous.updatedAt !== record.updatedAt) this.db.prepare('UPDATE organization_intents SET data=? WHERE intentKey=?').run(JSON.stringify({ ...previous, updatedAt: record.updatedAt }), record.intentKey)
        return { ...previous, updatedAt: record.updatedAt }
      }
      if (Number(this.db.prepare('SELECT COUNT(*) AS count FROM organization_intents').get()?.count) >= 200) throw new DesktopTeamError('CAPACITY_EXCEEDED', '组织创建意图已达限界，请先核对历史创建结果')
      this.db.prepare('INSERT INTO organization_intents VALUES(?,?,?)').run(record.intentKey, record.accountId, JSON.stringify(record))
      return record
    })
    if (operation.op === 'clear-organization-intent') return this.transaction(() => {
      const input = z.object({ intentKey: z.string().regex(/^[a-f0-9]{64}$/), accountId: desktopTeamAccountIdSchema, commandId: z.string().uuid() }).strict().parse(raw)
      const previous = this.organizationIntent(input.intentKey)
      if (previous.accountId !== input.accountId || previous.commandId !== input.commandId) throw new DesktopTeamError('COMMAND_CONFLICT', '组织创建结果不能清除其他账号或另一个原命令')
      this.db.prepare('DELETE FROM organization_intents WHERE intentKey=?').run(input.intentKey)
      return null
    })
    if (operation.op === 'save-invitation-intent') return this.transaction(() => {
      const record = invitationIntentRecordSchema.parse(raw)
      const existing = this.db.prepare('SELECT commandId FROM invitation_intents WHERE commandId=?').get(record.commandId)
      if (existing) {
        const previous = this.invitationIntent(record.commandId)
        if (previous.accountId !== record.accountId || previous.origin !== record.origin || previous.payloadDigest !== record.payloadDigest) throw new DesktopTeamError('COMMAND_CONFLICT', '同一邀请命令不能更换账号或语义载荷')
        return previous
      }
      const data = JSON.stringify(record), used = Number(this.db.prepare('SELECT COALESCE(SUM(length(data)),0) AS used FROM invitation_intents').get()?.used ?? 0)
      if (Number(this.db.prepare('SELECT COUNT(*) AS count FROM invitation_intents').get()?.count) >= 500 || used + Buffer.byteLength(data) > 32 * 1024 * 1024) throw new DesktopTeamError('CAPACITY_EXCEEDED', '加密邀请意图记录已达限界，请先处理已有邀请')
      this.db.prepare('INSERT INTO invitation_intents VALUES(?,?,?,?)').run(record.commandId, record.accountId, record.createdAt, data)
      return record
    })
    if (operation.op === 'complete-invitation-intent') return this.transaction(() => {
      const input = z.object({ commandId: id, receipt: teamInvitationSchema }).strict().parse(raw), previous = this.invitationIntent(input.commandId)
      if (previous.receipt && canonicalTeamJson(previous.receipt) !== canonicalTeamJson(input.receipt)) throw new DesktopTeamError('IMMUTABLE_CONFLICT', '同一邀请命令返回了不同的提交回执')
      const next = invitationIntentRecordSchema.parse({ ...previous, updatedAt: Date.now(), receipt: input.receipt })
      this.db.prepare('UPDATE invitation_intents SET data=? WHERE commandId=?').run(JSON.stringify(next), next.commandId)
      return next
    })
    if (operation.op === 'connection-by-approval-command') {
      const commandId = id.parse(raw)
      for (const row of this.db.prepare('SELECT data FROM connections ORDER BY rowid').all()) {
        const value = connectionRecordSchema.parse(JSON.parse(String(row.data)))
        if (value.approvalCommandId === commandId) return value
      }
      return null
    }
    if (operation.op === 'connections') return this.db.prepare('SELECT data FROM connections ORDER BY rowid').all().map((row) => connectionRecordSchema.parse(JSON.parse(String(row.data))))
    if (operation.op === 'connection') return this.connection(id.parse(raw))
    if (operation.op === 'add-connection') return this.transaction(() => {
      const c = connectionRecordSchema.parse(raw)
      if (c.state !== 'pending' || c.ownerId || c.sequence !== -1 || c.accessGeneration !== 0 || c.remoteDevice || c.accessLocked) throw new DesktopTeamError('INVALID_INPUT', '新配对必须保留待批准状态')
      if ((c.accountId === null) !== (c.approvalCommandId === null)) throw new DesktopTeamError('INVALID_INPUT', '原生账号批准必须同时固定账号与命令')
      if (c.accountId !== null) {
        const account = this.account(c.accountId)
        if (account.origin !== c.origin || account.state !== 'active' || c.projectId === null) throw new DesktopTeamError('BINDING_CHANGED', '候选设备不属于原账号服务或选定工作区')
      }
      if (c.approvalCommandId !== null && this.dispatch({ op: 'connection-by-approval-command', input: c.approvalCommandId }) !== null) throw new DesktopTeamError('COMMAND_CONFLICT', '该设备批准命令已绑定另一候选设备')
      if (Number(this.db.prepare('SELECT COUNT(*) AS count FROM connections').get()?.count) >= 100) throw new DesktopTeamError('CAPACITY_EXCEEDED', '团队设备绑定记录已达限界')
      if (this.db.prepare('SELECT id FROM connections WHERE id=?').get(c.connectionId)) throw new DesktopTeamError('CONFLICT', '绑定身份已存在')
      this.saveConnection(c); return c
    })
    if (operation.op === 'update-connection') return this.transaction(() => {
      const input = z.object({ connectionId: id, expectedConnection: connectionRecordSchema.optional(), device: z.unknown().optional(), network: z.enum(['reachable', 'offline']).optional(), errorCode: z.string().max(200).nullable().optional(), lock: z.boolean().optional(), revokeOutbox: z.boolean().optional(), disconnect: z.boolean().optional(), nextPollAt: timestamp.optional() }).strict().parse(raw)
      const c = this.connection(input.connectionId)
      if (input.expectedConnection && canonicalTeamJson(c) !== canonicalTeamJson(input.expectedConnection)) throw new DesktopTeamError('BINDING_CHANGED', '原连接在核对期间变化，迟到验证不能覆盖当前授权')
      if (c.accessGeneration === Number.MAX_SAFE_INTEGER && input.device !== undefined && teamDeviceSchema.parse(input.device).status === 'active') throw new DesktopTeamError('ACCESS_LOCKED', '连接失权版本已达限界，原连接不能恢复')
      return this.updateConnection(c, input)
    })
    if (operation.op === 'reserve-heartbeat') return this.transaction(() => { const c = this.connection(id.parse(raw)); active(c); c.sequence++; if (!Number.isSafeInteger(c.sequence)) throw new DesktopTeamError('CAPACITY_EXCEEDED', '心跳序号已达限界'); this.saveConnection(c); return c })
    if (operation.op === 'alias') return this.transaction(() => {
      const input = z.object({ connectionId: id, kind: z.enum(['repository', 'workspace', 'task', 'version']), value: z.string().min(1).max(8192) }).strict().parse(raw)
      active(this.connection(input.connectionId))
      const key = digest(canonicalTeamJson(input)), old = this.db.prepare('SELECT value FROM aliases WHERE key=?').get(key)
      if (old) return id.parse(old.value)
      if (Number(this.db.prepare('SELECT COUNT(*) AS count FROM aliases').get()?.count) >= 20000) throw new DesktopTeamError('CAPACITY_EXCEEDED', '本地来源映射数量已达限界')
      const value = randomUUID(); this.db.prepare('INSERT INTO aliases VALUES(?,?)').run(key, value); return value
    })
    if (operation.op === 'enqueue') return this.transaction(() => {
      const input = outboxInputSchema.parse(raw), c = this.connection(input.connectionId); active(c)
      if (canonicalTeamJson(input.binding) !== canonicalTeamJson(bindingFor(c))) throw new DesktopTeamError('BINDING_CHANGED', '原发布身份与当前绑定不一致')
      if ((input.kind === 'publication') !== ('projectId' in input.payload)) throw new DesktopTeamError('INVALID_INPUT', '操作类型与固定载荷不一致')
      const payload = input.payload
      if ('projectId' in payload && (payload.projectId !== c.projectId || Buffer.byteLength(payload.text, 'utf8') > TEAM_MAX_DOCUMENT_BYTES || digest(payload.text) !== payload.expectedDigest)) throw new DesktopTeamError('BODY_MISMATCH', '待发布正文、摘要或项目不一致')
      if (Buffer.byteLength(JSON.stringify(payload)) > TEAM_MAX_REQUEST_BYTES) throw new DesktopTeamError('CAPACITY_EXCEEDED', '发布请求的 JSON 封装超过限界')
      const hash = digest(canonicalTeamJson(payload)), existing = this.db.prepare('SELECT data FROM commands WHERE id=?').get(payload.commandId)
      if (existing) {
        const old = this.parseCommand(existing.data)
        if (old.connectionId !== input.connectionId || old.kind !== input.kind || old.payloadDigest !== hash || canonicalTeamJson(old.binding) !== canonicalTeamJson(input.binding)) throw new DesktopTeamError('COMMAND_CONFLICT', '同一个命令不能替换身份或正文')
        return publicOutbox(old)
      }
      if (Number(this.db.prepare('SELECT COUNT(*) AS count FROM commands').get()?.count) >= 2000) throw new DesktopTeamError('CAPACITY_EXCEEDED', '团队操作记录数量已达限界')
      const now = Date.now(), record: OutboxRecord = { ...input, commandId: payload.commandId, payloadDigest: hash, materialId: payload.materialId, version: 'version' in payload ? payload.version : payload.expectedVersion, title: 'title' in payload ? payload.title : null,
        state: 'queued', outcomeUnknown: false, createdAt: now, updatedAt: now, attempts: 0, reconciliation: 'not-checked', reconciledAt: null, lastErrorCode: null, receipt: null }
      this.saveCommand(record, true); return publicOutbox(record)
    })
    if (operation.op === 'command') return this.command(id.parse(raw))
    if (operation.op === 'outbox') return this.outbox(raw)
    if (operation.op === 'reverify-command') return this.transaction(() => {
      const record = this.command(id.parse(raw)), c = this.connection(record.connectionId); active(c)
      if (record.state !== 'access-revoked' || canonicalTeamJson(record.binding) !== canonicalTeamJson(bindingFor(c))) throw new DesktopTeamError('BINDING_CHANGED', '只能明确重新核对原账号、设备和项目下的受限操作')
      const next: OutboxRecord = { ...record, state: record.outcomeUnknown ? 'acknowledgement-unknown' : 'queued', updatedAt: Date.now(), lastErrorCode: 'ORIGINAL_BINDING_REVERIFIED', reconciliation: 'not-checked', reconciledAt: null }
      this.saveCommand(next); return next
    })
    if (operation.op === 'claim') return this.transaction(() => {
      const input = z.object({ commandId: id, retryUnknown: z.boolean().default(false) }).strict().parse(raw), record = this.command(input.commandId), c = this.connection(record.connectionId); active(c)
      if (canonicalTeamJson(record.binding) !== canonicalTeamJson(bindingFor(c))) throw new DesktopTeamError('BINDING_CHANGED', '原操作不能换用新的账号或项目')
      if (record.state !== 'queued' && !(record.state === 'acknowledgement-unknown' && input.retryUnknown && record.reconciliation === 'missing-at-read-point' && record.reconciledAt !== null && record.reconciledAt >= record.updatedAt)) throw new DesktopTeamError('RECONCILE_REQUIRED', '操作已派发或未完成核对，不能创建第二个发送意图')
      const next: OutboxRecord = { ...record, state: 'dispatching', outcomeUnknown: true, attempts: record.attempts + 1, reconciliation: 'not-checked', reconciledAt: null, updatedAt: Date.now(), lastErrorCode: null }
      this.saveCommand(next); return next
    })
    if (operation.op === 'cancel') return this.transaction(() => { const record = this.command(id.parse(raw)); if (record.state !== 'queued') throw new DesktopTeamError('RECONCILE_REQUIRED', '已派发操作不能作为未发送取消'); const next: OutboxRecord = { ...record, state: 'cancelled-before-dispatch', updatedAt: Date.now() }; this.saveCommand(next); return publicOutbox(next) })
    if (operation.op === 'outcome') return this.transaction(() => {
      const input = z.object({ commandId: id, state: z.enum(['acknowledgement-unknown', 'committed', 'conflict', 'access-revoked']), outcomeUnknown: z.boolean().optional(), errorCode: z.string().max(200).nullable(), receipt: z.unknown().optional() }).strict().parse(raw), record = this.command(input.commandId)
      if (['committed', 'cancelled-before-dispatch'].includes(record.state)) return publicOutbox(record)
      const receipt = input.state === 'committed' ? validateQueueReceipt(record, input.receipt) : null
      const next: OutboxRecord = { ...record, state: input.state, outcomeUnknown: input.state === 'acknowledgement-unknown' || (input.state === 'access-revoked' && (input.outcomeUnknown ?? record.outcomeUnknown)), receipt, updatedAt: Date.now(), lastErrorCode: input.errorCode, ...(receipt ? { reconciliation: 'committed', reconciledAt: Date.now() } as const : {}) }
      this.saveCommand(next); return publicOutbox(next)
    })
    if (operation.op === 'missing-receipt') return this.transaction(() => {
      const record = this.command(id.parse(raw)); if (!['dispatching', 'acknowledgement-unknown'].includes(record.state)) return publicOutbox(record)
      const next: OutboxRecord = { ...record, state: 'acknowledgement-unknown', reconciliation: 'missing-at-read-point', reconciledAt: Date.now(), lastErrorCode: 'RECEIPT_NOT_FOUND_AT_READ_POINT' }
      this.saveCommand(next); return publicOutbox(next)
    })
    if (operation.op === 'cache-document') return this.transaction(() => {
      const input = z.object({ connectionId: id, document: teamPublishedDocumentSchema }).strict().parse(raw), c = this.connection(input.connectionId); active(c)
      const document = verifyTeamDocument(input.document)
      if (document.material.projectId !== c.projectId || (document.material.visibility === 'personal' && document.material.ownerId !== c.ownerId)) throw new DesktopTeamError('BINDING_CHANGED', '共享正文不属于该设备的项目或个人范围')
      const key = `${c.connectionId}:${document.material.materialId}:${document.material.version}`, data = JSON.stringify({ document, fetchedAt: Date.now() }), bytes = Buffer.byteLength(data), old = this.db.prepare('SELECT data,bytes FROM documents WHERE key=?').get(key)
      if (old && canonicalTeamJson(cachedSchema.parse(JSON.parse(String(old.data))).document) !== canonicalTeamJson(document)) throw new DesktopTeamError('IMMUTABLE_CONFLICT', '远端固定版本正文发生冲突，旧缓存已保留')
      if (Number(this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS used FROM documents').get()?.used) - Number(old?.bytes ?? 0) + bytes > MAX_CACHE_BYTES || (!old && Number(this.db.prepare('SELECT COUNT(*) AS count FROM documents').get()?.count) >= 1000)) throw new DesktopTeamError('CAPACITY_EXCEEDED', '共享固定版本缓存已达限界')
      this.db.prepare('INSERT INTO documents VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data,bytes=excluded.bytes').run(key, c.connectionId, data, bytes)
      return cachedSchema.parse(JSON.parse(data))
    })
    if (operation.op === 'cached-document') {
      const input = z.object({ connectionId: id, materialId: id, version: z.number().int().positive() }).strict().parse(raw), c = this.connection(input.connectionId); active(c)
      const row = this.db.prepare('SELECT connectionId,data FROM documents WHERE key=?').get(`${input.connectionId}:${input.materialId}:${input.version}`)
      if (!row) return null
      const cached = cachedSchema.parse(JSON.parse(String(row.data))); verifyTeamDocument(cached.document)
      const material = cached.document.material
      if (row.connectionId !== c.connectionId || material.materialId !== input.materialId || material.version !== input.version || material.projectId !== c.projectId || (material.visibility === 'personal' && material.ownerId !== c.ownerId)) throw new DesktopTeamError('CORRUPT_STORE', '缓存固定版本的键、设备或项目人员范围不匹配；原记录已保留')
      return cached
    }
    if (operation.op === 'sync-read') { const c = this.connection(id.parse(raw)); active(c); return this.sync(c.connectionId) }
    if (operation.op === 'sync-cursor') return this.transaction(() => {
      const input = z.object({ connectionId: id, cursor: z.string().min(1).max(2048), resetRequired: z.boolean(), hasMore: z.boolean() }).strict().parse(raw), c = this.connection(input.connectionId); active(c)
      const old = this.sync(c.connectionId), next = input.resetRequired ? { ...old, resetRequired: true, resetCursor: input.cursor, hasMore: input.hasMore } : { ...old, cursor: input.cursor, hasMore: input.hasMore }
      this.saveSync(c.connectionId, next); return next
    })
    if (operation.op === 'snapshot-save') return this.transaction(() => {
      const input = z.object({ connectionId: id, items: z.array(teamMaterialVersionSchema).max(1000) }).strict().parse(raw), c = this.connection(input.connectionId); active(c)
      if (input.items.some((item) => item.projectId !== c.projectId || (item.visibility === 'personal' && item.ownerId !== c.ownerId))) throw new DesktopTeamError('BINDING_CHANGED', '共享快照含有其他身份范围')
      if (Buffer.byteLength(JSON.stringify(input.items)) > 2 * 1024 * 1024) throw new DesktopTeamError('CAPACITY_EXCEEDED', '共享快照超过限界，不能宣称已完整同步')
      const old = this.sync(c.connectionId), next = { ...old, cursor: old.resetCursor ?? old.cursor, resetCursor: null, resetRequired: false, snapshot: { items: input.items, fetchedAt: Date.now() } }
      this.saveSync(c.connectionId, next); return { ...next.snapshot, stale: false, authorization: 'last-observed', resetRequired: false, eventsHasMore: next.hasMore } satisfies DesktopTeamSnapshot
    })
    if (operation.op === 'snapshot-read') { const c = this.connection(id.parse(raw)); active(c); const sync = this.sync(c.connectionId); return sync.snapshot ? { ...sync.snapshot, stale: true, authorization: 'last-observed', resetRequired: sync.resetRequired, eventsHasMore: sync.hasMore } satisfies DesktopTeamSnapshot : null }
    throw new DesktopTeamError('INVALID_INPUT', '未知团队存储操作')
  }
  private updateConnection(c: ConnectionRecord, input: { device?: unknown; network?: 'reachable' | 'offline'; errorCode?: string | null; lock?: boolean; revokeOutbox?: boolean; disconnect?: boolean; nextPollAt?: number }): ConnectionRecord {
    let invalidated = input.lock === true || input.disconnect === true
    if (input.device !== undefined) {
      const remote = teamDeviceSchema.parse(input.device)
      invalidated ||= remote.status === 'revoked' || remote.status === 'expired'
      if (remote.deviceId !== c.deviceId || (c.projectId && remote.projectId !== c.projectId) || (c.ownerId && remote.ownerId !== c.ownerId)) throw new DesktopTeamError('BINDING_CHANGED', '远端配对试图更换原项目或账号')
      if (c.accountId !== null && remote.status === 'active') {
        const account = this.account(c.accountId)
        if (account.origin !== c.origin || account.person.userId !== remote.ownerId) throw new DesktopTeamError('BINDING_CHANGED', '远端配对账号不属于原桌面账号')
      }
      if (c.state === 'disconnected') throw new DesktopTeamError('ACCESS_LOCKED', '本地绑定已断开，不能被延迟状态重新激活')
      if (['revoked', 'expired'].includes(c.state) && remote.status === 'active') throw new DesktopTeamError('BINDING_CHANGED', '已撤销或到期的凭据不能自动恢复')
      c.remoteDevice = remote; c.state = remote.status; c.projectId = remote.projectId; c.ownerId = remote.ownerId; c.sequence = Math.max(c.sequence, remote.sequence)
      // Pending has zero authority through its state, but remains eligible for
      // setup polling. Access lock denotes actual access or credential loss.
      c.accessLocked = remote.status === 'revoked' || remote.status === 'expired'; c.lastCheckedAt = Date.now(); c.network = 'reachable'; c.lastErrorCode = null
    }
    if (input.network) c.network = input.network
    if (input.errorCode !== undefined) c.lastErrorCode = input.errorCode
    if (input.lock === true) c.accessLocked = true
    if (input.disconnect) { c.state = 'disconnected'; c.accessLocked = true }
    if (input.nextPollAt !== undefined) c.nextPollAt = input.nextPollAt
    if (invalidated) {
      // Saturation is terminal: invalidation still persists, but no future
      // active-device proof can clear this connection's fence.
      if (c.accessGeneration < Number.MAX_SAFE_INTEGER) c.accessGeneration++
    }
    this.saveConnection(c)
    if (c.state === 'disconnected' || c.state === 'revoked' || c.state === 'expired' || (input.lock === true && input.revokeOutbox !== false)) {
      for (const row of this.db.prepare('SELECT id FROM commands WHERE connectionId=?').all(c.connectionId)) {
        const record = this.command(String(row.id))
        if (!['committed', 'conflict', 'cancelled-before-dispatch'].includes(record.state)) this.saveCommand({ ...record, state: 'access-revoked', updatedAt: Date.now(), lastErrorCode: c.lastErrorCode ?? 'ACCESS_LOCKED' })
      }
    }
    return c
  }
  private outbox(raw: unknown): DesktopTeamOutboxPage {
    const input = z.object({ connectionId: id, cursor: z.string().max(2048).optional(), limit: z.number().int().min(1).max(100).default(50) }).strict().parse(raw)
    this.connection(input.connectionId)
    let after: { createdAt: number; commandId: string } | null = null
    if (input.cursor) {
      try {
        const cursor = z.object({ store: id, connection: id, createdAt: timestamp, commandId: id }).strict().parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')))
        if (cursor.store !== this.storeId || cursor.connection !== input.connectionId) throw Error('Foreign cursor')
        after = cursor
      } catch { throw new DesktopTeamError('CURSOR_CONFLICT', '本地操作游标已不属于原绑定，请重新加载') }
    }
    const rows = after ? this.db.prepare('SELECT id FROM commands WHERE connectionId=? AND (createdAt<? OR (createdAt=? AND id<?)) ORDER BY createdAt DESC,id DESC LIMIT 101').all(input.connectionId, after.createdAt, after.createdAt, after.commandId) : this.db.prepare('SELECT id FROM commands WHERE connectionId=? ORDER BY createdAt DESC,id DESC LIMIT 101').all(input.connectionId)
    const items: DesktopTeamOutboxPage['items'] = []; let bytes = 0
    for (const row of rows) { const item = publicOutbox(this.command(String(row.id))), size = Buffer.byteLength(JSON.stringify(item)); if (items.length >= input.limit || bytes + size > 512 * 1024) break; items.push(item); bytes += size }
    const hasMore = rows.length > items.length, last = items.at(-1)
    return { items, hasMore, nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ store: this.storeId, connection: input.connectionId, createdAt: last.createdAt, commandId: last.commandId })).toString('base64url') : null }
  }
}

export function validateQueueReceipt(record: OutboxRecord, raw: unknown): OutboxRecord['receipt'] {
  if (record.kind === 'publication') {
    const receipt = teamMaterialVersionSchema.parse(raw), payload = publicationInputSchema.parse(record.payload)
    if (receipt.materialId !== payload.materialId || receipt.projectId !== payload.projectId || receipt.ownerId !== record.binding.ownerId || receipt.authorId !== record.binding.ownerId || receipt.version !== (payload.expectedVersion ?? 0) + 1 || receipt.bodyDigest !== payload.expectedDigest || receipt.byteLength !== Buffer.byteLength(payload.text, 'utf8') || receipt.title !== payload.title || receipt.visibility !== payload.visibility || receipt.kind !== payload.kind || canonicalTeamJson(receipt.source) !== canonicalTeamJson(payload.source)) throw new DesktopTeamError('RECEIPT_MISMATCH', '远端发布回执与原固定操作不一致', true)
    return receipt
  }
  const receipt = teamFeedbackSchema.parse(raw), payload = teamFeedbackInputSchema.parse(record.payload)
  if (receipt.feedbackId !== payload.feedbackId || receipt.materialId !== payload.materialId || receipt.version !== payload.version || receipt.authorId !== record.binding.ownerId || receipt.body !== payload.body || receipt.quote !== (payload.quote ?? null) || canonicalTeamJson(receipt.anchor) !== canonicalTeamJson(payload.anchor ?? null)) throw new DesktopTeamError('RECEIPT_MISMATCH', '远端反馈回执与原选定版本不一致', true)
  return receipt
}

import { randomUUID } from 'node:crypto'
import { existsSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { conversationIdSchema, conversationSchema, conversationProjectSchema, type ConversationProject } from '../../../shared/private-conversations'
import { IpcErrorCode, type IpcFail } from '../../../shared/ipc-errors'
import { checkedDirectory, hash, ownedDirectory, readRegular } from './files'
import { cruxWorkspaceGeneration, cruxWorkspaceSnapshot, cruxWorkspaceCurrentView } from '../crux/connection-service'

const common = {
  revision: z.number().int().positive(),
  draft: z.object({ text: z.string().max(200_000), runtimeId: z.string().min(1).max(200).optional(), modelId: z.string().min(1).optional() }).strict(),
  rootIdentity: z.string().min(1), sourceGeneration: z.string().uuid().optional(), inputs: z.array(z.string().min(1).max(8192)).max(256),
  pending: z.object({ requestId: z.string().uuid(), digest: z.string().length(64), textDigest: z.string().length(64).optional(), initial: z.boolean().optional(), initialModelPending: z.boolean().optional(), modelChangeUncertain: z.boolean().optional(), state: z.enum(['preparing', 'dispatching', 'sent', 'unknown']), turnId: z.string().optional() }).strict().optional()
}
const legacyContextSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('personal') }).strict(),
  z.object({ kind: z.literal('team'), workspaceKey: z.string().min(1).max(256), spaceId: z.string().min(1).max(256) }).strict()
])
const legacyRowSchema = z.object({ version: z.literal(1), ...common, conversation: conversationSchema.extend({ context: legacyContextSchema }).strict() }).strict()
const rowSchema = z.object({
  version: z.literal(2), ...common, conversation: conversationSchema,
  nativeCreatorId: z.string().min(1).max(256), nativePreviewAt: z.number().finite().nonnegative().optional(),
  migration: z.object({ fromVersion: z.literal(1), originalDigest: z.string().length(64), convertedAt: z.number().int().nonnegative(), legacyProjectId: z.string().min(1).max(256).optional() }).strict().optional()
}).strict()
export type ConversationRow = z.infer<typeof rowSchema>
type LegacyProof = Awaited<ReturnType<typeof cruxWorkspaceSnapshot>> & { generation: number }
export interface ConversationMigrationBatch { legacyProof?: Promise<LegacyProof> }
const projectsSchema = z.object({ version: z.literal(2), creatorId: z.string().min(1).max(256), projects: z.array(conversationProjectSchema).max(1000) }).strict()
const legacyProjectsSchema = z.array(conversationProjectSchema.extend({ context: legacyContextSchema }).strict()).max(1000)

export class ConversationStorageError extends Error {
  constructor(message: string, readonly code: IpcFail['code'] = IpcErrorCode.Conflict) { super(message) }
}

/** One catalog format; v1 is accepted only as a guarded, non-destructive import. */
export class ConversationStorage {
  private loading = new Map<string, Promise<ConversationRow>>()
  constructor(private readonly directory: string, private readonly creatorId: string, private readonly userData: string) { checkedDirectory(directory) }
  private path(id: string): string { return `catalog/${conversationIdSchema.parse(id)}.json` }
  private bytes(relative: string, limit = 1024 * 1024): Buffer { return readRegular(this.directory, relative, limit).bytes }
  private decoded(relative: string, limit?: number): unknown { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.bytes(relative, limit))) }
  private assertCreator(row: ConversationRow): ConversationRow {
    if (row.conversation.creatorId !== this.creatorId) throw new ConversationStorageError('此会话属于另一位本机创建者', IpcErrorCode.Denied)
    return row
  }
  read(id: string): ConversationRow {
    const row = this.assertCreator(rowSchema.parse(this.decoded(this.path(id))))
    if (row.conversation.id !== id) throw new ConversationStorageError('会话文件与索引身份不一致')
    return row
  }
  load(id: string, batch: ConversationMigrationBatch = {}): Promise<ConversationRow> {
    const pending = this.loading.get(id)
    if (pending) return pending
    const request = this.loadOwned(id, batch)
    this.loading.set(id, request)
    void request.finally(() => { if (this.loading.get(id) === request) this.loading.delete(id) }).catch(() => {})
    return request
  }
  private async legacyCreator(row: z.infer<typeof legacyRowSchema>, batch: ConversationMigrationBatch): Promise<void> {
    const context = row.conversation.context
    if (context.kind === 'personal') {
      if (row.conversation.creatorId !== this.creatorId) throw new ConversationStorageError('旧会话属于另一位本机创建者，原文件已保留', IpcErrorCode.Denied)
      return
    }
    // This path is migration-only. New conversations and v2 reads never consult
    // a team account, selected space, membership or team project.
    const selected = join(this.userData, 'crux-remote', 'selection.json')
    if (!existsSync(selected) && !existsSync(join(this.userData, 'crux', 'store.json'))) throw new ConversationStorageError('旧会话需先核对原创建者，原文件已保留', IpcErrorCode.Denied)
    batch.legacyProof ??= (async () => {
      const generation = cruxWorkspaceGeneration(), proof = await cruxWorkspaceSnapshot()
      if (generation !== cruxWorkspaceGeneration()) throw new ConversationStorageError('旧创建者核对期间来源已变化', IpcErrorCode.Denied)
      return { ...proof, generation }
    })().catch(() => { throw new ConversationStorageError('旧创建者身份当前不可验证，原文件已保留', IpcErrorCode.Denied) })
    const proof = await batch.legacyProof
    let current: Awaited<ReturnType<typeof cruxWorkspaceCurrentView>>
    try { current = await cruxWorkspaceCurrentView() }
    catch { throw new ConversationStorageError('旧创建者身份当前不可验证，原文件已保留', IpcErrorCode.Denied) }
    const identity = (value: LegacyProof['context']): string => JSON.stringify([value.key, value.state, value.instanceId ?? 'local', value.origin ?? 'local', value.actorId])
    if (!['local', 'connected'].includes(proof.context.state) || !proof.context.actorId || proof.context.key !== context.workspaceKey
      || !proof.snapshot.members.some(member => member.id === proof.context.actorId) || proof.generation !== cruxWorkspaceGeneration() || identity(current.context) !== identity(proof.context)) throw new ConversationStorageError('不能验证旧会话的原创建者，原文件已保留', IpcErrorCode.Denied)
    const oldCreator = `team-${hash(JSON.stringify([this.creatorId, proof.context.key, proof.context.instanceId ?? 'local', proof.context.origin ?? 'local', proof.context.actorId]))}`
    if (row.conversation.creatorId !== oldCreator) throw new ConversationStorageError('当前身份不是旧会话的创建者，原文件已保留', IpcErrorCode.Denied)
  }
  private async loadOwned(id: string, batch: ConversationMigrationBatch): Promise<ConversationRow> {
    const path = this.path(id), bytes = this.bytes(path), raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (raw && typeof raw === 'object' && 'version' in raw && raw.version === 2) {
      const row = this.assertCreator(rowSchema.parse(raw))
      if (row.conversation.id !== id) throw new ConversationStorageError('会话文件与索引身份不一致')
      return row
    }
    const old = legacyRowSchema.parse(raw)
    if (old.conversation.id !== id) throw new ConversationStorageError('旧会话索引身份不一致')
    await this.legacyCreator(old, batch)
    if (hash(this.bytes(path)) !== hash(bytes)) throw new ConversationStorageError('旧会话在迁移期间改变，请重新读取')
    const { context, ...conversation } = old.conversation
    const next = rowSchema.parse({ ...old, version: 2, revision: old.revision + 1,
      conversation: { ...conversation, creatorId: this.creatorId, ...(context.kind === 'team' ? { projectId: undefined } : {}) },
      nativeCreatorId: old.conversation.creatorId,
      migration: { fromVersion: 1, originalDigest: hash(bytes), convertedAt: Date.now(), ...(context.kind === 'team' && conversation.projectId ? { legacyProjectId: conversation.projectId } : {}) }
    })
    this.backup(bytes)
    this.replace(path, Buffer.from(JSON.stringify(next)), hash(bytes))
    return next
  }
  private backup(bytes: Buffer): void {
    const digest = hash(bytes), directory = ownedDirectory(this.directory, 'migrations/v1'), file = join(directory, `${digest}.json`)
    try { writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    if (hash(this.bytes(`migrations/v1/${digest}.json`)) !== digest) throw new ConversationStorageError('旧会话备份校验失败；原文件已保留', IpcErrorCode.Io)
  }
  private replace(relative: string, bytes: Buffer, expectedDigest?: string): void {
    const directory = relative.startsWith('catalog/') ? ownedDirectory(this.directory, 'catalog') : this.directory
    const target = join(this.directory, relative)
    if (expectedDigest === undefined ? existsSync(target) : hash(this.bytes(relative)) !== expectedDigest) throw new ConversationStorageError('会话存储已改变，请重新读取')
    const temporary = join(directory, `.${randomUUID()}.tmp`)
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, target)
  }
  save(row: ConversationRow, expected?: number): void {
    const path = this.path(row.conversation.id), target = join(this.directory, path)
    let digest: string | undefined
    if (existsSync(target)) {
      const original = this.bytes(path), current = this.assertCreator(rowSchema.parse(JSON.parse(original.toString('utf8'))))
      if (expected === undefined || current.revision !== expected) throw new ConversationStorageError('会话已更新，请重新读取草稿')
      if (current.nativeCreatorId !== row.nativeCreatorId || current.conversation.nativeRef && (JSON.stringify(current.conversation.nativeRef) !== JSON.stringify(row.conversation.nativeRef) || JSON.stringify(current.conversation.workspace) !== JSON.stringify(row.conversation.workspace))) throw new ConversationStorageError('既有原生会话身份和目录不能改变', IpcErrorCode.Denied)
      if (JSON.stringify([current.conversation.workspace, current.rootIdentity, current.conversation.archivedAt]) !== JSON.stringify([row.conversation.workspace, row.rootIdentity, row.conversation.archivedAt])) row.sourceGeneration = randomUUID()
      digest = hash(original)
    }
    const next = this.assertCreator(rowSchema.parse({ ...row, revision: (expected ?? 0) + 1 }))
    const bytes = Buffer.from(JSON.stringify(next), 'utf8')
    if (bytes.length > 1024 * 1024) throw new ConversationStorageError('会话数据超过 1 MiB，未保存；原文件已保留', IpcErrorCode.Io)
    this.replace(path, bytes, digest)
    row.revision = next.revision
  }
  projects(): ConversationProject[] {
    const target = join(this.directory, 'projects.json')
    if (!existsSync(target)) return []
    const bytes = this.bytes('projects.json', 512 * 1024), raw: unknown = JSON.parse(bytes.toString('utf8'))
    if (!Array.isArray(raw)) {
      const value = projectsSchema.parse(raw)
      if (value.creatorId !== this.creatorId) throw new ConversationStorageError('私人分组属于另一位创建者', IpcErrorCode.Denied)
      return value.projects
    }
    const legacy = legacyProjectsSchema.parse(raw)
    // Team project references remain in the exact backup and their original
    // team service; they are never adopted as private topic IDs.
    const projects = legacy.filter(project => project.context.kind === 'personal').map(({ context: _context, ...project }) => project)
    this.backup(bytes)
    this.replace('projects.json', Buffer.from(JSON.stringify({ version: 2, creatorId: this.creatorId, projects })), hash(bytes))
    return projects
  }
  createProject(name: string): ConversationProject {
    const projects = this.projects(), project = conversationProjectSchema.parse({ id: randomUUID(), name })
    if (projects.length >= 1000) throw new ConversationStorageError('私人主题分组数量已达到上限', IpcErrorCode.Busy)
    const target = join(this.directory, 'projects.json'), digest = existsSync(target) ? hash(this.bytes('projects.json', 512 * 1024)) : undefined
    const body = projectsSchema.parse({ version: 2, creatorId: this.creatorId, projects: [...projects, project] })
    const bytes = Buffer.from(JSON.stringify(body))
    if (bytes.length > 512 * 1024) throw new ConversationStorageError('私人主题分组存储超过大小限制', IpcErrorCode.Busy)
    this.replace('projects.json', bytes, digest)
    return project
  }
}

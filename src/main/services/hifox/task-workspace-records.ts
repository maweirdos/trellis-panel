import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { hifoxProjectCandidateSchema, type HifoxDevelopmentSummary, type HifoxProjectCandidate, type HifoxWorkLocal } from '../../../shared/hifox-work'
import { IpcErrorCode } from '../../../shared/ipc-errors'
import { materialRead, materialWrite } from '../knowledge-access/materials'
import { resolveAuthorizedDocumentPath } from '../documents/paths'
import { expectedDefaultPrd, operationIdFor, sha256Hex, slugFor } from '../local-task/operations'
import { scanKnownTaskDirs } from '../task-identity'
import { inferPhase } from '../scan'
import { HifoxWorkError, hifoxWorkMaterialSchema, renderHifoxWorkPrd, type HifoxWorkSource } from './task-workspace-source'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const id = z.string().min(1).max(256)
export const hifoxWorkReferencePathSchema = z.string().regex(/^references\/(?:source-materials\.json|[a-f0-9-]{36}\/[a-f0-9-]{36}\.(?:html|md|review\.json)|(?:team|rules|templates)\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.md)$/i)
export const hifoxWorkRecordSchema = z.object({
  version: z.literal(1), workspaceKey: id, spaceId: id, sourceTaskId: id, ownerIdentity: hash,
  projectRoot: z.string().min(1).max(8192), commandId: id, slug: z.string().min(1).max(64),
  projectIdentity: hash.optional(),
  identityVersion: z.literal(2).optional(), taskCreatedAt: z.string().min(1).max(64).optional(),
  generation: z.number().int().positive().safe().optional(), createdAt: z.number().int().nonnegative().optional(),
  git: z.object({ repoRoot: z.string().max(8192), branch: z.string().max(4096).nullable(), head: z.string().max(128).nullable(), detached: z.boolean() }).strict().nullable().optional(),
  previousOperations: z.array(id).max(128).optional(),
  change: z.object({ commandId: z.string().uuid(), requestDigest: hash, previousContextId: id }).strict().optional(),
  codeResource: z.object({ resourceId: z.string().uuid(), selectionRevision: z.number().int().positive(), sourceDigest: hash }).strict().optional(),
  sourceRevision: hash, material: hifoxWorkMaterialSchema,
  cliTitle: z.string().min(1).max(500), cliDescription: z.string().max(1000), assignee: z.string().max(200),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']),
  stage: z.enum(['registered', 'dispatching', 'failed', 'uncertain', 'cli_created', 'ready']),
  relativeDir: z.string().max(4096).nullable(), localTaskId: id.nullable(),
  baselinePrdRevision: hash.nullable(), generatedPrdRevision: hash.nullable(),
  referenceFiles: z.array(z.object({ relativePath: hifoxWorkReferencePathSchema, bodyDigest: hash }).strict()).max(128).optional()
}).strict()
export type HifoxWorkRecord = z.infer<typeof hifoxWorkRecordSchema>
export type StoredHifoxWorkRecord = { value: HifoxWorkRecord; revision: string | null; storagePath?: string }
type HifoxWorkOwner = Pick<HifoxWorkSource, 'workspaceKey' | 'spaceId' | 'taskId' | 'identity'> & { taskCreatedAt?: string }
export const nativeRootKey = (root: string): string => process.platform === 'win32' ? root.toLowerCase() : root
export const bindingKey = (scope: { workspaceKey: string; spaceId: string; taskId: string }): string => sha256Hex(JSON.stringify([scope.workspaceKey, scope.spaceId, scope.taskId]))

/** Only local userData contains machine paths and the command's original material snapshot. */
export class HifoxWorkBindings {
  constructor(private readonly dataDir: string) {}
  file(scope: { workspaceKey: string; spaceId: string; taskId: string; identity?: string; taskCreatedAt?: string }): string {
    const owner = scope.identity && scope.taskCreatedAt ? `-${sha256Hex(JSON.stringify([scope.identity, scope.taskCreatedAt]))}` : ''
    return `hifox-work/bindings/${bindingKey(scope)}${owner}.json`
  }
  read(source: HifoxWorkOwner): StoredHifoxWorkRecord | null {
    try {
      const currentPath = this.file(source), legacyPath = this.file({ workspaceKey: source.workspaceKey, spaceId: source.spaceId, taskId: source.taskId })
      for (const path of new Set([currentPath, legacyPath])) {
        const found = materialRead(this.dataDir, path)
        if (found.revision === null) continue
        const value = hifoxWorkRecordSchema.parse(JSON.parse(found.body))
        if (value.ownerIdentity !== source.identity && path === legacyPath && path !== currentPath) continue
        if (value.taskCreatedAt && source.taskCreatedAt && value.taskCreatedAt !== source.taskCreatedAt && path === legacyPath) continue
        if (value.workspaceKey !== source.workspaceKey || value.spaceId !== source.spaceId || value.sourceTaskId !== source.taskId || value.ownerIdentity !== source.identity || value.taskCreatedAt && source.taskCreatedAt && value.taskCreatedAt !== source.taskCreatedAt) throw new HifoxWorkError('scope_changed', '本机绑定属于另一协作身份或原任务，不能转用。')
        if (sha256Hex(JSON.stringify(value.material)) !== value.sourceRevision || value.commandId !== commandId({ ...source, taskCreatedAt: value.taskCreatedAt }, value.projectRoot, value.generation ?? 1, value.identityVersion === 2)) throw new Error('binding identity')
        return { value, revision: found.revision, storagePath: path }
      }
      return null
    } catch (error) {
      if (error instanceof HifoxWorkError) throw error
      throw new HifoxWorkError('store_unavailable', '本机准备记录不可读取或已损坏，原文件已保留。', IpcErrorCode.Io)
    }
  }
  save(record: StoredHifoxWorkRecord): void {
    try {
      const value = hifoxWorkRecordSchema.parse(record.value)
      const body = JSON.stringify(value) + '\n'
      const path = record.storagePath ?? this.file({ workspaceKey: value.workspaceKey, spaceId: value.spaceId, taskId: value.sourceTaskId, identity: value.ownerIdentity, taskCreatedAt: value.taskCreatedAt })
      materialWrite(this.dataDir, path, body, record.revision)
      record.revision = sha256Hex(body)
      record.storagePath = path
    } catch {
      throw new HifoxWorkError('store_unavailable', '本机准备记录保存失败或被并发修改，请保留原目录并重试核对。', IpcErrorCode.Io)
    }
  }
  replace(source: HifoxWorkSource, previous: StoredHifoxWorkRecord, next: StoredHifoxWorkRecord): void {
    const actual = this.read(source)
    if (!actual || actual.revision !== previous.revision || actual.value.commandId !== previous.value.commandId) throw new HifoxWorkError('task_conflict', '开发绑定已被其他操作更新，请重新核对。')
    const historyPath = `${this.historyDirectory(source)}/${sha256Hex(previous.value.commandId)}.json`
    const body = JSON.stringify(hifoxWorkRecordSchema.parse(previous.value)) + '\n'
    const old = materialRead(this.dataDir, historyPath)
    if (old.revision !== null && old.body !== body) throw new HifoxWorkError('store_unavailable', '原开发尝试的历史记录不一致，未改变当前绑定。', IpcErrorCode.Io)
    if (old.revision === null) materialWrite(this.dataDir, historyPath, body, null)
    const path = this.file(source)
    next.storagePath = path
    next.revision = previous.storagePath === path ? previous.revision : null
    this.save(next)
  }
  private historyDirectory(source: HifoxWorkOwner): string { return `hifox-work/history/${sha256Hex(JSON.stringify([bindingKey(source), source.identity, source.taskCreatedAt ?? null]))}` }
  history(source: HifoxWorkSource): { items: HifoxDevelopmentSummary[]; hasMore: boolean } {
    const directory = this.historyDirectory(source), absolute = join(this.dataDir, directory)
    if (!existsSync(absolute)) return { items: [], hasMore: false }
    const names = readdirSync(absolute).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
    if (names.length > 128) throw new HifoxWorkError('store_unavailable', '开发历史超过核对上限，原记录已保留。', IpcErrorCode.Io)
    const items = names.map(name => {
      const value = hifoxWorkRecordSchema.parse(JSON.parse(materialRead(this.dataDir, `${directory}/${name}`).body))
      if (value.ownerIdentity !== source.identity || value.sourceTaskId !== source.taskId || value.taskCreatedAt && value.taskCreatedAt !== source.taskCreatedAt || sha256Hex(JSON.stringify(value.material)) !== value.sourceRevision) throw new HifoxWorkError('store_unavailable', '开发历史的原任务或内容无法核对。', IpcErrorCode.Io)
      return summarizeHifoxWork(value)
    }).sort((a, b) => b.ref.generation - a.ref.generation)
    return { items: items.slice(0, 32), hasMore: items.length > 32 }
  }
  private candidatePath(source: HifoxWorkSource, resourceId: string): string { return `hifox-work/projects/${sha256Hex(JSON.stringify([source.identity, resourceId]))}.json` }
  candidates(source: HifoxWorkSource, resourceId: string): HifoxProjectCandidate[] {
    const saved = materialRead(this.dataDir, this.candidatePath(source, resourceId))
    if (saved.revision === null) return []
    return z.array(hifoxProjectCandidateSchema).max(64).parse(JSON.parse(saved.body)).filter(item => item.resourceId === resourceId)
  }
  remember(source: HifoxWorkSource, record: HifoxWorkRecord): void {
    if (!record.codeResource || !record.projectIdentity) return
    const resourceId = record.codeResource.resourceId, path = this.candidatePath(source, resourceId), saved = materialRead(this.dataDir, path)
    const items = saved.revision === null ? [] : z.array(hifoxProjectCandidateSchema).max(64).parse(JSON.parse(saved.body))
    const entry: HifoxProjectCandidate = { id: sha256Hex(JSON.stringify([source.identity, resourceId, record.projectRoot, record.projectIdentity])), resourceId, projectRoot: record.projectRoot, projectIdentity: record.projectIdentity, checkedAt: Date.now() }
    materialWrite(this.dataDir, path, JSON.stringify([entry, ...items.filter(item => item.id !== entry.id)].slice(0, 64)), saved.revision)
  }
}
export function commandId(source: HifoxWorkOwner, root: string, generation = 1, scopedIdentity = false): string {
  return operationIdFor({ workspaceId: `hifox:${sha256Hex(nativeRootKey(root))}`, instanceId: source.identity, issueIdentifier: JSON.stringify([source.workspaceKey, source.spaceId, source.taskId, ...(scopedIdentity ? [source.taskCreatedAt] : [])]), ordinal: generation })
}
export function freshHifoxWorkRecord(source: HifoxWorkSource, projectRoot: string, generation = 1): StoredHifoxWorkRecord {
  const operation = commandId(source, projectRoot, generation, true)
  return { revision: null, value: {
    version: 1, workspaceKey: source.workspaceKey, spaceId: source.spaceId, sourceTaskId: source.taskId, ownerIdentity: source.identity,
    projectRoot, commandId: operation, slug: `${slugFor(source.taskId, source.material.title).slice(0, 39)}-${operation.slice(-12)}`,
    identityVersion: 2, taskCreatedAt: source.taskCreatedAt, generation, createdAt: Date.now(),
    sourceRevision: source.revision, material: source.material, cliTitle: source.material.title,
    cliDescription: `HiFox task ${source.taskId}: planning`, assignee: source.actorName.slice(0, 200) || source.actorId,
    priority: source.priority, stage: 'registered', relativeDir: null, localTaskId: null, baselinePrdRevision: null, generatedPrdRevision: null
  } }
}
export function summarizeHifoxWork(record: HifoxWorkRecord): HifoxDevelopmentSummary {
  return { ref: { contextId: record.commandId, generation: record.generation ?? 1 }, projectRoot: record.projectRoot, title: record.material.title,
    taskDir: record.relativeDir, inputVersion: record.sourceRevision, taskCreatedAt: record.taskCreatedAt ?? null, branch: record.git?.branch ?? null,
    head: record.git?.head ?? null, createdAt: record.createdAt ?? null, stage: record.stage, resourceId: record.codeResource?.resourceId ?? null,
    changeCommandId: record.change?.commandId ?? null, previousContextId: record.change?.previousContextId ?? null }
}

export function validateHifoxProject(input: string, pinned = false): string {
  try {
    if (!isAbsolute(input)) throw new Error('absolute root required')
    const root = realpathSync.native(input)
    if (!statSync(root).isDirectory() || (pinned && nativeRootKey(root) !== nativeRootKey(resolve(input)))) throw new Error('root redirected')
    for (const [path, directory] of [['.trellis', true], ['.trellis/tasks', true], ['.trellis/scripts/task.py', false], ['.trellis/workflow.md', false]] as const) {
      const authorized = resolveAuthorizedDocumentPath(root, path)
      if (!authorized.ok || !authorized.exists || nativeRootKey(authorized.canonicalPath) !== nativeRootKey(resolve(root, path))) throw new Error('project path redirected')
      const info = statSync(authorized.canonicalPath)
      if (directory ? !info.isDirectory() : !info.isFile()) throw new Error('invalid project marker')
    }
    return root
  } catch { throw new HifoxWorkError('project_invalid', '请选择包含工作流、任务目录和 task.py 的真实 Trellis 项目；绑定路径不能被重定向。', IpcErrorCode.InvalidArg) }
}

export function hifoxWorkMeta(record: HifoxWorkRecord): Array<[string, string]> {
  const metadata: Array<[string, string]> = [
    ['panel_operation_id', record.commandId], ['panel_hifox_workspace_key', record.workspaceKey],
    ['panel_hifox_space_id', record.spaceId], ['panel_hifox_task_id', record.sourceTaskId],
    ['panel_hifox_identity', record.ownerIdentity], ['panel_hifox_source_revision', record.sourceRevision]
  ]
  if (record.taskCreatedAt) metadata.push(['panel_hifox_task_created_at', record.taskCreatedAt])
  if (record.generation) metadata.push(['panel_hifox_generation', String(record.generation)])
  if (record.workspaceKey !== 'local') metadata.push(['panel_task_authority', 'team'])
  return metadata
}
const taskSchema = z.object({ id, status: z.string(), meta: z.record(z.string(), z.unknown()) }).passthrough()
export type HifoxWorkDiskTask = { local: HifoxWorkLocal; sourceRevision: string }

/** Reuse the task identity registry, including archives. Names alone never establish ownership. */
export function reconcileHifoxWork(record: HifoxWorkRecord): HifoxWorkDiskTask | null {
  const known = scanKnownTaskDirs(record.projectRoot)
  if (known.length > 5000) throw new HifoxWorkError('task_conflict', '任务注册表超过核对上限，请先整理项目任务。')
  const matches: HifoxWorkDiskTask[] = []
  for (const item of known) {
    const authorized = resolveAuthorizedDocumentPath(record.projectRoot, item.dir)
    if (!authorized.ok || !authorized.exists || nativeRootKey(authorized.canonicalPath) !== nativeRootKey(resolve(record.projectRoot, item.dir))) throw new HifoxWorkError('task_conflict', '任务注册表中存在重定向或越界目录，请先核对。')
    let task: z.infer<typeof taskSchema>
    try { task = taskSchema.parse(JSON.parse(materialRead(record.projectRoot, `${item.dir}/task.json`).body)) }
    catch {
      if (item.dir === record.relativeDir || basename(item.dir).endsWith(`-${record.slug}`)) throw new HifoxWorkError('task_conflict', '原准备目录的 task.json 不完整，已保留目录，请先核对。')
      continue
    }
    const meta = task.meta
    const sameSource = meta.panel_hifox_workspace_key === record.workspaceKey && meta.panel_hifox_space_id === record.spaceId && meta.panel_hifox_task_id === record.sourceTaskId
    if (meta.panel_operation_id !== record.commandId && !sameSource) continue
    if (meta.panel_operation_id !== record.commandId && sameSource) {
      if (meta.panel_hifox_identity !== record.ownerIdentity) continue
      if (record.taskCreatedAt && typeof meta.panel_hifox_task_created_at === 'string' && meta.panel_hifox_task_created_at !== record.taskCreatedAt) continue
      if (typeof meta.panel_operation_id === 'string' && record.previousOperations?.includes(meta.panel_operation_id)) continue
    }
    if (!sameSource || meta.panel_hifox_identity !== record.ownerIdentity || meta.panel_operation_id !== record.commandId || typeof meta.panel_hifox_source_revision !== 'string' || !hash.safeParse(meta.panel_hifox_source_revision).success) throw new HifoxWorkError('task_conflict', '发现冲突的任务来源或命令标识，不能自动复用。')
    if (record.localTaskId && task.id !== record.localTaskId) throw new HifoxWorkError('task_conflict', '本机任务身份发生变化，不能按目录名替换绑定。')
    matches.push({ sourceRevision: meta.panel_hifox_source_revision, local: {
      projectRoot: record.projectRoot, taskDir: basename(item.dir), taskId: task.id, relativeDir: item.dir,
      phase: inferPhase(task.status), archived: item.dir.startsWith('.trellis/tasks/archive/')
    } })
  }
  if (matches.length > 1) throw new HifoxWorkError('task_conflict', '同一协作任务存在多个本机目录，请先核对绑定。')
  if (!matches.length && (record.relativeDir || record.localTaskId || record.stage === 'ready' || record.stage === 'cli_created')) throw new HifoxWorkError('task_missing', '已绑定的本机任务已移动、删除或来源标识被修改，请先核对；不会自动另建。')
  return matches[0] ?? null
}
export function plannedHifoxPrd(record: HifoxWorkRecord): string {
  return renderHifoxWorkPrd({ workspaceKey: record.workspaceKey, spaceId: record.spaceId, taskId: record.sourceTaskId, material: record.material, revision: record.sourceRevision })
}
export function pristineHifoxPrd(record: HifoxWorkRecord, actual: { body: string; revision: string | null }): boolean {
  if (actual.revision === sha256Hex(plannedHifoxPrd(record))) return true
  if (record.generatedPrdRevision !== null || record.stage === 'ready') return false
  // A missing file is safe only before any source draft has been acknowledged.
  if (actual.revision === null) return record.baselinePrdRevision === null
  return actual.body.replace(/\r\n/g, '\n') === expectedDefaultPrd(record.cliTitle, record.cliDescription)
}
export function hifoxPrepDirectoryExists(record: HifoxWorkRecord, prefix: string): boolean { return existsSync(join(record.projectRoot, '.trellis/tasks', `${prefix}-${record.slug}`)) }

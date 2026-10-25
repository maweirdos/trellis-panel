import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import type { HifoxWorkLocal } from '../../../shared/hifox-work'
import { IpcErrorCode } from '../../../shared/ipc-errors'
import { materialRead, materialWrite } from '../knowledge-access/materials'
import { resolveAuthorizedDocumentPath } from '../documents/paths'
import { expectedDefaultPrd, operationIdFor, sha256Hex, slugFor } from '../local-task/operations'
import { scanKnownTaskDirs } from '../task-identity'
import { inferPhase } from '../scan'
import { HifoxWorkError, hifoxWorkMaterialSchema, renderHifoxWorkPrd, type HifoxWorkSource } from './task-workspace-source'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const id = z.string().min(1).max(256)
export const hifoxWorkReferencePathSchema = z.string().regex(/^references\/(?:source-materials\.json|[a-f0-9-]{36}\/[a-f0-9-]{36}\.(?:html|md|review\.json))$/i)
export const hifoxWorkRecordSchema = z.object({
  version: z.literal(1), workspaceKey: id, spaceId: id, sourceTaskId: id, ownerIdentity: hash,
  projectRoot: z.string().min(1).max(8192), commandId: id, slug: z.string().min(1).max(64),
  sourceRevision: hash, material: hifoxWorkMaterialSchema,
  cliTitle: z.string().min(1).max(500), cliDescription: z.string().max(1000), assignee: z.string().max(200),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']),
  stage: z.enum(['registered', 'dispatching', 'failed', 'uncertain', 'cli_created', 'ready']),
  relativeDir: z.string().max(4096).nullable(), localTaskId: id.nullable(),
  baselinePrdRevision: hash.nullable(), generatedPrdRevision: hash.nullable(),
  referenceFiles: z.array(z.object({ relativePath: hifoxWorkReferencePathSchema, bodyDigest: hash }).strict()).max(41).optional()
}).strict()
export type HifoxWorkRecord = z.infer<typeof hifoxWorkRecordSchema>
export type StoredHifoxWorkRecord = { value: HifoxWorkRecord; revision: string | null }
export const nativeRootKey = (root: string): string => process.platform === 'win32' ? root.toLowerCase() : root
export const bindingKey = (scope: { workspaceKey: string; spaceId: string; taskId: string }): string => sha256Hex(JSON.stringify([scope.workspaceKey, scope.spaceId, scope.taskId]))

/** Only local userData contains machine paths and the command's original material snapshot. */
export class HifoxWorkBindings {
  constructor(private readonly dataDir: string) {}
  file(scope: { workspaceKey: string; spaceId: string; taskId: string }): string { return `hifox-work/bindings/${bindingKey(scope)}.json` }
  read(source: HifoxWorkSource): StoredHifoxWorkRecord | null {
    try {
      const found = materialRead(this.dataDir, this.file(source))
      if (found.revision === null) return null
      const value = hifoxWorkRecordSchema.parse(JSON.parse(found.body))
      if (value.workspaceKey !== source.workspaceKey || value.spaceId !== source.spaceId || value.sourceTaskId !== source.taskId || value.ownerIdentity !== source.identity) throw new HifoxWorkError('scope_changed', '本机绑定属于另一协作身份，不能转用。')
      if (sha256Hex(JSON.stringify(value.material)) !== value.sourceRevision || value.commandId !== commandId(source, value.projectRoot)) throw new Error('binding identity')
      return { value, revision: found.revision }
    } catch (error) {
      if (error instanceof HifoxWorkError) throw error
      throw new HifoxWorkError('store_unavailable', '本机准备记录不可读取或已损坏，原文件已保留。', IpcErrorCode.Io)
    }
  }
  save(record: StoredHifoxWorkRecord): void {
    try {
      const value = hifoxWorkRecordSchema.parse(record.value)
      const body = JSON.stringify(value) + '\n'
      materialWrite(this.dataDir, this.file({ workspaceKey: value.workspaceKey, spaceId: value.spaceId, taskId: value.sourceTaskId }), body, record.revision)
      record.revision = sha256Hex(body)
    } catch {
      throw new HifoxWorkError('store_unavailable', '本机准备记录保存失败或被并发修改，请保留原目录并重试核对。', IpcErrorCode.Io)
    }
  }
}
export function commandId(source: HifoxWorkSource, root: string): string {
  return operationIdFor({ workspaceId: `hifox:${sha256Hex(nativeRootKey(root))}`, instanceId: source.identity, issueIdentifier: JSON.stringify([source.workspaceKey, source.spaceId, source.taskId]), ordinal: 1 })
}
export function freshHifoxWorkRecord(source: HifoxWorkSource, projectRoot: string): StoredHifoxWorkRecord {
  const operation = commandId(source, projectRoot)
  return { revision: null, value: {
    version: 1, workspaceKey: source.workspaceKey, spaceId: source.spaceId, sourceTaskId: source.taskId, ownerIdentity: source.identity,
    projectRoot, commandId: operation, slug: `${slugFor(source.taskId, source.material.title).slice(0, 39)}-${operation.slice(-12)}`,
    sourceRevision: source.revision, material: source.material, cliTitle: source.material.title,
    cliDescription: `HiFox task ${source.taskId}: planning`, assignee: source.actorName.slice(0, 200) || source.actorId,
    priority: source.priority, stage: 'registered', relativeDir: null, localTaskId: null, baselinePrdRevision: null, generatedPrdRevision: null
  } }
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
  return [
    ['panel_operation_id', record.commandId], ['panel_hifox_workspace_key', record.workspaceKey],
    ['panel_hifox_space_id', record.spaceId], ['panel_hifox_task_id', record.sourceTaskId],
    ['panel_hifox_identity', record.ownerIdentity], ['panel_hifox_source_revision', record.sourceRevision]
  ]
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

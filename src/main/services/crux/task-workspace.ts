import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import {
  cruxWorkPrepareSchema, cruxWorkQuerySchema, cruxWorkChangeSchema, cruxDevelopmentRefSchema, cruxGovernanceInputPath,
  type CruxWorkFailure, type CruxWorkFailureReason, type CruxWorkLocal,
  type CruxWorkPrepareInput, type CruxWorkQuery, type CruxWorkResult, type CruxDevelopmentView, type CruxDevelopmentRef
} from '../../../shared/crux-work'
import { IpcErrorCode, ipcFail } from '../../../shared/ipc-errors'
import { materialRead, materialWrite } from '../knowledge-access/materials'
import { resolveAuthorizedDocumentPath } from '../documents/paths'
import { IntegrationError } from '../integrations/types'
import { runTaskCreateCli, recoverTaskCliOperation } from '../local-task/cli-runner'
import { assertTeamTrellisCapabilities, TeamTrellisCapabilitiesError } from '../local-task/team-capabilities'
import { sha256Hex, todayPrefix } from '../local-task/operations'
import { cruxWorkspaceGeneration, cruxWorkspaceSnapshot, cruxWorkspaceStatus } from './connection-service'
import { CruxWorkError, readCruxWorkSource, type CruxWorkSource, type CruxWorkSourceDependencies } from './task-workspace-source'
import type { CreationMaterialReference, CreationMaterialFile } from '../../../shared/creation-materials'
import { cruxWorkProjectIdentity, inspectCruxWorkProject, inspectCruxWorkExecutionProject, type CruxWorkProjectPreview } from './work-project'
import type { TeamTaskCodeResourceDto } from '../../../shared/team-code-resources'
import { taskMaterialInputPath, type TaskMaterialInputReference } from '../../../shared/task-material-inputs'
import {
  CruxWorkBindings, bindingKey, freshCruxWorkRecord, cruxPrepDirectoryExists, cruxWorkMeta, cruxWorkReferencePathSchema,
  nativeRootKey, plannedCruxPrd, pristineCruxPrd, reconcileCruxWork, validateCruxProject,
  summarizeCruxWork, type CruxWorkDiskTask, type CruxWorkRecord, type StoredCruxWorkRecord
} from './task-workspace-records'
import { inspectWorkcopyUse } from '../workcopy-use/client'
import { taskDevelopmentKey } from './task-development-identity'
import { withNativeWorkcopyPreparation } from '../workcopy-use/preparation'
import { resolveWorkcopy, assertWorkcopyObservation } from '../workcopy-use'
import type { WorkcopyLease } from '../../../shared/workcopy-use'
import { DaemonError } from '../../daemon/errors'

export type CruxTaskWorkspaceDependencies = {
  /** Main-owned app.getPath('userData'); never a renderer argument. */
  dataDir: string
  getProjectRoot(): string | null
  getProjectGeneration(): number
  workspaceGeneration?(): number
  workcopyUses?: typeof inspectWorkcopyUse
  /** Must be a native directory chooser. Cancellation returns null. */
  chooseProjectRoot(context: { taskId: string; taskTitle: string }): Promise<string | null>
  /** Human review is native and main-owned; a renderer boolean never grants a binding. */
  confirmProjectRoot(preview: CruxWorkProjectPreview): Promise<boolean>
  taskCodeResource(query: CruxWorkQuery): Promise<TeamTaskCodeResourceDto | null>
  workspaceStatus?: CruxWorkSourceDependencies['workspaceStatus']
  workspaceSnapshot?: CruxWorkSourceDependencies['workspaceSnapshot']
  creationReferences?: CruxWorkSourceDependencies['creationReferences']
  teamMaterialReferences?: CruxWorkSourceDependencies['teamMaterialReferences']
  teamInputs?: CruxWorkSourceDependencies['teamInputs']
  readExecutionSource?(query: CruxWorkQuery, expected?: CruxWorkSource): Promise<ResourceWorkSource | null>
  governanceFiles?(query: CruxWorkQuery & { spaceId: string; taskCreatedAt: string }, input: NonNullable<CruxWorkSource['material']['governance']>): Promise<CreationMaterialFile[]>
  creationFiles?(query: CruxWorkQuery, references: CreationMaterialReference[]): Promise<CreationMaterialFile[]>
  teamMaterialFiles?(query: CruxWorkQuery, references: TaskMaterialInputReference[]): Promise<CreationMaterialFile[]>
  /** Isolated service regression boundary. Production uses the existing task.py runner. */
  cliRunner?: typeof runTaskCreateCli
  recoverCli?: typeof recoverTaskCliOperation
  prepareWorkcopy?: typeof withNativeWorkcopyPreparation
}
const preparations = new Map<string, Promise<void>>()
type ResourceWorkSource = CruxWorkSource & { codeResource: TeamTaskCodeResourceDto | null }
const resourceProof = (source: ResourceWorkSource): string => sha256Hex(JSON.stringify(source.codeResource ? [source.codeResource.taskCreatedAt, source.codeResource.revision,
  source.codeResource.availability, source.codeResource.resource?.resourceId, source.codeResource.resource?.revision, source.codeResource.resource?.source] : null))

function failure(reason: CruxWorkFailureReason, error: string, code: IpcErrorCode = IpcErrorCode.Conflict, local?: CruxWorkLocal): CruxWorkFailure {
  return {
    ...ipcFail(code, error), reason,
    ...(local ? { local } : {}),
    ...(reason === 'outcome_unknown' ? { outcomeUnknown: true } : {}),
    ...(['source_changed', 'prd_conflict'].includes(reason) ? { reviewRequired: true } : {})
  }
}
function caught(error: unknown): CruxWorkFailure {
  if (error instanceof CruxWorkError) return failure(error.reason, error.message, error.code)
  if (error instanceof DaemonError) return failure(error.code === 'E_UNKNOWN' ? 'outcome_unknown' : ['E_CONFLICT', 'E_BUSY'].includes(error.code) ? 'workcopy_in_use' : 'store_unavailable', error.message, error.code === 'E_UNKNOWN' ? IpcErrorCode.Unknown : IpcErrorCode.Conflict)
  if (error instanceof z.ZodError) return failure('invalid_input', '本机任务准备参数或来源材料无效。', IpcErrorCode.InvalidArg)
  return failure('store_unavailable', '本机任务准备未完成，原绑定和文件已保留，请重新核对。', IpcErrorCode.Io)
}
function referenceFilePath(record: CruxWorkRecord, relativeDir: string, relativePath: string): string {
  const path = `${relativeDir}/${relativePath}`
  const authorized = resolveAuthorizedDocumentPath(record.projectRoot, path)
  if (!cruxWorkReferencePathSchema.safeParse(relativePath).success || !authorized.ok || nativeRootKey(authorized.canonicalPath) !== nativeRootKey(resolve(record.projectRoot, path))) throw new CruxWorkError('prd_conflict', '开发引用路径已被替换或重定向，请先审阅；原文件不会被覆盖。')
  return path
}

/** Prepares materials only. It neither changes the business task nor starts Trellis/ACP execution. */
export class CruxTaskWorkspaceService {
  private readonly bindings: CruxWorkBindings
  private readonly sourceDeps: CruxWorkSourceDependencies
  constructor(private readonly deps: CruxTaskWorkspaceDependencies) {
    this.bindings = new CruxWorkBindings(deps.dataDir)
    this.sourceDeps = { workspaceStatus: deps.workspaceStatus ?? cruxWorkspaceStatus, workspaceSnapshot: deps.workspaceSnapshot ?? cruxWorkspaceSnapshot,
      workspaceGeneration: deps.workspaceGeneration ?? (deps.workspaceStatus ? undefined : cruxWorkspaceGeneration),
      creationReferences: deps.creationReferences, teamMaterialReferences: deps.teamMaterialReferences, teamInputs: deps.teamInputs }
  }

  async development(raw: unknown): Promise<CruxDevelopmentView> {
    try {
      const query = cruxWorkQuerySchema.parse(raw)
      const authorization = { ...this.sourceDeps, creationReferences: undefined, teamMaterialReferences: undefined, teamInputs: undefined }
      const owner = await readCruxWorkSource(authorization, query)
      const active = this.bindings.read(owner), history = this.bindings.history(owner)
      let current: ResourceWorkSource | undefined, sourceError: string | undefined, sourceReason: CruxWorkFailureReason | undefined
      try { current = await this.source(query) }
      catch (error) {
        if (!(error instanceof CruxWorkError)) throw error
        sourceError = error.message; sourceReason = error.reason
      }
      await readCruxWorkSource(authorization, query, owner)
      const resourceId = current?.codeResource?.resource?.resourceId ?? active?.value.codeResource?.resourceId
      return { ok: true, active: active ? summarizeCruxWork(active.value) : null, history: history.items, historyHasMore: history.hasMore,
        candidates: resourceId ? this.bindings.candidates(owner, resourceId) : [], currentInputVersion: current?.revision ?? null, sourceError, sourceReason }
    } catch (error) { return caught(error) }
  }

  /** This return value is main-owned; an expected context reference is never a path grant. */
  async resolveContext(raw: unknown, expectedRaw: CruxDevelopmentRef): Promise<{
    local: CruxWorkLocal; spaceId: string; ownerId: string; taskCreatedAt: string; resourceId: string | null; repositoryUrl: string | null; authority: string; selectionGeneration?: number; taskKey: string
  }> {
    const query = cruxWorkQuerySchema.parse(raw), expected = cruxDevelopmentRefSchema.parse(expectedRaw)
    const executable = (value: CruxWorkSource): void => {
      if (value.closed || !value.canCreate) throw new CruxWorkError('access_locked', '当前阶段不允许本机开发操作，请回团队任务核对；原服务仍可从运行中心安全停止。', IpcErrorCode.Denied)
    }
    const attachResource = (value: CruxWorkSource, codeResource: TeamTaskCodeResourceDto | null): ResourceWorkSource => {
      if (codeResource && (codeResource.taskId !== value.taskId || codeResource.spaceId !== value.spaceId || codeResource.taskCreatedAt !== value.taskCreatedAt)) throw new CruxWorkError('scope_changed', '代码资源不属于原任务身份。')
      if (value.workspaceKey !== 'local' && (!codeResource || codeResource.availability !== 'available' || !codeResource.resource || !codeResource.selection?.resourceId)) throw new CruxWorkError('resource_required', '原任务代码资源不可用，请回团队任务核对。', IpcErrorCode.Unavailable)
      return { ...value, codeResource }
    }
    // Execution admission is a pair of fresh reads around native verification,
    // not the presentation/recovery status path or a reusable authorization cache.
    const atomic = await this.deps.readExecutionSource?.(query)
    const first = atomic ?? await readCruxWorkSource(this.sourceDeps, query)
    executable(first)
    const source = attachResource(first, atomic ? atomic.codeResource : await this.deps.taskCodeResource(query)), stored = this.bindings.read(source)
    if (!stored || stored.value.stage !== 'ready' || stored.value.commandId !== expected.contextId || (stored.value.generation ?? 1) !== expected.generation) throw new CruxWorkError('binding_review_required', '本次开发环境已变化，请重新打开任务核对。')
    const record = stored.value
    if (!record.taskCreatedAt || record.taskCreatedAt !== source.taskCreatedAt || record.git === undefined || !record.projectIdentity) throw new CruxWorkError('binding_review_required', '原绑定缺少完整任务、工作副本或 Git 身份，请先明确准备开发环境。')
    if (record.sourceRevision !== source.revision) throw new CruxWorkError('source_changed', '当前采用输入已变化，请比较后建立明确的新尝试。')
    if (source.codeResource?.resource) {
      const binding = record.codeResource
      if (!binding || binding.resourceId !== source.codeResource.resource.resourceId || binding.selectionRevision !== source.codeResource.selection?.revision || binding.sourceDigest !== sha256Hex(JSON.stringify(source.codeResource.resource.source))) throw new CruxWorkError('resource_changed', '任务代码资源选用已变化，未沿用原开发环境。')
    }
    validateCruxProject(record.projectRoot, true)
    this.assertProjectIdentity(record)
    const observation = resolveWorkcopy(record.projectRoot)
    await this.teamAdapter(record.projectRoot, source)
    const verifyFiles = (): CruxWorkDiskTask => {
      this.assertProjectIdentity(record)
      const disk = reconcileCruxWork(record)
      if (!disk || disk.local.archived || disk.sourceRevision !== record.sourceRevision) throw new CruxWorkError('task_conflict', '原任务目录、归档状态或固定输入无法核对。')
      if (!record.referenceFiles?.some(file => file.relativePath === 'references/source-materials.json' && file.bodyDigest === record.sourceRevision)) throw new CruxWorkError('binding_review_required', '原固定输入索引登记不完整，请明确准备后再执行。')
      for (const file of record.referenceFiles) {
        if (materialRead(record.projectRoot, referenceFilePath(record, disk.local.relativeDir, file.relativePath)).revision !== file.bodyDigest) throw new CruxWorkError('prd_conflict', '已采用的开发引用已修改或删除，请先核对原输入。')
      }
      const prd = materialRead(record.projectRoot, `${disk.local.relativeDir}/prd.md`)
      if (prd.revision === null || record.generatedPrdRevision === null) throw new CruxWorkError('prd_conflict', '已准备的 PRD 缺失或缺少保存回执，请先核对；不会自动重建。')
      const task = z.object({ id: z.string(), meta: z.record(z.string(), z.unknown()) }).passthrough().parse(JSON.parse(materialRead(record.projectRoot, `${disk.local.relativeDir}/task.json`).body))
      if (task.id !== record.localTaskId || cruxWorkMeta(record).some(([key, value]) => key !== 'panel_task_authority' && task.meta[key] !== value)) throw new CruxWorkError('task_conflict', '原本机任务来源已变化，未授予执行权限。')
      if (source.workspaceKey !== 'local' && task.meta.panel_task_authority !== 'team') throw new CruxWorkError('binding_review_required', '原任务缺少团队状态权威，请从准备入口核对；执行检查不会补写任务。')
      return disk
    }
    verifyFiles()
    const preview = await inspectCruxWorkExecutionProject(record.projectRoot, source.codeResource?.resource ?? undefined)
    if (!preview.resourceMatched || record.git && (!preview.git || preview.git.repoRoot !== record.git.repoRoot || preview.git.branch !== record.git.branch || preview.git.detached !== record.git.detached || record.git.detached && preview.git.head !== record.git.head)) throw new CruxWorkError('project_changed', '原副本的仓库或分支已变化，请核对新的开发尝试。')
    const finalAtomic = await this.deps.readExecutionSource?.(query, source)
    let rechecked: ResourceWorkSource
    if (finalAtomic) rechecked = attachResource(finalAtomic, finalAtomic.codeResource)
    else {
      const finalResource = await this.deps.taskCodeResource(query)
      rechecked = attachResource(await readCruxWorkSource(this.sourceDeps, query, source), finalResource)
    }
    executable(rechecked)
    if (rechecked.spaceId !== source.spaceId || rechecked.taskCreatedAt !== source.taskCreatedAt || rechecked.identity !== source.identity || rechecked.authority !== source.authority || rechecked.selectionGeneration !== source.selectionGeneration) throw new CruxWorkError('scope_changed', '核对期间原任务或来源身份已变化。')
    if (rechecked.revision !== source.revision || rechecked.revision !== record.sourceRevision) throw new CruxWorkError('source_changed', '核对期间当前采用输入已变化，未继续旧操作。')
    if (resourceProof(rechecked) !== resourceProof(source)) throw new CruxWorkError('resource_changed', '核对期间任务代码资源已变化。')
    const current = this.bindings.read(rechecked)
    if (!current || current.value.commandId !== expected.contextId || (current.value.generation ?? 1) !== expected.generation || current.revision !== stored.revision) throw new CruxWorkError('binding_review_required', '核对期间开发绑定已被更新。')
    const disk = verifyFiles()
    assertWorkcopyObservation(resolveWorkcopy(record.projectRoot), observation)
    const local: CruxWorkLocal = { ...disk.local, development: { contextId: record.commandId, generation: record.generation ?? 1, taskCreatedAt: record.taskCreatedAt, inputVersion: record.sourceRevision, branch: record.git?.branch ?? null, head: preview.git?.head ?? null },
      ...(record.codeResource ? { resourceBinding: { ...record.codeResource, projectIdentity: record.projectIdentity, taskCreatedAt: record.taskCreatedAt } } : {}) }
    return { local, spaceId: source.spaceId, ownerId: source.actorId, taskCreatedAt: source.taskCreatedAt, resourceId: source.codeResource?.resource?.resourceId ?? null, repositoryUrl: source.codeResource?.resource?.source.repositoryUrl ?? null, authority: source.authority, selectionGeneration: source.selectionGeneration, taskKey: taskDevelopmentKey(source) }
  }

  /** Draft publication preserves its original input; it grants no new execution. */
  async resolveOutputContext(raw: unknown, expectedRaw: CruxDevelopmentRef): Promise<{
    local: CruxWorkLocal; spaceId: string; ownerId: string; authority: string; selectionGeneration?: number
  }> {
    const query = cruxWorkQuerySchema.parse(raw), expected = cruxDevelopmentRefSchema.parse(expectedRaw)
    const authorization = { ...this.sourceDeps, creationReferences: undefined, teamMaterialReferences: undefined, teamInputs: undefined }
    const source = await readCruxWorkSource(authorization, query), stored = this.bindings.read(source)
    if (source.closed || !source.canCreate || !stored || stored.value.stage !== 'ready' || stored.value.commandId !== expected.contextId || (stored.value.generation ?? 1) !== expected.generation) throw new CruxWorkError('binding_review_required', '原产物上下文不可用或任务已交接，请从原任务核对。')
    const record = stored.value
    validateCruxProject(record.projectRoot, true); this.assertProjectIdentity(record)
    if (!record.taskCreatedAt || record.git === undefined) throw new CruxWorkError('binding_review_required', '原尝试缺少完整身份，请明确准备后再共享本机产物。')
    const resource = await this.deps.taskCodeResource(query), binding = record.codeResource
    if (source.workspaceKey !== 'local' && (!binding || resource?.availability !== 'available' || resource.taskCreatedAt !== source.taskCreatedAt || resource.spaceId !== source.spaceId || resource.resource?.resourceId !== binding.resourceId || resource.selection?.revision !== binding.selectionRevision || sha256Hex(JSON.stringify(resource.resource.source)) !== binding.sourceDigest)) throw new CruxWorkError('resource_changed', '原产物的代码资源已变化，未改用其他仓库上传。')
    const preview = await inspectCruxWorkExecutionProject(record.projectRoot, resource?.resource ?? undefined)
    if (!preview.resourceMatched || record.git && (!preview.git || preview.git.repoRoot !== record.git.repoRoot || preview.git.branch !== record.git.branch || preview.git.detached !== record.git.detached || record.git.detached && preview.git.head !== record.git.head)) throw new CruxWorkError('project_changed', '原产物副本的仓库或分支已变化，请先核对。')
    const disk = reconcileCruxWork(record)
    if (!disk || disk.sourceRevision !== record.sourceRevision || !record.referenceFiles?.some(file => file.relativePath === 'references/source-materials.json' && file.bodyDigest === record.sourceRevision)) throw new CruxWorkError('task_conflict', '原任务目录或冻结输入索引无法核对。')
    for (const file of record.referenceFiles) if (materialRead(record.projectRoot, referenceFilePath(record, disk.local.relativeDir, file.relativePath)).revision !== file.bodyDigest) throw new CruxWorkError('prd_conflict', '原固定输入文件已改变，未继续产物操作。')
    const current = await readCruxWorkSource(authorization, query, source), active = this.bindings.read(current)
    this.assertProjectIdentity(record)
    if (current.closed || !current.canCreate || active?.value.commandId !== record.commandId || active.revision !== stored.revision) throw new CruxWorkError('binding_review_required', '读取产物期间原任务或开发尝试已变化。')
    const local: CruxWorkLocal = { ...disk.local, development: { contextId: record.commandId, generation: record.generation ?? 1, taskCreatedAt: record.taskCreatedAt, inputVersion: record.sourceRevision, branch: record.git?.branch ?? null, head: preview.git?.head ?? null },
      ...(binding && record.projectIdentity ? { resourceBinding: { ...binding, projectIdentity: record.projectIdentity, taskCreatedAt: record.taskCreatedAt } } : {}) }
    return { local, spaceId: source.spaceId, ownerId: source.actorId, authority: source.authority, selectionGeneration: source.selectionGeneration }
  }

  private async source(query: CruxWorkQuery, expected?: ResourceWorkSource): Promise<ResourceWorkSource> {
    query = { workspaceKey: query.workspaceKey, taskId: query.taskId }
    let current: CruxWorkSource
    let atomic: ResourceWorkSource | null | undefined
    try { atomic = await this.deps.readExecutionSource?.(query, expected); current = atomic ?? await readCruxWorkSource(this.sourceDeps, query, expected) }
    catch (error) {
      if (error instanceof CruxWorkError || error instanceof z.ZodError) throw error
      throw new CruxWorkError('access_locked', '原协作空间或登录权限暂时无法核实，本机绑定已锁定。', IpcErrorCode.Denied)
    }
    if (expected && current.spaceId !== expected.spaceId) throw new CruxWorkError('scope_changed', '任务所属空间已变化，请在原空间核对绑定。')
    if (expected && current.revision !== expected.revision) throw new CruxWorkError('source_changed', '业务任务的需求材料已变化，请先审阅原任务与本机 PRD。')
    if (expected?.canCreate && (current.closed || !current.canCreate)) throw new CruxWorkError('access_locked', '核对期间原任务已结束或已交接，未继续开发操作。', IpcErrorCode.Denied)
    const codeResource = atomic ? atomic.codeResource : await this.deps.taskCodeResource(query)
    if (codeResource && (codeResource.taskId !== current.taskId || codeResource.spaceId !== current.spaceId || codeResource.taskCreatedAt !== current.taskCreatedAt)) throw new CruxWorkError('scope_changed', '代码资源不属于原任务身份。')
    if (current.workspaceKey !== 'local' && (!codeResource || codeResource.availability !== 'available' || !codeResource.resource || !codeResource.selection?.resourceId)) {
      throw new CruxWorkError('resource_required', '请先为此团队任务选择空间内可用的代码资源，再绑定本机工程。', IpcErrorCode.Unavailable)
    }
    if (!atomic) await readCruxWorkSource(this.sourceDeps, query, current)
    const result = { ...current, codeResource }
    if (expected && resourceProof(result) !== resourceProof(expected)) throw new CruxWorkError('resource_changed', '任务代码资源或其版本已变化，请重新核对开发环境。')
    return result
  }

  private async teamAdapter(root: string, source: CruxWorkSource): Promise<void> {
    if (source.workspaceKey === 'local') return
    try { await assertTeamTrellisCapabilities(root) }
    catch (error) {
      if (error instanceof TeamTrellisCapabilitiesError) throw new CruxWorkError('project_invalid', error.message, IpcErrorCode.InvalidArg)
      throw new CruxWorkError('project_invalid', '工程的 Trellis 团队适配能力尚未确认；未准备或打开本机团队任务。', IpcErrorCode.InvalidArg)
    }
  }

  async status(raw: unknown): Promise<CruxWorkResult> {
    try {
      const input = cruxWorkQuerySchema.parse(raw)
      const source = await this.source(input)
      const stored = this.bindings.read(source)
      if (!stored) return { ok: true, ...input, prepared: false, local: null }
      validateCruxProject(stored.value.projectRoot, true)
      this.assertProjectIdentity(stored.value)
      await this.teamAdapter(stored.value.projectRoot, source)
      await this.source(input, source)
      const disk = reconcileCruxWork(stored.value)
      if (!disk) {
        if (['dispatching', 'uncertain'].includes(stored.value.stage)) return failure('outcome_unknown', '原创建命令尚未核实，请保留绑定；重试将先核对原目录。')
        return { ok: true, ...input, prepared: false, local: null }
      }
      if (disk.sourceRevision !== stored.value.sourceRevision) return failure('task_conflict', '本机恢复标识与原准备记录的材料版本不一致。', IpcErrorCode.Conflict, disk.local)
      if (stored.value.stage !== 'ready') return { ok: true, ...input, prepared: false, local: null }
      if (source.codeResource?.resource) {
        const binding = stored.value.codeResource
        if (!binding || !stored.value.projectIdentity) return failure('resource_required', '原开发环境尚未核对任务代码资源，请重新准备并确认绑定。', IpcErrorCode.Unavailable, disk.local)
        if (binding.resourceId !== source.codeResource.resource.resourceId || binding.selectionRevision !== source.codeResource.selection?.revision
          || binding.sourceDigest !== sha256Hex(JSON.stringify(source.codeResource.resource.source))) return failure('resource_changed', '任务代码资源选用已变化，原开发环境仅作历史保留；请明确核对新的开发尝试。', IpcErrorCode.Conflict, disk.local)
      }
      return await this.ready(source, stored.value, disk, false)
    } catch (error) { return caught(error) }
  }

  async prepare(raw: unknown): Promise<CruxWorkResult> {
    try {
      const input = cruxWorkPrepareSchema.parse(raw)
      return await this.serialized(input, source => this.prepareOwned(input, source))
    } catch (error) { return caught(error) }
  }

  async change(raw: unknown): Promise<CruxWorkResult> {
    try {
      const input = cruxWorkChangeSchema.parse(raw)
      return await this.serialized(input, async source => {
        if (!source.canCreate || source.closed) return failure('access_locked', '当前任务阶段不能创建开发尝试，请从团队流程重新交接后继续。', IpcErrorCode.Denied)
        const stored = this.bindings.read(source)
        if (!stored) return failure('binding_review_required', '原开发绑定不存在，请先选择本机开发环境。')
        const requestDigest = sha256Hex(JSON.stringify(input))
        if (stored.value.change?.commandId === input.commandId) {
          if (stored.value.change.requestDigest !== requestDigest) return failure('task_conflict', '原操作编号的内容不同，未创建替代尝试。')
          if (source.revision !== input.expectedInputVersion) return failure('source_changed', '原操作使用的输入已变化，请先核对已准备结果。')
          return this.prepareOwned({ workspaceKey: input.workspaceKey, taskId: input.taskId }, source)
        }
        if (stored.value.commandId !== input.expected.contextId || (stored.value.generation ?? 1) !== input.expected.generation) return failure('binding_review_required', '原开发绑定已变化，请重新打开环境详情。')
        if (source.revision !== input.expectedInputVersion) return failure('source_changed', '核对后输入再次变化，请重新比较；原开发现场已保留。')
        if (['dispatching', 'uncertain', 'cli_created'].includes(stored.value.stage)) return failure('outcome_unknown', '原准备操作尚未核实，不能通过更换环境绕过它。')
        const previousOperations = [...(stored.value.previousOperations ?? []), stored.value.commandId]
        if (previousOperations.length > 128) return failure('store_unavailable', '此任务开发尝试已达保留上限，请先整理历史，原记录不会删除。', IpcErrorCode.Unavailable)
        const generation = this.deps.getProjectGeneration()
        const assertCurrent = (): void => {
          if (generation !== this.deps.getProjectGeneration()) throw new CruxWorkError('project_changed', '核对期间工程已切换，原绑定保持不变。')
        }
        const selected = input.mode === 'choose-copy'
          ? await this.chooseRoot({ workspaceKey: input.workspaceKey, taskId: input.taskId, candidateId: input.candidateId }, source)
          : await this.reviewProject(input, source, validateCruxProject(stored.value.projectRoot, true), assertCurrent).then(preview => ({ root: preview.root, identity: preview.identity, git: preview.git, assertCurrent }))
        selected.assertCurrent()
        const usage = await (this.deps.workcopyUses ?? inspectWorkcopyUse)(selected.root)
        if (usage.uses.length) return failure('workcopy_in_use', '所选副本仍有执行或服务使用，请查看占用并完成原运行清理，或选择独立副本。', IpcErrorCode.Conflict)
        await this.source(input, source)
        selected.assertCurrent()
        const next = freshCruxWorkRecord(source, selected.root, (stored.value.generation ?? 1) + 1)
        const preview = await inspectCruxWorkProject(selected.root, source.taskId, source.material.title, source.codeResource?.resource ?? undefined)
        if (preview.identity !== selected.identity || preview.git?.revision !== selected.git?.revision) throw new CruxWorkError('project_changed', '所选副本或 Git 状态已变化，未更换原绑定。')
        next.value.projectIdentity = selected.identity
        next.value.git = preview.git ? { repoRoot: preview.git.repoRoot, branch: preview.git.branch, head: preview.git.head, detached: preview.git.detached } : null
        next.value.previousOperations = previousOperations
        next.value.change = { commandId: input.commandId, requestDigest, previousContextId: stored.value.commandId }
        if (source.codeResource?.resource && source.codeResource.selection) next.value.codeResource = {
          resourceId: source.codeResource.resource.resourceId, selectionRevision: source.codeResource.selection.revision, sourceDigest: sha256Hex(JSON.stringify(source.codeResource.resource.source))
        }
        await this.source(input, source)
        selected.assertCurrent()
        this.bindings.replace(source, stored, next)
        return this.prepareOwned({ workspaceKey: input.workspaceKey, taskId: input.taskId }, source)
      })
    } catch (error) { return caught(error) }
  }

  private async serialized(input: CruxWorkQuery, operation: (source: ResourceWorkSource) => Promise<CruxWorkResult>): Promise<CruxWorkResult> {
    let release: (() => void) | undefined
    let key: string | undefined
    let tail: Promise<void> | undefined
    try {
      const original = await this.source(input)
      key = `${resolve(this.deps.dataDir)}:${bindingKey(original)}`
      const previous = preparations.get(key)
      tail = new Promise<void>((done) => { release = done })
      preparations.set(key, tail)
      if (previous) await previous
      const source = await this.source(input, original)
      return await operation(source)
    } catch (error) { return caught(error) }
    finally {
      release?.()
      if (key && preparations.get(key) === tail) preparations.delete(key)
    }
  }

  private expectedRoot(expected: string | undefined, root: string): void {
    if (!expected) return
    try { if (nativeRootKey(realpathSync.native(expected)) === nativeRootKey(root)) return } catch { /* No root grant comes from an unreadable renderer path. */ }
    throw new CruxWorkError('project_changed', '所选项目与本机绑定或主进程当前项目不一致，请刷新后重试。')
  }
  private async chooseRoot(input: CruxWorkPrepareInput, source: ResourceWorkSource): Promise<{ root: string; identity: string; git: CruxWorkProjectPreview['git']; assertCurrent(): void }> {
    const generation = this.deps.getProjectGeneration()
    const assertCurrent = (): void => {
      if (this.deps.getProjectGeneration() !== generation) throw new CruxWorkError('project_changed', '核对期间本机工程已切换，请重新选择任务的开发环境。')
    }
    // A currently open valid project is only a browsing choice, not this task's resource.
    const candidate = input.candidateId && source.codeResource?.resource ? this.bindings.candidates(source, source.codeResource.resource.resourceId).find(item => item.id === input.candidateId) : undefined
    if (input.candidateId && !candidate) throw new CruxWorkError('project_changed', '此副本候选不属于当前设备的原资源，请重新选择。')
    const chosen = candidate?.projectRoot ?? await this.deps.chooseProjectRoot({ taskId: source.taskId, taskTitle: source.material.title })
    await this.source(input, source)
    assertCurrent()
    if (!chosen) throw new CruxWorkError('cancelled', '已取消选择本机 Trellis 项目。', IpcErrorCode.Denied)
    const root = validateCruxProject(chosen)
    if (candidate && cruxWorkProjectIdentity(root) !== candidate.projectIdentity) throw new CruxWorkError('project_changed', '此副本目录已被移动或替换，请重新绑定，不能复用同名路径。')
    this.expectedRoot(input.projectRoot, root)
    const { identity, git } = await this.reviewProject(input, source, root, assertCurrent)
    return { root, identity, git, assertCurrent: () => {
      assertCurrent()
      if (cruxWorkProjectIdentity(root) !== identity) throw new CruxWorkError('project_changed', '已确认的工程目录已被替换，请重新核对。')
    } }
  }

  private assertProjectIdentity(record: CruxWorkRecord): void {
    if (record.projectIdentity && cruxWorkProjectIdentity(record.projectRoot) !== record.projectIdentity) {
      throw new CruxWorkError('project_changed', '原工程目录的物理身份已变化，绑定已保留；请核对原工作副本，不能用同名目录替代。')
    }
  }

  private async reviewProject(input: CruxWorkQuery, source: ResourceWorkSource, root: string, assertCurrent: () => void): Promise<CruxWorkProjectPreview> {
    const preview = await inspectCruxWorkProject(root, source.taskId, source.material.title, source.codeResource?.resource ?? undefined)
    if (preview.resource && !preview.resource.matched) throw new CruxWorkError('repository_mismatch', `所选工程的 Git 来源与任务代码资源「${preview.resource.name}」不一致或无法核对。请重新选择对应工作副本；原文件不会改变。`)
    assertCurrent()
    await this.source(input, source)
    const approved = await this.deps.confirmProjectRoot(preview)
    assertCurrent()
    await this.source(input, source)
    if (!approved) throw new CruxWorkError('cancelled', '已取消绑定开发环境，任务和原文件未改变。', IpcErrorCode.Denied)
    const current = await inspectCruxWorkProject(root, source.taskId, source.material.title, source.codeResource?.resource ?? undefined)
    assertCurrent()
    await this.source(input, source)
    if (current.identity !== preview.identity || current.git?.revision !== preview.git?.revision || current.gitError !== preview.gitError || current.resource?.matched !== preview.resource?.matched) {
      throw new CruxWorkError('project_changed', '确认期间工程或 Git 状态发生变化，请重新核对后绑定。')
    }
    return current
  }

  private async prepareOwned(input: CruxWorkPrepareInput, source: ResourceWorkSource): Promise<CruxWorkResult> {
    if (source.closed) return failure('access_locked', '任务已结束；原开发材料保留，新的开发请通过团队流程重新安排。', IpcErrorCode.Denied)
    if (source.material.workKind !== 'code') return failure('invalid_input', '一般事务不创建本机代码任务，请使用任务交付流程。', IpcErrorCode.InvalidArg)
    let stored = this.bindings.read(source)
    if (stored) {
      validateCruxProject(stored.value.projectRoot, true)
      this.assertProjectIdentity(stored.value)
      this.expectedRoot(input.projectRoot, stored.value.projectRoot)
      const resource = source.codeResource?.resource
      if (stored.value.codeResource && (!resource || stored.value.codeResource.resourceId !== resource.resourceId || stored.value.codeResource.sourceDigest !== sha256Hex(JSON.stringify(resource.source)))) {
        throw new CruxWorkError('resource_changed', '原本机绑定属于另一代码资源，不能静默改绑；请核对原开发尝试。')
      }
      if (!stored.value.projectIdentity || resource && (!stored.value.codeResource || stored.value.codeResource.selectionRevision !== source.codeResource?.selection?.revision)) {
        const generation = this.deps.getProjectGeneration()
        const reviewed = await this.reviewProject(input, source, stored.value.projectRoot, () => {
          if (this.deps.getProjectGeneration() !== generation) throw new CruxWorkError('project_changed', '核对期间本机工程已切换，请重新打开原任务。')
        })
        stored.value.projectIdentity = reviewed.identity
        this.bindings.save(stored)
      }
    } else {
      const selected = await this.chooseRoot(input, source)
      // Also fence synchronous chooser implementations and current-root admission across the await.
      source = await this.source(input, source)
      selected.assertCurrent()
      const concurrent = this.bindings.read(source)
      stored = concurrent ?? freshCruxWorkRecord(source, selected.root)
      if (concurrent) this.expectedRoot(selected.root, concurrent.value.projectRoot)
      this.assertProjectIdentity(stored.value)
      stored.value.projectIdentity ??= selected.identity
      if (!concurrent) stored.value.git = selected.git ? { repoRoot: selected.git.repoRoot, branch: selected.git.branch, head: selected.git.head, detached: selected.git.detached } : null
    }
    const record = stored.value
    if (source.codeResource?.resource && source.codeResource.selection) {
      const binding = { resourceId: source.codeResource.resource.resourceId,
        selectionRevision: source.codeResource.selection.revision, sourceDigest: sha256Hex(JSON.stringify(source.codeResource.resource.source)) }
      if (JSON.stringify(record.codeResource) !== JSON.stringify(binding)) {
        record.codeResource = binding
        // A reused ready task can return before the creation path persists metadata.
        this.bindings.save(stored)
      }
    }
    this.assertProjectIdentity(record)
    // Probe before any creation, authority adoption or reference-file write.
    await this.teamAdapter(record.projectRoot, source)
    source = await this.source(input, source)
    this.assertProjectIdentity(record)
    let disk = reconcileCruxWork(record)
    if (record.sourceRevision !== source.revision || (disk && disk.sourceRevision !== source.revision)) return failure('source_changed', '业务任务的需求材料已变化，请审阅已有本机 PRD；原文不会被覆盖。', IpcErrorCode.Conflict, disk?.local)
    if (record.stage === 'ready' && disk) return await this.ready(source, record, disk, false)
    if (stored.revision === null) this.bindings.save(stored)
    return await (this.deps.prepareWorkcopy ?? withNativeWorkcopyPreparation)(record.projectRoot, record.commandId, lease => this.completePreparation(input, source, stored, lease))
  }

  private async completePreparation(input: CruxWorkPrepareInput, source: ResourceWorkSource, stored: StoredCruxWorkRecord, lease: WorkcopyLease): Promise<CruxWorkResult> {
    const record = stored.value
    this.assertProjectIdentity(record)
    source = await this.source(input, source)
    const preview = await inspectCruxWorkProject(record.projectRoot, source.taskId, source.material.title, source.codeResource?.resource ?? undefined)
    if (preview.resource && !preview.resource.matched || record.git && (!preview.git || preview.git.repoRoot !== record.git.repoRoot || preview.git.branch !== record.git.branch || preview.git.detached !== record.git.detached || record.git.detached && preview.git.head !== record.git.head)) return failure('project_changed', '原生准入等待期间仓库或分支已变化，请重新核对开发尝试。')
    let disk = reconcileCruxWork(record)
    if (['dispatching', 'uncertain', 'failed'].includes(record.stage)) {
      const original = await (this.deps.recoverCli ?? recoverTaskCliOperation)(record.projectRoot, record.commandId)
      if (!original.cleanupConfirmed) return failure('outcome_unknown', '原创建操作或子进程尚未核对清理，未发送新的创建命令。')
      if (original.code !== 0 || original.aborted || original.failedToStart) {
        record.stage = 'failed'; this.bindings.save(stored)
        return failure('cli_failed', '原创建操作已确认失败且已清理。原目录保留，可核对后建立新的开发尝试。', IpcErrorCode.Io, disk?.local)
      }
      disk = reconcileCruxWork(record)
      if (!disk) return failure('task_missing', '原命令已完成，但原任务目录无法核实；不会再次执行创建命令。')
    }

    let created = false
    if (!disk) {
      if (!source.canCreate) return failure('invalid_input', '当前任务尚未进入开发交接或技术规划阶段，不能创建本机代码任务。', IpcErrorCode.InvalidArg)
      if (cruxPrepDirectoryExists(record, todayPrefix())) return failure('task_conflict', '准备目录已存在但来源无法核实，请先核对，不能覆盖或另建。')
      if (stored.revision === null) this.bindings.save(stored)
      record.stage = 'dispatching'
      this.bindings.save(stored) // A durable original command must precede the CLI side effect.
      let result: Awaited<ReturnType<typeof runTaskCreateCli>>
      try {
        result = await (this.deps.cliRunner ?? runTaskCreateCli)({ root: record.projectRoot, operationId: record.commandId, workcopyLease: lease }, {
          title: record.cliTitle, description: record.cliDescription, slug: record.slug,
          assignee: record.assignee, priority: record.priority, meta: cruxWorkMeta(record)
        })
      } catch {
        record.stage = 'uncertain'; this.bindings.save(stored)
        await this.source(input, source)
        return failure('outcome_unknown', '原创建命令未返回确定结果，请重试核对已有目录。')
      }
      if (!result.cleanupConfirmed) {
        record.stage = 'uncertain'; this.bindings.save(stored)
        return failure('outcome_unknown', '原创建命令的全部子进程清理尚未确认，请核对原操作。')
      }
      if (result.code !== 0 || result.aborted || result.failedToStart) {
        record.stage = result.failedToStart || (result.code !== null && !result.aborted) ? 'failed' : 'uncertain'
        this.bindings.save(stored)
        await this.source(input, source)
        return failure(record.stage === 'uncertain' ? 'outcome_unknown' : 'cli_failed', record.stage === 'uncertain' ? '原创建命令超时或结果不明确，请重试核对原目录。' : 'task.py 创建失败；原命令和绑定已保留，可以重试。', IpcErrorCode.Io)
      }
      await this.source(input, source)
      validateCruxProject(record.projectRoot, true)
      disk = reconcileCruxWork(record)
      if (!disk) {
        record.stage = 'uncertain'; this.bindings.save(stored)
        return failure('outcome_unknown', '创建命令已返回，但尚未找到携带原恢复标识的任务目录，请先核对。')
      }
      created = true
    }
    if (disk.sourceRevision !== record.sourceRevision) return failure('source_changed', '恢复目录的业务材料版本与原命令不同，请先审阅。', IpcErrorCode.Conflict, disk.local)
    record.relativeDir = disk.local.relativeDir
    record.localTaskId = disk.local.taskId
    record.stage = 'cli_created'
    this.bindings.save(stored)
    const path = `${record.relativeDir}/prd.md`
    const actual = materialRead(record.projectRoot, path)
    if (!pristineCruxPrd(record, actual)) return failure('prd_conflict', '本机 PRD 已有开发者修改，已保留原文；请先审阅原任务材料再继续。', IpcErrorCode.Conflict, disk.local)
    const planned = plannedCruxPrd(record)
    if (actual.revision !== sha256Hex(planned) && (disk.local.archived || disk.local.phase !== 'plan')) return failure('prd_conflict', '本机任务已离开规划阶段，请审阅已有材料；不会自动替换 PRD。', IpcErrorCode.Conflict, disk.local)
    record.baselinePrdRevision = actual.revision
    this.bindings.save(stored)
    await this.prepareReferenceFiles(input, source, record)
    if (actual.revision !== sha256Hex(planned)) {
      try { materialWrite(record.projectRoot, path, planned, actual.revision) }
      catch (error) {
        if (error instanceof IntegrationError && error.kind === 'conflict') return failure('prd_conflict', '保存期间 PRD 已发生修改，请先审阅；原文不会被覆盖。', IpcErrorCode.Conflict, disk.local)
        throw error
      }
    }
    record.generatedPrdRevision = sha256Hex(planned)
    record.stage = 'ready'
    this.bindings.save(stored)
    return await this.ready(source, record, disk, created)
  }

  private async ready(source: ResourceWorkSource, record: CruxWorkRecord, disk: CruxWorkDiskTask, created: boolean): Promise<CruxWorkResult> {
    const local: CruxWorkLocal = { ...disk.local, development: { contextId: record.commandId, generation: record.generation ?? 1,
      taskCreatedAt: record.taskCreatedAt ?? source.taskCreatedAt, inputVersion: record.sourceRevision, branch: record.git?.branch ?? null, head: record.git?.head ?? null },
      ...(record.codeResource && record.projectIdentity ? { resourceBinding: { ...record.codeResource, taskCreatedAt: source.taskCreatedAt, projectIdentity: record.projectIdentity } } : {}) }
    if (!record.taskCreatedAt || record.git === undefined) return failure('binding_review_required', '原绑定尚未记录完整的任务与分支身份，请核对并建立新的开发尝试；原目录保留。', IpcErrorCode.Conflict, local)
    const preview = await inspectCruxWorkProject(record.projectRoot, source.taskId, source.material.title, source.codeResource?.resource ?? undefined)
    await this.source({ workspaceKey: source.workspaceKey, taskId: source.taskId }, source)
    this.assertProjectIdentity(record)
    if (preview.resource && !preview.resource.matched || record.git && (!preview.git || preview.git.repoRoot !== record.git.repoRoot || preview.git.branch !== record.git.branch || preview.git.detached !== record.git.detached || record.git.detached && preview.git.head !== record.git.head)) return failure('project_changed', '原副本的仓库或分支已变化，请核对并采用为新开发尝试；旧会话不会迁移。', IpcErrorCode.Conflict, local)
    if (local.development && preview.git) local.development.head = preview.git.head
    for (const file of record.referenceFiles ?? []) {
      if (file.relativePath === 'references/source-materials.json' && file.bodyDigest !== record.sourceRevision) return failure('binding_review_required', '原输入索引字节版本需要重新准备，请核对后建立新尝试；原文件保留。', IpcErrorCode.Conflict, local)
      const current = materialRead(record.projectRoot, referenceFilePath(record, disk.local.relativeDir, file.relativePath))
      if (current.revision !== file.bodyDigest) return failure('prd_conflict', '已采用的开发引用被修改或删除，请先审阅；原文件不会被覆盖。', IpcErrorCode.Conflict, disk.local)
    }
    const actual = materialRead(record.projectRoot, `${disk.local.relativeDir}/prd.md`)
    if (actual.revision === null || record.generatedPrdRevision === null) return failure('prd_conflict', '已准备的 PRD 已删除或缺少保存回执，请先核对；不会自动重建。', IpcErrorCode.Conflict, disk.local)
    const prdModified = actual.revision !== record.generatedPrdRevision
    const active = this.bindings.read(source)
    if (!active || active.value.commandId !== record.commandId || active.value.sourceRevision !== record.sourceRevision) return failure('binding_review_required', '原开发尝试已经被新的绑定取代，请重新打开任务。', IpcErrorCode.Conflict, local)
    if (source.workspaceKey !== 'local') {
      // The existing prepare/open entry must not leave a second local task authority.
      const path = `${disk.local.relativeDir}/task.json`
      const original = materialRead(record.projectRoot, path)
      const task = z.object({ id: z.string(), meta: z.record(z.string(), z.unknown()) }).passthrough().parse(JSON.parse(original.body))
      if (task.id !== record.localTaskId || cruxWorkMeta(record).some(([key, value]) => key !== 'panel_task_authority' && task.meta[key] !== value)) {
        throw new CruxWorkError('task_conflict', '原本机任务来源已变化，未启用团队状态权威。')
      }
      if (task.meta.panel_task_authority !== undefined && task.meta.panel_task_authority !== 'team') throw new CruxWorkError('task_conflict', '原任务已声明其它状态权威，不能自动替换。')
      if (task.meta.panel_task_authority !== 'team') {
        task.meta = { ...task.meta, panel_task_authority: 'team' }
        materialWrite(record.projectRoot, path, JSON.stringify(task, null, 2) + '\n', original.revision)
      }
    }
    this.bindings.remember(source, record)
    return {
      ok: true, workspaceKey: source.workspaceKey, taskId: source.taskId, prepared: true, local,
      created, reused: !created, sourceRevision: source.revision, preparedRevision: record.sourceRevision,
      reviewRequired: source.revision !== record.sourceRevision, prdModified,
      notes: prdModified ? ['已保留本机 PRD 的开发者修改。'] : []
    }
  }
  private async prepareReferenceFiles(query: CruxWorkQuery, source: ResourceWorkSource, record: CruxWorkRecord): Promise<void> {
    query = { workspaceKey: query.workspaceKey, taskId: query.taskId }
    if (!record.relativeDir) throw new CruxWorkError('task_missing', '本机任务目录尚未确认。')
    const references = record.material.creationReferences ?? []
    if (references.length && !this.deps.creationFiles) throw new CruxWorkError('source_changed', '当前宿主不支持读取已采用的原型材料，请更新桌面端。')
    const files = await this.deps.creationFiles?.(query, references) ?? []
    const teamReferences = record.material.teamMaterialReferences ?? []
    if (teamReferences.length && !this.deps.teamMaterialFiles) throw new CruxWorkError('source_changed', '当前宿主尚未接入固定团队文档读取，未把索引冒充正文。')
    const teamFiles = await this.deps.teamMaterialFiles?.(query, teamReferences) ?? []
    if (teamFiles.length !== teamReferences.length) throw new CruxWorkError('source_changed', '批准团队文档的实际读取范围不完整，未继续准备。')
    if (new Set(teamFiles.map((file) => file.relativePath)).size !== teamFiles.length || teamReferences.some((reference) => {
      const file = teamFiles.find((candidate) => candidate.relativePath === taskMaterialInputPath(reference))
      return !file || file.bodyDigest !== reference.bodyDigest || Buffer.byteLength(file.body, 'utf8') !== reference.byteLength
    })) throw new CruxWorkError('source_changed', '团队文档文件与固定版本清单不一致，未把其他正文作为原版本保存。')
    if (record.material.governance && !this.deps.governanceFiles) throw new CruxWorkError('source_changed', '当前宿主不能读取固定团队规则，未将清单当成正文。')
    const governanceFiles = record.material.governance ? await this.deps.governanceFiles?.({ ...query, spaceId: source.spaceId, taskCreatedAt: source.taskCreatedAt }, record.material.governance) ?? [] : []
    if (record.material.governance && governanceFiles.length !== record.material.governance.rules.length + (record.material.governance.template ? 1 : 0)) throw new CruxWorkError('source_changed', '团队规则正文读取不完整。')
    if (record.material.governance && [...record.material.governance.rules, ...(record.material.governance.template ? [record.material.governance.template] : [])].some(reference => {
      const path = cruxGovernanceInputPath(reference.settings.kind, reference.packageId, reference.versionId)
      const file = governanceFiles.find(candidate => candidate.relativePath === path)
      return !file || file.bodyDigest !== reference.bodyDigest || Buffer.byteLength(file.body, 'utf8') !== reference.byteLength
    })) throw new CruxWorkError('source_changed', '团队规则正文与已采用版本的路径、摘要或长度不一致。')
    const body = JSON.stringify(record.material)
    const planned: CreationMaterialFile[] = [{ relativePath: 'references/source-materials.json', body, bodyDigest: sha256Hex(body) }, ...files, ...teamFiles, ...governanceFiles]
    if (planned.length > 128 || new Set(planned.map(file => file.relativePath)).size !== planned.length || planned.reduce((bytes, file) => bytes + Buffer.byteLength(file.body, 'utf8'), 0) > 8 * 1024 * 1024) throw new CruxWorkError('invalid_input', '本次固定输入重复或超过本机包上限，请缩小引用范围。')
    await this.source(query, source)
    validateCruxProject(record.projectRoot, true)
    for (const file of planned) {
      if (!cruxWorkReferencePathSchema.safeParse(file.relativePath).success || sha256Hex(file.body) !== file.bodyDigest) throw new CruxWorkError('source_changed', '原型文件路径或内容摘要无法核实。')
      const path = referenceFilePath(record, record.relativeDir, file.relativePath)
      const current = materialRead(record.projectRoot, path)
      if (current.revision !== null && current.revision !== file.bodyDigest) throw new CruxWorkError('prd_conflict', '开发引用文件已有修改，已保留原文，请先审阅。')
    }
    for (const file of planned) {
      const path = referenceFilePath(record, record.relativeDir, file.relativePath), current = materialRead(record.projectRoot, path)
      if (current.revision === null) materialWrite(record.projectRoot, path, file.body, null)
      else if (current.revision !== file.bodyDigest) throw new CruxWorkError('prd_conflict', '保存时开发引用已变化，请核对原文件。')
    }
    record.referenceFiles = planned.map(({ relativePath, bodyDigest }) => ({ relativePath, bodyDigest }))
  }
}

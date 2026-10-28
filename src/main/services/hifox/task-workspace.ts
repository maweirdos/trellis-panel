import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import {
  hifoxWorkPrepareSchema, hifoxWorkQuerySchema,
  type HifoxWorkFailure, type HifoxWorkFailureReason, type HifoxWorkLocal,
  type HifoxWorkPrepareInput, type HifoxWorkQuery, type HifoxWorkResult
} from '../../../shared/hifox-work'
import { IpcErrorCode, ipcFail } from '../../../shared/ipc-errors'
import { materialRead, materialWrite } from '../knowledge-access/materials'
import { resolveAuthorizedDocumentPath } from '../documents/paths'
import { IntegrationError } from '../integrations/types'
import { runTaskCreateCli } from '../local-task/cli-runner'
import { assertTeamTrellisCapabilities, TeamTrellisCapabilitiesError } from '../local-task/team-capabilities'
import { sha256Hex, todayPrefix } from '../local-task/operations'
import { hifoxWorkspaceSnapshot, hifoxWorkspaceStatus } from './connection-service'
import { HifoxWorkError, readHifoxWorkSource, type HifoxWorkSource, type HifoxWorkSourceDependencies } from './task-workspace-source'
import type { CreationMaterialReference, CreationMaterialFile } from '../../../shared/creation-materials'
import {
  HifoxWorkBindings, bindingKey, freshHifoxWorkRecord, hifoxPrepDirectoryExists, hifoxWorkMeta, hifoxWorkReferencePathSchema,
  nativeRootKey, plannedHifoxPrd, pristineHifoxPrd, reconcileHifoxWork, validateHifoxProject,
  type HifoxWorkDiskTask, type HifoxWorkRecord
} from './task-workspace-records'

export type HifoxTaskWorkspaceDependencies = {
  /** Main-owned app.getPath('userData'); never a renderer argument. */
  dataDir: string
  getProjectRoot(): string | null
  getProjectGeneration(): number
  /** Must be a native directory chooser. Cancellation returns null. */
  chooseProjectRoot(): Promise<string | null>
  workspaceStatus?: HifoxWorkSourceDependencies['workspaceStatus']
  workspaceSnapshot?: HifoxWorkSourceDependencies['workspaceSnapshot']
  creationReferences?: HifoxWorkSourceDependencies['creationReferences']
  creationFiles?(query: HifoxWorkQuery, references: CreationMaterialReference[]): Promise<CreationMaterialFile[]>
  /** Isolated service regression boundary. Production uses the existing task.py runner. */
  cliRunner?: typeof runTaskCreateCli
}
const preparations = new Map<string, Promise<void>>()

function failure(reason: HifoxWorkFailureReason, error: string, code: IpcErrorCode = IpcErrorCode.Conflict, local?: HifoxWorkLocal): HifoxWorkFailure {
  return {
    ...ipcFail(code, error), reason,
    ...(local ? { local } : {}),
    ...(reason === 'outcome_unknown' ? { outcomeUnknown: true } : {}),
    ...(['source_changed', 'prd_conflict'].includes(reason) ? { reviewRequired: true } : {})
  }
}
function caught(error: unknown): HifoxWorkFailure {
  if (error instanceof HifoxWorkError) return failure(error.reason, error.message, error.code)
  if (error instanceof z.ZodError) return failure('invalid_input', '本机任务准备参数或来源材料无效。', IpcErrorCode.InvalidArg)
  return failure('store_unavailable', '本机任务准备未完成，原绑定和文件已保留，请重新核对。', IpcErrorCode.Io)
}
function referenceFilePath(record: HifoxWorkRecord, relativeDir: string, relativePath: string): string {
  const path = `${relativeDir}/${relativePath}`
  const authorized = resolveAuthorizedDocumentPath(record.projectRoot, path)
  if (!hifoxWorkReferencePathSchema.safeParse(relativePath).success || !authorized.ok || nativeRootKey(authorized.canonicalPath) !== nativeRootKey(resolve(record.projectRoot, path))) throw new HifoxWorkError('prd_conflict', '开发引用路径已被替换或重定向，请先审阅；原文件不会被覆盖。')
  return path
}

/** Prepares materials only. It neither changes the business task nor starts Trellis/ACP execution. */
export class HifoxTaskWorkspaceService {
  private readonly bindings: HifoxWorkBindings
  private readonly sourceDeps: HifoxWorkSourceDependencies
  constructor(private readonly deps: HifoxTaskWorkspaceDependencies) {
    this.bindings = new HifoxWorkBindings(deps.dataDir)
    this.sourceDeps = { workspaceStatus: deps.workspaceStatus ?? hifoxWorkspaceStatus, workspaceSnapshot: deps.workspaceSnapshot ?? hifoxWorkspaceSnapshot, creationReferences: deps.creationReferences }
  }

  private async source(query: HifoxWorkQuery, expected?: HifoxWorkSource): Promise<HifoxWorkSource> {
    let current: HifoxWorkSource
    try { current = await readHifoxWorkSource(this.sourceDeps, query, expected) }
    catch (error) {
      if (error instanceof HifoxWorkError || error instanceof z.ZodError) throw error
      throw new HifoxWorkError('access_locked', '原协作空间或登录权限暂时无法核实，本机绑定已锁定。', IpcErrorCode.Denied)
    }
    if (expected && current.spaceId !== expected.spaceId) throw new HifoxWorkError('scope_changed', '任务所属空间已变化，请在原空间核对绑定。')
    if (expected && current.revision !== expected.revision) throw new HifoxWorkError('source_changed', '业务任务的需求材料已变化，请先审阅原任务与本机 PRD。')
    return current
  }

  private async teamAdapter(root: string, source: HifoxWorkSource): Promise<void> {
    if (source.workspaceKey === 'local') return
    try { await assertTeamTrellisCapabilities(root) }
    catch (error) {
      if (error instanceof TeamTrellisCapabilitiesError) throw new HifoxWorkError('project_invalid', error.message, IpcErrorCode.InvalidArg)
      throw new HifoxWorkError('project_invalid', '工程的 Trellis 团队适配能力尚未确认；未准备或打开本机团队任务。', IpcErrorCode.InvalidArg)
    }
  }

  async status(raw: unknown): Promise<HifoxWorkResult> {
    try {
      const input = hifoxWorkQuerySchema.parse(raw)
      const source = await this.source(input)
      const stored = this.bindings.read(source)
      if (!stored) return { ok: true, ...input, prepared: false, local: null }
      validateHifoxProject(stored.value.projectRoot, true)
      await this.teamAdapter(stored.value.projectRoot, source)
      await this.source(input, source)
      const disk = reconcileHifoxWork(stored.value)
      if (!disk) {
        if (['dispatching', 'uncertain'].includes(stored.value.stage)) return failure('outcome_unknown', '原创建命令尚未核实，请保留绑定；重试将先核对原目录。')
        return { ok: true, ...input, prepared: false, local: null }
      }
      if (disk.sourceRevision !== stored.value.sourceRevision) return failure('task_conflict', '本机恢复标识与原准备记录的材料版本不一致。', IpcErrorCode.Conflict, disk.local)
      if (stored.value.stage !== 'ready') return { ok: true, ...input, prepared: false, local: null }
      return this.ready(source, stored.value, disk, false)
    } catch (error) { return caught(error) }
  }

  async prepare(raw: unknown): Promise<HifoxWorkResult> {
    let release: (() => void) | undefined
    let key: string | undefined
    let tail: Promise<void> | undefined
    try {
      const input = hifoxWorkPrepareSchema.parse(raw)
      const original = await this.source(input)
      key = `${resolve(this.deps.dataDir)}:${bindingKey(original)}`
      const previous = preparations.get(key)
      tail = new Promise<void>((done) => { release = done })
      preparations.set(key, tail)
      if (previous) await previous
      const source = await this.source(input, original)
      return await this.prepareOwned(input, source)
    } catch (error) { return caught(error) }
    finally {
      release?.()
      if (key && preparations.get(key) === tail) preparations.delete(key)
    }
  }

  private expectedRoot(expected: string | undefined, root: string): void {
    if (!expected) return
    try { if (nativeRootKey(realpathSync.native(expected)) === nativeRootKey(root)) return } catch { /* No root grant comes from an unreadable renderer path. */ }
    throw new HifoxWorkError('project_changed', '所选项目与本机绑定或主进程当前项目不一致，请刷新后重试。')
  }
  private async chooseRoot(input: HifoxWorkPrepareInput, source: HifoxWorkSource): Promise<{ root: string; assertCurrent(): void }> {
    const current = this.deps.getProjectRoot(), generation = this.deps.getProjectGeneration()
    let root: string | null = null
    if (current) {
      try { root = validateHifoxProject(current) }
      catch (error) { if (input.projectRoot) throw error }
    }
    if (input.projectRoot) {
      if (!root) throw new HifoxWorkError('project_changed', '没有可核实的主进程当前项目，请通过原生目录选择器选择项目。')
      this.expectedRoot(input.projectRoot, root)
    }
    if (root) {
      // This root was admitted from main state; a later bound operation is independent of UI selection.
      const assertCurrent = (): void => {
        if (this.deps.getProjectGeneration() !== generation || this.deps.getProjectRoot() !== current) throw new HifoxWorkError('project_changed', '本机项目已切换，请重新准备。')
      }
      assertCurrent()
      return { root, assertCurrent }
    }
    const chosen = await this.deps.chooseProjectRoot()
    await this.source(input, source)
    if (!chosen) throw new HifoxWorkError('cancelled', '已取消选择本机 Trellis 项目。', IpcErrorCode.Denied)
    return { root: validateHifoxProject(chosen), assertCurrent: () => {} }
  }

  private async prepareOwned(input: HifoxWorkPrepareInput, source: HifoxWorkSource): Promise<HifoxWorkResult> {
    if (source.material.workKind !== 'code') return failure('invalid_input', '一般事务不创建本机代码任务，请使用任务交付流程。', IpcErrorCode.InvalidArg)
    let stored = this.bindings.read(source)
    if (stored) {
      validateHifoxProject(stored.value.projectRoot, true)
      this.expectedRoot(input.projectRoot, stored.value.projectRoot)
    } else {
      const selected = await this.chooseRoot(input, source)
      // Also fence synchronous chooser implementations and current-root admission across the await.
      source = await this.source(input, source)
      selected.assertCurrent()
      const concurrent = this.bindings.read(source)
      stored = concurrent ?? freshHifoxWorkRecord(source, selected.root)
      if (concurrent) this.expectedRoot(selected.root, concurrent.value.projectRoot)
    }
    const record = stored.value
    // Probe before any creation, authority adoption or reference-file write.
    await this.teamAdapter(record.projectRoot, source)
    source = await this.source(input, source)
    let disk = reconcileHifoxWork(record)
    if (record.sourceRevision !== source.revision || (disk && disk.sourceRevision !== source.revision)) return failure('source_changed', '业务任务的需求材料已变化，请审阅已有本机 PRD；原文不会被覆盖。', IpcErrorCode.Conflict, disk?.local)
    if (record.stage === 'ready' && disk) return this.ready(source, record, disk, false)
    if (!disk && ['dispatching', 'uncertain'].includes(record.stage)) return failure('outcome_unknown', '原创建命令的结果尚不明确，尚未找到可核实的原目录；不会另发创建命令。')

    let created = false
    if (!disk) {
      if (!source.canCreate) return failure('invalid_input', '当前任务尚未进入开发交接或技术规划阶段，不能创建本机代码任务。', IpcErrorCode.InvalidArg)
      if (hifoxPrepDirectoryExists(record, todayPrefix())) return failure('task_conflict', '准备目录已存在但来源无法核实，请先核对，不能覆盖或另建。')
      if (stored.revision === null) this.bindings.save(stored)
      record.stage = 'dispatching'
      this.bindings.save(stored) // A durable original command must precede the CLI side effect.
      let result: Awaited<ReturnType<typeof runTaskCreateCli>>
      try {
        result = await (this.deps.cliRunner ?? runTaskCreateCli)({ root: record.projectRoot }, {
          title: record.cliTitle, description: record.cliDescription, slug: record.slug,
          assignee: record.assignee, priority: record.priority, meta: hifoxWorkMeta(record)
        })
      } catch {
        record.stage = 'uncertain'; this.bindings.save(stored)
        await this.source(input, source)
        return failure('outcome_unknown', '原创建命令未返回确定结果，请重试核对已有目录。')
      }
      if (result.code !== 0 || result.aborted || result.failedToStart) {
        record.stage = result.failedToStart || (result.code !== null && !result.aborted) ? 'failed' : 'uncertain'
        this.bindings.save(stored)
        await this.source(input, source)
        return failure(record.stage === 'uncertain' ? 'outcome_unknown' : 'cli_failed', record.stage === 'uncertain' ? '原创建命令超时或结果不明确，请重试核对原目录。' : 'task.py 创建失败；原命令和绑定已保留，可以重试。', IpcErrorCode.Io)
      }
      await this.source(input, source)
      validateHifoxProject(record.projectRoot, true)
      disk = reconcileHifoxWork(record)
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
    if (!pristineHifoxPrd(record, actual)) return failure('prd_conflict', '本机 PRD 已有开发者修改，已保留原文；请先审阅原任务材料再继续。', IpcErrorCode.Conflict, disk.local)
    const planned = plannedHifoxPrd(record)
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
    return this.ready(source, record, disk, created)
  }

  private ready(source: HifoxWorkSource, record: HifoxWorkRecord, disk: HifoxWorkDiskTask, created: boolean): HifoxWorkResult {
    for (const file of record.referenceFiles ?? []) {
      const current = materialRead(record.projectRoot, referenceFilePath(record, disk.local.relativeDir, file.relativePath))
      if (current.revision !== file.bodyDigest) return failure('prd_conflict', '已采用的开发引用被修改或删除，请先审阅；原文件不会被覆盖。', IpcErrorCode.Conflict, disk.local)
    }
    const actual = materialRead(record.projectRoot, `${disk.local.relativeDir}/prd.md`)
    if (actual.revision === null || record.generatedPrdRevision === null) return failure('prd_conflict', '已准备的 PRD 已删除或缺少保存回执，请先核对；不会自动重建。', IpcErrorCode.Conflict, disk.local)
    const prdModified = actual.revision !== record.generatedPrdRevision
    if (source.workspaceKey !== 'local') {
      // The existing prepare/open entry must not leave a second local task authority.
      const path = `${disk.local.relativeDir}/task.json`
      const original = materialRead(record.projectRoot, path)
      const task = z.object({ id: z.string(), meta: z.record(z.string(), z.unknown()) }).passthrough().parse(JSON.parse(original.body))
      if (task.id !== record.localTaskId || hifoxWorkMeta(record).some(([key, value]) => key !== 'panel_task_authority' && task.meta[key] !== value)) {
        throw new HifoxWorkError('task_conflict', '原本机任务来源已变化，未启用团队状态权威。')
      }
      if (task.meta.panel_task_authority !== undefined && task.meta.panel_task_authority !== 'team') throw new HifoxWorkError('task_conflict', '原任务已声明其它状态权威，不能自动替换。')
      if (task.meta.panel_task_authority !== 'team') {
        task.meta = { ...task.meta, panel_task_authority: 'team' }
        materialWrite(record.projectRoot, path, JSON.stringify(task, null, 2) + '\n', original.revision)
      }
    }
    return {
      ok: true, workspaceKey: source.workspaceKey, taskId: source.taskId, prepared: true, local: disk.local,
      created, reused: !created, sourceRevision: source.revision, preparedRevision: record.sourceRevision,
      reviewRequired: source.revision !== record.sourceRevision, prdModified,
      notes: prdModified ? ['已保留本机 PRD 的开发者修改。'] : []
    }
  }
  private async prepareReferenceFiles(query: HifoxWorkQuery, source: HifoxWorkSource, record: HifoxWorkRecord): Promise<void> {
    if (!record.relativeDir) throw new HifoxWorkError('task_missing', '本机任务目录尚未确认。')
    const references = record.material.creationReferences ?? []
    if (references.length && !this.deps.creationFiles) throw new HifoxWorkError('source_changed', '当前宿主不支持读取已采用的原型材料，请更新桌面端。')
    const files = await this.deps.creationFiles?.(query, references) ?? []
    const body = JSON.stringify(record.material, null, 2)
    const planned: CreationMaterialFile[] = [{ relativePath: 'references/source-materials.json', body, bodyDigest: sha256Hex(body) }, ...files]
    await this.source(query, source)
    validateHifoxProject(record.projectRoot, true)
    for (const file of planned) {
      if (!hifoxWorkReferencePathSchema.safeParse(file.relativePath).success || sha256Hex(file.body) !== file.bodyDigest) throw new HifoxWorkError('source_changed', '原型文件路径或内容摘要无法核实。')
      const path = referenceFilePath(record, record.relativeDir, file.relativePath)
      const current = materialRead(record.projectRoot, path)
      if (current.revision !== null && current.revision !== file.bodyDigest) throw new HifoxWorkError('prd_conflict', '开发引用文件已有修改，已保留原文，请先审阅。')
    }
    for (const file of planned) {
      const path = referenceFilePath(record, record.relativeDir, file.relativePath), current = materialRead(record.projectRoot, path)
      if (current.revision === null) materialWrite(record.projectRoot, path, file.body, null)
      else if (current.revision !== file.bodyDigest) throw new HifoxWorkError('prd_conflict', '保存时开发引用已变化，请核对原文件。')
    }
    record.referenceFiles = planned.map(({ relativePath, bodyDigest }) => ({ relativePath, bodyDigest }))
  }
}

import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import * as dto from '../../../shared/task-planning'
import { requirementCandidateSchema } from '../../../shared/conversation-requirements'
import type { TaskPlanningRuntimeIdentity, TaskPlanningRuntimeObservation } from '../../../shared/conversation/task-planning-runtime'
import type { CruxTaskMaterialsApi } from '../../../shared/crux-task-materials'
import type { TeamTaskCodeResourceDto } from '../../../shared/team-code-resources'
import { teamTaskMaterialCommandSchema, type TeamTaskMaterialReceipt } from '../../../shared/team-task-materials'
import { taskInputCanonical } from '../../../shared/team-task-inputs'
import { checkedDirectory, hash, ownedDirectory, readRegular } from '../private-conversations/files'
import { writeRevision } from '../private-conversations/requirement-files'
import { cruxWorkProjectIdentity } from '../crux/work-project'
import {
  planningIntentDirectory, planningIntentSchema, readPlanningIntent, taskPlanningLaunchText, type PlanningIntent,
} from './runtime-authority'
import { assertTaskPlanningSource, type TaskPlanningSource } from './source'

type Loaded = ReturnType<typeof readPlanningIntent>
type Capture = Pick<PlanningIntent, 'source' | 'teamSelection' | 'assignmentGeneration' | 'authorizationRevision'>
const equal = (left: unknown, right: unknown): boolean => taskInputCanonical(left) === taskInputCanonical(right)
const legacyOwnerSchema = z.object({
  id: z.string().uuid(), source: z.object({ query: dto.taskPlanningQuerySchema }),
  nativeStarted: z.boolean(), cleanupConfirmed: z.boolean(),
})

function names(profile: string, directory: string): string[] {
  const root = join(checkedDirectory(profile), directory)
  if (!existsSync(root)) return []
  const files = readdirSync(checkedDirectory(root)).filter(name => name.endsWith('.json'))
  if (files.length > 256 || files.some(name => !z.string().uuid().safeParse(name.slice(0, -5)).success)) {
    throw Error('原任务规划记录数量或身份无法核对。')
  }
  return files
}

function planningRecords(profile: string): Loaded[] {
  return names(profile, planningIntentDirectory).map(name => readPlanningIntent(profile, name.slice(0, -5)))
}

function legacyOwner(profile: string, query: dto.TaskPlanningQuery): boolean {
  return names(profile, 'task-planning').some(name => {
    const record = legacyOwnerSchema.parse(JSON.parse(readRegular(profile, `task-planning/${name}`, 3 * 1024 * 1024).bytes.toString('utf8')))
    if (`${record.id}.json` !== name) throw Error('既有规划身份无法核对。')
    return equal(record.source.query, query) && record.nativeStarted && !record.cleanupConfirmed
  })
}

export function hasTaskPlanningOwner(profile: string, raw: dto.TaskPlanningQuery): boolean {
  const query = dto.taskPlanningQuerySchema.parse(raw)
  return legacyOwner(profile, query) || planningRecords(profile).some(({ record }) =>
    equal(record.source.query, query) && record.started && !record.cleanupConfirmed)
}

export function readTaskPlanningDirectoryChoice(profile: string, current: {
  pin: TaskPlanningSource['pin']; task: TaskPlanningSource['task']; codeResource: TeamTaskCodeResourceDto
}): { root: string; directoryIdentity: string } | null {
  const query = { workspaceKey: current.pin.workspaceKey, taskId: current.task.taskId, spaceId: current.task.spaceId, taskCreatedAt: current.task.taskCreatedAt }
  if (hasTaskPlanningOwner(profile, query)) throw Error('原任务规划清理尚未确认，请先核对原规划。')
  const source = planningRecords(profile).map(({ record }) => record)
    .filter(record => equal(record.source.task, current.task) && equal(record.source.pin, current.pin))
    .sort((left, right) => right.createdAt - left.createdAt)[0]?.source
  if (!source || current.codeResource.availability !== 'available'
    || !equal(source.resource, current.codeResource.resource) || source.resourceSelection !== taskInputCanonical(current.codeResource.selection)) return null
  try {
    const root = checkedDirectory(source.root)
    return cruxWorkProjectIdentity(root) === source.directoryIdentity ? { root, directoryIdentity: source.directoryIdentity } : null
  } catch { return null }
}

export interface TaskPlanningPorts {
  profile: string
  materials: CruxTaskMaterialsApi
  source(query: dto.TaskPlanningQuery, root?: string, selected?: string[]): Promise<Capture | null>
  selectFiles(root: string): Promise<string[] | null>
  launch(input: TaskPlanningRuntimeIdentity): Promise<TaskPlanningRuntimeObservation>
  observe(input: TaskPlanningRuntimeIdentity): Promise<TaskPlanningRuntimeObservation>
  stop(input: TaskPlanningRuntimeIdentity & { stopCommandId: string }): Promise<TaskPlanningRuntimeObservation>
  assertCurrent(): void
  assertAccount(record: PlanningIntent, confirmTaskRead: boolean): Promise<void>
  assertCleanupAccount(record: PlanningIntent): Promise<void>
}

const identity = ({ planningId, commandId, source }: PlanningIntent): TaskPlanningRuntimeIdentity => ({
  planningId, commandId, sourceDigest: source.digest,
})

export class TaskPlanningService {
  private readonly lanes = new Map<string, Promise<unknown>>()
  constructor(private readonly ports: TaskPlanningPorts) {}

  private async locked<T>(key: string, action: () => Promise<T>): Promise<T> {
    const earlier = this.lanes.get(key) ?? Promise.resolve()
    const current = earlier.then(action, action)
    this.lanes.set(key, current)
    try { return await current }
    finally { if (this.lanes.get(key) === current) this.lanes.delete(key) }
  }
  private latest(query: dto.TaskPlanningQuery): Loaded | undefined {
    return planningRecords(this.ports.profile).filter(({ record }) => equal(record.source.query, query))
      .sort((left, right) => right.record.createdAt - left.record.createdAt)[0]
  }
  private load(id: string): Loaded { return readPlanningIntent(this.ports.profile, id) }
  private save(record: PlanningIntent, revision: string | null): void {
    ownedDirectory(this.ports.profile, planningIntentDirectory)
    const bytes = Buffer.from(JSON.stringify(planningIntentSchema.parse(record)))
    if (bytes.length > 3 * 1024 * 1024) throw Error('规划记录超过私有存储上限。')
    writeRevision(this.ports.profile, `${planningIntentDirectory}/${record.planningId}.json`, bytes, revision, this.ports.assertCurrent)
  }
  private async current(record: PlanningIntent): Promise<void> {
    const original = record.source
    const fresh = await this.ports.source(original.query, original.root, original.observations.map(file => file.path))
    this.ports.assertCurrent()
    if (!fresh || fresh.source.digest !== original.digest || fresh.assignmentGeneration !== record.assignmentGeneration
      || fresh.authorizationRevision !== record.authorizationRevision || fresh.teamSelection !== record.teamSelection) {
      throw Error('原任务、处理人、工程或固定资料已变化。')
    }
    assertTaskPlanningSource(original)
  }
  private view(record?: PlanningIntent, observed?: TaskPlanningRuntimeObservation, error?: string): dto.TaskPlanningView {
    if (!record) return dto.taskPlanningViewSchema.parse({ planningId: null, state: 'empty', sourceDigest: null,
      current: false, sourceError: null, directoryName: null, agentId: null, modelId: null, sources: [],
      candidate: null, cleanupConfirmed: true, save: null })
    const state = record.candidate ? 'candidate' : !record.started ? 'prepared'
      : observed?.state === 'waiting' && !record.stopCommandId && !record.cleanupConfirmed ? 'running'
        : observed?.state === 'failed' || observed?.state === 'completed' ? 'failed'
          : observed?.state === 'cancelled' ? 'cancelled' : 'unknown'
    return dto.taskPlanningViewSchema.parse({
      planningId: record.planningId, state, sourceDigest: record.source.digest, current: !error,
      sourceError: error ?? observed?.detail ?? null, directoryName: basename(record.source.root),
      agentId: record.selection.instanceId, modelId: record.selection.modelId,
      sources: [...record.source.documents, ...record.source.observations].map(file => ({ title: file.path, revision: file.digest })),
      candidate: record.candidate ? { revision: record.candidate.revision, value: {
        title: record.candidate.title, markdown: record.candidate.markdown, questions: [],
      } } : null,
      cleanupConfirmed: record.cleanupConfirmed,
      save: record.save && { commandId: record.save.command.commandId, receipt: record.save.receipt, error: record.save.error,
        state: record.save.receipt ? record.save.receipt.outcome === 'applied' ? 'saved' : 'conflict' : 'unknown' },
    })
  }
  private async observe(record: PlanningIntent): Promise<dto.TaskPlanningView> {
    const cached = !record.started || record.cleanupConfirmed && Boolean(record.candidate)
    await this.ports.assertAccount(record, cached)
    if (cached) return this.view(record)
    const result = await this.ports.observe(identity(record))
    await this.ports.assertAccount(record, false)
    const loaded = this.load(record.planningId)
    record = loaded.record
    if ((!record.stopCommandId || record.cleanupConfirmed) && !record.candidate && result.state === 'completed' && result.finalText
      && result.finalText.trim().length >= 80 && /^#{1,6}\s+\S/m.test(result.finalText)) {
      const candidate = requirementCandidateSchema.safeParse({
        title: `${record.source.title.slice(0, 180)} · 技术方案`, markdown: result.finalText, questions: [],
      })
      if (!candidate.success) return this.view(record, { ...result, detail: '原规划回合的方案超出了可保存的大小。' })
      const { title, markdown } = candidate.data
      record.candidate = { title, markdown, revision: hash(taskInputCanonical({ title, markdown })) }
      this.save(record, loaded.revision)
    }
    return this.view(record, result)
  }
  async read(raw: unknown): Promise<dto.TaskPlanningView> {
    const query = dto.taskPlanningQuerySchema.parse(raw)
    const latest = this.latest(query)
    if (!latest) return this.view()
    return this.locked(latest.record.planningId, () => this.observe(this.load(latest.record.planningId).record))
  }
  async prepare(raw: unknown): Promise<dto.TaskPlanningView> {
    const input = dto.taskPlanningPrepareSchema.parse(raw)
    const { commandId, expectedUpdatedAt, instanceId, modelId, options, reusePlanningId, ...query } = input
    return this.locked(taskInputCanonical(query), async () => {
      const prepareDigest = hash(taskInputCanonical(input))
      if (names(this.ports.profile, planningIntentDirectory).includes(`${commandId}.json`)) {
        const { record } = this.load(commandId)
        await this.ports.assertAccount(record, false)
        if (record.prepareDigest !== prepareDigest) throw Error('原准备编号已绑定另一份规划。')
        return this.observe(record)
      }
      if (hasTaskPlanningOwner(this.ports.profile, query)) throw Error('请先核对原规划清理。')
      if (this.latest(query)?.record.save?.receipt === null) throw Error('请先核对原方案保存。')
      const retained = reusePlanningId ? this.load(reusePlanningId).record : undefined
      if (retained && !equal(retained.source.query, query)) throw Error('不能复用另一任务的工程。')
      if (retained) await this.ports.assertAccount(retained, false)
      const captured = await this.ports.source(query, retained?.source.root, retained?.source.observations.map(file => file.path))
      if (!captured) return this.view()
      if (captured.source.taskUpdatedAt !== expectedUpdatedAt) throw Error('原任务版本已变化，请重新打开。')
      const record: PlanningIntent = { ...captured, version: 2, planningId: commandId, commandId: randomUUID(),
        selection: { instanceId, modelId, ...(options && { options }) }, prepareDigest, createdAt: Date.now(),
        started: false, stopCommandId: null, cleanupConfirmed: true, candidate: null, save: null }
      taskPlanningLaunchText(record)
      this.save(record, null)
      return this.view(record)
    })
  }
  async selectSources(raw: unknown): Promise<dto.TaskPlanningView> {
    const { planningId } = dto.taskPlanningControlSchema.parse(raw)
    return this.locked(planningId, async () => {
      const { record, revision } = this.load(planningId)
      if (record.started || record.stopCommandId) throw Error('已开始规划的固定来源不能替换。')
      await this.current(record)
      const selected = await this.ports.selectFiles(record.source.root)
      if (selected === null) return this.view(record)
      const fresh = await this.ports.source(record.source.query, record.source.root, selected)
      if (!fresh || fresh.assignmentGeneration !== record.assignmentGeneration || fresh.authorizationRevision !== record.authorizationRevision
        || fresh.teamSelection !== record.teamSelection || fresh.source.taskUpdatedAt !== record.source.taskUpdatedAt
        || fresh.source.directoryIdentity !== record.source.directoryIdentity) throw Error('原任务或工程已变化，请重新准备。')
      Object.assign(record, fresh)
      taskPlanningLaunchText(record)
      this.save(record, revision)
      return this.view(record)
    })
  }
  async generate(raw: unknown): Promise<dto.TaskPlanningView> {
    const input = dto.taskPlanningGenerateSchema.parse(raw), original = this.load(input.planningId).record
    return this.locked(taskInputCanonical(original.source.query), () => this.locked(input.planningId, async () => {
      const { record, revision } = this.load(input.planningId)
      if (record.source.digest !== input.sourceDigest || record.stopCommandId) throw Error('原规划已停止或固定来源已变化。')
      if (record.started) return this.observe(record)
      if (this.latest(record.source.query)?.record.planningId !== record.planningId || hasTaskPlanningOwner(this.ports.profile, record.source.query)) {
        throw Error('原任务已存在另一规划，请核对原请求。')
      }
      await this.current(record)
      record.started = true
      record.cleanupConfirmed = false
      this.save(record, revision)
      try { return this.view(record, await this.ports.launch(identity(record))) }
      catch (error) {
        await this.ports.assertAccount(record, true)
        return this.view(record, undefined, error instanceof Error ? error.message : '原派发结果待核对。')
      }
    }))
  }
  async reconcile(raw: unknown): Promise<dto.TaskPlanningView> {
    const { planningId } = dto.taskPlanningControlSchema.parse(raw)
    return this.locked(planningId, () => this.observe(this.load(planningId).record))
  }
  async respond(): Promise<dto.TaskPlanningView> {
    throw Error('只读规划拒绝授权扩大。')
  }
  async stop(raw: unknown): Promise<dto.TaskPlanningStopState> {
    const { planningId } = dto.taskPlanningControlSchema.parse(raw)
    let loaded = this.load(planningId)
    await this.ports.assertCleanupAccount(loaded.record)
    loaded = this.load(planningId)
    this.ports.assertCurrent()
    if (!loaded.record.cleanupConfirmed && loaded.record.started) {
      if (!loaded.record.stopCommandId) {
        loaded.record.stopCommandId = randomUUID()
        this.save(loaded.record, loaded.revision)
      }
      const stopCommandId = loaded.record.stopCommandId
      const result = await this.ports.stop({ ...identity(loaded.record), stopCommandId })
      loaded = this.load(planningId)
      if (loaded.record.stopCommandId !== stopCommandId) throw Error('原清理代次变化。')
      if (result.cleanupConfirmed && !loaded.record.cleanupConfirmed) {
        loaded.record.cleanupConfirmed = true
        this.save(loaded.record, loaded.revision)
      }
    }
    return { cleanupConfirmed: loaded.record.cleanupConfirmed }
  }
  private settle(record: PlanningIntent, receipt: TeamTaskMaterialReceipt): void {
    const save = record.save, { task, pin } = record.source
    if (!save || receipt.commandId !== save.command.commandId || receipt.action !== save.command.action
      || receipt.instanceId !== pin.instanceId || receipt.epoch !== pin.epoch || receipt.projectId !== pin.projectId
      || receipt.taskId !== task.taskId || receipt.spaceId !== task.spaceId || receipt.taskCreatedAt !== task.taskCreatedAt
      || receipt.actorId !== pin.actorId || 'documentId' in save.command && receipt.documentId !== save.command.documentId) {
      throw Error('材料回执与原固定任务或命令不匹配。')
    }
    save.receipt = receipt
    save.error = null
  }
  private async publish(loaded: Loaded, kind: 'new' | 'retry' | 'reconcile'): Promise<dto.TaskPlanningView> {
    const { record } = loaded
    const save = record.save
    if (!save || save.receipt) return this.view(record)
    const scope = record.source.query
    if (kind === 'reconcile') {
      const check = await this.ports.materials.reconcile({ ...scope, commandId: save.command.commandId })
      if (check.ok && check.value) this.settle(record, check.value)
      if (!check.ok) save.error = check.error
    } else {
      await this.current(record)
      const request = { ...scope, commandId: save.command.commandId }
      const checked = kind === 'retry' ? await this.ports.materials.reconcile(request) : undefined
      if (checked?.ok && checked.value) this.settle(record, checked.value)
      else if (checked && !checked.ok && checked.code !== 'NOT_FOUND') save.error = checked.error
      else {
        await this.current(record)
        const result = checked?.ok ? await this.ports.materials.retry(request)
          : await this.ports.materials.command({ ...scope, command: save.command })
        if (result.ok) this.settle(record, result.value.result)
        else save.error = result.error
      }
    }
    this.save(record, loaded.revision)
    return this.view(record)
  }
  async saveDraft(raw: unknown): Promise<dto.TaskPlanningView> {
    const input = dto.taskPlanningSaveSchema.parse(raw)
    return this.locked(input.planningId, async () => {
      const loaded = this.load(input.planningId), { record } = loaded
      await this.current(record)
      if (!record.candidate || record.candidate.revision !== input.candidateRevision || !record.cleanupConfirmed) throw Error('请先核对选中的完整方案及原进程清理。')
      if (record.save) return this.view(record)
      const scope = record.source.query
      const content = { commandId: randomUUID(), expectedEpoch: record.source.pin.epoch, spaceId: scope.spaceId, taskCreatedAt: scope.taskCreatedAt,
        title: record.candidate.title, text: record.candidate.markdown, expectedDigest: hash(record.candidate.markdown), references: [] }
      let command
      if (input.target.kind === 'draft') {
        const current = await this.ports.materials.read({ ...scope, documentId: input.target.documentId })
        if (!current.ok) throw Error(current.error)
        if (current.value.document.kind !== 'implement' || current.value.document.draftRevision !== input.target.expectedDraftRevision) throw Error('原方案草稿版本已变化。')
        command = teamTaskMaterialCommandSchema.parse({ ...content, action: 'saveDraft', documentId: input.target.documentId, expectedDraftRevision: input.target.expectedDraftRevision })
      } else {
        const listed = await this.ports.materials.list({ ...scope, limit: 100 })
        if (!listed.ok) throw Error(listed.error)
        if (listed.value.page.hasMore || listed.value.page.items.some(item => item.kind === 'implement')) throw Error('请核对并选用原技术方案草稿。')
        command = teamTaskMaterialCommandSchema.parse({ ...content, action: 'create', kind: 'implement', editorIds: input.target.editorIds, approverIds: input.target.approverIds })
      }
      await this.current(record)
      record.save = { command, candidateRevision: input.candidateRevision, receipt: null, error: null }
      this.save(record, loaded.revision)
      return this.publish(this.load(record.planningId), 'new')
    })
  }
  async recoverSave(raw: unknown): Promise<dto.TaskPlanningView> {
    const input = dto.taskPlanningRecoverySchema.parse(raw)
    return this.locked(input.planningId, async () => {
      const loaded = this.load(input.planningId)
      await this.ports.assertAccount(loaded.record, true)
      return this.publish(loaded, input.retry ? 'retry' : 'reconcile')
    })
  }
}

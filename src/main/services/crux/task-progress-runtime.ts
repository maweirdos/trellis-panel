import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import type { CruxProgressQuery, CruxProgressSession, CruxProgressValue } from '../../../shared/crux-task-progress'
import { cruxProgressSessionSchema } from '../../../shared/crux-task-progress'
import { taskProgressNativeSchema, taskProgressPinSchema, taskProgressPlanSchema, taskProgressSummarySchema, type TaskProgressNativeInput } from '../../../shared/crux-task-progress-native'
import { teamTaskProgressCommandSchema, teamTaskProgressDtoSchema, type TeamTaskProgressCommand, type TeamTaskProgressDto } from '../../../shared/team-task-progress'
import { readBounded, writeAtomic } from '../../daemon/files'
import { installTaskProgressEvents } from './task-progress-events'
import type { AcpSessionRecord, AcpSessionStatus } from '../../../shared/types'
import { CruxWorkBindings, reconcileCruxWork } from './task-workspace-records'
import { projectTeamTaskToLocal } from './team-task-projection'
import type { NativeTaskProgressSender } from './task-progress-sender'
import { DesktopTeamError } from '../team-platform/types'
import { readCruxWorkSource, type CruxWorkWorkspaceView } from './task-workspace-source'
import { cruxWorkProjectIdentity, inspectCruxWorkExecutionProject } from './work-project'
import { materialRead } from '../knowledge-access/materials'
import { legacyTaskDevelopmentKey, taskDevelopmentKey } from './task-development-identity'
import { installTaskInputRulesAuthority, type TaskInputRulesInput, type TaskInputRulesAuthority } from './task-input-rules'
import type { CruxWorkSource } from './task-workspace-source'
import { TaskOutputCoordinator } from './task-outputs'
import { DaemonError } from '../../daemon/errors'
import { resolveWorkcopy, workcopyUseDirectory } from '../workcopy-use'
import { readTaskSessionIntent } from '../workcopy-use/task-session-intent'

const rowSchema = z.object({
  pin: taskProgressPinSchema, plan: taskProgressPlanSchema.nullable(),
  session: cruxProgressSessionSchema.nullable(), nativeAlias: z.string(),
  state: z.enum(['preparing', 'binding', 'active', 'releasing', 'detached', 'stopped']),
  server: teamTaskProgressDtoSchema, bindingId: z.string().uuid().nullable(), bindingGeneration: z.number().int().nonnegative().safe().nullable().default(null), seq: z.number().int().nonnegative().safe(),
  dispatch: z.enum(['not_sent', 'dispatching', 'sent', 'unknown']), errorCode: z.string().nullable(),
  projectionActive: z.boolean().default(false),
  creationBinding: z.object({ commandId: z.string().uuid(), generation: z.number().int().nonnegative().safe(), bindingId: z.string().uuid().nullable() }).strict().optional(),
  queue: z.array(z.object({ command: teamTaskProgressCommandSchema, state: z.enum(['queued', 'dispatching', 'unknown', 'settled']), attempts: z.number().int().nonnegative() }).strict()).max(4)
}).strict()
const storeSchema = z.object({ version: z.literal(1), rows: z.array(rowSchema).max(128) }).strict()
type Row = z.infer<typeof rowSchema>
type QueueItem = Row['queue'][number]
export type TaskProgressDelivery = { pin: Row['pin']; command: TeamTaskProgressCommand }
export type TaskProgressNativeView = { value: CruxProgressValue; pin: Row['pin']; plan: Row['plan'] }
const key = (q: CruxProgressQuery): string => JSON.stringify([q.workspaceKey, q.taskId])
const rootKey = (s: string): string => process.platform === 'win32' ? s.toLowerCase() : s
const MAX_STORE_BYTES = 8 * 1024 * 1024

/** One daemon writer. Native tool reports and lifecycle observations share the same durable queue. */
export class CruxTaskProgressRuntime {
  private rows: Row[]
  private readonly file: string
  private readonly dispose: () => void
  private readonly disposeRules: () => void
  private readonly outputs: TaskOutputCoordinator
  private readonly work = new Map<string, Promise<unknown>>()
  private timer?: ReturnType<typeof setTimeout>
  private closed = false
  private pumping = false
  private offset = 0
  private failures = 0
  constructor(private readonly dataDir: string, private readonly userData: string = dataDir, private readonly assertOwner: () => void = () => {}, private readonly assertSending: () => void = assertOwner) {
    this.outputs = new TaskOutputCoordinator({ directory: dataDir, userData, sender: pin => this.sender(pin), assertOwner })
    this.file = join(dataDir, 'crux-progress', 'state.json')
    this.rows = existsSync(this.file) ? storeSchema.parse(JSON.parse(readBounded(this.file, MAX_STORE_BYTES))).rows : []
    for (const row of this.rows) {
      if (row.state === 'preparing') row.errorCode = 'NATIVE_CREATION_RECOVERY_REQUIRED'
      for (const item of row.queue) if (item.state === 'dispatching') item.state = 'unknown'
      if (row.dispatch === 'dispatching') row.dispatch = 'unknown'
    }
    this.dispose = installTaskProgressEvents({
      state: (owner, status, outcome) => this.observeState(owner, status, outcome),
      report: async (owner, summary) => {
        const row = this.owned(owner)
        if (!row || row.state !== 'active') throw new Error('The original task reporting handle is no longer active')
        this.report(row.pin, taskProgressSummarySchema.parse(summary))
        return { queued: true, acknowledged: false }
      },
      assertCurrent: async owner => {
        this.assertSending()
        if (this.closed) throw new Error('原任务执行所有者已关闭，不能发送命令')
        const row = this.owned(owner)
        if (!row || row.state !== 'active' || !row.bindingId || row.server.binding?.bindingId !== row.bindingId) throw new Error('原任务执行身份不可用，不能发送命令')
        if (row.plan?.development && owner.taskProgress?.workcopyTaskKey !== this.taskKey(row)) throw new Error('旧任务会话缺少当前服务世代的工作副本身份，请保留原会话并建立新会话')
        const original = JSON.stringify([row.pin, row.plan, row.nativeAlias, row.session, row.bindingId])
        const sender = await this.sender(row.pin)
        await this.inputCurrent(row, sender)
        const server = await sender.status()
        if (server.binding?.bindingId !== row.bindingId || server.binding.reporterId !== row.pin.ownerId || server.binding.deviceId !== row.pin.deviceId) throw new Error('原任务权限或执行绑定已变化，不能发送命令')
        const assertCurrent = (): void => {
          this.assertSending()
          const current = this.owned(owner)
          if (this.closed || !current || current.state !== 'active' || current.server.binding?.bindingId !== row.bindingId || JSON.stringify([current.pin, current.plan, current.nativeAlias, current.session, current.bindingId]) !== original) throw new Error('原任务权限或执行绑定已变化，不能发送命令')
        }
        assertCurrent()
        return assertCurrent
      },
      context: owner => {
        const row = this.owned(owner)
        if (!row || !['binding', 'active'].includes(row.state)) return undefined
        return { id: 'team-task', version: row.plan?.inputVersion ?? row.pin.epoch, title: 'Bound team task', body: [
          `Task: ${row.pin.taskId}; space: ${row.pin.spaceId}; input version: ${row.plan?.inputVersion ?? row.pin.epoch}.`,
          'The daemon owns this original task handle. report_progress accepts only activity, step and blocker; it cannot select another task.',
          'Report only a short step/blocker. Never upload tool calls, raw logs, tokens or credentials. A queued report is not server acknowledgement.',
          'A finished turn means idle. Business approval, testing and completion require the team task transition actions.'
        ].join('\n') }
      }
    })
    this.disposeRules = installTaskInputRulesAuthority(input => this.captureTaskRules(input))
    if (this.rows.some(row => row.projectionActive || ['binding', 'active', 'releasing'].includes(row.state)) || this.outputs.hasWork()) this.schedule()
  }
  async close(): Promise<void> { this.closed = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; await Promise.allSettled([...this.work.values()]); await this.outputs.close(); this.disposeRules(); this.dispose() }
  busy(): boolean { return this.pumping || this.work.size > 0 }
  private schedule(): void {
    if (this.closed || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.background().finally(() => this.schedule()).catch(() => { this.failures = Math.min(5, this.failures + 1) })
    }, Math.min(60_000, 1500 * 2 ** this.failures))
    this.timer.unref()
  }
  private async sender(pin: Row['pin']): Promise<NativeTaskProgressSender> {
    this.assertSending()
    const { DesktopTeamService } = await import('../team-platform/service')
    return DesktopTeamService.taskProgressSender(join(this.userData, 'team-platform'), pin)
  }
  private async pinnedSource(row: Row, sender: NativeTaskProgressSender, expected?: CruxWorkSource): Promise<CruxWorkSource> {
    const remote = await sender.snapshot()
    const view: CruxWorkWorkspaceView = { snapshot: remote.snapshot, context: { key: row.pin.workspaceKey, connectionId: row.pin.connectionId,
      origin: row.pin.origin, actorId: row.pin.ownerId, projectId: row.pin.projectId, instanceId: remote.instanceId, epoch: remote.epoch,
      authorizationRevision: remote.authorizationRevision, revision: remote.revision, state: 'connected', projectName: null, canManage: remote.canManage, pendingCount: 0 } }
    return readCruxWorkSource({ workspaceSnapshot: async () => view, workspaceStatus: async () => view.context }, { workspaceKey: row.pin.workspaceKey, taskId: row.pin.taskId }, expected)
  }
  private async captureTaskRules(input: TaskInputRulesInput): Promise<TaskInputRulesAuthority> {
    this.assertSending()
    if (this.closed) throw new Error('原任务执行所有者已关闭')
    const candidates = this.rows.filter(row => row.plan && !row.plan.managedDirectory && row.pin.taskId === input.teamTask.taskId && row.pin.spaceId === input.teamTask.spaceId
      && row.plan.inputVersion === input.teamTask.inputVersion && row.plan.taskDir === input.taskDir && rootKey(row.plan.root) === rootKey(input.projectRoot)
      && ['preparing', 'binding', 'active'].includes(row.state))
    if (candidates.length !== 1) throw new Error('原任务规则缺少唯一的有效本机执行绑定')
    const row = candidates[0], development = row.plan?.development
    if (!development || input.teamTask.workcopyTaskKey !== this.taskKey(row)) throw new Error('原任务规则没有可信的工作副本任务身份')
    const signature = (value: Row): string => JSON.stringify([value.pin, value.plan, value.nativeAlias, value.session?.sessionId ?? null])
    const original = signature(row), sender = await this.sender(row.pin)
    await this.inputCurrent(row, sender)
    const source = await this.pinnedSource(row, sender)
    if (source.closed || row.plan && !row.plan.managedDirectory && !source.canCreate) throw new DesktopTeamError('TASK_PROGRESS_FORBIDDEN', '原任务已结束或已交接到不可执行阶段，未继续原会话的新写入')
    return { dataDir: this.userData, source, assertCurrent: async () => {
      this.assertSending()
      const current = [...this.rows].reverse().find(value => value.pin.workspaceKey === row.pin.workspaceKey && value.pin.taskId === row.pin.taskId)
      if (this.closed || !current || signature(current) !== original || !['preparing', 'binding', 'active'].includes(current.state)) throw new Error('读取规则期间原执行尝试或所有者已变化')
      await this.inputCurrent(current, sender)
      await this.pinnedSource(current, sender, source)
    } }
  }
  private async background(): Promise<void> {
    if (this.closed || this.pumping) return
    this.assertSending()
    this.pumping = true
    try {
      if (this.outputs.hasWork()) await this.outputs.pump()
      const rows = this.rows.filter(row => row.projectionActive || ['binding', 'active', 'releasing'].includes(row.state))
      const picked = Array.from({ length: Math.min(2, rows.length) }, (_, index) => rows[(this.offset + index) % rows.length])
      this.offset = rows.length ? (this.offset + picked.length) % rows.length : 0
      const results = await Promise.allSettled(picked.map(row => this.execute({ operation: 'sync', query: { workspaceKey: row.pin.workspaceKey, taskId: row.pin.taskId } })))
      this.failures = results.some(result => result.status === 'rejected') ? Math.min(5, this.failures + 1) : 0
    } finally { this.pumping = false }
  }
  private async project(row: Row, enable: boolean, sender: NativeTaskProgressSender): Promise<void> {
    if (!row.plan?.taskDir || row.plan.managedDirectory) return
    if (enable && (row.state !== 'active' || row.server.binding?.bindingId !== row.bindingId)) throw new Error('Only a server-confirmed original binding can enable team authority')
    const remote = await sender.snapshot()
    const identity = createHash('sha256').update(JSON.stringify([row.pin.workspaceKey, row.pin.connectionId, row.pin.projectId, row.pin.ownerId, row.pin.origin, row.pin.instanceId])).digest('hex')
    const record = new CruxWorkBindings(this.userData).read({ workspaceKey: row.pin.workspaceKey, spaceId: row.pin.spaceId, taskId: row.pin.taskId, identity, taskCreatedAt: row.plan.development?.taskCreatedAt })
    if (!record || record.value.projectRoot !== row.plan.root || record.value.sourceRevision !== row.plan.inputVersion) throw new Error('Original task material or physical project binding changed')
    const view = { snapshot: remote.snapshot, context: { key: row.pin.workspaceKey, connectionId: row.pin.connectionId, projectId: row.pin.projectId,
      actorId: row.pin.ownerId, origin: row.pin.origin, instanceId: row.pin.instanceId, epoch: row.pin.epoch,
      revision: remote.revision, authorizationRevision: remote.authorizationRevision, state: 'connected' as const, projectName: null, canManage: remote.canManage, pendingCount: 0 } }
    const result = projectTeamTaskToLocal({ record: record.value, view, enableTeamAuthority: enable, expectedEpoch: row.pin.epoch, expectedInstanceId: row.pin.instanceId })
    if (!result.ok && !(result.reason === 'not_managed' && !enable)) throw new Error(result.error)
    const task = remote.snapshot.tasks.find(task => task.id === row.pin.taskId)
    const category = remote.snapshot.taskStatuses.find(status => status.id === task?.statusId)?.category
    if (result.ok && (category === 'done' || category === 'cancelled')) this.edit(row.pin, current => { current.projectionActive = false })
  }
  private async inputCurrent(row: Row, sender: NativeTaskProgressSender): Promise<void> {
    if (!row.plan) return
    if (row.plan.managedDirectory && readBounded(join(row.plan.root, 'task-input.json'), 270 * 1024) !== JSON.stringify({ inputVersion: row.plan.inputVersion, material: row.plan.material })) throw new DesktopTeamError('TASK_INPUT_CHANGED', '本机冻结任务材料已改变，请核对原版本后建立新会话')
    const query = { workspaceKey: row.pin.workspaceKey, taskId: row.pin.taskId }
    const source = await this.pinnedSource(row, sender)
    if (source.closed || !row.plan.managedDirectory && !source.canCreate) throw new DesktopTeamError('TASK_PROGRESS_FORBIDDEN', '原任务已结束或已交接到不可执行阶段，未继续原会话的新写入')
    if (source.revision !== row.plan.sourceVersion) throw new DesktopTeamError('TASK_INPUT_CHANGED', '中心需求、验收或设计材料已变化，请审阅后显式重新绑定新会话；旧输入版本已保留')
    if (!row.plan.managedDirectory) {
      const binding = row.plan.resourceBinding
      if (!binding) throw new DesktopTeamError('TASK_RESOURCE_REVIEW_REQUIRED', '原会话尚未固定代码资源与工作副本，请核对后显式建立新的执行绑定；原历史已保留')
      const resource = await sender.codeResource()
      const sourceDigest = createHash('sha256').update(JSON.stringify(resource.resource?.source ?? null)).digest('hex')
      if (resource.availability !== 'available' || resource.resource?.resourceId !== binding.resourceId || resource.selection?.revision !== binding.selectionRevision
        || resource.taskCreatedAt !== binding.taskCreatedAt || source.taskCreatedAt !== binding.taskCreatedAt || sourceDigest !== binding.sourceDigest) {
        throw new DesktopTeamError('TASK_RESOURCE_CHANGED', '原任务代码资源已变化或停用，不能沿用旧会话继续写入；请核对原开发尝试')
      }
      if (cruxWorkProjectIdentity(row.plan.root) !== binding.projectIdentity) throw new DesktopTeamError('TASK_WORKCOPY_CHANGED', '原工作副本目录身份已变化，不能以同名目录恢复执行')
      const identity = createHash('sha256').update(JSON.stringify([row.pin.workspaceKey, row.pin.connectionId, row.pin.projectId, row.pin.ownerId, row.pin.origin, row.pin.instanceId])).digest('hex')
      const record = new CruxWorkBindings(this.userData).read({ workspaceKey: row.pin.workspaceKey, spaceId: row.pin.spaceId, taskId: row.pin.taskId, identity, taskCreatedAt: binding.taskCreatedAt })
      if (!record || record.value.projectIdentity !== binding.projectIdentity || rootKey(record.value.projectRoot) !== rootKey(row.plan.root)
        || record.value.codeResource?.resourceId !== binding.resourceId || record.value.codeResource.selectionRevision !== binding.selectionRevision || record.value.codeResource.sourceDigest !== binding.sourceDigest) {
        throw new DesktopTeamError('TASK_WORKCOPY_CHANGED', '原任务的本机绑定已变化，请重新核对；不会跟随当前工程')
      }
      const context = row.plan.development
      if (!context || record.value.commandId !== context.contextId || (record.value.generation ?? 1) !== context.generation || record.value.sourceRevision !== row.plan.inputVersion || record.value.taskCreatedAt !== context.taskCreatedAt) throw new DesktopTeamError('TASK_WORKCOPY_CHANGED', '原开发尝试已被取代或输入已变化，请建立明确的新执行绑定')
      const inputs = await sender.inputs(context.taskCreatedAt)
      if (inputs.admission.status !== 'ready' || (inputs.current?.digest ?? null) !== (record.value.material.governance?.digest ?? null)) throw new DesktopTeamError('TASK_INPUT_CHANGED', '团队已采用输入或批准状态发生变化，请比较后建立新的开发尝试；旧输入保留')
      const preview = await inspectCruxWorkExecutionProject(row.plan.root, resource.resource ?? undefined)
      const baseline = record.value.git
      if (baseline === undefined || !preview.resourceMatched || baseline && (!preview.git || preview.git.repoRoot !== baseline.repoRoot || preview.git.branch !== baseline.branch || preview.git.detached !== baseline.detached || baseline.detached && preview.git.head !== baseline.head)) throw new DesktopTeamError('TASK_WORKCOPY_CHANGED', '原工作副本的分支或仓库已变化，未沿用旧会话继续写入')
      const disk = reconcileCruxWork(record.value)
      if (!disk || disk.local.taskDir !== row.plan.taskDir || disk.sourceRevision !== row.plan.inputVersion) throw new DesktopTeamError('TASK_INPUT_CHANGED', '原任务目录或固定输入无法核对')
      for (const file of record.value.referenceFiles ?? []) {
        if (materialRead(row.plan.root, `${disk.local.relativeDir}/${file.relativePath}`).revision !== file.bodyDigest) throw new DesktopTeamError('TASK_INPUT_CHANGED', '已采用的固定输入文件被修改，请核对原材料')
      }
    }
  }
  private async stopOld(row: Row): Promise<void> {
    if (!row.session) return
    const acp = await import('../acp')
    await acp.cancelAcpSession(row.session.projectRoot, row.session.sessionId).catch(() => {})
  }
  private taskKey(row: Row): string {
    const development = row.plan?.development
    if (!development) throw new Error('原任务缺少开发尝试身份')
    return taskDevelopmentKey({ workspaceKey: row.pin.workspaceKey, actorId: row.pin.ownerId, spaceId: row.pin.spaceId, taskId: row.pin.taskId,
      taskCreatedAt: development.taskCreatedAt, instanceId: row.pin.instanceId, epoch: row.pin.epoch })
  }
  private sessionExpected(row: Row): Parameters<typeof import('../acp').reserveTaskSession>[2] {
    if (!row.plan) throw new Error('Manual reporting has no native session intent')
    const plan = row.plan
    return { engine: plan.engine, taskDir: plan.taskDir, task: { taskId: row.pin.taskId, spaceId: row.pin.spaceId, inputVersion: plan.inputVersion,
      ...(plan.development ? { workcopyTaskKey: this.taskKey(row) } : {}) } }
  }
  private recoveryExpected(row: Row): Parameters<typeof import('../acp').reserveTaskSession>[2] {
    if (!row.plan) throw new Error('原任务没有本机会话')
    const intent = readTaskSessionIntent(workcopyUseDirectory(), row.plan.root, row.nativeAlias)
    if (!intent) throw new DaemonError('E_UNKNOWN', '原任务创建意图缺失，无法判定旧工作副本身份；请核对原会话清理。', 'unknown')
    const current = this.sessionExpected(row)
    const legacy = row.plan.development ? { ...current, task: { ...current.task, workcopyTaskKey: legacyTaskDevelopmentKey({ workspaceKey: row.pin.workspaceKey, actorId: row.pin.ownerId,
      spaceId: row.pin.spaceId, taskId: row.pin.taskId, taskCreatedAt: row.plan.development.taskCreatedAt }) } } : current
    if (JSON.stringify(intent.expected) !== JSON.stringify(current) && JSON.stringify(intent.expected) !== JSON.stringify(legacy)) throw new DaemonError('E_UNKNOWN', '原创建意图与任务身份不一致，未接管原会话。', 'unknown')
    return intent.expected
  }
  private async reconcileCreation(row: Row, sender: NativeTaskProgressSender): Promise<Row> {
    if (row.plan) {
      const original = this.recoveryExpected(row)
      if (original.task?.workcopyTaskKey !== this.sessionExpected(row).task?.workcopyTaskKey) throw new DaemonError('E_UNKNOWN', '旧任务会话仅可核对或清理，请建立新会话继续开发。', 'unknown')
      const acp = await import('../acp')
      const proof = await acp.reconcileTaskSession(row.plan.root, row.nativeAlias, original)
      if (proof.status === 'unknown') {
        this.edit(row.pin, current => { current.errorCode = 'NATIVE_CREATION_RECOVERY_REQUIRED' })
        throw new DaemonError('E_UNKNOWN', proof.reason, 'unknown')
      }
      if (proof.status === 'settled') {
        this.edit(row.pin, current => { current.state = 'stopped'; current.projectionActive = false; current.errorCode = proof.outcome === 'not-created' ? 'NATIVE_CREATION_NOT_ADMITTED' : 'NATIVE_CREATION_CLEANED';
          if (current.dispatch !== 'sent' && proof.dispatch !== 'not-sent') current.dispatch = proof.dispatch === 'sent' ? 'sent' : 'unknown' })
        return this.require(row.pin)
      }
      this.edit(row.pin, current => { current.session = proof.session; if (current.dispatch !== 'sent' && proof.dispatch !== 'not-sent') current.dispatch = proof.dispatch === 'sent' ? 'sent' : 'unknown' })
      row = this.require(row.pin)
      await this.inputCurrent(row, sender)
    }
    const server = await sender.status(), expected = row.creationBinding ?? { commandId: randomUUID(), generation: 0, bindingId: null }
    if (server.generation !== expected.generation || (server.binding?.bindingId ?? null) !== expected.bindingId) {
      this.edit(row.pin, current => { current.server = server; current.state = 'stopped'; current.errorCode = 'TASK_PROGRESS_BINDING_CONFLICT'; current.projectionActive = false })
      return this.require(row.pin)
    }
    this.edit(row.pin, current => {
      current.server = server; current.creationBinding = expected; current.errorCode = null; current.state = 'binding'
      current.queue.push({ command: { commandId: expected.commandId, expectedEpoch: current.pin.epoch, kind: 'bind', expectedGeneration: expected.generation, expectedBindingId: expected.bindingId,
        source: { kind: 'desktop', sessionId: current.nativeAlias, engine: current.plan?.engine ?? 'manual', directoryName: current.plan ? basename(current.plan.root).slice(0, 100) || 'Task' : 'Manual progress' } }, state: 'queued', attempts: 0 })
    })
    return this.require(row.pin)
  }
  private async sync(query: CruxProgressQuery): Promise<TaskProgressNativeView> {
    let row = this.require(query)
    if (row.state === 'preparing') {
      row = await this.reconcileCreation(row, await this.sender(row.pin))
      if (row.state === 'stopped') return this.view(row)
    }
    if (!row.projectionActive && !['binding', 'active', 'releasing'].includes(row.state)) return this.view(row)
    const sender = await this.sender(row.pin)
    let commandId: string | undefined
    try {
      // Formal task projection always comes from a fresh protected snapshot, including the final/handed-over stage.
      await this.project(row, false, sender)
      if (!['binding', 'active', 'releasing'].includes(this.require(query).state)) return this.view(this.require(query))
      const server = await sender.status()
      await this.executeOwned({ operation: 'observe', query, server })
      if (this.require(query).state === 'stopped') { await this.stopOld(row); return this.view(this.require(query)) }
      for (let count = 0; count < 4; count++) {
        row = this.require(query)
        if (!row.queue.length || !['binding', 'active', 'releasing'].includes(row.state)) break
        const item = await this.executeOwned({ operation: 'take', query }) as TaskProgressDelivery | null
        if (!item) break
        commandId = item.command.commandId
        const reply = await sender.command(item.command)
        await this.executeOwned({ operation: 'ack', query, reply })
        commandId = undefined
      }
      return this.view(this.require(query))
    } catch (error) {
      const code = error instanceof DesktopTeamError ? error.code : 'LOCAL_PROGRESS_CONFLICT'
      const retry = ['NETWORK_UNAVAILABLE', 'ACKNOWLEDGEMENT_UNKNOWN'].includes(code)
      await this.executeOwned({ operation: 'fail', query, commandId, code, uncertain: Boolean(commandId) && (retry || error instanceof DesktopTeamError && error.outcomeUnknown), terminal: !retry })
      if (!retry) await this.stopOld(row)
      throw error
    }
  }
  private find(query: CruxProgressQuery): Row | undefined { return [...this.rows].reverse().find(row => key(row.pin) === key(query)) }
  private require(query: CruxProgressQuery): Row {
    const row = this.find(query)
    if (!row) throw new Error('Original task progress binding was not found')
    return row
  }
  private commit(change: (rows: Row[]) => void): void {
    this.assertOwner()
    const next = structuredClone(this.rows)
    change(next)
    const value = storeSchema.parse({ version: 1, rows: next })
    const body = JSON.stringify(value)
    if (Buffer.byteLength(body) > MAX_STORE_BYTES) throw new DesktopTeamError('CAPACITY_EXCEEDED', '本机任务进度记录超过 8 MiB 上限；原队列与文件已保留，未启动新的任务')
    writeAtomic(this.file, body)
    this.rows = value.rows
  }
  private edit(query: CruxProgressQuery, change: (row: Row) => void): void {
    this.commit(rows => { const row = [...rows].reverse().find(item => key(item.pin) === key(query)); if (!row) throw new Error('Original task progress binding was not found'); change(row) })
  }
  private value(row: Row, freshness: CruxProgressValue['freshness'] = 'pending'): CruxProgressValue {
    return { workspaceKey: row.pin.workspaceKey, taskId: row.pin.taskId, server: structuredClone(row.server), freshness,
      local: { state: row.state, pendingCount: row.queue.filter(item => item.state !== 'settled').length, outcomeUnknown: row.state === 'preparing' || row.dispatch === 'unknown' || row.queue.some(item => item.state === 'dispatching' || item.state === 'unknown'),
        ...(row.plan && (row.state === 'preparing' || !row.session) ? { creationSessionId: row.nativeAlias, creationRecoveryRequired: row.state === 'preparing' || row.dispatch === 'unknown' } : {}),
        ...(row.plan ? { workcopyRoot: row.plan.root } : {}),
        ownsBinding: row.state === 'active' && row.bindingId !== null && row.server.binding?.bindingId === row.bindingId
          && row.server.binding.generation === row.bindingGeneration && row.server.binding.reporterId === row.pin.ownerId && row.server.binding.deviceId === row.pin.deviceId,
        errorCode: row.errorCode, session: structuredClone(row.session), inputVersion: row.plan?.inputVersion ?? row.pin.epoch,
        dispatch: row.dispatch, managedDirectory: row.plan?.managedDirectory ?? false } }
  }
  private view(row: Row): TaskProgressNativeView { return { value: this.value(row), pin: structuredClone(row.pin), plan: structuredClone(row.plan) } }
  private owned(owner: Pick<AcpSessionRecord, 'sessionId' | 'projectRoot' | 'cwd' | 'connectionGeneration' | 'backendSessionId'>): Row | undefined {
    let root: string, cwd: string
    try { root = rootKey(realpathSync.native(owner.projectRoot)); cwd = rootKey(realpathSync.native(owner.cwd ?? owner.projectRoot)) } catch { return undefined }
    return this.rows.find(row => row.session?.sessionId === owner.sessionId && row.session.connectionGeneration === owner.connectionGeneration
      && rootKey(row.session.projectRoot) === rootKey(owner.projectRoot) && rootKey(row.session.cwd) === rootKey(owner.cwd ?? owner.projectRoot)
      && rootKey(row.session.projectRoot) === root && rootKey(row.session.cwd) === cwd
      && (!row.session.backendSessionId || row.session.backendSessionId === owner.backendSessionId))
  }
  private observeState(owner: Parameters<CruxTaskProgressRuntime['owned']>[0], status: AcpSessionStatus, outcome?: 'completed' | 'cancelled' | 'failed'): void {
    const row = this.owned(owner)
    if (!row || row.state !== 'active') return
    const activity = outcome && outcome !== 'completed' ? 'interrupted' : status === 'awaiting_permission' ? 'waiting_confirmation' : status === 'busy' ? 'running'
      : status === 'ready' ? 'idle' : ['error', 'disconnected', 'closed'].includes(status) ? 'interrupted'
        : status === 'cancelling' ? 'paused' : undefined
    if (!activity) return
    const queued = [...row.queue].reverse().find(item => item.command.kind === 'report')?.command
    const current = queued?.kind === 'report' ? queued : row.server.progress
    if (current && ('state' in current ? current.state : undefined) === activity) return
    // Native lifecycle never copies a tool title, permission payload or error text.
    this.report(row.pin, { activity, step: current?.step ?? null, blocker: current && 'blockingReason' in current ? current.blockingReason : null })
  }
  private assertServer(row: Row, server: TeamTaskProgressDto): void {
    const pin = row.pin
    if (server.instanceId !== pin.instanceId || server.epoch !== pin.epoch || server.projectId !== pin.projectId || server.spaceId !== pin.spaceId || server.taskId !== pin.taskId) throw new Error('Original task authority changed')
    if (server.authorizationRevision < row.server.authorizationRevision || server.generation < row.server.generation) throw new Error('Task authority revision regressed')
  }
  private report(query: CruxProgressQuery, summary: z.infer<typeof taskProgressSummarySchema>): void {
    this.edit(query, row => {
      if (row.state !== 'active' || !row.bindingId) throw new Error('Original task reporting handle is not active')
      const command: TeamTaskProgressCommand = { commandId: randomUUID(), expectedEpoch: row.pin.epoch, kind: 'report', bindingId: row.bindingId,
        seq: ++row.seq, state: summary.activity, step: summary.step, blockingReason: summary.blocker }
      const tail = row.queue.at(-1)
      // Only a never-dispatched summary may be replaced. Unknown heads retain exact bytes/UUID.
      if (tail?.state === 'queued' && tail.command.kind === 'report') row.queue[row.queue.length - 1] = { command, state: 'queued', attempts: 0 }
      else { if (row.queue.length >= 3) throw new Error('Original task progress queue is full'); row.queue.push({ command, state: 'queued', attempts: 0 }) }
    })
  }
  async execute(raw: unknown): Promise<unknown> {
    const input = taskProgressNativeSchema.parse(raw)
    const scope = 'query' in input ? key(input.query) : 'input' in input ? key(input.input) : input.operation === 'prepare' ? key(input.pin) : '@catalog'
    const previous = this.work.get(scope) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(() => this.executeOwned(input))
    this.work.set(scope, current)
    try { return await current } finally { if (this.work.get(scope) === current) this.work.delete(scope) }
  }
  private async executeOwned(input: TaskProgressNativeInput): Promise<unknown> {
    if (this.closed && !['catalog', 'read', 'conversation', 'events', 'cancel', 'official'].includes(input.operation)) throw new Error('Task execution admission is closed')
    if (input.operation.startsWith('outputs.')) {
      const result = await this.outputs.execute(input)
      if (this.outputs.hasWork()) this.schedule()
      return result
    }
    if (input.operation === 'catalog') return this.rows.filter(row => ['binding', 'active', 'releasing'].includes(row.state)).map(row => this.view(row))
    if (input.operation === 'read') { const row = this.find(input.query); return row ? this.view(row) : null }
    if (input.operation === 'prepare') return this.prepare(input)
    if (['conversation', 'events', 'send', 'respond', 'cancel', 'resume'].includes(input.operation)) return this.conversation(input)
    if (!('query' in input)) throw new Error('Task progress operation is invalid')
    const row = this.require(input.query)
    switch (input.operation) {
      case 'observe': {
        this.assertServer(row, input.server)
        this.edit(input.query, current => {
          current.server = input.server
          if (current.state === 'active' && (input.server.binding?.bindingId !== current.bindingId || input.server.binding?.reporterId !== current.pin.ownerId || input.server.binding.deviceId !== current.pin.deviceId)) {
            current.state = 'stopped'; current.errorCode = 'TASK_PROGRESS_BINDING_CONFLICT'
          }
        })
        if (this.require(input.query).state === 'stopped') await this.stopOld(row)
        break
      }
      case 'take': {
        if (!['binding', 'active', 'releasing'].includes(row.state) || !row.queue.length || row.queue[0].state === 'dispatching') return null
        this.edit(input.query, current => { const item = current.queue[0]; item.state = 'dispatching'; item.attempts++ })
        return { pin: structuredClone(row.pin), command: structuredClone(this.require(input.query).queue[0].command) } satisfies TaskProgressDelivery
      }
      case 'ack': {
        const item = row.queue[0], reply = input.reply
        if (!item || item.command.commandId !== reply.commandId) throw new Error('Task acknowledgement does not match the original queue head')
        this.assertServer(row, reply.result)
        const command = item.command, binding = reply.result.binding
        const accepted = command.kind === 'bind' ? binding?.source.kind === 'desktop' && binding.source.sessionId === row.nativeAlias
          && binding.reporterId === row.pin.ownerId && binding.deviceId === row.pin.deviceId && binding.generation === command.expectedGeneration + 1
          : command.kind === 'release' ? binding === null && row.bindingGeneration !== null && reply.result.generation === row.bindingGeneration + 1
            : binding?.bindingId === row.bindingId && (reply.result.progress?.seq ?? 0) >= command.seq
        if (!accepted) { this.edit(input.query, current => { current.state = 'stopped'; current.errorCode = 'TASK_PROGRESS_BINDING_CONFLICT' }); throw new Error('The original progress binding is no longer current') }
        this.edit(input.query, current => {
          current.server = reply.result; current.queue.shift(); current.errorCode = null
          if (command.kind === 'bind') { current.bindingId = binding?.bindingId ?? null; current.bindingGeneration = binding?.generation ?? null; current.state = 'active' }
          if (command.kind === 'release') { current.bindingId = null; current.state = 'detached' }
        })
        break
      }
      case 'fail': {
        this.edit(input.query, current => {
          const item = current.queue[0]
          if (input.commandId && item?.command.commandId !== input.commandId) throw new Error('Progress failure belongs to another command')
          current.errorCode = input.code
          if (item && input.uncertain) item.state = 'unknown'
          else if (item && input.terminal && input.commandId) item.state = 'settled'
          if (input.terminal) current.state = 'stopped'
        })
        break
      }
      case 'report': this.report(input.query, input.summary); break
      case 'detach': {
        this.edit(input.query, current => {
          if (current.state === 'detached' || current.state === 'releasing') return
          if (current.state !== 'active' || !current.bindingId) throw new Error('Reconcile the original binding before detaching it')
          // Releasing fences the report handle before the request can leave this process.
          current.state = 'releasing'
          current.queue = current.queue.filter(item => item.state !== 'queued')
          current.queue.push({ command: { commandId: randomUUID(), expectedEpoch: current.pin.epoch, kind: 'release', bindingId: current.bindingId, seq: ++current.seq }, state: 'queued', attempts: 0 })
        })
        break
      }
      case 'run': return this.run(input.query)
      case 'sync': return this.sync(input.query)
      case 'official': {
        const sender = await this.sender(row.pin), snapshot = await sender.snapshot()
        const task = snapshot.snapshot.tasks.find(task => task.id === row.pin.taskId && task.spaceId === row.pin.spaceId)
        if (!task) throw new Error('The original official task is no longer readable')
        return { authority: { instanceId: snapshot.instanceId, epoch: snapshot.epoch, revision: snapshot.revision, authorizationRevision: snapshot.authorizationRevision },
          task: { id: task.id, spaceId: task.spaceId, stage: task.workflow?.stage ?? null, handlerId: task.workflow?.handlerId ?? task.assigneeIds[0] ?? null,
            statusId: task.statusId, updatedAt: task.updatedAt }, freshness: 'remote' }
      }
    }
    return this.view(this.require(input.query))
  }
  private async conversation(input: TaskProgressNativeInput): Promise<unknown> {
    if (!('query' in input) && !('input' in input)) throw new Error('A task conversation requires its original handle')
    const query = 'query' in input ? input.query : input.input
    const row = this.require(query), owner = row.session
    if (!owner) throw new Error('This task has no native conversation')
    const acp = await import('../acp')
    const read = () => acp.getAcpHistorySession(owner.projectRoot, owner.sessionId)
    const current = await read()
    if (!current.ok || current.session.backendSessionId !== owner.backendSessionId || rootKey(current.session.projectRoot) !== rootKey(owner.projectRoot)
      || rootKey(current.session.cwd ?? current.session.projectRoot) !== rootKey(owner.cwd) || current.session.taskProgress?.taskId !== row.pin.taskId
      || current.session.taskProgress.inputVersion !== row.plan?.inputVersion) throw new Error('The original native conversation identity cannot be verified')
    if (input.operation === 'conversation') return current
    if (input.operation === 'events') {
      const { workspaceKey: _w, taskId: _t, ...paging } = input.input
      return acp.getAcpHistoryEvents(owner.projectRoot, owner.sessionId, paging)
    }
    if (input.operation === 'cancel') return acp.cancelAcpSession(owner.projectRoot, owner.sessionId)
    if (row.state !== 'active' || row.server.binding?.bindingId !== row.bindingId) throw new Error('The original task progress handle is no longer active')
    if (input.operation === 'resume') {
      await this.inputCurrent(row, await this.sender(row.pin))
      const result = await acp.resumeAcpSession(owner.projectRoot, owner.sessionId)
      if (!result.ok) return result
      const restored = await read()
      if (!restored.ok || restored.session.backendSessionId !== owner.backendSessionId || !restored.session.connectionGeneration
        || rootKey(restored.session.cwd ?? restored.session.projectRoot) !== rootKey(owner.cwd)) throw new Error('Original native session restore was not confirmed')
      this.edit(query, next => { if (next.session) next.session.connectionGeneration = restored.session.connectionGeneration as string })
      return result
    }
    if (current.session.connectionGeneration !== owner.connectionGeneration) throw new Error('Original conversation connection changed; explicitly resume the same session')
    if (input.operation === 'send') {
      if (input.input.expectedConnectionGeneration !== owner.connectionGeneration) throw new Error('The task conversation connection is stale')
      await this.inputCurrent(row, await this.sender(row.pin))
      return acp.promptAcpSession(owner.projectRoot, owner.sessionId, input.input.text, { expectedConnectionGeneration: owner.connectionGeneration }, () => this.require(query).state === 'active')
    }
    if (input.operation === 'respond') {
      const request = current.session.pendingPermissions?.find(item => item.requestId === input.input.requestId && item.connectionGeneration === owner.connectionGeneration)
      const option = request?.options.find(item => item.optionId === input.input.optionId)
      if (input.input.expectedConnectionGeneration !== owner.connectionGeneration || !request || !option) throw new Error('The task permission request is no longer current')
      if (option.kind === 'allow_once' || option.kind === 'allow_always') await this.inputCurrent(row, await this.sender(row.pin))
      return acp.respondAcpPermission(owner.projectRoot, input.input.requestId, input.input.optionId)
    }
    throw new Error('Unsupported task conversation action')
  }
  private async prepare(input: Extract<TaskProgressNativeInput, { operation: 'prepare' }>): Promise<TaskProgressNativeView> {
    if (this.rows.length >= 128) throw new DesktopTeamError('CAPACITY_EXCEEDED', '本机任务进度绑定已达 128 条上限；原待确认与投影记录已保留')
    const old = this.find(input.pin)
    if (old) {
      if (JSON.stringify(old.pin) !== JSON.stringify(input.pin)) throw new Error('Original progress identity cannot be retargeted')
      if (old.state !== 'detached' && !input.takeover) return this.view(old)
      const nativeOwner = old.plan ? old : input.plan ? [...this.rows].reverse().find(row => key(row.pin) === key(input.pin) && row.plan) : undefined
      if (nativeOwner?.plan) {
        const acp = await import('../acp'), proof = await acp.reconcileTaskSession(nativeOwner.plan.root, nativeOwner.nativeAlias, this.recoveryExpected(nativeOwner))
        let sameCopy = true
        if (input.plan) {
          try { const previous = resolveWorkcopy(nativeOwner.plan.root), next = resolveWorkcopy(input.plan.root); sameCopy = previous.id === next.id || previous.physicalId === next.physicalId } catch { /* Without physical proof, the original copy remains protected. */ }
        }
        if (proof.status === 'unknown' && input.plan && sameCopy) {
          this.edit(old.pin, current => { if (nativeOwner === old) current.state = 'preparing'; current.errorCode = 'NATIVE_CREATION_RECOVERY_REQUIRED' })
          throw new DaemonError('E_UNKNOWN', `${proof.reason} 原副本尚不能启动替代会话；请先核对原创建，或明确选择可证明独立的副本。`, 'unknown')
        }
        if (proof.status === 'present' && proof.connection === 'live') {
          const stopped = await acp.killAcpSession(proof.session.projectRoot, proof.session.sessionId)
          if (!stopped.ok && input.plan && sameCopy) {
            this.edit(old.pin, current => { if (nativeOwner === old) current.state = 'preparing'; current.errorCode = 'NATIVE_CREATION_RECOVERY_REQUIRED' })
            throw new DaemonError('E_UNKNOWN', stopped.error, 'unknown')
          }
        }
      }
    }
    if (input.server.binding && !input.takeover) throw new Error('This task already has a progress reporter; explicitly confirm takeover first')
    if (input.server.instanceId !== input.pin.instanceId || input.server.epoch !== input.pin.epoch || input.server.taskId !== input.pin.taskId
      || input.server.spaceId !== input.pin.spaceId || input.server.projectId !== input.pin.projectId) throw new Error('Task progress admission authority mismatch')
    const nativeAlias = `task-${randomUUID()}`
    let plan = input.plan
    if (plan?.managedDirectory) {
      if (!plan.material) throw new Error('General task requires its complete frozen input')
      const material = JSON.stringify(plan.material)
      if (Buffer.byteLength(material) > 256 * 1024 || createHash('sha256').update(material).digest('hex') !== plan.inputVersion) throw new Error('General task material exceeds capacity or has a different version')
      const directory = join(this.dataDir, 'crux-progress', 'work', createHash('sha256').update(key(input.pin)).digest('hex'), nativeAlias)
      mkdirSync(directory, { recursive: true })
      plan = { ...plan, root: realpathSync.native(directory) }
      writeAtomic(join(plan.root, 'task-input.json'), JSON.stringify({ inputVersion: plan.inputVersion, material: plan.material }))
    } else if (plan) plan = { ...plan, root: realpathSync.native(plan.root) }
    const created: Row = { pin: input.pin, plan, session: null, nativeAlias, state: 'preparing', server: input.server, bindingId: null, bindingGeneration: null,
      seq: 0, dispatch: 'not_sent', errorCode: null, queue: [], projectionActive: Boolean(plan?.taskDir),
      creationBinding: { commandId: randomUUID(), generation: input.server.generation, bindingId: input.server.binding?.bindingId ?? null } }
    if (plan) {
      await this.inputCurrent(created, await this.sender(input.pin))
      const acp = await import('../acp')
      await acp.reserveTaskSession(plan.root, nativeAlias, this.sessionExpected(created))
    }
    this.commit(rows => {
      if (old) { const previous = [...rows].reverse().find(row => key(row.pin) === key(input.pin)); if (previous) { previous.state = 'stopped'; previous.errorCode = 'EXPLICIT_TAKEOVER'; previous.projectionActive = false } }
      rows.push(created)
    })
    if (old?.session) {
      const acp = await import('../acp')
      // A cancellation request is not a claim that another machine/process has stopped.
      await acp.cancelAcpSession(old.session.projectRoot, old.session.sessionId).catch(() => {})
    }
    if (plan) {
      const acp = await import('../acp')
      const session = await acp.newTaskAcpSession(plan.root, { agentId: plan.agentId ?? (plan.engine === 'pi' ? 'pi' : 'codex'), taskDir: plan.taskDir }, nativeAlias, plan.engine,
        this.sessionExpected(created).task)
      if (!session.ok) {
        const proof = await acp.reconcileTaskSession(plan.root, nativeAlias, this.sessionExpected(created))
        this.edit(input.pin, row => { row.state = proof.status === 'settled' ? 'stopped' : 'preparing'; row.errorCode = proof.status === 'settled' ? session.code : 'NATIVE_CREATION_RECOVERY_REQUIRED';
          if (proof.status === 'present') row.session = proof.session
          if (proof.dispatch !== 'not-sent') row.dispatch = proof.dispatch === 'sent' ? 'sent' : 'unknown' })
        const knownUnsent = proof.status === 'settled' && proof.dispatch === 'not-sent'
        throw new DaemonError(knownUnsent ? 'E_CONFLICT' : 'E_UNKNOWN', proof.status === 'unknown' ? proof.reason : session.error, knownUnsent ? 'not-admitted' : 'unknown')
      }
      this.edit(input.pin, row => { row.session = session.session })
    }
    this.edit(input.pin, row => {
      const source = { kind: 'desktop' as const, sessionId: nativeAlias, engine: plan?.engine ?? 'manual', directoryName: plan ? basename(plan.root).slice(0, 100) || 'Task' : 'Manual progress' }
      row.queue.push({ command: { commandId: row.creationBinding?.commandId ?? randomUUID(), expectedEpoch: row.pin.epoch, kind: 'bind', expectedGeneration: row.creationBinding?.generation ?? row.server.generation, expectedBindingId: row.creationBinding ? row.creationBinding.bindingId : row.server.binding?.bindingId ?? null, source }, state: 'queued', attempts: 0 })
      row.state = 'binding'
    })
    this.schedule()
    return this.view(this.require(input.pin))
  }
  private async run(query: CruxProgressQuery): Promise<TaskProgressNativeView> {
    let row = this.require(query)
    if (row.state !== 'active' || row.queue.length || !row.bindingId) throw new Error('Server must confirm the original progress binding before task delivery')
    if (!row.plan || !row.session || row.dispatch === 'sent') return this.view(row)
    if (row.dispatch !== 'not_sent') throw new Error('Original task delivery is uncertain; inspect the retained session without replaying its prompt')
    const sender = await this.sender(row.pin)
    const confirmed = await sender.status()
    await this.executeOwned({ operation: 'observe', query, server: confirmed })
    if (this.require(query).state !== 'active') throw new Error('Original server binding is no longer current')
    await this.project(this.require(query), true, sender)
    await this.inputCurrent(this.require(query), sender)
    const acp = await import('../acp')
    const current = await acp.getAcpHistorySession(row.session.projectRoot, row.session.sessionId)
    if (!current.ok || current.session.backendSessionId !== row.session.backendSessionId || current.session.connectionGeneration !== row.session.connectionGeneration
      || rootKey(current.session.cwd ?? current.session.projectRoot) !== rootKey(row.session.cwd)) throw new Error('Original native session identity changed; task was not sent')
    this.edit(query, owned => { owned.dispatch = 'dispatching' })
    const result = await acp.promptAcpSession(row.session.projectRoot, row.session.sessionId, row.plan.prompt,
      { expectedConnectionGeneration: row.session.connectionGeneration }, () => this.require(query).state === 'active')
    this.edit(query, owned => { owned.dispatch = result.ok ? 'sent' : 'unknown'; if (!result.ok) owned.errorCode = result.code })
    row = this.require(query)
    if (!result.ok) throw new Error(result.error)
    return this.view(row)
  }
}

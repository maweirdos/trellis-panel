import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import type { HifoxProgressQuery, HifoxProgressSession, HifoxProgressValue } from '../../../shared/hifox-task-progress'
import { hifoxProgressSessionSchema } from '../../../shared/hifox-task-progress'
import { taskProgressNativeSchema, taskProgressPinSchema, taskProgressPlanSchema, taskProgressSummarySchema, type TaskProgressNativeInput } from '../../../shared/hifox-task-progress-native'
import { teamTaskProgressCommandSchema, teamTaskProgressDtoSchema, type TeamTaskProgressCommand, type TeamTaskProgressDto } from '../../../shared/team-task-progress'
import { readBounded, writeAtomic } from '../../daemon/files'
import { installTaskProgressEvents } from './task-progress-events'
import type { AcpSessionRecord, AcpSessionStatus } from '../../../shared/types'
import { HifoxWorkBindings } from './task-workspace-records'
import { projectTeamTaskToLocal } from './team-task-projection'
import type { NativeTaskProgressSender } from './task-progress-sender'
import { DesktopTeamError } from '../team-platform/types'
import { readHifoxWorkSource, type HifoxWorkWorkspaceView } from './task-workspace-source'

const rowSchema = z.object({
  pin: taskProgressPinSchema, plan: taskProgressPlanSchema.nullable(),
  session: hifoxProgressSessionSchema.nullable(), nativeAlias: z.string(),
  state: z.enum(['preparing', 'binding', 'active', 'releasing', 'detached', 'stopped']),
  server: teamTaskProgressDtoSchema, bindingId: z.string().uuid().nullable(), bindingGeneration: z.number().int().nonnegative().safe().nullable().default(null), seq: z.number().int().nonnegative().safe(),
  dispatch: z.enum(['not_sent', 'dispatching', 'sent', 'unknown']), errorCode: z.string().nullable(),
  projectionActive: z.boolean().default(false),
  queue: z.array(z.object({ command: teamTaskProgressCommandSchema, state: z.enum(['queued', 'dispatching', 'unknown']), attempts: z.number().int().nonnegative() }).strict()).max(4)
}).strict()
const storeSchema = z.object({ version: z.literal(1), rows: z.array(rowSchema).max(128) }).strict()
type Row = z.infer<typeof rowSchema>
type QueueItem = Row['queue'][number]
export type TaskProgressDelivery = { pin: Row['pin']; command: TeamTaskProgressCommand }
export type TaskProgressNativeView = { value: HifoxProgressValue; pin: Row['pin']; plan: Row['plan'] }
const key = (q: HifoxProgressQuery): string => JSON.stringify([q.workspaceKey, q.taskId])
const rootKey = (s: string): string => process.platform === 'win32' ? s.toLowerCase() : s
const MAX_STORE_BYTES = 8 * 1024 * 1024

/** One daemon writer. Native tool reports and lifecycle observations share the same durable queue. */
export class HifoxTaskProgressRuntime {
  private rows: Row[]
  private readonly file: string
  private readonly dispose: () => void
  private readonly work = new Map<string, Promise<unknown>>()
  private timer?: ReturnType<typeof setTimeout>
  private closed = false
  private pumping = false
  private offset = 0
  private failures = 0
  constructor(private readonly dataDir: string, private readonly userData: string = dataDir, private readonly assertOwner: () => void = () => {}, private readonly assertSending: () => void = assertOwner) {
    this.file = join(dataDir, 'hifox-progress', 'state.json')
    this.rows = existsSync(this.file) ? storeSchema.parse(JSON.parse(readBounded(this.file, MAX_STORE_BYTES))).rows : []
    for (const row of this.rows) {
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
    if (this.rows.some(row => row.projectionActive || ['binding', 'active', 'releasing'].includes(row.state))) this.schedule()
  }
  async close(): Promise<void> { this.closed = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; await Promise.allSettled([...this.work.values()]); this.dispose() }
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
  private async background(): Promise<void> {
    if (this.closed || this.pumping) return
    this.assertSending()
    this.pumping = true
    try {
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
    const record = new HifoxWorkBindings(this.userData).read({ workspaceKey: row.pin.workspaceKey, spaceId: row.pin.spaceId, taskId: row.pin.taskId, identity })
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
    const remote = await sender.snapshot()
    const view: HifoxWorkWorkspaceView = { snapshot: remote.snapshot, context: { key: row.pin.workspaceKey, connectionId: row.pin.connectionId,
      origin: row.pin.origin, actorId: row.pin.ownerId, projectId: row.pin.projectId, instanceId: remote.instanceId, epoch: remote.epoch,
      authorizationRevision: remote.authorizationRevision, revision: remote.revision, state: 'connected', projectName: null, canManage: remote.canManage, pendingCount: 0 } }
    const query = { workspaceKey: row.pin.workspaceKey, taskId: row.pin.taskId }
    const source = await readHifoxWorkSource({ workspaceSnapshot: async () => view, workspaceStatus: async () => view.context }, query)
    if (source.revision !== row.plan.sourceVersion) throw new DesktopTeamError('TASK_INPUT_CHANGED', '中心需求、验收或设计材料已变化，请审阅后显式重新绑定新会话；旧输入版本已保留')
  }
  private async stopOld(row: Row): Promise<void> {
    if (!row.session) return
    const acp = await import('../acp')
    await acp.cancelAcpSession(row.session.projectRoot, row.session.sessionId).catch(() => {})
  }
  private async sync(query: HifoxProgressQuery): Promise<TaskProgressNativeView> {
    let row = this.require(query)
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
  private find(query: HifoxProgressQuery): Row | undefined { return [...this.rows].reverse().find(row => key(row.pin) === key(query)) }
  private require(query: HifoxProgressQuery): Row {
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
  private edit(query: HifoxProgressQuery, change: (row: Row) => void): void {
    this.commit(rows => { const row = [...rows].reverse().find(item => key(item.pin) === key(query)); if (!row) throw new Error('Original task progress binding was not found'); change(row) })
  }
  private value(row: Row, freshness: HifoxProgressValue['freshness'] = 'pending'): HifoxProgressValue {
    return { workspaceKey: row.pin.workspaceKey, taskId: row.pin.taskId, server: structuredClone(row.server), freshness,
      local: { state: row.state, pendingCount: row.queue.length, outcomeUnknown: row.dispatch === 'unknown' || row.queue.some(item => item.state !== 'queued'),
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
  private observeState(owner: Parameters<HifoxTaskProgressRuntime['owned']>[0], status: AcpSessionStatus, outcome?: 'completed' | 'cancelled' | 'failed'): void {
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
  private report(query: HifoxProgressQuery, summary: z.infer<typeof taskProgressSummarySchema>): void {
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
      if (input.input.expectedConnectionGeneration !== owner.connectionGeneration || !current.session.pendingPermissions?.some(item => item.requestId === input.input.requestId && item.connectionGeneration === owner.connectionGeneration)) throw new Error('The task permission request is no longer current')
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
      const directory = join(this.dataDir, 'hifox-progress', 'work', createHash('sha256').update(key(input.pin)).digest('hex'), nativeAlias)
      mkdirSync(directory, { recursive: true })
      plan = { ...plan, root: realpathSync.native(directory) }
      writeAtomic(join(plan.root, 'task-input.json'), JSON.stringify({ inputVersion: plan.inputVersion, material: plan.material }))
    } else if (plan) plan = { ...plan, root: realpathSync.native(plan.root) }
    const created: Row = { pin: input.pin, plan, session: null, nativeAlias, state: 'preparing', server: input.server, bindingId: null, bindingGeneration: null,
      seq: 0, dispatch: 'not_sent', errorCode: null, queue: [], projectionActive: Boolean(plan?.taskDir) }
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
        { taskId: input.pin.taskId, spaceId: input.pin.spaceId, inputVersion: plan.inputVersion })
      if (!session.ok) { this.edit(input.pin, row => { row.state = 'stopped'; row.errorCode = session.code }); throw new Error(session.error) }
      this.edit(input.pin, row => { row.session = session.session })
    }
    this.edit(input.pin, row => {
      const source = { kind: 'desktop' as const, sessionId: nativeAlias, engine: plan?.engine ?? 'manual', directoryName: plan ? basename(plan.root).slice(0, 100) || 'Task' : 'Manual progress' }
      row.queue.push({ command: { commandId: randomUUID(), expectedEpoch: row.pin.epoch, kind: 'bind', expectedGeneration: row.server.generation, expectedBindingId: row.server.binding?.bindingId ?? null, source }, state: 'queued', attempts: 0 })
      row.state = 'binding'
    })
    this.schedule()
    return this.view(this.require(input.pin))
  }
  private async run(query: HifoxProgressQuery): Promise<TaskProgressNativeView> {
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

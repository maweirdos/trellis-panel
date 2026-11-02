import { join } from 'node:path'
import { z } from 'zod'
import { requirementExecutionPrepareSchema, type RequirementExecutionPrepare, type RequirementExecutionPreparation } from '../../../shared/conversation-requirement-execution'
import { requirementConfirmedSchema, requirementTaskOriginSchema, requirementTaskSchema, REQUIREMENT_BODY_BYTES, REQUIREMENT_FILE_BYTES, REQUIREMENT_REFERENCES_BYTES, type RequirementTask, type RequirementTaskOrigin } from '../../../shared/conversation-requirements'
import type { AcpSessionMeta, ProjectSnapshot } from '../../../shared/types'
import type { IpcFail } from '../../../shared/ipc-errors'
import { canonicalWorkflowJson } from '../../../shared/workflow'
import { runtimeCall, readRuntimeCommandReceipt } from '../daemon-client/runtime'
import { runTaskStartCli, recoverTaskCliOperation, taskCliReceiptExists, type TaskCliRunResult } from '../local-task/cli-runner'
import { DaemonError } from '../../daemon/errors'
import { scanProject } from '../scan'
import { checkedDirectory, directoryIdentity, hash, pathKey, readRegular } from './files'
import { readOptional, RequirementError, trellisTarget, utf8, writeRevision } from './requirement-files'

/** All fields are captured from the original server-owned handoff, never renderer arguments. */
export interface RequirementExecutionOwner {
  conversationId: string
  creatorId: string
  task: RequirementTask
  origin: RequirementTaskOrigin
  targetIdentity: string
  assertCurrent(): void
}
export interface RequirementExecutionPorts {
  metaDirectory(): string
  validateExecutor(root: string, input: RequirementExecutionPrepare, current: () => boolean): Promise<string>
  startTask(root: string, taskDir: string, commandId: string, contextKey: string): Promise<TaskCliRunResult>
  recoverStart(root: string, commandId: string): Promise<TaskCliRunResult>
  startReceiptExists(root: string, commandId: string): Promise<boolean>
  newSession(root: string, input: { agentId: string; profileId?: string; taskDir: string }, commandId: string, current: () => boolean): Promise<{ ok: true; sessionId: string } | IpcFail>
  recoverNewSession(root: string, commandId: string, current: () => boolean): Promise<{ state: 'absent' | 'dispatching' | 'completed' | 'unknown'; result?: unknown }>
  readSession(root: string, sessionId: string, current: () => boolean): Promise<AcpSessionMeta>
  snapshot(root: string): ProjectSnapshot
}

const uuid = z.string().uuid(), digest = z.string().regex(/^[a-f0-9]{64}$/)
const newSessionReply = z.object({ ok: z.literal(true), sessionId: z.string().regex(/^acp-(?!private-)[A-Za-z0-9._-]{1,180}$/) })
const executionOrigin = requirementTaskOriginSchema.extend({ confirmedRevision: uuid, sourceDigest: digest, planRevision: uuid, planBodyRevision: digest, planSourceRevision: uuid })
const journalSchema = z.object({
  version: z.literal(1), commandId: uuid, inputDigest: digest, sourceRevision: digest, taskIdentity: z.string().min(1), executorRevision: digest,
  contextKey: z.string().regex(/^requirement_execution_[a-f0-9-]{36}$/),
  phase: z.enum(['registered', 'starting-task', 'task-started', 'creating-session', 'session-created', 'prepared', 'failed', 'uncertain']),
  sessionId: z.string().min(1).max(200).optional(), connectionGeneration: z.string().min(1).max(200).optional(), detail: z.string().max(2000).optional()
}).strict()
type Journal = z.infer<typeof journalSchema>
type Stored = { value: Journal; revision: string }
const sameRoot = (left: string, right: string): boolean => pathKey(left) === pathKey(right)
const canonical = (value: unknown): string => canonicalWorkflowJson(JSON.parse(JSON.stringify(value)))
function fail(message: string): never { throw new RequirementError(message) }
const manifestSchema = z.object({
  version: z.literal(2), conversationId: uuid, creatorId: z.string(), draftId: uuid, draftRevision: uuid, bodyRevision: digest,
  confirmed: requirementConfirmedSchema,
  plan: z.object({ revision: uuid, bodyRevision: digest, sourceRevision: uuid, sourceDigest: digest, path: z.literal('plan.md') }),
  references: z.array(z.object({ path: z.string().regex(/^references\/requirement-files\/[0-7](?:\.[A-Za-z0-9_-]{1,32})?$/), revision: digest, bytes: z.number().int().nonnegative().max(REQUIREMENT_FILE_BYTES) })).max(8)
})

const defaults: Omit<RequirementExecutionPorts, 'metaDirectory'> = {
  async validateExecutor(root, input, current) {
    const agents = await runtimeCall<{ ok: true; agents: Array<{ id: string; enabled: boolean; available: boolean; command: string; adapterVersion?: string }> } | IpcFail>(root, 'runtime.agents', { refresh: false }, undefined, current)
    if (!agents.ok) throw new RequirementError(agents.error, 'E_DENIED')
    const agent = agents.agents.find(value => value.id === input.agentId && value.enabled && value.available)
    if (!agent) throw new RequirementError('所选执行引擎当前不可用', 'E_DENIED')
    let profile: unknown = null
    if (input.profileId) {
      const profiles = await runtimeCall<{ ok: true; profiles: Array<{ id: string; runtimeId: string; cwd?: string }> } | IpcFail>(root, 'runtime.profiles', {}, undefined, current)
      if (!profiles.ok) throw new RequirementError(profiles.error, 'E_DENIED')
      const selected = profiles.profiles.find(value => value.id === input.profileId && value.runtimeId === input.agentId)
      if (!selected || selected.cwd && !sameRoot(trellisTarget(root).root, trellisTarget(selected.cwd).root)) throw new RequirementError('岗位或目录不属于原目标工程', 'E_DENIED')
      profile = selected
    }
    return hash(canonical({ agent: { id: agent.id, command: agent.command, adapterVersion: agent.adapterVersion ?? null }, profile }))
  },
  startTask: (root, taskDir, commandId, contextKey) => runTaskStartCli({ root, operationId: commandId, taskContextKey: contextKey }, taskDir),
  recoverStart: recoverTaskCliOperation,
  startReceiptExists: taskCliReceiptExists,
  newSession: (root, input, commandId, current) => runtimeCall(root, 'runtime.new', { input }, commandId, current),
  recoverNewSession: readRuntimeCommandReceipt,
  async readSession(root, sessionId, current) {
    const result = await runtimeCall<{ ok: true; session: AcpSessionMeta } | IpcFail>(root, 'runtime.historySession', { sessionId }, undefined, current)
    if (!result.ok) throw new RequirementError(result.error)
    return result.session
  },
  snapshot: scanProject
}

/** Only prepares the existing ordinary origin. It never previews, starts stages or sends a prompt. */
export class RequirementExecutionService {
  private readonly ports: RequirementExecutionPorts
  private readonly pending = new Map<string, { digest: string; work: Promise<RequirementExecutionPreparation> }>()
  constructor(ports: Pick<RequirementExecutionPorts, 'metaDirectory'> & Partial<Omit<RequirementExecutionPorts, 'metaDirectory'>>) { this.ports = { ...defaults, ...ports } }

  private guard(owner: RequirementExecutionOwner): void {
    owner.assertCurrent()
    if (directoryIdentity(owner.task.root) !== owner.targetIdentity) throw new RequirementError('原目标工程物理身份已变化', 'E_DENIED')
  }
  private source(owner: RequirementExecutionOwner, launch = true): { task: RequirementTask; revision: string; identity: string } {
    this.guard(owner)
    const root = launch ? trellisTarget(owner.task.root).root : checkedDirectory(owner.task.root), origin = executionOrigin.parse(owner.origin), prefix = `.trellis/tasks/${owner.task.taskDir}`
    const task = z.object({ id: z.string(), title: z.string(), status: z.string(), meta: z.object({ conversationRequirement: requirementTaskOriginSchema }).passthrough() }).passthrough().parse(JSON.parse(utf8(readRegular(root, `${prefix}/task.json`, 512 * 1024).bytes)))
    if (task.id !== owner.task.taskId || canonical(task.meta.conversationRequirement) !== canonical(origin)) throw new RequirementError('任务不是原需求交接身份', 'E_DENIED')
    const read = (path: string, expected: string, limit: number): Buffer => {
      const bytes = readRegular(root, `${prefix}/${path}`, limit).bytes
      if (hash(bytes) !== expected) fail(`原固定材料 ${path} 已变化；未启动任务`)
      return bytes
    }
    const manifest = manifestSchema.parse(JSON.parse(utf8(read(origin.manifestPath, origin.manifestRevision, 64 * 1024))))
    if (manifest.conversationId !== owner.conversationId || manifest.creatorId !== owner.creatorId || manifest.draftId !== origin.draftId || manifest.draftRevision !== origin.draftRevision || manifest.bodyRevision !== origin.bodyRevision
      || manifest.confirmed.revision !== origin.confirmedRevision || manifest.confirmed.bodyRevision !== origin.bodyRevision || manifest.confirmed.sourceDigest !== origin.sourceDigest
      || manifest.plan.revision !== origin.planRevision || manifest.plan.bodyRevision !== origin.planBodyRevision || manifest.plan.sourceRevision !== origin.planSourceRevision || manifest.plan.sourceRevision !== origin.confirmedRevision || manifest.plan.sourceDigest !== origin.sourceDigest) throw new RequirementError('固定需求、计划与原交接版本不一致', 'E_DENIED')
    read('references/requirement.md', origin.bodyRevision, REQUIREMENT_BODY_BYTES)
    read('references/plan.md', origin.planBodyRevision, REQUIREMENT_BODY_BYTES)
    if (launch) { read('prd.md', origin.bodyRevision, REQUIREMENT_BODY_BYTES); read('plan.md', origin.planBodyRevision, REQUIREMENT_BODY_BYTES) }
    read('references/requirement-confirmation.json', manifest.confirmed.snapshotRevision, 1024 * 1024)
    let bytes = 0
    for (const reference of manifest.references) { const actual = read(reference.path, reference.revision, REQUIREMENT_FILE_BYTES); bytes += actual.length; if (actual.length !== reference.bytes || bytes > REQUIREMENT_REFERENCES_BYTES) fail('原资料文件大小与固定清单不一致') }
    const script = launch ? hash(readRegular(root, '.trellis/scripts/task.py', 1024 * 1024).bytes) : null
    this.guard(owner)
    return { task: { ...owner.task, root, title: task.title, status: task.status }, revision: hash(canonical([origin, script])), identity: directoryIdentity(join(root, prefix)) }
  }
  private pointer(owner: RequirementExecutionOwner, entry: Journal): string | null {
    this.guard(owner)
    const file = readOptional(owner.task.root, `.trellis/.runtime/sessions/${entry.contextKey}.json`, 64 * 1024)
    if (!file) return null
    return z.object({ current_task: z.string().nullable().optional() }).parse(JSON.parse(utf8(file.bytes))).current_task ?? null
  }
  private load(path: string): Stored | null {
    const actual = readOptional(this.ports.metaDirectory(), path, 64 * 1024)
    return actual ? { value: journalSchema.parse(JSON.parse(utf8(actual.bytes))), revision: hash(actual.bytes) } : null
  }
  private save(owner: RequirementExecutionOwner, path: string, value: Journal, revision: string | null): Stored {
    this.guard(owner)
    const bytes = Buffer.from(JSON.stringify(journalSchema.parse(value)))
    writeRevision(this.ports.metaDirectory(), path, bytes, revision, () => this.guard(owner))
    return { value, revision: hash(bytes) }
  }
  private result(owner: RequirementExecutionOwner, entry: Journal, state: RequirementExecutionPreparation['state'], task: RequirementTask, extra: Partial<RequirementExecutionPreparation> = {}): RequirementExecutionPreparation {
    const taskPath = `.trellis/tasks/${task.taskDir}`
    let verified = false
    try { verified = task.status === 'in_progress' && this.pointer(owner, entry) === taskPath }
    catch (error) { this.guard(owner); if (!extra.existing) throw error }
    if (state === 'prepared' && !extra.existing && !verified) fail('原任务状态或准备指针已变化，未返回可启动的 origin')
    return { commandId: entry.commandId, state, task, activation: { contextKey: entry.contextKey, taskPath, scope: 'preparation', verified }, detail: entry.detail, ...extra }
  }

  async prepare(captured: RequirementExecutionOwner, raw: RequirementExecutionPrepare): Promise<RequirementExecutionPreparation> {
    const input = requirementExecutionPrepareSchema.parse(raw), origin = executionOrigin.parse(captured.origin)
    const task = requirementTaskSchema.parse(captured.task)
    const owner: RequirementExecutionOwner = { ...captured, task: { ...task, root: checkedDirectory(task.root) }, origin }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(owner.task.taskDir) || origin.conversationId !== owner.conversationId || origin.creatorId !== owner.creatorId
      || input.expectedHandoffCommandId !== origin.commandId || input.expectedPlanRevision !== origin.planRevision) throw new RequirementError('执行准备不属于原目标、创建者或固定计划', 'E_DENIED')
    this.guard(owner)
    const key = hash(canonical([owner.creatorId, owner.conversationId, origin.draftId, owner.task.root, owner.task.taskDir, owner.task.taskId])), path = `requirement-executions/${key}.json`
    const inputDigest = hash(canonical([input, origin, owner.task.root, owner.targetIdentity, owner.task.taskId, owner.task.taskDir]))
    const existing = this.pending.get(key)
    if (existing) {
      if (existing.digest !== inputDigest) fail('原任务正在准备另一条固定命令，未替换')
      const result = await existing.work
      this.guard(owner); this.source(owner, !result.existing && result.state !== 'prepared')
      return result
    }
    if (this.pending.size >= 16) throw new RequirementError('执行准备数量已达上限', 'E_BUSY')
    const work = this.run(owner, input, path, inputDigest)
    this.pending.set(key, { digest: inputDigest, work })
    try { return await work } finally { if (this.pending.get(key)?.work === work) this.pending.delete(key) }
  }

  private async run(owner: RequirementExecutionOwner, input: RequirementExecutionPrepare, path: string, inputDigest: string): Promise<RequirementExecutionPreparation> {
    let stored = this.load(path)
    if (stored && (stored.value.commandId !== input.commandId || stored.value.inputDigest !== inputDigest)) fail('原任务已绑定执行准备命令；请查询原命令，不新建会话')
    if (stored && (stored.value.phase === 'prepared' || stored.value.sessionId || stored.value.phase === 'creating-session' || stored.value.phase === 'uncertain')) return this.observeOrigin(owner, input, path, stored)
    let source = this.source(owner)
    const current = (): boolean => { try { this.guard(owner); return true } catch { return false } }
    const executor = await this.ports.validateExecutor(owner.task.root, input, current)
    source = this.source(owner)
    if (!stored) stored = this.save(owner, path, { version: 1, commandId: input.commandId, inputDigest, sourceRevision: source.revision, taskIdentity: source.identity, executorRevision: executor, contextKey: `requirement_execution_${input.commandId.toLowerCase()}`, phase: 'registered' }, null)
    const update = (patch: Partial<Journal>): void => { const previous = stored; if (!previous) fail('原执行准备记录不可用'); stored = this.save(owner, path, { ...previous.value, ...patch }, previous.revision) }
    const verify = (): ReturnType<RequirementExecutionService['source']> => {
      const actual = this.source(owner)
      if (!stored || actual.identity !== stored.value.taskIdentity || actual.revision !== stored.value.sourceRevision || executor !== stored.value.executorRevision) fail('原任务、固定材料或执行引擎已变化；保留原命令')
      return actual
    }
    let startNotAdmitted = false
    try {
      source = verify()
      if (stored.value.phase === 'failed') return this.result(owner, stored.value, 'failed', source.task)
      if (stored.value.phase === 'registered') {
        const pointer = this.pointer(owner, stored.value), target = `.trellis/tasks/${source.task.taskDir}`
        if (pointer && pointer !== target) fail('原激活上下文属于其他任务，未夺取指针')
        if (source.task.status === 'in_progress') {
          if (pointer !== target) fail('任务已开始但缺少原准备指针；未重复启动或夺取指针')
          update({ phase: 'task-started' })
        } else {
          if (source.task.status !== 'planning') fail('原任务当前不能激活')
          update({ phase: 'starting-task' })
          const result = await this.ports.startTask(owner.task.root, source.task.taskDir, input.commandId, stored.value.contextKey).catch(error => {
            startNotAdmitted = error instanceof DaemonError && error.code === 'E_CONFLICT' && error.outcome === 'not-admitted'
            throw error
          })
          source = verify()
          if (result.operationId !== input.commandId || result.code !== 0 || result.aborted || result.failedToStart || !result.cleanupConfirmed) fail('原 task.py 启动或子进程清理未确认；保留原命令')
          if (source.task.status !== 'in_progress' || this.pointer(owner, stored.value) !== target) fail('task.py 未同时确认实际 in_progress 和原准备指针')
          update({ phase: 'task-started' })
        }
      } else if (stored.value.phase === 'starting-task') {
        const result = await this.ports.recoverStart(owner.task.root, input.commandId)
        source = verify()
        if (result.operationId !== input.commandId || result.code !== 0 || result.aborted || result.failedToStart || !result.cleanupConfirmed || source.task.status !== 'in_progress' || this.pointer(owner, stored.value) !== `.trellis/tasks/${source.task.taskDir}`) fail('原任务激活回执未确认，未重新运行 task.py')
        update({ phase: 'task-started' })
      }
      source = verify()
      if (source.task.status !== 'in_progress' || this.pointer(owner, stored.value) !== `.trellis/tasks/${source.task.taskDir}`) fail('原任务状态或准备指针已变化，未继续建立会话')
      if (stored.value.phase === 'task-started') {
        update({ phase: 'creating-session' })
        const created = await this.ports.newSession(owner.task.root, { agentId: input.agentId, profileId: input.profileId, taskDir: source.task.taskDir }, input.commandId, current)
        this.guard(owner)
        const reply = newSessionReply.safeParse(created)
        if (!reply.success) fail('原普通会话创建没有可验证的 session ID；未重发或新建')
        update({ phase: 'session-created', sessionId: reply.data.sessionId })
      }
      return await this.observeOrigin(owner, input, path, stored, true)
    } catch (error) {
      this.guard(owner)
      if (startNotAdmitted && stored.value.phase === 'starting-task' && !stored.value.sessionId) {
        let absent = false
        try {
          source = verify()
          if (source.task.status === 'planning' && this.pointer(owner, stored.value) === null) {
            absent = await this.ports.startReceiptExists(owner.task.root, stored.value.commandId) === false
            source = verify()
            absent = absent && source.task.status === 'planning' && this.pointer(owner, stored.value) === null
          }
        } catch { this.guard(owner); absent = false }
        if (absent) {
          update({ phase: 'registered', detail: '工作副本冲突明确未准入，原启动回执不存在；释放占用后可按同一命令再次检查。' })
          return this.result(owner, stored.value, 'failed', source.task, { retryable: true })
        }
      }
      update({ phase: ['registered', 'failed'].includes(stored.value.phase) ? 'failed' : 'uncertain', detail: (error instanceof Error ? error.message : '原执行准备结果未确认').slice(0, 2000) })
      return this.result(owner, stored.value, stored.value.phase === 'failed' ? 'failed' : 'uncertain', source.task)
    }
  }

  private async observeOrigin(owner: RequirementExecutionOwner, input: RequirementExecutionPrepare, path: string, initial: Stored, launch = false): Promise<RequirementExecutionPreparation> {
    let stored = initial, source = this.source(owner, launch)
    const wasPrepared = stored.value.phase === 'prepared', current = (): boolean => { try { this.guard(owner); return true } catch { return false } }
    const verify = (): void => {
      source = this.source(owner, launch)
      if (source.identity !== stored.value.taskIdentity || launch && source.revision !== stored.value.sourceRevision) fail('原任务或固定来源身份已变化')
    }
    const update = (patch: Partial<Journal>): void => { stored = this.save(owner, path, { ...stored.value, ...patch }, stored.revision) }
    verify()
    try {
      if (!stored.value.sessionId) {
        const receipt = await this.ports.recoverNewSession(owner.task.root, stored.value.commandId, current)
        verify()
        const reply = receipt.state === 'completed' ? newSessionReply.safeParse(receipt.result) : null
        if (!reply?.success) return this.result(owner, stored.value, 'uncertain', source.task, { existing: true, detail: '原 sessionNew 回执尚无可验证的已完成结果；只查询原命令，不重发' })
        update({ phase: 'session-created', sessionId: reply.data.sessionId })
      }
      const sessionId = stored.value.sessionId
      if (!sessionId) fail('原普通会话身份未确认')
      const session = await this.ports.readSession(owner.task.root, sessionId, current)
      verify()
      if (session.sessionId !== sessionId || session.privateConversation || session.sessionId.startsWith('acp-private-') || !sameRoot(session.projectRoot, owner.task.root) || !sameRoot(session.cwd ?? session.projectRoot, owner.task.root)
        || session.taskDir !== source.task.taskDir || session.agentId !== input.agentId || session.profileSnapshot?.id !== input.profileId || !session.connectionGeneration || stored.value.connectionGeneration && stored.value.connectionGeneration !== session.connectionGeneration) fail('原普通会话的任务、目录、引擎或连接身份未匹配')
      const snapshot = this.ports.snapshot(owner.task.root)
      verify()
      const actual = snapshot.tasks.find(value => value.dirName === source.task.taskDir && value.record?.id === source.task.taskId)
      if (!sameRoot(snapshot.meta.root, owner.task.root) || !actual || canonical(actual.record?.meta?.conversationRequirement) !== canonical(owner.origin)) fail('工程快照没有原始交接任务')
      if (!wasPrepared) {
        if (source.task.status !== 'in_progress' || this.pointer(owner, stored.value) !== `.trellis/tasks/${source.task.taskDir}`) fail('原任务状态或准备指针已变化，未返回可启动的 origin')
        if (session.status !== 'ready' || session.connectionOwned !== true) {
          if (!stored.value.connectionGeneration) update({ connectionGeneration: session.connectionGeneration })
          return this.result(owner, stored.value, ['error', 'closed', 'disconnected', 'legacy'].includes(session.status) ? 'failed' : 'preparing', source.task, { existing: !launch, session, snapshot, detail: '原普通会话尚未确认就绪；保留原 session，不创建替代会话' })
        }
        update({ phase: 'prepared', connectionGeneration: session.connectionGeneration, detail: undefined })
      }
      return this.result(owner, stored.value, 'prepared', source.task, { existing: !launch, session, snapshot, origin: { sessionId, connectionGeneration: session.connectionGeneration } })
    } catch (error) {
      this.guard(owner)
      return this.result(owner, stored.value, 'uncertain', source.task, { existing: !launch, detail: (error instanceof Error ? error.message : '原普通会话读取未确认').slice(0, 2000) })
    }
  }
}

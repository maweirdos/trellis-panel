import { join } from 'node:path'
import { z } from 'zod'
import { requirementExecutionPrepareSchema, type RequirementExecutionPrepare, type RequirementExecutionPreparation } from '../../../shared/conversation-requirement-execution'
import { requirementConfirmedSchema, requirementDesignEvidenceSchema, requirementTaskOriginSchema, requirementTaskSchema, REQUIREMENT_BODY_BYTES, REQUIREMENT_FILE_BYTES, REQUIREMENT_REFERENCES_BYTES, type RequirementTask, type RequirementTaskOrigin, type RequirementPredecessor } from '../../../shared/conversation-requirements'
import type { AcpSessionMeta, ProjectSnapshot } from '../../../shared/types'
import type { IpcFail } from '../../../shared/ipc-errors'
import { canonicalWorkflowJson, runRefSchema, type RunRef } from '../../../shared/workflow'
import { runtimeCall, readRuntimeCommandReceipt } from '../daemon-client/runtime'
import { runTaskStartCli, recoverTaskCliOperation, taskCliReceiptExists, type TaskCliRunResult } from '../local-task/cli-runner'
import { DaemonError } from '../../daemon/errors'
import { scanProject } from '../scan'
import { checkedDirectory, directoryIdentity, hash, pathKey, readRegular } from './files'
import { readOptional, RequirementError, trellisTarget, utf8, writeRevision } from './requirement-files'
import { readExecutionReview } from './requirement-execution-review'
import { requirementKnowledgeSourceSnapshotSchema } from '../../../shared/conversation-requirement-knowledge'
import { assertRequirementHandoffGrants } from './requirement-handoff-grants'
import { preflightReviewedHandoff } from './requirement-handoff-preflight'
import type { RequirementPredecessorReleaseProof } from './requirement-predecessor-release'

/** All fields are captured from the original server-owned handoff, never renderer arguments. */
export interface RequirementExecutionOwner {
  conversationId: string
  creatorId: string
  task: RequirementTask
  origin: RequirementTaskOrigin
  targetIdentity: string
  assertCurrent(): void
  authorizeSources?(): Promise<unknown[]>
  authorizePredecessor?(): Promise<RequirementPredecessorReleaseProof>
  confirmReview?(review: { task: RequirementTask; digest: string; classification: 'lightweight' | 'complex'; agentId: string; profileId?: string; predecessorRun?: RunRef; files: Array<{ path: string; digest: string }> }): Promise<boolean>
}
export interface RequirementExecutionPorts {
  metaDirectory(): string
  validateExecutor(root: string, input: RequirementExecutionPrepare, current: () => boolean): Promise<string>
  startTask(root: string, taskDir: string, commandId: string, contextKey: string): Promise<TaskCliRunResult>
  recoverStart(root: string, commandId: string): Promise<TaskCliRunResult>
  startReceiptExists(root: string, commandId: string): Promise<boolean>
  newSession(root: string, input: { agentId: string; profileId?: string; taskDir: string; predecessor?: RequirementPredecessor; predecessorRun?: RunRef }, commandId: string, current: () => boolean): Promise<{ ok: true; sessionId: string } | IpcFail>
  checkPredecessor(root: string, predecessor: RequirementPredecessor, expectedRun: RunRef | undefined, current: () => boolean): Promise<{ run: RunRef; state: string }>
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
  phase: z.enum(['registered', 'not-admitted', 'starting-task', 'task-started', 'creating-session', 'session-created', 'prepared', 'failed', 'uncertain']),
  reviewDigest: digest.optional(),
  reviewClassification: z.enum(['lightweight', 'complex']).optional(),
  knowledgeDigest: digest.optional(),
  referencesDigest: digest.optional(),
  designDigest: digest.optional(),
  predecessorRun: runRefSchema.optional(),
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
  references: z.array(z.object({ fileId: z.string().min(1).max(256), originalPath: z.string().min(1).max(8192), path: z.string().regex(/^references\/requirement-files\/[0-7](?:\.[A-Za-z0-9_-]{1,32})?$/), revision: digest, bytes: z.number().int().nonnegative().max(REQUIREMENT_FILE_BYTES) })).max(8),
  knowledgeEvidence: z.array(requirementKnowledgeSourceSnapshotSchema).max(128).default([]), designEvidence: z.array(requirementDesignEvidenceSchema).max(16).default([])
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
  checkPredecessor: (root, predecessor, expectedRun, current) => runtimeCall(root, 'runtime.workflow.requirementPredecessor', { predecessor, ...(expectedRun ? { expectedRun } : {}) }, undefined, current),
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
  private readonly reviews = new Map<string, string>()
  constructor(ports: Pick<RequirementExecutionPorts, 'metaDirectory'> & Partial<Omit<RequirementExecutionPorts, 'metaDirectory'>>) { this.ports = { ...defaults, ...ports } }

  private guard(owner: RequirementExecutionOwner): void {
    owner.assertCurrent()
    if (directoryIdentity(owner.task.root) !== owner.targetIdentity) throw new RequirementError('原目标工程物理身份已变化', 'E_DENIED')
  }
  private async guardPredecessor(owner: RequirementExecutionOwner): Promise<void> {
    if (!owner.origin.predecessor) return
    if (!owner.authorizePredecessor) throw new RequirementError('原任务释放证明不可用；未准备或启动后继执行', 'E_BUSY')
    const proof = await owner.authorizePredecessor()
    this.guard(owner)
    if (canonical(proof.predecessor) !== canonical(owner.origin.predecessor)) throw new RequirementError('原任务释放证明身份不一致', 'E_DENIED')
  }
  private source(owner: RequirementExecutionOwner, launch = true): { task: RequirementTask; revision: string; identity: string; knowledge: unknown[]; references: z.infer<typeof manifestSchema>['references']; design: z.infer<typeof manifestSchema>['designEvidence'] } {
    this.guard(owner)
    const root = launch ? trellisTarget(owner.task.root).root : checkedDirectory(owner.task.root), origin = executionOrigin.parse(owner.origin), prefix = `.trellis/tasks/${owner.task.taskDir}`
    const task = z.object({ id: z.string(), title: z.string(), status: z.string(), meta: z.object({ conversationRequirement: requirementTaskOriginSchema }).passthrough() }).passthrough().parse(JSON.parse(utf8(readRegular(root, `${prefix}/task.json`, 512 * 1024).bytes)))
    if (task.id !== owner.task.taskId || canonical(task.meta.conversationRequirement) !== canonical(origin)) throw new RequirementError('任务不是原需求交接身份', 'E_DENIED')
    const read = (path: string, expected: string, limit: number): Buffer => {
      const bytes = readRegular(root, `${prefix}/${path}`, limit).bytes
      if (hash(bytes) !== expected) fail(`原固定材料 ${path} 已变化；未启动任务`)
      return bytes
    }
    const rawManifest: unknown = JSON.parse(utf8(read(origin.manifestPath, origin.manifestRevision, 64 * 1024)))
    assertRequirementHandoffGrants(rawManifest)
    const manifest = manifestSchema.parse(rawManifest)
    if (manifest.conversationId !== owner.conversationId || manifest.creatorId !== owner.creatorId || manifest.draftId !== origin.draftId || manifest.draftRevision !== origin.draftRevision || manifest.bodyRevision !== origin.bodyRevision
      || manifest.confirmed.revision !== origin.confirmedRevision || manifest.confirmed.bodyRevision !== origin.bodyRevision || manifest.confirmed.sourceDigest !== origin.sourceDigest
      || manifest.plan.revision !== origin.planRevision || manifest.plan.bodyRevision !== origin.planBodyRevision || manifest.plan.sourceRevision !== origin.planSourceRevision || manifest.plan.sourceRevision !== origin.confirmedRevision || manifest.plan.sourceDigest !== origin.sourceDigest) throw new RequirementError('固定需求、计划与原交接版本不一致', 'E_DENIED')
    read('references/requirement.md', origin.bodyRevision, REQUIREMENT_BODY_BYTES)
    read('references/plan.md', origin.planBodyRevision, REQUIREMENT_BODY_BYTES)
    if (launch) { read('prd.md', origin.bodyRevision, REQUIREMENT_BODY_BYTES); read('plan.md', origin.planBodyRevision, REQUIREMENT_BODY_BYTES) }
    read('references/requirement-confirmation.json', manifest.confirmed.snapshotRevision, 1024 * 1024)
    let bytes = 0
    for (const reference of manifest.references) { const actual = read(reference.path, reference.revision, REQUIREMENT_FILE_BYTES); bytes += actual.length; if (actual.length !== reference.bytes || bytes > REQUIREMENT_REFERENCES_BYTES) fail('原资料文件大小与固定清单不一致') }
    for (const reference of manifest.designEvidence) { const actual = read(reference.path, reference.revision, REQUIREMENT_FILE_BYTES); bytes += actual.length; if (actual.length !== reference.bytes || bytes > REQUIREMENT_REFERENCES_BYTES) fail('原设计资料大小与固定清单不一致') }
    const script = launch ? hash(readRegular(root, '.trellis/scripts/task.py', 1024 * 1024).bytes) : null
    this.guard(owner)
    return { task: { ...owner.task, root, title: task.title, status: task.status }, revision: hash(canonical([origin, script])), identity: directoryIdentity(join(root, prefix)), knowledge: manifest.knowledgeEvidence, references: manifest.references, design: manifest.designEvidence }
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
    await this.guardPredecessor(owner)
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
    try { return await work }
    catch (error) {
      if (input.planningWrite) throw error
      // A thrown response alone is not absence proof. Only release an original
      // command when the main-owned journal, task pointer and native receipts
      // all show that neither this command nor a retired command was admitted.
      try {
        this.guard(owner)
        const previous = this.load(path)
        if (previous && (previous.value.phase !== 'not-admitted' || previous.value.sessionId || previous.value.commandId === input.commandId)) throw error
        const before = this.source(owner), pending: Journal = { version: 1, commandId: input.commandId, inputDigest, sourceRevision: before.revision, taskIdentity: before.identity, executorRevision: '0'.repeat(64), contextKey: `requirement_execution_${input.commandId.toLowerCase()}`, phase: 'registered' }
        if (before.task.status !== 'planning' || this.pointer(owner, pending) !== null || previous && this.pointer(owner, previous.value) !== null) throw error
        if (await this.ports.startReceiptExists(owner.task.root, input.commandId) || previous && await this.ports.startReceiptExists(owner.task.root, previous.value.commandId)) throw error
        const after = this.source(owner), actual = this.load(path)
        if (actual?.revision !== previous?.revision || after.identity !== before.identity || after.revision !== before.revision || after.task.status !== 'planning' || this.pointer(owner, pending) !== null || previous && this.pointer(owner, previous.value) !== null) throw error
        return this.result(owner, pending, 'not-admitted', after.task, { retryable: true, detail: error instanceof Error ? error.message.slice(0, 2000) : '准备未准入；原命令无副作用。' })
      } catch { this.guard(owner); throw error }
    } finally { if (this.pending.get(key)?.work === work) this.pending.delete(key) }
  }

  private async run(owner: RequirementExecutionOwner, input: RequirementExecutionPrepare, path: string, inputDigest: string): Promise<RequirementExecutionPreparation> {
    const reviewKey = path + ':' + input.commandId + ':' + hash(canonical([input.agentId, input.profileId ?? null]))
    const predecessor = owner.origin.predecessor
    if (predecessor && !sameRoot(predecessor.task.root, owner.task.root)) throw new RequirementError('后继与原任务不属于同一工程', 'E_DENIED')
    let stored = this.load(path)
    if (input.planningWrite) {
      const write = input.planningWrite, before = this.source(owner), review = readExecutionReview(owner.task.root, before.task.taskDir, before.task.taskId, owner.origin)
      if (before.task.status !== 'planning' || !input.reviewDigest || this.reviews.get(reviewKey) !== input.reviewDigest || review.digest !== input.reviewDigest) fail('规划审阅已变化，请重新读取原任务材料')
      if (stored) {
        if (stored.value.phase !== 'not-admitted' || stored.value.sessionId || this.pointer(owner, stored.value) !== null || await this.ports.startReceiptExists(owner.task.root, stored.value.commandId)) fail('原执行准备仍有未核对的副作用，不能修改规划材料')
      }
      const filePath = `.trellis/tasks/${before.task.taskDir}/${write.file}`, previous = readOptional(owner.task.root, filePath, 256 * 1024)
      if ((previous ? hash(previous.bytes) : null) !== write.expectedDigest) fail('实际规划文件已变化；未覆盖原内容')
      const guard = (): void => {
        const actual = this.source(owner), current = this.load(path)
        if (actual.identity !== before.identity || actual.revision !== before.revision || actual.task.status !== 'planning' || current?.revision !== stored?.revision || readExecutionReview(owner.task.root, actual.task.taskDir, actual.task.taskId, owner.origin).digest !== review.digest) fail('保存期间原任务或审阅材料已变化；未继续写入')
      }
      guard()
      writeRevision(owner.task.root, filePath, Buffer.from(write.body, 'utf8'), write.expectedDigest, guard)
      const after = this.source(owner)
      if (after.identity !== before.identity || after.revision !== before.revision || after.task.status !== 'planning') fail('规划文件已保存，但原任务状态需要核对')
      const nextReview = readExecutionReview(owner.task.root, after.task.taskDir, after.task.taskId, owner.origin)
      this.reviews.set(reviewKey, nextReview.digest)
      const pending: Journal = { version: 1, commandId: input.commandId, inputDigest, sourceRevision: after.revision, taskIdentity: after.identity, executorRevision: '0'.repeat(64), contextKey: `requirement_execution_${input.commandId.toLowerCase()}`, phase: 'registered' }
      return this.result(owner, pending, 'review-required', after.task, { review: nextReview, detail: `${write.file} 已保存，请重新审阅全部规划材料。` })
    }
    if (stored?.value.phase === 'registered' && !stored.value.sessionId) {
      const original = stored, before = this.source(owner)
      if (before.identity === original.value.taskIdentity && before.revision === original.value.sourceRevision && before.task.status === 'planning' && this.pointer(owner, original.value) === null) {
        const absent = await this.ports.startReceiptExists(owner.task.root, original.value.commandId) === false
        const after = this.source(owner), currentRecord = this.load(path)
        if (absent && currentRecord?.revision === original.revision && after.identity === original.value.taskIdentity && after.revision === original.value.sourceRevision && after.task.status === 'planning' && this.pointer(owner, original.value) === null) {
          stored = this.save(owner, path, { ...original.value, phase: 'not-admitted', detail: '原准备未越过启动边界且回执不存在；可以更换引擎并重新审阅。' }, original.revision)
        }
      }
    }
    let retired: Stored | null = null
    if (stored?.value.phase === 'not-admitted' && stored.value.commandId !== input.commandId) {
      const original = stored, before = this.source(owner)
      if (before.identity !== original.value.taskIdentity || before.revision !== original.value.sourceRevision || before.task.status !== 'planning' || this.pointer(owner, original.value) !== null) fail('原任务状态或指针已变化，不能更换执行准备命令')
      if (await this.ports.startReceiptExists(owner.task.root, original.value.commandId)) fail('原启动回执已经出现，不能更换执行准备命令')
      const after = this.source(owner), currentRecord = this.load(path)
      if (!currentRecord || currentRecord.revision !== original.revision || after.identity !== original.value.taskIdentity || after.revision !== original.value.sourceRevision || after.task.status !== 'planning' || this.pointer(owner, original.value) !== null) fail('原任务或准备回执已变化，不能更换执行准备命令')
      retired = original; stored = null
    }
    if (stored && (stored.value.commandId !== input.commandId || stored.value.inputDigest !== inputDigest)) fail('原任务已绑定执行准备命令；请查询原命令，不新建会话')
    if (stored?.value.phase === 'not-admitted') return this.result(owner, stored.value, 'not-admitted', this.source(owner).task, { retryable: true })
    if (stored && (stored.value.phase === 'prepared' || stored.value.sessionId || stored.value.phase === 'creating-session' || stored.value.phase === 'uncertain')) return this.observeOrigin(owner, input, path, stored)
    let source = this.source(owner)
    const current = (): boolean => { try { this.guard(owner); return true } catch { return false } }
    let predecessorRun = stored?.value.predecessorRun
    let executor: string
    try { executor = await this.ports.validateExecutor(owner.task.root, input, current) }
    catch (error) {
      if (stored) throw error
      this.guard(owner)
      const actual = this.source(owner), currentRecord = this.load(path)
      if (currentRecord?.revision !== retired?.revision || actual.identity !== source.identity || actual.revision !== source.revision) throw error
      const pending: Journal = { version: 1, commandId: input.commandId, inputDigest, sourceRevision: actual.revision, taskIdentity: actual.identity, executorRevision: '0'.repeat(64), contextKey: `requirement_execution_${input.commandId.toLowerCase()}`, phase: 'registered' }
      return this.result(owner, pending, 'not-admitted', actual.task, { retryable: true, detail: error instanceof Error ? error.message : '执行引擎当前不可核验；未登记准备或启动任务。' })
    }
    source = this.source(owner)
    {
      if (!owner.authorizeSources) throw new RequirementError('知识交接的原始选择和授权无法核实', 'E_DENIED')
      const actual = await owner.authorizeSources()
      this.guard(owner)
      if (canonical(actual) !== canonical(source.knowledge)) throw new RequirementError('授权的知识摘录与固定交接清单不一致', 'E_DENIED')
      source = this.source(owner)
      if (canonical(actual) !== canonical(source.knowledge)) throw new RequirementError('授权期间固定交接清单已变化', 'E_DENIED')
    }
    if (!stored && (!input.reviewDigest || !input.reviewClassification || this.reviews.get(reviewKey) !== input.reviewDigest || input.reviewDigest !== readExecutionReview(owner.task.root, source.task.taskDir, source.task.taskId, owner.origin).digest)) {
      const pending: Journal = { version: 1, commandId: input.commandId, inputDigest, sourceRevision: source.revision, taskIdentity: source.identity, executorRevision: executor, contextKey: `requirement_execution_${input.commandId.toLowerCase()}`, phase: 'registered' }
      const review = readExecutionReview(owner.task.root, source.task.taskDir, source.task.taskId, owner.origin)
      if (!this.reviews.has(reviewKey) && this.reviews.size >= 64) {
        const oldest = this.reviews.keys().next().value
        if (oldest) this.reviews.delete(oldest)
      }
      this.reviews.delete(reviewKey); this.reviews.set(reviewKey, review.digest)
      return this.result(owner, pending, 'review-required', source.task, { review })
    }
    if (!stored && input.reviewClassification === 'complex') {
      const review = readExecutionReview(owner.task.root, source.task.taskDir, source.task.taskId, owner.origin)
      for (const name of ['design.md', 'implement.md']) if (!review.files.some(file => file.path === `.trellis/tasks/${source.task.taskDir}/${name}` && file.text.trim())) throw new RequirementError(`复杂任务缺少 ${name}；请先完成规划材料并重新审阅`)
    }
    if (!stored) {
      const review = readExecutionReview(owner.task.root, source.task.taskDir, source.task.taskId, owner.origin)
      if (!input.reviewClassification || review.digest !== input.reviewDigest || !owner.confirmReview) throw new RequirementError('原生规划审阅确认不可用或材料已变化；未激活任务', 'E_DENIED')
      const budget = await preflightReviewedHandoff(owner.task.root, source.task.taskDir, source.task.taskId, review, () => this.guard(owner))
      if (budget.promptBytes > budget.budgetBytes) {
        const pending: Journal = { version: 1, commandId: input.commandId, inputDigest, sourceRevision: source.revision, taskIdentity: source.identity, executorRevision: executor, contextKey: `requirement_execution_${input.commandId.toLowerCase()}`, phase: 'registered' }
        return this.result(owner, pending, 'not-admitted', source.task, { retryable: true, detail: '实际规划材料和所选资料超过完整上下文预算；未登记准备或启动任务，请调整材料后重新审阅。' })
      }
      if (predecessor) predecessorRun = runRefSchema.parse((await this.ports.checkPredecessor(owner.task.root, predecessor, undefined, current)).run)
      const accepted = await owner.confirmReview({ task: source.task, digest: review.digest, classification: input.reviewClassification, agentId: input.agentId, profileId: input.profileId, predecessorRun, files: review.files.map(({ path: filePath, digest: revision }) => ({ path: filePath, digest: revision })) })
      this.guard(owner)
      const actual = this.source(owner), currentRecord = this.load(path)
      if (currentRecord?.revision !== retired?.revision || actual.identity !== source.identity || actual.revision !== source.revision || readExecutionReview(owner.task.root, actual.task.taskDir, actual.task.taskId, owner.origin).digest !== review.digest) throw new RequirementError('规划审阅期间任务或材料已变化；未激活任务')
      if (!accepted) {
        this.reviews.delete(reviewKey)
        const pending: Journal = { version: 1, commandId: input.commandId, inputDigest, sourceRevision: actual.revision, taskIdentity: actual.identity, executorRevision: executor, contextKey: `requirement_execution_${input.commandId.toLowerCase()}`, phase: 'registered' }
        return this.result(owner, pending, 'not-admitted', actual.task, { retryable: true, detail: '已取消规划审阅确认；未登记准备或启动任务。' })
      }
      if (predecessor && predecessorRun) await this.ports.checkPredecessor(owner.task.root, predecessor, predecessorRun, current)
      {
        if (!owner.authorizeSources) fail('原交接资料授权不可用')
        const authorized = await owner.authorizeSources()
        const latest = this.source(owner), current = this.load(path)
        if (canonical(authorized) !== canonical(latest.knowledge) || current?.revision !== retired?.revision || latest.identity !== actual.identity || latest.revision !== actual.revision || readExecutionReview(owner.task.root, latest.task.taskDir, latest.task.taskId, owner.origin).digest !== review.digest) fail('规划确认期间交接授权或材料已变化；未激活任务')
      }
      if (retired) {
        if (await this.ports.startReceiptExists(owner.task.root, retired.value.commandId)) fail('原启动回执已经出现，不能更换执行准备命令')
        const latest = this.source(owner), original = this.load(path)
        if (!original || original.revision !== retired.revision || latest.identity !== retired.value.taskIdentity || latest.revision !== retired.value.sourceRevision || latest.task.status !== 'planning' || this.pointer(owner, retired.value) !== null) fail('原任务或准备回执已变化，不能更换执行准备命令')
      }
    }
    if (!stored) {
      if (retired) {
        const historyPath = `${path.slice(0, -5)}-history/${retired.value.commandId}.json`, old = this.load(historyPath)
        if (old && canonical(old.value) !== canonical(retired.value)) fail('原未准入回执归档冲突；未替换原命令')
        if (!old) this.save(owner, historyPath, retired.value, null)
      }
      stored = this.save(owner, path, { version: 1, commandId: input.commandId, inputDigest, sourceRevision: source.revision, taskIdentity: source.identity, executorRevision: executor, contextKey: `requirement_execution_${input.commandId.toLowerCase()}`, phase: 'registered', reviewDigest: input.reviewDigest, reviewClassification: input.reviewClassification, knowledgeDigest: hash(canonical(source.knowledge)), referencesDigest: hash(canonical(source.references)), designDigest: hash(canonical(source.design)), ...(predecessorRun ? { predecessorRun } : {}) }, retired?.revision ?? null)
    }
    this.reviews.delete(reviewKey)
    const update = (patch: Partial<Journal>): void => { const previous = stored; if (!previous) fail('原执行准备记录不可用'); stored = this.save(owner, path, { ...previous.value, ...patch }, previous.revision) }
    const verify = (): ReturnType<RequirementExecutionService['source']> => {
      const actual = this.source(owner)
      if (!stored || actual.identity !== stored.value.taskIdentity || actual.revision !== stored.value.sourceRevision || executor !== stored.value.executorRevision) fail('原任务、固定材料或执行引擎已变化；保留原命令')
      if (!stored.value.reviewDigest || readExecutionReview(owner.task.root, actual.task.taskDir, actual.task.taskId, owner.origin).digest !== stored.value.reviewDigest) fail('规划审阅回执缺失或材料已变化；未继续执行')
      return actual
    }
    let startNotAdmitted = false
    try {
      source = verify()
      if (predecessor) {
        if (!stored.value.predecessorRun) fail('原后继准备没有固定的原运行身份')
        await this.ports.checkPredecessor(owner.task.root, predecessor, stored.value.predecessorRun, current)
        source = verify()
      }
      if (stored.value.phase === 'failed') return this.result(owner, stored.value, 'failed', source.task)
      if (stored.value.phase === 'registered') {
        const pointer = this.pointer(owner, stored.value), target = `.trellis/tasks/${source.task.taskDir}`
        if (pointer && pointer !== target) fail('原激活上下文属于其他任务，未夺取指针')
        if (source.task.status === 'in_progress') {
          if (pointer !== target) fail('任务已开始但缺少原准备指针；未重复启动或夺取指针')
          update({ phase: 'starting-task' })
          const receipt = await this.ports.recoverStart(owner.task.root, input.commandId)
          source = verify()
          if (receipt.operationId !== input.commandId || receipt.code !== 0 || receipt.aborted || receipt.failedToStart || !receipt.cleanupConfirmed || source.task.status !== 'in_progress' || this.pointer(owner, stored.value) !== target) fail('原任务激活回执未确认，未建立会话')
          update({ phase: 'task-started' })
        } else {
          if (source.task.status !== 'planning') fail('原任务当前不能激活')
          await this.guardPredecessor(owner)
          source = verify()
          if (source.task.status !== 'planning' || this.pointer(owner, stored.value) !== null) fail('后继任务在原任务释放复核期间发生变化')
          update({ phase: 'starting-task' })
          const result = await this.ports.startTask(owner.task.root, source.task.taskDir, input.commandId, stored.value.contextKey).catch(error => {
            startNotAdmitted = error instanceof DaemonError && error.code === 'E_CONFLICT' && error.outcome === 'not-admitted'
            throw error
          })
          source = verify()
          if (result.operationId !== input.commandId || result.code !== 0 || result.aborted || result.failedToStart || !result.cleanupConfirmed || source.task.status !== 'in_progress' || this.pointer(owner, stored.value) !== target) fail('原任务激活回执未确认，未建立会话')
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
        await this.guardPredecessor(owner)
        source = verify()
        if (source.task.status !== 'in_progress' || this.pointer(owner, stored.value) !== `.trellis/tasks/${source.task.taskDir}`) fail('后继任务在原任务释放复核期间发生变化')
        update({ phase: 'creating-session' })
        const created = await this.ports.newSession(owner.task.root, { agentId: input.agentId, profileId: input.profileId, taskDir: source.task.taskDir, ...(predecessor ? { predecessor, predecessorRun: stored.value.predecessorRun } : {}) }, input.commandId, current)
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
          update({ phase: 'not-admitted', detail: '工作副本冲突明确未准入，原启动回执不存在；可以更换引擎并重新审阅。' })
          return this.result(owner, stored.value, 'not-admitted', source.task, { retryable: true })
        }
      }
      // Keep the actual side-effect boundary so a later observation queries the
      // matching task.py or sessionNew receipt, never the other operation.
      const phase = stored.value.phase
      update({ phase: phase === 'registered' ? 'failed' : phase, detail: (error instanceof Error ? error.message : '原执行准备结果未确认').slice(0, 2000) })
      return this.result(owner, stored.value, stored.value.phase === 'failed' ? 'failed' : 'uncertain', source.task)
    }
  }

  private async observeOrigin(owner: RequirementExecutionOwner, input: RequirementExecutionPrepare, path: string, initial: Stored, launch = false): Promise<RequirementExecutionPreparation> {
    let stored = initial, source = this.source(owner, launch)
    const wasPrepared = stored.value.phase === 'prepared', current = (): boolean => { try { this.guard(owner); return true } catch { return false } }
    const verify = (): void => {
      source = this.source(owner, launch)
      if (source.identity !== stored.value.taskIdentity || launch && source.revision !== stored.value.sourceRevision) fail('原任务或固定来源身份已变化')
      if (!stored.value.reviewDigest || readExecutionReview(owner.task.root, source.task.taskDir, source.task.taskId, owner.origin).digest !== stored.value.reviewDigest) fail('原规划审阅缺失或材料已变化，请重新核对')
    }
    const update = (patch: Partial<Journal>): void => { stored = this.save(owner, path, { ...stored.value, ...patch }, stored.revision) }
    verify()
    try {
      if (owner.origin.predecessor) {
        if (!stored.value.predecessorRun) fail('原后继准备没有固定的原运行身份')
        await this.ports.checkPredecessor(owner.task.root, owner.origin.predecessor, stored.value.predecessorRun, current)
        verify()
      }
      {
        if (!owner.authorizeSources) fail('知识交接的原始选择和授权无法核实')
        const authorized = await owner.authorizeSources()
        verify()
        if (canonical(authorized) !== canonical(source.knowledge) || hash(canonical(authorized)) !== stored.value.knowledgeDigest || hash(canonical(source.references)) !== stored.value.referencesDigest || hash(canonical(source.design)) !== stored.value.designDigest) fail('授权的交接资料与原准备回执不一致')
      }
      if (!stored.value.sessionId) {
        if (stored.value.phase === 'uncertain') return this.result(owner, stored.value, 'uncertain', source.task, { existing: true, detail: '旧准备记录未保留发生不确定结果的阶段；请核对原 task.py 和 sessionNew 回执，不能自动重发' })
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

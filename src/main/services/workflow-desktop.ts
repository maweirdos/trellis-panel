/** Desktop composition only; durable decisions and execution belong to the application. */
import { createHash } from 'node:crypto'
import { assertRuntimeExecutionHost } from './runtime-host'
import { realpath, lstat } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { canonicalWorkflowJson, legacyFlowSchema, workflowDefinitionSchema, type ExecutorBinding, type WorkflowDefinition, type VersionedAssetRef } from '../../shared/workflow'
import type { AcpSessionMeta, FlowDef } from '../../shared/types'
import type { WorkflowOrigin } from '../../shared/workflow-application'
import { listAcpAgents, listAcpProfiles, listAcpSessions, listOwnedAcpSessionFacts, getAcpHistorySession, type OwnedAcpSessionFacts } from './acp'
import { runtimeDefinitions } from './acp/setup'
import { createFacadeWorkflowAcpPort } from './workflow-runtime'
import { WorkflowApplicationService, WorkflowApplicationError, readLocalApplicationDefinition, type ApplicationNodePolicy, type VerifiedApplicationExecutor } from './workflow-application'
import { listFlows } from './flow'
import { readDocument } from './documents'
import { getDocumentViews, readerMaterialOwner } from './document-views'
import { canonicalWorkspaceRoot, executionWorkspaceRoot, claimWorkspaceAdmission, waitForWorkspaceAdmissions, workspaceProjects, registerWorkspaceProject, WorkflowAdmissionError, type NativeAdmissionOwner } from './workflow-admission'
import type { WorkflowStartInput } from '../../shared/workflow-application'

const hash = (value: unknown): string => createHash('sha256').update(canonicalWorkflowJson(JSON.parse(JSON.stringify(value)))).digest('hex')
const asset = (assetId: string, value: unknown): VersionedAssetRef => {
  const digest = hash(value)
  return { assetId, version: digest, digest }
}
const services = new Map<string, Promise<WorkflowApplicationService>>()
let admissionClosed = false
export const TRELLIS_MANAGED_FLOW = 'trellis-managed-v1'

const stages = [
  { id: 'prd', label: '需求梳理', phase: 'plan', file: 'prd.md', kind: 'trellis-prd', instruction: '依据已确认的产品需求和当前任务材料，使用项目 Trellis 规范审查并完善本任务 prd.md。区分已确认要求与待澄清问题；不得编造产品确认。' },
  { id: 'design', label: '技术设计', phase: 'plan', file: 'design.md', kind: 'design', instruction: '依据当前已固定的 PRD 和工程规范，编写本任务 design.md，明确接口、数据流、兼容与验证策略。保留真正未决事项及其影响，不得视超时为同意。' },
  { id: 'implement', label: '开发实现', phase: 'implement', file: 'implementation.md', kind: 'other', instruction: '仅在本任务已按项目 Trellis 规则获准实施时，依据 PRD、design 和适用规范进行实际代码开发，并写 implementation.md 记录实际修改路径、行为及未完成事项。若没有实施授权，停止开发并明确记录待确认原因；不得用实施报告代替代码。' },
  { id: 'check', label: '开发自检', phase: 'check', file: 'test-report.md', kind: 'other', instruction: '对本任务实际变更执行适用的检查，修复发现的问题，写 test-report.md 记录实际命令、结果与未运行项。不要伪造测试、产品确认或 QA 通过，不要自动归档或更改 Jira 状态。' }
] as const

function currentOrigin(root: string, origin: WorkflowOrigin): AcpSessionMeta {
  const result = listAcpSessions(root, 200)
  const session = result.ok ? result.sessions.find((item) => item.sessionId === origin.sessionId) : undefined
  if (!session || session.connectionGeneration !== origin.connectionGeneration || session.status !== 'ready') throw new WorkflowApplicationError('SCOPE_CHANGED', '请使用当前项目中已就绪的会话预览工作流')
  return session
}

async function verifiedExecutor(root: string, origin: WorkflowOrigin): Promise<{ executor: VerifiedApplicationExecutor; assertCurrent: () => void; assertExecutionCurrent: () => void }> {
  const session = currentOrigin(root, origin)
  if (executionWorkspaceRoot(root, session.cwd) !== executionWorkspaceRoot(root)) throw new WorkflowApplicationError('SCOPE_CHANGED', '当前岗位的执行目录属于其他 worktree，请先切换到该工作区再运行托管任务')
  const runtime = runtimeDefinitions().find((item) => item.id === session.agentId)
  if (!runtime || !session.runtimeSnapshot || hash(runtime) !== hash(session.runtimeSnapshot)) throw new WorkflowApplicationError('MATERIAL_CHANGED', '会话的执行端配置已改变，请使用按当前配置创建的会话')
  const profiles = listAcpProfiles(root)
  const profile = session.profileSnapshot
  if (profile && (!profiles.ok || !profiles.profiles.some((item) => item.id === profile.id && hash(item) === hash(profile)))) throw new WorkflowApplicationError('MATERIAL_CHANGED', '岗位配置已改变，请先创建使用该版本的会话')
  const status = (await listAcpAgents()).agents.find((item) => item.id === session.agentId)
  if (!status?.available || !status.adapterVersion) throw new WorkflowApplicationError('CAPABILITY_UNAVAILABLE', '执行端或适配器版本尚未核实，请先完成运行环境设置')
  const configuration = asset(`desktop-executor:${session.agentId}`, { runtime, profile: profile ?? null,
    nativeSessionConfiguration: { source: 'workflow-native-session', initialConfiguration: 'native-defaults', reuse: 'same-task-pinned-executor-session', originTransientOptionsInherited: false, effectiveValues: 'unobserved-until-stage-readiness' } })
  const binding: ExecutorBinding = {
    bindingId: `desktop-executor:${configuration.digest}`, engineId: session.agentId,
    engineVersion: 'unknown', adapterVersion: status.adapterVersion, configuration,
    capabilities: {
      'acp.prompt': { status: 'supported', evidenceRef: `acp-ready:${session.sessionId}:${session.connectionGeneration}` },
      'native.children': { status: 'unknown', reason: '原生引擎未提供可核验的内部子代理记录' },
      'native.hook-injection': { status: 'unknown', reason: '任务指针绑定不等于已观察到原生 Hook 注入' }
    }
  }
  const assertExecutionCurrent = (): void => {
    const now = runtimeDefinitions().find((item) => item.id === session.agentId)
    const nowProfiles = listAcpProfiles(root)
    if (!now || hash(now) !== hash(runtime) || (profile && (!nowProfiles.ok || !nowProfiles.profiles.some((item) => item.id === profile.id && hash(item) === hash(profile))))) throw new WorkflowApplicationError('MATERIAL_CHANGED', '执行端配置与预览版本不一致，请重新预览')
  }
  const assertCurrent = (): void => { currentOrigin(root, origin); assertExecutionCurrent() }
  return { executor: { binding, agentId: session.agentId, ...(profile ? { profileId: profile.id } : {}) }, assertCurrent, assertExecutionCurrent }
}

function builtIn(rootTask: string, executor: VerifiedApplicationExecutor): { definition: WorkflowDefinition; nodes: Record<string, ApplicationNodePolicy> } {
  const flow: FlowDef = {
    version: 1, id: TRELLIS_MANAGED_FLOW, name: 'Trellis 任务开发', description: '需求、设计、开发与自检；产物核验不代替产品或测试验收。', inputs: [],
    phases: stages.map((stage) => ({ id: stage.id, name: stage.label, steps: [{ id: stage.id, name: stage.label, kind: 'agent', instruction: `${stage.instruction}\n任务目录：.trellis/tasks/${rootTask}\n产物写入该任务目录的 ${stage.file}。遵循项目原有任务权限与工作流；不要修改其他任务。` }] }))
  }
  const nodes: Record<string, ApplicationNodePolicy> = {}
  for (const stage of stages) {
    const file = { relativePath: `.trellis/tasks/${rootTask}/${stage.file}`, kind: stage.kind, required: true }
    nodes[stage.id] = { agentId: executor.agentId, profileId: executor.profileId, output: { contract: asset(`trellis-artifact:${stage.id}`, { files: [file], verification: 'nonempty-artifact-only' }), files: [file], maxRepairTurns: 1, validateMaterial: (material) => ({ ok: material.text.trim().length > 0, reason: '阶段产物为空' }) }, ...(['codex', 'claude'].includes(executor.agentId) ? { nativeTask: { platform: executor.agentId as 'codex' | 'claude', allowBinding: true } } : {}) }
  }
  return { definition: workflowDefinitionSchema.parse({ contractVersion: 1, ref: { definitionId: `${TRELLIS_MANAGED_FLOW}:${hash(flow)}`, revision: 1 }, flow, defaultExecutor: executor.binding, nodeBindings: [], trellisPhases: Object.fromEntries(stages.map((stage) => [stage.id, stage.phase])) }), nodes }
}

const localOutputSchema = z.object({ files: z.array(z.object({ path: z.string().min(1).max(2048), kind: z.enum(['product-requirement', 'trellis-prd', 'design', 'spec', 'code', 'feedback', 'other']), required: z.boolean().default(true) }).strict()).min(1).max(16), maxRepairTurns: z.number().int().min(0).max(3).default(1) }).strict()

export function workflowDesktopTemplates(root: string): Array<{ id: string; name: string; description: string }> {
  return [{ id: TRELLIS_MANAGED_FLOW, name: 'Trellis 任务开发', description: 'PRD → 设计 → 开发 → 自检（产物核验）' }, ...listFlows(root).filter((item) => item.id !== TRELLIS_MANAGED_FLOW).map(({ id, name, description }) => ({ id, name, description }))]
}

export async function getWorkflowApplication(root: string): Promise<WorkflowApplicationService> {
  assertRuntimeExecutionHost()
  const canonical = await realpath(root)
  const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical
  const existing = services.get(key)
  if (existing) return existing
  if (admissionClosed) throw new WorkflowApplicationError('STORE_DEGRADED', '应用正在退出，暂不接纳新的工作流')
  const pending = WorkflowApplicationService.create({
    projectRoot: canonical, acp: createFacadeWorkflowAcpPort({ isCurrent: () => !admissionClosed }),
    resolveDefinition: async ({ flowId, origin, taskDir }) => {
      const { executor, assertCurrent, assertExecutionCurrent } = await verifiedExecutor(canonical, origin)
      if (flowId === TRELLIS_MANAGED_FLOW) {
        const task = await readDocument(canonical, { workspaceId: canonical, taskRef: taskDir }, { relativePath: `.trellis/tasks/${taskDir}/task.json`, requestId: 'workflow-task-authorization' })
        if (!task.ok || !task.rawText || JSON.parse(task.rawText).status !== 'in_progress') throw new WorkflowApplicationError('CAPABILITY_UNAVAILABLE', '此模板包含实际代码开发；请先按项目规则确认并激活该 Trellis 任务')
        return { ...builtIn(taskDir, executor), assertCurrent, assertExecutionCurrent }
      }
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(flowId)) throw new WorkflowApplicationError('INVALID_INPUT', '工作流标识无效')
      const read = await readDocument(canonical, { workspaceId: canonical }, { relativePath: `.trellis/flows/${flowId}.flow.json`, requestId: 'workflow-source-policy' })
      if (!read.ok || !read.rawText) throw new WorkflowApplicationError('NOT_FOUND', '选定的本地工作流不可读')
      const source = legacyFlowSchema.parse(JSON.parse(read.rawText))
      const nodes: Parameters<typeof readLocalApplicationDefinition>[0]['nodes'] = {}
      for (const phase of source.phases) for (const step of phase.steps) {
        if (step.kind !== 'agent') continue
        const output = localOutputSchema.safeParse((step as unknown as Record<string, unknown>).workflowOutput)
        if (!output.success) throw new WorkflowApplicationError('CAPABILITY_UNAVAILABLE', `步骤 ${step.name} 未配置可核验的 workflowOutput 产物契约`)
        const files = output.data.files.map(({ path, kind, required }) => ({ relativePath: path.replaceAll('{{taskDir}}', taskDir), kind, required }))
        if (files.some((file) => file.relativePath.replaceAll('\\', '/').startsWith('.trellis/tasks/') && !file.relativePath.replaceAll('\\', '/').startsWith(`.trellis/tasks/${taskDir}/`))) throw new WorkflowApplicationError('SCOPE_CHANGED', '阶段产物不能写入其他 Trellis 任务的目录')
        nodes[step.id] = { output: { contract: asset(`local-flow-output:${flowId}:${step.id}`, { files, maxRepairTurns: output.data.maxRepairTurns }), files, maxRepairTurns: output.data.maxRepairTurns } }
      }
      const resolved = await readLocalApplicationDefinition({ projectRoot: canonical, flowId, executor, nodes, assertExecutor: assertExecutionCurrent })
      if (hash(resolved.definition.flow) !== hash(source)) throw new WorkflowApplicationError('MATERIAL_CHANGED', '工作流产物配置在读取期间已改变，请重新预览')
      return resolved
    }
  })
  services.set(key, pending)
  void pending.catch(() => { if (services.get(key) === pending) services.delete(key) })
  getDocumentViews()?.setAdapters({ resolveOwner: async (sourceRoot, path) => {
    const canonicalSource = await realpath(sourceRoot)
    const sourceKey = process.platform === 'win32' ? canonicalSource.toLowerCase() : canonicalSource
    const application = services.get(sourceKey)
    return application ? (await application).resolveMaterialOwner(path) : readerMaterialOwner(sourceRoot, path)
  } })
  return pending
}

export function setWorkflowAdmissionClosed(closed: boolean): void { admissionClosed = closed }
export function isWorkflowAdmissionClosed(): boolean { return admissionClosed }

async function existingApplication(root: string): Promise<WorkflowApplicationService | null> {
  const canonical = await realpath(root)
  const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical
  const existing = services.get(key)
  if (existing) return existing
  try { await lstat(join(canonical, '.trellis', '.panel', 'runtime', 'workflow-local-identity.json')) }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null; throw error }
  return getWorkflowApplication(canonical)
}
const samePhysicalWorkspace = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
function ownedNativeBusy(session: OwnedAcpSessionFacts): boolean {
  return !['ready', 'closed'].includes(session.status) || session.accepting || session.closing
    || session.disconnected || session.leaseHeld || session.cleanupRequired || session.backgroundWork
    || session.unfinishedTools || session.turnActive || session.settling || session.pendingPermission
}
function nativeBusy(sessionId: string, generation?: string): boolean {
  try {
    const session = listOwnedAcpSessionFacts().find((entry) => entry.sessionId === sessionId)
    // Absence from the actual owned map confirms this facade released ownership;
    // historical rows cannot recreate a blocker or claim a still-live row idle.
    return session ? (!generation || !session.connectionGeneration || session.connectionGeneration === generation) && ownedNativeBusy(session) : false
  } catch { return true }
}
/** A disconnected presentation is still fenced, but must not fence its own
 * explicit recovery after all admitted execution/cleanup has actually settled. */
function canRecoverNative(root: string, workspace: string, owner: NativeAdmissionOwner | undefined, requested: NativeAdmissionOwner): boolean {
  if (!owner || owner.sessionId !== requested.sessionId || owner.connectionGeneration !== requested.connectionGeneration) return false
  const facts = listOwnedAcpSessionFacts()
  const session = facts.find((entry) => entry.sessionId === owner.sessionId)
  if (!session || session.connectionGeneration !== owner.connectionGeneration
    || !samePhysicalWorkspace(canonicalWorkspaceRoot(session.projectRoot), canonicalWorkspaceRoot(root))
    || !samePhysicalWorkspace(executionWorkspaceRoot(session.projectRoot, session.cwd ?? undefined), workspace)
    || !['error', 'disconnected'].includes(session.status)
    || session.accepting || session.closing || session.leaseHeld || session.cleanupRequired
    || session.backgroundWork || session.unfinishedTools || session.turnActive || session.settling || session.pendingPermission) return false
  // Other conversations in the same project own independent admissions. A
  // foreign project sharing the physical workspace still fences recovery.
  return !facts.some((entry) => entry.sessionId !== owner.sessionId && ownedNativeBusy(entry)
    && !samePhysicalWorkspace(canonicalWorkspaceRoot(entry.projectRoot), canonicalWorkspaceRoot(root))
    && samePhysicalWorkspace(executionWorkspaceRoot(entry.projectRoot, entry.cwd ?? undefined), workspace))
}
async function assertNoManagedOwner(sourceRoot: string, workspace: string, duplicate?: WorkflowStartInput): Promise<void> {
  const persisted = await workspaceProjects(workspace)
  const persistedKeys = new Set(persisted.map((entry) => {
    try { const canonical = canonicalWorkspaceRoot(entry); return process.platform === 'win32' ? canonical.toLowerCase() : canonical }
    catch { throw new WorkflowAdmissionError('已登记项目的实际目录无法核实，不能宣称工作区空闲') }
  }))
  const candidates = new Set([sourceRoot, workspace, ...services.keys(), ...persisted])
  const seen = new Set<string>()
  for (const candidate of candidates) {
    let canonical: string
    try { canonical = canonicalWorkspaceRoot(candidate) }
    catch (error) {
      if (!persisted.includes(candidate) && error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue
      throw new WorkflowAdmissionError('已登记项目的实际目录无法核实，不能宣称工作区空闲')
    }
    const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical
    const registered = persistedKeys.has(key)
    if (seen.has(key)) continue
    if (!samePhysicalWorkspace(executionWorkspaceRoot(canonical), workspace)) {
      if (registered) throw new WorkflowAdmissionError('已登记项目的物理工作区归属改变，请先核对')
      continue
    }
    seen.add(key)
    const application = await existingApplication(canonical)
    if (!application) {
      if (registered) throw new WorkflowAdmissionError('已登记项目的控制身份记录缺失，不能将工作区视为空闲')
      continue
    }
    const { projectId, repositoryId, workspaceId } = application.identity
    const owner = await application.control.workspaceOwner({ projectId, repositoryId, workspaceId })
    if (owner && (owner.state !== 'released' || owner.recoveryRequired)) {
      if (duplicate && samePhysicalWorkspace(canonicalWorkspaceRoot(sourceRoot), canonicalWorkspaceRoot(application.projectRoot))) {
        const command = await application.control.getCommand(owner.scope, duplicate.commandId)
        const payload = command?.command.payload
        if (command?.status === 'committed' && command.command.kind === 'start' && payload && typeof payload === 'object' && !Array.isArray(payload) && payload.previewId === duplicate.previewId && payload.taskDir === duplicate.taskDir) continue
      }
      throw new WorkflowAdmissionError('此工作区仍由托管任务占用或等待核对，请先停止并确认原任务；其他会话暂不能发送修改指令')
    }
  }
}
async function committedStart(root: string, input: WorkflowStartInput): Promise<boolean> {
  const application = await existingApplication(root)
  if (!application) return false
  const owner = await application.resolveMaterialOwner(`.trellis/tasks/${input.taskDir}/task.json`)
  if (!owner.taskRef) return false
  const command = await application.control.getCommand({ ...owner, taskRef: owner.taskRef }, input.commandId)
  const payload = command?.command.payload
  return Boolean(command?.status === 'committed' && command.command.kind === 'start' && payload && typeof payload === 'object' && !Array.isArray(payload) && payload.previewId === input.previewId && payload.taskDir === input.taskDir)
}
/** Ordinary IPC only. The private managed driver uses its admitted control owner. */
export async function withOrdinaryWorkflowAdmission<T extends { ok: boolean }>(root: string, sessionId: string, generation: string | undefined, action: (isCurrent: () => boolean) => Promise<T>): Promise<T> {
  if (admissionClosed) throw new WorkflowAdmissionError('应用正在退出，暂不接纳新的原生指令')
  const result = listAcpSessions(root, 100)
  const session = result.ok ? result.sessions.find((entry) => entry.sessionId === sessionId) : undefined
  if (!session || (generation && session.connectionGeneration !== generation)) throw new WorkflowAdmissionError('会话或连接已改变，请重新核对发送目标')
  const workspace = executionWorkspaceRoot(root, session.cwd)
  await assertNoManagedOwner(root, workspace)
  if (admissionClosed) throw new WorkflowAdmissionError('应用正在退出，原生指令尚未接纳')
  const owner = session.connectionGeneration ? { sessionId, connectionGeneration: session.connectionGeneration } : undefined
  const admission = claimWorkspaceAdmission(workspace, 'ordinary', undefined, { projectRoot: root, owner })
  const occupied = (): boolean => nativeBusy(sessionId, owner?.connectionGeneration)
  const recover = (requested: NativeAdmissionOwner): boolean => canRecoverNative(root, workspace, owner, requested)
  let retained = false
  try {
    // The first async result may precede a competing managed commit. Read again
    // under the synchronous admission token before entering any native preflight.
    await assertNoManagedOwner(root, workspace)
    const value = await action(() => !admissionClosed && admission.isCurrent())
    if (value.ok || occupied()) { admission.retainNative(occupied, recover); retained = true }
    return value
  } finally {
    if (!retained) {
      if (occupied()) admission.retainNative(occupied, recover)
      else admission.release()
    }
  }
}
/** Native connection/control admission uses the same workspace token as prompts.
 * The private managed driver calls its facade port directly under its owner.
 */
export async function withOrdinaryConnectionAdmission<T extends { ok: boolean }>(root: string, target: { sessionId?: string; profileId?: string }, action: () => Promise<T>): Promise<T> {
  if (admissionClosed) throw new WorkflowAdmissionError('应用正在退出，暂不接纳新的原生连接')
  let cwd: string | undefined
  if (target.sessionId) {
    const result = await getAcpHistorySession(root, target.sessionId)
    if (!result.ok) throw new WorkflowAdmissionError('原生会话的工作区无法核实，请重新选择会话')
    cwd = result.session.cwd
  } else if (target.profileId) {
    const profiles = listAcpProfiles(root)
    if (!profiles.ok) throw new WorkflowAdmissionError('原生配置的工作目录无法核实')
    const profile = profiles.profiles.find((entry) => entry.id === target.profileId)
    if (!profile) throw new WorkflowAdmissionError('原生配置已改变，请重新选择')
    cwd = profile.cwd
  }
  const workspace = executionWorkspaceRoot(root, cwd)
  await assertNoManagedOwner(root, workspace)
  if (admissionClosed) throw new WorkflowAdmissionError('应用正在退出，原生连接尚未接纳')
  let owner: NativeAdmissionOwner | undefined
  let recovery: NativeAdmissionOwner | undefined
  if (target.sessionId) {
    const session = listOwnedAcpSessionFacts().find((entry) => entry.sessionId === target.sessionId)
    if (session?.connectionGeneration) {
      owner = { sessionId: session.sessionId, connectionGeneration: session.connectionGeneration }
      if (['error', 'disconnected'].includes(session.status)) recovery = owner
    }
  }
  const admission = claimWorkspaceAdmission(workspace, 'ordinary', recovery, { projectRoot: root, owner })
  let pending = true
  let recoveryOwner: { root: string; identity: NativeAdmissionOwner } | undefined
  let occupiedSessionId = target.sessionId
  // A rejected targetless operation can retain a pre-existing sole blocker.
  // Snapshot it before action; a concurrently created conversation is not ours.
  let priorBlocker: OwnedAcpSessionFacts | undefined
  if (!target.sessionId) {
    try {
      const blockers = listOwnedAcpSessionFacts().filter((session) => ownedNativeBusy(session)
        && samePhysicalWorkspace(executionWorkspaceRoot(session.projectRoot, session.cwd ?? undefined), workspace))
      if (blockers.length === 1) priorBlocker = blockers[0]
    } catch { /* Unknown inventory remains fenced by occupied(). */ }
  }
  let inventoryUnknown = false
  const occupied = (): boolean => {
    if (pending) return true
    if (inventoryUnknown) return true
    try {
      return occupiedSessionId ? nativeBusy(occupiedSessionId, recoveryOwner?.identity.connectionGeneration) : false
    } catch { return true }
  }
  const recover = (requested: NativeAdmissionOwner): boolean => !pending && !!recoveryOwner && canRecoverNative(recoveryOwner.root, workspace, recoveryOwner.identity, requested)
  try {
    await assertNoManagedOwner(root, workspace)
    if (target.sessionId) {
      const current = await getAcpHistorySession(root, target.sessionId)
      if (!current.ok || !samePhysicalWorkspace(executionWorkspaceRoot(root, current.session.cwd), workspace)) throw new WorkflowAdmissionError('原生会话的工作目录已改变，请重新接纳连接')
      if (owner) {
        const live = listOwnedAcpSessionFacts().find((entry) => entry.sessionId === owner.sessionId)
        if (!live || live.connectionGeneration !== owner.connectionGeneration) throw new WorkflowAdmissionError('原生会话的连接已改变，请重新接纳连接')
      }
    } else if (target.profileId) {
      // Synchronous final read, directly before action captures the same profile.
      const profiles = listAcpProfiles(root)
      const profile = profiles.ok ? profiles.profiles.find((entry) => entry.id === target.profileId) : undefined
      if (!profile || !samePhysicalWorkspace(executionWorkspaceRoot(root, profile.cwd), workspace)) throw new WorkflowAdmissionError('原生配置工作目录已改变，请重新接纳连接')
    }
    if (admissionClosed || !admission.isCurrent()) throw new WorkflowAdmissionError('原生连接接纳已失效')
    // Native connection calls can await startup/drain. Let quit reach shutdownAcp
    // instead of waiting for a connection that only shutdown can settle. The
    // token remains fenced while pending; facade shuttingDown checks prevent
    // late asynchronous creation/load from resurrecting an owned connection.
    admission.retainNative(occupied, recover)
    const result = await action()
    if ('sessionId' in result && typeof result.sessionId === 'string') occupiedSessionId = result.sessionId
    if (!result.ok && !occupiedSessionId) occupiedSessionId = priorBlocker?.sessionId
    return result
  } finally {
    // Bind the exact operation's native generation, never another conversation
    // merely because it is currently busy in this workspace.
    try {
      occupiedSessionId ??= priorBlocker?.sessionId
      const blocker = listOwnedAcpSessionFacts().find((session) => session.sessionId === occupiedSessionId)
      if (blocker?.connectionGeneration) recoveryOwner = { root: blocker.projectRoot, identity: { sessionId: blocker.sessionId, connectionGeneration: blocker.connectionGeneration } }
    } catch { inventoryUnknown = true }
    pending = false
    if (!occupied()) admission.release()
    else admission.retainNative(occupied, recover, recoveryOwner?.identity)
  }
}
export async function withManagedWorkflowAdmission<T>(root: string, action: () => Promise<T>, duplicate?: WorkflowStartInput): Promise<T> {
  if (admissionClosed) throw new WorkflowAdmissionError('应用正在退出，暂不接纳新的工作流')
  // The only production caller is the application's idempotent start method.
  // Reading a committed receipt cannot dispatch again and need not drain a turn.
  if (duplicate && await committedStart(root, duplicate)) return action()
  const workspace = executionWorkspaceRoot(root)
  const admission = claimWorkspaceAdmission(workspace, 'managed', undefined, { projectRoot: root })
  try {
    // Bind the verified project identity before publishing a discovery ref.
    // A later missing marker is therefore uncertainty, never proof of no owner.
    const project = canonicalWorkspaceRoot(root)
    if (!statSync(join(project, '.trellis', 'tasks')).isDirectory()) throw new WorkflowAdmissionError('未核实 Trellis 任务目录，不能接纳工作流')
    await getWorkflowApplication(project)
    await registerWorkspaceProject(workspace, root)
    await assertNoManagedOwner(root, workspace, duplicate)
    // The actual live map spans all project roots. Preferences/history projections
    // can omit another nested project's starting/draining connection or retain a
    // stale ready status; native ownership flags remain authoritative.
    for (const session of listOwnedAcpSessionFacts()) {
      const occupied = ownedNativeBusy(session)
      if (!occupied) continue
      let nativeWorkspace: string
      try {
        if (!session.projectRoot || !session.sessionId || !session.connectionGeneration) throw new Error('Missing native identity')
        nativeWorkspace = executionWorkspaceRoot(session.projectRoot, session.cwd ?? undefined)
      } catch { throw new WorkflowAdmissionError('现有原生会话的实际工作区或连接身份无法核实，暂不接纳工作流') }
      if (samePhysicalWorkspace(nativeWorkspace, workspace)) throw new WorkflowAdmissionError('此工作区已有原生会话正在接纳、执行、连接或清理，请先等待结束或停止该会话')
    }
    return await action()
  } finally { admission.release() }
}
export async function hasWorkflowApplications(): Promise<boolean> {
  for (const pending of services.values()) if ((await pending).activeRuns().length) return true
  return false
}
/** Copied counts from actual controllers; never inferred from historical rows. */
export async function countOwnedWorkflowApplications(root?: string): Promise<number> {
  let count = 0
  const selected = root ? canonicalWorkspaceRoot(root) : null
  for (const [key, pending] of services) {
    if (selected && !samePhysicalWorkspace(key, selected)) continue
    count += (await pending).activeRuns().length
  }
  return count
}

/** Check only existing controllers; an ordinary chat never creates a control DB. */
export async function isManagedWorkflowOrigin(root: string, sessionId: string, generation?: string, associationOnly = false): Promise<boolean> {
  const canonical = await realpath(root)
  const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical
  let existing = services.get(key)
  if (!existing) {
    // Reopen existing workflow authority before permitting an ordinary turn;
    // a fresh project without a workflow marker still creates no control DB.
    try { await lstat(join(canonical, '.trellis', '.panel', 'runtime', 'workflow-local-identity.json')) }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false; throw error }
    existing = getWorkflowApplication(canonical)
  }
  const application = await existing
  for (const run of application.activeRuns()) {
    if (run.origin.sessionId === sessionId && (!generation || run.origin.connectionGeneration === generation)) return true
    const snapshot = await application.snapshot({ taskDir: run.taskDir, run: run.run })
    if (snapshot.stageSessions.some((session) => session.sessionId === sessionId && (!generation || session.connectionGeneration === generation))) return true
  }
  const selected = await getAcpHistorySession(canonical, sessionId)
  if (!selected.ok || !selected.session.taskDir || (generation && selected.session.connectionGeneration !== generation)) return false
  const snapshot = await application.snapshot({ taskDir: selected.session.taskDir })
  if (associationOnly) return Boolean(snapshot.snapshot && (snapshot.composer.target === 'managed' || snapshot.recoveryRequired)
    && (snapshot.origin?.sessionId === sessionId && (!generation || snapshot.origin.connectionGeneration === generation)
      || snapshot.stageSessions.some((session) => session.sessionId === sessionId && (!generation || session.connectionGeneration === generation))))
  // A restored controller has no in-memory activeRuns. Its durable active or
  // uncertain head must still fence every mutable session bound to that task.
  if (snapshot.snapshot && (snapshot.composer.target === 'managed' || snapshot.recoveryRequired)) return true
  return false
}

export async function shutdownWorkflowApplications(): Promise<void> {
  await waitForWorkspaceAdmissions()
  for (const pending of services.values()) {
    const application = await pending
    const results = await application.requestShutdown()
    if (results.some((result) => result.status !== 'stopped')) throw new WorkflowApplicationError('OUTCOME_UNKNOWN', '仍有工作流未确认停止，请回到会话核对后重试退出')
  }
  for (const pending of services.values()) await (await pending).close()
  services.clear()
}

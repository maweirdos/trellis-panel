/** Trellis application facade. ACP framing, turns, controls and child cleanup belong to acpx. */
import { app } from 'electron'
import { assertRuntimeExecutionHost } from './runtime-host'
import { createHash, randomUUID } from 'crypto'
import { existsSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { createAcpRuntime, createFileSessionStore, type AcpRuntimeHandle, type AcpRuntimeTurn, type AcpRuntimeEvent, type AcpPermissionHandler, type AcpPermissionDecision, type AcpSessionRecord as RuntimeRecord } from 'acpx/runtime'
import * as AcpxRuntime from 'acpx/runtime'
import { createAgentRegistry } from 'acpx/agent-registry'
import { broadcastToWindows } from './bridge'
import { noteTaskDir } from './observability/service'
import { parseTrellisTaskPath } from './task-identity'
import { ipcEvent } from '../../shared/ipc-channels'
import { publishWorkflowAcpEvent, publishWorkflowAcpState, type WorkflowObserverFailure } from './workflow-runtime/acp-events'
import type { WorkflowPreparedPrompt } from './workflow-runtime/types'
import { ipcFail, IpcErrorCode, type IpcFail } from '../../shared/ipc-errors'
import type { AcpAgentConfig, AcpAgentProfile, AcpBindTaskInput, AcpConfigureInput, AcpMaterialChange, AcpPermissionPayload, AcpPromptOptions, AcpSessionRecord, AcpSessionStatus, TimelineEvent, TimelineEventKind } from '../../shared/types'
import type { AcpRecoverModelInput, AcpRecoverModelResult } from '../../shared/acp-recovery'
import type { AcpHandoffOrigin, AcpHandoffOperationResult, AcpHandoffPreviewResult } from '../../shared/acp-handoff'
import { acpDataPath, canonicalDirectory, persistRecord, readProfiles, readRecords, saveProfiles } from './acp/metadata'
import { bindTaskSchema, configureSchema, errorMessage, idSchema, newSessionSchema, objectValue, profileSchema, promptOptionsSchema } from './acp/types'
import { activeTaskExists, preparePromptMaterials, sourceBelongs } from './acp/materials'
import { resolveAuthorizedDocumentPath } from './documents/paths'
import { launchArgv, resolveAcpRuntimeLaunch, NATIVE_TOOLS_DIAGNOSTIC } from './acp/setup'
import { archiveAcpEvent, ensureAcpHistory, flushAcpHistory, historyPersistence, listAcpHistory, onHistoryPersistence, readAcpHandoffArchive, readAcpHistoryEvents, readAcpHistorySession, retryAcpHistory, stopAcpHistory } from './acp/history-service'
import { acpHistoryUpdateInputSchema, type AcpHistoryEventPage, type AcpHistoryListResult, type AcpHistorySummary, type AcpHistoryUpdateResult } from '../../shared/acp-history'
import { snapshotHistoryEvents, snapshotHistoryList, snapshotHistorySession } from './acp/history-fallback'
import { applySessionPreferences, readSessionPreferences, updateSessionPreferences } from './acp/session-preferences'
import { ModelMetadataContext } from './acp/cc-switch-models'
import { prepareAgentContext, type PreparedAgentContext } from './acp/agent-context'
import { readConnectionTimings } from './acp/connection-timings'
import { zcodeStartupCacheDirectory } from './acp/zcode-startup'
import { upgradeLegacyKnowledgePolicy } from './acp/legacy-knowledge-policy'
import { knowledgeMcpBridge, type KnowledgeMcpConnection } from './knowledge-mcp'
import { AcpHandoffs, portableSourceReferences, type HandoffSource, type HandoffTargetPlan, type PreparedHandoff } from './acp/handoff'
import { handoffDigest } from './acp/handoff-store'
export { listAcpAgents, setupAcpRuntime, pickAcpNode, pickAcpRuntimePath } from './acp/setup'
export { testAcpRuntimeConnection } from './acp/connection-probe'
export { archiveAcpEvent, ensureAcpHistory, flushAcpHistory, historyPersistence, retryAcpHistory, stopAcpHistory } from './acp/history-service'

// acpx reads this host flag during runtime construction, not from child overlays.
// Inherit local user/project Claude settings without copying credential values.
process.env.ACPX_CLAUDE_INCLUDE_USER_SETTINGS = '1'
const MAX_ACTIVE = 4
const MAX_RECORD_EVENTS = 800
const PERMISSION_TIMEOUT_MS = 120_000
const CANCEL_TIMEOUT_MS = 10_000
const sessions = new Map<string, ActiveSession>()
// Reserve before discovery yields so two restores cannot replace one owner.
const resuming = new Set<string>()
const connectionReservations = new Set<symbol>()
const cancelledResumes = new Set<string>()
type ResumeResult = { ok: true; sessionId: string } | IpcFail
const resumeRequests = new Map<string, { root: string; promise: Promise<ResumeResult> }>()
const recoveryRequests = new Map<string, { root: string; operation: ModelRecoveryOperation; promise: Promise<AcpRecoverModelResult> }>()
const creatingRequests = new Set<Promise<{ ok: true; sessionId: string } | IpcFail>>()
const handoffRequests = new Set<Promise<AcpHandoffOperationResult | IpcFail>>()
const leases = new Map<string, Set<ActiveSession>>()
let shuttingDown = false
let eventSeq = 0
let lastWorkflowObserverWarningAt = 0

function directoryIdentity(root: string): string {
  const canonical = canonicalDirectory(root)
  const stat = statSync(canonical)
  if (!stat.isDirectory()) throw new Error('项目或工作目录不可用')
  return JSON.stringify([canonical, stat.dev, stat.ino])
}
function handoffMetadata(root: string, id: string): AcpSessionRecord | undefined {
  const meta = sessions.get(id)?.meta ?? readRecords().find(record => record.sessionId === id)
  return meta && belongs(root, meta) ? meta : undefined
}
function assertHandoffSourceIdle(root: string, id: string, allowArchived: boolean): AcpSessionRecord {
  const meta = handoffMetadata(root, id)
  if (!meta || meta.schemaVersion !== 2) throw new Error('当前项目没有可接续的现代源会话')
  const live = sessions.get(id)
  if (resuming.has(id) || resumeRequests.has(id) || recoveryRequests.has(id) || live && (live.accepting || live.turn || live.closing || live.settling
    || live.pendingPermissions.size || live.backgroundWork || live.uncertainWork || live.cleanupRequired || live.leaseHeld
    || !['ready', 'disconnected', 'closed'].includes(live.meta.status))) throw new Error('源会话仍有回合、连接、权限、后台工具或清理操作，请先完成后再接续')
  const presentation = applySessionPreferences(meta, readSessionPreferences(acpDataPath(), root))
  if (!allowArchived && presentation.archivedAt !== undefined) throw new Error('源会话已归档，请先恢复或取消原接续')
  return presentation
}
async function captureHandoffSource(root: string, id: string, allowArchived: boolean): Promise<HandoffSource> {
  const initial = assertHandoffSourceIdle(root, id, allowArchived)
  const workflow = await import('./workflow-desktop')
  if (await workflow.isManagedWorkflowOrigin(root, id, undefined, true)) throw new Error('托管工作流会话不能通过普通 Runtime 接续迁移')
  const headerBytes = Buffer.byteLength([initial.projectRoot, initial.cwd ?? initial.projectRoot, initial.title ?? initial.agentName,
    initial.taskDir ?? '', ...portableSourceReferences(initial)].join('\n')) + 4096
  const archive = await readAcpHandoffArchive(root, id, Math.min(22 * 1024, 32 * 1024 - headerBytes))
  if ('ok' in archive) throw new Error(archive.error)
  const meta = assertHandoffSourceIdle(root, id, allowArchived)
  const context = prepareAgentContext(root, 'handoff-source', meta.profileSnapshot)
  const { events: _cache, ...metadata } = meta
  return { meta: { ...metadata, events: [] }, archive,
    fence: handoffDigest({ root: directoryIdentity(root), cwd: directoryIdentity(meta.cwd ?? meta.projectRoot),
      sessionId: id, backendSessionId: meta.backendSessionId, agentSessionId: meta.agentSessionId,
      connectionGeneration: meta.connectionGeneration, turnId: meta.turnId, runtime: meta.runtimeSnapshot,
      taskDir: meta.taskDir, title: meta.title, profileId: meta.profileSnapshot?.id,
      contextRevision: context?.revision, materialSnapshot: meta.materialSnapshot, checkpointSeq: archive.checkpointSeq,
      checkpointEventId: archive.checkpointEventId, archiveContext: handoffDigest(archive.context),
      includedMessages: archive.includedMessages, latestTurnIncluded: archive.latestTurnIncluded, omittedMessages: archive.omittedMessages,
      attachments: archive.attachments, toolCalls: archive.toolCalls, coverage: archive.coverage }) }
}
function updateHandoffMetadata(root: string, id: string, update: (meta: AcpSessionRecord) => AcpSessionRecord): void {
  const old = handoffMetadata(root, id)
  if (!old) throw new Error('交接关联会话不可用，原历史已保留')
  const next = update(old)
  persistRecord(next)
  const live = sessions.get(id)
  if (live) { live.meta = next; setStatus(live, next.status, next.error) }
  else archiveAcpEvent(next)
}
const acpHandoffs = new AcpHandoffs({
  directory: () => acpDataPath(), canonical: canonicalDirectory, rootIdentity: directoryIdentity,
  source: captureHandoffSource, metadata: handoffMetadata, updateMetadata: updateHandoffMetadata,
  target: async runtimeId => {
    const launch = await resolveAcpRuntimeLaunch(runtimeId)
    if ('ok' in launch) throw new Error(launch.error)
    return { ...launch, fingerprint: handoffDigest({ config: launch.config, argv: launch.argv,
      files: launch.argv.map(path => { try { const stat = statSync(path); return stat.isFile() ? [canonicalDirectory(path), stat.dev, stat.ino, stat.size, stat.mtimeMs] : null } catch { return null } }) }) }
  },
  createTarget: async (root, id, source, plan, origin, assertCurrent, beforeNativeCreate) => {
    const old = source.profileSnapshot
    const profile: AcpAgentProfile | undefined = old ? { id: old.id, name: old.name, description: old.description,
      instructions: old.instructions, skillPaths: old.skillPaths ? [...old.skillPaths] : undefined,
      runtimeId: plan.config.id, maxTurnMinutes: 30, cwd: source.cwd ?? root } : undefined
    prepareAgentContext(root, id, profile)?.assertCurrent()
    const created = await newOwnedAcpSession(root, { agentId: plan.config.id, taskDir: source.taskDir },
      { sessionId: id, profile, cwd: source.cwd ?? root, plan, origin, assertCurrent, beforeNativeCreate })
    if (!created.ok) throw new Error(created.error)
    const target = sessions.get(id)
    if (!target) throw new Error('目标 Runtime 连接未创建')
    await target.preparing
    assertCurrent()
    if (sessions.get(id) !== target || target.meta.status !== 'ready' || target.closing || target.disconnected || !target.handle
      || target.handle.backendSessionId !== target.meta.backendSessionId) throw new Error(target.meta.error ?? '目标 Runtime 未确认就绪')
    persistRecord(target.meta)
    await flushAcpHistory()
    return target.meta
  },
  verifyTarget: async (root, id, identity) => {
    const meta = handoffMetadata(root, id)
    if (!meta || meta.backendSessionId !== identity.backendSessionId || identity.agentSessionId && meta.agentSessionId !== identity.agentSessionId) return false
    const live = sessions.get(id)
    if (live && !live.closing && !live.disconnected && live.handle?.backendSessionId === identity.backendSessionId
      && (live.meta.status === 'ready' || live.accepting || live.turn)) return true
    if (!meta.canResume) return false
    const record = await createFileSessionStore({ stateDir: acpDataPath('runtime-store') }).load(meta.acpxRecordId ?? id)
    return record?.acpSessionId === identity.backendSessionId && (!identity.agentSessionId || record.agentSessionId === identity.agentSessionId)
  },
  stopTarget: async (root, id, operationId) => {
    // Cleanup never starts/resumes a workspace or acquires a new native owner.
    const target = sessions.get(id)
    if (!target) return
    if (!belongs(root, target.meta) || target.meta.handoff?.operationId !== operationId) throw new Error('目标连接不属于此交接操作，未执行停止')
    const turn = target.turn
    const stopped = await killOwned(target, 'Runtime 接续已取消，保留目标历史')
    if (!stopped.ok) throw new Error(stopped.error)
    if (turn) await turn.promptStarted.catch(() => {})
  },
  warning: (root, id, message) => { const live = sessions.get(id); if (live && belongs(root, live.meta)) emit(live, 'diagnostic', message); else process.emitWarning(message, { code: 'TRELLIS_ACP_HANDOFF' }) },
  closing: () => shuttingDown
})
function handoffMutationConflict(root: string, id: string): IpcFail | undefined {
  try {
    const message = acpHandoffs.sourceConflict(root, id)
    if (message) return ipcFail(IpcErrorCode.Conflict, message)
    if (readSessionPreferences(acpDataPath(), root).sessions[id]?.archivedAt !== undefined) return ipcFail(IpcErrorCode.Conflict, '此会话已归档，内容尚未发送；请先恢复会话')
  } catch (error) { return ipcFail(IpcErrorCode.Io, errorMessage(error)) }
  return undefined
}
export function previewAcpSessionHandoff(root: string, id: string, input: unknown, isCurrent?: () => boolean): Promise<AcpHandoffPreviewResult | IpcFail> {
  assertRuntimeExecutionHost()
  return acpHandoffs.preview(root, id, input, isCurrent)
}
export function createAcpSessionHandoff(root: string, id: string, input: unknown, isCurrent?: () => boolean): Promise<AcpHandoffOperationResult | IpcFail> {
  assertRuntimeExecutionHost()
  const pending = acpHandoffs.create(root, id, input, isCurrent)
  handoffRequests.add(pending)
  void pending.finally(() => handoffRequests.delete(pending)).catch(() => {})
  return pending
}
export function getAcpSessionHandoff(root: string, id: string, operationId: string): Promise<AcpHandoffOperationResult | IpcFail> {
  assertRuntimeExecutionHost()
  return acpHandoffs.status(root, id, operationId)
}
export function cancelAcpSessionHandoff(root: string, id: string, input: unknown): Promise<AcpHandoffOperationResult | IpcFail> {
  assertRuntimeExecutionHost()
  return acpHandoffs.cancel(root, id, input)
}

/** Optional managed observers cannot break native ACP/history or recursively emit. */
function publishWorkflowObservation(publish: () => WorkflowObserverFailure[]): void {
  try { if (publish().length === 0) return }
  catch { /* Publication errors are contained and reported through the same bounded warning. */ }
  const now = Date.now()
  if (now - lastWorkflowObserverWarningAt < 5_000) return
  lastWorkflowObserverWarningAt = now
  process.emitWarning('A managed workflow observer could not record an ACP update; native execution continues.', { code: 'TRELLIS_WORKFLOW_OBSERVER' })
}

interface PendingPermission {
  payload: AcpPermissionPayload
  finish: (decision: AcpPermissionDecision, outcome: string) => void
}
interface ActiveSession {
  meta: AcpSessionRecord
  runtime: ReturnType<typeof createAcpRuntime>
  handle?: AcpRuntimeHandle
  raw?: RuntimeRecord
  turn?: AcpRuntimeTurn
  accepting: boolean
  closing: boolean
  disconnected: boolean
  preparing?: Promise<void>
  pendingPermissions: Map<string, PendingPermission>
  lastStatusAt: Map<string, number>
  hasProcess: boolean
  backgroundWork: boolean
  toolStates: Map<string, 'unfinished' | 'settled'>
  firstResponseAt?: number
  turnStartedAt?: number
  leaseHeld: boolean
  leaseMode: 'shared' | 'exclusive'
  leaseKey?: string
  uncertainWork: boolean
  disconnectOnClose?: boolean
  lastUsedAt: number
  closingTask?: Promise<{ ok: true } | IpcFail>
  settling: boolean
  promptAbort?: AbortController
  cleanupRequired?: boolean
  snapshotDirty: number
  snapshotTimer?: NodeJS.Timeout
  knowledge?: KnowledgeMcpConnection
  knowledgeSupport: 'http' | 'unsupported' | 'unknown'
  nativeCommands: Set<string>
  modelMetadata: ModelMetadataContext
  nativePersistenceConfirmed: boolean
}

function failure(error: unknown): IpcFail { return ipcFail(IpcErrorCode.Upstream, knowledgeMcpBridge.redactText(errorMessage(error))) }
function keyFor(session: ActiveSession): string { return canonicalDirectory(session.meta.cwd ?? session.meta.projectRoot) }
function belongs(root: string, record: Pick<AcpSessionRecord, 'projectRoot'>): boolean {
  return !!root && canonicalDirectory(root) === canonicalDirectory(record.projectRoot)
}
function owned(root: string, sessionId: string): ActiveSession | IpcFail {
  if (!root) return ipcFail(IpcErrorCode.NoProject, '未打开项目')
  const session = sessions.get(sessionId)
  if (!session) return ipcFail(IpcErrorCode.NotFound, '会话尚未连接，请重新打开会话以连接')
  if (!belongs(root, session.meta)) return ipcFail(IpcErrorCode.Denied, '此会话不属于当前项目')
  return session
}
function acquire(session: ActiveSession, mode: ActiveSession['leaseMode'] = session.leaseHeld ? session.leaseMode : 'shared'): IpcFail | undefined {
  const key = keyFor(session)
  if (session.leaseHeld && session.leaseKey !== key) return ipcFail(IpcErrorCode.Conflict, '会话工作目录已改变，请重新连接后重试')
  if (session.cleanupRequired || session.uncertainWork) return ipcFail(IpcErrorCode.Conflict, '此会话的工具或清理尚未确认结束，请先完成原会话清理')
  const owners = leases.get(key) ?? new Set<ActiveSession>()
  for (const owner of owners) {
    if (owner === session) continue
    const sameProject = belongs(session.meta.projectRoot, owner.meta)
    if (!sameProject || mode === 'exclusive' || owner.leaseMode === 'exclusive' || owner.cleanupRequired || owner.uncertainWork || owner.closing) {
      return ipcFail(IpcErrorCode.Conflict, sameProject ? '此目录有独占执行或尚未确认结束的清理，请等待完成后重试' : '此工作目录正由另一项目使用，请等待原执行结束',
        sameProject ? { ownerSessionId: owner.meta.sessionId } : undefined)
    }
  }
  owners.add(session)
  leases.set(key, owners)
  session.leaseHeld = true
  session.leaseMode = mode
  session.leaseKey = key
  return undefined
}
/** Cleanup uncertainty blocks new admission without cancelling already admitted peers. */
function holdCleanupBarrier(session: ActiveSession): void {
  const key = session.leaseKey ?? keyFor(session)
  const owners = leases.get(key) ?? new Set<ActiveSession>()
  owners.add(session); leases.set(key, owners)
  session.leaseHeld = true; session.leaseMode = 'exclusive'; session.leaseKey = key
}
function release(session: ActiveSession): void {
  if (session.cleanupRequired) { holdCleanupBarrier(session); return }
  const unfinished = [...session.toolStates.values()].some((state) => state === 'unfinished')
  if (session.hasProcess && (session.backgroundWork || unfinished)) {
    // A model turn ending does not prove an unfinished native tool has stopped.
    // Once that uncertainty crosses a turn boundary, keep ownership until stop.
    session.backgroundWork = true
    session.uncertainWork = unfinished
    if (unfinished) holdCleanupBarrier(session)
    session.meta.directoryLeaseReason = unfinished
      ? 'Runtime 仍有未报告完成的工具；回合结束不能证明工具已停止，请结束会话以释放目录'
      : '此会话仍有后台工具，其他普通对话可继续使用'
    return
  }
  const key = session.leaseKey ?? keyFor(session)
  const owners = leases.get(key)
  owners?.delete(session)
  if (owners?.size === 0) leases.delete(key)
  session.leaseHeld = false
  session.leaseMode = 'shared'
  session.leaseKey = undefined
  session.uncertainWork = false
  delete session.meta.directoryLeaseReason
}

async function reserveConnectionSlot(excludedSessionId?: string): Promise<symbol | IpcFail> {
  while (!shuttingDown && sessions.size + connectionReservations.size >= MAX_ACTIVE) {
    const idle = [...sessions.values()].filter((session) => session.meta.sessionId !== excludedSessionId
      && session.meta.canResume === true && session.meta.backendSessionId && session.meta.runtimeSnapshot
      // ZCode advertises load for new empty sessions that exist only in RAM.
      // Capability/snapshots alone cannot make that owner safe to discard.
      && (session.meta.runtimeSnapshot.id !== 'zcode' || session.meta.runtimeSnapshot.launchKind !== 'bundled' || session.nativePersistenceConfirmed)
      && session.meta.status === 'ready' && !session.turn && !session.accepting && !session.closing && !session.settling
      && !session.backgroundWork && !session.uncertainWork && !session.cleanupRequired && !session.leaseHeld && session.pendingPermissions.size === 0)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt || left.meta.sessionId.localeCompare(right.meta.sessionId))[0]
    if (!idle) return ipcFail(IpcErrorCode.Conflict, `运行连接已达 ${MAX_ACTIVE} 个，暂无可安全释放的空闲连接；输入已保留，请稍后重试或结束不用的会话`)
    const result = await killOwned(idle, '空闲连接已释放，发送消息时会自动连接原会话', 'disconnected')
    if (!result.ok) return result
  }
  if (shuttingDown) return ipcFail(IpcErrorCode.Conflict, '后台正在停止，未创建新连接')
  const reservation = Symbol('native-connection')
  connectionReservations.add(reservation)
  return reservation
}
function projectConnectionOwnership(session: ActiveSession): void {
  session.meta.connectionOwned = sessions.get(session.meta.sessionId) === session
  session.meta.cleanupRequired = session.meta.connectionOwned && session.cleanupRequired === true
}

function modelUnavailable(error: unknown): boolean {
  const visited = new Set<unknown>()
  for (let current = error; current && !visited.has(current) && visited.size < 8;) {
    visited.add(current)
    if (AcpxRuntime.isRequestedModelUnsupportedError(current)) return true
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined
  }
  return false
}
function save(session: ActiveSession): void {
  if (session.snapshotTimer) { clearTimeout(session.snapshotTimer); session.snapshotTimer = undefined }
  session.snapshotDirty = 0
  archiveAcpEvent(session.meta)
  try { persistRecord(session.meta) }
  catch (error) {
    // Keep live work and expose a persistence failure without recursive writes.
    broadcastToWindows(ipcEvent.acpOutput, eventFor(session, 'diagnostic', `历史保存失败：${errorMessage(error)}`))
  }
}
function eventFor(session: ActiveSession, kind: TimelineEventKind, text?: string, payload?: Record<string, unknown>): TimelineEvent {
  text = text === undefined ? undefined : knowledgeMcpBridge.redactText(text)
  try { payload = payload === undefined ? undefined : knowledgeMcpBridge.redact(payload) }
  catch { payload = { diagnostic: 'Native payload omitted: descriptor redaction limits exceeded' } }
  return { id: `te-${Date.now().toString(36)}-${eventSeq++}`, ts: Date.now(), source: 'acp', sessionId: session.meta.sessionId,
    projectRoot: session.meta.projectRoot, taskDir: session.meta.taskDir, connectionGeneration: session.meta.connectionGeneration,
    turnId: payload?.activityScope === 'connection' ? undefined : session.meta.turnId, kind, text, payload }
}
function emit(session: ActiveSession, kind: TimelineEventKind, text?: string, payload?: Record<string, unknown>): void {
  const event = eventFor(session, kind, text, payload)
  archiveAcpEvent(session.meta, event)
  publishWorkflowObservation(() => publishWorkflowAcpEvent(event))
  session.meta.events.push(event)
  if (session.meta.events.length > MAX_RECORD_EVENTS) session.meta.events.splice(0, session.meta.events.length - MAX_RECORD_EVENTS)
  broadcastToWindows(ipcEvent.acpOutput, event)
  session.snapshotDirty += 1
  if (session.snapshotDirty >= 20 && !session.snapshotTimer) {
    session.snapshotTimer = setTimeout(() => save(session), 250)
    session.snapshotTimer.unref()
  }
}
function setStatus(session: ActiveSession, status: AcpSessionStatus, error?: string, terminal = false): void {
  error = error === undefined ? undefined : knowledgeMcpBridge.redactText(error)
  session.meta.status = status
  session.meta.error = error
  if (terminal) session.meta.endedAt = Date.now()
  projectConnectionOwnership(session)
  session.meta.pendingPermissions = [...session.pendingPermissions.values()].map((pending) => pending.payload)
  session.meta.stateRevision = (session.meta.stateRevision ?? 0) + 1
  session.meta.historyPersistence = historyPersistence(session.meta.sessionId)
  const { events: _cache, ...metadata } = session.meta
  let presentation: typeof metadata | undefined
  try { presentation = applySessionPreferences(metadata, readSessionPreferences(acpDataPath(), metadata.projectRoot)) }
  catch (error) { broadcastToWindows(ipcEvent.acpOutput, eventFor(session, 'diagnostic', `会话偏好读取失败：${errorMessage(error)}`)) }
  const payload = { sessionId: session.meta.sessionId, projectRoot: session.meta.projectRoot, status, error,
    pendingPermissions: session.meta.pendingPermissions, stateRevision: session.meta.stateRevision, historyPersistence: session.meta.historyPersistence,
    connectionGeneration: session.meta.connectionGeneration, turnId: session.meta.turnId, ...(presentation ? { session: { ...presentation, events: [] } } : {}) }
  publishWorkflowObservation(() => publishWorkflowAcpState(payload))
  broadcastToWindows(terminal ? ipcEvent.acpDone : ipcEvent.acpState, payload)
  save(session)
}
onHistoryPersistence((sessionId, persistence) => {
  const session = sessions.get(sessionId)
  if (!session) return
  session.meta.historyPersistence = persistence
  session.meta.pendingPermissions = [...session.pendingPermissions.values()].map((pending) => pending.payload)
  session.meta.stateRevision = (session.meta.stateRevision ?? 0) + 1
  const payload = { sessionId, projectRoot: session.meta.projectRoot, status: session.meta.status, error: session.meta.error,
    connectionGeneration: session.meta.connectionGeneration, turnId: session.meta.turnId,
    pendingPermissions: session.meta.pendingPermissions, stateRevision: session.meta.stateRevision, historyPersistence: persistence }
  publishWorkflowObservation(() => publishWorkflowAcpState(payload))
  broadcastToWindows(ipcEvent.acpState, payload)
})
function observe(session: ActiveSession, label: string, since?: number, failed = false, activityScope: 'connection' | 'turn' = 'connection'): void {
  const atMs = Date.now()
  session.meta.startup ??= []
  session.meta.startup.push({ label, atMs, durationMs: since ? atMs - since : undefined, status: failed ? 'failed' : 'observed' })
  emit(session, 'session-status', label, { observation: session.meta.startup.at(-1), activityScope })
}
function syncRecord(session: ActiveSession, record: RuntimeRecord): void {
  session.raw = record
  session.meta.backendSessionId = record.acpSessionId || undefined
  session.meta.agentSessionId = record.agentSessionId
  session.meta.acpxRecordId = record.acpxRecordId
  session.meta.capabilities = { ...session.meta.capabilities, controls: session.meta.capabilities?.controls ?? [],
    protocolVersion: record.protocolVersion, loadSession: record.agentCapabilities?.loadSession === true,
    promptCapabilities: { image: record.agentCapabilities?.promptCapabilities?.image === true,
      embeddedContext: record.agentCapabilities?.promptCapabilities?.embeddedContext === true },
    agentInfo: record.agentInfo, authMethods: record.authMethods }
  session.meta.canResume = !!record.acpSessionId && record.agentCapabilities?.loadSession === true
  session.meta.currentModeId = record.acpx?.current_mode_id
  session.meta.modes = record.acpx?.available_modes?.map(({ id, name }) => ({ id, name }))
  session.meta.currentModelId = record.acpx?.current_model_id
  session.meta.models = record.acpx?.available_models?.map((modelId) => ({ modelId, name: record.acpx?.available_model_names?.[modelId] ?? modelId }))
  session.meta.configOptions = record.acpx?.config_options?.filter((option) => option.type === 'select').map((option) => ({
    id: option.id, name: option.name, category: option.category ?? undefined, currentValue: option.currentValue,
    options: option.options.flatMap((item) => 'options' in item ? item.options.map((child) => ({ value: child.value, name: child.name })) : [{ value: item.value, name: item.name }])
  }))
  projectCategorizedSelections(session.meta)
  session.modelMetadata.project(session.meta)
}

/** Modern categorized config acknowledgements override stale legacy display fields. */
function projectCategorizedSelections(meta: AcpSessionRecord): void {
  const modes = meta.configOptions?.filter((option) => option.category === 'mode') ?? []
  if (modes.length === 1) {
    meta.currentModeId = modes[0].currentValue
    meta.modes = modes[0].options.map(({ value, name }) => ({ id: value, name }))
  }
  const models = meta.configOptions?.filter((option) => option.category === 'model') ?? []
  if (models.length === 1) {
    meta.currentModelId = models[0].currentValue
    meta.models = models[0].options.map(({ value, name }) => ({ modelId: value, name }))
  }
  // Equal display names must not conceal distinct provider/model wire selectors.
  const names = new Map<string, number>()
  for (const model of meta.models ?? []) names.set(model.name, (names.get(model.name) ?? 0) + 1)
  meta.models = meta.models?.map((model) => (names.get(model.name) ?? 0) > 1 ? { ...model, name: `${model.name} · ${model.modelId}` } : model)
  const labels = new Map(meta.models?.map(({ modelId, name }) => [modelId, name]))
  if (models.length === 1) models[0].options = models[0].options.map((option) => ({ ...option, name: labels.get(option.value) ?? option.name }))
}

/** Main-only execution facts. Never read history/preferences or expose native objects. */
export interface OwnedAcpSessionFacts {
  projectRoot: string
  cwd: string | null
  sessionId: string
  connectionGeneration: string | null
  status: AcpSessionStatus
  accepting: boolean
  closing: boolean
  disconnected: boolean
  leaseHeld: boolean
  cleanupRequired: boolean
  backgroundWork: boolean
  unfinishedTools: boolean
  turnActive: boolean
  settling: boolean
  pendingPermission: boolean
}
export function listOwnedAcpSessionFacts(): OwnedAcpSessionFacts[] {
  return [...sessions.values()].map((session) => ({
    projectRoot: session.meta.projectRoot, cwd: session.meta.cwd ?? null,
    sessionId: session.meta.sessionId, connectionGeneration: session.meta.connectionGeneration ?? null,
    status: session.meta.status, accepting: session.accepting, closing: session.closing,
    disconnected: session.disconnected, leaseHeld: session.leaseHeld,
    cleanupRequired: session.cleanupRequired === true, backgroundWork: session.backgroundWork,
    unfinishedTools: [...session.toolStates.values()].some((state) => state === 'unfinished'),
    turnActive: Boolean(session.turn), settling: session.settling, pendingPermission: session.pendingPermissions.size > 0
  }))
}

export function listAcpSessions(projectRoot: string, limit = 20): { ok: true; sessions: AcpSessionRecord[] } | IpcFail {
  if (!projectRoot) return { ok: true, sessions: [] }
  const active = [...sessions.values()].filter((session) => belongs(projectRoot, session.meta)).map((session) => { session.modelMetadata.project(session.meta, true); return session.meta })
  const history = readRecords().filter((record) => belongs(projectRoot, record) && !sessions.has(record.sessionId)).sort((a, b) => b.startedAt - a.startedAt).slice(0, Math.max(0, Math.min(limit, 100)))
  try {
    const preferences = readSessionPreferences(acpDataPath(), projectRoot)
    return { ok: true, sessions: [...active, ...history].map((record) => ({ ...applySessionPreferences(record, preferences), events: record.events.map((event) => event.kind === 'permission' && event.payload?.pending === true
      ? { ...event, payload: { ...event.payload, pending: sessions.get(record.sessionId)?.pendingPermissions.has(String(event.payload.requestId)) === true } } : event) })) }
  } catch (error) { return ipcFail(IpcErrorCode.Io, errorMessage(error)) }
}

function liveHistorySummary(summary: AcpHistorySummary): AcpHistorySummary {
  const live = sessions.get(summary.sessionId)
  if (!live || !belongs(summary.projectRoot, live.meta)) return summary
  live.modelMetadata.project(live.meta, true)
  const { events: _events, ...meta } = live.meta
  return { ...summary, ...meta, title: summary.customTitle ?? meta.title ?? summary.title,
    customTitle: summary.customTitle, pinnedAt: summary.pinnedAt, archivedAt: summary.archivedAt, historyPersistence: historyPersistence(summary.sessionId),
    pendingPermissions: [...live.pendingPermissions.values()].map((pending) => pending.payload), stateRevision: meta.stateRevision ?? 0 }
}
export async function listAcpHistorySessions(root: string, input?: unknown): Promise<AcpHistoryListResult | IpcFail> {
  assertRuntimeExecutionHost()
  if (!root) return ipcFail(IpcErrorCode.NoProject, '未打开项目')
  try {
    let result = await listAcpHistory(root, input)
    if (!result.ok && result.code === IpcErrorCode.Io) result = snapshotHistoryList(root, input, result.error)
    return result.ok ? { ...result, sessions: result.sessions.map(liveHistorySummary) } : result
  } catch (error) { return ipcFail(IpcErrorCode.Io, errorMessage(error)) }
}
export async function getAcpHistorySession(root: string, id: string): Promise<{ ok: true; version: 1; session: AcpHistorySummary } | IpcFail> {
  assertRuntimeExecutionHost()
  if (!root) return ipcFail(IpcErrorCode.NoProject, '未打开项目')
  if (!idSchema.safeParse(id).success) return ipcFail(IpcErrorCode.InvalidArg, '会话 ID 无效')
  try {
    let result = await readAcpHistorySession(root, id)
    if (!result.ok && result.code === IpcErrorCode.Io) result = snapshotHistorySession(root, id, result.error)
    return result.ok ? { ...result, session: liveHistorySummary(result.session) } : result
  } catch (error) { return ipcFail(IpcErrorCode.Io, errorMessage(error)) }
}
/** Metadata only: no transport connection, turn, transcript or permission mutation. */
export async function updateAcpHistorySession(root: string, id: string, input: unknown, isCurrent: () => boolean = () => true): Promise<AcpHistoryUpdateResult | IpcFail> {
  assertRuntimeExecutionHost()
  if (!root || !isCurrent()) return ipcFail(IpcErrorCode.NoProject, '项目已切换或未打开项目')
  const parsed = acpHistoryUpdateInputSchema.safeParse(input)
  if (!idSchema.safeParse(id).success || !parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '会话 ID 或偏好参数无效')
  const active = sessions.get(id)
  if (active && !belongs(root, active.meta)) return ipcFail(IpcErrorCode.Denied, '此会话不属于当前项目')
  const existing = await getAcpHistorySession(root, id)
  if (!isCurrent()) return ipcFail(IpcErrorCode.NoProject, '项目已切换')
  if (!existing.ok) return existing
  if (existing.session.sessionId !== id || !belongs(root, existing.session)) return ipcFail(IpcErrorCode.NotFound, '当前项目没有此会话')
  try {
    // Synchronous read/merge/atomic rename: another main-process edit cannot interleave.
    if (parsed.data.archived !== undefined) acpHandoffs.noteHumanArchiveChange(root, id)
    const preferences = updateSessionPreferences(acpDataPath(), root, id, parsed.data)
    if (!isCurrent()) return ipcFail(IpcErrorCode.NoProject, '项目已切换')
    return { ok: true, version: 1, session: applySessionPreferences(existing.session, preferences) }
  } catch (error) { return ipcFail(IpcErrorCode.Io, errorMessage(error)) }
}
export async function getAcpHistoryEvents(root: string, id: string, input?: unknown): Promise<AcpHistoryEventPage | IpcFail> {
  assertRuntimeExecutionHost()
  if (!root) return ipcFail(IpcErrorCode.NoProject, '未打开项目')
  if (!idSchema.safeParse(id).success) return ipcFail(IpcErrorCode.InvalidArg, '会话 ID 无效')
  try {
    let result = await readAcpHistoryEvents(root, id, input)
    if (!result.ok && result.code === IpcErrorCode.Io) result = snapshotHistoryEvents(root, id, input, result.error)
    if (!result.ok) return result
    const session = liveHistorySummary(result.session)
    return { ...result, session, historyPersistence: session.historyPersistence }
  } catch (error) { return ipcFail(IpcErrorCode.Io, errorMessage(error)) }
}
export async function retryAcpHistorySession(root: string, id: string): Promise<{ ok: true; historyPersistence: import('../../shared/acp-history').AcpHistoryPersistence } | IpcFail> {
  assertRuntimeExecutionHost()
  if (!root || !idSchema.safeParse(id).success) return ipcFail(IpcErrorCode.InvalidArg, '项目或会话 ID 无效')
  const active = sessions.get(id)
  if (active && !belongs(root, active.meta)) return ipcFail(IpcErrorCode.Denied, '此会话不属于当前项目')
  const existing = await getAcpHistorySession(root, id)
  if (!existing.ok) return existing
  try { await retryAcpHistory(); const saved = await getAcpHistorySession(root, id); return saved.ok ? { ok: true, historyPersistence: saved.session.historyPersistence } : saved }
  catch (error) { return ipcFail(IpcErrorCode.Io, errorMessage(error)) }
}

export function listAcpProfiles(projectRoot: string): { ok: true; profiles: AcpAgentProfile[] } | IpcFail {
  if (!projectRoot) return ipcFail(IpcErrorCode.NoProject, '未打开项目')
  try { return { ok: true, profiles: readProfiles(projectRoot) } } catch (error) { return failure(error) }
}
export function saveAcpProfile(projectRoot: string, input: unknown): { ok: true; profile: AcpAgentProfile } | IpcFail {
  assertRuntimeExecutionHost()
  if (!projectRoot) return ipcFail(IpcErrorCode.NoProject, '未打开项目')
  const parsed = profileSchema.safeParse(input)
  if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, parsed.error.issues[0]?.message ?? 'Agent 配置无效')
  try {
    prepareAgentContext(projectRoot, 'profile-validation', parsed.data)
    const profiles = readProfiles(projectRoot)
    const index = profiles.findIndex((profile) => profile.id === parsed.data.id)
    if (index >= 0) profiles[index] = { ...profiles[index], ...parsed.data }
    else profiles.push(parsed.data)
    saveProfiles(projectRoot, profiles)
    return { ok: true, profile: index >= 0 ? profiles[index] : parsed.data }
  } catch (error) { return failure(error) }
}
export function deleteAcpProfile(projectRoot: string, id: string): { ok: true } | IpcFail {
  assertRuntimeExecutionHost()
  if (!projectRoot) return ipcFail(IpcErrorCode.NoProject, '未打开项目')
  if (!idSchema.safeParse(id).success) return ipcFail(IpcErrorCode.InvalidArg, 'Agent ID 无效')
  try { saveProfiles(projectRoot, readProfiles(projectRoot).filter((profile) => profile.id !== id)); return { ok: true } }
  catch (error) { return failure(error) }
}

function settlePermissions(session: ActiveSession, reason: string): void {
  for (const pending of [...session.pendingPermissions.values()]) pending.finish({ outcome: 'cancel' }, reason)
}

const ADAPTER_LAST_ERROR_LOG = 'zcode-adapter-last-error.log'
// 仅连接断开/启动失败类错误才读适配器尸检快照（真机遗留：连接断开错误此前不带任何现场信息）。
const ADAPTER_FORENSIC_ERROR_PATTERN = /disconnected|connection[_ ]?clos|spawn|could not start|启动失败|启动超时|就绪前退出|意外退出|进程已退出/i

/** 适配器现场快照（zcode-adapter-last-error.log）尾部 ≤30 行；读失败/不存在时静默返回空。
 *  落盘位置随适配器模式：隔离启动=acpDataPath，默认真实用户态=系统临时目录（两处都探测）。 */
function zcodeDiagnosticDirectory(meta: AcpSessionRecord): string | undefined {
  if (meta.runtimeSnapshot?.id !== 'zcode' || meta.runtimeSnapshot.launchKind !== 'bundled' || !meta.connectionGeneration) return undefined
  const owner = createHash('sha256').update(`${meta.sessionId}\0${meta.connectionGeneration}`).digest('hex')
  return acpDataPath('diagnostics', owner)
}
function captureConnectionTimings(session: ActiveSession): void {
  const directory = zcodeDiagnosticDirectory(session.meta)
  const generation = session.meta.connectionGeneration
  const startedAt = session.lastStatusAt.get('connection-start')
  if (!directory || !generation || startedAt === undefined) return
  const value = readConnectionTimings(directory, startedAt)
  if (!value) return
  const connectionTimings = { ...value, connectionGeneration: generation }
  if (JSON.stringify(session.meta.connectionTimings) === JSON.stringify(connectionTimings)) return
  session.meta.connectionTimings = connectionTimings
  emit(session, 'diagnostic', '连接分阶段耗时已记录', { activityScope: 'connection', connectionTimings })
}
function adapterForensicsSuffix(session: ActiveSession, error: unknown): string {
  if (!ADAPTER_FORENSIC_ERROR_PATTERN.test(errorMessage(error))) return ''
  try {
    const directory = zcodeDiagnosticDirectory(session.meta)
    if (!directory) return ''
    const path = join(directory, ADAPTER_LAST_ERROR_LOG)
    if (!existsSync(path) || statSync(path).size > 256 * 1024) return ''
    const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => line.trim().length > 0)
    if (lines.length === 0) return ''
    const body = knowledgeMcpBridge.redactText(lines.slice(-30).join('\n').slice(-4000))
    return `；适配器现场快照${lines.length > 30 ? `（尾部 30/${lines.length} 行，truncated）` : ''}：\n${body}`
  } catch { return '' }
}

async function closeAfterFailure(session: ActiveSession, error: unknown, remove: boolean): Promise<void> {
  session.knowledge?.revoke()
  let message = knowledgeMcpBridge.redactText(errorMessage(error))
  const forensics = adapterForensicsSuffix(session, error)
  if (forensics) message += forensics
  session.meta.recovery = { ...session.meta.recovery, kind: modelUnavailable(error) ? 'model-unavailable' : 'connection-failed' }
  try {
    await session.runtime.shutdown()
    session.hasProcess = false
    session.backgroundWork = false
    session.toolStates.clear()
    session.cleanupRequired = false
    release(session)
    if (remove && sessions.get(session.meta.sessionId) === session) sessions.delete(session.meta.sessionId)
  } catch (cleanupError) {
    message += `；Runtime 清理尚未完成：${knowledgeMcpBridge.redactText(errorMessage(cleanupError))}`
    session.cleanupRequired = true
    holdCleanupBarrier(session)
    session.meta.directoryLeaseReason = '清理未确认，目录占用保留；请显式停止 Runtime 后重试'
  }
  captureConnectionTimings(session)
  setStatus(session, 'error', message, true)
}
function permissionHandler(session: ActiveSession): AcpPermissionHandler {
  return async (request, context) => {
    if (session.closing || !session.turn || session.meta.status === 'cancelling' || !session.leaseHeld || context.signal.aborted) return { outcome: 'cancel' }
    // Native identities cannot be redacted/remapped without changing the exact
    // permission decision. Reject descriptor-bearing IDs before publishing them.
    if ([request.raw.toolCall.toolCallId, ...request.raw.options.map(({ optionId }) => optionId)]
      .some((id) => knowledgeMcpBridge.redactText(id) !== id)) {
      emit(session, 'diagnostic', '权限请求包含不可公开的连接标识，已取消该权限请求')
      return { outcome: 'cancel' }
    }
    const generation = session.meta.connectionGeneration
    const turnId = session.meta.turnId
    const requestId = `perm-${randomUUID()}`
    const payload: AcpPermissionPayload = { requestId, sessionId: session.meta.sessionId, agentName: session.meta.agentName ? knowledgeMcpBridge.redactText(session.meta.agentName) : session.meta.agentName,
      projectRoot: session.meta.projectRoot, connectionGeneration: generation, turnId, expiresAt: Date.now() + PERMISSION_TIMEOUT_MS,
      toolCall: { toolCallId: request.raw.toolCall.toolCallId, title: request.raw.toolCall.title ? knowledgeMcpBridge.redactText(request.raw.toolCall.title) : undefined, kind: request.raw.toolCall.kind ?? undefined },
      // Preserve native option IDs/kinds for exact decisions while redacting
      // provider-generated labels that may echo bridge descriptors.
      options: request.raw.options.map(({ optionId, name, kind }) => ({ optionId, name: knowledgeMcpBridge.redactText(name), kind })) }
    return new Promise<AcpPermissionDecision>((resolve) => {
      let done = false
      const finish = (decision: AcpPermissionDecision, outcome: string): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        context.signal.removeEventListener('abort', onAbort)
        session.pendingPermissions.delete(requestId)
    emit(session, 'permission', outcome === 'selected' ? '权限决定已提交' : `权限请求已结束：${outcome}`, { requestId, pending: false, outcome, decision, ...('optionId' in decision ? { optionId: decision.optionId } : {}) })
        if (session.meta.connectionGeneration === generation && session.meta.turnId === turnId && session.meta.status === 'awaiting_permission') setStatus(session, 'busy')
        resolve(decision)
      }
      const onAbort = (): void => finish({ outcome: 'cancel' }, 'cancelled')
      const timer = setTimeout(() => { finish({ outcome: 'cancel' }, 'timeout'); void cancelOwned(session, '权限等待超时') }, PERMISSION_TIMEOUT_MS)
      session.pendingPermissions.set(requestId, { payload, finish })
      context.signal.addEventListener('abort', onAbort, { once: true })
      emit(session, 'permission', payload.toolCall?.title ?? '权限请求', { requestId, pending: true, permission: payload })
      setStatus(session, 'awaiting_permission')
      broadcastToWindows(ipcEvent.acpPermission, payload)
      if (context.signal.aborted) onAbort()
    })
  }
}
export function respondAcpPermission(projectRoot: string, requestId: string, optionId: string): { ok: true } | IpcFail {
  assertRuntimeExecutionHost()
  if (!projectRoot) return ipcFail(IpcErrorCode.NoProject, '未打开项目')
  for (const session of sessions.values()) {
    const pending = session.pendingPermissions.get(requestId)
    if (!pending) continue
    if (!belongs(projectRoot, session.meta)) return ipcFail(IpcErrorCode.Denied, '此权限请求不属于当前项目')
    if (pending.payload.expiresAt !== undefined && pending.payload.expiresAt <= Date.now()) { pending.finish({ outcome: 'cancel' }, 'timeout'); void cancelOwned(session, '权限等待超时'); return ipcFail(IpcErrorCode.NotFound, '权限请求已结束或超时') }
    if (session.closing || pending.payload.connectionGeneration !== session.meta.connectionGeneration || pending.payload.turnId !== session.meta.turnId) return ipcFail(IpcErrorCode.Conflict, '权限请求已失效')
    const choices = pending.payload.options.filter((option) => option.optionId === optionId)
    if (choices.length !== 1) return ipcFail(IpcErrorCode.InvalidArg, '权限选项无效或不唯一，请选择此请求提供的唯一选项')
    pending.finish({ outcome: 'selected', optionId }, 'selected')
    return { ok: true }
  }
  return ipcFail(IpcErrorCode.NotFound, '权限请求已结束或超时')
}

/** 角色配置的进程级注入：环境变量覆盖、启动参数追加。快照随会话保留，恢复时沿用原值。 */
function profileProcessEnv(profile: AcpAgentProfile | undefined): Record<string, string> | undefined {
  const entries = (profile?.env ?? []).filter((item) => item.key.trim().length > 0).map((item) => [item.key, item.value] as const)
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}
function profileExtraArgv(profile: AcpAgentProfile | undefined): string[] {
  return (profile?.args ?? []).filter((item) => item.name.trim().length > 0).flatMap((item) => item.value.trim().length > 0 ? [item.name, item.value] : [item.name])
}

async function createSessionRuntime(meta: AcpSessionRecord, config: AcpAgentConfig, argv: string[]): Promise<ActiveSession> {
  // Import original snapshots before a resumed compatibility snapshot replaces them.
  await ensureAcpHistory().catch(() => {})
  if (!('TRELLIS_ACPX_COMPAT_VERSION' in AcpxRuntime) || AcpxRuntime.TRELLIS_ACPX_COMPAT_VERSION !== 3) throw new Error('acpx 兼容补丁未准备好；请重新安装应用依赖')
  const store = createFileSessionStore({ stateDir: acpDataPath('runtime-store') })
  const modelMetadata = new ModelMetadataContext({ agentId: config.id, launchKind: config.launchKind, cwd: meta.cwd ?? meta.projectRoot, env: meta.profileSnapshot?.env, args: meta.profileSnapshot?.args })
  let session: ActiveSession
  let knowledge: KnowledgeMcpConnection | undefined
  try {
    if (!meta.connectionGeneration) throw new Error('Native connection generation unavailable')
    knowledge = await knowledgeMcpBridge.connect({ root: meta.projectRoot, sessionId: meta.sessionId, connectionGeneration: meta.connectionGeneration }, (knowledgeBridge) => {
      if (session && sessions.get(meta.sessionId) === session && (!knowledgeBridge.turnId || knowledgeBridge.turnId === session.meta.turnId)) {
        const { knowledgeOperation, ...bridgeStatus } = knowledgeBridge
        emit(session, 'diagnostic', knowledgeBridge.detail, { knowledgeBridge: bridgeStatus, ...(knowledgeOperation ? { knowledgeOperation, activityScope: 'turn' } : knowledgeBridge.operationId ? {} : { activityScope: 'connection' }) })
      }
    })
  } catch { /* Ordinary native dialogue remains usable with an explicit unavailable diagnostic. */ }
  const runtime = createAcpRuntime({ cwd: meta.cwd ?? meta.projectRoot,
    agentProcessEnv: { ...profileProcessEnv(meta.profileSnapshot),
      ...(zcodeDiagnosticDirectory(meta) ? { TRELLIS_ZCODE_DIAGNOSTICS_DIR: zcodeDiagnosticDirectory(meta),
        TRELLIS_ZCODE_STARTUP_CACHE_DIR: zcodeStartupCacheDirectory() } : {}) },
    agentRegistry: createAgentRegistry({ overrides: { [config.id]: [...argv, ...profileExtraArgv(meta.profileSnapshot)] } }),
    sessionStore: { load: async (id) => upgradeLegacyKnowledgePolicy(await store.load(id), meta.profileSnapshot?.instructions), save: async (record) => {
      const safe = knowledgeMcpBridge.redact(record)
      await store.save(safe)
      if (session) syncRecord(session, safe)
    } },
    permissionMode: 'deny-all', nonInteractivePermissions: 'deny', timeoutMs: 30_000,
    mcpServers: (context) => {
      if (!knowledge || context.sessionKey !== meta.sessionId) return []
      try { return knowledge.servers() }
      catch {
        emit(session, 'diagnostic', 'Knowledge bridge unavailable; knowledge sources have not been checked', { knowledgeBridge: { state: 'unavailable', detail: 'Knowledge bridge unavailable; reconnect the native session or restart the application' }, activityScope: 'connection' })
        return []
      }
    },
    // Optional client services use a separate policy from per-turn permissions.
    // Current profiles use adapter-native tools, mediated by the callback below.
    fs: false, terminal: false,
    processLifecycle: {
      onBeforeSpawn: () => {
        if (shuttingDown || session.closing) throw new Error('会话已停止')
        const conflict = acquire(session)
        if (conflict) throw new Error(conflict.error)
        modelMetadata.capture(session.meta.connectionGeneration)
        session.lastStatusAt.set('process-start', Date.now())
        observe(session, '启动 Runtime')
      },
      onSpawned: () => { session.hasProcess = true; session.disconnected = false; observe(session, 'Runtime 进程已启动', session.lastStatusAt.get('process-start')) },
      onSpawnFailed: (error) => observe(session, `Runtime 启动失败：${errorMessage(error.error)}`, undefined, true),
      onExit: () => {
        session.knowledge?.disconnect()
        session.hasProcess = false
        session.disconnected = true
        session.backgroundWork = false
        session.toolStates.clear()
        settlePermissions(session, 'disconnected')
        if (!session.turn && !session.closing && !session.settling && session.meta.status !== 'starting') { release(session); setStatus(session, 'disconnected', 'Runtime 进程已退出', true) }
      }
    }
  })
  session = { meta, runtime, modelMetadata, knowledge, nativePersistenceConfirmed: false, knowledgeSupport: 'unknown', nativeCommands: new Set(), accepting: false, closing: false, disconnected: false, pendingPermissions: new Map(), lastStatusAt: new Map(), hasProcess: false, backgroundWork: false, toolStates: new Map(), leaseHeld: false, leaseMode: 'shared', uncertainWork: false, lastUsedAt: Date.now(), settling: false, snapshotDirty: 0 }
  return session
}

function describeClientServices(session: ActiveSession): void {
  emit(session, 'diagnostic', NATIVE_TOOLS_DIAGNOSTIC, { toolExecution: 'adapter-native', clientServices: { fs: false, terminal: false }, activityScope: 'connection' })
  if (!session.knowledge) emit(session, 'diagnostic', 'Knowledge bridge unavailable; ordinary dialogue can continue without verified knowledge', { knowledgeBridge: { state: 'unavailable', detail: 'Loopback knowledge bridge could not start; sources have not been checked' }, activityScope: 'connection' })
}

async function refreshSessionMetadata(session: ActiveSession): Promise<void> {
  if (!session.handle) return
  const handle = session.handle
  const generation = session.meta.connectionGeneration
  const assertCurrent = (): void => { if (session.closing || session.handle !== handle || session.meta.connectionGeneration !== generation) throw new Error('会话连接已变化') }
  const capabilities = await session.runtime.getCapabilities({ handle })
  assertCurrent()
  session.meta.capabilities = { ...session.meta.capabilities, controls: capabilities.controls }
  const status = await session.runtime.getStatus({ handle })
  assertCurrent()
  if (status.availableCommands) session.nativeCommands = new Set(status.availableCommands.map((command) => command.name.replace(/^\//, '')))
  if (status.models) {
    session.meta.models = status.models.availableModels ?? status.models.availableModelIds.map((modelId) => ({ modelId, name: modelId }))
    session.meta.currentModelId = status.models.currentModelId
  }
  projectCategorizedSelections(session.meta)
  session.modelMetadata.project(session.meta, true)
  const mcp = session.raw?.agentCapabilities?.mcpCapabilities
  const support = mcp?.http === true ? 'http' : mcp?.http === false || mcp?.sse === true || mcp?.acp === true ? 'unsupported' : 'unknown'
  if (support === 'unsupported' && session.knowledgeSupport !== support && session.knowledge) {
    session.knowledge.disconnect()
    emit(session, 'diagnostic', 'Native engine does not support the HTTP knowledge bridge; ordinary dialogue remains available', {
      knowledgeBridge: { state: 'unavailable', detail: 'Native MCP capabilities do not support these HTTP knowledge tools; no automatic project lookup was performed' }, activityScope: 'connection'
    })
  }
  session.knowledgeSupport = support
}

export function newAcpSession(projectRoot: string, input: unknown): Promise<{ ok: true; sessionId: string } | IpcFail> {
  assertRuntimeExecutionHost()
  const pending = newOwnedAcpSession(projectRoot, input)
  creatingRequests.add(pending)
  void pending.finally(() => creatingRequests.delete(pending)).catch(() => {})
  return pending
}
interface HandoffNewSession {
  sessionId: string; profile?: AcpAgentProfile; cwd: string; plan: HandoffTargetPlan; origin: AcpHandoffOrigin
  assertCurrent(): void; beforeNativeCreate(): void
}
async function newOwnedAcpSession(projectRoot: string, input: unknown, handoff?: HandoffNewSession): Promise<{ ok: true; sessionId: string } | IpcFail> {
  assertRuntimeExecutionHost()
  if (!projectRoot) return ipcFail(IpcErrorCode.NoProject, '未打开项目')
  const parsed = newSessionSchema.safeParse(input)
  if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, parsed.error.issues[0]?.message ?? '启动参数无效')
  if (shuttingDown) return ipcFail(IpcErrorCode.Conflict, '后台正在停止，未创建新会话')
  let reservation: symbol | undefined
  let preparingTarget: ActiveSession | undefined
  try {
    handoff?.assertCurrent()
    const { agentId, profileId, taskDir } = parsed.data
    const profile = handoff ? handoff.profile : profileId ? readProfiles(projectRoot).find((item) => item.id === profileId) : undefined
    if (profileId && !profile) return ipcFail(IpcErrorCode.NotFound, 'Agent 配置不存在')
    const runtimeId = handoff?.plan.config.id ?? profile?.runtimeId ?? agentId
    const launch = handoff?.plan ?? await resolveAcpRuntimeLaunch(runtimeId)
    if ('ok' in launch) return launch
    const { config, argv } = launch
    const cwd = handoff?.cwd ?? (profile?.cwd || projectRoot)
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return ipcFail(IpcErrorCode.NotFound, '工作目录不可用')
    if (taskDir && !await activeTaskExists(projectRoot, taskDir)) return ipcFail(IpcErrorCode.InvalidArg, '绑定任务不属于当前项目的活动任务目录或记录不可读')
    const slot = await reserveConnectionSlot()
    if (typeof slot !== 'symbol') return slot
    reservation = slot
    handoff?.assertCurrent()
    if (handoff && sessions.has(handoff.sessionId)) throw new Error('交接目标已拥有连接，未重复创建')
    const meta: AcpSessionRecord = { schemaVersion: 2, sessionId: handoff?.sessionId ?? `acp-${randomUUID()}`, agentId: runtimeId, agentName: profile?.name ?? config.name,
      projectRoot, cwd, taskDir, status: 'starting', startedAt: Date.now(), events: [], startup: [], connectionGeneration: randomUUID(),
      profileSnapshot: profile, handoff: handoff?.origin,
      runtimeSnapshot: { id: config.id, name: config.name, command: config.command, enabled: config.enabled, launchKind: config.launchKind, executable: config.executable, args: config.args }, historyKind: 'live', canResume: false }
    const session = await createSessionRuntime(meta, config, argv)
    preparingTarget = handoff ? session : undefined
    handoff?.assertCurrent()
    if (shuttingDown) { session.knowledge?.revoke(); await session.runtime.shutdown(); return ipcFail(IpcErrorCode.Conflict, '后台正在停止，未创建新连接') }
    const conflict = acquire(session)
    if (conflict) { session.knowledge?.revoke(); await session.runtime.shutdown(); return conflict }
    sessions.set(meta.sessionId, session)
    connectionReservations.delete(reservation); reservation = undefined
    session.lastStatusAt.set('connection-start', Date.now())
    observe(session, '开始准备会话')
    describeClientServices(session)
    setStatus(session, 'starting')
    session.preparing = (async () => {
      try {
        handoff?.beforeNativeCreate()
        session.handle = await session.runtime.ensureSession({ sessionKey: meta.sessionId, agent: runtimeId, cwd, mode: 'persistent' })
        handoff?.assertCurrent()
        if (session.closing) { await session.runtime.shutdown(); return }
        await refreshSessionMetadata(session)
        captureConnectionTimings(session)
        observe(session, 'ACP 会话已就绪', session.lastStatusAt.get('connection-start'))
        release(session)
        setStatus(session, 'ready')
      } catch (error) {
        if (session.closing) return
        observe(session, `会话准备失败：${errorMessage(error)}`, meta.startedAt, true)
        await closeAfterFailure(session, error, true)
      }
    })()
    return { ok: true, sessionId: meta.sessionId }
  } catch (error) {
    if (preparingTarget) {
      preparingTarget.knowledge?.revoke()
      try { await preparingTarget.runtime.shutdown() }
      catch (cleanup) { return failure(new Error(`${errorMessage(error)}；目标清理尚未确认：${errorMessage(cleanup)}`)) }
    }
    return failure(error)
  }
  finally { if (reservation) connectionReservations.delete(reservation) }
}

function mapEvent(session: ActiveSession, event: AcpRuntimeEvent): void {
  if (session.closing) return
  if (event.type === 'status' && event.tag === 'available_commands_update' && event.availableCommands) session.nativeCommands = new Set(event.availableCommands.map((command) => command.name.replace(/^\//, '')))
  const isModelResponse = (event.type === 'text_delta' && event.text.trim().length > 0) || event.type === 'tool_call' || (event.type === 'status' && event.tag === 'plan')
  if (!session.firstResponseAt && isModelResponse) { session.firstResponseAt = Date.now(); observe(session, '收到首次模型响应', session.turnStartedAt, false, 'turn') }
  if (event.type === 'text_delta') emit(session, event.stream === 'thought' ? 'thought' : 'message', event.text, { messageId: event.messageId, meta: event.meta })
  else if (event.type === 'tool_call') {
    if (event.toolCallId) {
      if (event.status === 'completed' || event.status === 'failed') session.toolStates.set(event.toolCallId, 'settled')
      else if (event.tag === 'tool_call' || event.status === 'pending' || event.status === 'in_progress' || !session.toolStates.has(event.toolCallId)) session.toolStates.set(event.toolCallId, 'unfinished')
      // A partial without status, or an unknown status, cannot erase prior state.
    }
    const input = objectValue(event.rawInput)
    const output = objectValue(event.rawOutput)
    if (input.run_in_background === true || output.task_id || output.background === true) session.backgroundWork = true
    emit(session, 'tool-call', event.title ?? event.text, { ...event })
  } else if (event.type === 'status') emit(session, 'rawUpdate' in event ? 'diagnostic' : event.tag === 'plan' ? 'plan' : event.tag === 'config_option_update' || event.tag === 'current_mode_update' ? 'config' : 'session-status', event.text, { ...event })
  else if (event.type === 'error') emit(session, 'diagnostic', event.message, { ...event })
  else emit(session, 'diagnostic', 'Runtime 更新', { ...event })
}

export async function bindAcpSessionTask(projectRoot: string, sessionId: string, input: AcpBindTaskInput, isCurrent?: () => boolean): Promise<{ ok: true; session: AcpSessionRecord } | IpcFail> {
  assertRuntimeExecutionHost()
  const session = owned(projectRoot, sessionId)
  if ('ok' in session) return session
  const handoffConflict = handoffMutationConflict(projectRoot, sessionId)
  if (handoffConflict) return handoffConflict
  const parsed = bindTaskSchema.safeParse(input)
  if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '任务绑定参数无效')
  if (parsed.data.expectedConnectionGeneration !== session.meta.connectionGeneration) return ipcFail(IpcErrorCode.Conflict, '会话连接已改变，请重新选择')
  if (session.meta.status !== 'ready' || session.accepting || session.turn || session.closing || session.pendingPermissions.size > 0) return ipcFail(IpcErrorCode.Conflict, '请在空闲且就绪的会话绑定任务')
  session.accepting = true
  try {
    if (parsed.data.taskDir !== null && !await activeTaskExists(projectRoot, parsed.data.taskDir)) return ipcFail(IpcErrorCode.InvalidArg, '当前项目没有此活动任务或任务记录不可读')
    if (isCurrent?.() === false || sessions.get(sessionId) !== session || session.closing || session.meta.connectionGeneration !== parsed.data.expectedConnectionGeneration) return ipcFail(IpcErrorCode.Conflict, '项目或会话已改变，未应用任务绑定')
    const previousTaskDir = session.meta.taskDir
    session.meta.taskDir = parsed.data.taskDir ?? undefined
    // Earlier event/task/material snapshots retain their original provenance.
    emit(session, 'session-status', parsed.data.taskDir ? `已关联任务：${parsed.data.taskDir}（后续发送生效）` : '已解除任务关联（后续发送生效）',
      { binding: { previousTaskDir, taskDir: parsed.data.taskDir, source: 'user' } })
    setStatus(session, 'ready')
    return { ok: true, session: session.meta }
  } catch (error) { return failure(error) }
  finally { session.accepting = false }
}

export async function promptAcpSession(projectRoot: string, sessionId: string, text: string, options?: AcpPromptOptions, isCurrent?: () => boolean, projectGeneration = 0, workflow?: WorkflowPreparedPrompt): Promise<{ ok: true; turnId: string } | IpcFail> {
  assertRuntimeExecutionHost()
  const live = sessions.get(sessionId)
  const mayRejectPrepared = live && belongs(projectRoot, live.meta) && !live.accepting && !live.turn && !live.closing
  const result = await promptOwnedAcpSession(projectRoot, sessionId, text, options, isCurrent, projectGeneration, workflow)
  if (!result.ok && mayRejectPrepared) {
    try { acpHandoffs.admissionFailed(projectRoot, sessionId, result.error) }
    catch (error) { return failure(new Error(`${result.error}；交接恢复失败：${errorMessage(error)}`)) }
  }
  return result
}
async function promptOwnedAcpSession(projectRoot: string, sessionId: string, text: string, options?: AcpPromptOptions, isCurrent?: () => boolean, projectGeneration = 0, workflow?: WorkflowPreparedPrompt): Promise<{ ok: true; turnId: string } | IpcFail> {
  assertRuntimeExecutionHost()
  const session = owned(projectRoot, sessionId)
  if ('ok' in session) return session
  const handoffConflict = handoffMutationConflict(projectRoot, sessionId)
  if (handoffConflict) return handoffConflict
  if (session.accepting || session.turn || session.closing || (session.meta.status !== 'ready' && !(session.meta.status === 'disconnected' && session.meta.restorePending))) return ipcFail(IpcErrorCode.Conflict, `当前不能发送：${session.meta.status}`)
  if (typeof text !== 'string' || text.length > 200000) return ipcFail(IpcErrorCode.InvalidArg, '发送内容无效或过长')
  if (!session.handle) return ipcFail(IpcErrorCode.Conflict, '会话尚未准备好')
  const parsedOptions = promptOptionsSchema.safeParse(options ?? {})
  if (!parsedOptions.success) return ipcFail(IpcErrorCode.InvalidArg, parsedOptions.error.issues[0]?.message ?? '文档引用或发送参数无效')
  const { sourceReferences = [], images = [], expectedConnectionGeneration } = parsedOptions.data
  if (!text.trim() && images.length === 0) return ipcFail(IpcErrorCode.InvalidArg, '请先输入内容或添加图片')
  if (images.length && session.raw?.agentCapabilities?.promptCapabilities?.image !== true) return ipcFail(IpcErrorCode.InvalidArg, '当前执行引擎未声明支持图片输入，请切换支持图片的会话；图片尚未发送')
  const generation = session.meta.connectionGeneration
  if (!generation) return ipcFail(IpcErrorCode.Conflict, '会话缺少连接标识，请重新连接后发送')
  const backendSessionId = session.handle.backendSessionId
  if (expectedConnectionGeneration !== undefined && expectedConnectionGeneration !== generation) return ipcFail(IpcErrorCode.Conflict, '会话连接已改变，请重新选择发送目标', { reason: 'SCOPE_CHANGED' })
  for (const reference of sourceReferences) {
    if (!sourceBelongs(projectRoot, session.meta.taskDir, reference) || reference.targetSessionId !== sessionId) return ipcFail(IpcErrorCode.Denied, '文档引用不属于此项目、任务或会话')
    if ((reference.targetConnectionGeneration ?? expectedConnectionGeneration) !== generation) return ipcFail(IpcErrorCode.Conflict, '文档引用的会话连接已改变', { reason: 'SCOPE_CHANGED' })
  }
  const conflict = acquire(session, workflow ? 'exclusive' : 'shared')
  if (conflict) return conflict
  session.lastUsedAt = Date.now()
  session.accepting = true
  const abort = new AbortController()
  session.promptAbort = abort
  const turnId = `turn-${randomUUID()}`
  const trimmed = text.trim()
  const nativeCommand = !workflow && images.length === 0 && sourceReferences.length === 0 && trimmed.startsWith('/') && session.nativeCommands.has(trimmed.slice(1).split(/\s/, 1)[0])
  let promptWritten = false
  let agentContext: PreparedAgentContext | undefined
  let handoffContext: PreparedHandoff | undefined
  const ownerCurrent = (): boolean => isCurrent?.() !== false && sessions.get(sessionId) === session && session.meta.connectionGeneration === generation && session.meta.turnId === turnId && session.accepting && !session.closing && !shuttingDown && (!session.disconnected || session.meta.restorePending === true) && (session.meta.status === 'busy' || session.meta.status === 'awaiting_permission')
  const active = (): boolean => !abort.signal.aborted && ownerCurrent()
  const assertActive = (): void => {
    if (!active()) throw new Error('发送前项目或会话已改变；内容尚未发送')
    workflow?.assertActive()
    agentContext?.assertCurrent()
    handoffContext?.assertCurrent()
  }
  try {
    // Backend-only managed packets contain already verified immutable bytes. UI
    // callers retain the normal source-checking path and cannot set this value.
    workflow?.assertActive()
    const prepared = workflow ? structuredClone(workflow.materials) : await preparePromptMaterials(projectRoot, nativeCommand ? undefined : session.meta.taskDir, sourceReferences)
    if (abort.signal.aborted || isCurrent?.() === false || sessions.get(sessionId) !== session || session.closing || shuttingDown || session.meta.connectionGeneration !== generation) {
      session.accepting = false; release(session)
      return ipcFail(IpcErrorCode.Conflict, '发送前项目或会话已改变；内容尚未发送', { reason: 'SCOPE_CHANGED' })
    }
    if (prepared.changed.length > 0) {
      session.accepting = false; release(session)
      return ipcFail(IpcErrorCode.Conflict, '引用文档已改变或不可读，请查看最新版本后再发送', { reason: 'SOURCE_CHANGED', sources: prepared.changed })
    }
    try {
      if (!nativeCommand) agentContext = prepareAgentContext(projectRoot, sessionId, session.meta.profileSnapshot)
    } catch (error) {
      session.accepting = false; release(session)
      return ipcFail(IpcErrorCode.InvalidArg, errorMessage(error))
    }
    if (agentContext && session.meta.capabilities?.promptCapabilities?.embeddedContext !== true) {
      session.accepting = false; release(session)
      return ipcFail(IpcErrorCode.InvalidArg, '当前引擎未声明支持角色上下文附件，角色指令和绑定技能未发送。请选择支持该能力的引擎，或使用引擎原生的项目规范。')
    }
    handoffContext = await acpHandoffs.preparePrompt(projectRoot, sessionId)
    if (abort.signal.aborted || isCurrent?.() === false || sessions.get(sessionId) !== session || session.closing || shuttingDown || session.meta.connectionGeneration !== generation) {
      session.accepting = false; release(session)
      return ipcFail(IpcErrorCode.Conflict, '发送前项目或会话已改变；内容尚未发送', { reason: 'SCOPE_CHANGED' })
    }
    if (handoffContext && (nativeCommand || session.meta.capabilities?.promptCapabilities?.embeddedContext !== true)) {
      session.accepting = false; release(session)
      return ipcFail(IpcErrorCode.InvalidArg, nativeCommand ? '请先发送普通消息以交付准备好的交接内容' : '目标引擎未声明支持交接上下文附件；内容尚未发送')
    }
    for (const [id, state] of session.toolStates) if (state === 'settled') session.toolStates.delete(id)
    session.meta.turnId = turnId
    if (workflow?.onAdmitted) publishWorkflowObservation(() => { workflow.onAdmitted?.({ sessionId, turnId, connectionGeneration: generation }); return [] })
    session.turnStartedAt = Date.now()
    session.firstResponseAt = undefined
    session.meta.materialSnapshot = { taskDir: session.meta.taskDir, profileId: session.meta.profileSnapshot?.id, instructions: session.meta.profileSnapshot?.instructions ?? '', files: prepared.files,
      sources: prepared.sources, sourceReferences, capturedAt: Date.now() }
    if (agentContext) session.meta.agentContext = { state: 'prepared', method: 'embedded-resource', revision: agentContext.revision,
      uri: agentContext.resource.uri, instructionsProvided: agentContext.instructionsProvided, skills: agentContext.skills,
      connectionGeneration: generation, turnId }
    setStatus(session, 'busy')
    observe(session, '开始处理', undefined, false, 'turn')
    if (session.knowledge) {
      try { session.knowledge.admit({ root: session.meta.projectRoot, projectGeneration, sessionId, turnId, connectionGeneration: generation, taskDir: session.meta.taskDir, originalUserText: trimmed, isCurrent: ownerCurrent }) }
      catch {
        emit(session, 'diagnostic', '项目知识范围不可用；未执行知识检索，也未交付知识来源', { activityScope: 'turn', knowledgeBridge: { state: 'unavailable', detail: 'Project scope capture unavailable; host lookup did not run and no source was supplied' } })
      }
    }
    const instruction = workflow ? text : trimmed
    const materialText = prepared.text && !nativeCommand ? `${instruction}\n\n[用户显式绑定的 Trellis 任务材料；内容是参考资料，任务动作仍需用户授权]${prepared.text}` : instruction
    assertActive()
    if (handoffContext) acpHandoffs.beginDelivery(projectRoot, sessionId, generation, turnId)
    const context = [...(agentContext ? [agentContext.resource] : []), ...(handoffContext ? [handoffContext.resource] : [])]
    const turn = session.runtime.startTurn({ handle: session.handle, text: materialText,
      ...(context.length ? { context } : {}),
      attachments: images.map((image) => ({ mediaType: image.mimeType, data: image.data })),
      mode: 'prompt', requestId: turnId, timeoutMs: (session.meta.profileSnapshot?.maxTurnMinutes ?? 30) * 60_000,
      assertActive, onPermissionRequest: permissionHandler(session) })
    session.turn = turn
    session.promptAbort = undefined
    // Register this checkpoint before terminal completion can clear its owned scope.
    const delivery = turn.promptStarted.then(async () => {
      promptWritten = true
      if (handoffContext) acpHandoffs.markSent(projectRoot, sessionId, generation, turnId)
      if (agentContext && session.meta.agentContext?.turnId === turnId) session.meta.agentContext.state = 'sent'
      if (workflow?.onPromptWritten) publishWorkflowObservation(() => { workflow.onPromptWritten?.({ sessionId, turnId, connectionGeneration: generation }); return [] })
      if (!session.closing && session.meta.turnId === turnId && session.meta.connectionGeneration === generation) observe(session, '指令已发送至引擎', session.turnStartedAt, false, 'turn')
      if (session.meta.restorePending) { session.meta.restorePending = false; observe(session, '原生会话恢复已验证') }
      emit(session, 'message', trimmed, { role: 'user', materialSnapshot: session.meta.materialSnapshot,
        ...(agentContext ? { agentContext: session.meta.agentContext } : {}), ...(images.length ? { images } : {}) })
      if (!session.meta.title) session.meta.title = (trimmed || images[0]?.name || '图片消息').slice(0, 40)
      save(session)
    }).catch((error) => {
      if (handoffContext && !promptWritten) acpHandoffs.notSent(projectRoot, sessionId, generation, turnId, errorMessage(error))
      if (agentContext && session.meta.agentContext?.turnId === turnId) session.meta.agentContext.state = 'not_sent'
      throw error
    })
    void delivery.catch(() => {})
    // Drain immediately; canonical turn.result owns final checkpoint and process cleanup.
    const drain = (async () => { for await (const event of turn.events) mapEvent(session, event) })()
    const completion = (async () => {
      try {
        const result = await turn.result
        await delivery.catch(() => {})
        session.knowledge?.endTurn()
        await drain
        settlePermissions(session, 'turn-ended')
        // Native ordinary input awaits session persistence before execution;
        // canonical result also waits for the final runtime checkpoint. Helpers,
        // partial output, failure and cancellation establish no such proof.
        if (promptWritten && !trimmed.startsWith('/') && result.status === 'completed' && result.stopReason === 'end_turn'
          && !session.closing && sessions.get(sessionId) === session && session.meta.connectionGeneration === generation
          && session.meta.turnId === turnId && backendSessionId && session.handle?.backendSessionId === backendSessionId
          && session.meta.backendSessionId === backendSessionId) session.nativePersistenceConfirmed = true
        emit(session, 'turn-done', result.status === 'failed' ? result.error.message : result.status === 'cancelled' ? '回合已取消' : '回合已结束', { result, stopReason: result.status !== 'failed' ? result.stopReason : undefined })
        await flushAcpHistory().catch(() => {})
        session.turn = undefined
        session.accepting = false
        release(session)
        if (!session.closing) {
          await refreshSessionMetadata(session)
          // A failed model/provider request does not end the persistent ACP
          // connection. Keep configuration and the next explicit turn usable.
          setStatus(session, session.disconnected ? 'disconnected' : 'ready', result.status === 'failed' ? errorMessage(result.error.message) : undefined)
          broadcastToWindows(ipcEvent.acpDone, { sessionId, projectRoot, turnId, connectionGeneration: session.meta.connectionGeneration, status: session.meta.status, result: knowledgeMcpBridge.redact(result) })
        }
      } catch (error) {
        await delivery.catch(() => {})
        session.knowledge?.endTurn()
        session.settling = true
        session.turn = undefined; session.accepting = false; settlePermissions(session, 'failed')
        if (!session.closing) await closeAfterFailure(session, error, false)
        session.settling = false
      }
    })()
    // Observe the completion promise immediately to avoid unhandled teardown rejection.
    void completion.catch((error) => { emit(session, 'diagnostic', errorMessage(error)); save(session) })
    await delivery
    return { ok: true, turnId }
  } catch (error) {
    if (handoffContext && !promptWritten) acpHandoffs.notSent(projectRoot, sessionId, generation, turnId, errorMessage(error))
    if (!promptWritten && agentContext && session.meta.agentContext?.turnId === turnId) session.meta.agentContext.state = 'not_sent'
    session.knowledge?.endTurn()
    session.accepting = false
    if (!session.turn) { release(session); if (!session.closing) setStatus(session, abort.signal.aborted || isCurrent?.() === false ? session.disconnected ? 'disconnected' : 'ready' : 'error', errorMessage(error)) }
    return failure(error)
  } finally { if (session.promptAbort === abort) session.promptAbort = undefined }
}

async function cancelOwned(session: ActiveSession, reason: string): Promise<{ ok: true } | IpcFail> {
  if (session.closing) return { ok: true }
  if (session.meta.status === 'starting') return killOwned(session, reason)
  const turn = session.turn
  if (!turn && session.promptAbort) { session.promptAbort.abort(); return { ok: true } }
  if (!turn) return ipcFail(IpcErrorCode.Conflict, '当前没有运行中的回合')
  session.knowledge?.endTurn()
  setStatus(session, 'cancelling')
  settlePermissions(session, 'cancelled')
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([turn.cancel({ reason }).then(() => turn.result), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('取消超过 10 秒，正在停止 Runtime')), CANCEL_TIMEOUT_MS) })])
    return { ok: true }
  } catch (error) {
    emit(session, 'diagnostic', errorMessage(error))
    return killOwned(session, '取消未及时确认，已停止 Runtime')
  } finally { if (timer) clearTimeout(timer) }
}
export async function cancelAcpSession(projectRoot: string, sessionId: string): Promise<{ ok: true } | IpcFail> {
  assertRuntimeExecutionHost()
  const session = owned(projectRoot, sessionId)
  return 'ok' in session ? session : cancelOwned(session, '用户取消')
}
async function killOwned(session: ActiveSession, reason: string, finalState: 'closed' | 'disconnected' = 'closed'): Promise<{ ok: true } | IpcFail> {
  if (session.closingTask) {
    if (finalState === 'closed') session.disconnectOnClose = false
    return session.closingTask
  }
  session.disconnectOnClose = finalState === 'disconnected'
  session.knowledge?.revoke()
  session.closing = true
  session.closingTask = closeOwned(session, reason).then((result) => {
    if (!result.ok) {
      // The runtime retains failed cleanup ownership; a later explicit stop or
      // application-quit retry must be able to ask it to join cleanup again.
      session.closingTask = undefined
      session.closing = false
    }
    return result
  })
  return session.closingTask
}
async function closeOwned(session: ActiveSession, reason: string): Promise<{ ok: true } | IpcFail> {
  setStatus(session, 'cancelling')
  settlePermissions(session, 'stopped')
  try {
    await session.runtime.shutdown()
    await session.preparing
    session.hasProcess = false
    session.cleanupRequired = false
    session.backgroundWork = false
    session.toolStates.clear()
    release(session)
    sessions.delete(session.meta.sessionId)
    session.meta.historyKind = session.meta.canResume ? 'resumable' : 'transcript'
    const disconnected = session.disconnectOnClose === true
    session.disconnected = disconnected
    if (disconnected) session.meta.endedAt = undefined
    setStatus(session, disconnected ? 'disconnected' : 'closed', undefined, !disconnected)
    emit(session, 'session-status', reason, { activityScope: 'connection' })
    save(session)
    await flushAcpHistory().catch(() => {})
    return { ok: true }
  } catch (error) {
    session.cleanupRequired = true
    holdCleanupBarrier(session)
    session.meta.directoryLeaseReason = '停止清理尚未确认，目录占用保留；请重试结束会话'
    setStatus(session, 'error', `停止失败：${errorMessage(error)}`)
    return failure(error)
  }
}
export async function killAcpSession(projectRoot: string, sessionId: string): Promise<{ ok: true } | IpcFail> {
  assertRuntimeExecutionHost()
  if (!projectRoot) return ipcFail(IpcErrorCode.NoProject, '未打开项目')
  const pendingResume = resumeRequests.get(sessionId)
  if (pendingResume) {
    if (pendingResume.root !== canonicalDirectory(projectRoot)) return ipcFail(IpcErrorCode.Denied, '此会话不属于当前项目')
    cancelledResumes.add(sessionId)
    if (!sessions.has(sessionId)) { await pendingResume.promise; return { ok: true } }
  }
  const recovery = recoveryRequests.get(sessionId)
  if (recovery) {
    if (recovery.root !== canonicalDirectory(projectRoot)) return ipcFail(IpcErrorCode.Denied, '此会话不属于当前项目')
    recovery.operation.cancelled = true
    if (!sessions.has(sessionId)) { await recovery.promise; return { ok: true } }
  }
  const session = owned(projectRoot, sessionId)
  return 'ok' in session ? session : killOwned(session, '会话已停止')
}

export function resumeAcpSession(projectRoot: string, sessionId: string): Promise<ResumeResult> {
  assertRuntimeExecutionHost()
  if (!projectRoot) return Promise.resolve(ipcFail(IpcErrorCode.NoProject, '未打开项目'))
  if (!idSchema.safeParse(sessionId).success) return Promise.resolve(ipcFail(IpcErrorCode.InvalidArg, '会话 ID 无效'))
  const handoffConflict = handoffMutationConflict(projectRoot, sessionId)
  if (handoffConflict) return Promise.resolve(handoffConflict)
  const root = canonicalDirectory(projectRoot)
  if (recoveryRequests.has(sessionId)) return Promise.resolve(ipcFail(IpcErrorCode.Conflict, '此会话正在验证模型，请等待当前请求完成'))
  const pending = resumeRequests.get(sessionId)
  if (pending) return pending.root !== root ? Promise.resolve(ipcFail(IpcErrorCode.Denied, '此会话不属于当前项目'))
    : cancelledResumes.has(sessionId) ? Promise.resolve(ipcFail(IpcErrorCode.Conflict, '原连接正在停止，请等待完成后再发送')) : pending.promise
  cancelledResumes.delete(sessionId)
  const promise: Promise<ResumeResult> = resumeOwnedSession(projectRoot, sessionId).then(result => {
    if (!result.ok) acpHandoffs.admissionFailed(projectRoot, sessionId, result.error)
    return result
  }).finally(() => {
    if (resumeRequests.get(sessionId)?.promise === promise) { resumeRequests.delete(sessionId); cancelledResumes.delete(sessionId) }
  })
  resumeRequests.set(sessionId, { root, promise })
  return promise
}

interface ModelRecoveryOperation {
  input: AcpRecoverModelInput
  isCurrent?: () => boolean
  cancelled?: boolean
  modelConfirmed?: boolean
}

/** Separate from normal configuration: cold controls must never imply a ready connection. */
export function recoverAcpSessionModel(projectRoot: string, sessionId: string, input: AcpRecoverModelInput, isCurrent?: () => boolean): Promise<AcpRecoverModelResult> {
  assertRuntimeExecutionHost()
  const reject = (code: typeof IpcErrorCode[keyof typeof IpcErrorCode], message: string): Promise<AcpRecoverModelResult> => Promise.resolve(ipcFail(code, message))
  if (!projectRoot) return reject(IpcErrorCode.NoProject, '未打开项目')
  if (!idSchema.safeParse(sessionId).success || !input || typeof input.modelId !== 'string' || !input.modelId.trim() || input.modelId.length > 512 || typeof input.expectedConnectionGeneration !== 'string' || !input.expectedConnectionGeneration) return reject(IpcErrorCode.InvalidArg, '模型恢复参数无效')
  const root = canonicalDirectory(projectRoot)
  const pending = recoveryRequests.get(sessionId)
  if (pending) {
    if (pending.root !== root) return reject(IpcErrorCode.Denied, '此会话不属于当前项目')
    return pending.operation.input.modelId === input.modelId && pending.operation.input.expectedConnectionGeneration === input.expectedConnectionGeneration
      ? pending.promise : reject(IpcErrorCode.Conflict, '此会话正在验证另一个模型，请等待当前请求完成')
  }
  if (resumeRequests.has(sessionId) || resuming.has(sessionId)) return reject(IpcErrorCode.Conflict, '此会话正在连接，请等待当前请求完成')
  const meta = sessions.get(sessionId)?.meta ?? readRecords().find((record) => record.sessionId === sessionId)
  if (!meta || !belongs(projectRoot, meta)) return reject(IpcErrorCode.NotFound, '当前项目没有此会话')
  if (meta.connectionGeneration !== input.expectedConnectionGeneration || isCurrent?.() === false) return reject(IpcErrorCode.Conflict, '项目或会话连接已改变，请重新选择')
  if (!['error', 'disconnected', 'closed'].includes(meta.status) || !meta.canResume) return reject(IpcErrorCode.Conflict, '请在已断开的原会话中恢复模型')
  const categorized = meta.configOptions?.filter((option) => option.category === 'model') ?? []
  const candidates = categorized.length === 1 ? categorized[0].options.map((option) => option.value) : meta.models?.map((model) => model.modelId) ?? []
  if (!candidates.includes(input.modelId)) return reject(IpcErrorCode.InvalidArg, '请选择此会话上次引擎提供的完整模型 ID；新模型需要执行引擎重新确认')
  const operation: ModelRecoveryOperation = { input: { ...input }, isCurrent }
  const promise: Promise<AcpRecoverModelResult> = (async (): Promise<AcpRecoverModelResult> => {
    const result = await resumeOwnedSession(projectRoot, sessionId, operation)
    const restored = sessions.get(sessionId)?.meta ?? readRecords().find((record) => record.sessionId === sessionId)
    const modelConfirmed = operation.modelConfirmed === true
    if (!result.ok) return { ...result, modelConfirmed, session: restored }
    if (!restored) return ipcFail(IpcErrorCode.Conflict, '会话恢复已停止')
    return { ok: true, sessionId, modelConfirmed, session: restored }
  })().finally(() => { if (recoveryRequests.get(sessionId)?.promise === promise) recoveryRequests.delete(sessionId) })
  recoveryRequests.set(sessionId, { root, operation, promise })
  return promise
}

async function resumeOwnedSession(projectRoot: string, sessionId: string, recovery?: ModelRecoveryOperation): Promise<ResumeResult> {
  if (!projectRoot) return ipcFail(IpcErrorCode.NoProject, '未打开项目')
  if (shuttingDown || cancelledResumes.has(sessionId)) return ipcFail(IpcErrorCode.Conflict, '原会话连接已停止')
  const existing = sessions.get(sessionId)
  if (existing) {
    if (!belongs(projectRoot, existing.meta)) return ipcFail(IpcErrorCode.Denied, '此会话不属于当前项目')
    if (existing.disconnectOnClose && existing.closingTask) {
      const released = await existing.closingTask
      if (!released.ok) return released
      if (!existing.disconnectOnClose || cancelledResumes.has(sessionId)) return ipcFail(IpcErrorCode.Conflict, '原会话连接已停止')
      return resumeOwnedSession(projectRoot, sessionId, recovery)
    }
    if (existing.meta.status === 'starting' && existing.preparing) {
      if (recovery) return ipcFail(IpcErrorCode.Conflict, '此会话正在连接，请等待当前请求完成')
      await existing.preparing
      const connected = sessions.get(sessionId)
      if (!connected || connected !== existing || connected.closing || connected.meta.status !== 'ready' || cancelledResumes.has(sessionId)) return ipcFail(IpcErrorCode.Upstream, existing.meta.error ?? '会话连接未完成，请重试')
      existing.lastUsedAt = Date.now()
      return { ok: true, sessionId }
    }
    if (existing.closing || existing.accepting || existing.turn) return ipcFail(IpcErrorCode.Conflict, '此会话仍有未结束的操作，请等待或停止')
    if ((existing.meta.status === 'error' || existing.meta.status === 'disconnected') && !existing.meta.restorePending) {
      if (!existing.meta.canResume) return ipcFail(IpcErrorCode.InvalidArg, '此记录仅供查看，不支持原会话恢复')
      const stopped = await killOwned(existing, '停止旧连接，显式恢复原会话')
      if (!stopped.ok) return stopped
      return resumeOwnedSession(projectRoot, sessionId, recovery)
    }
    existing.lastUsedAt = Date.now()
    return { ok: true, sessionId }
  }
  if (resuming.has(sessionId)) return ipcFail(IpcErrorCode.Conflict, '此会话正在恢复，请等待当前请求完成')
  const meta = readRecords().find((record) => record.sessionId === sessionId)
  if (!meta || !belongs(projectRoot, meta)) return ipcFail(IpcErrorCode.NotFound, '当前项目没有此会话')
  if (!meta.canResume || !meta.backendSessionId || !meta.runtimeSnapshot) return ipcFail(IpcErrorCode.InvalidArg, '此记录仅供查看，不支持原会话恢复')
  if (recovery && (recovery.cancelled || meta.connectionGeneration !== recovery.input.expectedConnectionGeneration || recovery.isCurrent?.() === false)) return ipcFail(IpcErrorCode.Conflict, '项目或会话连接已改变，请重新选择')
  resuming.add(sessionId)
  let session: ActiveSession | undefined
  let reservation: symbol | undefined
  try {
    const argv = await launchArgv(meta.runtimeSnapshot)
    if (shuttingDown || cancelledResumes.has(sessionId) || recovery?.cancelled || recovery?.isCurrent?.() === false) return ipcFail(IpcErrorCode.Conflict, '项目已改变或会话连接已停止')
    const slot = await reserveConnectionSlot(sessionId)
    if (typeof slot !== 'symbol') return slot
    reservation = slot
    if (cancelledResumes.has(sessionId)) return ipcFail(IpcErrorCode.Conflict, '原会话连接已停止')
    const runtimeId = meta.runtimeSnapshot.id
    session = await createSessionRuntime({ ...meta, connectionGeneration: randomUUID(), status: 'starting', historyKind: 'live', endedAt: undefined, turnId: undefined, agentContext: undefined, connectionTimings: undefined, restorePending: false, startup: [], recovery: recovery ? undefined : meta.recovery, connectionOwned: false, cleanupRequired: false }, meta.runtimeSnapshot, argv)
    if (shuttingDown || cancelledResumes.has(sessionId) || recovery?.cancelled || recovery?.isCurrent?.() === false) { session.knowledge?.revoke(); await session.runtime.shutdown(); return ipcFail(IpcErrorCode.Conflict, '项目已改变或会话连接已停止') }
    const conflict = acquire(session)
    if (conflict) { session.knowledge?.revoke(); await session.runtime.shutdown(); return conflict }
    sessions.set(sessionId, session)
    connectionReservations.delete(reservation); reservation = undefined
    resuming.delete(sessionId)
    session.lastStatusAt.set('connection-start', Date.now())
    observe(session, '开始恢复原会话')
    describeClientServices(session)
    const restoring = session
    const generation = restoring.meta.connectionGeneration
    const assertActive = (): void => {
      if (restoring.closing || shuttingDown || cancelledResumes.has(sessionId) || recovery?.cancelled || sessions.get(sessionId) !== restoring || restoring.meta.connectionGeneration !== generation || recovery?.isCurrent?.() === false) throw new Error('项目或会话连接已停止')
    }
    const assertIdentity = (): void => {
      assertActive()
      if (restoring.handle?.backendSessionId !== meta.backendSessionId || restoring.meta.backendSessionId !== meta.backendSessionId || (meta.agentSessionId && restoring.meta.agentSessionId !== meta.agentSessionId)) throw new Error('原 Runtime 身份已改变，不能恢复此会话')
    }
    setStatus(restoring, 'starting')
    let preparationError: unknown
    restoring.preparing = (async () => {
      try {
        const handle = await restoring.runtime.findSession({ sessionKey: sessionId, agent: runtimeId })
        assertActive()
        if (!handle || handle.backendSessionId !== meta.backendSessionId) throw new Error('原 Runtime 身份不可用，历史保留；请显式创建新会话')
        if (recovery) {
          // Public cold controls may recreate an unprompted startup on load failure.
          // Only records with real runtime conversation history are eligible here.
          const record = await createFileSessionStore({ stateDir: acpDataPath('runtime-store') }).load(handle.acpxRecordId ?? sessionId)
          assertActive()
          if (!record || record.acpSessionId !== meta.backendSessionId || !record.messages.some((message) => typeof message === 'object' && ('User' in message || 'Agent' in message))) throw new Error('原会话缺少已确认的对话记录，无法安全恢复模型；请显式新建会话')
        }
        restoring.handle = await restoring.runtime.ensureSession({ sessionKey: sessionId, agent: runtimeId, mode: 'persistent', cwd: meta.cwd, resumeSessionId: meta.backendSessionId })
        assertIdentity()
        if (recovery) {
          await restoring.runtime.setModel({ handle: restoring.handle, model: recovery.input.modelId, assertActive })
          if (restoring.meta.currentModelId === recovery.input.modelId) {
            recovery.modelConfirmed = true
            restoring.meta.recovery = { kind: 'connection-failed', modelConfirmed: true, confirmedModelId: recovery.input.modelId }
          }
          assertIdentity()
          await refreshSessionMetadata(restoring)
          assertIdentity()
          if (restoring.meta.currentModelId !== recovery.input.modelId) throw new Error('引擎未确认请求的完整模型 ID，连接未恢复')
          restoring.meta.recovery = { kind: 'connection-failed', modelConfirmed: true, confirmedModelId: recovery.input.modelId }
          observe(restoring, '模型已确认，正在重新连接原会话')
          setStatus(restoring, 'starting')
        }
        await restoring.runtime.connectSession({ handle: restoring.handle, assertActive })
        assertIdentity()
        await refreshSessionMetadata(restoring)
        assertIdentity()
        // Only an acknowledged same-identity native load confirms a new owner;
        // stored UI/runtime messages and a retained handle are not that receipt.
        restoring.nativePersistenceConfirmed = true
        captureConnectionTimings(restoring)
        restoring.meta.restorePending = false
        restoring.disconnected = false
        delete restoring.meta.recovery
        observe(restoring, '原会话已连接，可以继续对话', restoring.lastStatusAt.get('connection-start'))
        release(restoring)
        setStatus(restoring, 'ready')
      } catch (error) {
        preparationError = error
        if (!restoring.closing) await closeAfterFailure(restoring, error, true)
      }
    })()
    await restoring.preparing
    if (preparationError !== undefined) return failure(preparationError)
    if (restoring.closing) return ipcFail(IpcErrorCode.Conflict, '会话恢复已停止')
    return { ok: true, sessionId }
  } catch (error) {
    if (session && !session.closing) await closeAfterFailure(session, error, true)
    return failure(error)
  } finally { resuming.delete(sessionId); if (reservation) connectionReservations.delete(reservation) }
}

export async function configureAcpSession(projectRoot: string, sessionId: string, input: AcpConfigureInput): Promise<{ ok: true; session: AcpSessionRecord } | IpcFail> {
  assertRuntimeExecutionHost()
  const session = owned(projectRoot, sessionId)
  if ('ok' in session) return session
  const handoffConflict = handoffMutationConflict(projectRoot, sessionId)
  if (handoffConflict) return handoffConflict
  const parsed = configureSchema.safeParse(input)
  if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '配置参数无效')
  if (session.turn || session.accepting || session.closing || session.meta.status !== 'ready' || !session.handle) return ipcFail(IpcErrorCode.Conflict, '请在空闲且就绪的会话修改配置')
  session.modelMetadata.project(session.meta, true)
  const modelOptions = session.meta.configOptions?.filter((option) => option.category === 'model') ?? []
  const requestedModel = input.kind === 'model' ? input.id : input.kind === 'config' && modelOptions.length === 1 && modelOptions[0].id === input.id ? input.value : undefined
  const problem = requestedModel === undefined ? undefined : session.modelMetadata.selectionProblem(requestedModel)
  if (problem) { setStatus(session, 'ready'); return ipcFail(IpcErrorCode.Conflict, problem) }
  const conflict = acquire(session)
  if (conflict) return conflict
  session.lastUsedAt = Date.now()
  session.accepting = true
  try {
    const handle = session.handle
    const generation = session.meta.connectionGeneration
    const authority = { assertActive: (): void => { if (session.closing || sessions.get(sessionId) !== session || session.handle !== handle || session.meta.connectionGeneration !== generation) throw new Error('会话连接已变化或已停止') } }
    if (input.kind === 'model') await session.runtime.setModel({ handle, model: input.id, ...authority })
    else if (input.kind === 'mode') await session.runtime.setMode({ handle, mode: input.id, ...authority })
    else await session.runtime.setConfigOption({ handle, key: input.id, value: input.value ?? '', ...authority })
    await refreshSessionMetadata(session)
    authority.assertActive()
    emit(session, 'config', 'Runtime 已确认配置变更', { input })
    setStatus(session, 'ready')
    return { ok: true, session: session.meta }
  } catch (error) { return failure(error) }
  finally { session.accepting = false; release(session) }
}

export function closeAcpAdmission(): void { shuttingDown = true }
export async function shutdownAcp(): Promise<void> {
  shuttingDown = true
  const results = await Promise.all([...sessions.values()].map((session) => killOwned(session, '应用退出')))
  const failed = results.find((result) => result.ok === false)
  await knowledgeMcpBridge.close()
  if (failed?.ok === false) throw new Error(failed.error)
  await Promise.allSettled([...creatingRequests, ...handoffRequests, ...[...resumeRequests.values()].map(request => request.promise), ...[...recoveryRequests.values()].map(request => request.promise)])
  if (sessions.size || resuming.size || connectionReservations.size) throw new Error('ACP 原有连接或启动操作尚未确认释放')
  await stopAcpHistory()
}

/**
 * Trellis 轨道统一入口：watcher / jira / bridge notify 调用。
 * projectRoot 必传（调用方持有）；广播给渲染层并追加进该项目下所有活跃会话记录。
 */
export function emitTrellisTimeline(
  projectRoot: string,
  kind: TimelineEventKind,
  text: string,
  payload?: Record<string, unknown>,
  taskDir?: string
): void {
  if (!process.argv.includes('--trellis-role=daemon')) {
    void import('./daemon-client/acp').then(client => client.emitTrellisTimeline(projectRoot, kind, text, payload, taskDir)).catch(error => process.emitWarning(errorMessage(error), { code: 'TRELLIS_RUNTIME_OBSERVER' }))
    return
  }
  const ev: TimelineEvent = {
    id: `te-${Date.now().toString(36)}-${(eventSeq++).toString(36)}`,
    ts: Date.now(),
    source: 'trellis',
    projectRoot,
    taskDir,
    kind,
    text,
    payload
  }
  broadcastToWindows(ipcEvent.acpOutput, ev)
  for (const s of sessions.values()) {
    if (!belongs(projectRoot, s.meta)) continue
    if (taskDir && s.meta.taskDir !== taskDir) continue
    archiveAcpEvent(s.meta, ev)
    s.meta.events.push(ev)
    if (s.meta.events.length > MAX_RECORD_EVENTS) s.meta.events.splice(0, s.meta.events.length - MAX_RECORD_EVENTS)
    if (kind === 'material-change') save(s)
    else { s.snapshotDirty += 1; if (s.snapshotDirty >= 20 && !s.snapshotTimer) { s.snapshotTimer = setTimeout(() => save(s), 250); s.snapshotTimer.unref() } }
  }
}

/** First-party verified filesystem fact; no Agent/session/turn authorship is inferred. */
export function emitAcpMaterialChange(material: AcpMaterialChange): void {
  const verb = material.kind === 'add' ? '创建' : material.kind === 'unlink' ? '移除' : '更新'
  emitTrellisTimeline(material.projectRoot, 'material-change', `文件已${verb}：${material.relativePath}`, { materialChange: material }, material.taskDir)
}

/** watcher 文件级探针 → trellis 轨道事件（task.json 状态 / 任务文档新增 / spec 变更） */
export function routeWatcherEvent(projectRoot: string, rawPath: string, ev: 'add' | 'change' | 'unlink'): void {
  const rel = relative(projectRoot, rawPath).replace(/\\/g, '/')
  if (!rel.startsWith('.trellis/') || !resolveAuthorizedDocumentPath(projectRoot, rel).ok) return
  // S0 G3：路径解析收敛到 task-identity（吸收原内联正则；archive 结构显式识别）
  const parsed = parseTrellisTaskPath(projectRoot, rawPath)
  if (parsed !== null) {
    // 归档目录变化不打扰活动轨道（与原行为一致：旧正则把 archive 当 taskDir，两分支均不命中）
    if (parsed.archived) return
    const taskDir = parsed.taskDir
    const rest = parsed.innerPath
    if (rest === 'task.json' && ev === 'change') {
      // 同一任务 1.5s 内多次写只报一次（AI 批量改字段常见）
      const now = Date.now()
      for (const s of sessions.values()) {
        if (s.meta.projectRoot !== projectRoot) continue
        if (now - (s.lastStatusAt.get(taskDir) ?? 0) < 1500) return
        s.lastStatusAt.set(taskDir, now)
      }
      let status = ''
      try {
        status = String(JSON.parse(readFileSync(rawPath, 'utf-8')).status ?? '')
      } catch {
        // 读失败仍发事件（无 status 字段）
      }
      emitTrellisTimeline(projectRoot, 'task-status', `任务状态变更${status ? `：${status}` : ''}`, { taskDir, status }, taskDir)
      // S0 G3：任务身份登记（路径→taskRef 的真实目录证据；fire-and-forget，无绑定时静默跳过）
      noteTaskDir(projectRoot, taskDir)
      return
    }
    if (ev === 'add' && (rest === 'prd.md' || rest === 'PRD.md' || rest === 'design.md' || rest === 'implement.md' || rest.startsWith('research/'))) {
      emitTrellisTimeline(projectRoot, 'doc-created', `创建文档：${rest}`, { taskDir, file: rest, path: rawPath }, taskDir)
      noteTaskDir(projectRoot, taskDir)
    }
    return
  }
  const p = rawPath.replace(/\\/g, '/')
  if (/^(?:.*\/)?\.trellis\/spec\/.+/.test(p)) {
    const file = p.split('.trellis/spec/')[1] ?? ''
    // spec 更新是项目级活动：不带 taskDir，不借当前选中任务补全归属（design §5.3）
    emitTrellisTimeline(projectRoot, 'spec-updated', `规范变更：${file}`, { file, path: rawPath })
  }
}

/**
 * bridge notify 轨道：tpanel notify 文本以 `acp:<kind>:` 前缀路由为 trellis 卡片
 * （Studio 钩子一键接线 SessionStart / 每轮注入上报用）。其余文本不受影响。
 */
export function routeNotifyRail(projectRoot: string, text: string): void {
  const m = text.match(/^acp:(spec-injected|task-status|doc-created|spec-updated|jira-sync):\s*(.*)$/)
  if (!m) return
  const kind = m[1] as TimelineEventKind
  emitTrellisTimeline(projectRoot, kind, m[2] || kind, { via: 'tpanel-notify' })
}

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
import { acpDataPath, canonicalDirectory, persistRecord, readProfiles, readRecords, saveProfiles } from './acp/metadata'
import { bindTaskSchema, configureSchema, errorMessage, idSchema, newSessionSchema, objectValue, profileSchema, promptOptionsSchema } from './acp/types'
import { activeTaskExists, preparePromptMaterials, sourceBelongs } from './acp/materials'
import { resolveAuthorizedDocumentPath } from './documents/paths'
import { launchArgv, listAcpAgents, NATIVE_TOOLS_DIAGNOSTIC } from './acp/setup'
import { archiveAcpEvent, ensureAcpHistory, flushAcpHistory, historyPersistence, listAcpHistory, onHistoryPersistence, readAcpHistoryEvents, readAcpHistorySession, retryAcpHistory, stopAcpHistory } from './acp/history-service'
import { acpHistoryUpdateInputSchema, type AcpHistoryEventPage, type AcpHistoryListResult, type AcpHistorySummary, type AcpHistoryUpdateResult } from '../../shared/acp-history'
import { snapshotHistoryEvents, snapshotHistoryList, snapshotHistorySession } from './acp/history-fallback'
import { applySessionPreferences, readSessionPreferences, updateSessionPreferences } from './acp/session-preferences'
import { ModelMetadataContext } from './acp/cc-switch-models'
import { knowledgeMcpBridge, type KnowledgeMcpConnection } from './knowledge-mcp'
import { KNOWLEDGE_CONVERSATION_INSTRUCTIONS } from './knowledge-mcp/instructions'
import { skipConversationActionLookup } from './knowledge-mcp/preflight'
import type { KnowledgePreflight } from './knowledge-mcp/server'
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
type ResumeResult = { ok: true; sessionId: string } | IpcFail
const resumeRequests = new Map<string, { root: string; promise: Promise<ResumeResult> }>()
const recoveryRequests = new Map<string, { root: string; operation: ModelRecoveryOperation; promise: Promise<AcpRecoverModelResult> }>()
const creatingRequests = new Set<Promise<{ ok: true; sessionId: string } | IpcFail>>()
const leases = new Map<string, ActiveSession>()
let shuttingDown = false
let eventSeq = 0
let lastWorkflowObserverWarningAt = 0

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
function acquire(session: ActiveSession): IpcFail | undefined {
  const key = keyFor(session)
  const owner = leases.get(key)
  if (owner && owner !== session) return ipcFail(IpcErrorCode.Conflict, '此目录正在被另一个 Agent 使用，请停止占用会话后重试', { ownerSessionId: owner.meta.sessionId })
  leases.set(key, session)
  session.leaseHeld = true
  return undefined
}
function release(session: ActiveSession): void {
  const unfinished = [...session.toolStates.values()].some((state) => state === 'unfinished')
  if (session.hasProcess && (session.backgroundWork || unfinished)) {
    // A model turn ending does not prove an unfinished native tool has stopped.
    // Once that uncertainty crosses a turn boundary, keep ownership until stop.
    session.backgroundWork = true
    session.meta.directoryLeaseReason = unfinished
      ? 'Runtime 仍有未报告完成的工具；回合结束不能证明工具已停止，请结束会话以释放目录'
      : 'Runtime 报告的后台工具尚未确认结束，请停止会话以释放目录'
    return
  }
  if (leases.get(keyFor(session)) === session) leases.delete(keyFor(session))
  session.leaseHeld = false
  delete session.meta.directoryLeaseReason
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
    promptCapabilities: { image: record.agentCapabilities?.promptCapabilities?.image === true },
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
    session.meta.directoryLeaseReason = '清理未确认，目录占用保留；请显式停止 Runtime 后重试'
  }
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
  if (!('TRELLIS_ACPX_COMPAT_VERSION' in AcpxRuntime) || AcpxRuntime.TRELLIS_ACPX_COMPAT_VERSION !== 2) throw new Error('acpx 兼容补丁未准备好；请重新安装应用依赖')
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
      ...(zcodeDiagnosticDirectory(meta) ? { TRELLIS_ZCODE_DIAGNOSTICS_DIR: zcodeDiagnosticDirectory(meta) } : {}) },
    agentRegistry: createAgentRegistry({ overrides: { [config.id]: [...argv, ...profileExtraArgv(meta.profileSnapshot)] } }),
    sessionStore: { load: (id) => store.load(id), save: async (record) => {
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
  session = { meta, runtime, modelMetadata, knowledge, knowledgeSupport: 'unknown', nativeCommands: new Set(), accepting: false, closing: false, disconnected: false, pendingPermissions: new Map(), lastStatusAt: new Map(), hasProcess: false, backgroundWork: false, toolStates: new Map(), leaseHeld: false, settling: false, snapshotDirty: 0 }
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
      knowledgeBridge: { state: 'unavailable', detail: 'Negotiated native MCP capabilities do not support HTTP tools; host project lookup can still deliver plain-text evidence' }, activityScope: 'connection'
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
async function newOwnedAcpSession(projectRoot: string, input: unknown): Promise<{ ok: true; sessionId: string } | IpcFail> {
  assertRuntimeExecutionHost()
  if (!projectRoot) return ipcFail(IpcErrorCode.NoProject, '未打开项目')
  const parsed = newSessionSchema.safeParse(input)
  if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, parsed.error.issues[0]?.message ?? '启动参数无效')
  if (shuttingDown || sessions.size + resuming.size >= MAX_ACTIVE) return ipcFail(IpcErrorCode.Conflict, `同时最多 ${MAX_ACTIVE} 个已连接 ACP 会话`)
  try {
    const { agentId, profileId, taskDir } = parsed.data
    const profile = profileId ? readProfiles(projectRoot).find((item) => item.id === profileId) : undefined
    if (profileId && !profile) return ipcFail(IpcErrorCode.NotFound, 'Agent 配置不存在')
    const runtimeId = profile?.runtimeId ?? agentId
    const config = (await listAcpAgents(true)).agents.find((item) => item.id === runtimeId)
    if (!config?.enabled || !config.available) return ipcFail(IpcErrorCode.InvalidArg, config?.diagnostics?.join('；') ?? 'Runtime 未启用或不可用')
    const cwd = profile?.cwd || projectRoot
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return ipcFail(IpcErrorCode.NotFound, '工作目录不可用')
    if (taskDir && !await activeTaskExists(projectRoot, taskDir)) return ipcFail(IpcErrorCode.InvalidArg, '绑定任务不属于当前项目的活动任务目录或记录不可读')
    const argv = await launchArgv(config)
    // Recheck the cap after asynchronous discovery; admission is otherwise atomic.
    if (sessions.size + resuming.size >= MAX_ACTIVE || shuttingDown) return ipcFail(IpcErrorCode.Conflict, 'ACP 连接数量已达上限')
    const meta: AcpSessionRecord = { schemaVersion: 2, sessionId: `acp-${randomUUID()}`, agentId: runtimeId, agentName: profile?.name ?? config.name,
      projectRoot, cwd, taskDir, status: 'starting', startedAt: Date.now(), events: [], startup: [], connectionGeneration: randomUUID(),
      profileSnapshot: profile, runtimeSnapshot: { id: config.id, name: config.name, command: config.command, enabled: config.enabled, launchKind: config.launchKind, executable: config.executable, args: config.args }, historyKind: 'live', canResume: false }
    const session = await createSessionRuntime(meta, config, argv)
    if (sessions.size + resuming.size >= MAX_ACTIVE || shuttingDown) { session.knowledge?.revoke(); await session.runtime.shutdown(); return ipcFail(IpcErrorCode.Conflict, 'ACP 连接数量已达上限') }
    const conflict = acquire(session)
    if (conflict) { session.knowledge?.revoke(); await session.runtime.shutdown(); return conflict }
    sessions.set(meta.sessionId, session)
    session.lastStatusAt.set('connection-start', Date.now())
    observe(session, '开始准备会话')
    describeClientServices(session)
    setStatus(session, 'starting')
    session.preparing = (async () => {
      try {
        session.handle = await session.runtime.ensureSession({ sessionKey: meta.sessionId, agent: runtimeId, cwd, mode: 'persistent',
          sessionOptions: { systemPrompt: { append: [profile?.instructions, KNOWLEDGE_CONVERSATION_INSTRUCTIONS].filter(Boolean).join('\n\n') } } })
        if (session.closing) { await session.runtime.shutdown(); return }
        await refreshSessionMetadata(session)
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
  } catch (error) { return failure(error) }
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
  const session = owned(projectRoot, sessionId)
  if ('ok' in session) return session
  if (session.accepting || session.turn || session.closing || (session.meta.status !== 'ready' && !(session.meta.status === 'disconnected' && session.meta.restorePending))) return ipcFail(IpcErrorCode.Conflict, `当前不能发送：${session.meta.status}`)
  if (typeof text !== 'string' || text.length > 200000) return ipcFail(IpcErrorCode.InvalidArg, '发送内容无效或过长')
  if (!session.handle) return ipcFail(IpcErrorCode.Conflict, '会话尚未准备好')
  const parsedOptions = promptOptionsSchema.safeParse(options ?? {})
  if (!parsedOptions.success) return ipcFail(IpcErrorCode.InvalidArg, parsedOptions.error.issues[0]?.message ?? '文档引用或发送参数无效')
  const { sourceReferences = [], images = [], expectedConnectionGeneration } = parsedOptions.data
  if (!text.trim() && images.length === 0) return ipcFail(IpcErrorCode.InvalidArg, '请先输入内容或添加图片')
  if (images.length && session.raw?.agentCapabilities?.promptCapabilities?.image !== true) return ipcFail(IpcErrorCode.InvalidArg, '当前执行引擎未声明支持图片输入，请切换支持图片的会话；图片尚未发送')
  const generation = session.meta.connectionGeneration
  if (expectedConnectionGeneration !== undefined && expectedConnectionGeneration !== generation) return ipcFail(IpcErrorCode.Conflict, '会话连接已改变，请重新选择发送目标', { reason: 'SCOPE_CHANGED' })
  for (const reference of sourceReferences) {
    if (!sourceBelongs(projectRoot, session.meta.taskDir, reference) || reference.targetSessionId !== sessionId) return ipcFail(IpcErrorCode.Denied, '文档引用不属于此项目、任务或会话')
    if ((reference.targetConnectionGeneration ?? expectedConnectionGeneration) !== generation) return ipcFail(IpcErrorCode.Conflict, '文档引用的会话连接已改变', { reason: 'SCOPE_CHANGED' })
  }
  const conflict = acquire(session)
  if (conflict) return conflict
  session.accepting = true
  const abort = new AbortController()
  session.promptAbort = abort
  const turnId = `turn-${randomUUID()}`
  const trimmed = text.trim()
  const nativeCommand = !workflow && images.length === 0 && sourceReferences.length === 0 && trimmed.startsWith('/') && session.nativeCommands.has(trimmed.slice(1).split(/\s/, 1)[0])
  let questionReceived = false
  let promptWritten = false
  let preflight: KnowledgePreflight | undefined
  const ownerCurrent = (): boolean => isCurrent?.() !== false && sessions.get(sessionId) === session && session.meta.connectionGeneration === generation && session.meta.turnId === turnId && session.accepting && !session.closing && !shuttingDown && (!session.disconnected || session.meta.restorePending === true) && (session.meta.status === 'busy' || session.meta.status === 'awaiting_permission')
  const active = (): boolean => !abort.signal.aborted && ownerCurrent()
  const assertActive = (): void => {
    if (!active()) throw new Error('发送前项目或会话已改变；内容尚未发送')
    workflow?.assertActive()
    preflight?.assertActive()
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
    for (const [id, state] of session.toolStates) if (state === 'settled') session.toolStates.delete(id)
    session.meta.turnId = turnId
    if (workflow?.onAdmitted) publishWorkflowObservation(() => { workflow.onAdmitted?.({ sessionId, turnId, connectionGeneration: generation }); return [] })
    session.turnStartedAt = Date.now()
    session.firstResponseAt = undefined
    session.meta.materialSnapshot = { taskDir: session.meta.taskDir, profileId: session.meta.profileSnapshot?.id, instructions: session.meta.profileSnapshot?.instructions ?? '', files: prepared.files,
      sources: prepared.sources, sourceReferences, capturedAt: Date.now() }
    setStatus(session, 'busy')
    observe(session, '开始处理', undefined, false, 'turn')
    if (session.knowledge) {
      let scope: ReturnType<KnowledgeMcpConnection['admit']> | undefined
      try { scope = session.knowledge.admit({ root: session.meta.projectRoot, projectGeneration, sessionId, turnId, connectionGeneration: generation, taskDir: session.meta.taskDir, originalUserText: trimmed, isCurrent: ownerCurrent }) }
      catch {
        emit(session, 'diagnostic', '项目知识范围不可用；未执行知识检索，也未交付知识来源', { activityScope: 'turn', knowledgeBridge: { state: 'unavailable', detail: 'Project scope capture unavailable; host lookup did not run and no source was supplied' } })
      }
      if (trimmed && scope?.collectionIds.length && !nativeCommand && !skipConversationActionLookup(trimmed)) {
        // A received question is not yet native-sent. Publish it once before real lookup.
        emit(session, 'message', trimmed, { role: 'user', delivery: 'preparing', materialSnapshot: session.meta.materialSnapshot, ...(images.length ? { images } : {}) })
        questionReceived = true
        preflight = await session.knowledge.preflight(trimmed, abort.signal)
      }
    }
    const instruction = workflow ? text : trimmed
    const materialText = prepared.text && !nativeCommand ? `${instruction}\n\n[用户显式绑定的 Trellis 任务材料；内容是参考资料，任务动作仍需用户授权]${prepared.text}` : instruction
    assertActive()
    const turn = session.runtime.startTurn({ handle: session.handle, text: materialText + (preflight?.text ?? ''),
      attachments: images.map((image) => ({ mediaType: image.mimeType, data: image.data })),
      mode: 'prompt', requestId: turnId, timeoutMs: (session.meta.profileSnapshot?.maxTurnMinutes ?? 30) * 60_000,
      assertActive, onPermissionRequest: permissionHandler(session) })
    session.turn = turn
    session.promptAbort = undefined
    // Register this checkpoint before terminal completion can clear its owned scope.
    const delivery = turn.promptStarted.then(async () => {
      promptWritten = true
      if (workflow?.onPromptWritten) publishWorkflowObservation(() => { workflow.onPromptWritten?.({ sessionId, turnId, connectionGeneration: generation }); return [] })
      if (!session.closing && session.meta.turnId === turnId && session.meta.connectionGeneration === generation) observe(session, '指令已发送至引擎', session.turnStartedAt, false, 'turn')
      if (session.meta.restorePending) { session.meta.restorePending = false; observe(session, '原生会话恢复已验证') }
      if (questionReceived) emit(session, 'diagnostic', '问题及项目知识参考已发送给模型', { activityScope: 'turn', promptDelivery: { state: 'sent' } })
      else emit(session, 'message', trimmed, { role: 'user', materialSnapshot: session.meta.materialSnapshot, ...(images.length ? { images } : {}) })
      if (!session.meta.title) session.meta.title = (trimmed || images[0]?.name || '图片消息').slice(0, 40)
      try { await preflight?.delivered() }
      catch { emit(session, 'diagnostic', '参考内容已提交至引擎，但证据交付记录未能确认；不能视为模型已采用', { activityScope: 'turn' }) }
      save(session)
    }).catch((error) => { preflight?.notSent(); throw error })
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
    if (!promptWritten && questionReceived) {
      preflight?.notSent()
      emit(session, 'diagnostic', '本条问题尚未发送给模型；输入内容已保留', { activityScope: 'turn', promptDelivery: { state: 'not_sent' } })
    }
    session.knowledge?.endTurn()
    session.accepting = false
    if (!session.turn) { release(session); if (!session.closing) setStatus(session, questionReceived || abort.signal.aborted || isCurrent?.() === false ? session.disconnected ? 'disconnected' : 'ready' : 'error', errorMessage(error)) }
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
async function killOwned(session: ActiveSession, reason: string): Promise<{ ok: true } | IpcFail> {
  if (session.closingTask) return session.closingTask
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
    setStatus(session, 'closed', undefined, true)
    emit(session, 'session-status', reason, { activityScope: 'connection' })
    save(session)
    await flushAcpHistory().catch(() => {})
    return { ok: true }
  } catch (error) {
    session.cleanupRequired = true
    if (session.leaseHeld) session.meta.directoryLeaseReason = '停止清理尚未确认，目录占用保留；请重试结束会话'
    setStatus(session, 'error', `停止失败：${errorMessage(error)}`)
    return failure(error)
  }
}
export async function killAcpSession(projectRoot: string, sessionId: string): Promise<{ ok: true } | IpcFail> {
  assertRuntimeExecutionHost()
  if (!projectRoot) return ipcFail(IpcErrorCode.NoProject, '未打开项目')
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
  const root = canonicalDirectory(projectRoot)
  if (recoveryRequests.has(sessionId)) return Promise.resolve(ipcFail(IpcErrorCode.Conflict, '此会话正在验证模型，请等待当前请求完成'))
  const pending = resumeRequests.get(sessionId)
  if (pending) return pending.root === root ? pending.promise : Promise.resolve(ipcFail(IpcErrorCode.Denied, '此会话不属于当前项目'))
  const promise: Promise<ResumeResult> = resumeOwnedSession(projectRoot, sessionId).finally(() => {
    if (resumeRequests.get(sessionId)?.promise === promise) resumeRequests.delete(sessionId)
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
  const existing = sessions.get(sessionId)
  if (existing) {
    if (!belongs(projectRoot, existing.meta)) return ipcFail(IpcErrorCode.Denied, '此会话不属于当前项目')
    if (existing.meta.status === 'starting' && existing.preparing) {
      if (recovery) return ipcFail(IpcErrorCode.Conflict, '此会话正在连接，请等待当前请求完成')
      await existing.preparing
      const connected = sessions.get(sessionId)
      if (!connected || connected !== existing || connected.closing || connected.meta.status !== 'ready') return ipcFail(IpcErrorCode.Upstream, existing.meta.error ?? '会话连接未完成，请重试')
      return { ok: true, sessionId }
    }
    if (existing.closing || existing.accepting || existing.turn) return ipcFail(IpcErrorCode.Conflict, '此会话仍有未结束的操作，请等待或停止')
    if ((existing.meta.status === 'error' || existing.meta.status === 'disconnected') && !existing.meta.restorePending) {
      if (!existing.meta.canResume) return ipcFail(IpcErrorCode.InvalidArg, '此记录仅供查看，不支持原会话恢复')
      const stopped = await killOwned(existing, '停止旧连接，显式恢复原会话')
      if (!stopped.ok) return stopped
      return resumeOwnedSession(projectRoot, sessionId, recovery)
    }
    return { ok: true, sessionId }
  }
  if (resuming.has(sessionId)) return ipcFail(IpcErrorCode.Conflict, '此会话正在恢复，请等待当前请求完成')
  const meta = readRecords().find((record) => record.sessionId === sessionId)
  if (!meta || !belongs(projectRoot, meta)) return ipcFail(IpcErrorCode.NotFound, '当前项目没有此会话')
  if (!meta.canResume || !meta.backendSessionId || !meta.runtimeSnapshot) return ipcFail(IpcErrorCode.InvalidArg, '此记录仅供查看，不支持原会话恢复')
  if (recovery && (recovery.cancelled || meta.connectionGeneration !== recovery.input.expectedConnectionGeneration || recovery.isCurrent?.() === false)) return ipcFail(IpcErrorCode.Conflict, '项目或会话连接已改变，请重新选择')
  if (sessions.size + resuming.size >= MAX_ACTIVE || shuttingDown) return ipcFail(IpcErrorCode.Conflict, '连接数量已达上限')
  resuming.add(sessionId)
  let session: ActiveSession | undefined
  try {
    const argv = await launchArgv(meta.runtimeSnapshot)
    if (shuttingDown || recovery?.cancelled || recovery?.isCurrent?.() === false) return ipcFail(IpcErrorCode.Conflict, '项目已改变或会话连接已停止')
    const runtimeId = meta.runtimeSnapshot.id
    session = await createSessionRuntime({ ...meta, connectionGeneration: randomUUID(), status: 'starting', historyKind: 'live', endedAt: undefined, turnId: undefined, restorePending: false, startup: [], recovery: recovery ? undefined : meta.recovery, connectionOwned: false, cleanupRequired: false }, meta.runtimeSnapshot, argv)
    if (shuttingDown || recovery?.cancelled || recovery?.isCurrent?.() === false) { session.knowledge?.revoke(); await session.runtime.shutdown(); return ipcFail(IpcErrorCode.Conflict, '项目已改变或会话连接已停止') }
    const conflict = acquire(session)
    if (conflict) { session.knowledge?.revoke(); await session.runtime.shutdown(); return conflict }
    sessions.set(sessionId, session)
    resuming.delete(sessionId)
    session.lastStatusAt.set('connection-start', Date.now())
    observe(session, '开始恢复原会话')
    describeClientServices(session)
    const restoring = session
    const generation = restoring.meta.connectionGeneration
    const assertActive = (): void => {
      if (restoring.closing || shuttingDown || recovery?.cancelled || sessions.get(sessionId) !== restoring || restoring.meta.connectionGeneration !== generation || recovery?.isCurrent?.() === false) throw new Error('项目或会话连接已停止')
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
  } finally { resuming.delete(sessionId) }
}

export async function configureAcpSession(projectRoot: string, sessionId: string, input: AcpConfigureInput): Promise<{ ok: true; session: AcpSessionRecord } | IpcFail> {
  assertRuntimeExecutionHost()
  const session = owned(projectRoot, sessionId)
  if ('ok' in session) return session
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
  await Promise.allSettled([...creatingRequests, ...[...resumeRequests.values()].map(request => request.promise), ...[...recoveryRequests.values()].map(request => request.promise)])
  if (sessions.size || resuming.size) throw new Error('ACP 原有连接或启动操作尚未确认释放')
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

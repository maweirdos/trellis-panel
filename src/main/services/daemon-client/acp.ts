/** GUI native facade. Existing DTOs survive; execution/admission is performed only by the daemon. */
import type * as Local from '../acp'
import { relative } from 'node:path'
import type { AcpBindTaskInput, AcpConfigureInput, AcpMaterialChange, AcpPromptOptions, TimelineEventKind } from '../../../shared/types'
import type { AcpRecoverModelInput } from '../../../shared/acp-recovery'
import type { AcpHandoffPreviewInput, AcpHandoffCreateInput, AcpHandoffCancelInput } from '../../../shared/acp-handoff'
import { ipcFail, IpcErrorCode } from '../../../shared/ipc-errors'
import { runtimeCall } from './runtime'
import type { RuntimeBody, RuntimeBodyMethod } from '../../../shared/daemon-runtime'
import { pickAcpNode as pickLocalNode, pickAcpRuntimePath as pickLocalRuntimePath } from '../acp/setup'
import { writeNativeSettings } from './native-state'
export const pickAcpNode = () => pickLocalNode(writeNativeSettings)
export const pickAcpRuntimePath = (id: string) => pickLocalRuntimePath(id, writeNativeSettings)
type Result<K extends keyof typeof Local> = (typeof Local)[K] extends (...args: never[]) => unknown ? Awaited<ReturnType<(typeof Local)[K]>> : never
async function call<K extends keyof typeof Local, M extends RuntimeBodyMethod>(root: string, method: M, body: RuntimeBody<M>, isCurrent?: () => boolean): Promise<Result<K>> {
  if (!root && !['runtime.agents', 'runtime.setup', 'runtime.probe'].includes(method)) return ipcFail(IpcErrorCode.NoProject, '未打开项目') as Result<K>
  try { return await runtimeCall<Result<K>, M>(root, method, body, undefined, isCurrent) }
  catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    const known = Object.values(IpcErrorCode).find(value => value === code) ?? IpcErrorCode.Unavailable
    const receipt = error && typeof error === 'object' && 'commandId' in error && typeof error.commandId === 'string'
      ? { commandId: error.commandId, outcome: 'outcome' in error && error.outcome === 'not-admitted' ? 'not-admitted' : 'unknown' } : undefined
    return ipcFail(known, error instanceof Error ? error.message : '后台 Runtime 不可用', receipt) as Result<K>
  }
}
export const listAcpAgents = (refresh = false) => call<'listAcpAgents', 'runtime.agents'>('', 'runtime.agents', { refresh })
export const setupAcpRuntime = (runtimeId: string) => call<'setupAcpRuntime', 'runtime.setup'>('', 'runtime.setup', { runtimeId })
export const testAcpRuntimeConnection = (runtimeId: string) => call<'testAcpRuntimeConnection', 'runtime.probe'>('', 'runtime.probe', { runtimeId })
export const listAcpSessions = (root: string, limit?: number) => call<'listAcpSessions', 'runtime.sessions'>(root, 'runtime.sessions', { limit })
export const listAcpProfiles = (root: string) => call<'listAcpProfiles', 'runtime.profiles'>(root, 'runtime.profiles', {})
export const saveAcpProfile = (root: string, input: unknown) => call<'saveAcpProfile', 'runtime.profileSave'>(root, 'runtime.profileSave', { input })
export const deleteAcpProfile = (root: string, profileId: string) => call<'deleteAcpProfile', 'runtime.profileDelete'>(root, 'runtime.profileDelete', { profileId })
export const listAcpHistorySessions = (root: string, input?: unknown) => call<'listAcpHistorySessions', 'runtime.historyList'>(root, 'runtime.historyList', { input: input as RuntimeBody<'runtime.historyList'>['input'] })
export const getAcpHistorySession = (root: string, sessionId: string) => call<'getAcpHistorySession', 'runtime.historySession'>(root, 'runtime.historySession', { sessionId })
export const getAcpHistoryEvents = (root: string, sessionId: string, input?: unknown) => call<'getAcpHistoryEvents', 'runtime.historyEvents'>(root, 'runtime.historyEvents', { sessionId, input: input as RuntimeBody<'runtime.historyEvents'>['input'] })
export const getAcpPiImage = (root: string, sessionId: string, imageId: string) => call<'getAcpPiImage', 'runtime.piImage'>(root, 'runtime.piImage', { sessionId, imageId })
export const updateAcpHistorySession = (root: string, sessionId: string, input: unknown, isCurrent?: () => boolean) => call<'updateAcpHistorySession', 'runtime.historyUpdate'>(root, 'runtime.historyUpdate', { sessionId, input: input as RuntimeBody<'runtime.historyUpdate'>['input'] }, isCurrent)
export const previewAcpHistoryDeletion = (root: string, sessionId: string, isCurrent?: () => boolean) => call<'previewAcpHistoryDeletion', 'runtime.historyDeletePreview'>(root, 'runtime.historyDeletePreview', { sessionId }, isCurrent)
export const deleteAcpHistorySession = (root: string, sessionId: string, token: string, isCurrent?: () => boolean) => call<'deleteAcpHistorySession', 'runtime.historyDelete'>(root, 'runtime.historyDelete', { sessionId, input: { token } }, isCurrent)
export const regenerateAcpHistoryTitle = (root: string, sessionId: string, isCurrent?: () => boolean) => call<'regenerateAcpHistoryTitle', 'runtime.historyRegenerateTitle'>(root, 'runtime.historyRegenerateTitle', { sessionId }, isCurrent)
export const retryAcpHistorySession = (root: string, sessionId: string) => call<'retryAcpHistorySession', 'runtime.historyRetry'>(root, 'runtime.historyRetry', { sessionId })
export const newAcpSession = (root: string, input: unknown) => call<'newAcpSession', 'runtime.new'>(root, 'runtime.new', { input })
export const previewAcpSessionHandoff = (root: string, sessionId: string, input: AcpHandoffPreviewInput, isCurrent?: () => boolean) => call<'previewAcpSessionHandoff', 'runtime.handoffPreview'>(root, 'runtime.handoffPreview', { sessionId, input }, isCurrent)
export const createAcpSessionHandoff = (root: string, sessionId: string, input: AcpHandoffCreateInput, isCurrent?: () => boolean) => call<'createAcpSessionHandoff', 'runtime.handoffCreate'>(root, 'runtime.handoffCreate', { sessionId, input }, isCurrent)
export const getAcpSessionHandoff = (root: string, sessionId: string, operationId: string, isCurrent?: () => boolean) => call<'getAcpSessionHandoff', 'runtime.handoffStatus'>(root, 'runtime.handoffStatus', { sessionId, operationId }, isCurrent)
export const cancelAcpSessionHandoff = (root: string, sessionId: string, input: AcpHandoffCancelInput) => call<'cancelAcpSessionHandoff', 'runtime.handoffCancel'>(root, 'runtime.handoffCancel', { sessionId, input })
export const promptAcpSession = (root: string, sessionId: string, text: string, options?: AcpPromptOptions, isCurrent?: () => boolean, _generation?: number) => call<'promptAcpSession', 'runtime.prompt'>(root, 'runtime.prompt', { sessionId, text, options }, isCurrent)
export const bindAcpSessionTask = (root: string, sessionId: string, input: AcpBindTaskInput, isCurrent?: () => boolean) => call<'bindAcpSessionTask', 'runtime.bind'>(root, 'runtime.bind', { sessionId, input }, isCurrent)
export const cancelAcpSession = (root: string, sessionId: string) => call<'cancelAcpSession', 'runtime.cancel'>(root, 'runtime.cancel', { sessionId })
export const killAcpSession = (root: string, sessionId: string) => call<'killAcpSession', 'runtime.end'>(root, 'runtime.end', { sessionId })
export const resumeAcpSession = (root: string, sessionId: string) => call<'resumeAcpSession', 'runtime.resume'>(root, 'runtime.resume', { sessionId })
export const configureAcpSession = (root: string, sessionId: string, input: AcpConfigureInput) => call<'configureAcpSession', 'runtime.configure'>(root, 'runtime.configure', { sessionId, input })
export const recoverAcpSessionModel = (root: string, sessionId: string, input: AcpRecoverModelInput, isCurrent?: () => boolean) => call<'recoverAcpSessionModel', 'runtime.recover'>(root, 'runtime.recover', { sessionId, input }, isCurrent)
export const respondAcpPermission = (root: string, requestId: string, optionId: string) => call<'respondAcpPermission', 'runtime.permission'>(root, 'runtime.permission', { requestId, optionId })
/** Watcher/bridge projections carry no ownership claim; failures stay observable. */
function publish(root: string, method: RuntimeBodyMethod, body: RuntimeBody<RuntimeBodyMethod>): void {
  void runtimeCall(root, method, body).catch(error => process.emitWarning(error instanceof Error ? error.message : 'Runtime notification was not delivered', { code: 'TRELLIS_RUNTIME_OBSERVER' }))
}
export function routeWatcherEvent(root: string, path: string, event: 'add' | 'change' | 'unlink'): void {
  // Cheap source filter before the shared socket. The daemon still owns exact
  // document authorization and which Trellis changes become timeline facts.
  if (!root || !relative(root, path).replace(/\\/g, '/').startsWith('.trellis/')) return
  publish(root, 'runtime.watcher', { path, event })
}
export const routeNotifyRail = (root: string, text: string): void => publish(root, 'runtime.notify', { text })
export const emitAcpMaterialChange = (material: AcpMaterialChange): void => publish(material.projectRoot, 'runtime.materialChange', { material })
export const emitTrellisTimeline = (root: string, kind: TimelineEventKind, text: string, payload?: Record<string, unknown>, taskDir?: string): void => publish(root, 'runtime.timeline', { input: { kind, text, payload, taskDir } })

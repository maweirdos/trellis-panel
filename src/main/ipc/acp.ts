/**
 * ACP 域 IPC：注册表/会话生命周期/权限审批的薄壳（决策 TPD-004：一域一文件）。
 * projectRoot 统一取自 state（本层允许 import state；acp 服务保持无环叶子）。
 */
import { ipcInvoke } from '../../shared/ipc-channels'
import { app, BrowserWindow, dialog } from 'electron'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { noProject, ipcFail, IpcErrorCode, type IpcFail } from '../../shared/ipc-errors'
import { getProjectRoot, getProjectGeneration } from '../state'
import type { AcpBindTaskInput, AcpPromptOptions } from '../../shared/types'
import { acpHandoffPreviewInputSchema, acpHandoffCreateInputSchema, acpHandoffCancelInputSchema, acpHandoffSessionIdSchema, acpHandoffOperationIdSchema } from '../../shared/acp-handoff'
import {
  cancelAcpSession,
  killAcpSession,
  listAcpAgents,
  listAcpSessions,
  newAcpSession,
  promptAcpSession,
  respondAcpPermission,
  listAcpProfiles, saveAcpProfile, deleteAcpProfile, setupAcpRuntime, pickAcpNode, pickAcpRuntimePath, resumeAcpSession, configureAcpSession, bindAcpSessionTask,
  listAcpHistorySessions, getAcpHistorySession, getAcpHistoryEvents, getAcpPiImage, updateAcpHistorySession, retryAcpHistorySession, recoverAcpSessionModel,
  listAcpConversationProjections, getAcpConversationProjection, readAcpConversationProjectionEvents,
  previewAcpSessionHandoff, createAcpSessionHandoff, getAcpSessionHandoff, cancelAcpSessionHandoff,
  previewAcpHistoryDeletion, deleteAcpHistorySession, regenerateAcpHistoryTitle
} from '../services/daemon-client/acp'
import { testAcpRuntimeConnection } from '../services/daemon-client/acp'
import { handle, on } from './registry'
import { isManagedWorkflowOrigin } from '../services/daemon-client/workflow'
import { piDocumentOpenInputSchema } from '../../shared/pi-document'
import { acpHistoryDeleteRequestSchema } from '../../shared/acp-history'
import { approveNativeHistoryDeletion, discardNativeHistoryDeletion } from '../services/acp/history-deletion'
import { piDocumentHref } from '../services/pi/document-path'
import { openLocalDocumentLink } from '../services/local-document-links'

export function registerAcpIpc(): void {
  const documentOperations = new Map<string, { cancelled: boolean }>()
  on(ipcInvoke.acp.piDocumentCancel, (event, id: unknown) => {
    if (typeof id !== 'string') return
    const operation = documentOperations.get(`${event.sender.id}:${id}`)
    if (operation) operation.cancelled = true
  })
  handle(ipcInvoke.acp.piDocumentOpen, async (event, input: unknown) => {
    const parsed = piDocumentOpenInputSchema.safeParse(input)
    if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '文档打开请求无效。')
    const request = parsed.data
    const root = getProjectRoot()
    const generation = getProjectGeneration()
    if (!root) return noProject()
    const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)
    if (!samePath(root, request.expectedRoot)) return ipcFail(IpcErrorCode.Conflict, '项目已切换，请重新选择文件。')
    const key = `${event.sender.id}:${request.operationId}`
    if (documentOperations.has(key)) return ipcFail(IpcErrorCode.Conflict, '此打开请求正在处理。')
    const operation = { cancelled: false }
    documentOperations.set(key, operation)
    const current = (): boolean => !operation.cancelled && !event.sender.isDestroyed() && getProjectGeneration() === generation && getProjectRoot() === root
    const readOwner = async () => {
      const inventory = await listAcpSessions(root, 100)
      if (!inventory.ok) return inventory
      const session = inventory.sessions.find(item => item.sessionId === request.sessionId)
      return session ? { ok: true as const, session } : getAcpHistorySession(root, request.sessionId)
    }
    try {
      const first = await readOwner()
      if (!current()) return ipcFail(IpcErrorCode.Conflict, '项目或会话已切换，未打开文件。')
      if (!first.ok) return first
      const session = first.session
      if (session.engine !== 'pi' || session.sessionId !== request.sessionId || !samePath(session.projectRoot, root) || session.connectionGeneration !== request.connectionGeneration) return ipcFail(IpcErrorCode.Conflict, '项目或会话连接已变化，请重新选择文件。')
      const cwd = session.cwd ?? session.projectRoot
      const href = piDocumentHref(request.path, cwd, root)
      if (!href) return ipcFail(IpcErrorCode.InvalidArg, '文件路径无效或不在当前项目中。')
      const latest = await readOwner()
      if (!current() || !latest.ok || latest.session.engine !== 'pi' || latest.session.sessionId !== request.sessionId ||
        !samePath(latest.session.projectRoot, root) || latest.session.connectionGeneration !== request.connectionGeneration ||
        !samePath(latest.session.cwd ?? latest.session.projectRoot, cwd)) return ipcFail(IpcErrorCode.Conflict, '项目或会话已变化，未打开文件。')
      return await openLocalDocumentLink(href, root, current)
    } catch {
      return ipcFail(IpcErrorCode.Io, '无法核对会话或打开本地文档，请重试。')
    } finally { documentOperations.delete(key) }
  })
  handle(ipcInvoke.acp.agents, () => listAcpAgents())

  handle(ipcInvoke.acp.sessions, (_e, limit?: number) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    return listAcpSessions(root, limit)
  })
  const scopedHistory = async (operation: (root: string) => Promise<unknown>): Promise<unknown> => {
    const root = getProjectRoot()
    const generation = getProjectGeneration()
    if (!root) return noProject()
    const result = await operation(root)
    if (getProjectRoot() !== root || getProjectGeneration() !== generation) return noProject()
    return result
  }
  handle(ipcInvoke.acp.historyList, (_e, input) => scopedHistory((root) => listAcpHistorySessions(root, input)))
  handle(ipcInvoke.acp.conversationProjectionList, (_e, input) => scopedHistory((root) => listAcpConversationProjections(root, input)))
  handle(ipcInvoke.acp.conversationProjectionDetail, (_e, sessionId) => {
    if (typeof sessionId !== 'string' || !/^[\w.-]{1,200}$/.test(sessionId)) return ipcFail(IpcErrorCode.InvalidArg, '会话 ID 无效')
    return scopedHistory((root) => getAcpConversationProjection(root, sessionId))
  })
  handle(ipcInvoke.acp.conversationProjectionEvents, (_e, sessionId, input) => {
    if (typeof sessionId !== 'string' || !/^[\w.-]{1,200}$/.test(sessionId)) return ipcFail(IpcErrorCode.InvalidArg, '会话 ID 无效')
    return scopedHistory((root) => readAcpConversationProjectionEvents(root, sessionId, input))
  })
  handle(ipcInvoke.acp.historySession, (_e, id) => scopedHistory((root) => getAcpHistorySession(root, id)))
  handle(ipcInvoke.acp.historyUpdate, (_e, id, input) => {
    const root = getProjectRoot() ?? ''
    const generation = getProjectGeneration()
    return updateAcpHistorySession(root, id, input, () => getProjectRoot() === root && getProjectGeneration() === generation)
  })
  const deletions = new Set<string>()
  handle(ipcInvoke.acp.historyDelete, async (event, id: unknown, input: unknown) => {
    const parsed = acpHistoryDeleteRequestSchema.safeParse(input)
    if (!parsed.success || typeof id !== 'string' || !/^[\w.-]{1,200}$/.test(id) || id === '.' || id === '..') return ipcFail(IpcErrorCode.InvalidArg, '删除请求无效')
    const sender = event.sender, frame = event.senderFrame
    if (sender.isDestroyed() || !frame || frame.isDestroyed() || frame.parent || frame !== sender.mainFrame) return ipcFail(IpcErrorCode.Denied, '请从应用主页面确认永久删除')
    const originalUrl = frame.url, originalProcess = frame.processId, originalRouting = frame.routingId
    const root = getProjectRoot(), generation = getProjectGeneration()
    if (!root) return noProject()
    const pathKey = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
    if (pathKey(root) !== pathKey(parsed.data.expectedRoot)) return ipcFail(IpcErrorCode.Conflict, '项目已变化，请重新选择会话')
    let navigated = false
    const onNavigation = (_event: Electron.Event, _url: string, _inPlace: boolean, isMainFrame: boolean): void => { if (isMainFrame) navigated = true }
    const current = (): boolean => !navigated && !sender.isDestroyed() && !frame.isDestroyed() && event.senderFrame === frame && sender.mainFrame === frame
      && frame.url === originalUrl && frame.processId === originalProcess && frame.routingId === originalRouting
      && getProjectRoot() === root && getProjectGeneration() === generation
    const key = `${event.sender.id}:${id}`
    if (deletions.has(key)) return ipcFail(IpcErrorCode.Conflict, '此删除请求正在处理')
    deletions.add(key)
    sender.on('did-start-navigation', onNavigation)
    try {
      const existing = await getAcpHistorySession(root, id)
      if (!current()) return ipcFail(IpcErrorCode.Conflict, '项目已变化，未删除会话')
      if (!existing.ok) return existing
      if (existing.session.connectionGeneration !== parsed.data.expectedConnectionGeneration) return ipcFail(IpcErrorCode.Conflict, '会话连接已变化，请刷新后重试')
      const preview = await previewAcpHistoryDeletion(root, id, current)
      if (!preview.ok) return preview
      if (!current()) return ipcFail(IpcErrorCode.Conflict, '项目已变化，未删除会话')
      const parent = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.MessageBoxOptions = { type: 'warning', title: '永久删除本地会话', message: `永久删除“${preview.title}”？`,
        detail: `将删除：\n${preview.scope.map(value => `• ${value}`).join('\n')}\n\n保留：\n${preview.excluded.map(value => `• ${value}`).join('\n')}\n\n此操作无法撤销。`,
        buttons: ['取消', '永久删除本地会话及附件'], defaultId: 0, cancelId: 0, noLink: true }
      const choice = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
      if (choice.response !== 1) return { ok: true, sessionId: id, cancelled: true }
      if (!current()) return ipcFail(IpcErrorCode.Conflict, '项目已变化，未删除会话')
      approveNativeHistoryDeletion(app.getPath('userData'), root, id, preview.token)
      try { return await deleteAcpHistorySession(root, id, preview.token, current) }
      finally { discardNativeHistoryDeletion(app.getPath('userData'), preview.token) }
    } catch (error) { return ipcFail(IpcErrorCode.Io, error instanceof Error ? error.message : '永久删除未确认，请刷新后重试') }
    finally { sender.removeListener('did-start-navigation', onNavigation); deletions.delete(key) }
  })
  handle(ipcInvoke.acp.historyRegenerateTitle, (_event, id: string) => {
    const root = getProjectRoot() ?? '', generation = getProjectGeneration()
    return regenerateAcpHistoryTitle(root, id, () => getProjectRoot() === root && getProjectGeneration() === generation)
  })
  handle(ipcInvoke.acp.historyEvents, (_e, id, input) => scopedHistory((root) => getAcpHistoryEvents(root, id, input)))
  handle(ipcInvoke.acp.piImage, (_e, id, imageId) => scopedHistory((root) => getAcpPiImage(root, id, imageId)))
  handle(ipcInvoke.acp.piImageSave, async (event, id: string, imageId: string) => {
    const root = getProjectRoot()
    const generation = getProjectGeneration()
    if (!root) return noProject()
    const image = await getAcpPiImage(root, id, imageId)
    if (!image.ok) return image
    if (getProjectRoot() !== root || getProjectGeneration() !== generation) return noProject()
    const extension = image.image.mimeType === 'image/jpeg' ? 'jpg' : image.image.mimeType.slice(6)
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = { title: '保存图片', defaultPath: `图片.${extension}`, filters: [{ name: '图片', extensions: [extension] }] }
    const choice = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
    if (choice.canceled || !choice.filePath) return { ok: true, cancelled: true }
    if (getProjectRoot() !== root || getProjectGeneration() !== generation) return noProject()
    try { await writeFile(choice.filePath, Buffer.from(image.image.data, 'base64')); return { ok: true, cancelled: false } }
    catch { return ipcFail(IpcErrorCode.Io, '保存图片失败') }
  })
  handle(ipcInvoke.acp.historyRetry, (_e, id) => scopedHistory((root) => retryAcpHistorySession(root, id)))
  const connection = async <T extends { ok: boolean }>(root: string, _target: { sessionId?: string; profileId?: string }, action: () => Promise<T>): Promise<T | IpcFail> => {
    if (!root) return noProject()
    try { return await action() } // The daemon acquires the real ordinary connection admission.
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      return ipcFail(code === 'E_CONFLICT' || code === 'SCOPE_CHANGED' ? IpcErrorCode.Conflict : IpcErrorCode.Io, error instanceof Error ? error.message : '工作区暂不能接纳原生连接')
    }
  }
  handle(ipcInvoke.acp.sessionRecoverModel, (_e, id, input) => {
    const root = getProjectRoot() ?? ''
    const generation = getProjectGeneration()
    return connection(root, { sessionId: id }, () => recoverAcpSessionModel(root, id, input, () => getProjectRoot() === root && getProjectGeneration() === generation))
  })

  handle(ipcInvoke.acp.sessionNew, (_e, input: { agentId: string; taskDir?: string; profileId?: string }) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    return connection(root, { profileId: typeof input?.profileId === 'string' ? input.profileId : undefined }, () => newAcpSession(root, input))
  })

  handle(ipcInvoke.acp.sessionHandoffPreview, (_e, id: string, input: unknown) => {
    const parsed = acpHandoffPreviewInputSchema.safeParse(input)
    if (!parsed.success || !acpHandoffSessionIdSchema.safeParse(id).success) return ipcFail(IpcErrorCode.InvalidArg, '请选择有效的来源会话与目标 Runtime')
    return scopedHistory((root) => previewAcpSessionHandoff(root, id, parsed.data))
  })
  handle(ipcInvoke.acp.sessionHandoffCreate, (_e, id: string, input: unknown) => {
    const parsed = acpHandoffCreateInputSchema.safeParse(input)
    if (!parsed.success || !acpHandoffSessionIdSchema.safeParse(id).success) return ipcFail(IpcErrorCode.InvalidArg, '接续请求无效，请重新预览交接内容')
    const root = getProjectRoot() ?? ''
    const generation = getProjectGeneration()
    return createAcpSessionHandoff(root, id, parsed.data, () => getProjectRoot() === root && getProjectGeneration() === generation)
  })
  handle(ipcInvoke.acp.sessionHandoffStatus, (_e, id: string, operationId: string) => {
    if (!acpHandoffSessionIdSchema.safeParse(id).success || !acpHandoffOperationIdSchema.safeParse(operationId).success) return ipcFail(IpcErrorCode.InvalidArg, '接续操作标识无效')
    return scopedHistory((root) => getAcpSessionHandoff(root, id, operationId))
  })
  handle(ipcInvoke.acp.sessionHandoffCancel, (_e, id: string, input: unknown) => {
    const parsed = acpHandoffCancelInputSchema.safeParse(input)
    return parsed.success && acpHandoffSessionIdSchema.safeParse(id).success ? cancelAcpSessionHandoff(getProjectRoot() ?? '', id, parsed.data)
      : ipcFail(IpcErrorCode.InvalidArg, '接续操作标识无效')
  })

  handle(ipcInvoke.acp.sessionPrompt, async (_e, sessionId: string, text: string, options?: AcpPromptOptions) => {
    const root = getProjectRoot() ?? ''
    const generation = getProjectGeneration()
    if (!root) return noProject()
    if (options?.knowledgeReferences?.length && (options.expectedProjectGeneration !== generation || !options.expectedConnectionGeneration)) return ipcFail(IpcErrorCode.Conflict, '项目或会话已改变，请重新选择知识引用；内容尚未发送', { reason: 'SCOPE_CHANGED' })
    try {
      return await promptAcpSession(root, sessionId, text, options, () => getProjectRoot() === root && getProjectGeneration() === generation, generation)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      return ipcFail(code === 'E_CONFLICT' || code === 'SCOPE_CHANGED' ? IpcErrorCode.Conflict : IpcErrorCode.Io, error instanceof Error ? error.message : '工作区暂不能接纳新的修改指令')
    }
  })
  handle(ipcInvoke.acp.sessionBindTask, async (_e, sessionId: string, input: AcpBindTaskInput) => {
    const root = getProjectRoot() ?? ''
    const generation = getProjectGeneration()
    if (root && await isManagedWorkflowOrigin(root, sessionId, undefined, true)) return ipcFail(IpcErrorCode.Conflict, '请先停止托管工作流，再更改会话绑定的任务')
    return bindAcpSessionTask(root, sessionId, input, () => getProjectRoot() === root && getProjectGeneration() === generation)
  })

  handle(ipcInvoke.acp.sessionCancel, (_e, sessionId: string) => cancelAcpSession(getProjectRoot() ?? '', sessionId))

  handle(ipcInvoke.acp.sessionKill, async (_e, sessionId: string) => {
    const root = getProjectRoot() ?? ''
    if (root && await isManagedWorkflowOrigin(root, sessionId, undefined, true)) return ipcFail(IpcErrorCode.Conflict, '请先停止托管工作流，再结束关联会话')
    return killAcpSession(root, sessionId)
  })

  handle(ipcInvoke.acp.permissionRespond, (_e, requestId: string, optionId: string) => respondAcpPermission(getProjectRoot() ?? '', requestId, optionId))
  handle(ipcInvoke.acp.profiles, () => listAcpProfiles(getProjectRoot() ?? ''))
  handle(ipcInvoke.acp.profileSave, (_e, input) => saveAcpProfile(getProjectRoot() ?? '', input))
  handle(ipcInvoke.acp.profileDelete, (_e, id: string) => deleteAcpProfile(getProjectRoot() ?? '', id))
  handle(ipcInvoke.acp.runtimeRefresh, () => listAcpAgents(true))
  handle(ipcInvoke.acp.runtimeSetup, (_e, id: string) => setupAcpRuntime(id))
  handle(ipcInvoke.acp.runtimeNodePick, () => pickAcpNode())
  handle(ipcInvoke.acp.runtimeTest, (_e, id: string) => testAcpRuntimeConnection(id))
  handle(ipcInvoke.acp.runtimePathPick, (_e, id: string) => pickAcpRuntimePath(id))
  handle(ipcInvoke.acp.sessionResume, (_e, id: string) => { const root = getProjectRoot() ?? ''; return connection(root, { sessionId: id }, () => resumeAcpSession(root, id)) })
  handle(ipcInvoke.acp.sessionConfigure, (_e, id: string, input) => { const root = getProjectRoot() ?? ''; return connection(root, { sessionId: id }, () => configureAcpSession(root, id, input)) })
}

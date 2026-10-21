/** Main-owned fixed-document views. Immutable bytes stay in the shared material store. */
import { BrowserWindow } from 'electron'
import { statSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'
import { z } from 'zod'
import { ipcEvent, ipcInvoke } from '../../shared/ipc-channels'
import { documentDiffRequestSchema, documentReadRequestSchema, documentReadScopeSchema, documentWatchRequestSchema } from '../../shared/documents'
import { fixedDocumentTokenSchema, readerOriginSchema, type ReaderOrigin } from '../../shared/document-windows'
import { IpcErrorCode, ipcFail, noProject } from '../../shared/ipc-errors'
import { getProjectRoot, getProjectGeneration, getSnapshot, openProjectAt } from '../state'
import { getAcpHistorySession, listAcpSessions } from '../services/acp'
import { readDocument, computeDocumentDiff, watchReaderDocument, unwatchReaderDocument, clearReaderDocumentOwner } from '../services/documents'
import { configureDocumentViews } from '../services/document-views'
import { sameRoot } from '../services/observability/identity'
import { parseTrellisTaskPath, readTrellisTaskId, taskRefFor } from '../services/task-identity'
import { resolveAuthorizedDocumentPath } from '../services/documents/paths'
import { handle } from './registry'
import type { WindowDeps } from './deps'

export function registerDocumentViewIpc(deps: WindowDeps): void {
  const service = configureDocumentViews(() => ({ projectRoot: getProjectRoot(), generation: getProjectGeneration() }))
  const watchOwners = new Set<number>()
  const legacyKeys = new Map<string, { root: string; key: string }>()
  const fail = (error: unknown) => ipcFail(IpcErrorCode.Io, error instanceof Error ? error.message : '文档操作未完成')
  const currentRoot = (senderId: number): string | null => service.rootForSender(senderId)
  const validateOrigin = async (root: string, input?: ReaderOrigin, expectedTaskRef?: string | null): Promise<ReaderOrigin | null> => {
    if (!input) return null
    const value = readerOriginSchema.parse(input)
    if (value.sessionId) {
      const live = listAcpSessions(root)
      const current = live.ok ? live.sessions.find((session) => session.sessionId === value.sessionId) : undefined
      if (current) {
        if (value.connectionGeneration !== undefined && current.connectionGeneration !== value.connectionGeneration) throw new Error('来源会话连接已改变，未跳转到新的连接')
      } else {
        const archived = await getAcpHistorySession(root, value.sessionId)
        if (!archived.ok) throw new Error('来源会话已不可用，未改为其他会话')
        if (value.connectionGeneration !== undefined && archived.session.connectionGeneration !== value.connectionGeneration) throw new Error('来源会话连接版本无法核对')
      }
    }
    if (value.taskDir) {
      const snap = getSnapshot()
      const candidates = snap && sameRoot(snap.meta.root, root) ? [...snap.tasks, ...snap.archived] : []
      const identity = (path: string): string | null => {
        const authorized = resolveAuthorizedDocumentPath(root, resolve(path, 'task.json'))
        if (!authorized.ok || !authorized.exists) return null
        try { if (!statSync(authorized.canonicalPath).isFile()) return null } catch { return null }
        const parsed = parseTrellisTaskPath(root, authorized.absPath)
        return parsed ? taskRefFor(readTrellisTaskId(root, parsed.repoRelativeDir), parsed.repoRelativeDir) : null
      }
      const exact = candidates.filter((item) => (item.dirName === value.taskDir || sameRoot(item.path, resolve(root, value.taskDir ?? ''))) && (expectedTaskRef ? identity(item.path) === expectedTaskRef : identity(item.path) !== null))
      const matching = exact.length ? exact : expectedTaskRef ? candidates.filter((item) => identity(item.path) === expectedTaskRef) : []
      const task = matching.length === 1 ? matching[0] : null
      if (!task) throw new Error('来源任务已不可用')
      value.taskDir = task.path
    }
    return value
  }
  const open = async (sender: Electron.WebContents, token: string, origin?: ReaderOrigin, legacyKey?: string, title?: string, theme = 'dark') => {
    const root = currentRoot(sender.id)
    if (!root) return noProject()
    const generation = getProjectGeneration()
    const fixed = await service.readFixed(root, fixedDocumentTokenSchema.parse(token), { workspaceId: root })
    const taskSource = parseTrellisTaskPath(root, fixed.source.canonicalPath)
    const sourceOrigin = origin ?? (taskSource ? { taskDir: resolve(root, taskSource.repoRelativeDir) } : undefined)
    const expectedTaskRef = !origin && taskSource ? await service.taskRefForVersion(root, token) : undefined
    const checkedOrigin = await validateOrigin(root, sourceOrigin, expectedTaskRef)
    if (!service.ownedView(sender.id) && !service.isActive(root, generation)) return ipcFail(IpcErrorCode.Conflict, '项目已切换，未打开其他项目的文档')
    const view = service.createView(root, token, checkedOrigin)
    const key = legacyKey ?? `reader:${view.id}`
    let result: ReturnType<WindowDeps['openDocWindow']>
    try { result = deps.openDocWindow({ key, title: title ?? fixed.fixedVersion?.title ?? '文档', file: '', theme, readerViewId: view.id, placementKey: token,
      anchorBounds: BrowserWindow.fromWebContents(sender)?.getBounds(),
      onCreated: (id) => service.attachView(view.id, id),
      onClosed: () => { service.closeView(view.id); if (legacyKey) legacyKeys.delete(legacyKey) } }) }
    catch (error) { service.closeView(view.id); throw error }
    if (!result.ok || result.focused) service.closeView(view.id)
    if (!result.ok) return ipcFail(IpcErrorCode.Io, result.error ?? '文档窗口未能打开')
    if (legacyKey) legacyKeys.set(legacyKey, { root, key })
    return { ok: true as const, viewId: view.id, focused: result.focused }
  }
  handle(ipcInvoke.doc.open, async (event, raw: unknown) => {
    const parsed = z.object({ key: z.string().min(1).max(4096), title: z.string().max(500), file: z.string().min(1).max(4096), theme: z.string().optional() }).safeParse(raw)
    if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '文档打开参数无效')
    const root = getProjectRoot()
    if (!root) return noProject()
    const input = parsed.data
    const path = isAbsolute(input.file) ? relative(root, input.file).replace(/\\/g, '/') : input.file
    try {
      const captured = await service.capturePath(root, path)
      if (!captured.ok) return captured
      const key = `legacy:${JSON.stringify([root, captured.version.relativePath])}`
      if (legacyKeys.has(key)) return deps.openDocWindow({ ...input, key, theme: input.theme ?? 'dark' })
      return await open(event.sender, captured.version.token, undefined, key, input.title, input.theme)
    } catch (error) { return fail(error) }
  })
  handle(ipcInvoke.doc.read, async (_event, path: unknown) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    if (typeof path !== 'string') return ipcFail(IpcErrorCode.InvalidArg, '文档路径无效')
    const read = await readDocument(root, { workspaceId: root }, { relativePath: isAbsolute(path) ? relative(root, path).replace(/\\/g, '/') : path, requestId: 'legacy-doc-read' })
    if (!read.ok) return read
    if (read.rawText === null) return ipcFail(IpcErrorCode.Io, read.diagnostics[0]?.message ?? '文档不可读')
    return { ok: true, content: read.rawText, mtime: read.source.mtimeMs ?? undefined }
  })
  handle(ipcInvoke.doc.setPin, (event, on: unknown) => {
    if (typeof on !== 'boolean' || !deps.isDocWindowSender(event.sender.id)) return ipcFail(IpcErrorCode.Denied, '此窗口不能更改文档置顶状态')
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return ipcFail(IpcErrorCode.NotFound, '文档窗口已关闭')
    win.setAlwaysOnTop(on, 'screen-saver')
    return { ok: true, pinned: win.isAlwaysOnTop() }
  })
  handle(ipcInvoke.doc.versions, async (event, token: unknown, cursor: unknown) => {
    const root = currentRoot(event.sender.id)
    if (!root) return noProject()
    if ((token !== undefined && !fixedDocumentTokenSchema.safeParse(token).success) || (cursor !== undefined && !fixedDocumentTokenSchema.safeParse(cursor).success)) return ipcFail(IpcErrorCode.InvalidArg, '固定版本标识无效')
    const generation = getProjectGeneration()
    try { const result = await service.catalog(root, token as string | undefined, cursor as string | undefined); return service.ownedView(event.sender.id) || service.isActive(root, generation) ? result : ipcFail(IpcErrorCode.Conflict, '项目已切换，未采用其他项目的版本列表') } catch (error) { return fail(error) }
  })
  handle(ipcInvoke.doc.captureVersion, async (event, path: unknown) => {
    const root = currentRoot(event.sender.id)
    if (!root) return noProject()
    if (typeof path !== 'string' || path.length > 2048) return ipcFail(IpcErrorCode.InvalidArg, '项目文档路径无效')
    const view = service.ownedView(event.sender.id)
    if (view && !service.isActive(view.root, view.generation)) return ipcFail(IpcErrorCode.Conflict, '来源项目已切换，请回到该项目再读取当前文件')
    try { return await service.capturePath(root, path) } catch (error) { return fail(error) }
  })
  handle(ipcInvoke.doc.compareVersions, async (event, raw: unknown) => {
    const root = currentRoot(event.sender.id)
    if (!root) return noProject()
    const parsed = z.object({ left: fixedDocumentTokenSchema, right: fixedDocumentTokenSchema, requestId: z.string().min(1).max(256) }).strict().safeParse(raw)
    if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '文档对照参数无效')
    const generation = getProjectGeneration()
    try { const result = await service.compare(root, parsed.data); return service.ownedView(event.sender.id) || service.isActive(root, generation) ? result : ipcFail(IpcErrorCode.Conflict, '项目已切换，未采用这次对照') } catch (error) { return fail(error) }
  })
  handle(ipcInvoke.doc.openVersion, async (event, raw: unknown) => {
    const parsed = z.object({ token: fixedDocumentTokenSchema, origin: readerOriginSchema.optional() }).strict().safeParse(raw)
    if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '固定版本打开参数无效')
    try { return await open(event.sender, parsed.data.token, parsed.data.origin) } catch (error) { return fail(error) }
  })
  handle(ipcInvoke.doc.bootstrap, (event) => service.bootstrap(event.sender.id, BrowserWindow.fromWebContents(event.sender)?.isAlwaysOnTop() ?? false))
  handle(ipcInvoke.doc.sourceState, (event, ...args: unknown[]) => {
    if (args.length) return ipcFail(IpcErrorCode.InvalidArg, '来源状态查询不接受其他窗口或来源参数')
    const view = service.ownedView(event.sender.id)
    if (!view) return ipcFail(IpcErrorCode.Denied, '没有已登记的文档视图')
    try { return { ok: true as const, sourceActive: service.isActive(view.root, view.generation) } }
    catch (error) { return fail(error) }
  })
  handle(ipcInvoke.doc.current, async (event, scope: unknown, input: unknown) => {
    const view = service.ownedView(event.sender.id)
    if (!view) return ipcFail(IpcErrorCode.Denied, '没有已登记的文档视图')
    if (!service.isActive(view.root, view.generation)) return ipcFail(IpcErrorCode.Conflict, '来源项目已切换；固定版本仍可阅读，跟踪更新请从来源项目重新打开')
    const a = documentReadScopeSchema.safeParse(scope); const b = documentReadRequestSchema.safeParse(input)
    if (!a.success || !b.success) return ipcFail(IpcErrorCode.InvalidArg, '阅读参数无效')
    try {
      const fixed = await service.readFixed(view.root, view.token, a.data)
      if (b.data.relativePath.replace(/\\/g, '/') !== fixed.source.relativePath) return ipcFail(IpcErrorCode.Denied, '此视图不能读取其他来源')
      const read = await readDocument(view.root, a.data, b.data)
      const captured = read.ok ? await service.captureRead(view.root, read) : read
      return service.isActive(view.root, view.generation) ? captured : ipcFail(IpcErrorCode.Conflict, '项目已切换，未替换当前正文')
    } catch (error) { return fail(error) }
  })
  handle(ipcInvoke.doc.watch, async (event, scope: unknown, input: unknown) => {
    const view = service.ownedView(event.sender.id)
    const a = documentReadScopeSchema.safeParse(scope); const b = documentWatchRequestSchema.safeParse(input)
    if (!view || !a.success || !b.success || !service.isActive(view.root, view.generation)) return ipcFail(IpcErrorCode.Conflict, '来源项目已切换，固定版本保持不变')
    try {
      const fixed = await service.readFixed(view.root, view.token, a.data)
      if (fixed.source.relativePath !== b.data.relativePath.replace(/\\/g, '/')) return ipcFail(IpcErrorCode.Denied, '监听来源不匹配')
      if (!service.isActive(view.root, view.generation)) return ipcFail(IpcErrorCode.Conflict, '来源项目已切换')
      const result = watchReaderDocument(view.root, a.data, b.data, { projectRoot: view.root, projectGeneration: view.generation, ownerId: event.sender.id })
      if (result.ok && !watchOwners.has(event.sender.id)) {
        watchOwners.add(event.sender.id)
        event.sender.once('destroyed', () => { watchOwners.delete(event.sender.id); clearReaderDocumentOwner(event.sender.id) })
      }
      return result
    } catch (error) { return fail(error) }
  })
  handle(ipcInvoke.doc.unwatch, (event, path: unknown, watchId: unknown) => {
    const view = service.ownedView(event.sender.id)
    if (view && typeof path === 'string' && typeof watchId === 'string') unwatchReaderDocument(path, watchId, { projectRoot: view.root, projectGeneration: view.generation, ownerId: event.sender.id })
  })
  handle(ipcInvoke.doc.diff, async (event, scope: unknown, input: unknown) => {
    const view = service.ownedView(event.sender.id); const a = documentReadScopeSchema.safeParse(scope); const b = documentDiffRequestSchema.safeParse(input)
    if (!view || !a.success || !b.success) return ipcFail(IpcErrorCode.InvalidArg, '文档对照参数无效')
    if (b.data.baseline.kind === 'git-latest-commit' && !service.isActive(view.root, view.generation)) return ipcFail(IpcErrorCode.Conflict, '来源项目已切换，未读取新的 Git 基线')
    try {
      const fixed = await service.readFixed(view.root, view.token, a.data)
      if (fixed.source.relativePath !== b.data.relativePath.replace(/\\/g, '/')) return ipcFail(IpcErrorCode.Denied, '对照来源不匹配')
      if (b.data.baseline.kind === 'git-latest-commit' && !service.isActive(view.root, view.generation)) return ipcFail(IpcErrorCode.Conflict, '来源项目已切换')
    } catch (error) { return fail(error) }
    return computeDocumentDiff(view.root, a.data, b.data)
  })
  handle(ipcInvoke.doc.returnOrigin, async (event) => {
    const view = service.ownedView(event.sender.id)
    if (!view) return ipcFail(IpcErrorCode.Denied, '文档来源未登记')
    const current = getProjectRoot()
    if (!current || !sameRoot(current, view.root)) { const opened = openProjectAt(view.root); if (!opened.ok) return opened }
    const generation = getProjectGeneration()
    try {
      const origin = await validateOrigin(view.root, view.origin ?? undefined, view.originTaskRef)
      if (service.ownedView(event.sender.id) !== view || !service.isActive(view.root, generation)) return ipcFail(IpcErrorCode.Conflict, '项目或来源窗口已改变，未跳转到其他来源')
      deps.showMain()
      if (!service.isActive(view.root, generation)) return ipcFail(IpcErrorCode.Conflict, '项目已切换，未发送来源跳转')
      const main = deps.getMain()
      if (!main || main.isDestroyed()) return ipcFail(IpcErrorCode.NotFound, '主窗口不可用')
      main.webContents.send(ipcEvent.documentOriginReturn, { projectRoot: view.root, ...(origin ?? {}) })
      return { ok: true }
    } catch (error) { return fail(error) }
  })
}

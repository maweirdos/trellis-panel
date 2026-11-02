import { app, dialog, shell, type IpcMainInvokeEvent } from 'electron'
import { extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { ipcEvent, ipcInvoke } from '../../shared/ipc-channels'
import { conversationOpenFileSchema, conversationReadFileSchema, type ConversationResult } from '../../shared/private-conversations'
import { ipcFail, IpcErrorCode } from '../../shared/ipc-errors'
import { PrivateConversations, ConversationError, privateConversationNative } from '../services/private-conversations/service'
import { saveSelectedFile } from '../services/private-conversations/files'
import { readConversationGit } from '../services/private-conversations/git'
import { ConversationRequirements } from '../services/private-conversations/requirements'
import { openProjectAt } from '../state'
import { broadcastToWindows } from '../services/bridge'
import { handle } from './registry'
import type { WindowDeps } from './deps'

export function registerPrivateConversationsIpc(deps: WindowDeps): PrivateConversations {
  let requirements: ConversationRequirements
  const service = new PrivateConversations({ directory: () => app.getPath('userData'), native: privateConversationNative,
    workspaceHasRequirements: id => requirements.hasDrafts(id),
    publish: (channel, payload) => { if (Object.values(ipcEvent).includes(channel as typeof ipcEvent.acpOutput)) broadcastToWindows(channel, payload) },
    active: () => { const main = deps.getMain(); return Boolean(main && !main.isDestroyed() && main.isVisible() && !main.isMinimized()) } })
  requirements = new ConversationRequirements({
    metaDirectory: () => service.metadataDirectory(),
    owner: id => service.workspaceAccess(id),
    selectedFile: async (id, fileId, revision) => {
      const actual = await service.file(id, fileId, revision)
      return { bytes: actual.bytes, file: actual.file }
    },
    resolveTarget: (conversation, selection, directoryOwner, current) => {
      current?.()
      if (selection.kind === 'directory') return service.consumeWorkspaceGrant(selection.grantId, directoryOwner).root
      if (conversation.kind !== 'code' || conversation.workspace.kind !== 'directory') throw new ConversationError('请明确选择 Trellis 工程', IpcErrorCode.InvalidArg)
      return conversation.workspace.root
    },
    openTask: async (root, taskDir, current) => {
      current?.()
      const result = openProjectAt(root)
      if (!result.ok) throw new ConversationError(result.error, result.code)
      return { snapshot: result.snapshot, taskDir }
    }
  })
  app.once('will-quit', () => service.dispose())
  const channels = ipcInvoke.privateConversations
  const documents = new WeakMap<Electron.WebContents, { frame: Electron.WebFrameMain; owner: object }>()
  const watched = new WeakSet<Electron.WebContents>()
  function releaseDocument(sender: Electron.WebContents): void {
    const document = documents.get(sender)
    if (document) service.releaseDirectoryGrants(document.owner)
    documents.delete(sender)
  }
  function documentOwner(event: IpcMainInvokeEvent): object {
    const sender = event.sender, frame = event.senderFrame
    if (!frame) throw new ConversationError('原页面不可用', IpcErrorCode.Denied)
    if (!watched.has(sender)) {
      watched.add(sender)
      sender.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => { if (isMainFrame && !inPlace) releaseDocument(sender) })
      sender.on('render-process-gone', () => releaseDocument(sender))
      sender.once('destroyed', () => releaseDocument(sender))
    }
    const previous = documents.get(sender)
    if (previous?.frame === frame) return previous.owner
    releaseDocument(sender)
    const owner = Object.freeze({})
    documents.set(sender, { frame, owner })
    return owner
  }
  function capture(event: IpcMainInvokeEvent): () => void {
    const frame = event.senderFrame, main = deps.getMain()
    if (!main || main.isDestroyed() || main.webContents !== event.sender || !frame || frame !== event.sender.mainFrame || frame.parent) throw new ConversationError('请从应用主页面操作私有会话', IpcErrorCode.Denied)
    // Reading a Markdown anchor keeps the same document and its admitted work.
    const documentUrl = (value: string): string => { const url = new URL(value); url.hash = ''; return url.href }
    const processId = frame.processId, routingId = frame.routingId, url = documentUrl(frame.url), owner = documentOwner(event)
    return () => { if (event.sender.isDestroyed() || frame.isDestroyed() || event.sender.mainFrame !== frame || frame.processId !== processId || frame.routingId !== routingId || documentUrl(frame.url) !== url || documents.get(event.sender)?.owner !== owner) throw new ConversationError('原页面已变化，请重新操作') }
  }
  const fail = (error: unknown) => ipcFail(error instanceof ConversationError ? error.code : error instanceof z.ZodError ? IpcErrorCode.InvalidArg : IpcErrorCode.Io,
    error instanceof Error ? error.message : '私有会话操作未完成')
  const wrapped = <T>(channel: string, action: (event: IpcMainInvokeEvent, args: unknown[], current: () => void) => Promise<T>): void => {
    handle(channel, async (event, ...args: unknown[]): Promise<ConversationResult<T>> => {
      try { const current = capture(event); current(); const value = await action(event, args, current); current(); return { ok: true, value } }
      catch (error) { return fail(error) }
    })
  }
  const direct = (channel: string, action: (args: unknown[], current: () => void, event: IpcMainInvokeEvent) => Promise<unknown>): void => {
    handle(channel, async (event, ...args: unknown[]) => { try { const current = capture(event); current(); const result = await action(args, current, event); current(); return result } catch (error) { return fail(error) } })
  }
  const id = (value: unknown): string => z.string().uuid().parse(value)
  wrapped(channels.list, (_event, args) => service.list(args[0]))
  wrapped(channels.createDraft, (event, args) => service.createDraft(args[0], documentOwner(event)))
  wrapped(channels.updateDraft, (event, args) => service.updateDraft(id(args[0]), args[1], documentOwner(event)))
  wrapped(channels.read, (_event, args) => service.read(id(args[0])))
  direct(channels.events, args => service.events(id(args[0]), args[1] as Parameters<typeof service.events>[1]))
  direct(channels.send, args => service.send(id(args[0]), args[1]))
  direct(channels.respond, args => service.control('respond', id(args[0]), args[1]))
  direct(channels.cancel, args => service.control('cancel', id(args[0]), args[1]))
  direct(channels.end, args => service.control('end', id(args[0]), args[1]))
  direct(channels.configure, args => service.configure(id(args[0]), args[1]))
  direct(channels.recoverModel, args => service.recoverModel(id(args[0]), args[1]))
  wrapped(channels.projects, () => service.projects())
  wrapped(channels.createProject, (_event, args) => service.createProject(args[0]))
  wrapped(channels.reclassify, (_event, args) => service.reclassify(id(args[0]), args[1]))
  const requirementChannels = channels.requirements
  direct(requirementChannels.list, (args, current) => requirements.list(id(args[0]), current))
  direct(requirementChannels.create, (args, current) => requirements.create(id(args[0]), args[1], current))
  direct(requirementChannels.read, (args, current) => requirements.read(id(args[0]), id(args[1]), current))
  direct(requirementChannels.save, (args, current) => requirements.save(id(args[0]), id(args[1]), args[2], current))
  direct(requirementChannels.sync, (args, current) => requirements.sync(id(args[0]), id(args[1]), args[2], current))
  direct(requirementChannels.prompt, (args, current) => requirements.prompt(id(args[0]), id(args[1]), args[2], current))
  direct(requirementChannels.target, (args, current, event) => requirements.target(id(args[0]), id(args[1]), args[2], documentOwner(event), current))
  direct(requirementChannels.commit, (args, current) => requirements.commit(id(args[0]), id(args[1]), args[2], current))
  direct(requirementChannels.open, (args, current) => requirements.open(id(args[0]), id(args[1]), current))
  wrapped(channels.files, (_event, args) => service.files(id(args[0])))
  wrapped(channels.git, async (_event, args, current) => {
    const owner = await service.workspaceAccess(id(args[0]))
    if (owner.conversation.kind !== 'code' || owner.conversation.workspace.kind !== 'directory') throw new ConversationError('Git 仅用于 Code 会话目录', IpcErrorCode.InvalidArg)
    current(); owner.assertCurrent()
    const value = await readConversationGit(owner.conversation.workspace.root)
    current(); owner.assertCurrent()
    return value
  })
  wrapped(channels.pickDirectory, async (event, args, current) => {
    const input = z.object({ purpose: z.enum(['code', 'trellis-requirement']) }).strict().optional().parse(args[0])
    const main = deps.getMain()
    if (!main) throw new ConversationError('主窗口不可用')
    const choice = await dialog.showOpenDialog(main, { title: input?.purpose === 'trellis-requirement' ? '选择 Trellis 工程' : '选择 Code 工作目录', properties: ['openDirectory'] })
    current()
    if (choice.canceled || !choice.filePaths[0]) return null
    return service.grantDirectory(choice.filePaths[0], documentOwner(event))
  })
  wrapped(channels.pickFiles, async (_event, args, current) => {
    const conversationId = id(args[0]), first = await service.read(conversationId), main = deps.getMain()
    if (!main) throw new ConversationError('主窗口不可用')
    current()
    const choice = await dialog.showOpenDialog(main, { title: '选入会话文件', defaultPath: first.conversation.workspace.root, properties: ['openFile', 'multiSelections'] })
    current()
    if (choice.canceled) return []
    const latest = await service.read(conversationId)
    if (latest.conversation.workspace.root !== first.conversation.workspace.root || latest.conversation.creatorId !== first.conversation.creatorId) throw new ConversationError('原会话目录或创建者已变化')
    current(); return service.importFiles(conversationId, choice.filePaths)
  })
  wrapped(channels.openFile, async (_event, args, current) => {
    const input = conversationOpenFileSchema.parse(args[1]), actual = await service.file(id(args[0]), input.fileId)
    current()
    if (input.action === 'reveal') shell.showItemInFolder(actual.path)
    else {
      if (!new Set(['.md', '.txt', '.html', '.htm', '.pdf', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.docx', '.xlsx', '.pptx', '.csv']).has(extname(actual.path).toLowerCase())) throw new ConversationError('此文件请使用“在文件夹中显示”后自行选择应用', IpcErrorCode.Denied)
      await shell.openExternal(pathToFileURL(actual.path).href)
    }
    return null
  })
  wrapped(channels.readFile, async (_event, args) => {
    const input = conversationReadFileSchema.parse(args[1]), actual = await service.file(id(args[0]), input.fileId, input.expectedRevision, 256 * 1024)
    const extension = extname(actual.path).toLowerCase()
    if (!['.md', '.txt', '.html', '.htm'].includes(extension)) throw new ConversationError('此文件不支持作为文档正文读取', IpcErrorCode.InvalidArg)
    return { name: actual.file.name, body: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(actual.bytes), kind: extension === '.html' || extension === '.htm' ? 'prototype' as const : 'document' as const, revision: actual.file.revision, modifiedAt: actual.modifiedAt }
  })
  direct(channels.image, args => service.image(id(args[0]), z.string().regex(/^[a-f0-9]{64}$/).parse(args[1])))
  wrapped(channels.saveImage, async (_event, args, current) => {
    const conversationId = id(args[0]), imageId = z.string().regex(/^[a-f0-9]{64}$/).parse(args[1]), image = await service.image(conversationId, imageId)
    if (!image.ok) throw new ConversationError(image.error, image.code)
    const main = deps.getMain()
    if (!main) throw new ConversationError('主窗口不可用')
    current()
    const choice = await dialog.showSaveDialog(main, { title: '保存图片', defaultPath: `图片.${image.value.mimeType === 'image/jpeg' ? 'jpg' : image.value.mimeType.slice(6)}` })
    current()
    if (choice.canceled || !choice.filePath) return { cancelled: true }
    const latest = await service.image(conversationId, imageId)
    if (!latest.ok) throw new ConversationError(latest.error, latest.code)
    saveSelectedFile(choice.filePath, Buffer.from(latest.value.data, 'base64'), current)
    return { cancelled: false }
  })
  return service
}

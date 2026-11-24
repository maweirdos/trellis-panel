import { app, dialog, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { workspaceGrantSchema } from '../../shared/daemon'
import { desktopConversationTaskFields, runtimeBodies } from '../../shared/daemon-runtime'
import { ipcInvoke } from '../../shared/ipc-channels'
import { ipcFail, IpcErrorCode, noProject, type IpcFail } from '../../shared/ipc-errors'
import { modelSelectionIdSchema } from '../../shared/model-selection'
import { ConversationAttachmentBytesInputSchema } from '../../shared/conversation/attachments'
import { conversationTaskLocatorSchema, sameConversationTaskLocator, type ConversationTaskLocator } from '../../shared/conversation/task-scope'
import type { NativeConversationTask } from '../../shared/conversation/task-native'
import { DaemonError } from '../daemon/errors'
import { getProjectGeneration, getProjectRoot } from '../state'
import {
  applyConversationCommand, createConversationThread, describeConversationDriver, listConversationDrivers, listConversationModels,
  listConversationThreads, readConversationCommand, readConversationEventDelta, readConversationEvents, readConversationHistory,
  readConversationThread, readConversationThreadCommand, listConversationAttachments, readConversationAttachment,
  readConversationTaskScope, releaseConversationAttachment, stageConversationAttachment,
} from '../services/daemon-client/conversation'
import { readHostConversationAttachmentFile } from '../services/conversation/attachments'
import { captureDesktopConversationTask } from '../services/conversation/task-scope'
import { checkedDirectory, directoryIdentity, ownedDirectory, pathKey } from '../services/private-conversations/files'
import { captureAppWindowDocument } from '../services/window-navigation'
import { handle } from './registry'

const rootSchema = workspaceGrantSchema.shape.root.regex(/^[^\u0000-\u001f\u007f]+$/u)
const createBody = runtimeBodies['runtime.conversationCreate']
const createSchema = createBody.extend({
  ...desktopConversationTaskFields,
  cwd: rootSchema,
  model: modelSelectionIdSchema.refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value)),
  instanceId: createBody.shape.instanceId.regex(/^[\w.-]+$/)
})
const threadIdSchema = runtimeBodies['runtime.conversationRead'].shape.threadId.regex(/^[\w.-]+$/)
const commandIdSchema = runtimeBodies['runtime.conversationCommand'].shape.commandId
const desktopTaskScope = { cwd: rootSchema, ...desktopConversationTaskFields }
const eventsSchema = runtimeBodies['runtime.conversationEvents'].extend({ ...desktopTaskScope, threadId: threadIdSchema })
const applySchema = runtimeBodies['runtime.conversationApply'].extend(desktopTaskScope)
const threadCommandSchema = runtimeBodies['runtime.conversationThreadCommand'].extend(desktopTaskScope)
const deltaSchema = runtimeBodies['runtime.conversationEventDelta'].extend(desktopTaskScope)
const historySchema = runtimeBodies['runtime.conversationHistory'].extend(desktopTaskScope)
const listSchema = runtimeBodies['runtime.conversationList'].extend(desktopConversationTaskFields)
const describeDriverSchema = runtimeBodies['runtime.conversationDescribeDriver'].extend(desktopTaskScope)
const attachmentTarget = runtimeBodies['runtime.conversationAttachmentList'].extend(desktopTaskScope)
const attachmentStage = attachmentTarget.extend(ConversationAttachmentBytesInputSchema.shape)
const attachmentRelease = runtimeBodies['runtime.conversationAttachmentRelease'].extend(desktopTaskScope)
const attachmentRead = runtimeBodies['runtime.conversationAttachmentRead'].extend(desktopTaskScope)
const workDirectoryName = 'conversation-v2-workspace'

type ConversationScope = {
  root: string
  matchesRoot: (value: unknown) => boolean
  isCurrent: () => boolean
  task?: NativeConversationTask
}

type DesktopTaskGrant = {
  task: NativeConversationTask
  root: string
  identity: string
  isCurrent: () => boolean
}

const taskGrants = new WeakMap<BrowserWindow, Map<string, DesktopTaskGrant>>()

function rememberTaskGrant(window: BrowserWindow, grant: DesktopTaskGrant, scopeKey: string): void {
  let grants = taskGrants.get(window)
  if (!grants) {
    grants = new Map()
    taskGrants.set(window, grants)
  }
  grants.set(scopeKey, grant)
  if (grants.size > 64) {
    const oldest = grants.keys().next().value
    if (oldest) grants.delete(oldest)
  }
}

function withTask<T extends { task?: ConversationTaskLocator }>(scope: ConversationScope, input: T): Omit<T, 'task'> & { task?: NativeConversationTask } {
  const { task: _locator, ...body } = input
  return { ...body, ...(scope.task && { task: scope.task }) }
}

const taskScopeFailure = (error: unknown): IpcFail => {
  const code = error instanceof DaemonError ? Object.values(IpcErrorCode).find(value => value === error.code) : undefined
  return ipcFail(code ?? IpcErrorCode.Unavailable, error instanceof DaemonError ? error.message : '无法核实原团队任务。', { outcome: 'not-admitted' })
}

function captureScope(window: BrowserWindow | null, event: IpcMainInvokeEvent, getMain: () => BrowserWindow | null, requestedRoot: unknown, requestedTask: unknown): ConversationScope | IpcFail {
  const isDocumentCurrent = window && captureAppWindowDocument(window, event)
  if (!isDocumentCurrent) return ipcFail(IpcErrorCode.Denied, '请从应用主页面访问会话。', { outcome: 'not-admitted' })
  const userData = app.getPath('userData')
  const managed = join(userData, workDirectoryName)
  const requested = rootSchema.safeParse(requestedRoot)
  const task = conversationTaskLocatorSchema.optional().safeParse(requestedTask)
  if (!requested.success || !task.success) return ipcFail(IpcErrorCode.InvalidArg, '会话请求参数无效。', { outcome: 'not-admitted' })
  const sameDocument = (): boolean => getMain() === window && isDocumentCurrent() && app.getPath('userData') === userData
  const isWork = pathKey(requested.data) === pathKey(managed)
  const generation = getProjectGeneration()
  let selected = isWork ? managed : getProjectRoot()
  let taskGrant: DesktopTaskGrant | undefined
  if (task.data) {
    taskGrant = window && task.data.scopeKey ? taskGrants.get(window)?.get(task.data.scopeKey) : undefined
    if (!taskGrant || !taskGrant.isCurrent() || !sameConversationTaskLocator(taskGrant.task.locator, task.data)
        || pathKey(taskGrant.root) !== pathKey(requested.data)) {
      return ipcFail(IpcErrorCode.Conflict, '任务或原工程目录发生了变化。', { outcome: 'not-admitted' })
    }
    selected = taskGrant.root
  }
  if (!selected) return noProject()
  try {
    const root = rootSchema.parse(checkedDirectory(rootSchema.parse(selected)))
    const identity = directoryIdentity(selected)
    if (taskGrant && identity !== taskGrant.identity) {
      return ipcFail(IpcErrorCode.Conflict, '任务工作目录的物理身份发生了变化。', { outcome: 'not-admitted' })
    }
    return {
      root,
      matchesRoot: value => {
        const parsed = rootSchema.safeParse(value)
        return parsed.success && [selected, root].some(candidate => pathKey(candidate) === pathKey(parsed.data))
      },
      isCurrent: () => {
        if (!sameDocument()) return false
        if (!task.data && !isWork && (getProjectRoot() !== selected || getProjectGeneration() !== generation)) return false
        try { return (taskGrant?.isCurrent() ?? true) && directoryIdentity(selected) === identity } catch { return false }
      },
      task: taskGrant?.task,
    }
  } catch {
    return ipcFail(IpcErrorCode.Conflict, '原工程目录无法核实，请重新选择工程。', { outcome: 'not-admitted' })
  }
}

async function inScope<T extends { ok: boolean }>(scope: ConversationScope, request: () => Promise<T>, commandId?: string): Promise<T | IpcFail> {
  const changed = (): IpcFail => ipcFail(IpcErrorCode.Conflict, '页面或工程已变化，请重新加载会话。', commandId ? { commandId, outcome: 'not-admitted' } : undefined)
  if (!scope.isCurrent()) return changed()
  const result = await request()
  if (scope.isCurrent()) return result
  if (!commandId || (!result.ok && 'outcome' in result && result.outcome === 'not-admitted')) return changed()
  return ipcFail(IpcErrorCode.Conflict, '页面或工程已变化，请回到原工程按原命令核对发送结果。', { commandId, outcome: 'unknown' })
}

export function registerConversationIpc(getMain: () => BrowserWindow | null): void {
  handle(ipcInvoke.conversation.workRoot, (event, ...args: unknown[]) => {
    const window = getMain()
    if (!window || !captureAppWindowDocument(window, event)) return ipcFail(IpcErrorCode.Denied, '请从应用主页面访问会话。')
    if (args.length) return ipcFail(IpcErrorCode.InvalidArg, '会话请求参数无效。')
    try {
      return { ok: true as const, root: rootSchema.parse(ownedDirectory(app.getPath('userData'), workDirectoryName)) }
    } catch {
      return ipcFail(IpcErrorCode.Io, '无法打开 Work 会话目录。')
    }
  })
  handle(ipcInvoke.conversation.taskScope, async (event, raw: unknown, ...extra: unknown[]) => {
    const window = getMain()
    const current = window && captureAppWindowDocument(window, event)
    if (!window || !current) return ipcFail(IpcErrorCode.Denied, '请从应用主页面访问任务会话。')
    const task = conversationTaskLocatorSchema.safeParse(raw)
    if (!task.success || extra.length) return ipcFail(IpcErrorCode.InvalidArg, '任务会话请求参数无效。')
    const userData = app.getPath('userData')
    const isCurrent = (): boolean => getMain() === window && current() && app.getPath('userData') === userData
    try {
      const captured = await captureDesktopConversationTask(userData, task.data, isCurrent)
      const result = await readConversationTaskScope(captured.task, isCurrent)
      captured.assertCurrent()
      if (result.ok) {
        const { scope } = result
        if (!sameConversationTaskLocator(task.data, scope.locator) || scope.locator.scopeKey !== scope.scopeKey) {
          return ipcFail(IpcErrorCode.Conflict, '原任务授权回执不匹配。')
        }
        const root = checkedDirectory(scope.cwd)
        rememberTaskGrant(window, {
          root, identity: directoryIdentity(root), task: { ...captured.task, locator: scope.locator },
          isCurrent: () => {
            try { captured.assertCurrent(); return true } catch { return false }
          },
        }, scope.scopeKey)
      }
      return result
    } catch (error) { return taskScopeFailure(error) }
  })
  const register = <T>(
    channel: string, action: (scope: ConversationScope, args: unknown[]) => T,
    rootIndex = 0, taskIndex = rootIndex, taskField = true,
  ): void => {
    handle(channel, (event, ...args: unknown[]) => {
      const argument = args[rootIndex]
      const taskArgument = args[taskIndex]
      const requestedRoot = argument && typeof argument === 'object' && 'cwd' in argument ? argument.cwd : argument
      const requestedTask = !taskField ? taskArgument
        : taskArgument && typeof taskArgument === 'object' && 'task' in taskArgument ? taskArgument.task : undefined
      const scope = captureScope(getMain(), event, getMain, requestedRoot, requestedTask)
      return 'ok' in scope ? scope : action(scope, args)
    })
  }
  const invalid = (): IpcFail => ipcFail(IpcErrorCode.InvalidArg, '会话请求参数无效。', { outcome: 'not-admitted' })
  const changed = (): IpcFail => ipcFail(IpcErrorCode.Conflict, '页面所属工程已变化，请重新打开会话。', { outcome: 'not-admitted' })

  register(ipcInvoke.conversation.models, (scope, [cwd, task, ...extra]) => {
    const parsed = conversationTaskLocatorSchema.optional().safeParse(task)
    if (!parsed.success || extra.length || !rootSchema.safeParse(cwd).success) return invalid()
    if (!scope.matchesRoot(cwd)) return changed()
    return inScope(scope, () => listConversationModels(scope.root, scope.isCurrent, scope.task))
  }, 0, 1, false)
  register(ipcInvoke.conversation.create, (scope, [input, ...extra]) => {
    if (extra.length) return invalid()
    const parsed = createSchema.safeParse(input)
    if (!parsed.success) return invalid()
    const { cwd, ...body } = parsed.data
    if (!scope.matchesRoot(cwd)) return changed()
    return inScope(scope, () => createConversationThread(scope.root, withTask(scope, body), scope.isCurrent), body.commandId)
  })
  register(ipcInvoke.conversation.list, (scope, [root, filter, ...extra]) => {
    const parsed = listSchema.safeParse(filter ?? {})
    if (extra.length || !parsed.success || !rootSchema.safeParse(root).success) return invalid()
    if (!scope.matchesRoot(root)) return changed()
    return inScope(scope, () => listConversationThreads(scope.root, scope.isCurrent, withTask(scope, parsed.data)))
  }, 0, 1)
  register(ipcInvoke.conversation.read, (scope, [threadId, root, task, ...extra]) => {
    const parsed = threadIdSchema.safeParse(threadId)
    const locator = conversationTaskLocatorSchema.optional().safeParse(task)
    if (!locator.success || extra.length || !parsed.success || !rootSchema.safeParse(root).success) return invalid()
    if (!scope.matchesRoot(root)) return changed()
    return inScope(scope, () => readConversationThread(scope.root, parsed.data, scope.isCurrent, scope.task))
  }, 1, 2, false)
  register(ipcInvoke.conversation.events, (scope, [input, ...extra]) => {
    const parsed = eventsSchema.safeParse(input)
    if (extra.length || !parsed.success) return invalid()
    const { cwd, ...body } = parsed.data
    if (!scope.matchesRoot(cwd)) return changed()
    return inScope(scope, () => readConversationEvents(scope.root, withTask(scope, body), scope.isCurrent))
  })
  register(ipcInvoke.conversation.command, (scope, [commandId, root, task, ...extra]) => {
    const parsed = commandIdSchema.safeParse(commandId)
    const locator = conversationTaskLocatorSchema.optional().safeParse(task)
    if (!locator.success || extra.length || !parsed.success || !rootSchema.safeParse(root).success) return invalid()
    if (!scope.matchesRoot(root)) return changed()
    return inScope(scope, () => readConversationCommand(scope.root, parsed.data, scope.isCurrent, scope.task))
  }, 1, 2, false)
  register(ipcInvoke.conversation.apply, (scope, [input, ...extra]) => {
    const parsed = applySchema.safeParse(input)
    if (extra.length || !parsed.success || !commandIdSchema.safeParse(parsed.data.command.commandId).success) return invalid()
    const { cwd, ...body } = parsed.data
    if (!scope.matchesRoot(cwd)) return changed()
    return inScope(scope, () => applyConversationCommand(scope.root, withTask(scope, body), scope.isCurrent), body.command.commandId)
  })
  register(ipcInvoke.conversation.threadCommand, (scope, [input, ...extra]) => {
    const parsed = threadCommandSchema.safeParse(input)
    if (extra.length || !parsed.success) return invalid()
    const { cwd, ...body } = parsed.data
    if (!scope.matchesRoot(cwd)) return changed()
    return inScope(scope, () => readConversationThreadCommand(scope.root, withTask(scope, body), scope.isCurrent))
  })
  register(ipcInvoke.conversation.eventDelta, (scope, [input, ...extra]) => {
    const parsed = deltaSchema.safeParse(input)
    if (extra.length || !parsed.success) return invalid()
    const { cwd, ...body } = parsed.data
    if (!scope.matchesRoot(cwd)) return changed()
    return inScope(scope, () => readConversationEventDelta(scope.root, withTask(scope, body), scope.isCurrent))
  })
  register(ipcInvoke.conversation.history, (scope, [input, ...extra]) => {
    const parsed = historySchema.safeParse(input)
    if (extra.length || !parsed.success) return invalid()
    const { cwd, ...body } = parsed.data
    if (!scope.matchesRoot(cwd)) return changed()
    return inScope(scope, () => readConversationHistory(scope.root, withTask(scope, body), scope.isCurrent))
  })
  register(ipcInvoke.conversation.drivers, (scope, [cwd, task, ...extra]) => {
    const parsed = conversationTaskLocatorSchema.optional().safeParse(task)
    if (!parsed.success || extra.length || !rootSchema.safeParse(cwd).success) return invalid()
    if (!scope.matchesRoot(cwd)) return changed()
    return inScope(scope, () => listConversationDrivers(scope.root, scope.isCurrent, scope.task))
  }, 0, 1, false)
  register(ipcInvoke.conversation.describeDriver, (scope, [input, ...extra]) => {
    const parsed = describeDriverSchema.safeParse(input)
    if (extra.length || !parsed.success) return invalid()
    const { cwd, ...body } = parsed.data
    if (!scope.matchesRoot(cwd)) return changed()
    return inScope(scope, () => describeConversationDriver(scope.root, withTask(scope, body), scope.isCurrent))
  })
  register(ipcInvoke.conversation.attachmentStage, (scope, [input, ...extra]) => {
    const parsed = attachmentStage.safeParse(input)
    if (extra.length || !parsed.success) return invalid()
    const { cwd, ...body } = parsed.data
    if (!scope.matchesRoot(cwd)) return changed()
    return inScope(scope, () => stageConversationAttachment(scope.root, withTask(scope, body), scope.isCurrent))
  })
  register(ipcInvoke.conversation.attachmentPick, async (scope, [input, ...extra]) => {
    const parsed = attachmentTarget.safeParse(input)
    if (extra.length || !parsed.success) return invalid()
    const { cwd, ...target } = parsed.data
    if (!scope.matchesRoot(cwd) || !scope.isCurrent()) return changed()
    const window = getMain()
    if (!window) return changed()
    try {
      const selection = await dialog.showOpenDialog(window, { title: '添加会话附件', defaultPath: scope.root, properties: ['openFile'] })
      if (!scope.isCurrent()) return changed()
      const [path] = selection.filePaths
      if (selection.canceled || !path) return { ok: true as const, attachments: [] }
      const file = await readHostConversationAttachmentFile(path)
      const result = await inScope(scope, () => stageConversationAttachment(scope.root, withTask(scope, { ...target, ...file }), scope.isCurrent))
      return result.ok ? { ok: true as const, attachments: [result.attachment] } : result
    } catch (error) {
      const code = error instanceof DaemonError && error.code === 'E_INVALID_ARG' ? IpcErrorCode.InvalidArg
        : error instanceof DaemonError && error.code === 'E_CONFLICT' ? IpcErrorCode.Conflict : IpcErrorCode.Io
      return ipcFail(code, error instanceof DaemonError ? error.message : '无法读取所选文件。')
    }
  })
  register(ipcInvoke.conversation.attachmentList, (scope, [input, ...extra]) => {
    const parsed = attachmentTarget.safeParse(input)
    if (extra.length || !parsed.success) return invalid()
    const { cwd, ...target } = parsed.data
    if (!scope.matchesRoot(cwd)) return changed()
    return inScope(scope, () => listConversationAttachments(scope.root, withTask(scope, target), scope.isCurrent))
  })
  register(ipcInvoke.conversation.attachmentRelease, (scope, [input, ...extra]) => {
    const parsed = attachmentRelease.safeParse(input)
    if (extra.length || !parsed.success) return invalid()
    const { cwd, ...body } = parsed.data
    if (!scope.matchesRoot(cwd)) return changed()
    return inScope(scope, () => releaseConversationAttachment(scope.root, withTask(scope, body), scope.isCurrent))
  })
  register(ipcInvoke.conversation.attachmentRead, (scope, [input, ...extra]) => {
    const parsed = attachmentRead.safeParse(input)
    if (extra.length || !parsed.success) return invalid()
    const { cwd, ...body } = parsed.data
    if (!scope.matchesRoot(cwd)) return changed()
    return inScope(scope, () => readConversationAttachment(scope.root, withTask(scope, body), scope.isCurrent))
  })
}

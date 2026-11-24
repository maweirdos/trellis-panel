import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { workspaceGrantSchema } from '../../shared/daemon'
import { runtimeBodies } from '../../shared/daemon-runtime'
import { ipcInvoke } from '../../shared/ipc-channels'
import { ipcFail, IpcErrorCode, noProject, type IpcFail } from '../../shared/ipc-errors'
import { modelSelectionIdSchema } from '../../shared/model-selection'
import { getProjectGeneration, getProjectRoot } from '../state'
import {
  applyConversationCommand, createConversationThread, describeConversationDriver, listConversationDrivers, listConversationModels,
  listConversationThreads, readConversationCommand, readConversationEventDelta, readConversationEvents, readConversationHistory,
  readConversationThread, readConversationThreadCommand,
} from '../services/daemon-client/conversation'
import { checkedDirectory, directoryIdentity, pathKey } from '../services/private-conversations/files'
import { captureAppWindowDocument } from '../services/window-navigation'
import { handle } from './registry'

const rootSchema = workspaceGrantSchema.shape.root.regex(/^[^\u0000-\u001f\u007f]+$/u)
const createBody = runtimeBodies['runtime.conversationCreate']
const createSchema = createBody.extend({
  cwd: rootSchema,
  model: modelSelectionIdSchema.refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value)),
  instanceId: createBody.shape.instanceId.regex(/^[\w.-]+$/)
})
const threadIdSchema = runtimeBodies['runtime.conversationRead'].shape.threadId.regex(/^[\w.-]+$/)
const commandIdSchema = runtimeBodies['runtime.conversationCommand'].shape.commandId
const eventsSchema = runtimeBodies['runtime.conversationEvents'].extend({ cwd: rootSchema, threadId: threadIdSchema })
const applySchema = runtimeBodies['runtime.conversationApply'].extend({ cwd: rootSchema })
const threadCommandSchema = runtimeBodies['runtime.conversationThreadCommand'].extend({ cwd: rootSchema })
const deltaSchema = runtimeBodies['runtime.conversationEventDelta'].extend({ cwd: rootSchema })
const historySchema = runtimeBodies['runtime.conversationHistory'].extend({ cwd: rootSchema })
const describeDriverSchema = runtimeBodies['runtime.conversationDescribeDriver'].extend({ cwd: rootSchema })

type ConversationScope = {
  root: string
  matchesRoot: (value: unknown) => boolean
  isCurrent: () => boolean
}

function captureScope(window: BrowserWindow | null, event: IpcMainInvokeEvent, getMain: () => BrowserWindow | null): ConversationScope | IpcFail {
  const isDocumentCurrent = window && captureAppWindowDocument(window, event)
  if (!isDocumentCurrent) return ipcFail(IpcErrorCode.Denied, '请从应用主页面访问会话。')
  const selected = getProjectRoot()
  const generation = getProjectGeneration()
  if (!selected) return noProject()
  try {
    const root = rootSchema.parse(checkedDirectory(rootSchema.parse(selected)))
    const identity = directoryIdentity(selected)
    return {
      root,
      matchesRoot: value => {
        const parsed = rootSchema.safeParse(value)
        return parsed.success && [selected, root].some(candidate => pathKey(candidate) === pathKey(parsed.data))
      },
      isCurrent: () => {
        if (getMain() !== window || !isDocumentCurrent() || getProjectRoot() !== selected || getProjectGeneration() !== generation) return false
        try { return directoryIdentity(selected) === identity } catch { return false }
      }
    }
  } catch {
    return ipcFail(IpcErrorCode.Conflict, '原工程目录无法核实，请重新选择工程。')
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
  const register = <T>(channel: string, action: (scope: ConversationScope, args: unknown[]) => T): void => {
    handle(channel, (event, ...args: unknown[]) => {
      const scope = captureScope(getMain(), event, getMain)
      return 'ok' in scope ? scope : action(scope, args)
    })
  }
  const invalid = (): IpcFail => ipcFail(IpcErrorCode.InvalidArg, '会话请求参数无效。')
  const changed = (): IpcFail => ipcFail(IpcErrorCode.Conflict, '页面所属工程已变化，请重新打开会话。', { outcome: 'not-admitted' })

  register(ipcInvoke.conversation.models, (scope, [cwd, ...extra]) => {
    if (extra.length || !rootSchema.safeParse(cwd).success) return invalid()
    if (!scope.matchesRoot(cwd)) return changed()
    return inScope(scope, () => listConversationModels(scope.root, scope.isCurrent))
  })
  register(ipcInvoke.conversation.create, (scope, [input, ...extra]) => {
    if (extra.length) return invalid()
    const parsed = createSchema.safeParse(input)
    if (!parsed.success) return invalid()
    const { cwd, ...body } = parsed.data
    if (!scope.matchesRoot(cwd)) return changed()
    return inScope(scope, () => createConversationThread(scope.root, body, scope.isCurrent), body.commandId)
  })
  register(ipcInvoke.conversation.list, (scope, [root, ...extra]) => {
    if (extra.length || !rootSchema.safeParse(root).success) return invalid()
    if (!scope.matchesRoot(root)) return changed()
    return inScope(scope, () => listConversationThreads(scope.root, scope.isCurrent))
  })
  register(ipcInvoke.conversation.read, (scope, [threadId, root, ...extra]) => {
    const parsed = threadIdSchema.safeParse(threadId)
    if (extra.length || !parsed.success || !rootSchema.safeParse(root).success) return invalid()
    if (!scope.matchesRoot(root)) return changed()
    return inScope(scope, () => readConversationThread(scope.root, parsed.data, scope.isCurrent))
  })
  register(ipcInvoke.conversation.events, (scope, [input, ...extra]) => {
    const parsed = eventsSchema.safeParse(input)
    if (extra.length || !parsed.success) return invalid()
    const { cwd, ...body } = parsed.data
    if (!scope.matchesRoot(cwd)) return changed()
    return inScope(scope, () => readConversationEvents(scope.root, body, scope.isCurrent))
  })
  register(ipcInvoke.conversation.command, (scope, [commandId, root, ...extra]) => {
    const parsed = commandIdSchema.safeParse(commandId)
    if (extra.length || !parsed.success || !rootSchema.safeParse(root).success) return invalid()
    if (!scope.matchesRoot(root)) return changed()
    return inScope(scope, () => readConversationCommand(scope.root, parsed.data, scope.isCurrent))
  })
  register(ipcInvoke.conversation.apply, (scope, [input, ...extra]) => {
    const parsed = applySchema.safeParse(input)
    if (extra.length || !parsed.success || !commandIdSchema.safeParse(parsed.data.command.commandId).success) return invalid()
    const { cwd, ...body } = parsed.data
    if (!scope.matchesRoot(cwd)) return changed()
    return inScope(scope, () => applyConversationCommand(scope.root, body, scope.isCurrent), body.command.commandId)
  })
  register(ipcInvoke.conversation.threadCommand, (scope, [input, ...extra]) => {
    const parsed = threadCommandSchema.safeParse(input)
    if (extra.length || !parsed.success) return invalid()
    const { cwd, ...body } = parsed.data
    if (!scope.matchesRoot(cwd)) return changed()
    return inScope(scope, () => readConversationThreadCommand(scope.root, body, scope.isCurrent))
  })
  register(ipcInvoke.conversation.eventDelta, (scope, [input, ...extra]) => {
    const parsed = deltaSchema.safeParse(input)
    if (extra.length || !parsed.success) return invalid()
    const { cwd, ...body } = parsed.data
    if (!scope.matchesRoot(cwd)) return changed()
    return inScope(scope, () => readConversationEventDelta(scope.root, body, scope.isCurrent))
  })
  register(ipcInvoke.conversation.history, (scope, [input, ...extra]) => {
    const parsed = historySchema.safeParse(input)
    if (extra.length || !parsed.success) return invalid()
    const { cwd, ...body } = parsed.data
    if (!scope.matchesRoot(cwd)) return changed()
    return inScope(scope, () => readConversationHistory(scope.root, body, scope.isCurrent))
  })
  register(ipcInvoke.conversation.drivers, (scope, [cwd, ...extra]) => {
    if (extra.length || !rootSchema.safeParse(cwd).success) return invalid()
    if (!scope.matchesRoot(cwd)) return changed()
    return inScope(scope, () => listConversationDrivers(scope.root, scope.isCurrent))
  })
  register(ipcInvoke.conversation.describeDriver, (scope, [input, ...extra]) => {
    const parsed = describeDriverSchema.safeParse(input)
    if (extra.length || !parsed.success) return invalid()
    const { cwd, ...body } = parsed.data
    if (!scope.matchesRoot(cwd)) return changed()
    return inScope(scope, () => describeConversationDriver(scope.root, body, scope.isCurrent))
  })
}

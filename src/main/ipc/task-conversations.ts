/** Main-window-owned native session discovery, durable association and navigation. */
import { resolve } from 'node:path'
import { z } from 'zod'
import { ipcInvoke } from '../../shared/ipc-channels'
import { IpcErrorCode, ipcFail, type IpcFail } from '../../shared/ipc-errors'
import {
  taskConversationProjectInputSchema,
  taskConversationBindInputSchema,
  taskConversationBindingInputSchema
} from '../../shared/task-conversations'
import { TaskConversationsService } from '../services/task-conversations'
import { getProjectRoot, getProjectGeneration } from '../state'
import { handle } from './registry'
import type { WindowDeps } from './deps'

export type TaskConversationsPort = Pick<TaskConversationsService, 'list' | 'discover' | 'bind' | 'setPrimary' | 'unbind' | 'open'>
type Owner = { root: string; generation: number; sender: Electron.WebContents; frame: Electron.WebFrameMain }
let service: TaskConversationsService | null = null
let admissionClosed = false

export function closeTaskConversations(): void {
  admissionClosed = true
  service?.close()
  service = null
}

function getService(): TaskConversationsService {
  if (!service) service = new TaskConversationsService()
  return service
}

function failure(error: unknown): IpcFail {
  if (error instanceof z.ZodError) return ipcFail(IpcErrorCode.InvalidArg, '会话入口参数无效，请重新选择任务')
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  const known = Object.values(IpcErrorCode).find((value) => value === code)
  const mapped = known ?? (code === 'NOT_FOUND' ? IpcErrorCode.NotFound
    : code === 'INVALID_INPUT' ? IpcErrorCode.InvalidArg
      : ['SCOPE_CHANGED', 'AMBIGUOUS_TASK'].includes(code) ? IpcErrorCode.Conflict
        : ['CAPABILITY_UNAVAILABLE', 'E_UNAVAILABLE'].includes(code) ? IpcErrorCode.Denied : IpcErrorCode.Io)
  return ipcFail(mapped, error instanceof Error ? error.message : '会话操作失败，请重试')
}

export function registerTaskConversationsIpc(deps: WindowDeps, injectedService?: TaskConversationsPort): void {
  const capture = (event: Electron.IpcMainInvokeEvent, expectedRoot: string): Owner => {
    if (admissionClosed) throw Object.assign(new Error('应用正在退出，暂不接纳会话操作'), { code: IpcErrorCode.Conflict })
    const sender = deps.getMain()?.webContents
    if (!sender || sender.isDestroyed() || event.sender.id !== sender.id || event.senderFrame !== sender.mainFrame) {
      throw Object.assign(new Error('请从主窗口的任务列表操作会话'), { code: IpcErrorCode.Denied })
    }
    const root = getProjectRoot()
    if (!root) throw Object.assign(new Error('未打开项目'), { code: IpcErrorCode.NoProject })
    const actual = resolve(root), expected = resolve(expectedRoot)
    if (process.platform === 'win32' ? actual.toLowerCase() !== expected.toLowerCase() : actual !== expected) {
      throw Object.assign(new Error('项目已切换，请回到来源项目重试'), { code: IpcErrorCode.Conflict })
    }
    return { root, generation: getProjectGeneration(), sender, frame: sender.mainFrame }
  }
  const current = (owner: Owner): boolean => !admissionClosed && !owner.sender.isDestroyed()
    && deps.getMain()?.webContents.id === owner.sender.id && owner.sender.mainFrame === owner.frame
    && getProjectRoot() === owner.root && getProjectGeneration() === owner.generation
  const scoped = <T extends { expectedRoot: string }, R>(
    channel: string,
    schema: z.ZodType<T>,
    action: (port: TaskConversationsPort, owner: Owner, input: T) => Promise<R>
  ): void => {
    handle(channel, async (event, raw: unknown) => {
      let owner: Owner | undefined
      try {
        const input = schema.parse(raw)
        owner = capture(event, input.expectedRoot)
        const value = await action(injectedService ?? getService(), owner, input)
        // Accepted writes remain in their source project; never project their result into a new one.
        if (!current(owner)) return ipcFail(IpcErrorCode.Conflict, '项目或窗口在操作期间已变化，请回到来源项目核对')
        return { ok: true as const, value }
      } catch (error) {
        if (owner && !current(owner)) return ipcFail(IpcErrorCode.Conflict, '项目或窗口在操作期间已变化，请回到来源项目核对')
        return failure(error)
      }
    })
  }
  const channels = ipcInvoke.taskConversations
  scoped(channels.list, taskConversationProjectInputSchema, (port, owner) => port.list(owner.root))
  scoped(channels.discover, taskConversationProjectInputSchema, (port, owner) => port.discover(owner.root))
  scoped(channels.bind, taskConversationBindInputSchema, (port, owner, input) => port.bind(owner.root, input.taskDir, input.conversationId))
  scoped(channels.setPrimary, taskConversationBindingInputSchema, (port, owner, input) => port.setPrimary(owner.root, input.taskDir, input.bindingId))
  scoped(channels.unbind, taskConversationBindingInputSchema, (port, owner, input) => port.unbind(owner.root, input.taskDir, input.bindingId))
  scoped(channels.open, taskConversationBindingInputSchema, (port, owner, input) => port.open(owner.root, input.taskDir, input.bindingId, () => current(owner)))
}

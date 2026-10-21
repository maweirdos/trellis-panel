import { externalConversationSchema, type ExternalConversation, type TaskConversationsSnapshot, type TaskConversationCandidates, type TaskConversationOpenResult } from '../../../shared/task-conversations'
import { TaskConversationError, type NativeReadResult, type NativeReader, type TaskConversationsOptions, type LaunchPorts } from './types'
import { canonicalRoot, pathKey, projectCwd } from './lib/paths'
import { defaultLaunchPorts, applyCapability, launchTarget } from './lib/launch'
import { nativeReader } from './lib/native'
import { ConversationStore, type StoredBinding } from './lib/store'
import { knownTasks, resolveTask, sameTask, displayTaskDir, type TaskOwner } from './lib/identity'
import { importRuntime } from './lib/runtime'
import { isCodexSubagent } from './lib/codex'

export { TaskConversationError } from './types'
export type { TaskConversationsOptions, NativeReadResult, NativeReader, NativeIdentity, LaunchPorts, LaunchTarget, LaunchCapability } from './types'

type Context = { root: string; store: ConversationStore; known: ReturnType<typeof knownTasks> }
export class TaskConversationsService {
  private readonly stores = new Map<string, ConversationStore>()
  private readonly read: NativeReader
  private readonly launch: LaunchPorts
  private readonly now: () => number
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false
  constructor(options: TaskConversationsOptions = {}) {
    this.launch = options.launch ?? defaultLaunchPorts()
    this.read = options.readNative ?? nativeReader(options, this.launch)
    this.now = options.now ?? Date.now
  }
  private run<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => {
      if (this.closed) throw new TaskConversationError('E_UNAVAILABLE', '会话服务已关闭')
      return action()
    }).catch((error: unknown) => {
      if (error instanceof Error && /database (?:is )?(?:locked|busy)/i.test(error.message)) throw new TaskConversationError('E_UNAVAILABLE', '控制库暂时被占用，请重试')
      throw error
    })
    this.queue = next.catch(() => undefined)
    return next
  }
  private context(root: string): Context {
    const canonical = canonicalRoot(root)
    const key = pathKey(canonical)
    let store = this.stores.get(key)
    if (!store) { store = new ConversationStore(canonical); this.stores.set(key, store) }
    const known = knownTasks(canonical)
    store.reconcile(known)
    return { root: canonical, store, known }
  }
  private async native(root: string, stored: StoredBinding[] = []): Promise<NativeReadResult> {
    const result = await this.read(root, stored.map(item => item.binding.conversation))
    const items = result.items.flatMap(raw => {
      const item = externalConversationSchema.parse(raw)
      const cwd = projectCwd(root, item.cwd)
      return cwd && pathKey(cwd) === pathKey(item.cwd) ? [{ ...item, cwd }] : []
    })
    return { ...result, items }
  }
  private async snapshot(context: Context): Promise<TaskConversationsSnapshot> {
    const { root, store } = context
    const native = await this.native(root, store.bindings())
    if (this.closed) throw new TaskConversationError('E_UNAVAILABLE', '会话服务已关闭')
    const known = knownTasks(root)
    store.reconcile(known)
    importRuntime(root, known, native.items, store, this.now())
    const updates: { id: string; conversation: ExternalConversation }[] = []
    const bindings = store.bindings().map(({ owner, binding }) => {
      const fresh = native.items.find(item => item.id === binding.conversation.id && item.sessionId === binding.conversation.sessionId && item.source === binding.conversation.source)
      let conversation: ExternalConversation
      if (fresh) {
        conversation = fresh
        if (JSON.stringify(fresh) !== JSON.stringify(binding.conversation)) updates.push({ id: binding.id, conversation: fresh })
      }
      else {
        const status = native.sources.find(item => item.source === binding.conversation.source)
        conversation = { ...binding.conversation, capability: 'unavailable', unavailableReason: status?.available ? (native.truncated ? '扫描达到上限，暂未核验该会话' : '原生会话已删除或项目归属已改变') : status?.detail || '原生来源不可用' }
      }
      const taskExists = known.some(task => sameTask(owner, task))
      if (!taskExists) conversation = { ...conversation, capability: 'unavailable', unavailableReason: '任务目录缺失或任务身份有歧义，请重新关联' }
      return { ...binding, taskDir: displayTaskDir(owner.currentDir), taskRef: owner.taskRef, currentTaskRef: taskExists ? owner.taskRef : null, conversation }
    })
    store.refresh(updates)
    return { projectRoot: root, bindings, sources: native.sources, refreshedAt: this.now() }
  }
  list(root: string): Promise<TaskConversationsSnapshot> { return this.run(() => this.snapshot(this.context(root))) }
  discover(root: string): Promise<TaskConversationCandidates> {
    return this.run(async () => {
      const canonical = canonicalRoot(root)
      const result = await this.native(canonical)
      return { projectRoot: canonical, ...result, items: result.items.filter(item => !isCodexSubagent(item)) }
    })
  }
  bind(root: string, taskDir: string, conversationId: string): Promise<TaskConversationsSnapshot> {
    return this.run(async () => {
      const context = this.context(root)
      const task = resolveTask(context.root, taskDir, context.known)
      const native = await this.native(context.root)
      const conversation = native.items.find(item => item.id === conversationId && !isCodexSubagent(item))
      if (!conversation) throw new TaskConversationError('E_NOT_FOUND', '候选会话已不存在，请刷新后重新选择')
      if (this.closed) throw new TaskConversationError('E_UNAVAILABLE', '会话服务已关闭')
      const currentKnown = knownTasks(context.root)
      const currentTask = resolveTask(context.root, taskDir, currentKnown)
      if (currentTask.trellisTaskId !== task.trellisTaskId) throw new TaskConversationError('E_CONFLICT', '任务身份已改变')
      context.store.bind(context.store.owner(task), conversation, 'manual', this.now())
      return this.snapshot({ ...context, known: currentKnown })
    })
  }
  setPrimary(root: string, taskDir: string, bindingId: string): Promise<TaskConversationsSnapshot> {
    return this.run(async () => {
      const context = this.context(root)
      const { owner } = this.binding(context, taskDir, bindingId)
      context.store.setPrimary(owner, bindingId)
      return this.snapshot(context)
    })
  }
  unbind(root: string, taskDir: string, bindingId: string): Promise<TaskConversationsSnapshot> {
    return this.run(async () => {
      const context = this.context(root)
      const { owner } = this.binding(context, taskDir, bindingId)
      context.store.unbind(owner, bindingId)
      return this.snapshot(context)
    })
  }
  private binding(context: Context, taskDir: string, id: string): StoredBinding & { owner: TaskOwner } {
    const task = resolveTask(context.root, taskDir, context.known)
    const stored = context.store.bindings().find(item => item.binding.id === id && sameTask(item.owner, task))
    if (!stored) throw new TaskConversationError('E_NOT_FOUND', '关联不存在或不属于当前任务')
    return stored
  }
  open(root: string, taskDir: string, bindingId: string, isCurrent: () => boolean = () => true): Promise<TaskConversationOpenResult> {
    return this.run(async () => {
      const context = this.context(root)
      const stored = this.binding(context, taskDir, bindingId)
      const capability = await this.launch.capability(stored.binding.conversation.source)
      const native = await this.native(context.root, [stored])
      const cached = stored.binding.conversation
      const fresh = native.items.find(item => item.id === cached.id && item.source === cached.source && item.sessionId === cached.sessionId && pathKey(item.cwd) === pathKey(cached.cwd))
      if (!fresh) throw new TaskConversationError('E_NOT_FOUND', '原生会话已不存在或不属于当前项目')
      if (fresh.capability === 'unavailable') throw new TaskConversationError('E_UNAVAILABLE', fresh.unavailableReason || '原生打开入口不可用')
      const verified = applyCapability(fresh, capability)
      const target = launchTarget(verified, capability)
      // Async metadata/capability work may outlive an IPC sender or project generation.
      if (this.closed || !isCurrent()) throw new TaskConversationError('E_CONFLICT', '当前项目或窗口已改变，已取消打开')
      const current = this.context(root)
      this.binding(current, taskDir, bindingId)
      const currentCwd = projectCwd(current.root, verified.cwd)
      if (!currentCwd || pathKey(currentCwd) !== pathKey(verified.cwd)) throw new TaskConversationError('E_NOT_FOUND', '会话工作目录已不存在或已改变')
      if (!isCurrent()) throw new TaskConversationError('E_CONFLICT', '当前项目或窗口已改变，已取消打开')
      await this.launch.launch(target)
      return { source: fresh.source, sessionId: fresh.sessionId, capability: fresh.source === 'zcode' ? 'workspace' : 'session', destinationLabel: verified.destinationLabel,
        detail: fresh.source === 'claude-code' ? '已请求终端续接已有历史；未确认原有窗口聚焦' : fresh.source === 'zcode' ? '已请求打开工作区；该客户端尚不支持精确会话导航' : '已请求打开原生会话' }
    })
  }
  close(): void {
    this.closed = true
    for (const store of this.stores.values()) store.close()
    this.stores.clear()
  }
}

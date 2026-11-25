import { opendirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { codeTaskDirectory, type CodeTaskAction, type CodeTaskActionValue, type CodeTaskSummary } from '../../../shared/conversation/code-task-action'
import { readConversationThread } from '../daemon-client/conversation'
import { checkedDirectory, directoryIdentity, hash, pathKey, readRegular } from '../private-conversations/files'
import { readOptional, writeRevision } from '../private-conversations/requirement-files'
import { taskRefFor } from '../task-identity'

const recordDirectory = 'conversation-v2-code-task-actions'
const taskDirectory = '.trellis/tasks'
const recordLimit = 32 * 1024
const maxTasks = 200
const taskRecord = z.object({
  id: z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/u).nullish(),
  title: z.string().trim().min(1).max(500),
  status: z.string().trim().min(1).max(100).optional(),
})
const bindingRecord = z.strictObject({
  version: z.literal(1),
  root: z.string(),
  rootIdentity: z.string(),
  threadId: z.string(),
  commandId: z.string().uuid(),
  taskDir: codeTaskDirectory,
  taskRef: z.string(),
  taskIdentity: z.string(),
})

function readTask(root: string, taskDir: string): CodeTaskSummary | null {
  const relative = `${taskDirectory}/${taskDir}`
  try {
    const taskIdentity = directoryIdentity(join(root, relative))
    const source = readRegular(root, `${relative}/task.json`, 256 * 1024)
    const data = taskRecord.parse(JSON.parse(source.bytes.toString('utf8')))
    if (directoryIdentity(join(root, relative)) !== taskIdentity) return null
    return {
      taskDir, taskIdentity, title: data.title, status: data.status,
      taskRef: taskRefFor(data.id ?? null, relative), updatedAt: source.modifiedAt,
    }
  } catch { return null }
}

function listTasks(root: string): CodeTaskActionValue {
  const tasks: CodeTaskSummary[] = []
  let directory
  try { directory = opendirSync(checkedDirectory(join(root, taskDirectory))) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'tasks', root, tasks, truncated: false }
    throw error
  }
  let truncated = false
  try {
    for (let inspected = 0; ; inspected++) {
      const entry = directory.readSync()
      if (!entry) break
      if (inspected === 4096 || tasks.length === maxTasks) { truncated = true; break }
      if (!entry.isDirectory() || !codeTaskDirectory.safeParse(entry.name).success) continue
      const task = readTask(root, entry.name)
      if (task) tasks.push(task)
    }
  } finally { directory.closeSync() }
  tasks.sort((left, right) => right.updatedAt - left.updatedAt || left.title.localeCompare(right.title, 'zh-CN'))
  return { state: 'tasks', root, tasks, truncated }
}

export class CodeConversationTaskActions {
  constructor(private readonly profile: string) {}

  async execute(input: CodeTaskAction, root: string, rootIdentity: string, current: () => void): Promise<CodeTaskActionValue> {
    current()
    if (input.action === 'list') return listTasks(root)
    const thread = await readConversationThread(root, input.threadId, () => {
      try { current(); return true } catch { return false }
    })
    current()
    if (!thread.ok) throw Error(thread.error)
    if (thread.thread.id !== input.threadId || thread.thread.deletedAt || thread.relations?.parent ||
      (input.action === 'bind' && thread.thread.archivedAt)) {
      return { state: 'failed', detail: '原 Code 会话不可关联本地任务。' }
    }
    const owner = pathKey(root)
    const file = `${recordDirectory}/${hash(JSON.stringify([owner, input.threadId]))}.json`
    const existing = readOptional(this.profile, file, recordLimit)
    if (existing) {
      const binding = bindingRecord.parse(JSON.parse(existing.bytes.toString('utf8')))
      if (binding.root !== owner || binding.rootIdentity !== rootIdentity || binding.threadId !== input.threadId) {
        return { state: 'conflict', detail: '原工程或会话身份已变化。' }
      }
      const differentTarget = input.action === 'bind' && (input.taskRef !== binding.taskRef ||
        input.taskDir !== binding.taskDir || input.taskIdentity !== binding.taskIdentity)
      const differentReceipt = input.action === 'status' && input.commandId !== undefined && input.commandId !== binding.commandId
      if (differentTarget || differentReceipt) return { state: 'conflict', detail: '原会话已有另一条本地任务关联。' }
      const task = readTask(root, binding.taskDir)
      return task?.taskRef === binding.taskRef && task.taskIdentity === binding.taskIdentity
        ? { state: 'bound', taskDir: binding.taskDir, taskRef: binding.taskRef, title: task.title }
        : { state: 'conflict', detail: '原本地任务已移动或身份已变化。' }
    }
    if (input.action === 'status') return { state: 'idle', detail: '当前 Code 会话还没有关联本地任务。' }
    const task = readTask(root, input.taskDir)
    if (task?.taskRef !== input.taskRef || task.taskIdentity !== input.taskIdentity) {
      return { state: 'failed', detail: '本地任务已移动或身份已变化，请重新选择。' }
    }
    const binding = bindingRecord.parse({
      version: 1, root: owner, rootIdentity, threadId: input.threadId, commandId: input.commandId,
      taskDir: task.taskDir, taskRef: task.taskRef, taskIdentity: task.taskIdentity,
    })
    writeRevision(this.profile, file, Buffer.from(JSON.stringify(binding)), null, () => {
      current()
      const latest = readTask(root, task.taskDir)
      if (latest?.taskIdentity !== task.taskIdentity || latest.taskRef !== task.taskRef) throw Error('原任务身份已变化。')
    })
    return { state: 'bound', taskDir: task.taskDir, taskRef: task.taskRef, title: task.title }
  }
}

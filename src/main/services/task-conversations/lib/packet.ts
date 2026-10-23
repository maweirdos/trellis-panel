import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { statSync } from 'node:fs'
import { z } from 'zod'
import type { TaskInfo, TaskRecord } from '../../../../shared/types'
import { taskConversationContinuationSchema, type TaskConversationContinuation } from '../../../../shared/task-conversations'
import { buildHandoffPackage } from '../../handoff'
import { TaskConversationError } from '../types'
import { knownTasks, resolveTask, displayTaskDir } from './identity'
import { ownedPath, readBounded } from './paths'

const recordSchema = z.object({
  id: z.string().min(1).max(256).optional(), title: z.string().max(1024).optional(), status: z.string().max(128).optional(),
  subtasks: z.array(z.string().max(2048)).max(256).optional(), branch: z.string().max(256).nullable().optional(),
  base_branch: z.string().max(256).nullable().optional()
})
export type ContinuationTask = { root: string; dir: string; id: string | null; fingerprint: string; info: TaskInfo; status: string; history: boolean }
export function readContinuationTask(root: string, taskDir: string): ContinuationTask {
  const known = knownTasks(root), task = resolveTask(root, taskDir, known)
  if (task.trellisTaskId && known.filter(item => item.trellisTaskId === task.trellisTaskId).length !== 1) throw new TaskConversationError('E_CONFLICT', '任务身份有重复，暂不能生成接续说明')
  const path = ownedPath(root, join(root, task.dir)), file = ownedPath(path, join(path, 'task.json'))
  if (!statSync(file).isFile()) throw new TaskConversationError('E_NOT_FOUND', '任务记录不存在')
  let text: string, raw: z.infer<typeof recordSchema>
  try { text = readBounded(file, 256 * 1024); raw = recordSchema.parse(JSON.parse(text)) }
  catch { throw new TaskConversationError('E_UNAVAILABLE', '任务记录不可读取、格式不支持或超过读取上限') }
  if ((raw.id ?? null) !== task.trellisTaskId) throw new TaskConversationError('E_CONFLICT', '任务身份在读取期间已变化')
  const status = raw.status || '未知', history = task.dir.startsWith('.trellis/tasks/archive/') || /^(?:completed|done|archived)$/i.test(status)
  // The handoff builder consumes only these known fields; no untrusted record is spread into it.
  const record: TaskRecord = { id: raw.id || '', name: basename(path), title: raw.title || basename(path), status,
    description: '', dev_type: null, scope: null, package: null, priority: '', creator: '', assignee: '', createdAt: '',
    completedAt: null, branch: raw.branch || null, base_branch: raw.base_branch || null, worktree_path: null, commit: null,
    pr_url: null, subtasks: raw.subtasks || [], children: [], parent: null, relatedFiles: [], notes: '', meta: {} }
  return { root, dir: task.dir, id: task.trellisTaskId, status, history, fingerprint: createHash('sha256').update(text).digest('hex'),
    info: { dirName: basename(path), path, date: null, record, phase: history ? 'completed' : 'unknown', artifacts: [], updatedAt: 0, taskJsonMtime: statSync(file).mtimeMs, archived: task.dir.startsWith('.trellis/tasks/archive/') } }
}
export function verifyContinuationTask(task: ContinuationTask): void {
  const current = readContinuationTask(task.root, task.dir)
  if (current.id !== task.id || current.fingerprint !== task.fingerprint || current.info.path !== task.info.path) throw new TaskConversationError('E_CONFLICT', '任务记录已改变，请重新生成接续说明')
}
export async function continuationPacket(task: ContinuationTask): Promise<TaskConversationContinuation> {
  const extraIssues: string[] = []
  const intent = task.history
    ? '仅查看此任务历史并核对资料；任务已完成或归档，不重新执行，不改任务状态或当前任务指针。'
    : '接续本次明确选中的任务。先读取本任务的 PRD、设计、实施计划与项目工作流，核对当前真实进度和下一合法步骤；保留规划、确认与审核门槛。记录阶段不是实施批准。面板未修改原生任务指针；若当前会话指向其他任务，先核对现有运行，再按项目工作流安全绑定本次任务，不干扰其他任务，不绕过冲突或批准门槛。未发现未完成项不代表工作已完成。不得自动创建重复任务、归档或修改生命周期。'
  const built = await buildHandoffPackage(task.root, task.info, intent, { omitGit: true, readText: file => {
    try { return readBounded(ownedPath(task.info.path, file), 64 * 1024) }
    catch { extraIssues.push('PRD 待确认问题未读取：文件不可读或超过 64 KiB 上限；请按资料索引核对'); return null }
  } })
  const issues = [...built.issues, ...extraIssues]
  let text = `本次选中任务：${task.info.record?.title}\n选中任务目录：${task.dir}\n用户粘贴并发送本说明后才构成一次明确请求；面板没有发送消息或切换原生任务。\n\n${built.text}`
  if (task.history) text = text.replace('请通过当前平台的 Trellis 流程确认并绑定任务。', '本次只读核对历史；不绑定任务或重新开始实施。')
  if (text.length > 32768) { text = text.slice(0, 32720) + '\n（说明达到长度上限，请按任务资料索引核对。）'; issues.push('接续说明达到长度上限') }
  verifyContinuationTask(task)
  return taskConversationContinuationSchema.parse({ projectRoot: task.root, taskDir: displayTaskDir(task.dir), taskTitle: task.info.record?.title || task.info.dirName,
    status: task.status, mode: task.history ? 'history' : 'continue', text, issues, files: built.files })
}

import { createHash } from 'node:crypto'
import { join, relative, isAbsolute, sep, basename } from 'node:path'
import { realpathSync, lstatSync } from 'node:fs'
import { z } from 'zod'
import type { WorkspaceGrant } from '../../../../shared/daemon'
import { createOrOpenTaskFromExternal } from '../../local-task'
import { taskRefFor, scanKnownTaskDirs } from '../../task-identity'
import { updateTaskRecordAt } from '../../scan'
import { readBounded } from '../../../daemon/files'
import { IntegrationError } from '../types'
import type { DingMessage } from './repository'

/** Only saved task references enter this adapter. No chat-supplied path is used. */
export function createDingTalkTasks(assertWorkspace: (workspace: WorkspaceGrant) => void) {
  function locate(workspace: WorkspaceGrant, taskRef: string) {
    assertWorkspace(workspace)
    const found = scanKnownTaskDirs(workspace.root).filter(task => taskRefFor(task.trellisTaskId, task.dir) === taskRef)
    if (found.length !== 1 || !found[0]) throw new IntegrationError('任务身份缺失或存在多个候选，需在本机核实', 'conflict')
    const root = realpathSync(workspace.root), tasks = join(root, '.trellis', 'tasks'), dir = realpathSync(join(root, found[0].dir))
    const rel = relative(tasks, dir)
    if (realpathSync(tasks) !== tasks || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new IntegrationError('任务目录超出授权工作区', 'denied')
    const file = join(dir, 'task.json')
    if (lstatSync(file).isSymbolicLink() || realpathSync(file) !== file) throw new IntegrationError('任务元数据不能重定向', 'denied')
    const bytes = readBounded(file, 256 * 1024)
    const data = z.object({ title: z.string().max(500), priority: z.string().max(50).optional(), status: z.string().max(100).optional() }).passthrough().parse(JSON.parse(bytes))
    return { taskRef, taskDir: basename(dir), directory: dir, title: data.title, priority: data.priority ?? '', status: data.status ?? '', archived: found[0].dir.startsWith('.trellis/tasks/archive/'), revision: createHash('sha256').update(bytes).digest('hex') }
  }
  return {
    read: locate,
    async create(workspace: WorkspaceGrant, appId: string, message: DingMessage, text: string) {
      assertWorkspace(workspace)
      const title = text.split('\n')[0]?.trim().slice(0, 500) || '钉钉任务'
      const instanceId = `dingtalk:${createHash('sha256').update(JSON.stringify([message.chatbotCorpId, appId])).digest('hex')}`
      const result = await createOrOpenTaskFromExternal({ root: workspace.root, instanceId, issueKey: `DT-${createHash('sha256').update(message.msgId).digest('hex').slice(0, 24)}`, externalSource: { provider: 'dingtalk', id: message.msgId }, title, summaryDescription: text.slice(0, 4000), description: text, url: '', updatedAtMs: message.createAt || null, priority: 'P2', assignee: '', allowAdditional: false })
      assertWorkspace(workspace)
      if (!result.ok) throw new IntegrationError(`原任务创建操作未完成（${result.code}），请在本机核实原操作`, 'conflict')
      const found = scanKnownTaskDirs(workspace.root).filter(task => task.dir === `.trellis/tasks/${result.dirName}`)
      if (found.length !== 1 || !found[0]) throw new IntegrationError('创建后的任务身份需要核实', 'conflict')
      const task = locate(workspace, taskRefFor(found[0].trellisTaskId, found[0].dir))
      return { ...task, operationId: result.operationId }
    },
    update(workspace: WorkspaceGrant, taskRef: string, expectedRevision: string, title: string, priority: 'P0' | 'P1' | 'P2' | 'P3') {
      const task = locate(workspace, taskRef)
      if (task.archived || task.revision !== expectedRevision) throw new IntegrationError('任务已归档或被修改，请重新查询', 'conflict')
      assertWorkspace(workspace)
      const result = updateTaskRecordAt(workspace.root, task.directory, { title, priority })
      if (result.conflict || result.ignored.length) throw new IntegrationError('任务更新存在冲突，请在本机核实', 'conflict')
      return locate(workspace, taskRef)
    }
  }
}

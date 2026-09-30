import { join } from 'path'
import { writeFileSync } from 'fs'
import { ipcInvoke } from '../../shared/ipc-channels'
import { errorText, errorMessage } from '../../shared/errors'
import { IpcErrorCode, ipcFail, noProject } from '../../shared/ipc-errors'
import { updateTaskRecordAt } from '../services/scan'
import {
  getProjectRoot,
  getSnapshot,
  findTask,
  sendSnapshot,
  createTaskRecord,
  deleteTaskRecord,
  slugifyTitle
} from '../state'
import { handle } from './registry'

/* R0（09-30-r0-trusted-boundary）：task:archive 直写归档（renameSync + 补写 completedAt）
 * 已停用。归档收归外部 Trellis 工作流（task.py archive，含记账提交与 after_archive hook）；
 * 面板侧的归档能力将随 T4 派单扩展另行设计。WeKnora 归档沉淀一并停用，待归档能力
 * 重设计时接在官方归档路径之后。 */

const isConflict = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && 'conflict' in e && Boolean((e as { conflict?: unknown }).conflict)

export function registerTasksIpc(): void {
  handle(ipcInvoke.task.update, (_e, taskDir: string, patch: Record<string, unknown>, expectedMtime?: number) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    try {
      updateTaskRecordAt(root, taskDir, patch, expectedMtime)
      sendSnapshot()
      return { ok: true }
    } catch (e) {
      const msg = errorMessage(e)
      if (isConflict(e)) return ipcFail(IpcErrorCode.Conflict, msg ?? '任务已被外部修改', { conflict: true })
      return ipcFail(IpcErrorCode.Io, msg ?? '写入 task.json 失败')
    }
  })

  handle(ipcInvoke.task.delete, (_e, taskDir: string, expectedMtime?: number) => deleteTaskRecord(taskDir, expectedMtime))

  handle(ipcInvoke.task.createFromJira, (_e, input) => createTaskRecord(input))

  handle(ipcInvoke.task.create, (_e, input: { title: string; description: string; priority: string }) => {
    const dirName = slugifyTitle(input.title)
    return createTaskRecord({
      dirName,
      title: input.title,
      description: input.description,
      status: 'planning',
      priority: input.priority || 'P2',
      assignee: getSnapshot()?.meta.developer ?? ''
    })
  })

  handle(ipcInvoke.task.writeArtifact, (_e, dirName: string, fileName: string, content: string) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    const t = findTask(String(dirName))
    if (!t) return ipcFail(IpcErrorCode.NotFound, `任务不存在: ${dirName}`)
    const name = String(fileName ?? '').trim()
    if (!/^[\w.-]+\.(md|markdown|txt|yaml|yml|json)$/i.test(name)) {
      return ipcFail(IpcErrorCode.InvalidArg, '文件名不合法（仅允许 md/txt/yaml/json）')
    }
    try {
      const p = join(t.path, name)
      writeFileSync(p, String(content ?? ''), 'utf-8')
      sendSnapshot()
      return { ok: true, path: p }
    } catch (e) {
      return ipcFail(IpcErrorCode.Io, errorText(e, '写入失败'))
    }
  })
}

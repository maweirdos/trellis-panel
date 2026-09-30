import { join, resolve, basename } from 'path'
import { writeFileSync } from 'fs'
import { clipboard } from 'electron'
import { ipcInvoke } from '../../shared/ipc-channels'
import { errorText, errorMessage } from '../../shared/errors'
import { IpcErrorCode, ipcFail, noProject } from '../../shared/ipc-errors'
import { updateTaskRecordAt } from '../services/scan'
import { buildHandoffPackage, readPrdContent } from '../services/handoff'
import { getSettings } from '../services/store'
import {
  getProjectRoot,
  getSnapshot,
  findTask,
  sendSnapshot,
  createTaskRecord,
  deleteTaskRecord,
  slugifyTitle,
  markPanelWrite
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
      markPanelWrite(join(resolve(taskDir), 'task.json'))
      sendSnapshot()
      return { ok: true }
    } catch (e) {
      const msg = errorMessage(e)
      if (isConflict(e)) return ipcFail(IpcErrorCode.Conflict, msg ?? '任务已被外部修改', { conflict: true })
      return ipcFail(IpcErrorCode.Io, msg ?? '写入 task.json 失败')
    }
  })

  /** FR：从剪贴板解析任务（显式动作，非自动跳转）。接受 .trellis/tasks 下的
   *  绝对/相对路径或裸任务目录名；返回归一化 dirName 与归档标志。 */
  handle(ipcInvoke.task.resolveClipboardTask, async () => {
    const snap = getSnapshot()
    if (!snap) return noProject()
    let raw = ''
    try {
      raw = (await clipboard.readText()).trim()
    } catch {
      return ipcFail(IpcErrorCode.Io, '读取剪贴板失败')
    }
    if (!raw) return ipcFail(IpcErrorCode.InvalidArg, '剪贴板为空')
    raw = raw.replace(/^["']|["']$/g, '').replace(/[\\/]+$/, '')
    for (const c of [basename(raw), raw]) {
      const active = snap.tasks.find((t) => t.dirName === c || t.path.endsWith(c))
      if (active) return { ok: true as const, dirName: active.dirName, archived: false }
      const archived = snap.archived.find((t) => t.dirName === c || t.path.endsWith(c))
      if (archived) return { ok: true as const, dirName: archived.dirName, archived: true }
    }
    return ipcFail(IpcErrorCode.NotFound, `剪贴板内容不是本项目的任务：${raw.slice(0, 120)}`)
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

  /** T1：任务级分享深链（token 只在主进程拼装，渲染层不接触） */
  handle(ipcInvoke.task.buildTaskLink, (_e, dirName: string) => {
    const t = findTask(String(dirName))
    if (!t) return ipcFail(IpcErrorCode.NotFound, `任务不存在: ${dirName}`)
    const token = getSettings().bridgeToken
    return { ok: true as const, url: `trellis-panel://open-task?dir=${encodeURIComponent(t.path)}&t=${token}` }
  })

  /** T3：构建任务交接包（确定性文本；意图由渲染层选择，默认只核对与阅读） */
  handle(ipcInvoke.task.handoffBuild, (_e, dirName: string, intent: string, includePrd: boolean) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    const t = findTask(String(dirName))
    if (!t) return ipcFail(IpcErrorCode.NotFound, `任务不存在: ${dirName}`)
    const extra = includePrd ? { prdContent: readPrdContent(t.path) } : undefined
    return buildHandoffPackage(root, t, String(intent ?? ''), extra)
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
      markPanelWrite(p)
      sendSnapshot()
      return { ok: true, path: p }
    } catch (e) {
      return ipcFail(IpcErrorCode.Io, errorText(e, '写入失败'))
    }
  })
}

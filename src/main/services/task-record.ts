/** Root-scoped task creator shared by GUI and daemon knowledge handoff. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CreateTaskInput, CreateTaskResult } from '../state'
import type { ProjectSnapshot } from '../../shared/types'
import { IpcErrorCode, ipcFail, noProject, type IpcFail } from '../../shared/ipc-errors'
import { errorText } from '../../shared/errors'
import { getSettings } from './store'
import { resolveAuthorizedDocumentPath } from './documents/paths'
export interface TaskRecordPorts { snapshot?: ProjectSnapshot | null; markWritten?(path: string): void; changed?(): void }
export function createTaskRecordAt(root: string, input: CreateTaskInput, ports: TaskRecordPorts = {}): CreateTaskResult | IpcFail {
  if (!root) return noProject()
  if (!/^[^\\/.:\u0000-\u001f]{1,200}$/.test(input.dirName) || !resolveAuthorizedDocumentPath(root, `.trellis/tasks/${input.dirName}/task.json`).ok) return ipcFail(IpcErrorCode.InvalidArg, '任务目录无效或超出项目范围')
  const tasksRoot = join(root, '.trellis', 'tasks')
  const today = new Date()
  const pad = (x: number): string => String(x).padStart(2, '0')
  const mm = pad(today.getMonth() + 1)
  const dd = pad(today.getDate())
  const finalDirName = `${mm}-${dd}-${input.dirName}`
  const finalDir = join(tasksRoot, finalDirName)
  if (existsSync(finalDir)) return ipcFail(IpcErrorCode.Conflict, `任务目录 ${finalDirName} 已存在`)
  const jiraKey = input.jiraKey
  if (jiraKey) {
    const existing = [...(ports.snapshot?.tasks ?? []), ...(ports.snapshot?.archived ?? [])]
      .find((t) => String(t.record?.meta?.jiraKey ?? '').toUpperCase() === jiraKey.toUpperCase())
    if (existing) return ipcFail(IpcErrorCode.Conflict, `Jira ${jiraKey} 已关联任务 ${existing.dirName}`)
  }
  try {
    mkdirSync(tasksRoot, { recursive: true })
    // GUI and daemon share this creator. Claim the leaf atomically before writing.
    mkdirSync(finalDir)
    const meta: Record<string, unknown> = {}
    meta.origin = input.origin ?? (input.jiraKey ? 'jira' : 'panel')
    if (input.jiraKey) {
      meta.jiraKey = input.jiraKey
      meta.jiraUrl = input.jiraUrl ?? ''
    }
    const record: Record<string, unknown> = {
      id: input.dirName,
      name: input.dirName,
      title: input.title,
      description: input.description,
      status: input.status,
      dev_type: input.devType ?? null,
      scope: input.scope ?? null,
      package: null,
      priority: input.priority,
      creator: ports.snapshot?.meta.developer ?? getSettings().jira.user ?? 'panel',
      assignee: input.assignee,
      createdAt: `${today.getFullYear()}-${mm}-${dd}`,
      completedAt: null,
      branch: input.branch ?? null,
      base_branch: null,
      worktree_path: null,
      commit: null,
      pr_url: null,
      subtasks: input.subtasks ?? [],
      children: [],
      parent: null,
      relatedFiles: [],
      notes: input.jiraKey ? `从 Jira 导入：${input.jiraKey}\n${input.jiraUrl}` : '',
      meta
    }
    if (input.workflow) record.workflow = input.workflow
    writeFileSync(join(finalDir, 'task.json'), JSON.stringify(record, null, 2) + '\n', 'utf-8')
    ports.markWritten?.(join(finalDir, 'task.json'))
    const files = ['task.json']
    const warnings: string[] = []
    if (input.prdContent && input.prdContent.trim()) {
      const prdPath = join(finalDir, 'prd.md')
      // 目录为本面板新建，正常不存在同名文件；防御式检查避免覆盖用户内容
      if (!existsSync(prdPath)) {
        try {
          writeFileSync(prdPath, input.prdContent, 'utf-8')
          ports.markWritten?.(prdPath)
          files.push('prd.md')
        } catch (e) {
          warnings.push(`prd.md 写入失败：${errorText(e, '未知错误')}（任务已创建，可手动补写）`)
        }
      }
    }
    ports.changed?.()
    return { ok: true, dirName: finalDirName, files, warnings }
  } catch (e) {
    return ipcFail(IpcErrorCode.Io, errorText(e, '创建任务失败'))
  }
}

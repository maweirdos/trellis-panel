import { join, resolve, basename, sep } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs'
import { ipcInvoke, ipcEvent } from '../../shared/ipc-channels'
import { errorText, errorMessage } from '../../shared/errors'
import { IpcErrorCode, ipcFail, noProject } from '../../shared/ipc-errors'
import { broadcastToWindows } from '../services/bridge'
import { getSettings } from '../services/store'
import { updateTaskRecordAt } from '../services/scan'
import { isGitRepo, taskGitInfo } from '../services/git'
import { buildArchiveDoc, weknoraPushManual } from '../services/weknora'
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

  handle(ipcInvoke.task.archive, async (_e, dirName: string) => {
    const root = getProjectRoot()
    const snap = getSnapshot()
    if (!root || !snap) return noProject()
    const t = findTask(String(dirName))
    if (!t) return ipcFail(IpcErrorCode.NotFound, `任务不存在: ${dirName}`)
    if (t.archived) return ipcFail(IpcErrorCode.Denied, '任务已在归档中')
    const target = resolve(t.path)
    const tasksRoot = resolve(root, '.trellis', 'tasks') + sep
    if (!target.startsWith(tasksRoot)) return ipcFail(IpcErrorCode.InvalidArg, '非法任务目录')
    try {
      const jsonPath = join(target, 'task.json')
      const rec = JSON.parse(readFileSync(jsonPath, 'utf-8'))
      if (!rec.completedAt) {
        const now = new Date()
        const pad = (x: number): string => String(x).padStart(2, '0')
        rec.completedAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
        writeFileSync(jsonPath, JSON.stringify(rec, null, 2) + '\n', 'utf-8')
      }
    } catch {
      // task.json 缺失时仍允许归档
    }
    // WeKnora 沉淀素材必须在 rename 前读取（rename 后 t.path 失效）
    const wkCfg = getSettings().weknora
    let wkPayload: ReturnType<typeof buildArchiveDoc> | null = null
    if (wkCfg.enabled && wkCfg.autoPushArchive && wkCfg.archiveKbId) {
      const rec = t.record
      let prd: string | null = null
      try {
        prd = readFileSync(join(target, 'prd.md'), 'utf-8')
      } catch {
        // 无 PRD 时用描述字段
      }
      let commits: string[] = []
      if (rec?.branch && isGitRepo(root)) {
        try {
          const gi = await taskGitInfo(root, t.dirName, rec.branch, rec.base_branch ?? null)
          commits = gi.commits.map((c) => `\`${c.short}\` ${c.subject}`)
        } catch {
          // git 信息缺失不影响沉淀
        }
      }
      const meta = rec?.meta as Record<string, unknown> | undefined
      wkPayload = buildArchiveDoc({
        projectName: snap.meta.name,
        dirName: t.dirName,
        title: rec?.title ?? t.dirName,
        completedAt: rec?.completedAt ?? null,
        jiraKey: (typeof meta?.jiraKey === 'string' && meta.jiraKey) || t.jiraKey || null,
        jiraUrl: typeof meta?.jiraUrl === 'string' ? meta.jiraUrl : null,
        branch: rec?.branch ?? null,
        prUrl: rec?.pr_url ?? null,
        notes: rec?.notes ?? '',
        description: rec?.description ?? '',
        subtasks: rec?.subtasks ?? [],
        prd,
        commits
      })
    }
    const archiveRoot = join(root, '.trellis', 'archive')
    mkdirSync(archiveRoot, { recursive: true })
    let destName = basename(target)
    let dest = join(archiveRoot, destName)
    let i = 2
    while (existsSync(dest)) {
      destName = `${basename(target)}-${i}`
      dest = join(archiveRoot, destName)
      i += 1
    }
    try {
      renameSync(target, dest)
      sendSnapshot()
      // 归档成功后异步沉淀公司库（不阻塞归档返回；结果走 toast）
      if (wkPayload) {
        const payload = wkPayload
        void weknoraPushManual(wkCfg, wkCfg.archiveKbId, payload).then((r) => {
          broadcastToWindows(ipcEvent.toast, r.ok
            ? { kind: 'success', title: '已沉淀到公司库（WeKnora）', body: payload.title }
            : { kind: 'warn', title: '公司库沉淀失败', body: r.error })
        })
      }
      return { ok: true, dirName: destName }
    } catch (e) {
      return ipcFail(IpcErrorCode.Io, errorText(e, '归档失败'))
    }
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

import { createHash, randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { WorkcopyLease } from '../../../shared/workcopy-use'
import { runNativeWorkcopyCommand, recoverNativeWorkcopyCommand } from '../workcopy-use/native-command'
import { resolveWorkcopy, assertWorkcopyObservation } from '../workcopy-use/identity'
import { DaemonError } from '../../daemon/errors'
import { daemonClientContext } from '../daemon-client/manager'
import { checkedDirectory, directoryIdentity } from '../private-conversations/files'

/**
 * task.py CLI 执行器（design §7.2）：
 * - 参数数组执行（不经 shell 拼接）、固定 cwd=项目根、检查退出码；
 * - 禁止 --force；create 一律 --no-start（不改会话当前任务指针、不置 in_progress）；
 * - 输出有界收集；Windows Job Object 隔离并核验所有子进程清理；
 * - 超时≠成功：code=null + aborted=true，由上层按失败处理。
 *
 * 原生命令回执与工作副本准入共用已有 daemon。
 */

export interface TaskCliSpawnOptions {
  root: string
  /** python 可执行（默认 'python'；冒烟/环境差异可注入）。 */
  pythonCommand?: string
  /** task.py 路径（默认 <root>/.trellis/scripts/task.py）。 */
  taskPyPath?: string
  timeoutMs?: number
  /** Durable native command ID; retry reconciles this operation without re-executing. */
  operationId?: string
  /** Existing preparation writer/tree-change lease; never use a renderer token. */
  workcopyLease?: WorkcopyLease
  /** Main-owned official task activation context; never inherit another chat's pointer. */
  taskContextKey?: string
}

export interface TaskCliRunResult {
  /** 进程退出码；被杀/启动失败为 null（abandoned/error 细分见 aborted/failedToStart）。 */
  code: number | null
  stdout: string
  stderr: string
  /** 超时被杀。 */
  aborted: boolean
  /** 进程未能启动（ENOENT 等）。 */
  failedToStart: boolean
  /** 从输出解析到的 "Created task: <dir>"（仅 create；仍需上层 fs 核实）。 */
  createdDirName: string | null
  cleanupConfirmed: boolean
  operationId: string
}

const ANSI_RE = // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

async function runTaskPy(options: TaskCliSpawnOptions, args: string[]): Promise<Omit<TaskCliRunResult, 'createdDirName'>> {
  if (options.workcopyLease) {
    if (!['writer', 'tree-change'].includes(options.workcopyLease.kind)) throw new DaemonError('E_DENIED', '任务材料命令需要 writer 或 tree-change 登记。')
    assertWorkcopyObservation(resolveWorkcopy(options.root), options.workcopyLease.identity)
  }
  const python = options.pythonCommand ?? 'python'
  const taskPy = options.taskPyPath ?? join(options.root, '.trellis', 'scripts', 'task.py')
  const timeoutMs = options.timeoutMs ?? 30_000
  return runNativeWorkcopyCommand(options.root, {
    operationId: options.operationId ?? randomUUID(), executable: python, args: [taskPy, ...args], timeoutMs,
    env: { FORCE_COLOR: '0', NO_COLOR: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
      ...(options.taskContextKey === undefined ? {} : { TRELLIS_CONTEXT_ID: options.taskContextKey }) }, lease: options.workcopyLease
  })
}

/** Official lifecycle command; callers must verify actual status and the original context pointer. */
export async function runTaskStartCli(options: TaskCliSpawnOptions, dirName: string): Promise<TaskCliRunResult> {
  if (!options.taskContextKey || !/^[A-Za-z0-9_-]{1,200}$/.test(options.taskContextKey) || options.taskContextKey.startsWith('acp-private-')
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(dirName)) throw new DaemonError('E_INVALID_ARG', '任务启动需要原生捕获的任务与独立激活上下文。')
  const result = await runTaskPy(options, ['start', dirName])
  return { ...result, createdDirName: null }
}

/** Read-only absence proof at native-command's original receipt key. IO/redirect errors are not absence. */
export async function taskCliReceiptExists(root: string, operationId: string): Promise<boolean> {
  z.string().uuid().parse(operationId)
  let parent = checkedDirectory((await daemonClientContext()).directory)
  const entry = (name: string): ReturnType<typeof lstatSync> | null => {
    const identity = directoryIdentity(parent)
    try {
      const value = lstatSync(join(parent, name))
      if (directoryIdentity(parent) !== identity) throw new DaemonError('E_CONFLICT', '原命令回执目录已变化。')
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (directoryIdentity(parent) !== identity) throw new DaemonError('E_CONFLICT', '不能核验原命令回执是否存在。')
      return null
    }
  }
  const key = createHash('sha256').update(JSON.stringify([root.toLowerCase(), operationId])).digest('hex')
  for (const name of ['workcopy-commands', key]) {
    const value = entry(name)
    if (!value) return false
    if (!value.isDirectory() || value.isSymbolicLink()) throw new DaemonError('E_DENIED', '原命令回执目录包含重定向。')
    parent = checkedDirectory(join(parent, name))
  }
  return entry('operation.json') !== null
}

export interface TaskCreateCliInput {
  title: string
  description: string
  slug: string
  assignee: string
  priority: string
  /** 扁平 meta 键值（panel_* 恢复标识；值原样字符串）。 */
  meta: Array<[string, string]>
}

/** task.py create --no-start（无 --force）。 */
export async function runTaskCreateCli(options: TaskCliSpawnOptions, input: TaskCreateCliInput): Promise<TaskCliRunResult> {
  const args = [
    'create',
    input.title,
    '--description',
    input.description,
    '--slug',
    input.slug,
    '--assignee',
    input.assignee,
    '--priority',
    input.priority,
    '--no-start'
  ]
  for (const [k, v] of input.meta) args.push('--meta', `${k}=${v}`)
  const operationId = options.operationId ?? input.meta.find(([key]) => key === 'panel_operation_id')?.[1] ?? randomUUID()
  const res = await runTaskPy({ ...options, operationId }, args)
  // "Created task: <dir>" 走 stderr（common/task_store.cmd_create）；仅作定位线索，仍需 fs 核实
  const m = stripAnsi(res.stderr + '\n' + res.stdout).match(/Created task:\s*([^\s\r\n"']+)/)
  return { ...res, createdDirName: m !== null ? m[1] : null }
}

/** Reconcile/clean the exact original container. Never rerun task.py or infer from root exit. */
export async function recoverTaskCliOperation(root: string, operationId: string): Promise<TaskCliRunResult> {
  const res = await recoverNativeWorkcopyCommand(root, operationId)
  const match = stripAnsi(res.stderr + '\n' + res.stdout).match(/Created task:\s*([^\s\r\n"']+)/)
  return { ...res, createdDirName: match?.[1] ?? null }
}

/** task.py archive（本地归档走既有语义；G3 别名更新由服务层负责）。 */
export async function runTaskArchiveCli(
  options: TaskCliSpawnOptions,
  dirName: string,
  flags: { skipBranchValidation?: boolean; noCommit?: boolean } = {}
): Promise<TaskCliRunResult> {
  const args = ['archive', dirName]
  if (flags.skipBranchValidation === true) args.push('--skip-branch-validation')
  if (flags.noCommit === true) args.push('--no-commit')
  const res = await runTaskPy({ timeoutMs: 90_000, ...options }, args)
  return { ...res, createdDirName: null }
}

/** task.py add-subtask / remove-subtask：父子关联的唯一权威写入路径。
 *  面板此前在视图层伪造关联（刷新即丢），现统一走该受控命令。 */
export async function runTaskSubtaskCli(
  options: TaskCliSpawnOptions,
  parentDir: string,
  childDir: string,
  remove = false
): Promise<TaskCliRunResult> {
  const res = await runTaskPy(options, [remove ? 'remove-subtask' : 'add-subtask', parentDir, childDir])
  return { ...res, createdDirName: null }
}

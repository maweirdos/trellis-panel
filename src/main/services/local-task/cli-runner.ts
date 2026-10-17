import { spawn } from 'node:child_process'
import { join } from 'node:path'

/**
 * task.py CLI 执行器（design §7.2）：
 * - 参数数组执行（不经 shell 拼接）、固定 cwd=项目根、检查退出码；
 * - 禁止 --force；create 一律 --no-start（不改会话当前任务指针、不置 in_progress）；
 * - 输出有界收集；超时强杀（Windows 杀进程树）；
 * - 超时≠成功：code=null + aborted=true，由上层按失败处理。
 *
 * 本模块不 import electron（冒烟直驱）。
 */

export interface TaskCliSpawnOptions {
  root: string
  /** python 可执行（默认 'python'；冒烟/环境差异可注入）。 */
  pythonCommand?: string
  /** task.py 路径（默认 <root>/.trellis/scripts/task.py）。 */
  taskPyPath?: string
  timeoutMs?: number
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
}

const OUTPUT_CAP_BYTES = 64 * 1024
const ANSI_RE = // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

function runTaskPy(options: TaskCliSpawnOptions, args: string[]): Promise<Omit<TaskCliRunResult, 'createdDirName'>> {
  const python = options.pythonCommand ?? 'python'
  const taskPy = options.taskPyPath ?? join(options.root, '.trellis', 'scripts', 'task.py')
  const timeoutMs = options.timeoutMs ?? 30_000
  return new Promise((resolve) => {
    let proc
    try {
      proc = spawn(python, [taskPy, ...args], {
        cwd: options.root,
        windowsHide: true,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
      })
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: `启动 task.py 失败: ${e instanceof Error ? e.message : String(e)}`, aborted: false, failedToStart: true })
      return
    }
    let stdout = ''
    let stderr = ''
    let aborted = false
    const capPush = (current: string, chunk: Buffer): string => {
      if (current.length >= OUTPUT_CAP_BYTES) return current
      return (current + chunk.toString('utf-8')).slice(0, OUTPUT_CAP_BYTES)
    }
    proc.stdout?.on('data', (d: Buffer) => {
      stdout = capPush(stdout, d)
    })
    proc.stderr?.on('data', (d: Buffer) => {
      stderr = capPush(stderr, d)
    })
    proc.on('error', (e) => {
      resolve({ code: null, stdout, stderr: `${stderr}\n启动 task.py 失败: ${e.message}`.trim(), aborted, failedToStart: true })
    })
    const timer = setTimeout(() => {
      aborted = true
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
      } else {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }, timeoutMs)
    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code === null ? null : Number(code), stdout, stderr, aborted, failedToStart: false })
    })
  })
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
  const res = await runTaskPy(options, args)
  // "Created task: <dir>" 走 stderr（common/task_store.cmd_create）；仅作定位线索，仍需 fs 核实
  const m = stripAnsi(res.stderr + '\n' + res.stdout).match(/Created task:\s*([^\s\r\n"']+)/)
  return { ...res, createdDirName: m !== null ? m[1] : null }
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

import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, resolve, sep } from 'path'

/**
 * 任务身份纯函数层（design §2/§3.1，S0 G3 第一片）：
 * 路径 → Trellis 任务定位、task.json.id 读取与 taskRef 派生、归档续接扫描输入。
 *
 * 语义红线（design §3.1）：
 * - taskRef 是绑定内稳定本机 ID，映射 task.json.id 与原始相对目录；
 *   无 task.json.id 时按目录派生，不按文件名相似度或当前 UI 选中任务猜归属。
 * - 归档续接只认「原路径消失且唯一同 ID 目标」（判定在控制库 verifyTaskAliases）；
 *   多候选/复制目录/重复 ID → 待确认，不自动合并。
 * - 本模块不落库、不产生 IO 副作用（readTrellisTaskId/scanKnownTaskDirs 为只读探测）；
 *   写入控制库的编排（worker 调用）在 observability/service.ts，避免循环依赖。
 */

/** 相对目录统一正斜杠（`.trellis/tasks/<dir>` / `.trellis/tasks/archive/<ym>/<dir>`）。 */
export function toRepoRelativeDir(root: string, taskDirPath: string): string {
  let rel = resolve(taskDirPath).slice(resolve(root).length)
  rel = rel.replace(/^[\\/]+/, '')
  if (sep !== '/') rel = rel.split(sep).join('/')
  return rel
}

export interface ParsedTrellisTaskPath {
  /** 任务目录（不含 .trellis/tasks/ 前缀；归档任务为其末段目录名）。 */
  taskDir: string
  /** 任务目录内相对文件（如 `prd.md`、`research/x.md`）。 */
  innerPath: string
  /** 归档任务（.trellis/tasks/archive/<ym>/<dir>/…）。 */
  archived: boolean
  /** 仓库相对目录（正斜杠，别名表口径）。 */
  repoRelativeDir: string
}

/**
 * 解析一个绝对路径是否落在 .trellis/tasks 结构内（吸收 acp.ts 原正则；
 * archive/ 单独识别——旧逻辑把 `archive` 当 taskDir，此处显式区分）。
 */
export function parseTrellisTaskPath(root: string, rawPath: string): ParsedTrellisTaskPath | null {
  const p = rawPath.replace(/\\/g, '/')
  const m = p.match(/^(?:.*\/)?\.trellis\/tasks\/(.+)$/)
  if (m === null) return null
  const rest = m[1]
  const archiveMatch = rest.match(/^archive\/([0-9]{4}-[0-9]{2})\/([^/]+)\/(.+)$/)
  if (archiveMatch !== null) {
    return {
      taskDir: archiveMatch[2],
      innerPath: archiveMatch[3],
      archived: true,
      repoRelativeDir: `.trellis/tasks/archive/${archiveMatch[1]}/${archiveMatch[2]}`
    }
  }
  const activeMatch = rest.match(/^([^/]+)\/(.+)$/)
  if (activeMatch === null) return null
  return {
    taskDir: activeMatch[1],
    innerPath: activeMatch[2],
    archived: false,
    repoRelativeDir: `.trellis/tasks/${activeMatch[1]}`
  }
}

/** task.json 读取上限（超出按不可读处理，不无界装载）。 */
const TASK_JSON_READ_LIMIT_BYTES = 256 * 1024

/** 读取任务目录的 task.json.id；缺失/超限/坏 JSON → null（不猜、不抛出）。 */
export function readTrellisTaskId(root: string, repoRelativeDir: string): string | null {
  const file = join(resolve(root), ...repoRelativeDir.split('/'), 'task.json')
  try {
    const st = statSync(file)
    if (!st.isFile() || st.size > TASK_JSON_READ_LIMIT_BYTES) return null
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    const id = (raw as { id?: unknown }).id
    if (typeof id === 'string' && id.length > 0 && id.length <= 256) return id
    return null
  } catch {
    return null
  }
}

/**
 * taskRef 派生（绑定内稳定）：
 * - 有 task.json.id → `task:<id>`（归档移动后不变，续接依据）；
 * - 无 id（task.json 未写/损坏）→ `dir:<repoRelativeDir>`（目录移动即断链，显示待确认）。
 * 前缀隔离两种来源，避免 id 恰与目录名同形时串线。
 */
export function taskRefFor(trellisTaskId: string | null, repoRelativeDir: string): string {
  return trellisTaskId !== null ? `task:${trellisTaskId}` : `dir:${repoRelativeDir}`
}

/** scanKnownTaskDirs 输出项（verifyTaskAliases 的 known 输入口径）。 */
export interface KnownTaskDir {
  /** 仓库相对目录（正斜杠）。 */
  dir: string
  /** task.json.id；缺失/不可读为 null（此时只做存在性续接，不做同 ID 归并）。 */
  trellisTaskId: string | null
}

function listTaskDirsUnder(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => name !== '.' && name !== '..')
  } catch {
    return []
  }
}

/**
 * 扫描当前真实任务目录（活跃 + 归档），作为别名续接核验输入。
 * 只读目录与 task.json.id；不修改任何文件。归档月份目录按 yyyy-mm 识别。
 */
export function scanKnownTaskDirs(root: string): KnownTaskDir[] {
  const tasksRoot = join(resolve(root), '.trellis', 'tasks')
  const out: KnownTaskDir[] = []
  const push = (repoRelativeDir: string): void => {
    out.push({ dir: repoRelativeDir, trellisTaskId: readTrellisTaskId(root, repoRelativeDir) })
  }
  for (const name of listTaskDirsUnder(tasksRoot)) {
    if (name === 'archive') continue
    push(`.trellis/tasks/${name}`)
  }
  const archiveRoot = join(tasksRoot, 'archive')
  for (const month of listTaskDirsUnder(archiveRoot)) {
    if (!/^\d{4}-\d{2}$/.test(month)) continue
    const monthDir = join(archiveRoot, month)
    for (const name of listTaskDirsUnder(monthDir)) {
      push(`.trellis/tasks/archive/${month}/${name}`)
    }
  }
  return out
}

/** runtime 目录路径（不创建；创建走 identity.ensureRuntimeDir）。 */
export function runtimeDirOf(root: string): string {
  return join(resolve(root), '.trellis', '.panel', 'runtime')
}

/** 绑定/库文件是否已存在（决定是否值得拉起观测 worker）。 */
export function observationRuntimeExists(root: string): boolean {
  const dir = runtimeDirOf(root)
  if (!existsSync(dir)) return false
  try {
    return readdirSync(dir).some((f) => f === 'binding.json' || f === 'observations.sqlite')
  } catch {
    return false
  }
}

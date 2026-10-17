/**
 * T3：任务交接包构建器（05 §5.2 / 06 v2 §2 支柱三）。
 * 原则：确定性生成（不依赖 LLM）；只放索引与元信息，不复制整仓库、不含凭据；
 * 阅读清单按文件真实存在性拼装；已知读取问题如实申报。
 * 接续说明完整性（PF-08/PF-11，数据附录"最小接续说明"表）：在阅读清单之外
 * 如实汇总——本次变化（Git，归属以 git 为准）、检查记录与未完成子任务、
 * PRD 内待确认问题；缺哪块就说未发现，不冒充已有结论。
 */
import { existsSync, readFileSync } from 'fs'
import { join, relative } from 'path'
import { isGitRepo, runGit } from './git'
import type { TaskInfo } from '../../shared/types'

export interface HandoffBuildResult {
  ok: boolean
  error?: string
  text: string
  /** 已知读取问题（缺失/无法读取）；空数组表示无 */
  issues: string[]
  /** 阅读清单里实际存在的文件（相对项目根，正斜杠） */
  files: string[]
  /** 本次变化（Git）摘要行；空数组表示项目非 git 仓库等中性情况 */
  gitLines: string[]
  /** 任务目录内实际存在的检查记录文件名 */
  checkFiles: string[]
  /** 子任务未勾选项（原样文本，截断上限 12） */
  uncheckedSubtasks: string[]
  /** prd.md "待确认"类小节下的未决问题（上限 8） */
  openQuestions: string[]
}

export const DEFAULT_INTENT = '只核对与阅读，不开始实施'

const MAX_LINE = 200
const MAX_CHECK_FILES = 6
const MAX_SUBTASKS = 12
const MAX_QUESTIONS = 8

function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

function clip(line: string): string {
  return line.length > MAX_LINE ? line.slice(0, MAX_LINE) + '…' : line
}

/** prd.md 中"待确认/开放问题/待问"小节下的未决项；无该小节返回空。 */
function extractOpenQuestions(prdPath: string): string[] {
  let content: string
  try {
    content = readFileSync(prdPath, 'utf-8')
  } catch {
    return []
  }
  const lines = content.split(/\r?\n/)
  const out: string[] = []
  let inSection = false
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      inSection = /待确认|开放问题|待问/.test(line)
      continue
    }
    if (!inSection) continue
    const m = /^\s*-\s*\[ \]\s*(.+)$/.exec(line) ?? /^\s*-\s+(?![[\s])[^\s].+$/.exec(line)
    if (m) {
      out.push(clip(m[1].trim()))
      if (out.length >= MAX_QUESTIONS) break
    }
  }
  return out
}

/** Git 变化摘要（只读命令；脏改动未必属于本任务，原样标注）。 */
async function collectGitLines(root: string, task: TaskInfo): Promise<string[]> {
  if (!isGitRepo(root)) return ['当前项目不是 git 仓库——变化以任务资料与检查记录为准']
  const lines: string[] = []
  const cur = await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const branch = cur.ok ? cur.out.trim() : null
  const dirty = await runGit(root, ['status', '--porcelain'])
  const dirtyCount = dirty.ok ? dirty.out.split(/\r?\n/).filter((l) => l.trim()).length : -1
  if (branch) lines.push(clip(`当前分支：${branch}`))
  if (dirtyCount >= 0) lines.push(clip(`工作区有 ${dirtyCount} 处未提交改动（未必全部属于本任务，归属以 git 为准）`))
  const taskBranch = task.record?.branch ?? null
  if (taskBranch) {
    const show = await runGit(root, ['rev-parse', '--verify', taskBranch])
    if (show.ok) {
      const base = task.record?.base_branch || 'main'
      const baseExists = (await runGit(root, ['rev-parse', '--verify', base])).ok
      if (baseExists) {
        const ab = await runGit(root, ['rev-list', '--left-right', '--count', `${base}...${taskBranch}`])
        if (ab.ok) {
          const [behind, ahead] = ab.out.trim().split(/\s+/).map((x) => parseInt(x, 10) || 0)
          lines.push(clip(`任务分支 ${taskBranch}：领先 ${base} ${ahead} / 落后 ${behind}`))
        }
      }
      const last = await runGit(root, ['log', taskBranch, '-1', '--pretty=format:%h %s'])
      if (last.ok && last.out.trim()) lines.push(clip(`任务分支最近提交：${last.out.trim()}`))
    } else {
      lines.push(clip(`任务分支 ${taskBranch} 不存在（可能尚未创建或已被删除）`))
    }
  } else {
    lines.push(clip('任务未关联分支——本次变化请配合工作区状态与提交记录核对'))
  }
  return lines
}

export async function buildHandoffPackage(
  root: string,
  task: TaskInfo,
  intent: string,
  extra?: { prdContent?: string | null }
): Promise<HandoffBuildResult> {
  const relDir = toPosix(relative(root, task.path))
  const issues: string[] = []
  const files: string[] = []

  if (task.parseError) issues.push(`task.json 无法读取（${task.parseError}）`)

  // 阅读清单：只列真实存在的文件
  const entry = existsSync(join(root, 'AGENTS.md')) ? 'AGENTS.md' : null
  const lines: string[] = ['请先核对工作目录，再读取：']
  let n = 0
  if (entry) {
    n += 1
    lines.push(`${n}. 项目入口说明（${entry}）`)
    files.push(entry)
  } else {
    issues.push('未找到 AGENTS.md 项目入口说明（按目标平台的对应说明为准）')
  }
  const candidates: Array<{ abs: string; rel: string; label: string }> = [
    { abs: join(root, '.trellis', 'workflow.md'), rel: '.trellis/workflow.md', label: '项目工作流契约' },
    { abs: join(task.path, 'prd.md'), rel: `${relDir}/prd.md`, label: '当前任务需求' },
    { abs: join(task.path, 'design.md'), rel: `${relDir}/design.md`, label: '当前任务设计' },
    { abs: join(task.path, 'implement.md'), rel: `${relDir}/implement.md`, label: '当前任务实施计划' },
    { abs: join(task.path, 'implement.jsonl'), rel: `${relDir}/implement.jsonl`, label: '实现阶段上下文引用清单' },
    { abs: join(task.path, 'check.jsonl'), rel: `${relDir}/check.jsonl`, label: '检查阶段上下文引用清单' }
  ]
  let prdMissing = true
  for (const c of candidates) {
    if (!existsSync(c.abs)) {
      if (c.rel.endsWith('prd.md')) prdMissing = true
      continue
    }
    if (c.rel.endsWith('prd.md')) prdMissing = false
    n += 1
    lines.push(`${n}. ${c.rel}${c.label ? `（${c.label}）` : ''}`)
    files.push(c.rel)
  }
  if (prdMissing) issues.push('未找到 prd.md（轻量任务可合法缺失，按项目流程判断）')
  if (!existsSync(join(root, '.trellis', 'workflow.md'))) {
    issues.push('未找到 .trellis/workflow.md（该项目可能未完成 Trellis 初始化或工作流被定制）')
  }

  // 接续说明补充块（PF-08/PF-11）：全部只读事实，缺哪块如实说未发现
  const gitLines = await collectGitLines(root, task)
  const checkFiles = ['validation.md', 'check.md', 'review.md', 'qa.md']
    .filter((f) => existsSync(join(task.path, f)))
    .slice(0, MAX_CHECK_FILES)
  const uncheckedSubtasks = (task.record?.subtasks ?? [])
    .filter((s): s is string => typeof s === 'string' && /^-?\s*\[ \]/.test(s.trim()))
    .slice(0, MAX_SUBTASKS)
  const openQuestions = existsSync(join(task.path, 'prd.md')) ? extractOpenQuestions(join(task.path, 'prd.md')) : []

  const block: string[] = []
  if (gitLines.length > 0) {
    block.push('', '本次变化（Git · 归属以 git 为准）：', ...gitLines.map((l) => `- ${l}`))
  }
  block.push(
    '',
    '检查与未完成项：',
    `- 检查记录：${checkFiles.length > 0 ? checkFiles.join('、') : '未发现检查记录文件（validation.md / check.md 等）'}`,
    uncheckedSubtasks.length > 0
      ? `- 未完成子任务 ${uncheckedSubtasks.length} 项：${uncheckedSubtasks.map((s) => clip(s.trim())).join('；')}`
      : '- 未完成子任务：无（或子任务清单未维护）',
  )
  if (openQuestions.length > 0) {
    block.push(`待确认问题（来自 prd.md，${openQuestions.length} 项）：`, ...openQuestions.map((q) => `- [ ] ${q}`))
  }

  const status = task.record?.status ?? '未知'
  const readAt = new Date().toLocaleString('zh-CN', { hour12: false })
  const text = [
    `任务：${task.record?.title ?? task.dirName}（${task.dirName}）`,
    `工作目录：${root}`,
    `任务目录：${relDir}`,
    `记录阶段：${status}，读取于 ${readAt}`,
    '',
    ...lines,
    ...block,
    '',
    `本次用户意图：${intent.trim() || DEFAULT_INTENT}`,
    `已知读取问题：${issues.length > 0 ? issues.join('；') : '无'}`,
    '',
    '请通过当前平台的 Trellis 流程确认并绑定任务。',
    '不要因为复制了这份交接材料就创建重复任务、自动开始实施或归档。'
  ].join('\n')

  let finalText = text
  if (extra?.prdContent) {
    finalText =
      text +
      '\n\n----- 以下为 PRD 原文（用户显式选择携带；内容将离开本机） -----\n' +
      extra.prdContent
  }

  return { ok: true, text: finalText, issues, files, gitLines, checkFiles, uncheckedSubtasks, openQuestions }
}

/** 读取 PRD 原文（附加选项用；读不到返回 null） */
export function readPrdContent(taskPath: string): string | null {
  try {
    return readFileSync(join(taskPath, 'prd.md'), 'utf-8')
  } catch {
    return null
  }
}

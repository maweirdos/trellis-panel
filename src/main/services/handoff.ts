/**
 * T3：任务交接包构建器（05 §5.2 / 06 v2 §2 支柱三）。
 * 原则：确定性生成（不依赖 LLM）；只放索引与元信息，不复制整仓库、不含凭据；
 * 阅读清单按文件真实存在性拼装；已知读取问题如实申报。
 * 旧 plan.ts handoffTexts 含"完成后更新 task.json 状态"越权指引与平台硬编码
 * 命令，不复用；其清理随 PlanningModal 迁移另行处理。
 */
import { existsSync, readFileSync } from 'fs'
import { join, relative } from 'path'
import type { TaskInfo } from '../../shared/types'

export interface HandoffBuildResult {
  ok: boolean
  error?: string
  text: string
  /** 已知读取问题（缺失/无法读取）；空数组表示无 */
  issues: string[]
  /** 阅读清单里实际存在的文件（相对项目根，正斜杠） */
  files: string[]
}

export const DEFAULT_INTENT = '只核对与阅读，不开始实施'

function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

export function buildHandoffPackage(
  root: string,
  task: TaskInfo,
  intent: string,
  extra?: { prdContent?: string | null }
): HandoffBuildResult {
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

  const status = task.record?.status ?? '未知'
  const readAt = new Date().toLocaleString('zh-CN', { hour12: false })
  const text = [
    `任务：${task.record?.title ?? task.dirName}（${task.dirName}）`,
    `工作目录：${root}`,
    `任务目录：${relDir}`,
    `记录阶段：${status}，读取于 ${readAt}`,
    '',
    ...lines,
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

  return { ok: true, text: finalText, issues, files }
}

/** 读取 PRD 原文（附加选项用；读不到返回 null） */
export function readPrdContent(taskPath: string): string | null {
  try {
    return readFileSync(join(taskPath, 'prd.md'), 'utf-8')
  } catch {
    return null
  }
}

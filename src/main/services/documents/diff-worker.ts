import { parentPort } from 'node:worker_threads'
import { diffLines } from 'diff'
import type { DocumentDiffHunk, DocumentDiffLine, DocumentDiffStats } from '../../../shared/documents'

/**
 * jsdiff worker（S0 G2，design §6.2）：行级 diff 在独立线程计算，
 * 主进程按 1s 超时预算 terminate，不阻塞主进程事件循环。
 *
 * 语义红线：
 * - 输出是纯文本行（统一单列结构），worker 侧剥离控制字符；
 *   本模块不做 HTML 实体转义——wire 契约只承载文本，渲染端以文本节点呈现，
 *   绝不把 diff 输出当 HTML 注入（design §6.2「不渲染不可信 diff 为 HTML」）。
 * - 纯计算函数（sanitizeDiffLine / computeUnifiedDiff）无副作用、可在任意线程直接
 *   调用，供冒烟做转义与结构断言；线程消息循环仅在 parentPort 存在时启动
 * （主线程 import 本模块无副作用）。
 */

/** 剥离 C0/C1 控制字符（保留 \t；\r 一并剥离，避免 CRLF 行尾残留），防终端转义/控制序列注入。 */
export function sanitizeDiffLine(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f]/g, '').replace(/\r/g, '')
}

interface DiffRow {
  type: DocumentDiffLine['type']
  text: string
  oldLine: number | null
  newLine: number | null
}

/** jsdiff 行块 → 带双侧行号的行序列（统一单列的行序：removed 在 added 前，与 jsdiff 输出一致）。 */
function rowsOf(oldText: string, newText: string): DiffRow[] {
  const chunks = diffLines(oldText, newText)
  const rows: DiffRow[] = []
  let oldNo = 1
  let newNo = 1
  for (const chunk of chunks) {
    if (!chunk.value) continue
    const lines = chunk.value.split('\n')
    if (chunk.value.endsWith('\n')) lines.pop()
    for (const text of lines) {
      if (chunk.added === true) {
        rows.push({ type: 'added', text: sanitizeDiffLine(text), oldLine: null, newLine: newNo++ })
      } else if (chunk.removed === true) {
        rows.push({ type: 'removed', text: sanitizeDiffLine(text), oldLine: oldNo++, newLine: null })
      } else {
        rows.push({ type: 'context', text: sanitizeDiffLine(text), oldLine: oldNo++, newLine: newNo++ })
      }
    }
  }
  return rows
}

export interface UnifiedDiffCore {
  identical: boolean
  hunks: DocumentDiffHunk[]
  stats: DocumentDiffStats
}

/**
 * 统一单列 diff（纯函数）：按 context 行折叠出 hunks；
 * 变更簇之间隔超过 2×context 行时分块。identical 时 hunks 为空。
 */
export function computeUnifiedDiff(oldText: string, newText: string, context: number): UnifiedDiffCore {
  const rows = rowsOf(oldText, newText)
  const isChange = (r: DiffRow): boolean => r.type !== 'context'

  let added = 0
  let removed = 0
  for (const r of rows) {
    if (r.type === 'added') added += 1
    else if (r.type === 'removed') removed += 1
  }
  const hasChange = added > 0 || removed > 0

  const hunks: DocumentDiffHunk[] = []
  let contextInHunks = 0
  if (hasChange) {
    let i = 0
    while (i < rows.length) {
      if (!isChange(rows[i])) {
        i += 1
        continue
      }
      // 变更簇：从 i 起，向后合并间隔 ≤ 2×context 的相邻变更
      let lastChange = i
      let j = i + 1
      while (j < rows.length) {
        if (isChange(rows[j])) {
          lastChange = j
          j += 1
          continue
        }
        if (j - lastChange - 1 <= 2 * context) {
          j += 1
          continue
        }
        break
      }
      const start = Math.max(0, i - context)
      const end = Math.min(rows.length, lastChange + 1 + context)
      const slice = rows.slice(start, end)
      const firstOld = slice.find((r) => r.oldLine !== null)?.oldLine ?? 0
      const firstNew = slice.find((r) => r.newLine !== null)?.newLine ?? 0
      hunks.push({
        oldStart: firstOld,
        oldLines: slice.filter((r) => r.type !== 'added').length,
        newStart: firstNew,
        newLines: slice.filter((r) => r.type !== 'removed').length,
        lines: slice.map(({ type, text, oldLine, newLine }) => ({ type, text, oldLine, newLine }))
      })
      contextInHunks += slice.filter((r) => r.type === 'context').length
      i = lastChange + 1
    }
  }

  return {
    identical: !hasChange,
    hunks,
    stats: { added, removed, context: contextInHunks }
  }
}

/* ---------------- 线程消息循环（仅 worker 线程内激活） ---------------- */

export interface DiffWorkerRequest {
  id: number
  oldText: string
  newText: string
  context: number
}

export type DiffWorkerResponse =
  | { id: number; ok: true; result: UnifiedDiffCore }
  | { id: number; ok: false; error: string }

if (parentPort !== null) {
  parentPort.on('message', (msg: DiffWorkerRequest) => {
    let response: DiffWorkerResponse
    try {
      response = { id: msg.id, ok: true, result: computeUnifiedDiff(msg.oldText, msg.newText, msg.context) }
    } catch (e) {
      response = { id: msg.id, ok: false, error: String((e as Error | null)?.message ?? e) }
    }
    parentPort?.postMessage(response)
  })
}

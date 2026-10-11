import { statSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'
import type {
  ContextManifestParsed,
  ContextManifestTotals,
  DocumentDiagnostic,
  ManifestEntry,
  ManifestReadability,
  TaskJsonFields,
  TaskJsonParsed
} from '../../../shared/documents'

/**
 * task.json / 上下文清单（jsonl）解析器（S0 G2 数据层，design §5.1/§6.1）。
 *
 * 纪律：
 * - 解析失败不当空任务、不静默——返回诊断并保留原文（由 controller 负责）。
 * - 未知字段/未知条目形态原样保留，不猜测语义。
 * - 清单条目只有"列入"事实与磁盘可读性事实，绝无"已执行/已使用"语义。
 */

/** task.json 中可结构化的常见字段（值仅接受字符串；其余形态原样留在 unknownFields）。 */
const TASK_JSON_CURATED_KEYS = [
  'id',
  'name',
  'title',
  'status',
  'priority',
  'assignee',
  'creator',
  'createdAt',
  'completedAt'
] as const

const emptyTaskJsonFields = (): TaskJsonFields => ({
  id: null,
  name: null,
  title: null,
  status: null,
  priority: null,
  assignee: null,
  creator: null,
  createdAt: null,
  completedAt: null
})

export type TaskJsonParseResult =
  | { parsed: TaskJsonParsed; diagnostic: null }
  | { parsed: null; diagnostic: DocumentDiagnostic }

/** 解析 task.json 文本。坏 JSON/非对象 → 诊断（不当空任务）。 */
export function parseTaskJsonText(rawText: string): TaskJsonParseResult {
  let obj: unknown
  try {
    obj = JSON.parse(rawText)
  } catch (e) {
    return {
      parsed: null,
      diagnostic: {
        code: 'parse_failed',
        severity: 'error',
        message: 'task.json 解析失败（可能正在写入），原文已保留，未按空任务处理',
        data: { kind: 'task-json', detail: e instanceof Error ? e.message : String(e) }
      }
    }
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return {
      parsed: null,
      diagnostic: {
        code: 'parse_failed',
        severity: 'error',
        message: 'task.json 内容不是 JSON 对象，原文已保留，未按空任务处理',
        data: { kind: 'task-json', detail: `实际类型: ${Array.isArray(obj) ? 'array' : typeof obj}` }
      }
    }
  }
  const source = obj as Record<string, unknown>
  const fields = emptyTaskJsonFields()
  const unknownFields: Record<string, unknown> = {}
  const curated = new Set<string>(TASK_JSON_CURATED_KEYS)
  for (const [key, value] of Object.entries(source)) {
    if (curated.has(key) && typeof value === 'string') {
      fields[key as keyof TaskJsonFields] = value
    } else {
      unknownFields[key] = value
    }
  }
  return { parsed: { kind: 'task-json', fields, unknownFields }, diagnostic: null }
}

/* ---------------- 上下文清单（jsonl） ---------------- */

/** 坏行诊断附带的原始行文本上限，防止一行巨文撑爆响应。 */
const BAD_LINE_RAW_LIMIT = 400

/** 空白行（不改行号，也不产生条目/诊断）。 */
function isBlankLine(line: string): boolean {
  return line.trim().length === 0
}

function truncateRaw(raw: string): { raw: string; rawTruncated: boolean } {
  if (raw.length <= BAD_LINE_RAW_LIMIT) return { raw, rawTruncated: false }
  return { raw: `${raw.slice(0, BAD_LINE_RAW_LIMIT)}…`, rawTruncated: true }
}

/**
 * 条目可读性 = 磁盘事实（stat），不读内容、不含任何执行语义。
 * ENOENT → missing；其他 stat 失败 → unknown（未知 ≠ 缺失）。
 * 目录条目的 sizeBytes 为 null（目录字节数无内容口径，不填 0）。
 */
function manifestReadability(root: string, file: string): ManifestReadability {
  const abs = resolve(root, file)
  // 条目可含任意用户文本：越界（绝对路径/..）不得探测根外文件的存在性与大小。
  const rel = relative(root, abs)
  const insideRoot = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  if (!insideRoot) return { status: 'unknown', sizeBytes: null }
  try {
    const st = statSync(abs)
    return { status: 'present', sizeBytes: st.isDirectory() ? null : st.size }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT') return { status: 'missing', sizeBytes: null }
    return { status: 'unknown', sizeBytes: null }
  }
}

export interface ContextManifestParseResult {
  parsed: ContextManifestParsed
  diagnostics: DocumentDiagnostic[]
}

/**
 * 逐行解析上下文清单。行号是真实 1-based 行号（空行不改编号）；
 * 坏行以诊断条目呈现并附原始行文本，不进入 entries。
 */
export function parseContextManifest(root: string, rawText: string): ContextManifestParseResult {
  const diagnostics: DocumentDiagnostic[] = []
  const entries: ManifestEntry[] = []
  const totals: ContextManifestTotals = { entries: 0, badLines: 0, blankLines: 0 }

  const lines = rawText.split(/\r?\n/)
  // 末尾换行产生的最后一个空段不是真实行
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNo = i + 1
    if (isBlankLine(line)) {
      totals.blankLines += 1
      continue
    }
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      totals.badLines += 1
      const { raw, rawTruncated } = truncateRaw(line)
      diagnostics.push({
        code: 'manifest_bad_line',
        severity: 'warning',
        message: `第 ${lineNo} 行无法解析为清单条目（原文已保留）`,
        data: { line: lineNo, raw, ...(rawTruncated ? { rawTruncated: true } : {}) }
      })
      continue
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      totals.badLines += 1
      const { raw, rawTruncated } = truncateRaw(line)
      diagnostics.push({
        code: 'manifest_bad_line',
        severity: 'warning',
        message: `第 ${lineNo} 行不是 JSON 对象，无法作为清单条目`,
        data: { line: lineNo, raw, ...(rawTruncated ? { rawTruncated: true } : {}) }
      })
      continue
    }
    const source = obj as Record<string, unknown>
    const file = typeof source.file === 'string' ? source.file : ''
    if (!file.trim()) {
      totals.badLines += 1
      const { raw, rawTruncated } = truncateRaw(line)
      diagnostics.push({
        code: 'manifest_bad_line',
        severity: 'warning',
        message: `第 ${lineNo} 行缺少 file 字段，无法作为清单条目`,
        data: { line: lineNo, raw, ...(rawTruncated ? { rawTruncated: true } : {}) }
      })
      continue
    }
    const reason = typeof source.reason === 'string' ? source.reason : null
    // type 只认显式声明；未声明为 null，未知值原样留在 extra（不默认猜测）
    const declaredType = source.type === 'file' || source.type === 'directory' ? source.type : null
    const extra: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(source)) {
      if (k === 'file' || (k === 'reason' && reason !== null) || (k === 'type' && declaredType !== null)) continue
      extra[k] = v
    }
    entries.push({
      line: lineNo,
      file,
      reason,
      type: declaredType,
      extra,
      readability: manifestReadability(root, file)
    })
  }
  totals.entries = entries.length
  return { parsed: { kind: 'context-manifest', entries, totals }, diagnostics }
}

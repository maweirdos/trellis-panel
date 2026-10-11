import { z } from 'zod'
import type { IpcFail } from './ipc-errors'

/**
 * 文档读取契约（S0 G2，design.md §5.1 documentRead 逻辑契约）。
 *
 * 语义红线（收敛决议）：
 * - 文档级事实（缺失/暂不可读/解析失败/超限/坏行）用中性或警示诊断表达，
 *   不用错误码伪装成请求失败；请求级失败（未开项目、路径越界、参数非法）才走 ipcFail。
 * - 未知 ≠ 错误：未知字段、未知条目形态原样保留，不猜测语义。
 * - revision 是内容版本标识（sha256 前 16 hex），不是完整观测摘要规则
 *   （后者在 shared/observability）；本契约不携带任何执行时间语义。
 */

/** 文档读取默认上限（design §6.2：默认 5MiB，更大文档显示限额与本机打开入口，不无界装载）。 */
export const DOCUMENT_READ_LIMIT_BYTES = 5 * 1024 * 1024

/** documentRead 的 scope。G2 阶段 workspaceId/taskRef 仅作缓存命名空间与回显；
 * 授权始终以已打开工作区（项目根）为准，绑定校验在 G3 落地。 */
export interface DocumentReadScope {
  workspaceId: string
  taskRef?: string
}

export interface DocumentReadRequest {
  /** 相对项目根的路径（正/反斜杠均可，越界拒绝）。 */
  relativePath: string
  /** 渲染层生成的请求标识，原样回显，用于竞态丢弃。 */
  requestId: string
}

export const documentReadScopeSchema = z.object({
  workspaceId: z.string().min(1),
  taskRef: z.string().min(1).optional()
})

export const documentReadRequestSchema = z.object({
  relativePath: z.string().min(1).max(2048),
  requestId: z.string().min(1).max(256)
})

/* ---------------- 诊断 ---------------- */

/**
 * neutral = 未知/空态等中性事实（中性色呈现）；
 * warning = 已知但需注意（暂不可读、超限、坏行）；
 * error = 明确损坏（解析失败）。未知不用 error 伪装。
 */
export type DocumentDiagnosticSeverity = 'neutral' | 'warning' | 'error'

export const DOCUMENT_DIAGNOSTIC_CODES = [
  /** 文件尚未创建（明确空态）。 */
  'file_missing',
  /** 有限重试后仍读不到（写入中/被锁），调用方应保留旧版本内容。 */
  'file_unreadable',
  /** 目标是目录，不是可读文档。 */
  'not_a_file',
  /** 读取期间文件在变化，重读后取得稳定版本（附尝试次数）。 */
  'read_retried',
  /** 结构化解析失败（如损坏/半写的 JSON）；原文保留，不当空对象。 */
  'parse_failed',
  /** 超过读取限额，未装载全文；附实际大小与本机打开提示数据。 */
  'document_too_large',
  /** 上下文清单（jsonl）中的坏行；附真实行号与原始行文本。 */
  'manifest_bad_line'
] as const

export type DocumentDiagnosticCode = (typeof DOCUMENT_DIAGNOSTIC_CODES)[number]

export interface DocumentDiagnostic {
  code: DocumentDiagnosticCode
  severity: DocumentDiagnosticSeverity
  /** 面向用户的中文文案（不含原始代码内容）。 */
  message: string
  /** 机器可读补充（行号、原始行文本、实际大小、限额、尝试次数等）。 */
  data?: Record<string, unknown>
}

/* ---------------- 解析结果 ---------------- */

/** task.json 常见字段的结构化视图；值仅接受字符串，其余形态原样留在 unknownFields。 */
export interface TaskJsonFields {
  id: string | null
  name: string | null
  title: string | null
  /** 原始状态字符串，不映射阶段、不推导完成链。 */
  status: string | null
  priority: string | null
  assignee: string | null
  creator: string | null
  createdAt: string | null
  completedAt: string | null
}

export interface TaskJsonParsed {
  kind: 'task-json'
  fields: TaskJsonFields
  /** 未结构化字段原样保留（含常见字段键的非字符串值）——不隐藏、不猜测语义。 */
  unknownFields: Record<string, unknown>
}

/** 清单条目在磁盘上的当前可读性事实。present 只说明文件存在，绝不代表已执行/已使用/已注入。 */
export interface ManifestReadability {
  status: 'present' | 'missing' | 'unknown'
  /** present 且为普通文件时的字节大小；目录/缺失/未知为 null，不填 0 暗示空文件。 */
  sizeBytes: number | null
}

export interface ManifestEntry {
  /** 真实 1-based 行号；空行不改编号。 */
  line: number
  /** 材料路径（清单原样字符串）。 */
  file: string
  /** 用途说明；缺失或非字符串为 null。 */
  reason: string | null
  /** 条目形态：清单显式声明 file/directory；未声明为 null（不默认猜测）。 */
  type: 'file' | 'directory' | null
  /** 清单行上未被消费的字段原样保留。 */
  extra: Record<string, unknown>
  readability: ManifestReadability
}

export interface ContextManifestTotals {
  entries: number
  badLines: number
  blankLines: number
}

/**
 * 上下文清单（implement.jsonl / check.jsonl 等）的解析结果。
 * 这是"计划里列了什么"的数据层：只有路径、用途、顺序与当前可读性，
 * 不包含任何执行时间、成功或注入语义。
 */
export interface ContextManifestParsed {
  kind: 'context-manifest'
  /** 顺序即清单书写顺序。 */
  entries: ManifestEntry[]
  totals: ContextManifestTotals
}

export type DocumentParsed = TaskJsonParsed | ContextManifestParsed

/* ---------------- 读取结果 ---------------- */

export interface DocumentSource {
  /** 归一化（正斜杠）相对项目根路径。 */
  relativePath: string
  /** realpath 后的绝对路径（文件缺失时取最近存在祖先的 realpath 拼接）。 */
  canonicalPath: string
  sizeBytes: number | null
  mtimeMs: number | null
  workspaceId: string
  taskRef: string | null
}

export interface DocumentReadSuccess {
  ok: true
  requestId: string
  /** 内容 revision（sha256 前 16 hex）；未读取（缺失/暂不可读/超限）为 null。 */
  revision: string | null
  /** 原始文本；未读取为 null。解析失败时原文保留（不丢原文）。 */
  rawText: string | null
  /** 结构化解析结果；不适用（如 .md）或解析失败为 null。 */
  parsed: DocumentParsed | null
  diagnostics: DocumentDiagnostic[]
  source: DocumentSource
}

export type DocumentReadOutcome = DocumentReadSuccess | IpcFail

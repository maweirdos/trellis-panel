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
  /** Main-owned exact version. The displayed reader retains it across later saves. */
  fixedVersion?: import('./document-windows').FixedDocumentVersion
  fixedVersionError?: string
}

export type DocumentReadOutcome = DocumentReadSuccess | IpcFail

/* ---------------- 会话级变更信号（design §5.2 按 canonicalPath+digest 定向通知） ---------------- */

export const documentWatchRequestSchema = z.object({
  relativePath: z.string().min(1).max(2048),
  /**
   * 调用方已展示的内容 revision（sha256 前 16 hex）；null = 尚无版本（缺失文件首次监听）。
   * 主进程注册时读一次磁盘：与 knownRevision 不同则立即发一条变更事件，关闭
   * 「读完成 → 注册监听」之间文件又变化的竞态窗口。
   */
  knownRevision: z.string().min(1).max(64).nullable()
})

export interface DocumentWatchSuccess {
  ok: true
  /** Opaque main-process lease. Release this exact registration, never just its path. */
  watchId: string
  /** realpath 后的绝对路径——变更定向键；不单独授予解除其他监听的权限。 */
  canonicalPath: string
  relativePath: string
}

export type DocumentWatchOutcome = DocumentWatchSuccess | IpcFail

/**
 * 主进程 → 渲染层的定向文档变更事件（只发给已注册的 canonicalPath，不广播无关文档）。
 * revision 是 settle 后读到的内容摘要；读不到（如正被删除）为 null——渲染端
 * 收到 null 仍应重读一次以呈现诚实诊断（file_missing / file_unreadable）。
 */
export interface DocumentChangedEvent {
  canonicalPath: string
  relativePath: string
  revision: string | null
}

/* ---------------- 版本比较（document:diff，design §6.2） ---------------- */

/** 每侧对比输入上限（design §6.2：初始对比每侧 2MiB；试点后可调整）。 */
export const DOCUMENT_DIFF_SIDE_LIMIT_BYTES = 2 * 1024 * 1024
/** worker 行级 diff 计算超时（毫秒）：超时终止 worker 并返回诊断，不冻结调用方。 */
export const DOCUMENT_DIFF_TIMEOUT_MS = 1000
/** 统一单列 diff 的上下文行数。 */
export const DOCUMENT_DIFF_CONTEXT_LINES = 3

/** 对比的一侧输入。文本由调用方（渲染端阅读会话）持有并传入。 */
export interface DocumentDiffSideInput {
  /** 侧文本（UTF-8 字节数不得超过 DOCUMENT_DIFF_SIDE_LIMIT_BYTES）。 */
  text: string
  /** 该文本的内容 revision（sha256 前 16 hex）；无法提供为 null。 */
  revision: string | null
}

/**
 * 基准选择（design §6.2）：
 * - text：调用方持有的文本——「与本次打开版本比较」（覆盖未提交草稿是特性，
 *   由界面文案说清基准）或「与最新候选比较」。
 * - git-latest-commit：最近提交（HEAD）中的该路径内容，由主进程 `git show` 取得；
 *   不实现任意两个历史提交选择器。
 */
export type DocumentDiffBaseline =
  | { kind: 'text'; side: DocumentDiffSideInput }
  | { kind: 'git-latest-commit' }

export interface DocumentDiffRequest {
  requestId: string
  /** 相对项目根路径（git 基线解析与诊断回显；越界拒绝）。 */
  relativePath: string
  baseline: DocumentDiffBaseline
  /** 当前展示侧（右侧）。 */
  current: DocumentDiffSideInput
}

export const documentDiffRequestSchema = z.object({
  requestId: z.string().min(1).max(256),
  relativePath: z.string().min(1).max(2048),
  baseline: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('text'),
      side: z.object({ text: z.string(), revision: z.string().nullable() })
    }),
    z.object({ kind: z.literal('git-latest-commit') })
  ]),
  current: z.object({ text: z.string(), revision: z.string().nullable() })
})

export const DOCUMENT_DIFF_DIAGNOSTIC_CODES = [
  /** 某侧输入超过每侧 2MiB 上限，未计算；附 side/sizeBytes/limitBytes 与外部打开建议数据。 */
  'diff_side_too_large',
  /** worker 计算超时，已终止并恢复；建议改为原文对比或本机打开。 */
  'diff_timeout',
  /** worker 异常退出或消息异常（非超时）。 */
  'diff_worker_error',
  /** 当前目录不是 Git 仓库——「最近提交」基线不可用（中性降级说明，非错误）。 */
  'git_no_repo',
  /** 仓库尚无任何提交。 */
  'git_no_commits',
  /** 文件未跟踪（不在索引中），无提交历史可比较。 */
  'git_untracked',
  /** 路径在最近提交中不存在（可能新增未提交或已重命名/移动）。 */
  'git_path_not_in_commit',
  /** git 不可调用（未安装或启动失败）。 */
  'git_unavailable'
] as const

export type DocumentDiffDiagnosticCode = (typeof DOCUMENT_DIFF_DIAGNOSTIC_CODES)[number]

export interface DocumentDiffDiagnostic {
  code: DocumentDiffDiagnosticCode
  severity: DocumentDiagnosticSeverity
  /** 面向用户的中文文案（不含原始内容）。 */
  message: string
  /** 机器可读补充（side、limitBytes、commit、openLocally 等）。 */
  data?: Record<string, unknown>
}

/* ---------------- diff 结果结构（统一单列） ---------------- */

export type DocumentDiffLineType = 'context' | 'added' | 'removed'

export interface DocumentDiffLine {
  type: DocumentDiffLineType
  /**
   * 纯文本行内容（worker 已剥离控制字符；本契约只承载文本行，
   * 渲染端以文本节点呈现，绝不将 diff 输出作为 HTML 注入）。
   */
  text: string
  /** 左侧（基准）行号；added 行为 null。 */
  oldLine: number | null
  /** 右侧（当前展示）行号；removed 行为 null。 */
  newLine: number | null
}

export interface DocumentDiffHunk {
  /** 1-based；hunk 首行在基准侧的行号（0 表示纯新增块无基准行）。 */
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DocumentDiffLine[]
}

export interface DocumentDiffStats {
  added: number
  removed: number
  /** 进入 hunks 的上下文行数（不是全文未变行数）。 */
  context: number
}

export interface DocumentDiffResultSide {
  /** revision；git 基线侧为对 `git show` 输出内容计算的 revision。 */
  revision: string | null
  /** 基线来源描述：provided=调用方文本；git-latest-commit=最近提交。 */
  origin: 'provided' | 'git-latest-commit'
  /** origin=git-latest-commit 时的提交完整哈希；否则 null。 */
  commit: string | null
}

export interface DocumentDiffResult {
  /** 两侧文本完全一致时为 true（hunks 为空）。 */
  identical: boolean
  hunks: DocumentDiffHunk[]
  stats: DocumentDiffStats
  left: DocumentDiffResultSide
  right: DocumentDiffResultSide
  /** 本次计算耗时（毫秒；时长度量，不是时间点）。 */
  elapsedMs: number
}

export interface DocumentDiffSuccess {
  ok: true
  requestId: string
  /** null = 无法计算（超限/超时/Git 基线不可用），原因见 diagnostics（降级说明）。 */
  diff: DocumentDiffResult | null
  diagnostics: DocumentDiffDiagnostic[]
}

export type DocumentDiffOutcome = DocumentDiffSuccess | IpcFail

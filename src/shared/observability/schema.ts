import { z } from 'zod'

/**
 * 上下文观测事件契约 v1（design.md §3.2）。
 *
 * 权威语义：
 * - `context.assembled`：宿主 Hook 完成读取与组装（并不证明输出）。
 * - `context.emitted`：宿主协议输出对象序列化完成且 stdout write+flush 成功之后记录。
 * - `context.output_failed`：序列化或输出确实报错时尽力记录；不重发 stdout。
 * 时间一律 Unix 毫秒整数（shared/timestamp.md）；digest 一律完整 SHA-256 hex，
 * UI 层才允许缩写。未知字段保留（passthrough）；主版本不认识时不得按旧格式解释。
 */

export const OBSERVABILITY_SCHEMA_VERSION = 1 as const

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'expected full SHA-256 hex')

/** UUID（任何版本变体）；重复内容靠 payloadDigest 核对，不靠 eventId 格式。 */
const uuid = z.string().min(1)

export const materialOutcomeSchema = z.enum([
  'included',
  'truncated',
  'index_only',
  'missing',
  'unreadable'
])

export const materialResultSchema = z.object({
  /** 相对路径或可解释的逻辑来源别名；禁止绝对路径（不向共享面泄露本机路径）。 */
  source: z.string().min(1),
  /** 来源类型：file=仓库文件，inline=直接拼接的 workflow/prompt 段，other=无法归类。 */
  origin: z.enum(['file', 'inline', 'other']),
  outcome: materialOutcomeSchema,
  /** 结果原因（binary / budget / not_found / read_failed 等），未知为 null。 */
  reason: z.string().nullable(),
  /** 源文件当次已读取的字节与摘要；未读取/不适用为 null，不得填 0 暗示空文件。 */
  sourceBytes: z.number().int().nonnegative().nullable(),
  sourceDigest: sha256Hex.nullable(),
  /** 实际纳入输出的源文本片段（UTF-8）字节数与摘要；标题/提示文案不计入。 */
  includedBytes: z.number().int().nonnegative().nullable(),
  includedDigest: sha256Hex.nullable()
}).passthrough()

export const contextEventV1Schema = z.object({
  schemaVersion: z.literal(1),
  eventId: uuid,
  /** 同一次注入的组装/输出事件共用 injectionId。 */
  injectionId: uuid,
  kind: z.enum(['context.assembled', 'context.emitted', 'context.output_failed']),
  occurredAtMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  producer: z.object({
    host: z.string().min(1),
    hook: z.string().min(1),
    version: z.string().min(1),
    capability: z.string().min(1)
  }).passthrough(),
  scope: z.object({
    repositoryId: z.string().min(1),
    workspaceId: z.string().min(1),
    taskRef: z.string().nullable(),
    trellisTaskId: z.string().nullable(),
    taskPath: z.string().nullable(),
    association: z.enum(['resolved', 'unresolved'])
  }).passthrough(),
  /** 仅填宿主实际提供的值；不可得为 null，不制造看似真实的 ID。 */
  session: z.object({
    parentId: z.string().nullable(),
    childId: z.string().nullable(),
    runId: z.string().nullable()
  }).passthrough(),
  materials: z.array(materialResultSchema),
  totals: z.object({
    /** 预期材料条数未知时为 null；此时不得计算缺失率。 */
    expectedEntries: z.number().int().nonnegative().nullable(),
    recordedEntries: z.number().int().nonnegative(),
    omittedEntries: z.number().int().nonnegative(),
    /** 组装后上下文全量 UTF-8 字节（含标题/提示文案）。 */
    contextUtf8Bytes: z.number().int().nonnegative(),
    /** 宿主协议包装整体 stdout UTF-8 字节；仅最终序列化后可得。 */
    stdoutUtf8Bytes: z.number().int().nonnegative().nullable(),
    budgetBytes: z.number().int().nonnegative().nullable(),
    completeness: z.enum(['complete', 'partial', 'not_applicable'])
  }).passthrough(),
  /** 实际输出上下文字段的完整 SHA-256；assembled 阶段可为 null。 */
  outputDigest: sha256Hex.nullable(),
  diagnosticCode: z.string().nullable()
}).passthrough()

export type MaterialOutcome = z.infer<typeof materialOutcomeSchema>
export type MaterialResult = z.infer<typeof materialResultSchema>
export type ContextEventV1 = z.infer<typeof contextEventV1Schema>

export type ParseEventResult =
  | { success: true; event: ContextEventV1 }
  | { success: false; reason: 'unsupported_schema_version'; found: unknown }
  | { success: false; reason: 'malformed'; issues: string[] }

/**
 * 解析外部（Hook 产出）事件：先验主版本再验结构。
 * 主版本不认识 → unsupported（进入有界诊断，不按旧格式硬解释）。
 */
export function parseContextEvent(raw: unknown): ParseEventResult {
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'schemaVersion' in raw &&
    (raw as { schemaVersion?: unknown }).schemaVersion !== OBSERVABILITY_SCHEMA_VERSION
  ) {
    return {
      success: false,
      reason: 'unsupported_schema_version',
      found: (raw as { schemaVersion?: unknown }).schemaVersion
    }
  }
  const parsed = contextEventV1Schema.safeParse(raw)
  if (parsed.success === true) {
    return { success: true, event: parsed.data }
  }
  return {
    success: false,
    reason: 'malformed',
    issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
  }
}

import type { MaterialOutcome, MaterialResult } from './schema'
import type { ObservationItem } from './store'

/**
 * 回执投影（S0 G3 第二片，design §3.3/§5.1；纯函数，无 Electron/IO 依赖）：
 * 事件流（按 injectionId 分组）→ 回执视图模型。
 *
 * 语义红线（design §3.3 / PRD FR2）：
 * - assembled+emitted 配对；**只有 emitted 也是完整证据**（前一条 assembled 丢失
 *   不使其消失）；只有 assembled → 证据到「已组装」；两者皆无 → 未观察到。
 * - output_failed 是「输出失败事实」：与 assembled 并存时按输出失败呈现。
 * - 措辞上限：**已输出至宿主通道**；禁止「已注入模型 / 已遵守」。
 * - 清单 partial/遗漏数透出；预期数量未知（expectedEntries=null）不计算缺失率。
 * - 材料当时摘要与当前文件的对比由调用方给出 currentDigests；
 *   不可比 → 'unverifiable'（无法核对），不用现在的文件冒充当时内容。
 * - 时间一律事件自带的 Unix 毫秒；本模块不格式化时间。
 */

export type ReceiptEvidenceLevel = 'emitted' | 'assembled' | 'output_failed'

export type ReceiptMaterialCurrency = 'not_checked' | 'same' | 'changed' | 'unverifiable'

export interface ReceiptMaterialView {
  /** 相对路径或逻辑来源别名（契约禁止绝对路径；此处原样透传）。 */
  source: string
  origin: MaterialResult['origin']
  outcome: MaterialOutcome
  reason: string | null
  sourceBytes: number | null
  sourceDigest: string | null
  includedBytes: number | null
  /** 与当前文件的核对结果（默认未核对）。 */
  currency: ReceiptMaterialCurrency
}

export interface ReceiptTotalsView {
  expectedEntries: number | null
  recordedEntries: number
  omittedEntries: number
  contextUtf8Bytes: number
  stdoutUtf8Bytes: number | null
  budgetBytes: number | null
  completeness: 'complete' | 'partial' | 'not_applicable'
}

export interface ReceiptView {
  injectionId: string
  /** 证据等级（emitted=已输出至宿主通道；assembled=已组装；output_failed=输出失败）。 */
  level: ReceiptEvidenceLevel
  /** assembled 与 emitted 均在（完整配对）。 */
  paired: boolean
  assembledAtMs: number | null
  emittedAtMs: number | null
  /** 本组最新事件的 occurredAtMs（排序键）。 */
  occurredAtMs: number
  /** 本组最大 seq（投影幂等/调试用）。 */
  lastSeq: number
  host: string
  hook: string
  producerVersion: string
  session: { parentId: string | null; childId: string | null; runId: string | null }
  association: 'resolved' | 'unresolved'
  taskRef: string | null
  /** 明细可能被 64KiB 预算删减：此时 materials 为空但遗漏数在 totals。 */
  materials: ReceiptMaterialView[]
  totals: ReceiptTotalsView
  /** completeness=partial 或 omittedEntries>0。 */
  manifestIncomplete: boolean
  outputDigest: string | null
  diagnosticCode: string | null
}

export interface ReceiptProjectionResult {
  /** 新的在前（occurredAtMs 降序，同刻按 seq）。 */
  receipts: ReceiptView[]
  /** 输入无任何事件（≠故障；无记录默认「未观察到」）。 */
  unobserved: boolean
  totalEvents: number
}

/** 汇总口径事件：emitted（最终输出）> assembled（组装口径）> output_failed。 */
function pickTotalsEvent(group: ObservationItem[]): ObservationItem | null {
  const lastOf = (kind: string): ObservationItem | undefined =>
    group.filter((it) => it.event.kind === kind).slice(-1)[0]
  return lastOf('context.emitted') ?? lastOf('context.assembled') ?? lastOf('context.output_failed') ?? null
}

/** 明细来源事件：emitted 明细被编码预算删减时回退 assembled（遗漏数仍在汇总里）。 */
function pickDetailEvent(group: ObservationItem[]): ObservationItem | null {
  const emitted = group.find((it) => it.event.kind === 'context.emitted' && it.event.materials.length > 0)
  if (emitted !== undefined) return emitted
  const assembled = group.find((it) => it.event.kind === 'context.assembled' && it.event.materials.length > 0)
  if (assembled !== undefined) return assembled
  return pickTotalsEvent(group)
}

function currencyOf(material: MaterialResult, currentDigests: Readonly<Record<string, string | null>> | undefined): ReceiptMaterialCurrency {
  if (currentDigests === undefined || !(material.source in currentDigests)) return 'not_checked'
  if (material.sourceDigest === null) return 'unverifiable'
  const current = currentDigests[material.source]
  if (current === null || current === undefined || current.length === 0) return 'unverifiable'
  // documents 层 revision 为 sha256 前 16 hex、材料 sourceDigest 为完整 64 hex：
  // 按可比前缀对比（同源摘要算法），不做内容重读。
  const len = Math.min(current.length, material.sourceDigest.length)
  return current.slice(0, len) === material.sourceDigest.slice(0, len) ? 'same' : 'changed'
}

/**
 * 事件流 → 回执视图（纯函数）。
 * @param items 已按 eventId 去重的事件（订阅端去重；本函数对重复 eventId 再兜底一次）
 * @param currentDigests 材料源 → 当前摘要（string=可比对；null=当前不可比/无法核对）
 */
export function projectReceipts(
  items: readonly ObservationItem[],
  currentDigests?: Readonly<Record<string, string | null>>
): ReceiptProjectionResult {
  const deduped = new Map<string, ObservationItem>()
  for (const item of items) {
    const existing = deduped.get(item.eventId)
    if (existing === undefined || item.seq > existing.seq) deduped.set(item.eventId, item)
  }
  const groups = new Map<string, ObservationItem[]>()
  let lastSeq = 0
  for (const item of deduped.values()) {
    const list = groups.get(item.injectionId)
    if (list === undefined) groups.set(item.injectionId, [item])
    else list.push(item)
    if (item.seq > lastSeq) lastSeq = item.seq
  }

  const receipts: ReceiptView[] = []
  for (const [injectionId, group] of groups) {
    const hasAssembled = group.some((it) => it.event.kind === 'context.assembled')
    const hasEmitted = group.some((it) => it.event.kind === 'context.emitted')
    const hasFailed = group.some((it) => it.event.kind === 'context.output_failed')
    // emitted 是完整证据：assembled 缺席不降级；output_failed 是输出失败事实（优先于 assembled 呈现）
    // 无 emitted/failed/assembled（如未来新增 kind）→ 按已组装呈现，不假装未观察到已有事件
    const level: ReceiptEvidenceLevel = hasEmitted ? 'emitted' : hasFailed ? 'output_failed' : 'assembled'
    const detail = pickDetailEvent(group)
    const totalsSource = pickTotalsEvent(group)
    const totalsEvent = (totalsSource ?? group[0]).event
    const materials: ReceiptMaterialView[] = (detail?.event.materials ?? []).map((m) => ({
      source: m.source,
      origin: m.origin,
      outcome: m.outcome,
      reason: m.reason,
      sourceBytes: m.sourceBytes,
      sourceDigest: m.sourceDigest,
      includedBytes: m.includedBytes,
      currency: currencyOf(m, currentDigests)
    }))
    const occurredAtMs = group.reduce((max, it) => Math.max(max, it.occurredAtMs), 0)
    const producer = totalsEvent.producer
    receipts.push({
      injectionId,
      level,
      paired: hasAssembled && hasEmitted,
      assembledAtMs: group.find((it) => it.event.kind === 'context.assembled')?.occurredAtMs ?? null,
      emittedAtMs: group.find((it) => it.event.kind === 'context.emitted')?.occurredAtMs ?? null,
      occurredAtMs,
      lastSeq: group.reduce((max, it) => Math.max(max, it.seq), 0),
      host: producer.host,
      hook: producer.hook,
      producerVersion: producer.version,
      session: {
        parentId: totalsEvent.session.parentId,
        childId: totalsEvent.session.childId,
        runId: totalsEvent.session.runId
      },
      association: totalsEvent.scope.association,
      taskRef: totalsEvent.scope.taskRef,
      materials,
      totals: {
        expectedEntries: totalsEvent.totals.expectedEntries,
        recordedEntries: totalsEvent.totals.recordedEntries,
        omittedEntries: totalsEvent.totals.omittedEntries,
        contextUtf8Bytes: totalsEvent.totals.contextUtf8Bytes,
        stdoutUtf8Bytes: totalsEvent.totals.stdoutUtf8Bytes,
        budgetBytes: totalsEvent.totals.budgetBytes,
        completeness: totalsEvent.totals.completeness
      },
      manifestIncomplete: totalsEvent.totals.completeness === 'partial' || totalsEvent.totals.omittedEntries > 0,
      outputDigest: totalsEvent.outputDigest,
      diagnosticCode: totalsEvent.diagnosticCode
    })
  }

  receipts.sort((a, b) => b.occurredAtMs - a.occurredAtMs || b.lastSeq - a.lastSeq)
  return { receipts, unobserved: receipts.length === 0, totalEvents: deduped.size }
}

/* ---------------- 证据措辞（design §3.3 UI 词汇） ---------------- */

export type EvidenceTone = 'l0' | 'l1' | 'l2' | 'fail'

export interface EvidenceWording {
  label: string
  tone: EvidenceTone
  /** 补充说明（普通话；不要求员工学习 L0/L1/L2 编号）。 */
  hint: string
}

const EVIDENCE_WORDING: Record<ReceiptEvidenceLevel, EvidenceWording> = {
  emitted: {
    label: '已输出至宿主通道',
    tone: 'l2',
    hint: '尚无宿主接收确认；不表示模型已注入或规范已遵守'
  },
  assembled: {
    label: '已组装',
    tone: 'l1',
    hint: '已读取并组装上下文；尚无成功输出到宿主通道的证据'
  },
  output_failed: {
    label: '输出失败',
    tone: 'fail',
    hint: '输出环节报告了失败（宿主原有失败语义保留，未重发输出）'
  }
}

export const EVIDENCE_UNOBSERVED: EvidenceWording = {
  label: '未观察到',
  tone: 'l0',
  hint: '没有本次注入的观测记录；未观察到 ≠ 故障'
}

export function evidenceWording(level: ReceiptEvidenceLevel): EvidenceWording {
  return EVIDENCE_WORDING[level]
}

export const MATERIAL_OUTCOME_LABELS: Record<MaterialOutcome, string> = {
  included: '完整纳入',
  truncated: '已截断',
  index_only: '仅索引',
  missing: '缺失',
  unreadable: '不可读'
}

export const MATERIAL_CURRENCY_LABELS: Record<ReceiptMaterialCurrency, string> = {
  not_checked: '',
  same: '与当前文件一致',
  changed: '当前文件与当时记录不同',
  unverifiable: '无法核对'
}

/** UI 缩写摘要（契约：完整 SHA-256 只在 UI 边界缩写）。 */
export function shortDigest(digest: string | null): string | null {
  return digest === null ? null : digest.slice(0, 8)
}

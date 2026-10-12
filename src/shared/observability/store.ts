import { z } from 'zod'
import type { ContextEventV1 } from './schema'

/**
 * 观测存储读取/订阅契约（design §5.1，S0 G3 第一片）。
 *
 * 语义红线：
 * - `resetRequired=true` 表示调用方持有的 cursor 已失效（清理/重建换了 storeEpoch），
 *   必须重新全量拉取，不默默跳过；这不是错误，用数据字段表达而非 ipcFail。
 * - health 描述存储事实（active/paused/corrupted/…），未知 ≠ 故障；渲染端按状态
 *   呈现，不把 paused 当损坏。
 * - 时间一律 Unix 毫秒（shared/timestamp.md）；seq 是本库单调序号，只做游标，
 *   不表达跨进程因果顺序。
 */

/** 单事件编码上限（design §4.3 初值）：超限删减明细标 partial；汇总仍超限跳过并记诊断。 */
export const OBSERVATION_EVENT_ENCODE_LIMIT_BYTES = 64 * 1024
/** 保留：14 天 / 50,000 条 / 64MiB payload（design §4.3 初值，可被测量修订）。 */
export const OBSERVATION_RETENTION_DAYS = 14
export const OBSERVATION_RETENTION_MAX_EVENTS = 50_000
export const OBSERVATION_RETENTION_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024
/** 库＋sidecar 物理体积软保护阈值（只 stat 固定文件；超限不写新观测）。 */
export const OBSERVATION_PHYSICAL_SOFT_LIMIT_BYTES = 128 * 1024 * 1024
/** 观测诊断总量上限（有界轮换，保留最近摘要与计数）。 */
export const OBSERVATION_DIAGNOSTICS_LIMIT_BYTES = 1024 * 1024
/** query 每页最大条数（design §5.1）。 */
export const OBSERVATION_QUERY_PAGE_MAX = 100

/* ---------------- scope / cursor ---------------- */

export const observationScopeSchema = z.object({
  workspaceId: z.string().min(1).max(256),
  taskRef: z.string().min(1).max(256).optional()
})

export type ObservationScope = z.infer<typeof observationScopeSchema>

export const observationCursorSchema = z.object({
  storeEpoch: z.string().min(1).max(128),
  seq: z.number().int().nonnegative()
})

export type ObservationCursor = z.infer<typeof observationCursorSchema>

/* ---------------- query ---------------- */

export const observationQueryRequestSchema = z.object({
  after: z.number().int().nonnegative().optional(),
  before: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(OBSERVATION_QUERY_PAGE_MAX),
  /**
   * 调用方持有 cursor 的 epoch（来自上次 nextCursor/snapshotCursor）：
   * 与当前库 storeEpoch 不符 → resetRequired=true（需全量重拉，不默默跳过）。
   * 不属于分页参数，只做 cursor 有效性核对。
   */
  cursorEpoch: z.string().min(1).max(128).optional()
})

export type ObservationQueryRequest = z.infer<typeof observationQueryRequestSchema>

/** 查询单项：存储行事实 + 已解析事件（payload 由本库写入时校验过；读出仅 JSON.parse）。 */
export interface ObservationItem {
  seq: number
  eventId: string
  injectionId: string
  kind: string
  occurredAtMs: number
  receivedAtMs: number
  event: ContextEventV1
}

/** 采集/存储健康事实（不含绝对路径等本机敏感信息）。 */
export interface ObservationHealth {
  /** active=正常采集；paused=按原因暂停（未知≠故障）；corrupted=库损坏停写（保留原文件待重建）；future_version=库版本高于当前程序（禁止降级写入）；closed=连接未打开。 */
  state: 'active' | 'paused' | 'corrupted' | 'future_version' | 'closed' | 'not_initialized'
  pauseReason: string | null
  dbVersion: number | null
  /** 当前库纪元；清理/重建后更换，旧 cursor 因此 resetRequired。 */
  storeEpoch: string | null
  logicalCount: number
  logicalPayloadBytes: number
  /** 库＋sidecar 物理字节（软保护口径，非精确配额）。 */
  physicalBytes: number
  controlState: 'active' | 'corrupted' | 'future_version' | 'closed' | 'not_initialized'
}

export interface ObservationQuerySuccess {
  ok: true
  items: ObservationItem[]
  /** 当前最大 seq（订阅快照回补基准）。 */
  highWatermark: number
  /** 取下一页用的 cursor（epoch=当前 storeEpoch）；items 为空时等于 after/0。 */
  nextCursor: ObservationCursor
  /** 当前保留的最老事件 occurredAtMs（判断时间窗口下界）；无事件为 null。 */
  retainedFrom: number | null
  /** 调用方 cursor 的 epoch ≠ 当前库 epoch（或库刚重建）→ 需全量重拉。 */
  resetRequired: boolean
  health: ObservationHealth
}

/* ---------------- 订阅（快照回补后增量） ---------------- */

export interface ObservationSubscriptionOptions {
  /** 已持有的 cursor（首次可不带 → 从当前 highWatermark 起回补至最新）。 */
  afterCursor?: ObservationCursor
  /**
   * 订阅轮询间隔请求（S0 G3 第二片，design §5.2）：可见 1s / 后台 5s。
   * 服务端夹取 [1000, 5000]；冒烟环境变量覆盖优先。
   */
  pollMs?: number
}

/** 推给订阅者的增量/复位事件（主进程 → 渲染层，eventId 去重由发送侧保证不重叠）。 */
export type ObservationSubscriptionEvent =
  | {
      type: 'events'
      items: ObservationItem[]
      cursor: ObservationCursor
      health: ObservationHealth
    }
  | {
      /** cursor 失效（清理/重建换 epoch）：订阅端必须重新全量拉取，不默默跳过。 */
      type: 'reset'
      reason: 'epoch_changed' | 'store_unavailable'
      health: ObservationHealth
    }

export interface ObservationSubscribeResult {
  ok: true
  subscriptionId: string
  /** 订阅建立时的快照基准（渲染端可先 query 回补到该水位再收增量）。 */
  snapshotCursor: ObservationCursor
}

/* ---------------- 健康与治理（S0 G3 第二片：设置/面板的状态显示与开关） ---------------- */

/** 当前项目观测绑定状态（不含绝对路径；workspaceId 为绑定内 UUID，非本机路径）。 */
export interface ObservationBindingStatus {
  workspaceId: string | null
  repositoryId: string | null
  /** null = 未绑定（无从谈启用）。 */
  collectionEnabled: boolean | null
  bindingStatus: 'bound' | 'rebind_required' | 'not_bound'
  blockReason: string | null
}

export interface ObservationStatusResult {
  ok: true
  health: ObservationHealth
  binding: ObservationBindingStatus
}

export type ObservationHealthTone = 'ok' | 'neutral' | 'warn' | 'error'

export interface ObservationHealthView {
  label: string
  tone: ObservationHealthTone
  detail: string | null
}

const PAUSE_REASON_LABELS: Record<string, string> = {
  collection_disabled: '采集已禁用（可随时重新启用）',
  quota_retention: '达到保留配额，暂停新增记录（清理后恢复）',
  physical_limit: '观测库体积达到软保护阈值，暂停新增',
  store_corrupted: '观测库损坏，已停止写入（原文件保留）',
  future_version: '观测库来自更新版本，本程序只读不写',
  store_unavailable: '观测存储暂不可用',
  installation_missing: '安装身份缺失，需重新绑定确认',
  installation_mismatch: '安装身份不符，需重新绑定确认',
  root_mismatch: '项目根与绑定不符，需确认迁移',
  binding_mismatch: '绑定校验未通过'
}

/**
 * 健康事实 → 展示口径（纯函数；未知 ≠ 故障）：
 * 未初始化/关闭/禁用是中性事实，不标失败；只有明确损坏才是错误态。
 */
export function observationHealthView(health: ObservationHealth): ObservationHealthView {
  const reason = health.pauseReason
  switch (health.state) {
    case 'active':
      return { label: '采集中', tone: 'ok', detail: null }
    case 'paused': {
      const known = reason !== null ? PAUSE_REASON_LABELS[reason] : undefined
      // 配额/体积类暂停是可恢复的存储事实 → 提示级；禁用/门禁 → 中性
      const tone = reason === 'collection_disabled' || reason === 'installation_missing' || reason === 'installation_mismatch' || reason === 'root_mismatch' ? 'neutral' : 'warn'
      return { label: '已暂停', tone, detail: known ?? (reason !== null ? `暂停原因：${reason}` : null) }
    }
    case 'corrupted':
      return { label: '存储异常', tone: 'error', detail: '观测库损坏：已停止写入并保留原文件，可由用户选择重建' }
    case 'future_version':
      return { label: '版本不兼容', tone: 'warn', detail: PAUSE_REASON_LABELS.future_version }
    case 'closed':
      return { label: '未连接', tone: 'neutral', detail: '观测库连接未打开（读取按未初始化口径呈现）' }
    case 'not_initialized':
    default:
      return { label: '未初始化', tone: 'neutral', detail: '尚未绑定工作区或未打开观测库；未观察到 ≠ 故障' }
  }
}

/* ---------------- 写入口径（insert 结果，供回执投影消费；也用于冒烟） ---------------- */

export type ObservationInsertOutcome =
  | { status: 'inserted'; seq: number; eventId: string; trimmed: boolean; omittedMaterials: number }
  /** 同 eventId＋同 digest：幂等命中已有行，不重复计数。 */
  | { status: 'duplicate'; seq: number; eventId: string }
  /** 同 eventId 异 digest：保留冲突诊断，不覆盖。 */
  | { status: 'conflict'; eventId: string }
  /** 被配额/物理保护/绑定不符/损坏等暂停：未落账，不得显示已持久化。 */
  | { status: 'rejected'; reason: string; diagnosticCode: string | null }
  /** 事件结构非法或主版本不支持：跳过并记有界诊断（缺证据≠故障）。 */
  | { status: 'invalid'; reason: string }

import { z } from 'zod'

/**
 * LocalTaskService 类型与输入契约（S0 G4 第一片，design §7.2）。
 *
 * 语义红线：
 * - 未创建≠失败、超时≠成功；时间一律 Unix 毫秒。
 * - --meta 只承载扁平字符串恢复标识（panel_* 键），完整描述不走命令行。
 * - 描述是业务数据：进 PRD 原文呈现，绝不当作指令执行。
 * - 本目录模块不 import electron（冒烟可直接 esbuild 打包驱动）。
 */

/** 操作阶段（design §7.2 步骤链 + 恢复可见态）。 */
export const LOCAL_TASK_STAGES = [
  'registered', // 控制库操作记录已提交（预备目录 + 来源快照）；CLI 未调用
  'cli_created', // task.py create --no-start 成功且目录已核实（含 panel_* meta）
  'prd_written', // 最小 PRD 来源草稿已原子写入（用户已改则跳过并留 note）
  'linked', // source_links 关联 + task_aliases 登记
  'ready', // 最终验证通过
  'failed', // 上次尝试失败（可恢复重试；原因在 payload.error）
  'conflict', // 需用户确认的冲突（同名不同 operationId / 多候选目录等；保持可见）
  'missing' // 曾 ready/linked 但真实目录消失（不自动重建，保持可见）
] as const
export type LocalTaskStage = (typeof LOCAL_TASK_STAGES)[number]

/** 可续跑（对账后允许继续推进或重建）的阶段。 */
export const RESUMABLE_STAGES: readonly LocalTaskStage[] = ['registered', 'cli_created', 'prd_written', 'linked', 'failed']
/** 已产生真实任务目录的阶段。 */
export const CREATED_STAGES: readonly LocalTaskStage[] = ['cli_created', 'prd_written', 'linked', 'ready']

/** --meta 扁平恢复标识键（design §7.2：值原样字符串，不嵌套不 JSON）。 */
export const META_OPERATION_ID = 'panel_operation_id'
export const META_JIRA_INSTANCE_ID = 'panel_jira_instance_id'
export const META_JIRA_ISSUE_ID = 'panel_jira_issue_id'
export const META_JIRA_ISSUE_KEY = 'panel_jira_issue_key'
export const META_SOURCE_UPDATED_AT_MS = 'panel_source_updated_at_ms'

export const createFromJiraInputSchema = z.object({
  /** 项目根（canonical root；IPC 层取当前项目）。 */
  root: z.string().min(1),
  /** Jira 实例稳定 ID（jiraInstanceIdFor(baseUrl, user)）。 */
  instanceId: z.string().min(1).max(128),
  issueKey: z.string().min(1).max(64),
  /** 数字稳定 issue id；缺失时回退 issueKey 防重。 */
  issueId: z.number().int().safe().positive().nullable().optional(),
  title: z.string().min(1).max(500),
  /** 短描述（CLI --description；完整描述走 PRD，不进命令行）。 */
  summaryDescription: z.string().max(4000).default(''),
  /** Jira 完整描述（业务数据 → PRD 原文）；未取得为 null（PRD 明示，不静默摘要替代）。 */
  description: z.string().nullable().optional(),
  url: z.string().max(2000).default(''),
  /** 从 Jira updated 显式解析的 Unix 毫秒；非法/缺失为 null（meta 相应缺省）。 */
  updatedAtMs: z.number().int().safe().positive().nullable().optional(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).default('P2'),
  assignee: z.string().max(200).default(''),
  /** 显式 slug（默认由 issueKey+title 派生）。 */
  slug: z.string().max(64).optional(),
  /** 显式「一单多任务」：产生新增序号；缺省重复点击=打开已有任务。 */
  allowAdditional: z.boolean().default(false),
  fetchedAtMs: z.number().int().safe().positive().optional()
})
export type CreateFromJiraInput = z.infer<typeof createFromJiraInputSchema>

/** 操作键（design §7.2：workspaceId＋instanceId＋issueId＋显式新增序号）。 */
export interface LocalOperationKey {
  workspaceId: string
  instanceId: string
  /** 数字 issueId 优先；缺失回退 'key:<KEY>'。 */
  issueIdentifier: string
  ordinal: number
}

/** 来源快照（控制库记录；描述只存摘要与摘要哈希，全文进 PRD）。 */
export interface LocalOperationSource {
  issueKey: string
  issueId: number | null
  instanceId: string
  url: string
  updatedAtMs: number | null
  fetchedAtMs: number
  title: string
  summaryDescription: string
  descriptionBytes: number | null
  descriptionSha256: string | null
  truncated: boolean
}

/** local_operations.payloadJson 结构。 */
export interface LocalOperationPayload {
  operationKey: LocalOperationKey
  slug: string
  /** 预备目录（.trellis/tasks 下相对目录名，含 MM-DD 前缀；跨日恢复时原子更新）。 */
  prepDir: string
  /** 核实后的最终实际目录（仓库相对，正斜杠）；未创建为 null。 */
  finalDir: string | null
  source: LocalOperationSource
  /** CLI 创建后 prd.md 的基线哈希（用户改动的判定依据）。 */
  prdBaselineSha256: string | null
  stageDetail?: string
  error?: string
  attempts: number
}

export interface LocalOperationRow {
  operationId: string
  workspaceId: string
  stage: LocalTaskStage
  payload: LocalOperationPayload
  createdAtMs: number
  updatedAtMs: number
}

export type CreateOrOpenFailureCode =
  | 'invalid' // 输入非法
  | 'control_store' // 控制库不可用/提交失败——不产生任何创建副作用
  | 'cli_failed' // task.py create 失败（含被拒；无 --force）
  | 'conflict' // 需用户确认（同名不同 operationId、多候选目录、ready 后目录消失等）
  | 'interrupted' // 冒烟注入的模拟中断（生产不会出现）
  | 'internal' // 未预期的内部错误（已脱敏；目录/记录保持可对账状态）

export type CreateOrOpenResult =
  | {
      ok: true
      /** 任务目录名（basename；与面板 dirName 语义一致）。 */
      dirName: string
      created: boolean
      /** 打开的是已有任务（重复点击默认行为）。 */
      already: boolean
      operationId: string
      stage: LocalTaskStage
      notes: string[]
      /** 已归档任务被打开时为 true。 */
      archived: boolean
    }
  | { ok: false; code: CreateOrOpenFailureCode; error: string; operationId?: string }

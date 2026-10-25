import { z } from 'zod'

export const ACP_CONNECTION_STAGES = ['backend-process', 'storage-ready', 'account-sync', 'session-create-or-resume', 'subscribe'] as const
const duration = z.number().int().nonnegative().max(600_000)
const stage = z.object({ stage: z.enum(ACP_CONNECTION_STAGES), status: z.enum(['completed', 'failed', 'skipped']), durationMs: duration.optional() })
  .refine((value) => value.status === 'skipped' ? value.durationMs === undefined : value.durationMs !== undefined)

/** Only measured non-secret fields cross the adapter diagnostics boundary. */
export const acpConnectionTimingsSchema = z.object({
  version: z.literal(1), operation: z.enum(['new', 'load']), status: z.enum(['completed', 'failed']),
  backendReused: z.boolean(), totalDurationMs: duration, stages: z.array(stage).length(ACP_CONNECTION_STAGES.length)
}).refine((value) => value.stages.every((entry, index) => entry.stage === ACP_CONNECTION_STAGES[index]
  && (entry.durationMs === undefined || entry.durationMs <= value.totalDurationMs + 2)))
export type AcpConnectionTimings = z.infer<typeof acpConnectionTimingsSchema>

export const ACP_CONNECTION_STAGE_LABELS: Record<typeof ACP_CONNECTION_STAGES[number], string> = {
  'backend-process': 'ZCode 进程启动', 'storage-ready': '存储就绪', 'account-sync': '账户状态同步',
  'session-create-or-resume': '原生会话准备', subscribe: '事件订阅'
}

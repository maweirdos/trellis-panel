import { z } from 'zod'
import { modelSelectionIdSchema } from '../model-selection'
import { conversationModelOptionsSchema } from './command-runtime'
import type { ConversationDriverDescriptor } from './driverCatalog'

export const taskPlanningRuntimeSelection = z.object({
  instanceId: z.string().min(1).max(64).regex(/^[\w.-]+$/),
  modelId: modelSelectionIdSchema,
  options: conversationModelOptionsSchema.optional(),
}).strict()

const original = z.object({
  planningId: z.string().uuid(),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  commandId: z.string().uuid(),
}).strict()

export const taskPlanningRuntimeBodies = {
  'runtime.taskPlanningCatalog': z.object({
    instanceId: taskPlanningRuntimeSelection.shape.instanceId.optional(),
    purpose: z.literal('execution').optional(),
  }).strict(),
  'runtime.taskPlanningLaunch': original,
  'runtime.taskPlanningObserve': original,
  'runtime.taskPlanningStop': original.extend({ stopCommandId: z.string().uuid() }).strict(),
} as const

export type TaskPlanningRuntimeIdentity = z.infer<typeof original>
export type TaskPlanningRuntimeSelection = z.infer<typeof taskPlanningRuntimeSelection>
export type TaskPlanningRuntimeCatalogRequest = z.infer<typeof taskPlanningRuntimeBodies['runtime.taskPlanningCatalog']>
export type TaskPlanningRuntimeCatalog = {
  readonly drivers: ReadonlyArray<{ readonly instanceId: string; readonly driverKind: string }>
  readonly descriptor?: ConversationDriverDescriptor
  readonly purpose?: 'execution'
}

export interface TaskPlanningRuntimeObservation {
  readonly threadId: string | null
  readonly runId: string | null
  readonly state: 'unrecorded' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'unknown'
  readonly finalText?: string
  readonly detail?: string
  readonly cleanupConfirmed: boolean
}

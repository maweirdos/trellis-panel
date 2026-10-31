import { z } from 'zod'
import type { ChildProcess } from 'node:child_process'
import type { ApplicationConfig, ApplicationFailure, ApplicationLaunchPreview, ApplicationPortState, ApplicationReadinessState, ApplicationRun, ApplicationProcessState, ApplicationEnvironmentCheck, ApplicationTaskServiceUse, ApplicationRunSnapshot, ApplicationSummary } from '../../../shared/app-runtime'
import { applicationConfigSchema, applicationPortSchema, applicationReadinessSchema, applicationRunSnapshotSchema, applicationTaskServiceUseSchema } from '../../../shared/app-runtime'
import { IpcErrorCode, ipcFail } from '../../../shared/ipc-errors'
import { workcopyLeaseSchema, workcopyOwnerSchema } from '../../../shared/workcopy-use'
import type { AcpJobOwner } from '../workcopy-use/acp-jobs'
import { DaemonError } from '../../daemon/errors'

export const processIdentitySchema = z.object({ pid: z.number().int().positive(), parentPid: z.number().int().nonnegative(), createdAt: z.string(), executable: z.string().nullable(), commandHash: z.string() })
export type ProcessIdentity = z.infer<typeof processIdentitySchema>
export const runPolicySchema = z.object({ ports: z.array(applicationPortSchema).max(16), readiness: applicationReadinessSchema, stopTimeoutMs: z.number().int().min(1000).max(60000) })
export type RunPolicy = z.infer<typeof runPolicySchema>
export const applicationWorkcopyUseSchema = z.object({ root: z.string().min(1).max(4096), lease: workcopyLeaseSchema }).strict()
export type ApplicationWorkcopyUse = z.infer<typeof applicationWorkcopyUseSchema>
export const applicationProcessContainerSchema = z.object({ scheme: z.literal('windows-job-v1'), directory: z.string().min(1).max(4096), root: z.string().min(1).max(4096), owner: workcopyOwnerSchema }).strict()
export type ApplicationProcessContainer = z.infer<typeof applicationProcessContainerSchema>
export const applicationConsumerMutationSchema = z.object({
  version: z.literal(1), runId: z.string().min(1).max(100), referenceId: z.string().uuid(), action: z.enum(['attach', 'detach']),
  original: applicationWorkcopyUseSchema, taskKeys: z.array(z.string().min(1).max(4096)).max(128)
}).strict()
export const applicationConsumerRemovalSchema = applicationConsumerMutationSchema.omit({ action: true }).extend({
  phase: z.enum(['read', 'submitted'])
}).strict()
export const storedApplicationSchema = z.object({ config: applicationConfigSchema, revision: z.string(), updatedAt: z.number(), protectedOverrides: z.record(z.string(), z.string()).default({}), overrideRevision: z.string().default(''), taskServiceUses: z.array(applicationTaskServiceUseSchema).max(256).default([]), consumerMutation: applicationConsumerMutationSchema.optional(), consumerRemoval: applicationConsumerRemovalSchema.optional(), approvedFingerprint: z.string().optional(), approvedAt: z.number().optional(), lastRun: z.object({ id: z.string(), pid: z.number().nullable(), pidRole: z.enum(['application','supervisor']).optional(), container: applicationProcessContainerSchema.optional(), startedAt: z.number(), exitedAt: z.number().nullable(), exitCode: z.number().nullable(), signal: z.string().nullable(), identities: z.array(processIdentitySchema), state: z.enum(['stopped','starting','running','stopping','exited','failed','unknown','cleanup-required']), snapshot: applicationRunSnapshotSchema.default({ status: 'unknown', reason: 'legacy-record' }), policy: runPolicySchema.optional(), workcopy: applicationWorkcopyUseSchema.optional() }).optional() })
export type StoredApplication = z.infer<typeof storedApplicationSchema>
export const projectStoreSchema = z.object({ schemaVersion: z.union([z.literal(1), z.literal(2)]), root: z.string(), applications: z.array(storedApplicationSchema).max(100) })
export type ProjectStore = z.infer<typeof projectStoreSchema>
export interface RuntimeEntry {
  stored: StoredApplication
  root: string
  processState: ApplicationProcessState
  readiness: ApplicationReadinessState
  ports: ApplicationPortState[]
  run: ApplicationRun | null
  runPolicy?: RunPolicy
  workcopy?: ApplicationWorkcopyUse
  container?: ApplicationProcessContainer
  jobOwner?: AcpJobOwner
  identities: ProcessIdentity[]
  child?: ChildProcess
  childClosed: boolean
  rootExited: boolean
  launchExecutable?: string
  pendingApproval: boolean
  approvalCurrent?: boolean
  lastError?: string
  output: string
  outputBytes: number
  cursor: number
  outputTruncated: boolean
  cancelProbe?: AbortController
  monitor?: ReturnType<typeof setInterval>
  queue: Promise<unknown>
  stopping: boolean
  persistError?: boolean
  environmentCheck?: ApplicationEnvironmentCheck
  runEnvironmentCheck?: ApplicationEnvironmentCheck
  outputFlush?: () => void
}
export type ApplicationTaskReferenceOwner = Pick<ApplicationTaskServiceUse, 'taskKey' | 'taskLabel' | 'bindingId' | 'attemptId' | 'contextRevision'>
export type ApplicationTaskLaunchGuard = { expectedPlanId: string; expectedCheckId: string; workcopyId: string }
export type ApplicationLaunchInspection = { planId: string; app: ApplicationSummary; snapshot: ApplicationRunSnapshot; environment: ApplicationEnvironmentCheck; canVerify: boolean; workcopyId: string }
export interface AppOperationOptions { expectedRevision?: string; expectedRunId?: string; requireConfirmation?: boolean; confirm?: (preview: ApplicationLaunchPreview) => Promise<boolean>; isCurrent?: () => boolean; assertCurrent?: () => Promise<void>; taskKey?: string; taskGuard?: ApplicationTaskLaunchGuard; taskOwner?: ApplicationTaskReferenceOwner; expectedServiceUseIds?: string[] }
export type AppInstanceRestartOptions = AppOperationOptions & { expectedRevision: string }
export class AppRuntimeError extends Error {
  constructor(message: string, public code: IpcErrorCode = IpcErrorCode.Io, public reason?: ApplicationFailure['reason']) { super(message); this.name = 'AppRuntimeError' }
}
export function runtimeFailure(error: unknown, root?: string, appId?: string): ApplicationFailure {
  if (error instanceof z.ZodError) return { ...ipcFail(IpcErrorCode.InvalidArg, '应用操作参数无效，请重新读取原配置与任务上下文'), root, appId }
  if (error instanceof AppRuntimeError) return { ...ipcFail(error.code, error.message), root, appId, ...(error.reason ? { reason: error.reason } : {}) }
  if (error instanceof DaemonError) return { ...ipcFail(error.code, error.message), root, appId }
  return { ...ipcFail(IpcErrorCode.Io, '应用操作失败，请检查配置、文件权限或进程状态'), root, appId }
}
export type { ApplicationConfig }

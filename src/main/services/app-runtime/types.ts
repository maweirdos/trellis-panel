import { z } from 'zod'
import type { ChildProcess } from 'node:child_process'
import type { ApplicationConfig, ApplicationFailure, ApplicationLaunchPreview, ApplicationPortState, ApplicationReadinessState, ApplicationRun, ApplicationProcessState } from '../../../shared/app-runtime'
import { applicationConfigSchema } from '../../../shared/app-runtime'
import { IpcErrorCode, ipcFail } from '../../../shared/ipc-errors'

export const processIdentitySchema = z.object({ pid: z.number().int().positive(), parentPid: z.number().int().nonnegative(), createdAt: z.string(), executable: z.string().nullable(), commandHash: z.string() })
export type ProcessIdentity = z.infer<typeof processIdentitySchema>
export const storedApplicationSchema = z.object({ config: applicationConfigSchema, revision: z.string(), updatedAt: z.number(), protectedOverrides: z.record(z.string(), z.string()).default({}), overrideRevision: z.string().default(''), approvedFingerprint: z.string().optional(), approvedAt: z.number().optional(), lastRun: z.object({ id: z.string(), pid: z.number().nullable(), startedAt: z.number(), exitedAt: z.number().nullable(), exitCode: z.number().nullable(), signal: z.string().nullable(), identities: z.array(processIdentitySchema), state: z.enum(['stopped','starting','running','stopping','exited','failed','unknown','cleanup-required']) }).optional() })
export type StoredApplication = z.infer<typeof storedApplicationSchema>
export const projectStoreSchema = z.object({ schemaVersion: z.literal(1), root: z.string(), applications: z.array(storedApplicationSchema).max(100) })
export type ProjectStore = z.infer<typeof projectStoreSchema>
export interface RuntimeEntry {
  stored: StoredApplication
  root: string
  processState: ApplicationProcessState
  readiness: ApplicationReadinessState
  ports: ApplicationPortState[]
  run: ApplicationRun | null
  identities: ProcessIdentity[]
  child?: ChildProcess
  childClosed: boolean
  rootExited: boolean
  launchExecutable?: string
  pendingApproval: boolean
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
  outputFlush?: () => void
}
export interface AppOperationOptions { expectedRevision?: string; confirm?: (preview: ApplicationLaunchPreview) => Promise<boolean> }
export class AppRuntimeError extends Error {
  constructor(message: string, public code: IpcErrorCode = IpcErrorCode.Io, public reason?: ApplicationFailure['reason']) { super(message); this.name = 'AppRuntimeError' }
}
export function runtimeFailure(error: unknown, root?: string, appId?: string): ApplicationFailure {
  if (error instanceof AppRuntimeError) return { ...ipcFail(error.code, error.message), root, appId, ...(error.reason ? { reason: error.reason } : {}) }
  return { ...ipcFail(IpcErrorCode.Io, '应用操作失败，请检查配置、文件权限或进程状态'), root, appId }
}
export type { ApplicationConfig }

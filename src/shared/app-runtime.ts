import { z } from 'zod'
import type { IpcFail } from './ipc-errors'

export const APP_RUNTIME_LIMITS = { outputBytes: 256 * 1024, envFileBytes: 256 * 1024, envFiles: 12, envKeys: 512, envValueBytes: 32 * 1024, applications: 100 } as const

const pathText = z.string().trim().min(1).max(4096).refine((value) => !value.includes('\0'), '路径无效')
const argument = z.string().max(32768).refine((value) => !value.includes('\0'), '参数无效')
export const applicationIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/)
export const applicationLaunchSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('argv'), executable: pathText, args: z.array(argument).max(128).default([]) }),
  z.object({ kind: z.literal('script'), command: z.string().trim().min(1).max(32768).refine((value) => !value.includes('\0'), '命令无效') }),
  z.object({ kind: z.literal('npm-script'), script: z.string().min(1).max(256).refine((value) => !value.includes('\0'), '脚本名称无效') })
])
const localHostSchema = z.enum(['127.0.0.1', '::1', 'localhost'])
export const applicationPortSchema = z.object({ port: z.number().int().min(1).max(65535), host: z.enum(['127.0.0.1', '0.0.0.0', '::1', '::']).default('127.0.0.1') })
export const applicationReadinessSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('tcp'), host: localHostSchema.default('127.0.0.1'), port: z.number().int().min(1).max(65535), timeoutMs: z.number().int().min(100).max(120000).default(30000) }),
  z.object({ kind: z.literal('http'), url: z.string().url().max(4096), timeoutMs: z.number().int().min(100).max(120000).default(30000) })
])
export const applicationConfigSchema = z.object({
  id: applicationIdSchema,
  name: z.string().trim().min(1).max(120),
  cwd: pathText.default('.'),
  launch: applicationLaunchSchema,
  envFiles: z.array(pathText).max(APP_RUNTIME_LIMITS.envFiles).default([]),
  ports: z.array(applicationPortSchema).max(16).default([]),
  readiness: applicationReadinessSchema.default({ kind: 'none' }),
  stopTimeoutMs: z.number().int().min(1000).max(60000).default(10000)
})
export const applicationOverridePatchSchema = z.discriminatedUnion('action', [
  z.object({ key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(256), action: z.literal('keep') }),
  z.object({ key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(256), action: z.literal('clear') }),
  z.object({ key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(256), action: z.literal('replace'), value: argument })
])
export const applicationSaveSchema = z.object({ config: applicationConfigSchema, expectedRevision: z.string().max(100).nullable().optional(), overrides: z.array(applicationOverridePatchSchema).max(APP_RUNTIME_LIMITS.envKeys).default([]) })

export type ApplicationConfig = z.infer<typeof applicationConfigSchema>
export type ApplicationLaunch = z.infer<typeof applicationLaunchSchema>
export type ApplicationPort = z.infer<typeof applicationPortSchema>
export type ApplicationReadiness = z.infer<typeof applicationReadinessSchema>
export type ApplicationSaveInput = z.input<typeof applicationSaveSchema>
export type ApplicationDefinition = ApplicationConfig & { revision: string; updatedAt: number; overrideKeys: string[] }
export type ApplicationProcessState = 'stopped' | 'starting' | 'running' | 'stopping' | 'exited' | 'failed' | 'unknown' | 'cleanup-required'
export type ApplicationReadinessState = { state: 'not-configured' | 'checking' | 'ready' | 'unhealthy' | 'unknown'; checkedAt: number | null; message?: string }
export type ApplicationPortState = ApplicationPort & { state: 'available' | 'owned' | 'external-conflict' | 'unknown'; pid?: number; message?: string }
export interface ApplicationRun { id: string; pid: number | null; startedAt: number; exitedAt: number | null; exitCode: number | null; signal: string | null }
export interface ApplicationSummary {
  definition: ApplicationDefinition
  processState: ApplicationProcessState
  readiness: ApplicationReadinessState
  run: ApplicationRun | null
  ports: ApplicationPortState[]
  approval: 'required' | 'approved' | 'pending'
  lastError?: string
  canStart: boolean
  canStop: boolean
  canRestart: boolean
}
export interface ApplicationLaunchPreview { root: string; appId: string; revision: string; name: string; cwd: string; command: string; envFiles: string[]; overrideKeys: string[]; ports: ApplicationPort[]; action: 'start' | 'restart' }
export type ApplicationFailure = IpcFail & { reason?: 'APPROVAL_REQUIRED' | 'CLEANUP_REQUIRED' | 'PORT_CONFLICT' | 'SHUTTING_DOWN'; root?: string; appId?: string }
export type ApplicationResult = { ok: true; root: string; app: ApplicationSummary } | ApplicationFailure
export type ApplicationListResult = { ok: true; root: string; apps: ApplicationSummary[] } | ApplicationFailure
export type ApplicationSuccess = { ok: true; root: string } | ApplicationFailure
export type ApplicationLogsResult = { ok: true; root: string; appId: string; runId: string | null; output: string; outputTruncated: boolean; cursor: number } | ApplicationFailure
export interface ApplicationRuntimeEvent { kind: 'state' | 'output' | 'done' | 'attention'; root: string; appId: string; runId: string | null; app: ApplicationSummary; output?: string; cursor?: number; outputTruncated?: boolean }
export interface ApplicationRuntimeApi {
  appRuntimeList(expectedRoot: string): Promise<ApplicationListResult>
  appRuntimeSave(expectedRoot: string, input: ApplicationSaveInput): Promise<ApplicationResult>
  appRuntimeRemove(expectedRoot: string, id: string, revision: string): Promise<ApplicationSuccess>
  appRuntimeImportNpm(expectedRoot: string, dir: string, script: string, name?: string): Promise<ApplicationResult>
  appRuntimeStart(expectedRoot: string, id: string, revision?: string): Promise<ApplicationResult>
  appRuntimeStop(expectedRoot: string, id: string): Promise<ApplicationResult>
  appRuntimeRestart(expectedRoot: string, id: string, revision?: string): Promise<ApplicationResult>
  appRuntimeLogs(expectedRoot: string, id: string, after?: number): Promise<ApplicationLogsResult>
  onAppRuntimeEvent(listener: (event: ApplicationRuntimeEvent) => void): () => void
}

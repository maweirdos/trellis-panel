import { z } from 'zod'
import type { IpcFail } from './ipc-errors'

export const APP_RUNTIME_LIMITS = { outputBytes: 256 * 1024, envFileBytes: 256 * 1024, envFiles: 12, envKeys: 512, envValueBytes: 32 * 1024, applications: 100, inventoryPage: 100, retainedRuns: 4 } as const

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
export const applicationEnvironmentSchema = z.object({
  selection: z.enum(['unknown', 'local', 'test', 'other']).default('unknown'),
  dependencies: z.enum(['unknown', 'none', 'env-targets']).default('unknown'),
  targetKeys: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(256)).max(32).default([])
}).strict()
export const applicationEnvironmentCheckSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), status: z.enum(['verified', 'unknown', 'changed']),
  method: z.enum(['manual', 'adapter']).nullable(), checkedBy: z.string().max(256).nullable(), checkedAt: z.number().nullable(),
  configRevision: z.string().min(1).max(100), workcopyId: z.string().max(100),
  selection: z.enum(['unknown', 'local', 'test', 'other']),
  targets: z.array(z.object({ key: z.string().max(256), endpoint: z.string().max(1024).nullable() }).strict()).max(32),
  reason: z.string().max(500).optional()
}).strict()
export type ApplicationEnvironmentCheck = z.infer<typeof applicationEnvironmentCheckSchema>
export const applicationConfigSchema = z.object({
  id: applicationIdSchema,
  name: z.string().trim().min(1).max(120),
  cwd: pathText.default('.'),
  launch: applicationLaunchSchema,
  envFiles: z.array(pathText).max(APP_RUNTIME_LIMITS.envFiles).default([]),
  environment: applicationEnvironmentSchema.default({ selection: 'unknown', dependencies: 'unknown', targetKeys: [] }),
  workcopyAccess: z.enum(['consumer', 'writer']).default('writer'),
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

// The unpredictable run ID is the instance generation, not a PID or a config ID.
export const applicationRunIdSchema = z.string().min(1).max(100)
export const applicationInstanceTargetSchema = z.object({ handle: z.string().uuid(), root: pathText, appId: applicationIdSchema, expectedRunId: applicationRunIdSchema }).strict()
export const applicationInventoryInputSchema = z.object({ cursor: z.string().min(1).max(16384).optional(), limit: z.number().int().min(1).max(APP_RUNTIME_LIMITS.inventoryPage).default(50) }).strict()
export const applicationRunSnapshotSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unknown'), reason: z.literal('legacy-record') }),
  z.object({
    status: z.literal('known'), root: pathText, appId: applicationIdSchema, runId: applicationRunIdSchema,
    configRevision: z.string().min(1).max(100), name: z.string().max(1024), cwd: pathText, startedAt: z.number(),
    entry: z.object({ kind: z.enum(['argv', 'script', 'npm-script']), executable: pathText, file: pathText.nullable(), npmScript: z.string().max(1024).nullable(), arguments: z.literal('withheld'), build: z.enum(['unknown', 'existing-artifact']), artifact: z.object({ path: pathText, size: z.number().nonnegative(), modifiedAt: z.number() }).nullable() }),
    environment: z.object({ status: z.enum(['unverified', 'verified']), inherited: z.literal(true), envFiles: z.array(pathText).max(APP_RUNTIME_LIMITS.envFiles), overrideKeys: z.array(z.string().max(1024)).max(APP_RUNTIME_LIMITS.envKeys), check: applicationEnvironmentCheckSchema.optional() }),
    workcopy: z.object({ id: z.string().max(100), branch: z.string().max(4096).nullable(), head: z.string().max(128).nullable(), dirty: z.boolean().nullable(), access: z.enum(['consumer', 'writer', 'unknown']).default('unknown') }).optional(),
    ports: z.array(applicationPortSchema).max(16),
    // HTTP targets expose the origin only; query/path/userinfo may contain credentials.
    readiness: z.object({ kind: z.enum(['none', 'tcp', 'http']), target: z.string().max(4096).nullable() }),
    source: z.literal('not-verified')
  })
])
export type ApplicationRunSnapshot = z.infer<typeof applicationRunSnapshotSchema>
export type ApplicationInstanceTarget = z.infer<typeof applicationInstanceTargetSchema>
export type ApplicationInventoryInput = z.input<typeof applicationInventoryInputSchema>

export type ApplicationConfig = z.infer<typeof applicationConfigSchema>
export type ApplicationLaunch = z.infer<typeof applicationLaunchSchema>
export type ApplicationPort = z.infer<typeof applicationPortSchema>
export type ApplicationReadiness = z.infer<typeof applicationReadinessSchema>
export type ApplicationSaveInput = z.input<typeof applicationSaveSchema>
export type ApplicationDefinition = ApplicationConfig & { revision: string; updatedAt: number; overrideKeys: string[] }
export type ApplicationProcessState = 'stopped' | 'starting' | 'running' | 'stopping' | 'exited' | 'failed' | 'unknown' | 'cleanup-required'
export type ApplicationReadinessState = { state: 'not-configured' | 'checking' | 'ready' | 'unhealthy' | 'unknown'; checkedAt: number | null; message?: string }
export type ApplicationPortState = ApplicationPort & { state: 'available' | 'owned' | 'external-conflict' | 'unknown'; pid?: number; message?: string }
export interface ApplicationRun { id: string; pid: number | null; pidRole?: 'application' | 'supervisor'; startedAt: number; exitedAt: number | null; exitCode: number | null; signal: string | null; snapshot: ApplicationRunSnapshot }
export interface ApplicationSummary {
  definition: ApplicationDefinition
  processState: ApplicationProcessState
  readiness: ApplicationReadinessState
  run: ApplicationRun | null
  serviceUses?: ApplicationTaskServiceUse[]
  environmentCheck?: ApplicationEnvironmentCheck
  runEnvironmentCheck?: ApplicationEnvironmentCheck
  /** Null means that an old record has no trustworthy launch revision. */
  configChanged: boolean | null
  ports: ApplicationPortState[]
  approval: 'required' | 'approved' | 'pending'
  lastError?: string
  canStart: boolean
  canStop: boolean
  canRestart: boolean
}
export interface ApplicationLaunchPreview { root: string; appId: string; revision: string; name: string; cwd: string; command: string; envFiles: string[]; overrideKeys: string[]; ports: ApplicationPort[]; workcopyAccess?: 'consumer' | 'writer'; action: 'start' | 'restart' }
export type ApplicationRestartProgress = { previousRunId: string | null; previousStopped: boolean; phase: 'preflight' | 'stop' | 'revalidate' | 'start' | 'complete'; replacementRunId: string | null }
export type ApplicationFailure = IpcFail & { reason?: 'APPROVAL_REQUIRED' | 'CLEANUP_REQUIRED' | 'PORT_CONFLICT' | 'SHUTTING_DOWN' | 'STALE_RUN' | 'LOGS_UNAVAILABLE' | 'ENVIRONMENT_UNVERIFIED' | 'PLAN_CHANGED' | 'TASK_REFERENCES'; root?: string; appId?: string; app?: ApplicationSummary; restart?: ApplicationRestartProgress }
export type ApplicationResult = { ok: true; root: string; app: ApplicationSummary; disposition?: 'started' | 'reused' | 'restarted'; restart?: ApplicationRestartProgress } | ApplicationFailure
export type ApplicationListResult = { ok: true; root: string; apps: ApplicationSummary[] } | ApplicationFailure
export type ApplicationSuccess = { ok: true; root: string } | ApplicationFailure
export type ApplicationLogsResult = { ok: true; root: string; appId: string; runId: string | null; output: string; outputTruncated: boolean; cursor: number } | ApplicationFailure
export type ApplicationInstanceSummary = { target: ApplicationInstanceTarget; run: ApplicationRun; serviceUses?: ApplicationTaskServiceUse[]; environmentCheck?: ApplicationEnvironmentCheck; runEnvironmentCheck?: ApplicationEnvironmentCheck; processState: ApplicationProcessState; readiness: ApplicationReadinessState; ports: ApplicationPortState[]; currentRevision: string; configChanged: boolean | null; canStop: boolean; canRestart: boolean; lastError?: string }
/** Local-only fixed references. Detaching a task never stops the process. */
export const applicationTaskServiceUseSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), taskKey: z.string().min(1).max(4096), taskLabel: z.string().max(500),
  bindingId: z.string().min(1).max(256), attemptId: z.string().min(1).max(256), contextRevision: z.string().min(1).max(256),
  root: pathText, workcopyId: z.string().max(100), appId: applicationIdSchema, configRevision: z.string().min(1).max(100),
  runId: applicationRunIdSchema, checkId: z.string().uuid(), disposition: z.enum(['created', 'reused']), createdAt: z.number(),
  coordination: z.enum(['pending', 'ready', 'releasing', 'unknown']).default('unknown')
}).strict()
export type ApplicationTaskServiceUse = z.infer<typeof applicationTaskServiceUseSchema>
export type ApplicationReferenceDetachResult = { ok: true; detached: true; reference: ApplicationTaskServiceUse; app: ApplicationSummary } | ApplicationFailure
export type ApplicationInventoryResult = { ok: true; instances: ApplicationInstanceSummary[]; nextCursor: string | null; total: number; partial: boolean; unavailableProjects: number } | ApplicationFailure
/** Main must authorize these global operations independently of the active project. */
export interface ApplicationInstanceApi {
  appRuntimeInventory(input?: ApplicationInventoryInput): Promise<ApplicationInventoryResult>
  appRuntimeStopInstance(target: ApplicationInstanceTarget): Promise<ApplicationResult>
  appRuntimeRestartInstance(target: ApplicationInstanceTarget, expectedRevision: string): Promise<ApplicationResult>
  appRuntimeLogsInstance(target: ApplicationInstanceTarget, after?: number): Promise<ApplicationLogsResult>
  appRuntimeDetachInstanceReference(target: ApplicationInstanceTarget, referenceId: string): Promise<ApplicationReferenceDetachResult>
}
export interface ApplicationRuntimeEvent { kind: 'state' | 'output' | 'done' | 'attention'; root: string; appId: string; runId: string | null; app: ApplicationSummary; output?: string; cursor?: number; outputTruncated?: boolean }
export interface ApplicationRuntimeApi {
  appRuntimeList(expectedRoot: string): Promise<ApplicationListResult>
  appRuntimeSave(expectedRoot: string, input: ApplicationSaveInput): Promise<ApplicationResult>
  appRuntimeRemove(expectedRoot: string, id: string, revision: string): Promise<ApplicationSuccess>
  appRuntimeImportNpm(expectedRoot: string, dir: string, script: string, name?: string): Promise<ApplicationResult>
  appRuntimeStart(expectedRoot: string, id: string, revision?: string): Promise<ApplicationResult>
  appRuntimeStop(expectedRoot: string, id: string, expectedRunId?: string): Promise<ApplicationResult>
  appRuntimeRestart(expectedRoot: string, id: string, revision?: string, expectedRunId?: string): Promise<ApplicationResult>
  appRuntimeLogs(expectedRoot: string, id: string, after?: number, expectedRunId?: string): Promise<ApplicationLogsResult>
  onAppRuntimeEvent(listener: (event: ApplicationRuntimeEvent) => void): () => void
}

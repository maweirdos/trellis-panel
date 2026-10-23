import { z } from 'zod'
import type { IpcFail } from './ipc-errors'
import { processOwnerSchema, type DaemonResult } from './daemon'

export const legacyDaemonInspectionSchema = z.object({
  epoch: z.string().uuid(), owner: processOwnerSchema,
  activeJobs: z.number().int().nonnegative().safe(), unknownJobs: z.number().int().nonnegative().safe(),
  runtimeAuthority: z.enum(['legacy', 'daemon']), settingsAuthority: z.enum(['legacy', 'prepared', 'daemon']),
  canStop: z.boolean()
}).strict()
export type LegacyDaemonInspection = z.infer<typeof legacyDaemonInspectionSchema>
export const legacyDaemonStopInputSchema = z.object({ epoch: z.string().uuid(), owner: processOwnerSchema }).strict()
export type LegacyDaemonStopInput = z.infer<typeof legacyDaemonStopInputSchema>

export const bootstrapPhaseSchema = z.enum(['window-ready', 'connecting', 'preparing', 'ready', 'error', 'incompatible'])
export const bootstrapPaintSchema = z.object({ startTimeMs: z.number().finite().nonnegative() }).strict()
export const bootstrapMigrationSchema = z.object({ commandId: z.string().uuid(), releaseId: z.string().uuid() }).strict()
export type BootstrapMigration = z.infer<typeof bootstrapMigrationSchema>
export const bootstrapSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  phase: bootstrapPhaseSchema,
  ui: z.object({ theme: z.enum(['light', 'dark']), warning: z.string().optional() }).strict(),
  failure: z.object({
    code: z.string(), message: z.string(), outcome: z.string(),
    stage: z.enum(['native', 'desktop']), retryable: z.boolean(),
    migration: bootstrapMigrationSchema.optional()
  }).strict().optional(),
  // Main's monotonic process clock. Renderer paint uses its own navigation clock;
  // receipt time is separate and must never be presented as paint duration.
  marks: z.object({
    processStartMs: z.number(), firstVisibleMs: z.number().optional(),
    authenticatedMs: z.number().optional(),
    nativeReadyMs: z.number().optional(), desktopReadyMs: z.number().optional(),
    rendererFirstPaintMs: z.number().optional(), firstPaintReceivedMs: z.number().optional()
  }).strict()
}).strict()
export type BootstrapSnapshot = z.infer<typeof bootstrapSnapshotSchema>
export type BootstrapResult = { ok: true; data: BootstrapSnapshot } | IpcFail
export type BootstrapActionResult = { ok: true } | IpcFail

/** Main-window-only shell capability; no project, settings or generic RPC access. */
export interface BootstrapApi {
  status(): Promise<BootstrapResult>
  retry(): Promise<BootstrapResult>
  legacyInspect(): Promise<DaemonResult<LegacyDaemonInspection>>
  legacyStop(input: LegacyDaemonStopInput): Promise<DaemonResult<{ stopped: true }>>
  legacyReconcile(input?: LegacyDaemonStopInput): Promise<DaemonResult<{ stopped: true }>>
  exit(): Promise<BootstrapActionResult>
  minimize(): Promise<BootstrapActionResult>
  maximize(): Promise<BootstrapActionResult>
  rendered(): Promise<BootstrapActionResult>
  attached(): Promise<BootstrapActionResult>
  detached(): Promise<BootstrapActionResult>
  paint(input: z.infer<typeof bootstrapPaintSchema>): Promise<BootstrapActionResult>
  onChanged(listener: (state: BootstrapSnapshot) => void): () => void
}

import { z } from 'zod'
import type { IpcFail } from './ipc-errors'
import { processOwnerSchema, type DaemonResult } from './daemon'
import { workcopyOwnerSchema, type WorkcopyOwner } from './workcopy-use'

const daemonTakeoverBlockerSchema = z.object({
  domain: z.enum(['runtime', 'workflow', 'application', 'work-copy', 'scheduler', 'stop']),
  state: z.enum(['active', 'unknown']), label: z.string().min(1).max(200),
  acquiredAt: z.number().int().nonnegative().safe().optional(),
  evidence: z.enum(['none', 'job-witness', 'kernel-transition', 'cleanup-receipt']),
    requiredEvidence: z.array(z.enum(['job-witness', 'kernel-transition', 'cleanup-receipt'])).max(3),
    leaseId: z.string().length(64).optional(),
    owner: workcopyOwnerSchema.optional()
}).strict()

export const daemonTakeoverDiagnosticsSchema = z.object({
  state: z.enum(['running', 'stopping']),
  buildCompatibility: z.enum(['current', 'changed', 'unknown']),
  identities: z.object({
    productVersion: z.string().min(1).max(64),
    protocolVersion: z.number().int().positive(),
    installationId: z.string().length(64),
    ownerBuildSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    currentBuildSha256: z.string().regex(/^[a-f0-9]{64}$/).optional()
  }).strict(),
  activeJobs: z.number().int().nonnegative(),
  unknownJobs: z.number().int().nonnegative(),
  stopCommandId: z.string().uuid().optional(),
  blockers: z.array(daemonTakeoverBlockerSchema).max(32).optional()
}).strict()
export type DaemonTakeoverDiagnostics = z.infer<typeof daemonTakeoverDiagnosticsSchema>
export type { WorkcopyOwner }

export const legacyDaemonInspectionSchema = z.object({
  epoch: z.string().uuid(), owner: processOwnerSchema,
  activeJobs: z.number().int().nonnegative().safe(), unknownJobs: z.number().int().nonnegative().safe(),
  runtimeAuthority: z.enum(['legacy', 'daemon']), settingsAuthority: z.enum(['legacy', 'prepared', 'daemon']),
  canStop: z.boolean()
}).strict()
export type LegacyDaemonInspection = z.infer<typeof legacyDaemonInspectionSchema>
export const legacyDaemonStopInputSchema = z.object({ epoch: z.string().uuid(), owner: processOwnerSchema }).strict()
export type LegacyDaemonStopInput = z.infer<typeof legacyDaemonStopInputSchema>
export const workcopyRecoveryInputSchema = z.object({
  leaseId: z.string().length(64), owner: workcopyOwnerSchema,
  acceptedEvidence: z.enum(['job-witness', 'kernel-transition', 'cleanup-receipt'])
}).strict()
export type WorkcopyRecoveryInput = z.infer<typeof workcopyRecoveryInputSchema>
export const workcopyRecoveryResultSchema = z.object({
  released: z.boolean(), evidence: z.enum(['job-witness', 'kernel-transition', 'cleanup-receipt']).optional(),
  reason: z.enum(['released', 'already-released', 'missing-evidence']).optional()
}).strict()
export type WorkcopyRecoveryResult = z.infer<typeof workcopyRecoveryResultSchema>

export const bootstrapPhaseSchema = z.enum(['window-ready', 'connecting', 'preparing', 'ready', 'error', 'incompatible'])
export const bootstrapPaintSchema = z.object({ startTimeMs: z.number().finite().nonnegative() }).strict()
export const desktopAppearanceSchema = z.object({ fontSize: z.enum(['small', 'standard', 'large']) }).strict()
export type DesktopAppearance = z.infer<typeof desktopAppearanceSchema>
export const bootstrapMigrationSchema = z.object({ commandId: z.string().uuid(), releaseId: z.string().uuid() }).strict()
export type BootstrapMigration = z.infer<typeof bootstrapMigrationSchema>
export const bootstrapSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  phase: bootstrapPhaseSchema,
  ui: z.object({ theme: z.enum(['light', 'dark']), fontSize: desktopAppearanceSchema.shape.fontSize.optional(), warning: z.string().optional() }).strict(),
  failure: z.object({
    code: z.string(), message: z.string(), outcome: z.string(),
    stage: z.enum(['native', 'desktop']), retryable: z.boolean(),
    migration: bootstrapMigrationSchema.optional()
  }).strict().optional(),
  takeover: daemonTakeoverDiagnosticsSchema.optional(),
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
  /** Non-secret appearance only, captured from the ordinary GUI's preferences. */
  appearance(input: DesktopAppearance): Promise<BootstrapActionResult>
  /** Read-only takeover facts; recovery remains an explicit authenticated control. */
  takeoverStatus(): Promise<DaemonResult<DaemonTakeoverDiagnostics>>
  retry(): Promise<BootstrapResult>
  legacyInspect(): Promise<DaemonResult<LegacyDaemonInspection>>
  legacyStop(input: LegacyDaemonStopInput): Promise<DaemonResult<{ stopped: true }>>
  legacyReconcile(input?: LegacyDaemonStopInput): Promise<DaemonResult<{ stopped: true }>>
  workcopyRecovery(input: WorkcopyRecoveryInput): Promise<DaemonResult<WorkcopyRecoveryResult>>
  exit(): Promise<BootstrapActionResult>
  minimize(): Promise<BootstrapActionResult>
  maximize(): Promise<BootstrapActionResult>
  rendered(): Promise<BootstrapActionResult>
  attached(): Promise<BootstrapActionResult>
  detached(): Promise<BootstrapActionResult>
  paint(input: z.infer<typeof bootstrapPaintSchema>): Promise<BootstrapActionResult>
  onChanged(listener: (state: BootstrapSnapshot) => void): () => void
}

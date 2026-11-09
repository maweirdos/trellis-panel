/** Main-only installer contracts. The coordinator owns reviewed manifests and admission. */
export const CUTOVER_INSTALLER_VERSION = 1 as const
export const CUTOVER_FILE_LIMITS = Object.freeze({ files: 64, fileBytes: 1024 * 1024, totalBytes: 8 * 1024 * 1024, planBytes: 24 * 1024 * 1024, eventBytes: 2 * 1024 * 1024, journalBytes: 64 * 1024 * 1024, events: 512, components: 32, directoryEntries: 12000 })

export type CutoverInstallationAction = 'stage' | 'inspect' | 'recover' | 'install' | 'rollback'
export interface CutoverFileChange {
  relativePath: string
  expectedBeforeDigest: string | null
  afterBytes: Uint8Array | null
  afterDigest: string | null
}
export interface CutoverStageRequest {
  operationId: string
  rootDirectory: string
  files: readonly CutoverFileChange[]
}
export interface CutoverAdmissionRequest {
  operationId: string
  rootDirectory: string
  manifestDigest: string
  action: CutoverInstallationAction
  relativePath: string | null
}
export interface CutoverInstallerOptions {
  /** Existing protected main-owned directory outside the entire affected workcopy. */
  privateDirectory: string
  /** Must validate current authority and hold the whole-workcopy fence until this call settles. */
  validateAdmission(request: Readonly<CutoverAdmissionRequest>): Promise<void>
}
export type CutoverFilePhase = 'staged' | 'install-intent' | 'installed' | 'rollback-intent' | 'rolled-back' | 'conflict' | 'unknown'
export interface CutoverFileProgress {
  relativePath: string
  expectedBeforeDigest: string | null
  afterDigest: string | null
  observedDigest: string | null
  phase: CutoverFilePhase
  message: string | null
}
export interface CutoverInstallationStatus {
  version: typeof CUTOVER_INSTALLER_VERSION
  operationId: string
  rootDirectory: string
  manifestDigest: string
  scope: 'whole-workcopy'
  phase: 'staged' | 'installing' | 'installed' | 'rolling-back' | 'rolled-back' | 'blocked'
  files: CutoverFileProgress[]
  /** File verification only; server activation remains the coordinator's responsibility. */
  localVerified: boolean
}
export class CutoverInstallerError extends Error {
  constructor(readonly code: 'CUTOVER_INVALID_PLAN' | 'CUTOVER_OPERATION_CONFLICT' | 'CUTOVER_PATH_CHANGED' | 'CUTOVER_FILE_CONFLICT' | 'CUTOVER_LIMIT' | 'CUTOVER_JOURNAL_INVALID' | 'CUTOVER_BUSY', message: string) { super(message); this.name = 'CutoverInstallerError' }
}

export interface CutoverPhysicalIdentity { path: string; device: string; inode: string; birthtime: string }
export interface CutoverFileObservation { bytes: Buffer | null; identity: CutoverPhysicalIdentity | null; mode: number | null }
export interface CutoverStoredFile {
  relativePath: string
  expectedBeforeDigest: string | null
  afterDigest: string | null
  afterBase64: string | null
  beforeBase64: string | null
  beforeIdentity: CutoverPhysicalIdentity | null
  beforeMode: number | null
}
export interface CutoverStoredPlan {
  version: typeof CUTOVER_INSTALLER_VERSION
  operationId: string
  rootDirectory: string
  manifestDigest: string
  directories: CutoverPhysicalIdentity[]
  files: CutoverStoredFile[]
}
export interface CutoverFileIntent {
  direction: 'install' | 'rollback'
  scratch: string
  scratchIdentity: CutoverPhysicalIdentity
  preparedIdentity: CutoverPhysicalIdentity | null
  sourceIdentity: CutoverPhysicalIdentity | null
}
export interface CutoverStoredProgress {
  phase: CutoverFilePhase
  message: string | null
  intent: CutoverFileIntent | null
  ownedIdentity: CutoverPhysicalIdentity | null
}
export interface CutoverJournalState {
  sequence: number
  previousDigest: string | null
  directories: CutoverPhysicalIdentity[]
  files: CutoverStoredProgress[]
}

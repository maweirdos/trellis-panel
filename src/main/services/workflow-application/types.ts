import type { CompiledWorkflow, ExecutorBinding, WorkflowDefinition, WorkflowScope, RunManifest, WorkflowRun, DriverDispatch, WorkflowCommand, DriverStopResult } from '../../../shared/workflow'
import type { WorkflowRevisionPreview, WorkflowRevisionState } from '../../../shared/workflow-revisions'
import type { WorkflowApplicationSnapshot } from '../../../shared/workflow-application'
import type { WorkflowOwner } from '../workflow-control'
import type { WorkflowOrigin } from '../../../shared/workflow-application'
import type { WorkflowAcpPort, WorkflowStagePlan, PreparedWorkflowContext } from '../workflow-runtime'
import type { WorkflowControlService } from '../workflow-control'
import type { WorkflowMaterialStore } from '../workflow-runtime'
import type { PreparedApplicationFeedback } from './feedback-materials'

export class WorkflowApplicationError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'SCOPE_CHANGED' | 'STALE_PREVIEW' | 'REVISION_CONFLICT' | 'COMMAND_PAYLOAD_CONFLICT' | 'CAPABILITY_UNAVAILABLE' | 'MATERIAL_CHANGED' | 'OUTCOME_UNKNOWN' | 'STORE_DEGRADED' | 'NOT_FOUND' | 'CAPACITY_EXCEEDED', message: string) {
    super(message); this.name = 'WorkflowApplicationError'
  }
}
export type ApplicationNodePolicy = {
  agentId: string; profileId?: string;
  output: WorkflowStagePlan['output']; nativeTask?: WorkflowStagePlan['nativeTask']
}
export type ResolvedApplicationDefinition = {
  definition: WorkflowDefinition;
  /** Keyed by stable Flow step ID. These are main-verified policies, never renderer paths. */
  nodes: Record<string, ApplicationNodePolicy>;
  /** A main-owned current source digest check (e.g. the exact Flow file). */
  assertCurrent: () => void | Promise<void>
  /** Synchronous launch/config fence; admitted runs do not reread mutable drafts/origin state. */
  assertExecutionCurrent: () => void
}
export type WorkflowApplicationOptions = {
  projectRoot: string; acp: WorkflowAcpPort; control?: WorkflowControlService; materials?: WorkflowMaterialStore;
  resolveDefinition: (input: { projectRoot: string; flowId: string; origin: WorkflowOrigin; taskDir: string }) => Promise<ResolvedApplicationDefinition>;
  /** Main owns project lifetime; switching selected chat does not change this. */
  assertProject?: () => void;
  contextBudgetBytes?: number; previewTtlMs?: number; driverTimeouts?: { startupTimeoutMs?: number; turnTimeoutMs?: number }
}
export type PreparedApplicationStage = { context: PreparedWorkflowContext; compiled: CompiledWorkflow; manifest: RunManifest; request: DriverDispatch; policy: ApplicationNodePolicy }
export type ApplicationPriorNode = Omit<WorkflowApplicationSnapshot['nodes'][number], 'run'> & { run: import('../../../shared/workflow').RunRef }
export type ApplicationRevisionCandidate = { dto: WorkflowRevisionPreview; live: ApplicationLiveRun }
export type PendingApplicationRevision = {
  candidate: ApplicationRevisionCandidate; command: WorkflowCommand; state: WorkflowRevisionState;
  cancelled: boolean; stopIntentStarted: boolean; stopOperationId?: string;
  noNativeAdmissionConfirmed?: boolean;
  stopPromise?: Promise<DriverStopResult>; evidenceRefs: string[]; reason: string | null
}
export type ApplicationLiveRun = {
  scope: WorkflowScope; origin: WorkflowOrigin; taskDir: string; source: ResolvedApplicationDefinition;
  compiled: CompiledWorkflow; owner: WorkflowOwner; run: WorkflowRun; stage: PreparedApplicationStage;
  stopRequested: boolean; dispatchStarted: boolean; stopOperationIds: string[]; promise?: Promise<void>;
  inputs: Record<string, import('../../../shared/workflow').WorkflowJson>;
  baseSelections: Array<{ owner: import('../workflow-runtime').MaterialOwner; ref: string; purpose: 'baseline' | 'spec' | 'delta' | 'other'; reason: string }>;
  feedback?: PreparedApplicationFeedback;
  outputs: Map<string, Array<{ ref: string; material: import('../../../shared/workflow').MaterialVersion }>>
  pendingRevision?: PendingApplicationRevision
  startIndex?: number; priorNodes?: ApplicationPriorNode[]
  gateRetries?: Map<string, number>; gateFeedback?: Map<string, string[]>; attempts?: Map<string, number>
}
export type VerifiedApplicationExecutor = { binding: ExecutorBinding; agentId: string; profileId?: string }

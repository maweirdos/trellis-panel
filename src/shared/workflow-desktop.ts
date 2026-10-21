/** Expected root is an anti-retargeting precondition, never an authorization grant. */
import type { IpcFail } from './ipc-errors'
import type { FixedDocumentVersion } from './document-windows'
import type { WorkflowApplicationPreview, WorkflowApplicationAdmission, WorkflowApplicationSnapshot, WorkflowApplicationEventPage, WorkflowPreviewInput, WorkflowStartInput, WorkflowSnapshotInput, WorkflowEventsInput, WorkflowStopInput, WorkflowArtifactInput } from './workflow-application'
import type { WorkflowRevisionPreviewInput, WorkflowRevisionAcceptInput, WorkflowRevisionStatusInput, WorkflowRevisionPreview, WorkflowRevisionStatus } from './workflow-revisions'
import type { WorkflowWorkspaceRecoveryInput, WorkflowRecoveryArtifactInput, WorkflowWorkspaceRecovery } from './workflow-recovery'

export type WorkflowDesktopReply<T> = { ok: true; value: T } | IpcFail
export type WorkflowDesktopUpdate = {
  leaseId: string; projectRoot: string; projectGeneration: number; taskDir: string;
  snapshot?: WorkflowApplicationSnapshot; page?: WorkflowApplicationEventPage; error?: IpcFail
}
export interface WorkflowDesktopApi {
  templates(expectedRoot: string): Promise<WorkflowDesktopReply<Array<{ id: string; name: string; description: string }>>>
  preview(expectedRoot: string, input: WorkflowPreviewInput): Promise<WorkflowDesktopReply<WorkflowApplicationPreview>>
  start(expectedRoot: string, input: WorkflowStartInput): Promise<WorkflowDesktopReply<WorkflowApplicationAdmission>>
  snapshot(expectedRoot: string, input: WorkflowSnapshotInput): Promise<WorkflowDesktopReply<WorkflowApplicationSnapshot>>
  events(expectedRoot: string, input: WorkflowEventsInput): Promise<WorkflowDesktopReply<WorkflowApplicationEventPage>>
  stop(expectedRoot: string, input: WorkflowStopInput): Promise<WorkflowDesktopReply<{ commandId: string; status: string; run: WorkflowStopInput['run'] }>>
  artifact(expectedRoot: string, input: WorkflowArtifactInput): Promise<WorkflowDesktopReply<FixedDocumentVersion>>
  previewRevision(expectedRoot: string, input: WorkflowRevisionPreviewInput): Promise<WorkflowDesktopReply<WorkflowRevisionPreview>>
  acceptRevision(expectedRoot: string, input: WorkflowRevisionAcceptInput): Promise<WorkflowDesktopReply<WorkflowRevisionStatus>>
  cancelRevision(expectedRoot: string, input: WorkflowRevisionStatusInput): Promise<WorkflowDesktopReply<WorkflowRevisionStatus>>
  revisionStatus(expectedRoot: string, input: WorkflowRevisionStatusInput): Promise<WorkflowDesktopReply<WorkflowRevisionStatus>>
  inspectRecovery(expectedRoot: string, input: WorkflowWorkspaceRecoveryInput): Promise<WorkflowDesktopReply<WorkflowWorkspaceRecovery>>
  recoveryArtifact(expectedRoot: string, input: WorkflowRecoveryArtifactInput): Promise<WorkflowDesktopReply<FixedDocumentVersion>>
  subscribe(expectedRoot: string, input: WorkflowEventsInput): Promise<WorkflowDesktopReply<{ leaseId: string }>>
  unsubscribe(leaseId: string): Promise<void>
  onOutput(callback: (update: WorkflowDesktopUpdate) => void): () => void
  onDone(callback: (update: WorkflowDesktopUpdate) => void): () => void
}

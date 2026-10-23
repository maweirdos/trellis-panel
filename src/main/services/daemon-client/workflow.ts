import type { WorkflowApplicationService } from '../workflow-application'
import { runtimeCall } from './runtime'
type Access = Pick<WorkflowApplicationService, 'preview' | 'start' | 'snapshot' | 'events' | 'stop' | 'previewRevision' | 'acceptRevision' | 'cancelRevision' | 'revisionStatus' | 'inspectWorkspaceRecovery' | 'readArtifact' | 'readRecoveryArtifact' | 'resolveMaterialOwner'>
/** Explicit facade, not reflection over a renderer-supplied method. Reader registration stays GUI-owned. */
export async function getWorkflowApplication(root: string): Promise<Access> {
  return {
    preview: input => runtimeCall(root, 'runtime.workflow.preview', input),
    start: input => runtimeCall(root, 'runtime.workflow.start', input),
    snapshot: input => runtimeCall(root, 'runtime.workflow.snapshot', input),
    events: input => runtimeCall(root, 'runtime.workflow.events', input),
    stop: input => runtimeCall(root, 'runtime.workflow.stop', input),
    previewRevision: input => runtimeCall(root, 'runtime.workflow.previewRevision', input),
    acceptRevision: input => runtimeCall(root, 'runtime.workflow.acceptRevision', input),
    cancelRevision: input => runtimeCall(root, 'runtime.workflow.cancelRevision', input),
    revisionStatus: input => runtimeCall(root, 'runtime.workflow.revisionStatus', input),
    inspectWorkspaceRecovery: (input = {}) => runtimeCall(root, 'runtime.workflow.inspectWorkspaceRecovery', input),
    readArtifact: input => runtimeCall(root, 'runtime.workflow.readArtifact', input),
    readRecoveryArtifact: input => runtimeCall(root, 'runtime.workflow.readRecoveryArtifact', input),
    resolveMaterialOwner: relativePath => runtimeCall(root, 'runtime.workflow.resolveMaterialOwner', { relativePath })
  }
}
export const workflowDesktopTemplates = (root: string): Promise<Array<{ id: string; name: string; description: string }>> => runtimeCall(root, 'runtime.workflow.templates', {})
export const isManagedWorkflowOrigin = (root: string, sessionId: string, generation?: string, associationOnly = false): Promise<boolean> => runtimeCall(root, 'runtime.workflow.isManagedOrigin', { sessionId, generation, associationOnly })
export { isWorkflowAdmissionClosed } from '../workflow-desktop'

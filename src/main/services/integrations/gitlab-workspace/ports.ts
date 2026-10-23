import type { IntegrationJob, IntegrationSource, IntegrationWorkInput } from '../../../../shared/integration-work'
import type { WorkspaceGrant } from '../../../../shared/daemon'
import type { GitlabInput, GitlabBinding } from '../../../../shared/gitlab-integration'
import type { ResolvedConnection } from '../types'
import type { GitlabTaskPort } from './tasks'
import type { GitlabCredentialPort } from './adapter'
import type { GitlabWorkspaceRepository } from './repository'

/** All methods are installed by the single authenticated daemon composition.
 * GUI IPC forwards typed requests to it; it must not construct another store. */
export interface GitlabWorkspacePorts {
  repository: GitlabWorkspaceRepository
  credentials: GitlabCredentialPort
  tasks: GitlabTaskPort
  profileId: string
  workspace(expectedRoot: string): Promise<WorkspaceGrant>
  assertWorkspace(workspace: WorkspaceGrant): void
  connection(input: Pick<GitlabInput<'snapshot'>, 'connectionId' | 'connectionRevision'>): Promise<ResolvedConnection>
  enqueue(workspace: WorkspaceGrant, source: IntegrationSource, input: IntegrationWorkInput, commandId: string): Promise<IntegrationJob>
  jobs(workspace: WorkspaceGrant, after: string | null): Promise<{ items: IntegrationJob[]; next: string | null }>
  job(workspace: WorkspaceGrant, id: string): Promise<IntegrationJob | null>
  cancel(workspace: WorkspaceGrant, job: IntegrationJob, commandId: string): Promise<IntegrationJob>
  /** Update the common job to paused/partially-failed only after reconciliation;
   * evidence does not prove all local work complete. Preserve epoch/CAS and never
   * automatically redispatch an outbound intent. */
  reconciled(workspace: WorkspaceGrant, job: IntegrationJob, evidenceRef: string): Promise<void>
  /** Native login UI plus protected CAS save at the current credential authority. */
  authorizeWrites(connection: ResolvedConnection, signal: AbortSignal): Promise<{ connectionRevision: number; detail: string }>
  /** Optional reachable receiver, configured by native owner; contains no renderer secrets. */
  receiver?: {
    configuration(binding: GitlabBinding): Promise<{ url: string; token: string }>
  }
}

import type { TeamPerson } from '../../../src/shared/team-platform'

export type StoreActor = { kind: 'session' | 'device'; credentialHash: string }
export type StorePrincipal = {
  person: TeamPerson; actor: StoreActor; deviceId: string | null; projectId: string | null;
  csrfToken: string | null
}
export type StoreOptions = { dataDir: string; issuer: string; bootstrapSubject: string; identityProvider?: 'oidc' | 'gitlab'; sessionTtlMs: number; pairingTtlMs: number; onlineTtlMs: number }
export type StoreOperation = 'health' | 'createLogin' | 'consumeLogin' | 'completeLogin' | 'authenticate' | 'logout'
  | 'people' | 'setPersonActive' | 'teams' | 'createTeam' | 'teamMembers' | 'setTeamMember' | 'projects' | 'createProject' | 'projectMembers' | 'setProjectMember'
  | 'publish' | 'materials' | 'versions' | 'document' | 'recordFeedback' | 'feedback' | 'events' | 'command'
  | 'enrollDevice' | 'pairing' | 'approveDevice' | 'pairingStatus' | 'devices' | 'revokeDevice' | 'heartbeat'
  | 'backup' | 'close'
  | 'createInvitation' | 'invitations' | 'inspectInvitation' | 'acceptInvitation' | 'revokeInvitation' | 'identity'
  | 'hifoxSnapshot' | 'hifoxCommand' | 'hifoxHead' | 'taskDevelopmentContext'
  | 'taskProgressRead' | 'taskProgressCommand' | 'taskProgressReceipt'
  | 'taskExecutionRead' | 'taskExecutionCommand' | 'taskExecutionReconcile' | 'taskExecutionHistory' | 'taskExecutionArtifact'
  | 'executionInputRead' | 'executionInputResource' | 'executionInputCommand' | 'executionInputReconcile'
  | 'importCommand' | 'importReconcile' | 'importNamespaces' | 'importItems' | 'importRead' | 'importBatch'
  | 'taskMaterialList' | 'taskMaterialRead' | 'taskMaterialVersions' | 'taskMaterialSubmissions' | 'taskMaterialCommand' | 'taskMaterialReceipt'
  | 'governanceList' | 'governanceRead' | 'governanceCommand' | 'governanceReceipt'
  | 'taskInputRead' | 'taskInputCandidates' | 'taskInputRevision' | 'taskInputReadDocument' | 'taskInputCommand' | 'taskInputReceipt'
  | 'codeResourceList' | 'codeResourceCommand' | 'taskCodeResourceRead'
  | 'contentConfigRead' | 'contentConfigure' | 'contentCapabilities' | 'contentPrepare' | 'contentProbe'
  | 'contentJob' | 'contentReceipt' | 'contentCancel' | 'contentBudget' | 'contentAccounting' | 'contentReconcile'
  | 'contentStart' | 'contentSettle' | 'contentRecover'
  | 'creationList' | 'creationView' | 'creationCommand' | 'creationHead'
  | 'hifoxTick'
  | 'registerLocal' | 'localCredential' | 'completeLocalLogin'
  | 'collaborationCommand' | 'collaborationList' | 'collaborationGet' | 'collaborationHistory' | 'collaborationReplies' | 'collaborationReports' | 'collaborationReanchor'
  | 'collaborationDispositions'
export type StoreRequest = { id: number; operation: StoreOperation; input: unknown }
export type StoreResponse = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: { code: string; message: string; statusCode: number } }

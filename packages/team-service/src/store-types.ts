import type { TeamPerson } from '../../../src/shared/team-platform'

export type StoreActor = { kind: 'session' | 'device'; credentialHash: string }
export type StorePrincipal = {
  person: TeamPerson; actor: StoreActor; deviceId: string | null; projectId: string | null;
  csrfToken: string | null
}
export type StoreOptions = { dataDir: string; issuer: string; bootstrapSubject: string; sessionTtlMs: number; pairingTtlMs: number; onlineTtlMs: number }
export type StoreOperation = 'health' | 'createLogin' | 'consumeLogin' | 'completeLogin' | 'authenticate' | 'logout'
  | 'people' | 'setPersonActive' | 'teams' | 'createTeam' | 'teamMembers' | 'setTeamMember' | 'projects' | 'createProject' | 'projectMembers' | 'setProjectMember'
  | 'publish' | 'materials' | 'versions' | 'document' | 'recordFeedback' | 'feedback' | 'events' | 'command'
  | 'enrollDevice' | 'pairing' | 'approveDevice' | 'pairingStatus' | 'devices' | 'revokeDevice' | 'heartbeat'
  | 'backup' | 'close'
  | 'collaborationCommand' | 'collaborationList' | 'collaborationGet' | 'collaborationHistory' | 'collaborationReplies' | 'collaborationReports' | 'collaborationReanchor'
  | 'collaborationDispositions'
export type StoreRequest = { id: number; operation: StoreOperation; input: unknown }
export type StoreResponse = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: { code: string; message: string; statusCode: number } }

import type { DesktopTeamConnection } from '@shared/team-desktop'
import type { CruxPendingCommand } from '@shared/crux'
import type { TeamAuthFeedback } from '@shared/team-auth-feedback'
import type { TeamRole } from '@shared/team-platform'
import { DEFAULT_TEAM_ORIGIN } from '../../team-service-origin'

export type AccountFlowStep = 'auth' | 'organizations' | 'create-organization' | 'accept-invitation' | 'space-setup'
export type AccountAuthMode = 'login' | 'register'
export type AccountAuthProvider = 'local' | 'gitlab' | 'oidc'
export type OrganizationMembershipRole = 'owner' | 'admin' | 'member'
export type AccountOperation = 'load' | 'authenticate' | 'organization' | 'switch' | 'logout' | 'pending'

export interface DesktopWorkspaceChoice {
  connectionId: string | null
  workspaceId: string | null
  workspaceName: string
  organizationId: string | null
  organizationName: string | null
  origin: string
  deviceName: string
  state: DesktopTeamConnection['state'] | 'unconnected'
  accessLocked: boolean
  network: DesktopTeamConnection['network']
  current: boolean
  userCode: string | null
}

export interface DesktopAccountGroup {
  accountId: string
  displayName: string
  provider: AccountAuthProvider | 'unknown'
  origin: string
  state: 'active' | 'signed-out' | 'reauthentication-required' | 'connection-only'
  verified: boolean
  scopeError: string | null
  workspaces: DesktopWorkspaceChoice[]
}

export interface DesktopConnectedAccountSnapshot {
  accounts: DesktopAccountGroup[]
  pendingCommands: CruxPendingCommand[]
  suggestedOrigin: string | null
}

export interface DesktopAccountSession {
  accountId: string
  displayName: string
  provider: AccountAuthProvider
  origin: string
}

export interface DesktopScopeWorkspace {
  workspaceId: string
  name: string
}

export interface DesktopScopeOrganization {
  organizationId: string
  name: string
  workspaces: DesktopScopeWorkspace[]
}

export interface DesktopScopeInvitation {
  invitationId: string
  url: string
  organizationId: string
  organizationName: string
  workspaceId: string
  workspaceName: string
  space: { id: string; name: string } | null
  organizationRoles: OrganizationMembershipRole[]
  workspaceRoles: TeamRole[]
  status: 'pending' | 'accepted' | 'expired' | 'revoked'
  expiresAt: number
}

export interface DesktopScopeSnapshot {
  organizations: DesktopScopeOrganization[]
}

export interface DesktopMemberInvitationInput {
  accountId: string
  workspaceId: string
  username: string
  organizationRoles: Array<Exclude<OrganizationMembershipRole, 'owner'>>
  workspaceRoles: TeamRole[]
  spaceId?: string
}

export interface DesktopMemberInvitationResult {
  invitationId: string
  url: string
  expiresAt: number
}

export interface AccountDraft {
  origin: string
  username: string
  displayName: string
  password: string
  confirmPassword: string
  invitationToken: string
  organizationName: string
  organizationSpaceKey: string
  spaceKeyEdited: boolean
}

export const emptyConnectedSnapshot: DesktopConnectedAccountSnapshot = {
  accounts: [],
  pendingCommands: [],
  suggestedOrigin: null
}

export function createInitialDraft(): AccountDraft {
  return {
    origin: DEFAULT_TEAM_ORIGIN,
    username: '',
    displayName: '',
    password: '',
    confirmPassword: '',
    invitationToken: '',
    organizationName: '',
    organizationSpaceKey: 'MAIN',
    spaceKeyEdited: false
  }
}

export type AccountFeedback = TeamAuthFeedback

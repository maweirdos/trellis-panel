import type { DesktopTeamConnection } from '@shared/team-desktop'
import type { CruxPendingCommand } from '@shared/crux'
import type { TeamRole } from '@shared/team-platform'

export const DEFAULT_TEAM_ORIGIN = ''

export type AccountFlowStep = 'entry' | 'accounts' | 'auth' | 'scope' | 'create-organization' | 'create-workspace' | 'accept-invitation' | 'device' | 'space' | 'confirm-switch'
export type AccountAuthMode = 'login' | 'register'
export type AccountAuthProvider = 'local' | 'gitlab' | 'oidc'
export type OrganizationMembershipRole = 'owner' | 'admin' | 'member'
export type AccountOperation = 'load' | 'authenticate' | 'scope' | 'connect' | 'switch' | 'logout' | 'disconnect' | 'pending'

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

export type AccountSwitchTarget =
  | { kind: 'local' }
  | { kind: 'workspace'; workspace: DesktopWorkspaceChoice }

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
  workspaceName: string
  spaceName: string
  spaceKey: string
  deviceName: string
}

export interface AccountFlowState {
  step: AccountFlowStep
  previousStep: Exclude<AccountFlowStep, 'confirm-switch'>
  authMode: AccountAuthMode
  authProvider: AccountAuthProvider
  draft: AccountDraft
  originEdited: boolean
  snapshot: DesktopConnectedAccountSnapshot
  session: DesktopAccountSession | null
  scopeDraftAccountId: string | null
  scope: DesktopScopeSnapshot
  inspectedInvitation: DesktopScopeInvitation | null
  selectedOrganizationId: string | null
  selectedWorkspaceId: string | null
  connectedConnectionId: string | null
  switchTarget: AccountSwitchTarget | null
  logoutTarget: DesktopAccountGroup | null
  disconnectTarget: DesktopWorkspaceChoice | null
  operation: { id: number; kind: AccountOperation } | null
  error: string | null
  status: string | null
}

const emptyConnectedSnapshot: DesktopConnectedAccountSnapshot = {
  accounts: [],
  pendingCommands: [],
  suggestedOrigin: null
}

const emptyScope: DesktopScopeSnapshot = { organizations: [] }

export function createAccountFlowState(): AccountFlowState {
  return {
    step: 'entry',
    previousStep: 'entry',
    authMode: 'login',
    authProvider: 'local',
    draft: {
      origin: DEFAULT_TEAM_ORIGIN,
      username: '',
      displayName: '',
      password: '',
      confirmPassword: '',
      invitationToken: '',
      organizationName: '',
      workspaceName: '',
      spaceName: '',
      spaceKey: '',
      deviceName: '我的工作电脑'
    },
    originEdited: false,
    snapshot: emptyConnectedSnapshot,
    session: null,
    scopeDraftAccountId: null,
    scope: emptyScope,
    inspectedInvitation: null,
    selectedOrganizationId: null,
    selectedWorkspaceId: null,
    connectedConnectionId: null,
    switchTarget: null,
    logoutTarget: null,
    disconnectTarget: null,
    operation: null,
    error: null,
    status: null
  }
}

export type AccountFlowAction =
  | { type: 'opened' }
  | { type: 'closed' }
  | { type: 'go'; step: Exclude<AccountFlowStep, 'confirm-switch'> }
  | { type: 'back' }
  | { type: 'set-auth-mode'; mode: AccountAuthMode }
  | { type: 'set-auth-provider'; provider: AccountAuthProvider }
  | { type: 'set-draft'; field: keyof AccountDraft; value: string }
  | { type: 'loaded'; snapshot: DesktopConnectedAccountSnapshot }
  | { type: 'authenticated'; session: DesktopAccountSession; scope: DesktopScopeSnapshot }
  | { type: 'scope-updated'; scope: DesktopScopeSnapshot }
  | { type: 'invitation-inspected'; invitation: DesktopScopeInvitation }
  | { type: 'invitation-cleared' }
  | { type: 'select-scope'; organizationId: string; workspaceId: string }
  | { type: 'device-connected'; connectionId: string }
  | { type: 'request-switch'; target: AccountSwitchTarget; from: Exclude<AccountFlowStep, 'confirm-switch'> }
  | { type: 'cancel-switch' }
  | { type: 'request-logout'; target: DesktopAccountGroup | null }
  | { type: 'request-disconnect'; target: DesktopWorkspaceChoice | null }
  | { type: 'operation-started'; id: number; kind: AccountOperation }
  | { type: 'operation-succeeded'; id: number; status?: string | null }
  | { type: 'operation-failed'; id: number; error: string }
  | { type: 'set-error'; error: string }
  | { type: 'set-status'; status: string }
  | { type: 'clear-feedback' }

export function previousAccountStep(step: AccountFlowStep): Exclude<AccountFlowStep, 'confirm-switch'> {
  switch (step) {
    case 'accounts': return 'entry'
    case 'auth': return 'accounts'
    case 'scope': return 'auth'
    case 'create-organization':
    case 'create-workspace':
    case 'accept-invitation': return 'scope'
    case 'device': return 'scope'
    case 'space': return 'entry'
    case 'confirm-switch': return 'accounts'
    default: return 'entry'
  }
}

export function accountFlowReducer(state: AccountFlowState, action: AccountFlowAction): AccountFlowState {
  switch (action.type) {
    case 'opened':
      return {
        ...state,
        step: 'entry',
        previousStep: 'entry',
        draft: { ...state.draft, password: '', confirmPassword: '' },
        session: null,
        scope: emptyScope,
        inspectedInvitation: null,
        selectedOrganizationId: null,
        selectedWorkspaceId: null,
        connectedConnectionId: null,
        switchTarget: null,
        logoutTarget: null,
        disconnectTarget: null,
        operation: null,
        error: null,
        status: null
      }
    case 'closed':
      return { ...state, draft: { ...state.draft, password: '', confirmPassword: '' }, operation: null }
    case 'go':
      return { ...state, step: action.step, previousStep: previousAccountStep(action.step), draft: action.step === 'entry' || action.step === 'accounts' ? { ...state.draft, password: '', confirmPassword: '' } : state.draft, switchTarget: null, logoutTarget: null, disconnectTarget: null, error: null, status: null }
    case 'back': {
      const target = state.step === 'confirm-switch' ? state.previousStep : previousAccountStep(state.step)
      return { ...state, step: target, draft: target === 'entry' || target === 'accounts' ? { ...state.draft, password: '', confirmPassword: '' } : state.draft, switchTarget: null, logoutTarget: null, disconnectTarget: null, error: null, status: null }
    }
    case 'set-auth-mode':
      return { ...state, authMode: action.mode, error: null, status: null }
    case 'set-auth-provider':
      return { ...state, authProvider: action.provider, error: null, status: null }
    case 'set-draft':
      return {
        ...state,
        draft: { ...state.draft, [action.field]: action.value },
        originEdited: action.field === 'origin' ? true : state.originEdited,
        error: null,
        status: null
      }
    case 'loaded':
      return {
        ...state,
        snapshot: action.snapshot,
        draft: !state.originEdited && action.snapshot.suggestedOrigin
          ? { ...state.draft, origin: action.snapshot.suggestedOrigin }
          : state.draft
      }
    case 'authenticated':
      return {
        ...state,
        session: action.session,
        scope: action.scope,
        inspectedInvitation: null,
        scopeDraftAccountId: action.session.accountId,
        draft: { ...state.draft, password: '', confirmPassword: '', ...(state.scopeDraftAccountId && state.scopeDraftAccountId !== action.session.accountId ? { invitationToken: '', organizationName: '', workspaceName: '', spaceName: '', spaceKey: '' } : {}) },
        step: 'scope',
        previousStep: 'auth',
        selectedOrganizationId: null,
        selectedWorkspaceId: null,
        connectedConnectionId: null,
        error: null,
        status: null
      }
    case 'scope-updated':
      return { ...state, scope: action.scope, error: null, status: null }
    case 'invitation-inspected':
      return { ...state, inspectedInvitation: action.invitation, error: null, status: null }
    case 'invitation-cleared':
      return { ...state, inspectedInvitation: null, error: null, status: null }
    case 'select-scope':
      return { ...state, selectedOrganizationId: action.organizationId, selectedWorkspaceId: action.workspaceId, connectedConnectionId: null, error: null, status: null }
    case 'device-connected':
      return { ...state, connectedConnectionId: action.connectionId }
    case 'request-switch':
      return { ...state, step: 'confirm-switch', previousStep: action.from, switchTarget: action.target, disconnectTarget: null, error: null, status: null }
    case 'cancel-switch':
      return { ...state, step: state.previousStep, switchTarget: null, error: null, status: null }
    case 'request-logout':
      return { ...state, logoutTarget: action.target, disconnectTarget: null, error: null, status: null }
    case 'request-disconnect':
      return { ...state, disconnectTarget: action.target, error: null, status: null }
    case 'operation-started':
      return { ...state, operation: { id: action.id, kind: action.kind }, error: null, status: null }
    case 'operation-succeeded':
      return state.operation?.id === action.id ? { ...state, operation: null, error: null, status: action.status ?? null } : state
    case 'operation-failed':
      return state.operation?.id === action.id ? { ...state, operation: null, error: action.error, status: null } : state
    case 'set-error':
      return { ...state, error: action.error, status: null }
    case 'set-status':
      return { ...state, error: null, status: action.status }
    case 'clear-feedback':
      return { ...state, error: null, status: null }
  }
}

export function findScopeWorkspace(scope: DesktopScopeSnapshot, workspaceId: string | null): { organization: DesktopScopeOrganization; workspace: DesktopScopeWorkspace } | null {
  if (!workspaceId) return null
  for (const organization of scope.organizations) {
    const workspace = organization.workspaces.find((item) => item.workspaceId === workspaceId)
    if (workspace) return { organization, workspace }
  }
  return null
}

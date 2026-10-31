import type { DesktopTeamConnection, DesktopTeamConnectionContext } from '@shared/team-desktop'
import type { DesktopTeamAccount, DesktopTeamAuthOptions } from '@shared/team-desktop-account'
import type { TeamInvitation } from '@shared/team-invitations'
import type { TeamPage, TeamProject, TeamTeam } from '@shared/team-platform'
import { api, hasIpc } from '../../api'
import type {
  AccountAuthMode,
  AccountAuthProvider,
  DesktopAccountGroup,
  DesktopAccountSession,
  DesktopConnectedAccountSnapshot,
  DesktopMemberInvitationInput,
  DesktopMemberInvitationResult,
  DesktopScopeInvitation,
  DesktopScopeSnapshot,
  DesktopWorkspaceChoice
} from './model'

export interface DesktopAccountCapabilities {
  localCredentials: boolean
  accountScope: boolean
  organizationManagement: boolean
  invitationAcceptance: boolean
  deviceConnection: boolean
  memberInvitation: boolean
}

export interface DesktopAccountAdapter {
  capabilities: DesktopAccountCapabilities
  authOptions(origin: string): Promise<DesktopTeamAuthOptions>
  loadConnectedAccounts(currentConnectionId: string | null): Promise<DesktopConnectedAccountSnapshot>
  subscribe(onChange: () => void): () => void
  authenticateLocal(input: { mode: AccountAuthMode; origin: string; username: string; displayName?: string; password: string }): Promise<{ session: DesktopAccountSession; scope: DesktopScopeSnapshot }>
  openAccount(accountId: string): Promise<{ session: DesktopAccountSession; scope: DesktopScopeSnapshot }>
  logoutAccount(accountId: string): Promise<void>
  createOrganization(session: DesktopAccountSession, commandId: string, name: string): Promise<{ scope: DesktopScopeSnapshot; organizationId: string }>
  createWorkspace(session: DesktopAccountSession, commandId: string, organizationId: string, name: string): Promise<{ scope: DesktopScopeSnapshot; workspaceId: string }>
  inspectInvitation(session: DesktopAccountSession, url: string): Promise<DesktopScopeInvitation>
  acceptInvitation(session: DesktopAccountSession, commandId: string, invitation: DesktopScopeInvitation): Promise<DesktopScopeSnapshot>
  connectDevice(input: { session: DesktopAccountSession; commandId: string; organizationId: string; workspaceId: string; deviceName: string }): Promise<{ connectionId: string }>
  createMemberInvitation(input: DesktopMemberInvitationInput & { commandId: string }): Promise<DesktopMemberInvitationResult>
  pollConnection(connectionId: string): Promise<void>
  disconnect(connectionId: string): Promise<void>
  retryPending(commandId: string): Promise<void>
  discardPending(commandId: string): Promise<void>
}

export class DesktopAccountCapabilityError extends Error {
  constructor(capability: string) {
    super(`当前桌面版本尚未提供${capability}能力。请更新完整应用后重试。`)
    this.name = 'DesktopAccountCapabilityError'
  }
}

export class DesktopAccountReplyError extends Error {
  readonly code: string
  readonly outcomeUnknown: boolean

  constructor(reply: { code: string; error: string; outcomeUnknown: boolean }) {
    super(reply.error)
    this.name = 'DesktopAccountReplyError'
    this.code = reply.code
    this.outcomeUnknown = reply.outcomeUnknown
  }
}

function requireBridge(): NonNullable<typeof api.teamDesktop> {
  if (!hasIpc || !api?.teamDesktop) throw new DesktopAccountCapabilityError('团队连接')
  return api.teamDesktop
}

function replyValue<T>(reply: { ok: true; value: T } | { ok: false; code: string; error: string; outcomeUnknown: boolean }): T {
  if (!reply.ok) throw new DesktopAccountReplyError(reply)
  return reply.value
}

function providerOf(value: DesktopTeamAccount['person']['provider'] | undefined): DesktopAccountGroup['provider'] {
  return value ?? 'unknown'
}

function sessionOf(account: DesktopTeamAccount): DesktopAccountSession {
  const provider = providerOf(account.person.provider)
  return {
    accountId: account.accountId,
    displayName: account.person.displayName,
    provider: provider === 'unknown' ? 'local' : provider,
    origin: account.origin
  }
}

async function collectPages<T>(load: (cursor?: string) => Promise<{ ok: true; value: TeamPage<T> } | { ok: false; code: string; error: string; outcomeUnknown: boolean }>): Promise<T[]> {
  const items: T[] = []
  let cursor: string | undefined
  for (let pageIndex = 0; pageIndex < 50; pageIndex++) {
    const page = replyValue(await load(cursor))
    items.push(...page.items)
    if (!page.hasMore) return items
    if (!page.nextCursor || page.nextCursor === cursor) throw new Error('团队列表游标没有前进，请重新加载。')
    cursor = page.nextCursor
  }
  throw new Error('团队列表超过桌面核对限界。')
}

async function loadScopeForAccount(account: DesktopTeamAccount): Promise<DesktopScopeSnapshot> {
  const bridge = requireBridge()
  const [organizations, workspaces] = await Promise.all([
    collectPages<TeamTeam>((cursor) => bridge.organizations(account.accountId, { cursor, limit: 100 })),
    collectPages<TeamProject>((cursor) => bridge.workspaces(account.accountId, { cursor, limit: 100 }))
  ])
  return {
    organizations: organizations.map((organization) => ({
      organizationId: organization.teamId,
      name: organization.name,
      workspaces: workspaces.filter((workspace) => workspace.teamId === organization.teamId).map((workspace) => ({ workspaceId: workspace.projectId, name: workspace.name }))
    }))
  }
}

function chooseConnection(connections: DesktopTeamConnection[], currentConnectionId: string | null): DesktopTeamConnection | undefined {
  return [...connections].sort((left, right) => Number(right.connectionId === currentConnectionId) - Number(left.connectionId === currentConnectionId)
    || Number(right.state === 'active' && !right.accessLocked) - Number(left.state === 'active' && !left.accessLocked)
    || (right.lastCheckedAt ?? 0) - (left.lastCheckedAt ?? 0))[0]
}

function workspaceChoice(project: { projectId: string; teamId: string; name: string }, organization: { name: string } | undefined, connection: DesktopTeamConnection | undefined, currentConnectionId: string | null): DesktopWorkspaceChoice {
  return {
    connectionId: connection?.connectionId ?? null,
    workspaceId: project.projectId,
    workspaceName: project.name,
    organizationId: project.teamId,
    organizationName: organization?.name ?? null,
    origin: connection?.origin ?? '',
    deviceName: connection?.deviceName ?? '',
    state: connection?.state ?? 'unconnected',
    accessLocked: connection?.accessLocked ?? false,
    network: connection?.network ?? 'unknown',
    current: connection?.connectionId === currentConnectionId,
    userCode: connection?.userCode ?? null
  }
}

function legacyChoice(connection: DesktopTeamConnection, context: DesktopTeamConnectionContext | undefined, currentConnectionId: string | null): DesktopWorkspaceChoice {
  return {
    connectionId: connection.connectionId,
    workspaceId: context?.project.projectId ?? connection.projectId,
    workspaceName: context?.project.name ?? (connection.state === 'pending' ? '等待完成连接' : '工作区待核对'),
    organizationId: context?.project.teamId ?? null,
    organizationName: null,
    origin: connection.origin,
    deviceName: connection.deviceName,
    state: connection.state,
    accessLocked: connection.accessLocked,
    network: connection.network,
    current: connection.connectionId === currentConnectionId,
    userCode: connection.userCode
  }
}

function invitationSummary(invitation: TeamInvitation, url: string): DesktopScopeInvitation {
  return {
    invitationId: invitation.invitationId,
    url,
    organizationId: invitation.teamId,
    organizationName: invitation.teamName,
    workspaceId: invitation.projectId,
    workspaceName: invitation.projectName,
    space: invitation.space ? { id: invitation.space.id, name: invitation.space.name } : null,
    organizationRoles: [...invitation.teamRoles],
    workspaceRoles: [...invitation.projectRoles],
    status: invitation.status,
    expiresAt: invitation.expiresAt
  }
}

function sameRoleSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((role) => right.includes(role))
}

export const desktopAccountAdapter: DesktopAccountAdapter = {
  capabilities: {
    localCredentials: true,
    accountScope: true,
    organizationManagement: true,
    invitationAcceptance: true,
    deviceConnection: true,
    memberInvitation: true
  },

  async authOptions(origin) {
    return replyValue(await requireBridge().authOptions(origin.trim()))
  },

  async loadConnectedAccounts(currentConnectionId) {
    const bridge = requireBridge()
    const [accounts, connections] = await Promise.all([
      bridge.accounts().then(replyValue),
      bridge.connections().then(replyValue)
    ])
    const activeAccounts = accounts.filter((account) => account.state === 'active')
    const scopes = new Map<string, DesktopScopeSnapshot>()
    const scopeErrors = new Map<string, string>()
    await Promise.all(activeAccounts.map(async (account) => {
      try { scopes.set(account.accountId, await loadScopeForAccount(account)) }
      catch (cause) { scopeErrors.set(account.accountId, cause instanceof Error ? cause.message : String(cause)) }
    }))
    const representedConnections = new Set<string>()
    const groups: DesktopAccountGroup[] = accounts.map((account) => {
      const scope = scopes.get(account.accountId) ?? { organizations: [] }
      const workspaces = scope.organizations.flatMap((organization) => organization.workspaces.map((workspace) => {
        const candidates = connections.filter((connection) => connection.accountId === account.accountId && connection.projectId === workspace.workspaceId)
        const connection = chooseConnection(candidates, currentConnectionId)
        for (const candidate of candidates) representedConnections.add(candidate.connectionId)
        return workspaceChoice({ projectId: workspace.workspaceId, teamId: organization.organizationId, name: workspace.name }, { name: organization.name }, connection, currentConnectionId)
      }))
      return {
        accountId: account.accountId,
        displayName: account.person.displayName,
        provider: providerOf(account.person.provider),
        origin: account.origin,
        state: account.state,
        verified: account.state === 'active',
        scopeError: scopeErrors.get(account.accountId) ?? null,
        workspaces
      }
    })
    const legacyConnections = connections.filter((connection) => !representedConnections.has(connection.connectionId))
    const contextEntries = await Promise.all(legacyConnections.filter((connection) => connection.state === 'active' && !connection.accessLocked).map(async (connection): Promise<readonly [string, DesktopTeamConnectionContext] | null> => {
      try {
        const reply = await bridge.connectionContext(connection.connectionId)
        return reply.ok ? [connection.connectionId, reply.value] as const : null
      } catch { return null }
    }))
    const contexts = new Map(contextEntries.filter((entry): entry is readonly [string, DesktopTeamConnectionContext] => entry !== null))
    for (const connection of legacyConnections) {
      const context = contexts.get(connection.connectionId)
      const accountId = connection.accountId ?? context?.person.userId ?? connection.ownerId ?? `connection:${connection.connectionId}`
      const existing = groups.find((group) => group.accountId === accountId)
      if (existing) existing.workspaces.push(legacyChoice(connection, context, currentConnectionId))
      else groups.push({
        accountId,
        displayName: context?.person.displayName ?? (connection.state === 'pending' ? '待完成登录' : '账号待核对'),
        provider: providerOf(context?.person.provider),
        origin: connection.origin,
        state: 'connection-only',
        verified: Boolean(context),
        scopeError: null,
        workspaces: [legacyChoice(connection, context, currentConnectionId)]
      })
    }
    let pendingCommands: DesktopConnectedAccountSnapshot['pendingCommands'] = []
    try {
      const pending = await api.hifox.workspacePending()
      if (pending.ok) pendingCommands = pending.data
    } catch {
      // Account and workspace choices remain usable when the optional queue read fails.
    }
    for (const group of groups) group.workspaces.sort((left, right) => Number(right.current) - Number(left.current) || left.workspaceName.localeCompare(right.workspaceName, 'zh-CN'))
    groups.sort((left, right) => Number(right.workspaces.some((item) => item.current)) - Number(left.workspaces.some((item) => item.current)) || left.displayName.localeCompare(right.displayName, 'zh-CN'))
    const currentOrigin = connections.find((connection) => connection.connectionId === currentConnectionId)?.origin
    return { accounts: groups, pendingCommands, suggestedOrigin: currentOrigin ?? accounts[0]?.origin ?? connections[0]?.origin ?? null }
  },

  subscribe(onChange) {
    if (!hasIpc || !api?.teamDesktop?.onChanged) return () => {}
    return api.teamDesktop.onChanged(() => onChange())
  },

  async authenticateLocal(input) {
    const bridge = requireBridge()
    const account = input.mode === 'login'
      ? replyValue(await bridge.login({ origin: input.origin, username: input.username, password: input.password }))
      : replyValue(await bridge.register({ origin: input.origin, username: input.username, displayName: input.displayName ?? '', password: input.password }))
    return { session: sessionOf(account), scope: await loadScopeForAccount(account) }
  },

  async openAccount(accountId) {
    const account = replyValue(await requireBridge().accounts()).find((item) => item.accountId === accountId)
    if (!account || account.state !== 'active') throw new Error('该桌面账号需要重新登录。')
    return { session: sessionOf(account), scope: await loadScopeForAccount(account) }
  },

  async logoutAccount(accountId) {
    replyValue(await requireBridge().logout(accountId))
  },

  async createOrganization(session, commandId, name) {
    const receipt = replyValue(await requireBridge().createOrganization({ accountId: session.accountId, commandId, name }))
    const account = replyValue(await requireBridge().accounts()).find((item) => item.accountId === session.accountId)
    if (!account) throw new Error('组织已创建，但原桌面账号不再可用；请重新登录后核对。')
    const scope = await loadScopeForAccount(account)
    if (!scope.organizations.some((organization) => organization.organizationId === receipt.result.teamId)) throw new Error('组织已创建，但当前账号尚未读到该组织，请重试核对。')
    return { scope, organizationId: receipt.result.teamId }
  },

  async createWorkspace(session, commandId, organizationId, name) {
    const receipt = replyValue(await requireBridge().createWorkspace({ accountId: session.accountId, commandId, organizationId, name }))
    const account = replyValue(await requireBridge().accounts()).find((item) => item.accountId === session.accountId)
    if (!account) throw new Error('工作区已创建，但原桌面账号不再可用；请重新登录后核对。')
    const scope = await loadScopeForAccount(account)
    if (!scope.organizations.some((organization) => organization.organizationId === organizationId && organization.workspaces.some((workspace) => workspace.workspaceId === receipt.result.projectId))) throw new Error('工作区已创建，但当前账号尚未读到该工作区，请重试核对。')
    return { scope, workspaceId: receipt.result.projectId }
  },

  async inspectInvitation(session, url) {
    return invitationSummary(replyValue(await requireBridge().inspectInvitation({ accountId: session.accountId, url })), url)
  },

  async acceptInvitation(session, commandId, invitation) {
    replyValue(await requireBridge().acceptInvitation({ accountId: session.accountId, commandId, url: invitation.url }))
    const account = replyValue(await requireBridge().accounts()).find((item) => item.accountId === session.accountId)
    if (!account) throw new Error('邀请已接受，但原桌面账号不再可用；请重新登录后核对。')
    return loadScopeForAccount(account)
  },

  async connectDevice(input) {
    const connection = replyValue(await requireBridge().connectWorkspace({
      accountId: input.session.accountId,
      commandId: input.commandId,
      workspaceId: input.workspaceId,
      deviceName: input.deviceName,
      capabilityClaims: []
    }))
    return { connectionId: connection.connectionId }
  },

  async createMemberInvitation(input) {
    const created = replyValue(await requireBridge().createInvitation({
      accountId: input.accountId,
      commandId: input.commandId,
      workspaceId: input.workspaceId,
      ...(input.spaceId ? { spaceId: input.spaceId } : {}),
      recipientUsername: input.username,
      organizationRoles: input.organizationRoles,
      projectRoles: input.workspaceRoles,
      expiresInMs: 24 * 60 * 60_000
    }))
    if (!sameRoleSet(created.invitation.teamRoles, input.organizationRoles) || !sameRoleSet(created.invitation.projectRoles, input.workspaceRoles)) {
      throw new DesktopAccountReplyError({ code: 'RECEIPT_MISMATCH', error: '邀请已返回，但组织或工作区职责与原提交不一致；不能声明创建成功。', outcomeUnknown: true })
    }
    return { invitationId: created.invitation.invitationId, url: created.url, expiresAt: created.invitation.expiresAt }
  },

  async pollConnection(connectionId) {
    replyValue(await requireBridge().pollPairing(connectionId))
  },

  async disconnect(connectionId) {
    replyValue(await requireBridge().disconnect(connectionId))
  },

  async retryPending(commandId) {
    const result = await api.hifox.retryWorkspaceCommand({ commandId })
    if (!result.ok) throw new Error(result.error)
  },

  async discardPending(commandId) {
    const result = await api.hifox.discardWorkspaceCommand({ commandId })
    if (!result.ok) throw new Error(result.error)
  }
}

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite'
import {
  teamInvitationCreateSchema, teamInvitationAcceptSchema, teamInvitationInspectSchema, teamInvitationListSchema,
  teamInvitationRevokeSchema, teamInvitationSchema, teamInvitationRecipientSchema, type TeamInvitation
} from '../../../src/shared/team-invitations'
import { teamIdSchema, type TeamCommandReply, type TeamPage, type TeamVisibility } from '../../../src/shared/team-platform'
import type { StoreActor, StorePrincipal } from './store-types'
import { TeamServiceError, requireValue } from './errors'
import { TEAM_LOCAL_ISSUER } from '../../../src/shared/team-auth'
import { cruxSnapshotSchema } from '../../../src/shared/crux-schema'
import type { CruxSnapshot } from '../../../src/shared/crux'
import { teamRoleSchema, TEAM_MAX_RESPONSE_BYTES } from '../../../src/shared/team-platform'
import { z } from 'zod'

type Row = Record<string, SQLOutputValue>
export interface InvitationHost {
  issuer(): string
  epoch(): string
  get(sql: string, ...params: SQLInputValue[]): Row | undefined
  all(sql: string, ...params: SQLInputValue[]): Row[]
  run(sql: string, ...params: SQLInputValue[]): void
  admin(principal: StorePrincipal, teamId: string): void
  project(principal: StorePrincipal, projectId: string): void
  principalFor(userId: string): StorePrincipal
  mutation(actor: StoreActor, commandId: string, kind: string, input: unknown, authorize: (p: StorePrincipal) => void, apply: (p: StorePrincipal) => TeamInvitation, replay?: (p: StorePrincipal, result: TeamInvitation) => void): TeamCommandReply<TeamInvitation>
  event(type: string, visibility: TeamVisibility, audienceId: string, projectId: string | null, payload: Record<string, unknown>): void
  bumpAuthorization(): void
  after(principal: StorePrincipal, scope: string, cursor?: string): string
  page<T>(principal: StorePrincipal, scope: string, rows: Row[], key: string, limit: number, allowed: (row: Row) => boolean, map: (row: Row) => T): TeamPage<T>
}
const text = (row: Row, key: string): string => { const value = row[key]; if (typeof value !== 'string') throw new TeamServiceError('CORRUPT_STORE', 'Invalid invitation record', 503); return value }
const number = (row: Row, key: string): number => { const value = row[key]; if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TeamServiceError('CORRUPT_STORE', 'Invalid invitation timestamp', 503); return value }
const hash = (token: string): string => createHash('sha256').update(token).digest('hex')
const denied = (): never => { throw new TeamServiceError('FORBIDDEN', 'This invitation is unavailable to the current account', 403) }
const conflict = (): never => { throw new TeamServiceError('INVITATION_CONFLICT', 'Invitation expired, revoked, already accepted or its membership changed; ask an administrator for a new invitation', 409) }

/** Uses the existing writer and mutation transaction. Neither receipts nor events contain invitation secrets. */
export class TeamInvitations {
  constructor(private readonly host: InvitationHost) {}
  private row(invitationId: string): Row {
    return requireValue(this.host.get('SELECT i.*,t.name AS teamName,p.name AS projectName FROM invitations i JOIN teams t ON t.teamId=i.teamId JOIN projects p ON p.projectId=i.projectId AND p.teamId=i.teamId WHERE invitationId=?', invitationId), 'NOT_FOUND', 'Invitation unavailable')
  }
  private record(row: Row): TeamInvitation {
    const space = this.host.get('SELECT spaceId,spaceName FROM invitation_spaces WHERE invitationId=?', text(row, 'invitationId'))
    return teamInvitationSchema.parse({ invitationId: row.invitationId, teamId: row.teamId, projectId: row.projectId, teamName: row.teamName, projectName: row.projectName,
      ...(space ? { space: { id: space.spaceId, name: space.spaceName } } : {}),
      recipient: JSON.parse(text(row, 'recipientJson')), teamRoles: JSON.parse(text(row, 'teamRolesJson')), projectRoles: JSON.parse(text(row, 'projectRolesJson')),
      createdBy: row.createdBy, createdAt: row.createdAt, expiresAt: row.expiresAt, status: row.status === 'pending' && number(row, 'expiresAt') <= Date.now() ? 'expired' : row.status,
      acceptedBy: row.acceptedBy, acceptedAt: row.acceptedAt })
  }
  private browser(p: StorePrincipal): void { if (p.actor.kind !== 'session') denied() }
  private recipient(row: Row, p: StorePrincipal): void {
    this.browser(p)
    const target = teamInvitationRecipientSchema.parse(JSON.parse(text(row, 'recipientJson')))
    const person = this.host.get('SELECT issuer,subject FROM people WHERE userId=? AND active=1', p.person.userId)
    if (!person || person.issuer !== row.recipientIssuer || (target.kind === 'oidc-subject' && person.issuer !== this.host.issuer()) || (target.kind === 'person' ? target.userId !== p.person.userId : (target.kind === 'local' ? target.username : target.subject) !== text(person, 'subject'))) denied()
  }
  private issuer(row: Row): void { this.host.admin(this.host.principalFor(text(row, 'createdBy')), text(row, 'teamId')) }
  private workspace(projectId: string) {
    const row = requireValue(this.host.get('SELECT revision,snapshotJson FROM crux_workspaces WHERE projectId=?', projectId), 'INVITATION_CONFLICT', 'Space workspace is unavailable', 409)
    try {
      const snapshot: unknown = JSON.parse(text(row, 'snapshotJson'))
      cruxSnapshotSchema.parse(snapshot)
      return { revision: number(row, 'revision'), snapshot: snapshot as CruxSnapshot }
    }
    catch { throw new TeamServiceError('CORRUPT_STORE', 'Stored project workspace cannot be read', 503) }
  }
  private manageableSpace(projectId: string, spaceId: string, actorId: string, requireAvailable = true) {
    const workspace = this.workspace(projectId)
    const matches = workspace.snapshot.spaces.filter((item) => item.id === spaceId)
    const space = matches.length === 1 ? matches[0] : undefined
    const member = this.host.get('SELECT pm.rolesJson FROM project_members pm JOIN projects pr ON pr.projectId=pm.projectId JOIN team_members tm ON tm.teamId=pr.teamId AND tm.userId=pm.userId JOIN people p ON p.userId=pm.userId WHERE pm.projectId=? AND pm.userId=? AND pm.active=1 AND tm.active=1 AND p.active=1', projectId, actorId)
    if (!space || (requireAvailable && space.archived) || !member) throw new TeamServiceError('FORBIDDEN', 'This invitation is unavailable to the current account', 403)
    const roles = z.array(teamRoleSchema).min(1).max(5).parse(JSON.parse(text(member, 'rolesJson')))
    const isMember = space.memberIds.includes(actorId)
    if ((space.visibility === 'private' && !isMember) || (!roles.includes('admin') && !roles.includes('pm') && (!isMember || space.ownerId !== actorId))) denied()
    return { ...workspace, space }
  }
  private invitationSpace(row: Row): Row | undefined { return this.host.get('SELECT * FROM invitation_spaces WHERE invitationId=?', text(row, 'invitationId')) }
  private authorizeManagerSpace(row: Row, userId: string): void {
    const target = this.invitationSpace(row)
    if (target) this.manageableSpace(text(row, 'projectId'), text(target, 'spaceId'), userId, false)
  }
  private currentSpaceMember(row: Row, userId: string): void {
    const target = this.invitationSpace(row)
    if (!target) return
    const workspace = this.workspace(text(row, 'projectId'))
    const spaces = workspace.snapshot.spaces.filter((item) => item.id === text(target, 'spaceId'))
    const space = spaces.length === 1 ? spaces[0] : undefined
    if (!space || space.createdAt !== target.spaceCreatedAt || this.host.epoch() !== target.workspaceEpoch || space.archived || !space.memberIds.includes(userId)) denied()
  }
  private secret(row: Row, token: string): void {
    if (!timingSafeEqual(Buffer.from(text(row, 'tokenHash'), 'hex'), Buffer.from(hash(token), 'hex'))) denied()
  }
  authorizeReceipt(p: StorePrincipal, kind: string, invitationId: string): void {
    this.browser(p); const row = this.row(invitationId)
    if (kind === 'acceptInvitation') {
      this.recipient(row, p); this.issuer(row)
      if (row.status !== 'accepted' || row.acceptedBy !== p.person.userId) denied()
      this.host.project(p, text(row, 'projectId'))
      this.currentSpaceMember(row, p.person.userId)
    } else { this.host.admin(p, text(row, 'teamId')); this.authorizeManagerSpace(row, p.person.userId) }
  }
  dispatch(operation: string, actor: StoreActor, p: StorePrincipal, raw: Record<string, unknown>): unknown {
    this.browser(p)
    if (operation === 'createInvitation') {
      const parsed = teamInvitationCreateSchema.parse(raw.body)
      const { token, ...rest } = parsed
      const input = { ...rest, teamRoles: [...rest.teamRoles].sort(), projectRoles: [...rest.projectRoles].sort(), tokenHash: hash(token) }
      return this.host.mutation(actor, input.commandId, operation, input, (principal) => {
        this.host.admin(principal, input.teamId)
        if (!this.host.get('SELECT projectId FROM projects WHERE projectId=? AND teamId=?', input.projectId, input.teamId)) throw new TeamServiceError('PROJECT_CONFLICT', 'Invitation project must belong to the selected team', 409)
        if (input.spaceId) this.manageableSpace(input.projectId, input.spaceId, principal.person.userId)
      }, (principal) => {
        if (this.host.get('SELECT invitationId FROM invitations WHERE tokenHash=?', input.tokenHash)) throw new TeamServiceError('INVITATION_TOKEN_REUSED', 'Create a new invitation secret for each invitation', 409)
        if (input.recipient.kind === 'oidc-subject' && !this.host.issuer()) throw new TeamServiceError('OIDC_NOT_CONFIGURED', 'Select a local account or an existing person; external identity is not configured', 409)
        const recipientIssuer = input.recipient.kind === 'local' ? TEAM_LOCAL_ISSUER : this.host.issuer()
        const target = input.recipient.kind === 'person'
          ? requireValue(this.host.get('SELECT userId,issuer FROM people WHERE userId=? AND active=1', input.recipient.userId), 'NOT_FOUND', 'Invitation recipient is unavailable')
          : this.host.get('SELECT userId,active FROM people WHERE issuer=? AND subject=?', recipientIssuer, input.recipient.kind === 'local' ? input.recipient.username : input.recipient.subject)
        if (target?.active === 0) denied()
        const teamMember = target ? this.host.get('SELECT revision,active FROM team_members WHERE teamId=? AND userId=?', input.teamId, text(target, 'userId')) : undefined
        const projectMember = target ? this.host.get('SELECT revision,active FROM project_members WHERE projectId=? AND userId=?', input.projectId, text(target, 'userId')) : undefined
        if (teamMember?.active === 0 || projectMember?.active === 0) conflict()
        const count = this.host.get("SELECT COUNT(*) AS total FROM invitations WHERE teamId=? AND status='pending' AND expiresAt>?", input.teamId, Date.now())
        if (count && number(count, 'total') >= 500) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Revoke unused invitations before creating more', 409)
        const invitationId = randomUUID(), timestamp = Date.now()
        this.host.run("INSERT INTO invitations(invitationId,teamId,projectId,tokenHash,recipientIssuer,recipientJson,teamRolesJson,projectRolesJson,expectedTeamRevision,expectedProjectRevision,createdBy,createdAt,expiresAt,status,acceptedBy,acceptedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',NULL,NULL)", invitationId, input.teamId, input.projectId, input.tokenHash, target?.issuer ?? recipientIssuer, JSON.stringify(input.recipient), JSON.stringify(input.teamRoles), JSON.stringify(input.projectRoles), teamMember?.revision ?? null, projectMember?.revision ?? null, principal.person.userId, timestamp, timestamp + input.expiresInMs)
        if (input.spaceId) {
          const workspace = this.manageableSpace(input.projectId, input.spaceId, principal.person.userId)
          this.host.run('INSERT INTO invitation_spaces(invitationId,spaceId,spaceName,workspaceRevision,workspaceEpoch,spaceCreatedAt) VALUES(?,?,?,?,?,?)', invitationId, input.spaceId, workspace.space.name, workspace.revision, this.host.epoch(), workspace.space.createdAt)
        }
        this.host.event('invitation.created', 'personal', principal.person.userId, input.projectId, { invitationId, teamId: input.teamId, projectId: input.projectId })
        return this.record(this.row(invitationId))
      }, (principal, result) => this.authorizeReceipt(principal, operation, result.invitationId))
    }
    if (operation === 'invitations') {
      const input = teamInvitationListSchema.parse(raw.query); this.host.admin(p, input.teamId)
      const scope = `invitations:${input.teamId}`, after = this.host.after(p, scope, input.cursor)
      return this.host.page(p, scope, this.host.all('SELECT invitationId FROM invitations WHERE teamId=? AND invitationId>? ORDER BY invitationId LIMIT 501', input.teamId, after), 'invitationId', input.limit, (item) => {
        try { this.authorizeManagerSpace(this.row(text(item, 'invitationId')), p.person.userId); return true }
        catch (error) { if (error instanceof TeamServiceError && error.code === 'FORBIDDEN') return false; throw error }
      }, (row) => this.record(this.row(text(row, 'invitationId'))))
    }
    const invitationId = teamIdSchema.parse(raw.invitationId)
    if (operation === 'inspectInvitation') {
      const input = teamInvitationInspectSchema.parse(raw.body), row = this.row(invitationId)
      this.secret(row, input.token); this.recipient(row, p); this.issuer(row)
      return this.record(row)
    }
    if (operation === 'revokeInvitation') {
      const input = teamInvitationRevokeSchema.parse(raw.body)
      return this.host.mutation(actor, input.commandId, operation, { invitationId, ...input }, (principal) => { const row = this.row(invitationId); this.host.admin(principal, text(row, 'teamId')); this.authorizeManagerSpace(row, principal.person.userId) }, () => {
        const row = this.row(invitationId)
        if (row.status === 'accepted') throw new TeamServiceError('INVITATION_ACCEPTED', 'Remove the accepted membership through member management', 409)
        this.host.run("UPDATE invitations SET status='revoked' WHERE invitationId=?", invitationId)
        return this.record(this.row(invitationId))
      })
    }
    if (operation === 'acceptInvitation') {
      const parsed = teamInvitationAcceptSchema.parse(raw.body), { token, ...rest } = parsed
      const input = { invitationId, ...rest, tokenHash: hash(token) }
      return this.host.mutation(actor, input.commandId, operation, input, (principal) => {
        const row = this.row(invitationId); this.secret(row, token); this.recipient(row, principal); this.issuer(row)
        if (principal.person.userId !== input.expectedUserId || row.teamId !== input.expectedTeamId || row.projectId !== input.expectedProjectId) denied()
        const space = this.invitationSpace(row)
        if ((space ? text(space, 'spaceId') : undefined) !== input.expectedSpaceId) denied()
        if (space) this.manageableSpace(input.expectedProjectId, text(space, 'spaceId'), text(row, 'createdBy'))
        if (row.status === 'accepted' && row.acceptedBy === principal.person.userId) { this.host.project(principal, input.expectedProjectId); this.currentSpaceMember(row, principal.person.userId); return }
        if (row.status !== 'pending' || number(row, 'expiresAt') <= Date.now()) conflict()
      }, (principal) => {
        const row = this.row(invitationId)
        if (row.status !== 'pending') conflict()
        const targetSpace = this.invitationSpace(row)
        const workspace = targetSpace ? this.manageableSpace(input.expectedProjectId, text(targetSpace, 'spaceId'), text(row, 'createdBy')) : undefined
        if (targetSpace && workspace && (workspace.space.createdAt !== targetSpace.spaceCreatedAt || this.host.epoch() !== targetSpace.workspaceEpoch || number(targetSpace, 'accessRevoked') !== 0)) conflict()
        if (workspace?.space.memberIds.includes(principal.person.userId)) {
          const active = this.host.get('SELECT pm.userId FROM project_members pm JOIN projects p ON p.projectId=pm.projectId JOIN team_members tm ON tm.teamId=p.teamId AND tm.userId=pm.userId WHERE pm.projectId=? AND pm.userId=? AND pm.active=1 AND tm.active=1', input.expectedProjectId, principal.person.userId)
          if (!active) conflict()
        }
        for (const [table, key, scope, rolesKey, revisionKey] of [
          ['team_members', 'teamId', input.expectedTeamId, 'teamRolesJson', 'expectedTeamRevision'],
          ['project_members', 'projectId', input.expectedProjectId, 'projectRolesJson', 'expectedProjectRevision']
        ] as const) {
          const member = this.host.get(`SELECT * FROM ${table} WHERE ${key}=? AND userId=?`, scope, principal.person.userId)
          if ((member?.revision ?? null) !== row[revisionKey] || member?.active === 0) conflict()
          const roles = [...new Set([...(member ? JSON.parse(text(member, 'rolesJson')) as string[] : []), ...JSON.parse(text(row, rolesKey)) as string[]])].sort()
          this.host.run(`INSERT INTO ${table}(${key},userId,rolesJson,active,revision) VALUES(?,?,?,1,1) ON CONFLICT(${key},userId) DO UPDATE SET rolesJson=excluded.rolesJson,revision=revision+1`, scope, principal.person.userId, JSON.stringify(roles))
        }
        if (workspace && !workspace.space.memberIds.includes(principal.person.userId)) {
          const count = this.host.get('SELECT COUNT(*) AS total FROM project_members pm JOIN projects pr ON pr.projectId=pm.projectId JOIN team_members tm ON tm.teamId=pr.teamId AND tm.userId=pm.userId JOIN people p ON p.userId=pm.userId WHERE pm.projectId=? AND pm.active=1 AND tm.active=1 AND p.active=1', input.expectedProjectId)
          if (!count || number(count, 'total') > 500 || workspace.space.memberIds.length >= 500) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Workspace member bound exceeded', 409)
          workspace.space.memberIds.push(principal.person.userId)
          cruxSnapshotSchema.parse(workspace.snapshot)
          const snapshotJson = JSON.stringify(workspace.snapshot)
          if (Buffer.byteLength(snapshotJson) > TEAM_MAX_RESPONSE_BYTES - 16 * 1024) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Project workspace exceeds its response bound', 413)
          const current = requireValue(this.host.get('SELECT revision FROM crux_workspaces WHERE projectId=?', input.expectedProjectId), 'INVITATION_CONFLICT', 'Space workspace is unavailable', 409)
          if (number(current, 'revision') >= Number.MAX_SAFE_INTEGER) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Workspace revision bound exceeded', 503)
          this.host.run('UPDATE crux_workspaces SET revision=revision+1,snapshotJson=?,updatedAt=? WHERE projectId=?', snapshotJson, Date.now(), input.expectedProjectId)
        }
        this.host.run("UPDATE invitations SET status='accepted',acceptedBy=?,acceptedAt=? WHERE invitationId=? AND status='pending'", principal.person.userId, Date.now(), invitationId)
        this.host.bumpAuthorization()
        this.host.event('invitation.accepted', 'team', input.expectedTeamId, input.expectedProjectId, { invitationId, userId: principal.person.userId, projectId: input.expectedProjectId })
        return this.record(this.row(invitationId))
      }, (principal) => this.authorizeReceipt(principal, operation, invitationId))
    }
    throw new TeamServiceError('UNSUPPORTED_OPERATION', 'Unknown invitation operation', 404)
  }
}

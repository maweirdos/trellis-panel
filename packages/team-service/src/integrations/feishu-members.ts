import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite'
import { z } from 'zod'
import {
  feishuMemberBindingSchema, feishuMemberClaimSchema, feishuMemberCodeTtlMs, feishuMemberCommandSchema,
  feishuMemberReceiptSchema, feishuMemberRevokeSchema, feishuMemberSnapshotSchema, feishuMemberSpaceSchema,
  type FeishuMemberIdentity
} from '../../../../src/shared/feishu-member'
import { cruxRemoteSnapshotSchema, type CruxRemoteSnapshot } from '../../../../src/shared/crux-remote'
import { teamIdSchema, type TeamCommandReply, type TeamPerson } from '../../../../src/shared/team-platform'
import type { TeamCruxWorkspace } from '../crux-workspace'
import { TeamServiceError } from '../errors'
import type { StorePrincipal } from '../store-types'

type Row = Record<string, SQLOutputValue>
export type FeishuMemberOperation = 'feishuMemberCode' | 'feishuMemberBindings' | 'feishuMemberRevoke' | 'feishuMemberClaim'
  | 'feishuMemberSnapshot' | 'feishuMemberCommand' | 'feishuMemberReceipt' | 'feishuMemberReady'
export function isFeishuMemberOperation(operation: string): operation is FeishuMemberOperation {
  return operation === 'feishuMemberCode' || operation === 'feishuMemberBindings' || operation === 'feishuMemberRevoke'
    || operation === 'feishuMemberClaim' || operation === 'feishuMemberSnapshot' || operation === 'feishuMemberReady'
    || operation === 'feishuMemberCommand' || operation === 'feishuMemberReceipt'
}

type Host = {
  epoch(): string
  instanceId(): string
  transaction<T>(run: () => T): T
  get(sql: string, ...params: SQLInputValue[]): Row | undefined
  all(sql: string, ...params: SQLInputValue[]): Row[]
  run(sql: string, ...params: SQLInputValue[]): void
  actor(userId: string): TeamPerson
  mutationFor<T>(authenticate: () => StorePrincipal, commandId: string, kind: string, input: unknown,
    authorize: (principal: StorePrincipal) => void, apply: (principal: StorePrincipal) => T): TeamCommandReply<T>
}

const storedBinding = feishuMemberBindingSchema.extend({
  projectId: teamIdSchema, spaceId: z.string(), spaceCreatedAt: z.string(),
  actorId: teamIdSchema, ownerId: teamIdSchema, deviceId: teamIdSchema,
  epoch: teamIdSchema, tenantKey: z.string(), senderOpenId: z.string(), revokedAt: z.number().nullable()
})
const storedCode = z.object({ actorId: teamIdSchema, spaceCreatedAt: z.string() })
const storedReceipt = z.object({ bindingId: teamIdSchema, result: cruxRemoteSnapshotSchema }).strict()
const commandKind = 'feishuTaskCommand'
const MAX_CODES = 1000
const MAX_MEMBER_BINDINGS = 50
const MAX_SPACE_BINDINGS = 1000
const MAX_TOTAL_BINDINGS = 20_000
const REVOKED_BINDING_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const denied = () => new TeamServiceError('FEISHU_MEMBER_NOT_AUTHORIZED', 'The current Feishu identity has no active binding in this space', 403)
const codeInvalid = () => new TeamServiceError('FEISHU_MEMBER_CODE_INVALID', 'The binding code expired, was used or belongs to another space', 409)
const codeHash = (code: string): string => createHash('sha256').update(code, 'utf8').digest('hex')

export class TeamFeishuMembers {
  constructor(private readonly host: Host, private readonly workspace: TeamCruxWorkspace) {}

  private browser(principal: StorePrincipal): void {
    if (principal.actor.kind !== 'session') throw denied()
  }

  private device(principal: StorePrincipal, projectId: string): string {
    if (principal.actor.kind !== 'device' || !principal.deviceId || principal.projectId !== projectId) throw denied()
    return principal.deviceId
  }

  private identityRow(projectId: string, spaceId: string, identity: FeishuMemberIdentity) {
    const { appId, tenantKey, senderOpenId } = identity
    const row = this.host.get(`SELECT * FROM feishu_member_bindings
      WHERE epoch=? AND projectId=? AND spaceId=? AND appId=? AND tenantKey=? AND senderOpenId=? AND revokedAt IS NULL`,
    this.host.epoch(), projectId, spaceId, appId, tenantKey, senderOpenId)
    return row ? storedBinding.parse(row) : null
  }

  private member(owner: StorePrincipal, projectId: string, spaceId: string, identity: FeishuMemberIdentity, bindingId?: string) {
    const deviceId = this.device(owner, projectId)
    const binding = this.identityRow(projectId, spaceId, identity)
    if (!binding || bindingId && binding.bindingId !== bindingId || binding.deviceId !== deviceId || binding.ownerId !== owner.person.userId) throw denied()
    const current = this.workspace.feishuMembership(projectId, spaceId, [binding.ownerId, binding.actorId])
    if (current.createdAt !== binding.spaceCreatedAt) throw denied()
    const principal: StorePrincipal = {
      person: this.host.actor(binding.actorId),
      actor: { kind: 'device', credentialHash: '' },
      deviceId: null, projectId, csrfToken: null
    }
    return { principal, binding }
  }

  dispatch(operation: FeishuMemberOperation, owner: StorePrincipal, raw: Record<string, unknown>): unknown {
    const projectId = teamIdSchema.parse(raw.projectId)
    if (operation === 'feishuMemberReady') {
      this.device(owner, projectId)
      const { spaceId } = feishuMemberSpaceSchema.parse(raw.body)
      this.workspace.feishuMembership(projectId, spaceId, [owner.person.userId])
      return { epoch: this.host.epoch(), instanceId: this.host.instanceId() }
    }
    if (operation === 'feishuMemberCode') return this.issue(owner, projectId, feishuMemberSpaceSchema.parse(raw.body).spaceId)
    if (operation === 'feishuMemberBindings') return this.list(owner, projectId, feishuMemberSpaceSchema.parse(raw.body).spaceId)
    if (operation === 'feishuMemberRevoke') {
      const input = feishuMemberRevokeSchema.parse(raw.body)
      return this.revoke(owner, projectId, input.spaceId, input.bindingId)
    }
    if (operation === 'feishuMemberClaim') return this.claim(owner, projectId, feishuMemberClaimSchema.parse(raw.body))
    if (operation === 'feishuMemberSnapshot') {
      const input = feishuMemberSnapshotSchema.parse(raw.body), { principal, binding } = this.member(owner, projectId, input.spaceId, input.identity, input.bindingId)
      return { bindingId: binding.bindingId, snapshot: this.workspace.feishuRead(principal, projectId, input.spaceId, input.agentId) }
    }
    if (operation === 'feishuMemberCommand') return this.command(owner, projectId, feishuMemberCommandSchema.parse(raw.body))
    return this.receipt(owner, projectId, feishuMemberReceiptSchema.parse(raw.body))
  }

  private issue(owner: StorePrincipal, projectId: string, spaceId: string) {
    this.browser(owner)
    return this.host.transaction(() => {
      const actorId = owner.person.userId, { createdAt } = this.workspace.feishuMembership(projectId, spaceId, [actorId])
      const now = Date.now(), epoch = this.host.epoch()
      this.host.run('DELETE FROM feishu_member_codes WHERE expiresAt<=? OR epoch<>?', now, epoch)
      this.host.run('DELETE FROM feishu_member_codes WHERE projectId=? AND spaceId=? AND actorId=?', projectId, spaceId, actorId)
      const count = this.host.get('SELECT COUNT(*) AS count FROM feishu_member_codes')?.count
      if (typeof count !== 'number' || count >= MAX_CODES) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Too many outstanding Feishu binding codes', 429)
      const code = randomBytes(16).toString('base64url'), expiresAt = now + feishuMemberCodeTtlMs
      this.host.run('INSERT INTO feishu_member_codes(codeHash,projectId,spaceId,spaceCreatedAt,actorId,epoch,expiresAt) VALUES(?,?,?,?,?,?,?)',
        codeHash(code), projectId, spaceId, createdAt, actorId, epoch, expiresAt)
      return { code, expiresAt }
    })
  }

  private list(owner: StorePrincipal, projectId: string, spaceId: string) {
    this.browser(owner)
    return this.host.all(`SELECT bindingId,appId,linkedAt FROM feishu_member_bindings
      WHERE epoch=? AND projectId=? AND spaceId=? AND actorId=? AND revokedAt IS NULL
      ORDER BY linkedAt DESC,bindingId LIMIT ?`, this.host.epoch(), projectId, spaceId, owner.person.userId, MAX_MEMBER_BINDINGS)
      .map(row => feishuMemberBindingSchema.parse(row))
  }

  private revoke(owner: StorePrincipal, projectId: string, spaceId: string, bindingId: string): null {
    this.browser(owner)
    this.host.transaction(() => {
      const scope = [this.host.epoch(), projectId, spaceId, owner.person.userId, bindingId] as const
      if (!this.host.get('SELECT bindingId FROM feishu_member_bindings WHERE epoch=? AND projectId=? AND spaceId=? AND actorId=? AND bindingId=?', ...scope)) throw denied()
      this.host.run('UPDATE feishu_member_bindings SET revokedAt=? WHERE epoch=? AND projectId=? AND spaceId=? AND actorId=? AND bindingId=? AND revokedAt IS NULL', Date.now(), ...scope)
      this.host.run('DELETE FROM feishu_member_codes WHERE projectId=? AND spaceId=? AND actorId=?', projectId, spaceId, owner.person.userId)
    })
    return null
  }

  private claim(owner: StorePrincipal, projectId: string, input: z.infer<typeof feishuMemberClaimSchema>) {
    const deviceId = this.device(owner, projectId)
    const ownerId = owner.person.userId
    return this.host.transaction(() => {
      const now = Date.now(), epoch = this.host.epoch(), digest = codeHash(input.code)
      const code = storedCode.safeParse(this.host.get(`SELECT actorId,spaceCreatedAt FROM feishu_member_codes
        WHERE codeHash=? AND projectId=? AND spaceId=? AND epoch=? AND expiresAt>?`, digest, projectId, input.spaceId, epoch, now))
      if (!code.success) throw codeInvalid()
      const { actorId, spaceCreatedAt } = code.data
      const space = this.workspace.feishuMembership(projectId, input.spaceId, [ownerId, actorId])
      if (space.createdAt !== spaceCreatedAt) throw codeInvalid()
      const { appId, tenantKey, senderOpenId } = input.identity
      const existing = this.identityRow(projectId, input.spaceId, input.identity)
      if (existing) {
        if (existing.actorId !== actorId || existing.ownerId !== ownerId || existing.deviceId !== deviceId || existing.spaceCreatedAt !== spaceCreatedAt) {
          throw new TeamServiceError('FEISHU_MEMBER_BINDING_CONFLICT', 'The Feishu identity already has a different active binding', 409)
        }
        this.host.run('DELETE FROM feishu_member_codes WHERE codeHash=?', digest)
        return { bindingId: existing.bindingId, actorId }
      }
      const scope = [epoch, projectId, input.spaceId] as const
      if (this.host.get('SELECT bindingId FROM feishu_member_bindings WHERE epoch=? AND projectId=? AND spaceId=? AND actorId=? AND appId=? AND revokedAt IS NULL',
        ...scope, actorId, appId)) throw new TeamServiceError('FEISHU_MEMBER_BINDING_CONFLICT', 'Revoke the existing binding for this app before linking another identity', 409)
      const counts = this.host.get(`SELECT COUNT(*) AS spaceCount, COUNT(CASE WHEN actorId=? THEN 1 END) AS actorCount
        FROM feishu_member_bindings WHERE epoch=? AND projectId=? AND spaceId=? AND revokedAt IS NULL`, actorId, ...scope)
      this.host.run('DELETE FROM feishu_member_bindings WHERE epoch<>? OR revokedAt<=?', epoch, now - REVOKED_BINDING_RETENTION_MS)
      const total = this.host.get('SELECT COUNT(*) AS count FROM feishu_member_bindings')?.count
      if (typeof counts?.spaceCount !== 'number' || counts.spaceCount >= MAX_SPACE_BINDINGS || typeof counts.actorCount !== 'number' ||
        counts.actorCount >= MAX_MEMBER_BINDINGS || typeof total !== 'number' || total >= MAX_TOTAL_BINDINGS) {
        throw new TeamServiceError('CAPACITY_EXCEEDED', 'Feishu binding limit reached', 409)
      }
      const bindingId = randomUUID()
      this.host.run(`INSERT INTO feishu_member_bindings(bindingId,projectId,spaceId,spaceCreatedAt,appId,tenantKey,senderOpenId,actorId,ownerId,deviceId,epoch,linkedAt)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, bindingId, projectId, input.spaceId, spaceCreatedAt, appId, tenantKey, senderOpenId, actorId, ownerId, deviceId, epoch, now)
      this.host.run('DELETE FROM feishu_member_codes WHERE codeHash=?', digest)
      return { bindingId, actorId }
    })
  }

  private command(owner: StorePrincipal, projectId: string, input: z.infer<typeof feishuMemberCommandSchema>) {
    const { spaceId, identity, bindingId, command } = input
    const reply = this.host.mutationFor(
      () => this.member(owner, projectId, spaceId, identity, bindingId).principal,
      command.commandId, commandKind, { projectId, spaceId, bindingId, command },
      principal => this.workspace.authorizeFeishuCommand(principal, projectId, spaceId, command),
      principal => ({ bindingId, result: this.workspace.applyFeishuCommand(principal, projectId, spaceId, command) })
    )
    const { principal } = this.member(owner, projectId, spaceId, identity, bindingId)
    return { status: reply.status, commandId: reply.commandId, bindingId,
      result: this.workspace.feishuProjectReceipt(principal, projectId, spaceId, reply.result.result) }
  }

  private receipt(owner: StorePrincipal, projectId: string, input: z.infer<typeof feishuMemberReceiptSchema>) {
    const { spaceId, identity, bindingId, commandId } = input
    const { principal } = this.member(owner, projectId, spaceId, identity, bindingId)
    const row = this.host.get('SELECT resultJson FROM commands WHERE userId=? AND commandId=? AND kind=?',
      principal.person.userId, commandId, commandKind)
    let result: CruxRemoteSnapshot | null = null
    if (typeof row?.resultJson === 'string') {
      const parsed = storedReceipt.parse(JSON.parse(row.resultJson))
      if (parsed.bindingId === bindingId) result = this.workspace.feishuProjectReceipt(principal, projectId, spaceId, parsed.result)
    }
    return { bindingId, result, current: this.workspace.feishuRead(principal, projectId, spaceId, undefined, result?.taskId ?? '') }
  }
}

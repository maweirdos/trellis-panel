import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { IntegrationConnection } from '../../../shared/integrations'
import { readIntegrationState } from './repository'
import { authorizeTeamGitlabConnection, resolveConnection, saveTeamGitlabConnection } from './service'
import { GitlabIdentityMismatchError, normalizedGitlabIdentity, verifyGitlabConnectionIdentity } from './providers/gitlab-authorization'
import type { TeamGitlabBinding, VerifiedGitlabIdentity } from './types'

const ownerSchema = z.object({
  connectionId: z.string().min(1).max(128), origin: z.string().url().max(2048),
  ownerId: z.string().min(1).max(256), deviceId: z.string().min(1).max(256),
  projectId: z.string().min(1).max(256), clientRevision: z.number().int().nonnegative().safe()
})
/** Main-owned generation and a fresh protected team access check, never IPC input. */
export type TeamGitlabOwnerBinding = z.infer<typeof ownerSchema> & { assertCurrent: () => Promise<void> }
const statusSchema = z.object({
  connectionId: z.string().nullable(), state: z.enum(['connected', 'authorization-required', 'mismatch', 'failed']), detail: z.string()
})
export type TeamGitlabConnectionStatus = z.infer<typeof statusSchema>
type Attempt = {
  fingerprint: string; clientRevision: number; controller: AbortController; promise: Promise<TeamGitlabConnectionStatus>
  result?: TeamGitlabConnectionStatus; revision?: number
}
const attempts = new Map<string, Attempt>()
const needsAuthorization = (connectionId: string | null, detail: string): TeamGitlabConnectionStatus => ({ connectionId, state: 'authorization-required', detail })
const requestOf = (c: IntegrationConnection) => ({ connectionId: c.id, connectionRevision: c.revision })
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function linkedSignal(signal: AbortSignal, controller: AbortController): () => void {
  const abort = (): void => controller.abort()
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
  return () => signal.removeEventListener('abort', abort)
}

/** Optional GitLab login only, after verified active enrollment; never a task admission gate. */
export async function ensureTeamGitlabConnection(identity: VerifiedGitlabIdentity, owner: TeamGitlabOwnerBinding, signal: AbortSignal): Promise<TeamGitlabConnectionStatus> {
  return ensure(identity, owner, signal, false)
}

/** Only a deliberate user retry may open another browser after failure/cancellation. */
export async function retryTeamGitlabConnection(identity: VerifiedGitlabIdentity, owner: TeamGitlabOwnerBinding, signal: AbortSignal): Promise<TeamGitlabConnectionStatus> {
  return ensure(identity, owner, signal, true)
}

export function cancelTeamGitlabConnection(teamConnectionId: string): void {
  attempts.get(teamConnectionId)?.controller.abort()
}

async function ensure(raw: VerifiedGitlabIdentity, owner: TeamGitlabOwnerBinding, signal: AbortSignal, retry: boolean): Promise<TeamGitlabConnectionStatus> {
  let identity: VerifiedGitlabIdentity
  let binding: TeamGitlabBinding
  let fingerprint: string
  let ownerFingerprint: string
  try {
    const parsedOwner = ownerSchema.parse(owner)
    ownerFingerprint = digest(parsedOwner)
    identity = normalizedGitlabIdentity(raw)
    const { clientRevision, ...stableOwner } = parsedOwner
    binding = { issuer: identity.issuer, subject: identity.subject, baseUrl: identity.baseUrl, clientId: identity.clientId, ownerKey: digest([stableOwner, identity.issuer, identity.subject, identity.baseUrl, identity.clientId]), authorizationAttempted: false }
    fingerprint = digest([binding.ownerKey, clientRevision])
  } catch { return needsAuthorization(null, '未提供完整的 GitLab 登录身份或可选应用配置，未自动连接 GitLab') }

  if (signal.aborted) return needsAuthorization(null, 'GitLab 自动连接已取消')
  const previous = attempts.get(owner.connectionId)
  if (previous && previous.clientRevision > owner.clientRevision) return needsAuthorization(null, '团队登录绑定版本已过期')
  if (previous && previous.fingerprint === fingerprint && (!retry || !previous.result)) {
    const unlink = linkedSignal(signal, previous.controller)
    try {
      await owner.assertCurrent()
      const result = await previous.promise
      if (signal.aborted || previous.controller.signal.aborted) return needsAuthorization(result.connectionId, 'GitLab 自动连接已取消，请手动重试')
      await owner.assertCurrent()
      if (signal.aborted || previous.controller.signal.aborted || attempts.get(owner.connectionId) !== previous || digest(ownerSchema.parse(owner)) !== ownerFingerprint) return needsAuthorization(result.connectionId, '团队登录绑定已变化')
      if (result.state === 'connected') {
        const current = readIntegrationState().connections.find((c) => c.id === result.connectionId && !c.deleted)
        if (!current?.enabled || current.revision !== previous.revision || !current.secrets.oauthTokens) return needsAuthorization(result.connectionId, 'GitLab 连接已变更或停用，请检查连接后手动重试')
      }
      return result
    } catch { previous.controller.abort(); return needsAuthorization(previous.result?.connectionId ?? null, '团队登录或 GitLab 连接已失效，请手动重试') }
    finally { unlink() }
  }
  previous?.controller.abort()
  if (!previous && attempts.size >= 100) {
    const finished = [...attempts].find(([, item]) => item.result)
    if (finished) attempts.delete(finished[0])
    else return { connectionId: null, state: 'failed', detail: 'GitLab 登录请求过多，请稍后手动重试' }
  }
  const controller = new AbortController()
  const unlink = linkedSignal(signal, controller)
  const activeSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(5 * 60 * 1000)])
  const attempt: Attempt = { fingerprint, clientRevision: owner.clientRevision, controller, promise: Promise.resolve(needsAuthorization(null, 'GitLab 连接准备中')) }
  attempts.set(owner.connectionId, attempt)
  const assertCurrent = async (): Promise<void> => {
    if (activeSignal.aborted || attempts.get(owner.connectionId) !== attempt || digest(ownerSchema.parse(owner)) !== ownerFingerprint) throw new Error('Team binding changed')
    await owner.assertCurrent()
    if (activeSignal.aborted || attempts.get(owner.connectionId) !== attempt || digest(ownerSchema.parse(owner)) !== ownerFingerprint) throw new Error('Team binding changed')
  }
  attempt.promise = connect(identity, binding, activeSignal, assertCurrent, retry, (revision) => { attempt.revision = revision }).then((result) => {
    attempt.result = result
    return result
  }).catch(() => {
    const result = needsAuthorization(null, '团队登录或 GitLab 连接已失效，请手动重试')
    attempt.result = result
    return result
  }).finally(unlink)
  return attempt.promise
}

async function connect(identity: VerifiedGitlabIdentity, binding: TeamGitlabBinding, signal: AbortSignal, assertCurrent: () => Promise<void>, retry: boolean, rememberRevision: (revision: number) => void): Promise<TeamGitlabConnectionStatus> {
  let connectionId: string | null = null
  try {
    await assertCurrent()
    const state = readIntegrationState()
    const owned = state.connections.find((c) => c.teamGitlab?.ownerKey === binding.ownerKey)
    if (owned) {
      connectionId = owned.id
      if (owned.deleted || !owned.enabled) return needsAuthorization(connectionId, '团队 GitLab 连接已删除或停用，请在集成设置中检查')
      if (owned.config.baseUrl !== identity.baseUrl || owned.config.clientId !== identity.clientId || owned.config.authMethod !== 'oauth2') return needsAuthorization(connectionId, 'GitLab 连接配置已变化，请在集成设置中检查')
      if (owned.secrets.oauthTokens) {
        try {
          await verifyGitlabConnectionIdentity(resolveConnection({ connectionId, connectionRevision: owned.revision }), identity, signal, true)
          await assertCurrent()
          resolveConnection({ connectionId, connectionRevision: owned.revision })
          rememberRevision(owned.revision)
          return { connectionId, state: 'connected', detail: 'GitLab 集成已连接，账号身份已核验' }
        } catch (error) {
          if (!retry || error instanceof GitlabIdentityMismatchError) throw error
        }
      } else if (owned.teamGitlab?.authorizationAttempted && !retry) return needsAuthorization(connectionId, 'GitLab 浏览器授权尚未完成，请手动重试')
    } else {
      // Existing accounts are inspected, never overwritten or silently relinked.
      for (const existing of state.connections.filter((c) => !c.deleted && c.enabled && !c.teamGitlab && c.providerId === 'gitlab' && c.config.authMethod === 'oauth2' && c.config.baseUrl === identity.baseUrl && c.config.clientId === identity.clientId && c.secrets.oauthTokens)) {
        try {
          await verifyGitlabConnectionIdentity(resolveConnection({ connectionId: existing.id, connectionRevision: existing.revision }), identity, signal)
        } catch (error) { if (signal.aborted) throw error; continue }
        await assertCurrent()
        resolveConnection({ connectionId: existing.id, connectionRevision: existing.revision })
        rememberRevision(existing.revision)
        return { connectionId: existing.id, state: 'connected', detail: '已复用身份一致的 GitLab 集成' }
      }
    }
    await assertCurrent()
    const connection = owned ? resolveConnection({ connectionId: owned.id, connectionRevision: owned.revision }).public : saveTeamGitlabConnection(binding)
    connectionId = connection.id
    const authorized = await authorizeTeamGitlabConnection(requestOf(connection), binding, signal, assertCurrent)
    rememberRevision(authorized.revision)
    return { connectionId, state: 'connected', detail: 'GitLab 集成已连接，账号身份已核验' }
  } catch (error) {
    if (error instanceof GitlabIdentityMismatchError) return { connectionId, state: 'mismatch', detail: error.message }
    if (signal.aborted) return needsAuthorization(connectionId, 'GitLab 自动连接已取消或超时，请手动重试')
    return { connectionId, state: 'failed', detail: 'GitLab 自动连接未完成，请检查团队登录和集成配置后手动重试' }
  }
}

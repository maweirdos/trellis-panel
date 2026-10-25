import { randomUUID } from 'node:crypto'
import type { LegacyIntegrationInput, LegacyIntegrationData } from '../../../shared/integration-native'
import { legacyIntegrationCall } from './integration-legacy'
import { IntegrationError } from '../integrations/types'

/** Native profile facade: the caller owns the fresh team checks, the daemon
 * owns OAuth/refresh and persistence. No workspace root or credential crosses this bridge. */
export async function teamGitlabCall(
  identity: LegacyIntegrationInput<'teamGitlabConnect'>['identity'],
  owner: LegacyIntegrationInput<'teamGitlabConnect'>['owner'], signal: AbortSignal,
  assertCurrent: () => Promise<void>, retry: boolean
): Promise<LegacyIntegrationData<'teamGitlabConnect'>> {
  const ownerId = randomUUID(), requestId = randomUUID()
  let finished = false, cancellation: Promise<void> | undefined, assertionFailed = false
  const current = (): boolean => !finished && !signal.aborted
  const cancel = (): void => {
    cancellation ??= legacyIntegrationCall('', 'cancelAuthorization', { requestId }, ownerId).then((result) => {
      if (!result.ok) throw new IntegrationError('团队 GitLab 授权取消未确认，请检查原连接', 'uncertain')
    }).catch(() => { process.emitWarning('Team GitLab cancellation was not confirmed; inspect the original connection before retrying.', { code: 'TRELLIS_TEAM_GITLAB_CANCEL' }) })
  }
  await assertCurrent()
  if (signal.aborted) throw new IntegrationError('团队 GitLab 授权已取消', 'denied')
  signal.addEventListener('abort', cancel, { once: true })
  const pending = legacyIntegrationCall('', 'teamGitlabConnect', { requestId, identity, owner, retry }, ownerId, randomUUID(), current).finally(() => { finished = true })
  const assertions = (async (): Promise<void> => {
    while (current()) {
      const result = await legacyIntegrationCall('', 'teamGitlabCheck', { requestId }, ownerId, randomUUID(), current)
      if (!result.ok) throw new IntegrationError(result.error, 'denied')
      if (result.data.done || !current()) return
      if (result.data.challengeId) {
        await assertCurrent()
        if (!current()) throw new IntegrationError('团队 GitLab 授权已取消', 'denied')
        const confirmed = await legacyIntegrationCall('', 'teamGitlabConfirm', { requestId, challengeId: result.data.challengeId }, ownerId, randomUUID(), current)
        if (!confirmed.ok) throw new IntegrationError(confirmed.error, 'conflict')
      } else await new Promise<void>((resolve) => { setTimeout(resolve, 100) })
    }
  })().catch(() => { if (!finished) { assertionFailed = true; cancel() } })
  try {
    const result = await Promise.race([pending, assertions.then(() => pending)])
    if (!result.ok) throw new IntegrationError(result.error, 'denied')
    if (result.data.status.state !== 'connected') return result.data
    if (signal.aborted || assertionFailed) return { status: { connectionId: result.data.status.connectionId, state: 'authorization-required', detail: '团队登录或 GitLab 授权已变化，请检查原连接后手动重试' }, revision: null }
    await assertCurrent()
    return result.data
  } finally {
    finished = true
    signal.removeEventListener('abort', cancel)
    if (cancellation) await cancellation
    // An admitted check ends when its original connect attempt completes, or
    // at its bounded long-poll deadline. Observe failures without replaying it.
    void assertions.catch(() => {})
  }
}

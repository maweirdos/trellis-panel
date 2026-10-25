import { randomUUID } from 'node:crypto'
import type { ProcessOwner } from '../../shared/daemon'
import type { LegacyIntegrationData, LegacyIntegrationInput } from '../../shared/integration-native'
import { connectTeamGitlabThroughOwner } from '../services/integrations/team-gitlab'
import { IntegrationError } from '../services/integrations/types'

type Check = LegacyIntegrationData<'teamGitlabCheck'>
type Attempt = {
  done: boolean; expiresAt: number
  challenge?: { id: string; approve(): void; reject(error: Error): void }
  wake?: () => void
}

/** Challenges cross only the authenticated native connection. Credentials and
 * their sole writer remain in this process; the GUI retains the actual team ACL check. */
export function createTeamGitlabAuthorizations() {
  const attempts = new Map<string, Attempt>()
  const keyFor = (actor: ProcessOwner, ownerId: string, requestId: string): string => JSON.stringify([actor, ownerId, requestId])
  const snapshot = (attempt: Attempt): Check => ({ challengeId: attempt.challenge?.id ?? null, done: attempt.done })
  function prune(): void {
    for (const [key, attempt] of attempts) if (attempt.done && attempt.expiresAt <= Date.now()) attempts.delete(key)
  }
  return {
    async connect(actor: ProcessOwner, ownerId: string, input: LegacyIntegrationInput<'teamGitlabConnect'>, signal: AbortSignal): Promise<LegacyIntegrationData<'teamGitlabConnect'>> {
      prune()
      const key = keyFor(actor, ownerId, input.requestId)
      if (attempts.has(key)) throw new IntegrationError('团队 GitLab 授权标识已在使用', 'conflict')
      if (attempts.size >= 100) {
        const finished = [...attempts].find(([, attempt]) => attempt.done)
        if (finished) attempts.delete(finished[0])
        else throw new IntegrationError('团队 GitLab 授权请求过多，请稍后重试', 'denied')
      }
      const attempt: Attempt = { done: false, expiresAt: Date.now() + 5 * 60_000 }
      attempts.set(key, attempt)
      const abort = (): void => {
        attempt.done = true
        attempt.challenge?.reject(new IntegrationError('团队 GitLab 授权已取消或超时', 'denied'))
        attempt.challenge = undefined
        attempt.wake?.()
      }
      signal.addEventListener('abort', abort, { once: true })
      const assertCurrent = async (): Promise<void> => {
        if (signal.aborted || attempt.done) throw new IntegrationError('团队 GitLab 授权已取消或超时', 'denied')
        await new Promise<void>((resolve, reject) => {
          attempt.challenge = { id: randomUUID(), approve: resolve, reject }
          attempt.wake?.()
        })
        if (signal.aborted || attempt.done) throw new IntegrationError('团队 GitLab 授权已取消或超时', 'denied')
      }
      try {
        return await connectTeamGitlabThroughOwner(input.identity, input.owner, signal, assertCurrent, input.retry)
      } finally {
        signal.removeEventListener('abort', abort)
        attempt.done = true
        attempt.challenge = undefined
        attempt.expiresAt = Date.now() + 5 * 60_000
        attempt.wake?.()
      }
    },
    async check(actor: ProcessOwner, ownerId: string, requestId: string): Promise<Check> {
      prune()
      const attempt = attempts.get(keyFor(actor, ownerId, requestId))
      // A check can overtake the original request before its admission.
      if (!attempt) return { challengeId: null, done: false }
      if (attempt.done || attempt.challenge) return snapshot(attempt)
      if (attempt.wake) throw new IntegrationError('团队 GitLab 校验正在等待原请求', 'conflict')
      return new Promise<Check>((resolve) => {
        const finish = (): void => { clearTimeout(timer); attempt.wake = undefined; resolve(snapshot(attempt)) }
        const timer = setTimeout(finish, 10_000)
        timer.unref()
        attempt.wake = finish
      })
    },
    confirm(actor: ProcessOwner, ownerId: string, requestId: string, challengeId: string): null {
      const attempt = attempts.get(keyFor(actor, ownerId, requestId))
      const challenge = attempt?.challenge
      if (!attempt || attempt.done || !challenge || challenge.id !== challengeId) throw new IntegrationError('团队 GitLab 校验已失效，请检查原请求', 'conflict')
      attempt.challenge = undefined
      challenge.approve()
      return null
    }
  }
}

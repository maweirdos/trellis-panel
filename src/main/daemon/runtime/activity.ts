import type { DaemonActivity } from '../../../shared/daemon/lifecycle'
import type { OwnedAcpSessionFacts } from '../../services/acp'

/** Only current native facts establish idleness. Historical connection existence
 * and non-session integration jobs are not interruption consent. */
export function sessionActivity(session: OwnedAcpSessionFacts): DaemonActivity['state'] {
  if (session.disconnected || session.cleanupRequired || session.closing || !session.sessionId || !session.connectionGeneration) return 'uncertain'
  if (session.accepting || session.turnActive || session.pendingPermission || session.unfinishedTools || session.backgroundWork || session.settling || session.leaseHeld) return 'interruptible'
  return session.status === 'ready' ? 'idle' : 'uncertain'
}
export function projectDaemonActivity(facts: OwnedAcpSessionFacts[], otherWork: number): DaemonActivity {
  const sessions = facts.map(session => ({ title: session.title?.trim().slice(0, 200) || '未命名会话', state: sessionActivity(session) }))
  return {
    state: sessions.some(session => session.state === 'uncertain') ? 'uncertain'
      : sessions.some(session => session.state === 'interruptible') ? 'interruptible' : 'idle',
    sessions: sessions.slice(0, 100), otherWork
  }
}

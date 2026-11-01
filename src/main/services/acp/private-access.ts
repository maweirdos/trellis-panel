import { AsyncLocalStorage } from 'node:async_hooks'
import { resolve } from 'node:path'
import type { PrivateNativeOwner } from '../../../shared/private-conversations'

type RecordOwner = { projectRoot: string; sessionId?: string; privateConversation?: { id: string; creatorId: string } }
const ownerScope = new AsyncLocalStorage<PrivateNativeOwner>()
const rootKey = (root: string): string => process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root)
export function isPrivateAcpRecord(record: Pick<RecordOwner, 'sessionId' | 'privateConversation'>): boolean {
  return Boolean(record.privateConversation) || record.sessionId?.startsWith('acp-private-') === true
}
/** Only the native-GUI private dispatch lane installs this exact owner proof. */
export function withPrivateAcpOwner<T>(owner: PrivateNativeOwner, action: () => T): T {
  if (owner.sessionId !== `acp-private-${owner.conversationId}`) throw new Error('私有原生会话身份无效')
  return ownerScope.run(Object.freeze({ ...owner }), action)
}
export function canAccessPrivateAcpRecord(record: RecordOwner): boolean {
  if (!isPrivateAcpRecord(record)) return true
  const owner = ownerScope.getStore()
  return Boolean(owner && owner.sessionId === record.sessionId && rootKey(owner.root) === rootKey(record.projectRoot)
    && (!record.privateConversation || record.privateConversation.id === owner.conversationId && record.privateConversation.creatorId === owner.creatorId))
}
export function privateAcpEventIdentity(root: string, payload: unknown): RecordOwner {
  if (!payload || typeof payload !== 'object') return { projectRoot: root }
  const value = payload as { sessionId?: string; session?: { privateConversation?: RecordOwner['privateConversation'] }; privateConversation?: RecordOwner['privateConversation']; payload?: { privateConversation?: RecordOwner['privateConversation'] } }
  return { projectRoot: root, sessionId: value.sessionId, privateConversation: value.privateConversation ?? value.session?.privateConversation ?? value.payload?.privateConversation }
}

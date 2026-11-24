import { createHmac, randomBytes } from 'node:crypto'
import type { ConversationDriverAction, ConversationDriverDescriptor, ConversationDriverEvidence } from '../../../../../shared/conversation/driverCatalog'

const fingerprintKey = randomBytes(32)
export type MutableDriverActions = Partial<Record<ConversationDriverAction, ConversationDriverEvidence>>
const actions: readonly ConversationDriverAction[] = [
  'chat', 'planning', 'execution', 'cancel', 'steer', 'resume', 'goal', 'goalPause',
  'compact', 'nativeSubthreads', 'modelSwitch', 'readOnly', 'toolApproval',
]

export function driverConfigurationKey(values: unknown): string {
  return createHmac('sha256', fingerprintKey).update(JSON.stringify(values)).digest('hex')
}

export function driverActionEvidence(
  overrides: Partial<ConversationDriverDescriptor['actions']>,
): ConversationDriverDescriptor['actions'] {
  const unknown: ConversationDriverEvidence = {
    state: 'unknown', source: 'native-handshake', detail: '当前实例尚未提供该操作的可核对证据。',
  }
  return Object.fromEntries(actions.map(action => [action, overrides[action] ?? unknown])) as Record<ConversationDriverAction, ConversationDriverEvidence>
}

export function hostUnsupported(detail: string): ConversationDriverEvidence {
  return { state: 'unsupported', source: 'host-policy', detail }
}

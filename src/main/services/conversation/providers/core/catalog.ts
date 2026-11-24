import { createHmac, randomBytes } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import type { ConversationDriverAction, ConversationDriverDescriptor, ConversationDriverEvidence } from '../../../../../shared/conversation/driverCatalog'
import { DaemonError } from '../../../../daemon/errors'
import { readBounded, writeExclusiveAtomic } from '../../../../daemon/files'
import { checkedDirectory } from '../../../private-conversations/files'

const temporaryFingerprintKey = randomBytes(32)
export type MutableDriverActions = Partial<Record<ConversationDriverAction, ConversationDriverEvidence>>
const actions: readonly ConversationDriverAction[] = [
  'chat', 'planning', 'execution', 'cancel', 'steer', 'resume', 'goal', 'goalPause',
  'compact', 'nativeSubthreads', 'modelSwitch', 'readOnly', 'toolApproval',
]

export function loadDriverFingerprintKey(protectedDirectory: string): Buffer {
  const file = join(checkedDirectory(protectedDirectory), 'conversation-driver-fingerprint.v1')
  const read = (): Buffer => {
    const entry = lstatSync(file)
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new DaemonError('E_DENIED', '原引擎配置凭据已被重定向。')
    const key = readBounded(file, 128)
    if (!/^[0-9a-f]{64}$/u.test(key)) throw new DaemonError('E_CONFLICT', '原引擎配置凭据无法核实。')
    return Buffer.from(key, 'hex')
  }
  try { return read() }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  try { writeExclusiveAtomic(file, randomBytes(32).toString('hex')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  return read()
}

export function driverConfigurationKey(values: unknown, fingerprintKey: Buffer = temporaryFingerprintKey): string {
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

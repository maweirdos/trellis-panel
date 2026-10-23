import { randomUUID } from 'node:crypto'
import {
  legacyIntegrationRequestSchema, legacyIntegrationResults, legacyIntegrationResultSchema,
  type LegacyIntegrationOperation, type LegacyIntegrationInput, type LegacyIntegrationData
} from '../../../shared/integration-native'
import type { IntegrationResult } from '../../../shared/integrations'
import { DaemonError } from '../../daemon/errors'
import { nativeDomainCall } from './runtime'

/** Called only by native feature IPC; the renderer cannot choose an RPC method,
 * grant or cancellation owner. nativeDomainCall supplies the checked bulk wire. */
export async function legacyIntegrationCall<M extends LegacyIntegrationOperation>(
  root: string, operation: M, input: LegacyIntegrationInput<M>, ownerId: string,
  commandId = randomUUID(), isCurrent?: () => boolean
): Promise<IntegrationResult<LegacyIntegrationData<M>>> {
  const body = legacyIntegrationRequestSchema.parse({ ownerId, operation, input })
  const result = legacyIntegrationResultSchema.parse(await nativeDomainCall<unknown>(root, 'integration.execute', body, commandId, isCurrent))
  if (!result.ok) return result
  const data = legacyIntegrationResults[operation].safeParse(result.data)
  if (!data.success) throw new DaemonError('E_UNKNOWN', '后台集成返回了无效结果，请先检查原操作记录。', 'unknown')
  // The result is validated with the schema indexed by this same operation.
  return { ok: true, data: data.data as LegacyIntegrationData<M> }
}

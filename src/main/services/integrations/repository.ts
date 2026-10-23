import { app } from 'electron'
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteText } from '../local-task/prd'
import { IntegrationError } from './types'
import { assertLegacySettingsWriter } from '../../daemon/settings-owner'
import { integrationStatePort } from './state-port'
import { integrationStateSchema as stateSchema, integrationStateV1Schema as stateV1Schema, type IntegrationState } from './stored-schema'
export { storedConnectionSchema } from './stored-schema'
export type { StoredConnection, IntegrationState } from './stored-schema'

function filePath(): string { return join(app.getPath('userData'), 'integrations.json') }
export function readIntegrationState(): IntegrationState {
  const authority = integrationStatePort()
  if (authority) return authority.read()
  const path = filePath()
  if (!existsSync(path)) return { version: 2, connections: [], bindings: [], receipts: [], legacyImports: {} }
  try {
    if (statSync(path).size > 2 * 1024 * 1024) throw new Error('limit')
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (raw && typeof raw === 'object' && 'version' in raw && raw.version === 1) {
      assertLegacySettingsWriter(app.getPath('userData'))
      const previous = stateV1Schema.parse(raw)
      const next = stateSchema.parse({ ...previous, version: 2, legacyImports: {} })
      const backup = path + '.v1.bak'
      if (!existsSync(backup)) copyFileSync(path, backup)
      atomicWriteText(path, JSON.stringify(next, null, 2))
      return next
    }
    return stateSchema.parse(raw)
  } catch { throw new IntegrationError('集成配置无法读取或版本不兼容；原文件已保留', 'io') }
}
/** Short synchronous mutation: one main-process writer, atomic replacement, no optimistic success. */
export function updateIntegrationState<T>(change: (state: IntegrationState) => T): T {
  const authority = integrationStatePort()
  if (authority) return authority.update(change)
  assertLegacySettingsWriter(app.getPath('userData'))
  const state = readIntegrationState()
  const result = change(state)
  try {
    const validated = stateSchema.parse(state)
    const text = JSON.stringify(validated, null, 2)
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('limit')
    atomicWriteText(filePath(), text)
  } catch { throw new IntegrationError('集成配置保存失败，未确认此次修改', 'io') }
  return result
}

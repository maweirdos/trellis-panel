import { app } from 'electron'
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { atomicWriteText } from '../local-task/prd'
import { providerIdSchema, integrationBindingSchema, deliveryReceiptSchema } from '../../../shared/integrations'
import { IntegrationError } from './types'

export const storedConnectionSchema = z.object({ id: z.string(), providerId: providerIdSchema, name: z.string(), enabled: z.boolean(), revision: z.number().int().positive(), config: z.record(z.string(), z.string()), secrets: z.record(z.string(), z.string()), checkedAt: z.number().nullable(), check: z.enum(['unverified', 'authenticated', 'configured', 'failed']), detail: z.string(), deleted: z.boolean().default(false) })
export type StoredConnection = z.infer<typeof storedConnectionSchema>
const records = { connections: z.array(storedConnectionSchema).max(100), bindings: z.array(integrationBindingSchema).max(500), receipts: z.array(deliveryReceiptSchema).max(100) }
const stateV1Schema = z.object({ version: z.literal(1), ...records })
const stateSchema = z.object({ version: z.literal(2), ...records, legacyImports: z.record(z.string().max(256), z.string().max(128)) })
export type IntegrationState = z.infer<typeof stateSchema>

function filePath(): string { return join(app.getPath('userData'), 'integrations.json') }
export function readIntegrationState(): IntegrationState {
  const path = filePath()
  if (!existsSync(path)) return { version: 2, connections: [], bindings: [], receipts: [], legacyImports: {} }
  try {
    if (statSync(path).size > 2 * 1024 * 1024) throw new Error('limit')
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (raw && typeof raw === 'object' && 'version' in raw && raw.version === 1) {
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

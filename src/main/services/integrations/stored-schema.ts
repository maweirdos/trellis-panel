import { z } from 'zod'
import { providerIdSchema, integrationBindingSchema, deliveryReceiptSchema } from '../../../shared/integrations'

/** Persistence validators shared with the dormant daemon migration; no repository/GUI imports. */
export const storedConnectionSchema = z.object({ id: z.string(), providerId: providerIdSchema, name: z.string(), enabled: z.boolean(), revision: z.number().int().positive(), config: z.record(z.string(), z.string()), secrets: z.record(z.string(), z.string()), checkedAt: z.number().nullable(), check: z.enum(['unverified', 'authenticated', 'configured', 'failed']), detail: z.string(), deleted: z.boolean().default(false) })
export type StoredConnection = z.infer<typeof storedConnectionSchema>
const records = { connections: z.array(storedConnectionSchema).max(100), bindings: z.array(integrationBindingSchema).max(500), receipts: z.array(deliveryReceiptSchema).max(100) }
export const integrationStateV1Schema = z.object({ version: z.literal(1), ...records })
export const integrationStateSchema = z.object({ version: z.literal(2), ...records, legacyImports: z.record(z.string().max(256), z.string().max(128)) })
export type IntegrationState = z.infer<typeof integrationStateSchema>

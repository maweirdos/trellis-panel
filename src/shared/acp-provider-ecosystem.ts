import { z } from 'zod'

export const ACP_REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'

const boundedText = (max: number) => z.string().min(1).max(max).refine(value => !value.includes('\0'))
const httpsUrl = z.string().min(1).max(2048).refine(value => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch { return false }
}, '必须是 HTTPS URL')

const registryEnvSchema = z.record(boundedText(200), boundedText(4000)).optional()
const registryPackage = (shape: { package: z.ZodString; args?: z.ZodOptional<z.ZodArray<z.ZodString>>; env?: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>> }) =>
  z.object(shape).transform(value => {
    if (value.env === undefined) return value
    const { env: _removed, ...safe } = value
    return safe
  })
const registryBinary = z.object({
  archive: httpsUrl,
  cmd: boundedText(200),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  args: z.array(boundedText(2000)).max(64).optional(),
  env: registryEnvSchema
}).transform(value => {
  if (value.env === undefined) return value
  const { env: _removed, ...safe } = value
  return safe
})

export const acpRegistryAgentSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/i),
  name: boundedText(200),
  version: z.string().min(1).max(64).regex(/^\d+(?:\.\d+){0,3}(?:[+-][\w.-]+)?$/),
  description: z.string().max(2000).refine(value => !value.includes('\0')),
  authors: z.array(boundedText(200)).max(16).optional(),
  license: boundedText(128).optional(),
  website: httpsUrl.optional(),
  repository: httpsUrl.optional(),
  icon: httpsUrl.optional(),
  license_url: httpsUrl.optional(),
  distribution: z.object({
    binary: z.record(z.string().min(1).max(128), registryBinary).optional(),
    npx: registryPackage({ package: boundedText(214), args: z.array(boundedText(2000)).max(64).optional(), env: registryEnvSchema }).optional(),
    uvx: registryPackage({ package: boundedText(214), args: z.array(boundedText(2000)).max(64).optional(), env: registryEnvSchema }).optional()
  })
}).strict()

export const acpLocalProviderProvenanceSchema = z.object({
  executable: z.string().min(1).max(4096),
  realpath: z.string().min(1).max(4096),
  dev: z.string().min(1).max(128),
  ino: z.string().min(1).max(128),
  size: z.number().int().nonnegative(),
  mtimeNs: z.string().min(1).max(128),
  ctimeNs: z.string().min(1).max(128),
  birthtimeNs: z.string().min(1).max(128).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i)
}).strict()

export const acpRegistryIndexSchema = z.object({
  version: z.string().min(1).max(64).regex(/^\d+(?:\.\d+){0,3}(?:[+-][\w.-]+)?$/),
  agents: z.array(z.unknown()).max(256),
  extensions: z.unknown().optional()
}).strict()

export const acpRegistryCacheSchema = z.object({
  schemaVersion: z.literal(1),
  sourceUrl: z.literal(ACP_REGISTRY_URL),
  fetchedAt: z.number().int().positive(),
  index: acpRegistryIndexSchema,
  agents: z.array(acpRegistryAgentSchema).max(256)
}).strict()

export const acpRegistryQuerySchema = z.object({
  query: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(256).default(256)
}).strict()

export const acpLocalProviderSaveSchema = z.object({
  id: z.string().min(1).max(128).regex(/^local-[a-z0-9][a-z0-9._-]*$/i).optional(),
  name: boundedText(120),
  agentId: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/i),
  executable: z.string().min(4).max(4096).refine(value => /^[a-z]:[\\/].+/i.test(value) && !value.startsWith('\\\\') && !value.includes('\0')),
  argv: z.array(z.string().min(1).max(2000)).max(64),
  env: z.array(z.object({ key: z.string().min(1).max(200).regex(/^[A-Za-z_][A-Za-z0-9_]*$/), value: z.string().max(4000) })).max(32),
  enabled: z.boolean()
}).strict()

export const acpLocalProviderRecordSchema = acpLocalProviderSaveSchema.extend({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(128).regex(/^local-[a-z0-9][a-z0-9._-]*$/i),
  source: z.literal('local'),
  provenance: acpLocalProviderProvenanceSchema,
  savedAt: z.number().int().positive()
}).strict()

export const acpLocalProviderStoreSchema = z.object({
  schemaVersion: z.literal(1),
  providers: z.array(acpLocalProviderRecordSchema).max(64)
}).strict()

export type AcpRegistryAgent = z.infer<typeof acpRegistryAgentSchema>
export type AcpRegistryIndex = z.infer<typeof acpRegistryIndexSchema>
export type AcpRegistryCache = z.infer<typeof acpRegistryCacheSchema>
export type AcpRegistryQuery = z.infer<typeof acpRegistryQuerySchema>
export type AcpLocalProviderSaveInput = z.infer<typeof acpLocalProviderSaveSchema>
export type AcpLocalProviderRecord = z.infer<typeof acpLocalProviderRecordSchema>

export interface AcpRegistryCatalogState {
  ok: boolean
  stale: boolean
  fetchedAt?: number
  sourceUrl: string
  indexVersion?: string
  agents: AcpRegistryAgent[]
  error?: string
}

export interface AcpProviderLaunchProvenance {
  executable: string
  realpath: string
  dev: string
  ino: string
  size: number
  mtimeNs: string
  ctimeNs: string
  birthtimeNs?: string
  sha256: string
}

export interface AcpCapabilityEvidenceRecord {
  schemaVersion: 1
  runtimeId: string
  checkedAt: number
  identity: string
  protocolVersion?: number
  agentInfo?: { name?: string; version?: string }
  capabilities?: string[]
}

export type AcpCapabilityEvidenceStatus = 'registry-declared' | 'negotiated' | 'unknown'
export type AcpCapabilityKey = 'protocolVersion' | 'loadSession' | 'imageInput' | 'embeddedContext' | 'mcp'

export interface AcpCapabilityMatrixItem {
  key: AcpCapabilityKey
  registry?: string
  negotiated?: string | boolean
  status: AcpCapabilityEvidenceStatus
}

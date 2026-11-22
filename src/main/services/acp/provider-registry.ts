import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { app } from 'electron'
import { Readable } from 'node:stream'
import {
  ACP_REGISTRY_URL,
  acpRegistryAgentSchema,
  acpRegistryCacheSchema,
  acpRegistryIndexSchema,
  type AcpCapabilityMatrixItem,
  type AcpRegistryAgent,
  type AcpRegistryCatalogState,
  type AcpLocalProviderRecord
} from '../../../shared/acp-provider-ecosystem'
import { acpRegistryQuerySchema } from '../../../shared/acp-provider-ecosystem'
import { proxiedFetch } from '../proxy'
import { readLocalProviderStore } from './provider-store'
import { runtimeVerificationEvidence } from './runtime-verification'

const MAX_REGISTRY_BYTES = 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000

let inFlight: Promise<AcpRegistryCatalogState> | undefined

function cachePath(): string {
  return join(app.getPath('userData'), 'acp', 'registry', 'catalog.json')
}

function ensureWithinUserData(path: string): string {
  const root = resolve(app.getPath('userData'))
  const target = resolve(path)
  const contained = process.platform === 'win32'
    ? target === root || target.toLowerCase().startsWith(`${root.toLowerCase()}\\`)
    : target === root || target.startsWith(`${root}/`)
  if (contained) return target
  throw new Error('本地 Provider 数据必须保存在应用数据目录')
}

function decodeIndex(text: string): { index: ReturnType<typeof acpRegistryIndexSchema.parse>; agents: AcpRegistryAgent[] } {
  const value: unknown = JSON.parse(text)
  const index = acpRegistryIndexSchema.parse(value)
  const raw = (value as { agents: unknown[] }).agents
  const agents: AcpRegistryAgent[] = []
  for (const entry of raw) {
    const parsed = acpRegistryAgentSchema.safeParse(entry)
    if (!parsed.success) throw new Error('目录中存在无效 provider 条目')
    if (agents.some(previous => previous.id.toLowerCase() === parsed.data.id.toLowerCase())) throw new Error('目录中存在重复的 provider ID')
    agents.push(parsed.data)
  }
  return { index, agents }
}

function readCache(): AcpRegistryCatalogState | undefined {
  try {
    const path = ensureWithinUserData(cachePath())
    const cache = acpRegistryCacheSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    return { ok: true, stale: true, fetchedAt: cache.fetchedAt, sourceUrl: cache.sourceUrl, indexVersion: cache.index.version, agents: cache.agents }
  } catch { return undefined }
}

function writeCache(text: string, fetchedAt: number): void {
  const path = ensureWithinUserData(cachePath())
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  try {
    writeFileSync(temporary, text, 'utf8')
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true })
  }
}

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) return response.text()
  const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > MAX_REGISTRY_BYTES) throw new Error(`官方目录超过 ${MAX_REGISTRY_BYTES / 1024 / 1024} MiB 上限`)
    chunks.push(buffer)
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
}

async function fetchCatalog(): Promise<AcpRegistryCatalogState> {
  const response = await proxiedFetch(ACP_REGISTRY_URL, { redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`官方目录请求失败（HTTP ${response.status}）`)
  const text = await readBoundedBody(response)
  const decoded = decodeIndex(text)
  const fetchedAt = Date.now()
  writeCache(JSON.stringify({ schemaVersion: 1, sourceUrl: ACP_REGISTRY_URL, fetchedAt, index: decoded.index, agents: decoded.agents }), fetchedAt)
  return { ok: true, stale: false, fetchedAt, sourceUrl: ACP_REGISTRY_URL, indexVersion: decoded.index.version, agents: decoded.agents }
}

export async function listAcpRegistryCatalog(refresh = false): Promise<AcpRegistryCatalogState> {
  if (refresh && !inFlight) {
    inFlight = fetchCatalog().finally(() => { inFlight = undefined })
  }
  if (inFlight) {
    try { return await inFlight }
    catch (error) {
      const cached = readCache()
      if (cached) return { ...cached, stale: true, error: `目录刷新失败，已回退本地缓存：${error instanceof Error ? error.message : String(error)}` }
      return { ok: false, stale: false, sourceUrl: ACP_REGISTRY_URL, agents: [], error: error instanceof Error ? error.message : String(error) }
    }
  }
  return readCache() ?? { ok: false, stale: false, sourceUrl: ACP_REGISTRY_URL, agents: [], error: '尚未取得有效目录缓存' }
}

export function searchAcpRegistryCatalog(input: unknown): AcpRegistryCatalogState {
  const parsed = acpRegistryQuerySchema.parse(input ?? {})
  const catalog = readCache()
  if (!catalog) return { ok: false, stale: false, sourceUrl: ACP_REGISTRY_URL, agents: [], error: '尚未取得有效目录缓存' }
  const terms = (parsed.query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  const agents = catalog.agents.filter(agent => {
    const haystack = [agent.id, agent.name, agent.description, ...(agent.authors ?? [])].join('\n').toLowerCase()
    return terms.every(term => haystack.includes(term))
  }).slice(0, parsed.limit)
  return { ...catalog, agents }
}

export function registryAgent(runtimeId: string): AcpRegistryAgent | undefined {
  return readCache()?.agents.find(agent => agent.id === runtimeId)
}

export function providerCapabilityMatrix(runtimeId: string): { registry?: AcpRegistryAgent; local?: AcpLocalProviderRecord; matrix: AcpCapabilityMatrixItem[] } {
  const local = readLocalProviderStore().providers.find(provider => provider.id === runtimeId)
  const registry = registryAgent(local ? local.agentId : runtimeId)
  const evidence = runtimeVerificationEvidence(runtimeId)
  const negotiatedCapabilities = evidence?.capabilitiesSummary ?? []
  const has = (label: string): boolean => negotiatedCapabilities.includes(label)
  const items: AcpCapabilityMatrixItem[] = [
    { key: 'protocolVersion', registry: '未声明', status: evidence?.protocolVersion === undefined ? 'unknown' : 'negotiated', ...(evidence?.protocolVersion === undefined ? {} : { negotiated: `v${evidence.protocolVersion}` }) },
    { key: 'loadSession', registry: '未声明', status: has('会话恢复') ? 'negotiated' : 'unknown' },
    { key: 'imageInput', registry: '未声明', status: has('图片输入') ? 'negotiated' : 'unknown' },
    { key: 'embeddedContext', registry: '未声明', status: has('内嵌上下文') ? 'negotiated' : 'unknown' },
    { key: 'mcp', registry: '未声明', status: has('MCP') ? 'negotiated' : 'unknown' }
  ]
  return { ...(registry ? { registry } : {}), ...(local ? { local } : {}), matrix: items }
}

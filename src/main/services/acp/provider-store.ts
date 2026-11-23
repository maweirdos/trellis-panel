import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { acpLocalProviderStoreSchema, type AcpLocalProviderRecord } from '../../../shared/acp-provider-ecosystem'

function providerStorePath(userData: string): string {
  if (!isAbsolute(userData)) throw new Error('本地 Provider 数据必须保存在应用数据目录')
  return join(userData, 'acp', 'providers.json')
}

export function readLocalProviderStore(userData: string): { schemaVersion: 1; providers: AcpLocalProviderRecord[] } {
  const path = providerStorePath(userData)
  if (!existsSync(path)) return { schemaVersion: 1, providers: [] }
  const store = acpLocalProviderStoreSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  if (new Set(store.providers.map(provider => provider.id.toLowerCase())).size !== store.providers.length) throw new Error('本地 provider 存储存在重复 ID')
  if (new Set(store.providers.map(provider => provider.agentId.toLowerCase())).size !== store.providers.length) throw new Error('本地 provider 存在重复 agent ID')
  return store
}

export function writeLocalProviderStore(userData: string, store: { schemaVersion: 1; providers: AcpLocalProviderRecord[] }): void {
  const path = providerStorePath(userData)
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  try {
    writeFileSync(temporary, JSON.stringify(store, null, 2), 'utf8')
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true })
  }
}

export type StorageCacheId = 'electron-session' | 'model-catalog' | 'zcode'
export type StorageCacheStatus = 'available' | 'unavailable' | 'error'

export interface StorageCacheItem {
  id: StorageCacheId
  status: StorageCacheStatus
  bytes: number | null
  requiresExplicitChoice: boolean
  reason?: string
}

export interface StorageScanResult {
  busy: boolean
  userDataPath: string
  dataBytes: number | null
  dataIncomplete: boolean
  items: StorageCacheItem[]
}

export interface StorageCleanInput {
  ids: StorageCacheId[]
  includeModelCatalog?: boolean
}

export interface StorageCleanItem {
  id: StorageCacheId
  status: 'cleaned' | 'unavailable' | 'failed' | 'skipped'
  bytesFreed: number | null
  reason?: string
}

export interface StorageCleanResult {
  busy: boolean
  items: StorageCleanItem[]
}

export interface StorageApi {
  scan: () => Promise<StorageScanResult>
  clean: (input: StorageCleanInput) => Promise<StorageCleanResult>
  openDataDirectory: () => Promise<{ ok: boolean; error?: string }>
}

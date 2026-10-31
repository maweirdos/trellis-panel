import { app, session, shell } from 'electron'
import { lstatSync, realpathSync, unlinkSync } from 'node:fs'
import { lstat, opendir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { StorageCacheItem, StorageCleanItem, StorageCleanResult, StorageScanResult } from '../../shared/storage'

const cleanInput = z.object({
  ids: z.array(z.enum(['electron-session', 'model-catalog', 'zcode'])).max(3),
  includeModelCatalog: z.boolean().optional()
}).strict().refine(input => new Set(input.ids).size === input.ids.length, 'Duplicate cache category')

let busy = false
const zcodeReason = 'ZCode 启动缓存可能正在被其他进程使用，无法保证安全清理。'
const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const pathKey = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path

// Only this exact, application-owned file is eligible; never accept a path from IPC.
// The root may itself be a configured symlink, but the cache file must not be one.
function inspectModelCatalog(): { path: string; bytes: number; identity: string } | null {
  const root = realpathSync.native(app.getPath('userData'))
  const path = join(root, 'models-dev.json')
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('模型目录缓存不是安全的普通文件。')
  if (pathKey(realpathSync.native(path)) !== pathKey(path)) throw new Error('模型目录缓存路径已重定向。')
  if (pathKey(realpathSync.native(app.getPath('userData'))) !== pathKey(root)) throw new Error('应用数据目录已变更。')
  return { path, bytes: stat.size, identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` }
}

function modelScan(): StorageCacheItem {
  try {
    const file = inspectModelCatalog()
    return { id: 'model-catalog', status: 'available', bytes: file?.bytes ?? 0, requiresExplicitChoice: true }
  } catch (error) {
    return { id: 'model-catalog', status: 'error', bytes: null, requiresExplicitChoice: true, reason: reason(error) }
  }
}

// Count logical file sizes without following links. A bounded scan can be partial
// on large, changing or inaccessible profiles and is never a deletion inventory.
async function dataUsage(root: string): Promise<{ bytes: number | null; incomplete: boolean }> {
  let bytes = 0, count = 0, incomplete = false
  const deadline = Date.now() + 4000
  const queue = [root]
  try {
    while (queue.length) {
      if (Date.now() >= deadline || count >= 20000) { incomplete = true; break }
      const dirPath = queue.pop()
      if (!dirPath) break
      try {
        const stat = await lstat(dirPath)
        if (stat.isSymbolicLink() || !stat.isDirectory()) { incomplete = true; continue }
        const directory = await opendir(dirPath)
        for await (const entry of directory) {
          if (++count > 20000 || Date.now() >= deadline) { incomplete = true; break }
          const path = join(dirPath, entry.name)
          try {
            const file = await lstat(path)
            if (file.isSymbolicLink()) { incomplete = true; continue }
            if (file.isDirectory()) queue.push(path)
            else if (file.isFile()) bytes += file.size
          } catch { incomplete = true }
        }
      } catch { incomplete = true }
    }
    return { bytes, incomplete }
  } catch { return { bytes: null, incomplete: true } }
}

export async function scanStorage(): Promise<StorageScanResult> {
  const userDataPath = app.getPath('userData')
  if (busy) return { busy: true, userDataPath, dataBytes: null, dataIncomplete: true, items: [] }
  busy = true
  try {
    let electron: StorageCacheItem
    try {
      electron = { id: 'electron-session', status: 'available', bytes: await session.defaultSession.getCacheSize(), requiresExplicitChoice: false }
    } catch (error) {
      electron = { id: 'electron-session', status: 'error', bytes: null, requiresExplicitChoice: false, reason: reason(error) }
    }
    const usage = await dataUsage(userDataPath)
    return { busy: false, userDataPath, dataBytes: usage.bytes, dataIncomplete: usage.incomplete, items: [electron, modelScan(), { id: 'zcode', status: 'unavailable', bytes: null, requiresExplicitChoice: false, reason: zcodeReason }] }
  } finally {
    busy = false
  }
}

function cleanModelCatalog(): StorageCleanItem {
  try {
    const before = inspectModelCatalog()
    if (!before) return { id: 'model-catalog', status: 'cleaned', bytesFreed: 0 }
    const current = inspectModelCatalog()
    if (!current || current.path !== before.path || current.identity !== before.identity) throw new Error('模型目录缓存在清理前发生变化。')
    unlinkSync(current.path)
    return { id: 'model-catalog', status: 'cleaned', bytesFreed: current.bytes }
  } catch (error) {
    return { id: 'model-catalog', status: 'failed', bytesFreed: null, reason: reason(error) }
  }
}

export async function cleanStorage(input: unknown): Promise<StorageCleanResult> {
  const parsed = cleanInput.parse(input)
  if (busy) return { busy: true, items: [] }
  busy = true
  try {
    const items: StorageCleanItem[] = []
    for (const id of parsed.ids) {
      if (id === 'zcode') {
        items.push({ id, status: 'unavailable', bytesFreed: null, reason: zcodeReason })
      } else if (id === 'model-catalog') {
        items.push(parsed.includeModelCatalog === true ? cleanModelCatalog() : { id, status: 'skipped', bytesFreed: null, reason: '清理模型离线缓存需要单独确认。' })
      } else {
        try {
          await session.defaultSession.clearCache()
          // Concurrent network activity means before/after sizes cannot prove bytes freed.
          items.push({ id, status: 'cleaned', bytesFreed: null })
        } catch (error) {
          items.push({ id, status: 'failed', bytesFreed: null, reason: reason(error) })
        }
      }
    }
    return { busy: false, items }
  } finally {
    busy = false
  }
}

export async function openDataDirectory(): Promise<{ ok: boolean; error?: string }> {
  try {
    const error = await shell.openPath(app.getPath('userData'))
    return error ? { ok: false, error } : { ok: true }
  } catch (error) {
    return { ok: false, error: reason(error) }
  }
}

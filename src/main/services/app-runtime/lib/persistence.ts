import { app, safeStorage } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalDirectory } from '../../acp/metadata'
import { atomicWriteText } from '../../local-task/prd'
import { AppRuntimeError, projectStoreSchema, type ProjectStore } from '../types'
import { IpcErrorCode } from '../../../../shared/ipc-errors'

export { canonicalDirectory }
export function runtimeDirectory(): string { return join(app.getPath('userData'), app.isPackaged ? 'app-runtimes' : 'app-runtimes-dev') }
export function projectFile(root: string): string { return join(runtimeDirectory(), `${createHash('sha256').update(canonicalDirectory(root)).digest('hex')}.json`) }
export function readProject(root: string): ProjectStore {
  const canonical = canonicalDirectory(root)
  const file = projectFile(canonical)
  if (!existsSync(file)) return { schemaVersion: 1, root: canonical, applications: [] }
  try {
    if (statSync(file).size > 8 * 1024 * 1024) throw new Error('size')
    const parsed = projectStoreSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
    if (canonicalDirectory(parsed.root) !== canonical || new Set(parsed.applications.map((entry) => entry.config.id)).size !== parsed.applications.length) throw new Error('identity')
    return parsed
  } catch { throw new AppRuntimeError('应用配置文件无效或版本不受支持，原文件已保留', IpcErrorCode.Io) }
}
export function writeProject(store: ProjectStore): void {
  try {
    const content = JSON.stringify(projectStoreSchema.parse(store), null, 2)
    if (Buffer.byteLength(content, 'utf8') > 8 * 1024 * 1024) throw new Error('size')
    atomicWriteText(projectFile(store.root), content)
  }
  catch { throw new AppRuntimeError('应用配置未能保存，请检查本地数据目录权限', IpcErrorCode.Io) }
}
export function listProjectRoots(): string[] {
  const directory = runtimeDirectory()
  if (!existsSync(directory)) return []
  const roots: string[] = []
  for (const name of readdirSync(directory)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
    try {
      const file = join(directory, name)
      if (statSync(file).size > 8 * 1024 * 1024) continue
      const store = projectStoreSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
      if (projectFile(store.root) === file) roots.push(store.root)
    } catch { /* A corrupt project is reported when opened; never overwrite it. */ }
  }
  return roots
}
export function protect(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new AppRuntimeError('系统加密不可用，请改用环境文件或恢复系统凭据加密', IpcErrorCode.Denied)
  return safeStorage.encryptString(value).toString('base64')
}
export function reveal(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new AppRuntimeError('系统加密不可用，无法读取已保存的环境覆盖', IpcErrorCode.Denied)
  try { return safeStorage.decryptString(Buffer.from(value, 'base64')) }
  catch { throw new AppRuntimeError('环境覆盖解密失败，请重新填写', IpcErrorCode.Denied) }
}

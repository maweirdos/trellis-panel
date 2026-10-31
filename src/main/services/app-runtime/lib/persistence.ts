import { app } from 'electron'
import { protectedStorage as safeStorage } from '../../../daemon/protected-storage'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalDirectory } from '../../acp/metadata'
import { atomicWriteText } from '../../local-task/prd'
import { AppRuntimeError, projectStoreSchema, type ProjectStore } from '../types'
import { IpcErrorCode } from '../../../../shared/ipc-errors'
import { processIdentitySignature } from './process-tree'

export { canonicalDirectory }
export function runtimeDirectory(): string { return join(app.getPath('userData'), app.isPackaged ? 'app-runtimes' : 'app-runtimes-dev') }
export function projectFile(root: string): string { return join(runtimeDirectory(), `${createHash('sha256').update(canonicalDirectory(root)).digest('hex')}.json`) }
export function readProject(root: string): ProjectStore {
  const canonical = canonicalDirectory(root)
  const file = projectFile(canonical)
  if (!existsSync(file)) return { schemaVersion: 2, root: canonical, applications: [] }
  try {
    if (statSync(file).size > 8 * 1024 * 1024) throw new Error('size')
    const parsed = projectStoreSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
    if (canonicalDirectory(parsed.root) !== canonical || new Set(parsed.applications.map((entry) => entry.config.id)).size !== parsed.applications.length) throw new Error('identity')
    let migratedIdentity = false
    for (const entry of parsed.applications) {
      const run = entry.lastRun
      if (run?.container && (run.container.directory !== join(runtimeDirectory(), 'process-jobs') || run.container.owner.kind !== 'application'
        || run.container.owner.id !== entry.config.id || run.container.owner.generation !== run.id || run.pidRole !== 'supervisor'
        || run.snapshot.status === 'known' && run.container.root !== run.snapshot.cwd)) throw new Error('application container identity')
      const mutation = entry.consumerMutation
      if (mutation && (mutation.runId !== run?.id || mutation.original.lease.owner.kind !== 'application' || mutation.original.lease.owner.id !== entry.config.id
        || mutation.original.lease.owner.generation !== mutation.runId || mutation.original.lease.token !== run?.workcopy?.lease.token
        || mutation.original.root !== run.workcopy.root || !entry.taskServiceUses.some(use => use.id === mutation.referenceId && use.runId === mutation.runId))) throw new Error('consumer mutation identity')
      const removal = entry.consumerRemoval
      if (removal && (removal.runId !== run?.id || removal.original.lease.owner.kind !== 'application' || removal.original.lease.owner.id !== entry.config.id
        || removal.original.lease.owner.generation !== removal.runId || removal.original.lease.token !== run?.workcopy?.lease.token
        || removal.original.root !== run.workcopy.root || !entry.taskServiceUses.some(use => use.id === removal.referenceId && use.runId === removal.runId))) throw new Error('consumer removal identity')
      for (const identity of run?.identities ?? []) {
        const signature = processIdentitySignature(identity)
        if (identity.commandHash !== signature) { identity.commandHash = signature; migratedIdentity = true }
      }
      if (parsed.schemaVersion === 1 && run) run.snapshot = { status: 'unknown', reason: 'legacy-record' }
      if (run?.snapshot.status === 'known' && (run.snapshot.root !== parsed.root || run.snapshot.appId !== entry.config.id || run.snapshot.runId !== run.id || run.snapshot.startedAt !== run.startedAt || !run.policy)) throw new Error('snapshot identity')
    }
    if (migratedIdentity) writeProject(parsed)
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
  return discoverProjects().roots
}
export function discoverProjects(): { roots: string[]; unavailableProjects: number } {
  const directory = runtimeDirectory()
  if (!existsSync(directory)) return { roots: [], unavailableProjects: 0 }
  const roots: string[] = []
  let unavailableProjects = 0
  for (const name of readdirSync(directory)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
    try {
      const file = join(directory, name)
      if (statSync(file).size > 8 * 1024 * 1024) throw new Error('size')
      const store = projectStoreSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
      if (projectFile(store.root) !== file) throw new Error('identity')
      roots.push(store.root)
    } catch { unavailableProjects += 1 }
  }
  return { roots, unavailableProjects }
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

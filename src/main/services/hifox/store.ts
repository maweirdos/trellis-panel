/**
 * HiFox 本地协作快照：写事务复制后原子替换 JSON 文件，读取不暴露缓存引用。
 * 损坏文件报错保留；HIFOX_STORE_DIR 用于隔离服务回归的存储目录。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { hifoxSnapshotSchema as snapshotSchema } from '../../../shared/hifox-schema'
import { configureHifoxDomainStore } from '../../../shared/hifox-domain/store'
import type { HifoxSnapshot } from '../../../shared/hifox'
import { buildInitialSnapshot, buildSeedSnapshot } from './seed'

let cache: HifoxSnapshot | null = null
let cacheFile: string | null = null
let writing = false
const authorityObservers = new Set<() => void>()

/** Subscribe to committed local authority changes, including explicit resets. */
export function onLocalHifoxAuthorityChanged(observer: () => void): () => void {
  authorityObservers.add(observer)
  return () => { authorityObservers.delete(observer) }
}

function authorityFingerprint(snapshot: HifoxSnapshot): string {
  const members = snapshot.members.map((member) => [member.id, member.role, [...(member.projectRoles ?? [])].sort()] as const)
    .sort((left, right) => left[0].localeCompare(right[0]))
  const spaces = snapshot.spaces.map((space) => [space.id, space.ownerId ?? null, space.visibility ?? 'public', Boolean(space.archived), [...space.memberIds].sort()] as const)
    .sort((left, right) => left[0].localeCompare(right[0]))
  return JSON.stringify([snapshot.members.find((member) => member.role === 'owner')?.id ?? null, members, spaces])
}

function notifyAuthorityChanged(): void {
  for (const observer of authorityObservers) {
    try { observer() } catch { process.emitWarning('Local collaboration authority notification failed', { code: 'HIFOX_AUTHORITY_NOTIFICATION' }) }
  }
}

function storeDir(): string {
  const override = process.env.HIFOX_STORE_DIR
  if (override) return override
  // 延迟 require，保持服务层可在无 Electron 测试环境加载
  const { app } = require('electron') as typeof import('electron')
  return join(app.getPath('userData'), 'hifox')
}

function storeFile(): string {
  return resolve(storeDir(), 'store.json')
}

export function loadSnapshot(): HifoxSnapshot {
  const file = storeFile()
  if (cache && cacheFile === file) return structuredClone(cache)
  let snapshot: HifoxSnapshot
  if (existsSync(file)) {
    try {
      const raw: unknown = JSON.parse(readFileSync(file, 'utf-8'))
      const parsed = snapshotSchema.safeParse(raw)
      if (!parsed.success) throw new Error('快照结构不合法')
      snapshot = raw as HifoxSnapshot
    } catch (error) {
      const detail = error instanceof Error ? error.message : '读取失败'
      throw new Error(`HiFox 数据读取失败，原文件已保留：${detail}`)
    }
  } else {
    snapshot = buildInitialSnapshot()
    persist(snapshot)
  }
  cache = snapshot
  cacheFile = file
  return structuredClone(snapshot)
}

export function resetDemoSnapshot(): HifoxSnapshot {
  if (writing) throw new Error('HiFox 写事务中不能重置数据')
  const snapshot = buildSeedSnapshot()
  persist(snapshot)
  cache = snapshot
  cacheFile = storeFile()
  notifyAuthorityChanged()
  return structuredClone(snapshot)
}

function persist(snapshot: HifoxSnapshot): void {
  const dir = storeDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = storeFile()
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf-8')
  renameSync(tmp, file)
}

/** Copy on write: validation and disk failures cannot change the committed cache. */
export function mutate<T>(fn: (draft: HifoxSnapshot) => T): { result: T; snapshot: HifoxSnapshot } {
  if (writing) throw new Error('HiFox 不支持嵌套写事务')
  const draft = loadSnapshot()
  const previousAuthority = authorityFingerprint(draft)
  writing = true
  try {
    const result = fn(draft)
    if (result instanceof Promise) throw new Error('HiFox 写事务必须同步完成')
    const validation = snapshotSchema.safeParse(draft)
    if (!validation.success) {
      const issue = validation.error.issues[0]
      throw new Error(`HiFox 数据校验失败：${issue?.path.join('.') ?? 'snapshot'} ${issue?.message ?? ''}`)
    }
    // Cache owns a separate copy, including from references retained by fn.
    const committed = structuredClone(draft)
    persist(committed)
    cache = committed
    cacheFile = storeFile()
    if (authorityFingerprint(committed) !== previousAuthority) notifyAuthorityChanged()
    return { result, snapshot: draft }
  } finally {
    writing = false
  }
}

export function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

export function nowIso(): string {
  return new Date().toISOString()
}

configureHifoxDomainStore({ loadSnapshot, mutate })

/**
 * HiFox 协作域持久化：userData 下的单一 JSON 快照存储。
 * 设计取舍：无数据库（PRD 逆向整理阶段同样不涉及表流转），原子写 + 全量快照，
 * 规模与面板演示场景匹配；后续可平移到 SQLite。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { HifoxSnapshot } from '../../../shared/hifox'
import { buildSeedSnapshot } from './seed'

let cache: HifoxSnapshot | null = null

function storeDir(): string {
  const override = process.env.HIFOX_STORE_DIR
  if (override) return override
  // 延迟 require，保持服务层可在无 Electron 测试环境加载
  const { app } = require('electron') as typeof import('electron')
  return join(app.getPath('userData'), 'hifox')
}

function storeFile(): string {
  return join(storeDir(), 'store.json')
}

export function loadSnapshot(): HifoxSnapshot {
  if (cache) return cache
  const file = storeFile()
  try {
    if (existsSync(file)) {
      cache = JSON.parse(readFileSync(file, 'utf-8')) as HifoxSnapshot
      return cache
    }
  } catch {
    // 损坏则回落到种子重建
  }
  cache = buildSeedSnapshot()
  persist(cache)
  return cache
}

export function resetDemoSnapshot(): HifoxSnapshot {
  cache = buildSeedSnapshot()
  persist(cache)
  return cache
}

function persist(snapshot: HifoxSnapshot): void {
  const dir = storeDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = storeFile()
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf-8')
  renameSync(tmp, file)
}

/** 所有写操作走这里：改内存快照 → 落盘 → 返回新快照引用 */
export function mutate<T>(fn: (draft: HifoxSnapshot) => T): { result: T; snapshot: HifoxSnapshot } {
  const draft = loadSnapshot()
  const result = fn(draft)
  persist(draft)
  cache = draft
  return { result, snapshot: draft }
}

export function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

export function nowIso(): string {
  return new Date().toISOString()
}

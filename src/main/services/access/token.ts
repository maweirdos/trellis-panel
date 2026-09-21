import { randomBytes } from 'crypto'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

/**
 * 接入协议 Bearer token：持久化于 userData，进程重启不变（外部工具配置一次即可）。
 * rotate 生成新值覆盖旧值——旧 token 立即失效。
 */
const TOKEN_FILE = 'access-token'

function tokenPath(): string {
  return join(app.getPath('userData'), TOKEN_FILE)
}

let cached: string | null = null

function generate(): string {
  return randomBytes(32).toString('hex')
}

export function getAccessToken(): string {
  if (cached) return cached
  try {
    if (existsSync(tokenPath())) {
      const existing = readFileSync(tokenPath(), 'utf-8').trim()
      if (/^[0-9a-f]{64}$/.test(existing)) {
        cached = existing
        return cached
      }
    }
  } catch {
    // fall through to regenerate
  }
  cached = generate()
  persist(cached)
  return cached
}

export function rotateAccessToken(): string {
  cached = generate()
  persist(cached)
  return cached
}

function persist(token: string): void {
  try {
    writeFileSync(tokenPath(), token + '\n', 'utf-8')
  } catch {
    // persistence failure keeps the in-memory token for this session
  }
}

export function verifyToken(candidate: string | undefined | null): boolean {
  if (!candidate) return false
  const expected = getAccessToken()
  if (candidate.length !== expected.length) return false
  // 常量时间比较，避免逐字节短路泄露前缀
  let diff = 0
  for (let i = 0; i < expected.length; i += 1) {
    diff |= candidate.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

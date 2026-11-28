import { closeSync, existsSync, openSync, readdirSync, readSync, statSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  ConversationProviderUsageSnapshot,
  ConversationUsageLimitsReport,
  ConversationUsageWindow,
} from '../../../../shared/conversation/usageLimits'

const CACHE_TTL_MS = 15_000
const MAX_SCAN_FILES = 36
const MAX_TAIL_BYTES = 512 * 1024
const WINDOW_24H_MS = 24 * 60 * 60_000
const MAX_DIR_DEPTH = 5

let cachedReport: { readonly expiresAt: number; readonly report: ConversationUsageLimitsReport } | null = null

interface FileCandidate {
  readonly path: string
  readonly mtimeMs: number
  readonly size: number
}

interface ParsedCodexRateLimits {
  readonly timestampMs: number
  readonly planType?: string | null
  readonly primary?: { readonly usedPercent: number; readonly resetsAt: string | null; readonly windowMinutes?: number }
  readonly secondary?: { readonly usedPercent: number; readonly resetsAt: string | null; readonly windowMinutes?: number }
}

interface ParsedTokenDelta {
  readonly timestampMs: number
  readonly inputTokens: number
  readonly cachedInputTokens: number
  readonly outputTokens: number
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function toIsoFromEpochOrIso(value: unknown): string | null {
  const ms = parseTimestampMs(value)
  if (ms === null) return null
  const date = new Date(ms)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function clampPercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10))
}

function collectRecentJsonlFiles(rootDir: string, minMtimeMs: number): readonly FileCandidate[] {
  if (!existsSync(rootDir)) return []
  const candidates: FileCandidate[] = []

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DIR_DEPTH) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const st = statSync(fullPath)
          if (st.mtimeMs >= minMtimeMs && st.size > 0) {
            candidates.push({ path: fullPath, mtimeMs: st.mtimeMs, size: st.size })
          }
        } catch {
          // 跳过并发删除或不可读文件
        }
      }
    }
  }

  walk(rootDir, 0)
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return candidates.slice(0, MAX_SCAN_FILES)
}

function readTailLines(filePath: string, size: number): readonly string[] {
  const readBytes = Math.min(size, MAX_TAIL_BYTES)
  const start = Math.max(0, size - readBytes)
  const buffer = Buffer.allocUnsafe(readBytes)
  let fd: number | null = null
  try {
    fd = openSync(filePath, 'r')
    const bytesRead = readSync(fd, buffer, 0, readBytes, start)
    const text = buffer.toString('utf8', 0, bytesRead)
    const lines = text.split(/\r?\n/)
    if (start > 0 && lines.length > 0) lines.shift()
    return lines
  } catch {
    return []
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}

export function parseCodexSessionLine(line: string): {
  readonly rateLimits?: ParsedCodexRateLimits
  readonly tokenUsage?: ParsedTokenDelta
} {
  if (!line || (!line.includes('token_count') && !line.includes('rate_limits'))) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object') return {}
  const record = parsed as Record<string, unknown>
  const payload = record.payload && typeof record.payload === 'object'
    ? (record.payload as Record<string, unknown>)
    : record
  const timestampMs = parseTimestampMs(record.timestamp ?? payload.timestamp) ?? Date.now()

  let rateLimits: ParsedCodexRateLimits | undefined
  const rawLimits = (payload.rate_limits ?? record.rate_limits) as Record<string, unknown> | undefined
  if (rawLimits && typeof rawLimits === 'object') {
    const parseWindow = (raw: unknown): { readonly usedPercent: number; readonly resetsAt: string | null; readonly windowMinutes?: number } | undefined => {
      if (!raw || typeof raw !== 'object') return undefined
      const win = raw as Record<string, unknown>
      const usedPercent = clampPercent(win.used_percent ?? win.usedPercent)
      if (usedPercent === null) return undefined
      const resetsAt = toIsoFromEpochOrIso(win.resets_at ?? win.resetsAt)
      const windowMinutes = typeof win.window_minutes === 'number' && Number.isFinite(win.window_minutes)
        ? win.window_minutes
        : undefined
      return { usedPercent, resetsAt, ...(windowMinutes ? { windowMinutes } : {}) }
    }
    const primary = parseWindow(rawLimits.primary)
    const secondary = parseWindow(rawLimits.secondary)
    if (primary || secondary) {
      rateLimits = {
        timestampMs,
        planType: typeof rawLimits.plan_type === 'string' ? rawLimits.plan_type : null,
        primary,
        secondary,
      }
    }
  }

  let tokenUsage: ParsedTokenDelta | undefined
  const info = payload.info && typeof payload.info === 'object' ? (payload.info as Record<string, unknown>) : null
  const lastUsage = info?.last_token_usage && typeof info.last_token_usage === 'object'
    ? (info.last_token_usage as Record<string, unknown>)
    : null
  if (lastUsage) {
    const inputTokens = nonNegativeInt(lastUsage.input_tokens)
    const cachedInputTokens = nonNegativeInt(lastUsage.cached_input_tokens)
    const outputTokens = nonNegativeInt(lastUsage.output_tokens)
    if (inputTokens > 0 || outputTokens > 0) {
      tokenUsage = { timestampMs, inputTokens, cachedInputTokens, outputTokens }
    }
  }

  return { rateLimits, tokenUsage }
}

export function parseClaudeSessionLine(line: string): ParsedTokenDelta | null {
  if (!line || !line.includes('"usage"')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  if (record.type !== 'assistant') return null
  const message = record.message && typeof record.message === 'object' ? (record.message as Record<string, unknown>) : null
  const usage = message?.usage && typeof message.usage === 'object' ? (message.usage as Record<string, unknown>) : null
  if (!usage) return null
  const timestampMs = parseTimestampMs(record.timestamp) ?? Date.now()
  const inputTokens = nonNegativeInt(usage.input_tokens) + nonNegativeInt(usage.cache_creation_input_tokens) + nonNegativeInt(usage.cache_read_input_tokens)
  const cachedInputTokens = nonNegativeInt(usage.cache_read_input_tokens)
  const outputTokens = nonNegativeInt(usage.output_tokens)
  if (inputTokens === 0 && outputTokens === 0) return null
  return { timestampMs, inputTokens, cachedInputTokens, outputTokens }
}

function formatWindowMinutesLabel(minutes: number | undefined, fallback: string): string {
  if (!minutes || minutes <= 0) return fallback
  if (minutes >= 24 * 60) {
    const days = Math.round(minutes / (24 * 60))
    return `${days} 天额度`
  }
  if (minutes >= 60) {
    const hours = Math.round(minutes / 60)
    return `${hours} 小时额度`
  }
  return `${minutes} 分钟额度`
}

function scanCodexUsage(codexHome: string, nowMs: number): ConversationProviderUsageSnapshot {
  const sessionsDir = join(codexHome, 'sessions')
  const cutoff24h = nowMs - WINDOW_24H_MS
  const cutoff7d = nowMs - 7 * WINDOW_24H_MS
  const files = collectRecentJsonlFiles(sessionsDir, cutoff7d)

  let latestLimits: ParsedCodexRateLimits | null = null
  let inputTokens = 0
  let cachedInputTokens = 0
  let outputTokens = 0
  const recentSessionPaths = new Set<string>()

  for (const file of files) {
    const lines = readTailLines(file.path, file.size)
    for (const line of lines) {
      const parsed = parseCodexSessionLine(line)
      if (parsed.rateLimits && (!latestLimits || parsed.rateLimits.timestampMs >= latestLimits.timestampMs)) {
        latestLimits = parsed.rateLimits
      }
      if (parsed.tokenUsage && parsed.tokenUsage.timestampMs >= cutoff24h) {
        inputTokens += parsed.tokenUsage.inputTokens
        cachedInputTokens += parsed.tokenUsage.cachedInputTokens
        outputTokens += parsed.tokenUsage.outputTokens
        recentSessionPaths.add(file.path)
      }
    }
  }

  const windows: ConversationUsageWindow[] = []
  if (latestLimits?.primary) {
    windows.push({
      id: 'primary',
      label: formatWindowMinutesLabel(latestLimits.primary.windowMinutes, '5 小时额度'),
      usedPercent: latestLimits.primary.usedPercent,
      resetsAt: latestLimits.primary.resetsAt,
    })
  }
  if (latestLimits?.secondary) {
    windows.push({
      id: 'secondary',
      label: formatWindowMinutesLabel(latestLimits.secondary.windowMinutes, '7 天额度'),
      usedPercent: latestLimits.secondary.usedPercent,
      resetsAt: latestLimits.secondary.resetsAt,
    })
  }

  const totalTokens = inputTokens + outputTokens
  const hasAny = windows.length > 0 || totalTokens > 0

  return {
    provider: 'codex',
    label: 'Codex',
    plan: latestLimits?.planType ?? null,
    available: hasAny,
    source: windows.length > 0 ? 'rate-limit' : totalTokens > 0 ? 'local-transcripts' : 'unavailable',
    windows,
    ...(totalTokens > 0 ? {
      recentTokens24h: {
        inputTokens,
        outputTokens,
        cachedInputTokens,
        totalTokens,
        sessions: recentSessionPaths.size,
      },
    } : {}),
    ...(!hasAny ? { note: '暂未检测到最近 7 天的 Codex 本地用量记录。' } : {}),
  }
}

function scanClaudeUsage(claudeHome: string, nowMs: number): ConversationProviderUsageSnapshot {
  const projectsDir = join(claudeHome, 'projects')
  const cutoff24h = nowMs - WINDOW_24H_MS
  const files = collectRecentJsonlFiles(projectsDir, cutoff24h)

  let inputTokens = 0
  let cachedInputTokens = 0
  let outputTokens = 0
  const recentSessionPaths = new Set<string>()

  for (const file of files) {
    const lines = readTailLines(file.path, file.size)
    for (const line of lines) {
      const parsed = parseClaudeSessionLine(line)
      if (!parsed || parsed.timestampMs < cutoff24h) continue
      inputTokens += parsed.inputTokens
      cachedInputTokens += parsed.cachedInputTokens
      outputTokens += parsed.outputTokens
      recentSessionPaths.add(file.path)
    }
  }

  const totalTokens = inputTokens + outputTokens
  return {
    provider: 'claude',
    label: 'Claude Code',
    available: totalTokens > 0,
    source: totalTokens > 0 ? 'local-transcripts' : 'unavailable',
    windows: [],
    ...(totalTokens > 0 ? {
      recentTokens24h: {
        inputTokens,
        outputTokens,
        cachedInputTokens,
        totalTokens,
        sessions: recentSessionPaths.size,
      },
    } : {}),
    ...(totalTokens === 0 ? { note: '暂未检测到最近 24 小时的 Claude 本地用量记录。' } : {}),
  }
}

export function readConversationUsageLimits(options?: {
  readonly codexHome?: string
  readonly claudeHome?: string
  readonly nowMs?: number
  readonly bypassCache?: boolean
}): ConversationUsageLimitsReport {
  const nowMs = options?.nowMs ?? Date.now()
  const customPaths = Boolean(options?.codexHome || options?.claudeHome)
  if (!customPaths && !options?.bypassCache && cachedReport && cachedReport.expiresAt > nowMs) {
    return cachedReport.report
  }
  const home = homedir()
  const codexHome = options?.codexHome ?? (process.env.CODEX_HOME?.trim() || join(home, '.codex'))
  const claudeHome = options?.claudeHome ?? (process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude'))

  const report: ConversationUsageLimitsReport = {
    collectedAt: new Date(nowMs).toISOString(),
    providers: [
      scanCodexUsage(codexHome, nowMs),
      scanClaudeUsage(claudeHome, nowMs),
    ],
  }

  if (!customPaths) {
    cachedReport = { expiresAt: nowMs + CACHE_TTL_MS, report }
  }
  return report
}

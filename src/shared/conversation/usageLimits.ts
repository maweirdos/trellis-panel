export interface ConversationUsageWindow {
  readonly id: string
  readonly label: string
  readonly usedPercent: number | null
  readonly resetsAt: string | null
  readonly detail?: string
}

export interface ConversationRecentTokenTotals {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedInputTokens: number
  readonly totalTokens: number
  readonly sessions: number
}

export interface ConversationProviderUsageSnapshot {
  readonly provider: 'codex' | 'claude' | string
  readonly label: string
  readonly plan?: string | null
  readonly available: boolean
  readonly source: 'rate-limit' | 'local-transcripts' | 'unavailable'
  readonly windows: readonly ConversationUsageWindow[]
  readonly recentTokens24h?: ConversationRecentTokenTotals
  readonly note?: string
}

export interface ConversationUsageLimitsReport {
  readonly collectedAt: string
  readonly providers: readonly ConversationProviderUsageSnapshot[]
}

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { Gauge, RefreshCw } from 'lucide-react'
import type { ConversationUsageLimitsReport } from '../../../shared/conversation/usageLimits'
import { api, hasIpc } from '../api'
import { Dropdown } from '../my/ui'
import './conversation-enhancements.css'

const POLL_INTERVAL_MS = 90_000

function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(Math.round(tokens))
}

function formatResetCountdown(iso: string | null): string | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  const diffMs = ms - Date.now()
  if (diffMs <= 0) return '即将重置'
  const minutes = Math.ceil(diffMs / 60_000)
  if (minutes < 60) return `${minutes} 分钟后重置`
  const hours = Math.floor(minutes / 60)
  const remMin = minutes % 60
  if (hours < 24) return remMin > 0 ? `${hours} 小时 ${remMin} 分后重置` : `${hours} 小时后重置`
  const days = Math.floor(hours / 24)
  const remHours = hours % 24
  return remHours > 0 ? `${days} 天 ${remHours} 小时后重置` : `${days} 天后重置`
}

function usageTone(percent: number | null): 'normal' | 'warning' | 'critical' {
  if (percent === null) return 'normal'
  if (percent >= 92) return 'critical'
  if (percent >= 78) return 'warning'
  return 'normal'
}

export function ComposerUsageLimits({ activeProvider }: { readonly activeProvider?: string }): JSX.Element | null {
  const [report, setReport] = useState<ConversationUsageLimitsReport | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async (force = false): Promise<void> => {
    if (!hasIpc || typeof api.conversationUsageLimits !== 'function') return
    setLoading(true)
    try {
      const response = await api.conversationUsageLimits(force ? { refresh: true } : undefined)
      if (response.ok) setReport(response.report)
    } catch {
      // 配额监控仅作辅助显示，失败时静默降级不阻断对话
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!hasIpc || typeof api.conversationUsageLimits !== 'function') return
    void refresh(false)
    const timer = window.setInterval(() => void refresh(false), POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [refresh])

  const summary = useMemo(() => {
    if (!report) return null
    const preferred = report.providers.find(
      (provider) => provider.available && activeProvider && provider.provider === activeProvider,
    ) ?? report.providers.find((provider) => provider.available && provider.windows.length > 0)
      ?? report.providers.find((provider) => provider.available)
    if (!preferred) return null
    const highestWindow = preferred.windows.reduce<number | null>((max, win) => {
      if (win.usedPercent === null) return max
      return max === null ? win.usedPercent : Math.max(max, win.usedPercent)
    }, null)
    return { provider: preferred, highestPercent: highestWindow }
  }, [activeProvider, report])

  if (!hasIpc || typeof api.conversationUsageLimits !== 'function') return null

  const tone = usageTone(summary?.highestPercent ?? null)
  const badgeLabel = summary?.highestPercent !== null && summary?.highestPercent !== undefined
    ? `${Math.round(summary.highestPercent)}%`
    : null

  return (
    <Dropdown
      placement="top"
      align="right"
      width={300}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className="my-composer-control conversation-usage-trigger inline-flex shrink-0 items-center gap-1 px-1.5 text-my-xs"
          data-tone={tone}
          title={badgeLabel ? `${summary?.provider.label ?? '账号'} 配额已用 ${badgeLabel}` : '查看账号配额与本机 24 小时用量'}
          aria-label="查看账号配额与本机用量"
          aria-expanded={open}
          onClick={() => {
            if (!open && !report) void refresh(false)
            toggle()
          }}
        >
          <Gauge size={14} aria-hidden="true" />
          {badgeLabel && <span className="tabular-nums">{badgeLabel}</span>}
        </button>
      )}
    >
      {() => (
        <div className="conversation-usage-popover">
          <div className="conversation-usage-head">
            <span className="text-my-xs font-medium text-my-primary">账号配额与本机用量</span>
            <button
              type="button"
              className="my-icon-control"
              title="刷新用量统计"
              aria-label="刷新用量统计"
              disabled={loading}
              onClick={() => void refresh(true)}
            >
              <RefreshCw size={12} className={loading ? 'animate-spin motion-reduce:animate-none' : undefined} aria-hidden="true" />
            </button>
          </div>
          {!report ? (
            <p className="my-item-description">正在读取本机用量记录…</p>
          ) : (
            <div className="conversation-usage-providers">
              {report.providers.map((provider) => (
                <section key={provider.provider} className="conversation-usage-provider">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-my-xs font-medium text-my-primary">
                      {provider.label}
                      {provider.plan ? ` · ${provider.plan}` : ''}
                    </span>
                    {provider.recentTokens24h && (
                      <span className="text-my-2xs text-my-tertiary tabular-nums">
                        24h {formatCompactTokens(provider.recentTokens24h.totalTokens)} tok
                      </span>
                    )}
                  </div>
                  {provider.windows.length > 0 ? (
                    <div className="space-y-1.5">
                      {provider.windows.map((win) => {
                        const winTone = usageTone(win.usedPercent)
                        const resetText = formatResetCountdown(win.resetsAt)
                        return (
                          <div key={win.id} className="space-y-1">
                            <div className="flex items-center justify-between gap-2 text-my-2xs text-my-secondary">
                              <span>{win.label}</span>
                              <span className="tabular-nums">
                                {win.usedPercent !== null ? `${Math.round(win.usedPercent)}%` : '未知'}
                                {resetText ? ` · ${resetText}` : ''}
                              </span>
                            </div>
                            <div className="conversation-usage-bar" role="progressbar"
                              aria-label={win.label}
                              aria-valuenow={win.usedPercent ?? 0} aria-valuemin={0} aria-valuemax={100}>
                              <div
                                className="conversation-usage-bar-fill"
                                data-tone={winTone}
                                style={{ width: `${Math.max(2, Math.min(100, win.usedPercent ?? 0))}%` }}
                              />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  ) : provider.recentTokens24h ? (
                    <p className="text-my-2xs text-my-tertiary tabular-nums">
                      近 24 小时 {provider.recentTokens24h.sessions} 个会话 · 输入 {formatCompactTokens(provider.recentTokens24h.inputTokens)} / 输出 {formatCompactTokens(provider.recentTokens24h.outputTokens)}
                    </p>
                  ) : (
                    <p className="text-my-2xs text-my-tertiary">{provider.note ?? '暂无本地记录'}</p>
                  )}
                </section>
              ))}
            </div>
          )}
        </div>
      )}
    </Dropdown>
  )
}

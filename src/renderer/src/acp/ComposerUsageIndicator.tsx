import { useMemo, type JSX } from 'react'
import { Tooltip } from '../my/ui'
import { asObject } from './timeline'
import type { AcpSessionRecord, TimelineEvent } from '../../../shared/types'

/** Reported context occupancy, never a guessed model window or summed deltas. */
export function ComposerUsageIndicator({ session, events }: { session: AcpSessionRecord; events: TimelineEvent[] }): JSX.Element {
  const usage = useMemo(() => {
    const modelConfigIds = new Set(session.configOptions?.filter((option) => option.category === 'model').map((option) => option.id))
    let used: number | undefined, size: number | undefined
    let breakdown: Record<string, unknown> | undefined
    for (const event of events) {
      if (event.source !== 'acp' || event.connectionGeneration !== session.connectionGeneration) continue
      const payload = event.payload
      const input = asObject(payload?.input)
      if (event.kind === 'config' && (input?.kind === 'model' || (input?.kind === 'config' && typeof input.id === 'string' && modelConfigIds.has(input.id)))) {
        used = undefined; size = undefined; breakdown = undefined
      }
      if (payload?.tag !== 'usage_update') continue
      if (typeof payload.used === 'number' && Number.isFinite(payload.used) && payload.used >= 0) used = payload.used
      if (typeof payload.size === 'number' && Number.isFinite(payload.size) && payload.size > 0) size = payload.size
      if (asObject(payload.breakdown)) breakdown = asObject(payload.breakdown)
    }
    return { used, size, breakdown }
  }, [events, session.connectionGeneration, session.configOptions])
  const known = usage.used !== undefined && usage.size !== undefined
  const fraction = known ? (usage.used ?? 0) / (usage.size ?? 1) : undefined
  const percent = fraction === undefined ? undefined : Math.round(fraction * 1000) / 10
  const tokenDetails = [['输入', usage.breakdown?.inputTokens], ['输出', usage.breakdown?.outputTokens], ['缓存读取', usage.breakdown?.cachedReadTokens]]
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))
    .map(([name, count]) => `${name} ${count.toLocaleString()}`).join(' · ')
  const label = known ? `上下文已用 ${percent}% · ${usage.used?.toLocaleString()} / ${usage.size?.toLocaleString()} tokens${tokenDetails ? `；${tokenDetails}` : ''}`
    : `执行引擎尚未提供上下文占用${tokenDetails ? `；最近报告：${tokenDetails}` : ''}`
  const circumference = 2 * Math.PI * 7
  return <Tooltip label={label} side="top" align="right" wrap><span className="acp-usage-indicator" tabIndex={0} role="img" aria-label={label}>
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
      <circle className="acp-usage-track" cx="10" cy="10" r="7" fill="none" strokeWidth="2.4" strokeDasharray={known ? undefined : '2 2'} />
      {fraction !== undefined && <circle className="acp-usage-fill" cx="10" cy="10" r="7" fill="none" strokeWidth="2.4" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - Math.max(0, Math.min(1, fraction)))} transform="rotate(-90 10 10)" />}
    </svg>
  </span></Tooltip>
}

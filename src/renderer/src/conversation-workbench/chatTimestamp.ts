/**
 * Ported from t3code@28c58b1 apps/web/src/timestampFormat.ts (formatDayAwareTimestamp).
 * Today shows only the time, yesterday is named, older days show a numeric date first.
 */
export function formatDayAwareTimestamp(isoDate: string, nowMs: number = Date.now()): string {
  const date = new Date(isoDate)
  if (!Number.isFinite(date.getTime())) return ''
  const time = formatTime(date)
  const today = calendarDay(new Date(nowMs))
  const messageDay = calendarDay(date)
  const dayDiff = today.index - messageDay.index
  if (dayDiff <= 0) return time
  if (dayDiff === 1) return `昨天 ${time}`
  const sameYear = messageDay.year === today.year
  return `${sameYear ? '' : `${messageDay.year}/`}${date.getMonth() + 1}/${date.getDate()} ${time}`
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
}

interface CalendarDay {
  readonly year: number
  /** Days since the epoch so differences are whole days across DST shifts. */
  readonly index: number
}

function calendarDay(date: Date): CalendarDay {
  const year = date.getFullYear()
  return { year, index: Date.UTC(year, date.getMonth(), date.getDate()) / 86_400_000 }
}

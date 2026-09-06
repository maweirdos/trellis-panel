import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import { app } from 'electron'
import type { ActivityEntry, AnalyticsResult, ProjectSnapshot } from '../../shared/types'
import { statusLabelShared as statusLabel } from '../../shared/labels-shared'

const MAX_BYTES = 2 * 1024 * 1024

let logPath = ''
let prevStatuses = new Map<string, { status: string; title: string }>()

function file(): string {
  if (!logPath) {
    logPath = join(app.getPath('userData'), 'activity.jsonl')
    mkdirSync(dirname(logPath), { recursive: true })
  }
  return logPath
}

function append(entry: ActivityEntry): void {
  try {
    const p = file()
    appendFileSync(p, JSON.stringify(entry) + '\n', 'utf-8')
    // trim when oversized
    try {
      const st = statSync(p)
      if (st.size > MAX_BYTES) {
        const lines = readFileSync(p, 'utf-8').trim().split(/\r?\n/)
        const keep = lines.slice(-Math.floor(lines.length / 2)).join('\n') + '\n'
        const tmp = p + '.tmp'
        writeFileSync(tmp, keep, 'utf-8')
        renameSync(tmp, p)
      }
    } catch {
      // trim is best-effort
    }
  } catch {
    // best-effort
  }
}

/** Diff a fresh snapshot against the previous one and record status transitions. */
export function recordActivity(snap: ProjectSnapshot): void {
  const next = new Map<string, { status: string; title: string }>()
  for (const t of snap.tasks) {
    if (!t.record) continue
    const status = (t.record.status ?? '').toLowerCase()
    next.set(t.dirName, { status, title: t.record.title })
    const prev = prevStatuses.get(t.dirName)
    if (!prev) continue // first sighting — no transition (backfill covers creation)
    if (prev.status !== status) {
      append({
        ts: Date.now(),
        dir: t.dirName,
        title: t.record.title,
        from: prev.status || null,
        to: status
      })
    }
  }
  prevStatuses = next
}

function readLog(): ActivityEntry[] {
  try {
    const p = file()
    if (!existsSync(p)) return []
    return readFileSync(p, 'utf-8')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ActivityEntry)
  } catch {
    return []
  }
}

const DAY = 24 * 3600 * 1000

export function getAnalytics(snap: ProjectSnapshot): AnalyticsResult {
  const log = readLog().sort((a, b) => a.ts - b.ts)
  const now = Date.now()
  const window14 = now - 14 * DAY

  // daily transition counts (last 14 days)
  const dailyMap = new Map<string, number>()
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now - i * DAY)
    dailyMap.set(d.toISOString().slice(0, 10), 0)
  }
  for (const e of log) {
    if (e.ts < window14) continue
    const d = new Date(e.ts).toISOString().slice(0, 10)
    if (dailyMap.has(d)) dailyMap.set(d, (dailyMap.get(d) ?? 0) + 1)
  }

  // cycle time: created -> completed, per task record
  const memberMap = new Map<string, { total: number; days: number[] }>()
  let cycleSum = 0
  let cycleCount = 0
  for (const t of snap.tasks) {
    const r = t.record
    if (!r) continue
    if (['completed', 'done'].includes((r.status ?? '').toLowerCase()) && r.createdAt && r.completedAt) {
      const created = new Date(r.createdAt).getTime()
      const completed = new Date(r.completedAt).getTime()
      if (!isNaN(created) && !isNaN(completed) && completed >= created) {
        const days = (completed - created) / DAY
        cycleSum += days
        cycleCount += 1
        const who = r.assignee || r.creator || '未分配'
        const m = memberMap.get(who) ?? { total: 0, days: [] }
        m.days.push(days)
        m.total += 1
        memberMap.set(who, m)
      }
    }
  }

  // aging: in-flight tasks with no file activity for > 3 days
  const aging = snap.tasks
    .filter(
      (t) =>
        t.record &&
        ['in_progress', 'review', 'planning'].includes((t.record.status ?? '').toLowerCase()) &&
        t.updatedAt &&
        now - t.updatedAt > 3 * DAY
    )
    .map((t) => ({
      dirName: t.dirName,
      title: t.record?.title ?? t.dirName,
      status: statusLabel(t.record?.status),
      days: Math.floor((now - t.updatedAt) / DAY),
      assignee: t.record?.assignee || t.record?.creator || '未分配'
    }))
    .sort((a, b) => b.days - a.days)
    .slice(0, 10)

  return {
    totalTransitions: log.length,
    avgCycleDays: cycleCount ? Math.round((cycleSum / cycleCount) * 10) / 10 : null,
    aging,
    daily: [...dailyMap.entries()].map(([date, count]) => ({ date, count })),
    memberCycle: [...memberMap.entries()]
      .map(([name, m]) => ({
        name,
        completed: m.total,
        avgDays: m.days.length ? Math.round((m.days.reduce((a, b) => a + b, 0) / m.days.length) * 10) / 10 : null
      }))
      .sort((a, b) => (a.avgDays ?? 999) - (b.avgDays ?? 999)),
    recent: log.slice(-12).reverse()
  }
}

/** Full activity log (for reports). */
export function getActivity(entries: number): ActivityEntry[] {
  return readLog().slice(-entries).reverse()
}

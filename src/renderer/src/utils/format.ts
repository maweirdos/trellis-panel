export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function fmtDate(s?: string | null): string {
  if (!s) return '—'
  // task createdAt / completedAt use YYYY-MM-DD
  return s.slice(0, 10)
}

export function fmtIso(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const pad = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function relTime(ms: number): string {
  if (!ms) return '—'
  const diff = Date.now() - ms
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  const date = new Date(ms)
  const pad = (x: number): string => String(x).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function taskDateLabel(dirName: string, date: string | null): string {
  if (date) return date
  const m = /^(\d{2})-(\d{2})-/.exec(dirName)
  return m ? `${m[1]}-${m[2]}` : dirName
}

/** Parse a subtask string like "[ ] xxx" / "[x] xxx" / "- [ ] xxx" / plain text. */
export function parseSubtask(s: string): { done: boolean; text: string; isCheckable: boolean } {
  let t = s.trim()
  if (t.startsWith('- ')) t = t.slice(2)
  const m = /^\[( |x|X)\]\s*(.*)$/.exec(t)
  if (m) return { done: m[1].toLowerCase() === 'x', text: m[2], isCheckable: true }
  return { done: false, text: s, isCheckable: false }
}

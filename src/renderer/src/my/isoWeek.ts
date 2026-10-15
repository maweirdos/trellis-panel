// ISO 周号工具：cycle = "YYYY-Wnn"。周期起止由周号推导，不落盘。
export function isoWeekKey(date: Date): string {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7)) // 移到本周周四（ISO 归属）
  const week1 = new Date(d.getFullYear(), 0, 4)
  week1.setDate(week1.getDate() + 3 - ((week1.getDay() + 6) % 7))
  const week = 1 + Math.round((d.getTime() - week1.getTime()) / (7 * 24 * 3600 * 1000))
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`
}

export function currentWeekKey(): string {
  return isoWeekKey(new Date())
}

export function nextWeekKey(): string {
  const d = new Date()
  d.setDate(d.getDate() + 7)
  return isoWeekKey(d)
}

/** 周号 → 该周一 0 点（ISO：先定位 W1 的周四，再回退到周一） */
export function isoWeekStart(key: string): Date {
  const m = key.match(/^(\d{4})-W(\d{2})$/)
  if (!m) return new Date(NaN)
  const jan4 = new Date(Number(m[1]), 0, 4)
  const thursday = new Date(jan4)
  thursday.setDate(thursday.getDate() + 3 - ((thursday.getDay() + 6) % 7))
  const monday = new Date(thursday)
  monday.setDate(monday.getDate() - 3 + (Number(m[2]) - 1) * 7)
  return monday
}

/** 周号 → "MM/DD–MM/DD" */
export function isoWeekRangeTitle(key: string): string {
  const start = isoWeekStart(key)
  if (Number.isNaN(start.getTime())) return key
  const end = new Date(start)
  end.setDate(end.getDate() + 6)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${start.getMonth() + 1}/${start.getDate()}–${end.getMonth() + 1}/${end.getDate()}`
}

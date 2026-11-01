import { useEffect, useState, type JSX } from 'react'
import { TASK_STATUSES, type TaskStatus } from '../../../../../shared/types'
import { Button } from '../../ui'
import { IntegrationMappingEditor, type IntegrationMappingRow } from './IntegrationSections'

const labels: Record<TaskStatus, string> = { planning: '规划中', in_progress: '进行中', review: '待审阅', completed: '已完成' }
function parse(value: string): Record<string, string> | null {
  if (!value.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return Object.values(parsed).every((target) => typeof target === 'string') ? parsed as Record<string, string> : null
  } catch { return null }
}
function mappingRows(value: Record<string, string>): IntegrationMappingRow[] {
  return Object.entries(value).map(([source, target]) => ({ id: crypto.randomUUID(), source, target }))
}

/** Adapts the existing statusMap string without changing its native save contract. */
export function ConnectionStatusMapping({ value, disabled, onChange, onValidityChange }: { value: string; disabled: boolean; onChange: (value: string) => void; onValidityChange: (valid: boolean) => void }): JSX.Element {
  const [initial] = useState(() => parse(value))
  const [rows, setRows] = useState<IntegrationMappingRow[]>(() => mappingRows(initial ?? {}))
  const [raw, setRaw] = useState<string | null>(initial === null ? value : null)
  const decorated = rows.map((row) => ({ ...row, error: !row.source.trim() || !row.target ? '请选择来源状态和目标状态。' : rows.some((item) => item.id !== row.id && item.source.trim() === row.source.trim()) ? '来源状态不能重复。' : undefined }))
  const valid = raw === null && decorated.every((row) => !row.error)
  useEffect(() => { onValidityChange(valid) }, [valid, onValidityChange])
  const known = TASK_STATUSES.map((status) => ({ value: status, label: labels[status] }))
  const unknown = [...new Set(rows.map((row) => row.target).filter((target) => target && !known.some((choice) => choice.value === target)))]
  const update = (next: IntegrationMappingRow[]): void => {
    setRows(next)
    const complete = next.every((row) => row.source.trim() && row.target) && new Set(next.map((row) => row.source.trim())).size === next.length
    onValidityChange(complete)
    if (complete) onChange(JSON.stringify(Object.fromEntries(next.map((row) => [row.source.trim(), row.target]))))
  }
  if (raw !== null) return <div className="space-y-2"><p role="alert" className="text-my-sm text-my-warning-text">原有状态映射格式无法读取，修复后才能保存。</p><textarea aria-label="修复原有状态映射 JSON" className="my-input min-h-20 w-full" disabled={disabled} value={raw} onChange={(event) => setRaw(event.target.value)} /><Button size="sm" disabled={disabled || parse(raw) === null} onClick={() => { const parsed = parse(raw); if (parsed) { setRows(mappingRows(parsed)); setRaw(null); onChange(JSON.stringify(parsed)) } }}>应用修复后的映射</Button></div>
  return <div className="space-y-2"><IntegrationMappingEditor label="状态映射" rows={decorated} targets={[{ value: '', label: '选择本地状态' }, ...known, ...unknown.map((target) => ({ value: target, label: `保留原有值：${target}` }))]} disabled={disabled} onChange={update} /><p className="my-item-description">配置导入时的本地状态；远端流转仍需明确操作与权限。</p></div>
}

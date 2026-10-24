import { useCallback, useEffect, useState, type ComponentProps, type JSX } from 'react'
import type { JiraData, JiraField, JiraMapping } from '@shared/jira-integration'
import { Checkbox } from '../../../../ui'
import { IntegrationMappingEditor, type IntegrationMappingOption, type IntegrationMappingRow } from '../../IntegrationSections'

const labels: Record<JiraField, string> = { title: '标题', description: '描述', priority: '优先级', status: 'Jira 来源状态', assignee: '负责人', labels: '标签', type: '类型', comments: '评论（追加与完整读取）' }
export function emptyJiraMapping(): JiraMapping { return { revision: 1, fields: ['title', 'description'], priorities: {}, statuses: {}, members: {}, types: {}, transitions: {} } }
function rows(mapping: Record<string, string>): IntegrationMappingRow[] { return Object.entries(mapping).map(([source, target], index) => ({ id: `${index}:${source}`, source, target })) }
function mapping(rows: IntegrationMappingRow[]): Record<string, string> { return Object.fromEntries(rows.filter((row) => row.source && row.target).map((row) => [row.source, row.target])) }
const priorityTargets = ['P0', 'P1', 'P2', 'P3'].map((value) => ({ value, label: value }))
const statusTargets = ['planning', 'in_progress', 'review', 'completed'].map((value) => ({ value, label: value }))
const typeTargets = ['task', 'feature', 'bug', 'subtask'].map((value) => ({ value, label: value }))
function MappedEditor({ values, onChange, onValidityChange, ...props }: Omit<ComponentProps<typeof IntegrationMappingEditor>, 'rows' | 'onChange'> & { values: Record<string, string>; onChange: (rows: IntegrationMappingRow[]) => void; onValidityChange: (valid: boolean) => void }): JSX.Element {
  const [draft, setDraft] = useState(() => rows(values))
  useEffect(() => { setDraft((current) => JSON.stringify(mapping(current)) === JSON.stringify(values) ? current : rows(values)) }, [values])
  const checked = draft.map((row) => ({ ...row, error: !row.source || !row.target ? '请选择完整的来源与目标。' : draft.some((other) => other.id !== row.id && other.source === row.source) ? '来源字段重复。' : undefined }))
  const valid = checked.every((row) => !row.error)
  useEffect(() => { onValidityChange(valid) }, [valid, onValidityChange])
  return <IntegrationMappingEditor {...props} rows={checked} onChange={(next) => { setDraft(next); onChange(next) }} />
}
export function JiraMappingFields({ value, onChange, metadata, disabled = false, onValidityChange, section = 'all', showTransitions = true }: { value: JiraMapping; onChange: (mapping: JiraMapping) => void; metadata: JiraData<'discover'> | null; disabled?: boolean; onValidityChange?: (valid: boolean) => void; section?: 'all' | 'statuses' | 'members' | 'fields'; showTransitions?: boolean }): JSX.Element {
  const [memberTarget, setMemberTarget] = useState('')
  const [validity, setValidity] = useState<Record<string, boolean>>({})
  const validate = useCallback((field: string, valid: boolean) => setValidity((prior) => prior[field] === valid ? prior : { ...prior, [field]: valid }), [])
  const visible = (field: JiraField): boolean => section === 'all' || (section === 'statuses' ? field === 'status' : section === 'members' ? field === 'assignee' : field !== 'status' && field !== 'assignee')
  const valid = value.fields.filter(visible).every((field) => validity[field] !== false) && value.fields.length > 0
  useEffect(() => { onValidityChange?.(valid) }, [valid, onValidityChange])
  const choices = (items: { id: string; name: string }[] | undefined): IntegrationMappingOption[] => [{ value: '', label: '请选择来源' }, ...(items ?? []).map((item) => ({ value: item.id, label: `${item.name} (${item.id})` }))]
  const update = (key: 'priorities' | 'statuses' | 'types' | 'members' | 'transitions', next: IntegrationMappingRow[]): void => onChange({ ...value, [key]: mapping(next) })
  return <div className="space-y-4">
    <fieldset disabled={disabled} className="space-y-3"><legend className="mb-2 text-my-sm font-medium">{section === 'statuses' ? '状态映射' : section === 'members' ? '成员映射' : '同步字段'}</legend><div className="grid gap-3 sm:grid-cols-2">{(Object.keys(labels) as JiraField[]).filter(visible).map((field) => <label key={field} className="flex items-center gap-2 text-my-sm"><Checkbox checked={value.fields.includes(field)} onChange={(checked) => onChange({ ...value, fields: checked ? [...value.fields, field] : value.fields.filter((item) => item !== field) })} />{labels[field]}</label>)}</div></fieldset>
    {(section === 'all' || section === 'statuses') && <p className="text-my-xs text-my-tertiary">Jira 状态保存为来源状态，任务生命周期保持原有流程。</p>}
    {visible('priority') && value.fields.includes('priority') && <MappedEditor onValidityChange={(valid) => validate('priority', valid)} label="优先级" values={value.priorities} sourceOptions={choices(metadata?.priorities)} targets={priorityTargets} onChange={(next) => update('priorities', next)} disabled={disabled} />}
    {visible('status') && value.fields.includes('status') && <><MappedEditor onValidityChange={(valid) => validate('status', valid)} label="来源状态" values={value.statuses} sourceOptions={choices(metadata?.statuses)} targets={statusTargets} onChange={(next) => update('statuses', next)} disabled={disabled} />{showTransitions && <details className="space-y-3 text-my-sm"><summary className="cursor-pointer">双向状态流转</summary><p className="text-my-xs text-my-tertiary">填写真实 Jira transition ID，执行前会重新核实可用流转。</p>{[...new Set(Object.values(value.statuses))].map((status) => <label key={status} className="flex items-center gap-3 text-my-sm"><span>{status}</span><input className="my-input min-w-0 flex-1" aria-label={`${status} 的 Jira transition ID`} value={value.transitions[status] ?? ''} onChange={(event) => { const transitions = { ...value.transitions }; if (event.target.value) transitions[status] = event.target.value; else delete transitions[status]; onChange({ ...value, transitions }) }} disabled={disabled} /></label>)}</details>}</>}
    {visible('type') && value.fields.includes('type') && <MappedEditor onValidityChange={(valid) => validate('type', valid)} label="Issue 类型" values={value.types} sourceOptions={choices(metadata?.issueTypes)} targets={typeTargets} onChange={(next) => update('types', next)} disabled={disabled} />}
    {visible('assignee') && value.fields.includes('assignee') && <><label className="block space-y-1 text-my-sm"><span>本地负责人标识</span><input className="my-input w-full" value={memberTarget} placeholder="填写已有本地负责人" onChange={(event) => setMemberTarget(event.target.value)} disabled={disabled} /></label><MappedEditor onValidityChange={(valid) => validate('assignee', valid)} label="成员" values={value.members} sourceOptions={[{ value: '', label: '选择 Jira 用户名' }, ...(metadata?.members ?? []).map((member) => ({ value: member.name, label: `${member.displayName} (${member.name})` }))]} targets={[{ value: '', label: '选择本地负责人' }, ...[...new Set([...Object.values(value.members), memberTarget].filter(Boolean))].map((name) => ({ value: name, label: name }))]} onChange={(next) => update('members', next)} disabled={disabled} />{metadata?.membersHasMore && <p className="text-my-xs text-my-tertiary">还有成员未显示，可按用户名缩小查询范围。</p>}</>}
    {(section === 'all' || section === 'fields') && <details className="text-my-xs text-my-tertiary"><summary className="cursor-pointer">字段与历史支持范围</summary><p className="mt-2">只处理明确映射的字段。已编写的 PRD 保持原有流程。附件、父任务、自定义字段与历史仅保留来源证据，不支持双向编辑。</p></details>}
  </div>
}

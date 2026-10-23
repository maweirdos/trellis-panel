import { useEffect, useState, type JSX } from 'react'
import { gitlabMappingSchema, type GitlabBinding, type GitlabField, type GitlabInput, type GitlabOutput, type GitlabProject, type GitlabUser } from '@shared/gitlab-integration'
import { Select } from '../../../../../components/Select'
import { Button } from '../../../../ui'
import { IntegrationMappingEditor, type IntegrationMappingRow } from '../../IntegrationSections'

type Snapshot = GitlabOutput<'snapshot'>
export interface PlanEditorProps {
  initial?: GitlabBinding
  snapshot: Snapshot
  projects: GitlabProject[]
  members: GitlabUser[]
  busy: boolean
  loadMembers: (projectId: string) => void
  save: (draft: Omit<GitlabInput<'savePlan'>, 'expectedRoot' | 'connectionId' | 'connectionRevision'>) => void
  close: () => void
}
const fields: { id: GitlabField; label: string }[] = [{ id: 'title', label: '标题' }, { id: 'description', label: '描述（保留已编辑 PRD）' }, { id: 'state', label: 'Issue 状态（独立于任务生命周期）' }, { id: 'labels', label: '标签' }, { id: 'assignees', label: '负责人' }]
export function GitlabPlanEditor({ initial, snapshot, projects, members, busy, loadMembers, save, close }: PlanEditorProps): JSX.Element {
  const [projectId, setProject] = useState(initial?.project.id ?? '')
  const [direction, setDirection] = useState<'inbound' | 'bidirectional'>(initial?.plan.direction ?? 'inbound')
  const [transport, setTransport] = useState<'polling' | 'webhook'>(initial?.plan.transport === 'webhook' ? 'webhook' : 'polling')
  const [selected, setSelected] = useState<GitlabField[]>(initial?.mapping.fields ?? ['title', 'description', 'labels'])
  const [statusRows, setStatusRows] = useState<IntegrationMappingRow[]>(initial?.mapping.statuses.map((s) => ({ id: s.remote, source: s.remote, target: s.local })) ?? [])
  const [memberRows, setMemberRows] = useState<IntegrationMappingRow[]>(initial?.mapping.members.map((m) => ({ id: m.remote, source: m.remote, target: m.local })) ?? [])
  const [comments, setComments] = useState(initial?.mapping.comments ?? false)
  const [history, setHistory] = useState(initial?.history ?? false)
  const [createMissing, setCreateMissing] = useState(initial?.createMissing ?? true)
  useEffect(() => { if (projectId) loadMembers(projectId) }, [projectId, loadMembers])
  const mapping = { revision: (initial?.mapping.revision ?? 0) + 1, fields: selected, statuses: selected.includes('state') ? statusRows.map((r) => ({ remote: r.source, local: r.target })) : [], members: selected.includes('assignees') ? memberRows.map((r) => ({ remote: r.source, local: r.target })) : [], comments }
  const checked = gitlabMappingSchema.safeParse(mapping)
  const projectOptions = [...(initial && !projects.some((p) => p.id === initial.project.id) ? [initial.project] : []), ...projects].map((p) => ({ value: p.id, label: `${p.path}${p.issuesEnabled ? '' : '（Issues 未启用）'}` }))
  return <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); if (!checked.success || !projectId) return; save({ ...(initial ? { bindingId: initial.plan.id, bindingRevision: initial.plan.source.bindingRevision } : {}), projectId, direction, transport, mapping: checked.data, createMissing, history }) }}>
    <label className="block space-y-2 text-my-sm"><span>GitLab 项目</span><Select ariaLabel="GitLab 项目" value={projectId} onChange={(value) => { setProject(value); setMemberRows([]) }} options={[{ value: '', label: '请选择来源项目' }, ...projectOptions]} disabled={busy || Boolean(initial)} /></label>
    <div className="flex flex-wrap gap-4"><label className="space-y-2 text-my-sm"><span className="block">同步方向</span><Select ariaLabel="同步方向" value={direction} onChange={(value) => setDirection(value === 'bidirectional' ? 'bidirectional' : 'inbound')} options={[{ value: 'inbound', label: 'GitLab → 本地' }, { value: 'bidirectional', label: '双向（需要 api 授权）' }]} disabled={busy} /></label><label className="space-y-2 text-my-sm"><span className="block">接收方式</span><Select ariaLabel="接收方式" value={transport} onChange={(value) => setTransport(value === 'webhook' ? 'webhook' : 'polling')} options={[{ value: 'polling', label: '定时同步（60 秒起，失败退避）' }, ...(snapshot.receiverAvailable ? [{ value: 'webhook', label: 'Webhook + 定时追赶' }] : [])]} disabled={busy} /></label></div>
    <fieldset disabled={busy} className="space-y-2"><legend className="mb-2 text-my-sm font-medium">同步字段</legend>{fields.map((field) => <label key={field.id} className="flex items-center gap-2 text-my-sm"><input type="checkbox" checked={selected.includes(field.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, field.id] : selected.filter((f) => f !== field.id))} />{field.label}</label>)}</fieldset>
    {selected.includes('state') && <IntegrationMappingEditor label="状态映射" rows={statusRows} onChange={setStatusRows} sourceOptions={[{ value: 'opened', label: 'opened' }, { value: 'closed', label: 'closed' }]} targets={snapshot.localStatuses.map((s) => ({ value: s.id, label: s.name }))} disabled={busy} />}
    {selected.includes('assignees') && <IntegrationMappingEditor label="成员映射" rows={memberRows} onChange={setMemberRows} sourceOptions={members.map((m) => ({ value: m.id, label: `${m.name} (@${m.username})` }))} targets={snapshot.localMembers.map((m) => ({ value: m.id, label: m.name }))} disabled={busy} />}
    <div className="space-y-2">{([{ label: '为未关联的 Issue 创建本地任务', value: createMissing, set: setCreateMissing }, { label: '归档 GitLab 评论（保留数字 note 身份）', value: comments, set: setComments }, { label: '包含已有 Issue 的评论历史', value: history, set: setHistory }]).map((option) => <label key={option.label} className="flex items-center gap-2 text-my-sm"><input type="checkbox" checked={option.value} disabled={busy} onChange={(e) => option.set(e.target.checked)} />{option.label}</label>)}</div>
    <p className="text-my-xs text-my-tertiary">保存后处于暂停状态。启用和导入分别操作；Webhook 注册需要再次明确提交。状态映射保存来源状态，不改变 Trellis 完成或归档状态。</p>
    {!checked.success && <p role="status" className="text-my-sm text-my-warning-text">{checked.error.issues[0]?.message}</p>}
    <div className="flex gap-2"><Button size="sm" onClick={(event) => event.currentTarget.form?.requestSubmit()} disabled={busy || !projectId || !checked.success}>保存暂停的同步</Button><Button size="sm" variant="ghost" disabled={busy} onClick={close}>取消</Button></div>
  </form>
}

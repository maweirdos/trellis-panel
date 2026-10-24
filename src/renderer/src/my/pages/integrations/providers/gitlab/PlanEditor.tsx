import { useEffect, useRef, useState, type JSX } from 'react'
import { Search } from 'lucide-react'
import { gitlabMappingSchema, type GitlabBinding, type GitlabField, type GitlabInput, type GitlabOutput, type GitlabProject, type GitlabUser } from '@shared/gitlab-integration'
import { useInteractionGuard } from '../../../../../utils/interaction-scope'
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
  query: string
  setQuery: (value: string) => void
  search: () => void
  searched: boolean
  moreProjects: boolean
  loadMoreProjects: () => void
  moreMembers: boolean
  loadMoreMembers: () => void
  membersBusy: boolean
  membersError: string | null
  loadMembers: (projectId: string) => void
  dirtyChange: (dirty: boolean) => void
  save: (draft: Omit<GitlabInput<'savePlan'>, 'expectedRoot' | 'connectionId' | 'connectionRevision'>) => void
  close: () => void
}
const fields: { id: GitlabField; label: string }[] = [{ id: 'title', label: '标题' }, { id: 'description', label: '描述' }, { id: 'state', label: 'Issue 状态' }, { id: 'labels', label: '标签' }, { id: 'assignees', label: '负责人' }]
const steps = ['项目', '状态', '成员', '选项', '确认']
export function GitlabPlanEditor({ initial, snapshot, projects, members, busy, query, setQuery, search, searched, moreProjects, loadMoreProjects, moreMembers, loadMoreMembers, membersBusy, membersError, loadMembers, dirtyChange, save, close }: PlanEditorProps): JSX.Element {
  const [step, setStep] = useState(0)
  const [tab, setTab] = useState<'settings' | 'members' | 'statuses'>('settings')
  const [project, setProject] = useState<GitlabProject | undefined>(initial?.project)
  const [direction, setDirection] = useState<'inbound' | 'bidirectional'>(initial?.plan.direction ?? 'inbound')
  const [transport, setTransport] = useState<'polling' | 'webhook'>(initial?.plan.transport === 'webhook' ? 'webhook' : 'polling')
  const [selected, setSelected] = useState<GitlabField[]>(initial?.mapping.fields ?? ['title', 'description', 'labels'])
  const [statusRows, setStatusRows] = useState<IntegrationMappingRow[]>(initial?.mapping.statuses.map((s) => ({ id: s.remote, source: s.remote, target: s.local })) ?? [])
  const [memberRows, setMemberRows] = useState<IntegrationMappingRow[]>(initial?.mapping.members.map((m) => ({ id: m.remote, source: m.remote, target: m.local })) ?? [])
  const [comments, setComments] = useState(initial?.mapping.comments ?? false)
  const [history, setHistory] = useState(initial?.history ?? false)
  const [createMissing, setCreateMissing] = useState(initial?.createMissing ?? true)
  const canInteract = useInteractionGuard()
  const projectId = project?.id
  useEffect(() => { if (projectId) loadMembers(projectId) }, [projectId, loadMembers])
  const mapping = { revision: (initial?.mapping.revision ?? 0) + 1, fields: selected, statuses: selected.includes('state') ? statusRows.map((r) => ({ remote: r.source, local: r.target })) : [], members: selected.includes('assignees') ? memberRows.map((r) => ({ remote: r.source, local: r.target })) : [], comments }
  const checked = gitlabMappingSchema.safeParse(mapping)
  const fingerprint = JSON.stringify({ projectId, direction, transport, selected, statusRows, memberRows, comments, history, createMissing })
  const baseline = useRef(fingerprint)
  const dirty = fingerprint !== baseline.current
  useEffect(() => { dirtyChange(dirty); return () => dirtyChange(false) }, [dirty, dirtyChange])
  // A saved mapping may name members beyond the current page. Preserve their numeric identities.
  const unknownMemberIds = [...new Set(memberRows.map((row) => row.source).filter((source) => source && !members.some((m) => m.id === source)))]
  const memberOptions = [...members.map((m) => ({ value: m.id, label: `${m.name} (@${m.username})` })), ...unknownMemberIds.map((id) => ({ value: id, label: `GitLab 用户 ${id}` }))]
  const toggleField = (field: GitlabField, enabled: boolean) => setSelected((old) => enabled ? [...old.filter((v) => v !== field), field] : old.filter((v) => v !== field))
  const canSave = Boolean(project?.issuesEnabled && checked.success)
  const stepValid = step === 0 ? Boolean(project?.issuesEnabled) : step === 1 || step === 2 ? checked.success : canSave
  const showStatuses = initial ? tab === 'statuses' : step === 1
  const showMembers = initial ? tab === 'members' : step === 2
  const showOptions = initial ? tab === 'settings' : step === 3
  const showProject = initial ? tab === 'settings' : step === 0
  function submit(): void {
    if (busy || !canInteract()) return
    if (!initial && step < 4) { if (stepValid) setStep((value) => value + 1); return }
    if (checked.success && project?.issuesEnabled) save({ ...(initial ? { bindingId: initial.plan.id, bindingRevision: initial.plan.source.bindingRevision } : {}), projectId: project.id, direction, transport, mapping: checked.data, createMissing, history })
  }
  return <form className="space-y-6" onSubmit={(event) => { event.preventDefault(); if (!initial && step === 0) { if (!busy && canInteract()) search() } else submit() }}>
    {initial ? <div role="tablist" aria-label="同步设置" className="flex gap-2 border-b border-my-line pb-3">{([{ id: 'settings', label: '设置' }, { id: 'members', label: '成员' }, { id: 'statuses', label: '状态' }] as const).map((item) => <Button key={item.id} size="sm" role="tab" aria-selected={tab === item.id} variant={tab === item.id ? 'neutral' : 'ghost'} disabled={busy} onClick={() => setTab(item.id)}>{item.label}</Button>)}</div> : <ol aria-label="配置步骤" className="flex flex-wrap gap-x-5 gap-y-2 border-b border-my-line pb-4 text-my-sm">{steps.map((label, index) => <li key={label} aria-current={step === index ? 'step' : undefined} className={step === index ? 'font-medium text-my-primary' : 'text-my-tertiary'}>{index + 1}. {label}</li>)}</ol>}
    {showProject && <>
      {initial ? <label className="block space-y-2 text-my-sm"><span>GitLab 项目</span><input className="my-input w-full" value={project?.path ?? ''} readOnly /></label> : <>
        <div className="flex gap-2"><input aria-label="搜索 GitLab 项目" className="my-input min-w-0 flex-1" value={query} maxLength={200} onChange={(e) => setQuery(e.target.value)} placeholder="项目名称或路径" disabled={busy} /><Button size="sm" disabled={busy} onClick={search}><Search size={14} />搜索</Button></div>
        <div role="group" aria-label="来源项目" className="space-y-2">{projects.map((item) => {
          const linked = snapshot.bindings.some((b) => b.project.id === item.id)
          return <button key={item.id} type="button" disabled={busy || !item.issuesEnabled || linked} aria-pressed={project?.id === item.id} className={`flex w-full items-center justify-between gap-3 rounded-my-md border p-3 text-left text-my-sm ${project?.id === item.id ? 'border-my-line-accent bg-my-layer-2' : 'border-my-line hover:bg-my-layer-2'} disabled:opacity-50`} onClick={() => { setProject(item); if (item.id !== project?.id) setMemberRows([]) }}><span className="min-w-0 break-words">{item.path}</span><span className="shrink-0 text-my-xs text-my-tertiary">{!item.issuesEnabled ? '未启用 Issues' : linked ? '已创建同步' : project?.id === item.id ? '已选择' : '选择'}</span></button>
        })}</div>
        {searched && !projects.length && !busy && <p role="status" className="text-my-sm text-my-tertiary">未找到可访问的项目，请更换关键词。</p>}
        {!searched && <p className="text-my-sm text-my-tertiary">搜索要同步的 GitLab 项目。</p>}
        {moreProjects && <Button size="sm" variant="ghost" disabled={busy} onClick={loadMoreProjects}>加载更多项目</Button>}
      </>}
      <p className="text-my-sm text-my-secondary">目标：当前项目</p>
      <fieldset disabled={busy} className="space-y-2"><legend className="mb-2 text-my-sm font-medium">同步方向</legend><div className="flex flex-wrap gap-2">{([{ value: 'inbound', label: 'GitLab → 当前项目' }, { value: 'bidirectional', label: '双向同步' }] as const).map((option) => <button key={option.value} type="button" aria-pressed={direction === option.value} className={`rounded-my-md border px-3 py-2 text-my-sm ${direction === option.value ? 'border-my-line-accent bg-my-layer-2' : 'border-my-line'}`} onClick={() => setDirection(option.value)}>{option.label}</button>)}</div></fieldset>
      {direction === 'bidirectional' && <p className="text-my-sm text-my-warning-text">双向同步会将映射字段写回 GitLab，需要已验证的 api 权限。</p>}
    </>}
    {showStatuses && <div className="space-y-5">
      <label className="flex items-center gap-2 text-my-sm"><input type="checkbox" checked={selected.includes('state')} disabled={busy} onChange={(e) => toggleField('state', e.target.checked)} />同步 Issue 状态</label>
      {selected.includes('state') ? <IntegrationMappingEditor label="状态映射" rows={statusRows} onChange={setStatusRows} sourceOptions={[{ value: 'opened', label: 'opened' }, { value: 'closed', label: 'closed' }]} targets={snapshot.localStatuses.map((s) => ({ value: s.id, label: s.name }))} disabled={busy} /> : <p className="text-my-sm text-my-tertiary">保留 GitLab 原始状态，不应用状态映射。</p>}
      <p className="text-my-xs text-my-tertiary">状态映射不改变 Trellis 的完成或归档状态。</p>
    </div>}
    {showMembers && <div className="space-y-5">
      <label className="flex items-center gap-2 text-my-sm"><input type="checkbox" checked={selected.includes('assignees')} disabled={busy} onChange={(e) => toggleField('assignees', e.target.checked)} />映射 GitLab 负责人</label>
      {membersBusy && <p role="status" className="text-my-sm text-my-secondary">正在读取项目成员…</p>}
      {membersError && <div className="space-y-2"><p role="alert" className="text-my-sm text-my-warning-text">{membersError}</p><Button size="sm" disabled={busy || membersBusy} onClick={() => { if (projectId) loadMembers(projectId) }}>重新读取成员</Button></div>}
      {selected.includes('assignees') ? <><IntegrationMappingEditor label="成员映射" rows={memberRows} onChange={setMemberRows} sourceOptions={memberOptions} targets={snapshot.localMembers.map((m) => ({ value: m.id, label: m.name }))} disabled={busy || membersBusy} />{moreMembers && <Button size="sm" variant="ghost" disabled={busy || membersBusy} onClick={loadMoreMembers}>加载更多项目成员</Button>}</> : <p className="text-my-sm text-my-tertiary">保留来源用户身份，不应用成员映射。</p>}
    </div>}
    {showOptions && <div className="space-y-5">
      <fieldset disabled={busy} className="space-y-2"><legend className="mb-2 text-my-sm font-medium">同步字段</legend><div className="flex flex-wrap gap-x-5 gap-y-3">{fields.filter((field) => field.id !== 'state' && field.id !== 'assignees').map((field) => <label key={field.id} className="flex items-center gap-2 text-my-sm"><input type="checkbox" checked={selected.includes(field.id)} onChange={(e) => toggleField(field.id, e.target.checked)} />{field.label}</label>)}</div></fieldset>
      <div className="space-y-3">{([{ label: '为未关联的 Issue 创建本地任务', value: createMissing, set: setCreateMissing }, { label: '同步 GitLab 评论', value: comments, set: setComments }, { label: '包含已有 Issue 的评论历史', value: history, set: setHistory }]).map((option) => <label key={option.label} className="flex items-center gap-2 text-my-sm"><input type="checkbox" checked={option.value} disabled={busy} onChange={(e) => option.set(e.target.checked)} />{option.label}</label>)}</div>
      <p className="text-my-xs text-my-tertiary">已有 Issue 的导入需在保存后单独预览确认。</p>
      <details className="space-y-4 text-my-sm"><summary className="cursor-pointer text-my-secondary">接收方式</summary><Select ariaLabel="接收方式" value={transport} onChange={(value) => setTransport(value === 'webhook' ? 'webhook' : 'polling')} options={[{ value: 'polling', label: '定时同步' }, ...((snapshot.receiverAvailable || transport === 'webhook') ? [{ value: 'webhook', label: snapshot.receiverAvailable ? 'Webhook + 定时追赶' : 'Webhook（接收端不可用）' }] : [])]} disabled={busy} />{transport === 'webhook' && <p className="text-my-xs text-my-secondary">保存不会注册 Webhook，需在同步详情中再次确认。</p>}</details>
    </div>}
    {!initial && step === 4 && <>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-3 text-my-sm"><dt className="text-my-tertiary">GitLab 项目</dt><dd className="break-words">{project?.path}</dd><dt className="text-my-tertiary">目标</dt><dd>当前项目</dd><dt className="text-my-tertiary">同步方向</dt><dd>{direction === 'inbound' ? 'GitLab → 当前项目' : '双向同步'}</dd><dt className="text-my-tertiary">同步字段</dt><dd>{fields.filter((field) => selected.includes(field.id)).map((field) => field.label).join('、')}</dd><dt className="text-my-tertiary">状态映射</dt><dd>{mapping.statuses.length} 项</dd><dt className="text-my-tertiary">成员映射</dt><dd>{mapping.members.length} 项</dd><dt className="text-my-tertiary">评论</dt><dd>{comments ? '同步' : '不同步'}{history ? ' · 包含历史' : ''}</dd><dt className="text-my-tertiary">接收方式</dt><dd>{transport === 'webhook' ? 'Webhook + 定时追赶' : '定时同步'}</dd></dl>
      {direction === 'bidirectional' && <p className="text-my-sm text-my-warning-text">启用后允许将所选字段写回 GitLab。当前权限：{snapshot.permission?.write === 'granted' ? '已验证' : '未获得写入授权'}。</p>}
      <p className="text-my-sm text-my-secondary">保存后保持暂停，返回同步列表可启用。历史 Issue 需单独预览导入。</p>
      {selected.includes('description') && <p className="text-my-xs text-my-tertiary">本地已编辑的 PRD 会保留。</p>}
    </>}
    {(initial || step > 0) && !checked.success && <p role="status" className="text-my-sm text-my-warning-text">{checked.error.issues[0]?.message}</p>}
    <div className="flex flex-wrap justify-end gap-2 border-t border-my-line pt-4">
      <Button size="sm" variant="ghost" disabled={busy} onClick={close}>取消</Button>
      {initial && dirty && <Button size="sm" disabled={busy} onClick={close}>放弃修改</Button>}
      {!initial && step > 0 && <Button size="sm" disabled={busy} onClick={() => setStep((value) => value - 1)}>上一步</Button>}
      <Button size="sm" variant="primary" disabled={busy || (initial || step === 4 ? !canSave : !stepValid)} onClick={submit}>{initial || step === 4 ? '保存同步' : '下一步'}</Button>
    </div>
  </form>
}

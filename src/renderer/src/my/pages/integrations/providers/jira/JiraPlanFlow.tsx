import { useEffect, useId, useRef, useState, type JSX } from 'react'
import type { ExecutionTarget, IntegrationSource } from '@shared/integration-work'
import { jiraPlanSchema, type JiraData, type JiraIntegrationApi, type JiraMapping, type JiraPlan } from '@shared/jira-integration'
import { Select } from '../../../../../components/Select'
import { useEscLayer } from '../../../../../utils/use-esc-layer'
import { Button, Checkbox, Modal, Tabs } from '../../../../ui'
import { useIntegrationAction } from '../../hooks'
import { JiraMappingFields, emptyJiraMapping } from './JiraMappingFields'
import { JiraFlowHeader, JIRA_SYNC_STEPS } from './JiraFlowHeader'
import { useJiraReads } from './use-jira-reads'
import { useJiraConfirmation } from './use-jira-confirmation'
import './jira.css'

type Scope = { expectedRoot: string; workspaceId: string }
type EditTab = 'settings' | 'users' | 'statuses'

export function JiraPlanDialog({ api, scope, source, sourceLabel, writeIdentity, target, metadata, initial, draft, startStep = 1, mapping, onChangeSource, onClose, onSaved }: {
  api: JiraIntegrationApi; scope: Scope; source: IntegrationSource; sourceLabel: string; writeIdentity: string; target: ExecutionTarget; metadata: JiraData<'discover'> | null
  initial?: JiraPlan; draft?: JiraPlan; startStep?: 1 | 2; mapping: JiraMapping; onChangeSource: (draft: JiraPlan) => void; onClose: () => void; onSaved: () => void
}): JSX.Element {
  const [value, setValue] = useState<JiraPlan>(() => draft ?? initial ?? { plan: { id: crypto.randomUUID(), revision: 1, source, target, direction: 'inbound', state: 'paused', transport: 'polling', fieldMappingRevision: mapping.revision }, controlRevision: 1, name: 'Jira 项目同步', jql: '', mapping, rules: { inboundCreate: true, inboundUpdate: true, outboundCreate: false, outboundUpdate: false }, outboundTaskRefs: [], remoteWritesApproved: false, receiverId: null, createIssueTypeId: null, includeHistory: false, since: Date.now(), scanAfterId: null, lastSuccessAt: null, nextPollAt: null, failures: 0, detail: '' })
  const baseline = useRef(JSON.stringify(value))
  const flowFocus = useRef<HTMLDivElement>(null)
  const [step, setStep] = useState<number>(startStep)
  const [tab, setTab] = useState<EditTab>('settings')
  const [tasks, setTasks] = useState<JiraData<'localTasks'> | null>(null)
  const [taskError, setTaskError] = useState('')
  const [memberQuery, setMemberQuery] = useState('')
  const [currentMetadata, setCurrentMetadata] = useState(metadata)
  const [validation, setValidation] = useState('')
  const [statusValid, setStatusValid] = useState(true)
  const [membersValid, setMembersValid] = useState(true)
  const [fieldsValid, setFieldsValid] = useState(true)
  const askConfirmation = useJiraConfirmation(`${scope.expectedRoot}:${source.bindingId}:${source.bindingRevision}:${source.connectionRevision}`)
  const escId = useId()
  const action = useIntegrationAction(`${scope.expectedRoot}:${source.bindingId}:${source.bindingRevision}:${source.connectionRevision}`)
  useEffect(() => { if (!initial && action.current()) flowFocus.current?.focus({ preventScroll: true }) }, [initial, step, action.current])
  const read = useJiraReads(api, scope)
  const needsRebind = Object.entries(source).some(([key, expected]) => value.plan.source[key as keyof IntegrationSource] !== expected)
  const dirty = Boolean(draft) || baseline.current !== JSON.stringify(value)
  const close = async (): Promise<void> => {
    if (action.busy || !action.current()) return
    if (dirty && !await askConfirmation({ title: '放弃未保存的同步配置？', confirmText: '放弃配置', danger: true })) return
    if (action.current()) onClose()
  }
  useEscLayer(!initial, { kind: 'preview', id: `jira-sync-${escId}`, onClose: () => void close(), deferWhenInputFocused: true })
  useEffect(() => {
    if (!value.rules.outboundCreate) return
    let live = true
    void api.localTasks(scope).then((result) => {
      if (!live || !action.current()) return
      if (result.ok) { setTasks(result.data); setTaskError('') } else setTaskError(result.error)
    }).catch(() => { if (live && action.current()) setTaskError('无法读取可向外创建的本地任务。') })
    return () => { live = false }
  }, [api, scope, value.rules.outboundCreate, action.current])
  const save = (): void => {
    const revision = (initial?.plan.revision ?? 0) + 1
    const mappingRevision = (initial?.mapping.revision ?? 0) + 1
    const parsed = jiraPlanSchema.safeParse({ ...value, mapping: { ...value.mapping, revision: mappingRevision }, plan: { ...value.plan, revision, fieldMappingRevision: mappingRevision } })
    if (!parsed.success) { setValidation(parsed.error.issues[0]?.message ?? '请检查同步配置'); return }
    void action.run(() => api.savePlan({ ...scope, expectedRevision: initial?.plan.revision ?? 0, value: parsed.data })).then((saved) => { if (saved && action.current()) onSaved() })
  }
  const direction = <fieldset disabled={action.busy} className="space-y-2"><legend className="mb-2 text-my-sm font-medium">同步方向</legend><div className="my-segmented integration-auth-methods">{(['inbound', 'bidirectional'] as const).map((direction) => <button key={direction} type="button" aria-pressed={value.plan.direction === direction} className={`my-segment ${value.plan.direction === direction ? 'is-active' : ''}`} onClick={() => setValue({ ...value, plan: { ...value.plan, direction }, rules: { ...value.rules, outboundCreate: false, outboundUpdate: false }, remoteWritesApproved: false })}>{direction === 'inbound' ? 'Jira → 当前项目' : '双向同步'}</button>)}</div></fieldset>
  const statuses = <JiraMappingFields value={value.mapping} onChange={(mapping) => setValue({ ...value, mapping })} metadata={needsRebind ? null : currentMetadata} disabled={action.busy || needsRebind} section="statuses" showTransitions={value.plan.direction === 'bidirectional'} onValidityChange={setStatusValid} />
  const members = <div className="space-y-4"><div className="flex flex-wrap items-end gap-2"><label className="min-w-0 flex-1 space-y-2 text-my-sm"><span>查找 Jira 成员</span><input className="my-input w-full" value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} placeholder="用户名" disabled={action.busy || needsRebind} /></label><Button size="sm" disabled={action.busy || needsRebind} onClick={() => void action.run(() => read((requestId) => api.discover({ ...scope, source, requestId, memberQuery }))).then((metadata) => { if (metadata) setCurrentMetadata(metadata) })}>查找</Button></div><JiraMappingFields value={value.mapping} onChange={(mapping) => setValue({ ...value, mapping })} metadata={needsRebind ? null : currentMetadata} disabled={action.busy || needsRebind} section="members" onValidityChange={setMembersValid} /><p className="text-my-xs text-my-tertiary">只映射已有身份，不会创建或邀请成员。</p></div>
  const options = <div className="space-y-5">
    <JiraMappingFields value={value.mapping} onChange={(mapping) => setValue({ ...value, mapping })} metadata={needsRebind ? null : currentMetadata} disabled={action.busy || needsRebind} section="fields" onValidityChange={setFieldsValid} />
    <fieldset disabled={action.busy || needsRebind} className="space-y-3"><legend className="mb-2 text-my-sm font-medium">同步规则</legend>{(['inboundCreate', 'inboundUpdate', ...(value.plan.direction === 'bidirectional' ? ['outboundCreate', 'outboundUpdate'] : [])] as Array<keyof JiraPlan['rules']>).map((rule) => <label className="flex items-start gap-2 text-my-sm" key={rule}><Checkbox checked={value.rules[rule]} onChange={(enabled) => setValue({ ...value, rules: { ...value.rules, [rule]: enabled }, remoteWritesApproved: false })} />{{ inboundCreate: '从 Jira 创建本地任务', inboundUpdate: '更新已映射的本地字段', outboundCreate: '为明确选择的本地任务创建 Jira Issue', outboundUpdate: '更新 Jira 字段、状态流转和追加评论' }[rule]}</label>)}</fieldset>
    {value.rules.outboundCreate && <fieldset disabled={action.busy} className="space-y-3"><legend className="mb-2 text-my-sm font-medium">允许向 Jira 创建的任务</legend>{tasks?.map((task) => <label key={task.taskRef} className="flex items-center gap-2 text-my-sm"><Checkbox checked={value.outboundTaskRefs.includes(task.taskRef)} onChange={(checked) => setValue({ ...value, outboundTaskRefs: checked ? [...value.outboundTaskRefs, task.taskRef] : value.outboundTaskRefs.filter((ref) => ref !== task.taskRef), remoteWritesApproved: false })} />{task.title}</label>)}{!tasks && !taskError && <p role="status" className="text-my-sm text-my-tertiary">正在读取本地任务…</p>}{tasks?.length === 0 && <p className="text-my-sm text-my-tertiary">没有可选的本地任务。</p>}{taskError && <p role="alert" className="text-my-sm text-my-danger-text">{taskError}</p>}<label className="block space-y-2 text-my-sm"><span>创建 Issue 类型</span><Select ariaLabel="创建 Issue 类型" value={value.createIssueTypeId ?? ''} options={[{ value: '', label: '使用已配置的类型映射' }, ...(currentMetadata?.issueTypes ?? []).map((type) => ({ value: type.id, label: type.name }))]} onChange={(id) => setValue({ ...value, createIssueTypeId: id || null, remoteWritesApproved: false })} /></label></fieldset>}
    <label className="flex items-start gap-2 text-my-sm"><Checkbox checked={value.includeHistory} onChange={(includeHistory) => setValue({ ...value, includeHistory })} />读取可用的历史证据</label><p className="text-my-xs text-my-tertiary">Server 8.1 的部分历史会明确标注；一次性历史导入需另行预览提交。</p>
    <label className="flex items-center gap-2 text-my-sm"><Checkbox checked={value.plan.state === 'active'} onChange={(active) => setValue({ ...value, plan: { ...value.plan, state: active ? 'active' : 'paused' } })} />保存后启用同步</label>
    <details className="space-y-4 text-my-sm" open={value.plan.transport === 'webhook' || undefined}><summary className="cursor-pointer text-my-secondary">更多选项</summary><label className="block space-y-2"><span>同步名称</span><input className="my-input w-full" value={value.name} onChange={(event) => setValue({ ...value, name: event.target.value })} /></label><label className="block space-y-2"><span>JQL 筛选条件</span><textarea className="my-input w-full" value={value.jql} onChange={(event) => setValue({ ...value, jql: event.target.value })} placeholder="留空同步所选项目；不含 ORDER BY" /></label><label className="block space-y-2"><span>变更接收方式</span><Select ariaLabel="变更接收方式" value={value.plan.transport} options={[{ value: 'polling', label: '后台定时同步' }, { value: 'webhook', label: 'Webhook（需要已部署的接收器）' }]} onChange={(transport) => setValue({ ...value, plan: { ...value.plan, transport: transport as 'polling' | 'webhook' } })} /></label>{value.plan.transport === 'webhook' && <label className="block space-y-2"><span>已部署的接收器 ID</span><input className="my-input w-full" value={value.receiverId ?? ''} onChange={(event) => setValue({ ...value, receiverId: event.target.value || null })} /><span className="block text-my-xs text-my-warning-text">当前后台未提供可用接收器。保存会核实真实部署，无法验证时请选择定时同步。</span></label>}</details>
  </div>
  const confirm = <div className="space-y-5"><dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-3 text-my-sm"><dt className="text-my-tertiary">Jira 项目</dt><dd className="break-words">{sourceLabel}</dd><dt className="text-my-tertiary">目标</dt><dd>当前项目</dd><dt className="text-my-tertiary">方向</dt><dd>{value.plan.direction === 'inbound' ? 'Jira → 当前项目' : '双向同步'}</dd><dt className="text-my-tertiary">字段</dt><dd>{value.mapping.fields.length} 个字段 · {value.mapping.fields.includes('status') ? Object.keys(value.mapping.statuses).length : 0} 项状态 · {value.mapping.fields.includes('assignee') ? Object.keys(value.mapping.members).length : 0} 位成员</dd><dt className="text-my-tertiary">历史证据</dt><dd>{value.includeHistory ? '读取可用历史，缺失部分会标注' : '不读取'}</dd><dt className="text-my-tertiary">保存后</dt><dd>{value.plan.state === 'active' ? '启用后台同步' : '保持暂停'}</dd></dl>{value.rules.outboundCreate || value.rules.outboundUpdate ? <label className="flex items-start gap-2 rounded-my-md border border-my-line p-4 text-my-sm"><Checkbox checked={value.remoteWritesApproved} onChange={(approved) => setValue({ ...value, remoteWritesApproved: approved })} /><span>Jira 写入身份：{writeIdentity}。允许写入：{value.rules.outboundCreate ? `为 ${value.outboundTaskRefs.length} 个选定任务创建 Issue；` : ''}{value.rules.outboundUpdate ? '更新映射字段、配置的流转和追加评论；' : ''}执行时仍核实实际账号与每个 Issue 的权限。</span></label> : <p className="text-my-sm text-my-secondary">此配置只从 Jira 读取数据。</p>}</div>
  const canSave = statusValid && membersValid && fieldsValid && !needsRebind && (!(value.rules.outboundCreate || value.rules.outboundUpdate) || value.remoteWritesApproved)
  const body = <>
    {needsRebind && <div className="space-y-3 rounded-my-md border border-my-line p-4"><p className="text-my-sm text-my-warning-text">此同步的来源已变化。重绑将暂停同步、重置映射并关闭向外写入。</p><Button size="sm" disabled={action.busy} onClick={() => { setValue({ ...value, mapping: emptyJiraMapping(), plan: { ...value.plan, source, target, direction: 'inbound', state: 'paused' }, rules: { inboundCreate: true, inboundUpdate: true, outboundCreate: false, outboundUpdate: false }, outboundTaskRefs: [], remoteWritesApproved: false, createIssueTypeId: null }); setStatusValid(true); setMembersValid(true); setFieldsValid(true) }}>确认改用当前项目来源</Button></div>}
    <div hidden={initial ? tab !== 'settings' : step !== 1} className="space-y-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-my-xs text-my-tertiary">Jira 项目 → 当前项目</p><p className="mt-2 text-my-sm font-medium">{sourceLabel}</p></div><Button size="sm" disabled={action.busy} onClick={() => onChangeSource(value)}>重新选择项目</Button></div>{direction}</div>
    <div hidden={initial ? tab !== 'statuses' : step !== 2}>{statuses}</div>
    <div hidden={initial ? tab !== 'users' : step !== 3}>{members}</div>
    <div hidden={initial ? tab !== 'settings' : step !== 4}>{options}</div>
    <div hidden={initial ? tab !== 'settings' : step !== 5}>{confirm}</div>
    {(validation || action.error) && <p role="alert" className="break-words text-my-sm text-my-danger-text">{validation || action.error}</p>}
    {currentMetadata && <details className="text-my-xs text-my-tertiary"><summary className="cursor-pointer">实例与可用范围</summary><p className="mt-2">{currentMetadata.deployment} {currentMetadata.version} · {currentMetadata.authenticatedUser.displayName} · 写入权限逐条核实</p>{currentMetadata.warnings.map((warning, index) => <p key={index} className="mt-2 text-my-warning-text">{warning}</p>)}</details>}
  </>
  const footer = <div className="flex flex-wrap justify-end gap-2 border-t border-my-line pt-4"><Button disabled={action.busy} onClick={() => void close()}>{initial ? '取消' : '返回概览'}</Button>{!initial && step > 1 && <Button disabled={action.busy} onClick={() => { setValidation(''); setStep((step) => step - 1) }}>上一步</Button>}{!initial && step < 5 ? <Button variant="primary" disabled={action.busy || needsRebind || step === 2 && !statusValid || step === 3 && !membersValid || step === 4 && !fieldsValid} onClick={() => { setValidation(''); setStep((step) => step + 1) }}>下一步</Button> : <Button variant="primary" disabled={action.busy || !canSave} onClick={save}>{action.busy ? '正在保存…' : '保存同步配置'}</Button>}</div>
  if (initial) return <Modal open ariaLabel="Jira 同步设置" width="var(--my-integration-drawer-width, var(--my-modal-width))" onClose={() => void close()}><div className="jira-plan-drawer flex h-full flex-col"><div className="shrink-0 space-y-4 border-b border-my-line p-5"><div className="flex items-center justify-between gap-3"><h2 className="text-my-lg font-semibold">{value.name}</h2><Button size="sm" variant="ghost" onClick={() => void close()}>关闭</Button></div><Tabs tabs={[{ id: 'settings', label: '设置' }, { id: 'users', label: '成员' }, { id: 'statuses', label: '状态' }]} active={tab} onChange={setTab} /></div><div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5 my-scrollbar" style={{ scrollbarGutter: 'stable' }}>{body}</div><div className="shrink-0 p-4">{footer}</div></div></Modal>
  return <div className="space-y-6" data-jira-sync-flow><JiraFlowHeader step={step} onBack={() => void close()} /><div ref={flowFocus} role="region" aria-label={JIRA_SYNC_STEPS[step - 1]} tabIndex={-1} className="space-y-5">{body}</div>{footer}</div>
}

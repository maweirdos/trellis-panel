import { useEffect, useRef, useState, type JSX } from 'react'
import type { ExecutionTarget, IntegrationSource } from '@shared/integration-work'
import { JIRA_LIMITS, jiraPlanSchema, type JiraData, type JiraIntegrationApi, type JiraMapping, type JiraPlan, type JiraPreview } from '@shared/jira-integration'
import { Select } from '../../../../../components/Select'
import { Button, Checkbox, Modal } from '../../../../ui'
import { useIntegrationAction } from '../../hooks'
import { JiraMappingFields, emptyJiraMapping } from './JiraMappingFields'
import { useJiraReads } from './use-jira-reads'

type Scope = { expectedRoot: string; workspaceId: string }
export function JiraPlanDialog({ api, scope, source, target, metadata, initial, mapping, onClose, onSaved }: { api: JiraIntegrationApi; scope: Scope; source: IntegrationSource; target: ExecutionTarget; metadata: JiraData<'discover'> | null; initial?: JiraPlan; mapping: JiraMapping; onClose: () => void; onSaved: () => void }): JSX.Element {
  const [value, setValue] = useState<JiraPlan>(() => initial ?? { plan: { id: crypto.randomUUID(), revision: 1, source, target, direction: 'inbound', state: 'paused', transport: 'polling', fieldMappingRevision: mapping.revision }, controlRevision: 1, name: 'Jira 项目同步', jql: '', mapping, rules: { inboundCreate: true, inboundUpdate: true, outboundCreate: false, outboundUpdate: false }, outboundTaskRefs: [], remoteWritesApproved: false, receiverId: null, createIssueTypeId: null, includeHistory: false, since: Date.now(), scanAfterId: null, lastSuccessAt: null, nextPollAt: null, failures: 0, detail: '' })
  const [tasks, setTasks] = useState<JiraData<'localTasks'>>([])
  const action = useIntegrationAction(`${scope.expectedRoot}:${source.bindingId}:${source.bindingRevision}:${source.connectionRevision}`)
  const [validation, setValidation] = useState('')
  const [mappingValid, setMappingValid] = useState(true)
  const needsRebind = Object.entries(source).some(([key, expected]) => value.plan.source[key as keyof IntegrationSource] !== expected)
  useEffect(() => {
    let live = true
    void api.localTasks(scope).then((result) => { if (live && action.current()) { if (result.ok) setTasks(result.data); else setValidation(result.error) } }).catch(() => { if (live && action.current()) setValidation('无法读取可向外创建的本地任务。') })
    return () => { live = false }
  }, [api, scope.expectedRoot, scope.workspaceId, action.current])
  const save = (): void => {
    const revision = (initial?.plan.revision ?? 0) + 1; const mappingRevision = (initial?.mapping.revision ?? 0) + 1
    const next = { ...value, mapping: { ...value.mapping, revision: mappingRevision }, plan: { ...value.plan, revision, fieldMappingRevision: mappingRevision } }
    const parsed = jiraPlanSchema.safeParse(next)
    if (!parsed.success) { setValidation(parsed.error.issues[0]?.message ?? '映射无效'); return }
    void action.run(() => api.savePlan({ ...scope, expectedRevision: initial?.plan.revision ?? 0, value: parsed.data })).then((saved) => { if (saved) onSaved() })
  }
  return <Modal open ariaLabel="配置 Jira 项目同步" onClose={() => { if (!action.busy) onClose() }}>
    <div className="flex max-h-[var(--my-modal-max-height)] flex-col">
    <div className="shrink-0 border-b border-my-line p-5"><h2 className="text-my-lg font-semibold">{initial ? '编辑' : '创建'} Jira 项目同步</h2><p className="mt-2 text-my-xs text-my-tertiary">本机工作区 · 项目 {value.plan.source.remoteProjectId} · 连接版本 {value.plan.source.connectionRevision}</p></div>
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5 my-scrollbar" style={{ scrollbarGutter: 'stable' }}>
      {needsRebind && <div className="space-y-2"><p className="text-my-sm text-my-warning-text">此同步的来源与当前验证的项目不同。明确重绑会暂停同步、重置映射并关闭向外写入。</p><Button size="sm" disabled={action.busy} onClick={() => setValue({ ...value, mapping: emptyJiraMapping(), plan: { ...value.plan, source, target, direction: 'inbound', state: 'paused' }, rules: { inboundCreate: true, inboundUpdate: true, outboundCreate: false, outboundUpdate: false }, outboundTaskRefs: [], remoteWritesApproved: false, createIssueTypeId: null })}>改用当前已验证的 Jira 项目</Button></div>}
      <label className="block space-y-1 text-my-sm"><span>同步名称</span><input className="my-input w-full" value={value.name} onChange={(event) => setValue({ ...value, name: event.target.value })} /></label>
      <label className="block space-y-1 text-my-sm"><span>JQL 筛选条件（项目范围自动固定，不含 ORDER BY）</span><textarea className="my-input w-full" value={value.jql} onChange={(event) => setValue({ ...value, jql: event.target.value })} /></label>
      <Select ariaLabel="同步方向" value={value.plan.direction} options={[{ value: 'inbound', label: 'Jira → 本地' }, { value: 'bidirectional', label: '显式双向同步' }]} onChange={(direction) => setValue({ ...value, plan: { ...value.plan, direction: direction as 'inbound' | 'bidirectional' }, rules: { ...value.rules, outboundCreate: false, outboundUpdate: false }, remoteWritesApproved: false })} />
      <div className="space-y-2">{(['inboundCreate', 'inboundUpdate', ...(value.plan.direction === 'bidirectional' ? ['outboundCreate', 'outboundUpdate'] : [])] as Array<keyof JiraPlan['rules']>).map((rule) => <label className="flex items-center gap-2 text-my-sm" key={rule}><Checkbox checked={value.rules[rule]} onChange={(enabled) => setValue({ ...value, rules: { ...value.rules, [rule]: enabled } })} />{{ inboundCreate: '允许从 Jira 创建本地任务', inboundUpdate: '允许更新已映射本地字段', outboundCreate: '允许为下方明确选择的本地任务创建 Jira Issue', outboundUpdate: '允许更新 Jira 已映射字段、已配置流转和追加评论' }[rule]}</label>)}</div>
      {value.plan.direction === 'bidirectional' && <><label className="flex items-center gap-2 text-my-sm"><Checkbox checked={value.remoteWritesApproved} onChange={(approved) => setValue({ ...value, remoteWritesApproved: approved })} />确认启用上述 Jira 写入规则（执行时仍重新核实账号和 Issue 权限）</label>{value.rules.outboundCreate && <fieldset className="space-y-2"><legend className="mb-2 text-my-sm">明确选择可向外创建的本地任务</legend>{tasks.map((task) => <label key={task.taskRef} className="flex items-center gap-2 text-my-sm"><Checkbox checked={value.outboundTaskRefs.includes(task.taskRef)} onChange={(checked) => setValue({ ...value, outboundTaskRefs: checked ? [...value.outboundTaskRefs, task.taskRef] : value.outboundTaskRefs.filter((ref) => ref !== task.taskRef) })} />{task.title}</label>)}</fieldset>}</>}
      <Select ariaLabel="变更接收方式" value={value.plan.transport} options={[{ value: 'polling', label: '本机后台定时同步（60 秒起，失败退避）' }, { value: 'webhook', label: '已部署的受验证 Webhook 接收器' }]} onChange={(transport) => setValue({ ...value, plan: { ...value.plan, transport: transport as 'polling' | 'webhook' } })} />
      {value.rules.outboundCreate && <Select ariaLabel="向外创建 Jira Issue 的明确类型" value={value.createIssueTypeId ?? ''} options={[{ value: '', label: '选择创建类型（有本地类型映射时可留空）' }, ...(metadata?.issueTypes ?? []).map((type) => ({ value: type.id, label: type.name }))]} onChange={(id) => setValue({ ...value, createIssueTypeId: id || null })} />}
      {value.plan.transport === 'webhook' && <label className="block space-y-1 text-my-sm"><span>原生接收器 ID</span><input className="my-input w-full" value={value.receiverId ?? ''} onChange={(event) => setValue({ ...value, receiverId: event.target.value || null })} /><span className="text-my-xs text-my-tertiary">保存前核实实际可达性和认证。未部署接收器时可选择定时同步。</span></label>}
      <JiraMappingFields value={value.mapping} onChange={(mapping) => setValue({ ...value, mapping })} metadata={needsRebind ? null : metadata} disabled={action.busy || needsRebind} onValidityChange={setMappingValid} />
      <label className="flex items-center gap-2 text-my-sm"><Checkbox checked={value.includeHistory} onChange={(includeHistory) => setValue({ ...value, includeHistory })} />保留可读取的历史记录（Server 8.1 部分历史将明确标注）</label>
      <label className="flex items-center gap-2 text-my-sm"><Checkbox checked={value.plan.state === 'active'} onChange={(active) => setValue({ ...value, plan: { ...value.plan, state: active ? 'active' : 'paused' } })} />保存后启用后台同步</label>
      {(validation || action.error) && <p role="alert" className="text-my-sm text-my-danger-text">{validation || action.error}</p>}
    </div><div className="flex shrink-0 justify-end gap-2 border-t border-my-line p-4"><Button disabled={action.busy} onClick={onClose}>取消</Button><Button variant="primary" disabled={action.busy || !mappingValid || needsRebind} onClick={save}>保存同步配置</Button></div>
    </div>
  </Modal>
}

const defaultColumns = { issueId: 'Issue id', key: 'Issue key', title: 'Summary', description: 'Description', priority: '', status: '', assignee: '', labels: '', type: '', updated: '' }
export function JiraImportDialog({ api, scope, source, metadata, mapping, onClose, onStarted }: { api: JiraIntegrationApi; scope: Scope; source: IntegrationSource; metadata: JiraData<'discover'> | null; mapping: JiraMapping; onClose: () => void; onStarted: () => void }): JSX.Element {
  const [format, setFormat] = useState<'api' | 'csv'>('api'); const [jql, setJql] = useState(''); const [csv, setCsv] = useState(''); const [filename, setFilename] = useState('')
  const [columns, setColumns] = useState(defaultColumns); const [map, setMap] = useState(mapping); const [includeHistory, setIncludeHistory] = useState(false)
  const [preview, setPreview] = useState<JiraPreview | null>(null); const [acknowledged, setAcknowledged] = useState(false); const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [mappingValid, setMappingValid] = useState(true)
  const command = useRef(crypto.randomUUID())
  const action = useIntegrationAction(`${scope.expectedRoot}:${source.bindingId}:${source.bindingRevision}:${source.connectionRevision}`)
  const read = useJiraReads(api, scope)
  const inspect = (): void => {
    command.current = crypto.randomUUID(); setError('')
    void action.run(() => read((requestId) => format === 'api' ? api.previewApi({ ...scope, source, requestId, jql, mapping: map, includeHistory, maxItems: 50 }) : api.previewCsv({ ...scope, source, requestId, csv, columns, mapping: map, includeHistory: false }))).then((data) => { if (data) { setPreview(data); setAcknowledged(false) } })
  }
  return <Modal open ariaLabel="预览与导入 Jira Issue" onClose={() => { if (!submitting) onClose() }}>
    <div className="flex max-h-[var(--my-modal-max-height)] flex-col">
    <div className="border-b border-my-line p-5"><h2 className="text-my-lg font-semibold">独立导入 Issue 数据</h2><p className="mt-2 text-my-xs text-my-tertiary">导入与持续同步独立。API 作业会逐页读取整个选定查询；预览只是有界样本。</p></div>
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5 my-scrollbar" style={{ scrollbarGutter: 'stable' }}>
      {!preview ? <><Select ariaLabel="导入格式" value={format} options={[{ value: 'api', label: 'Jira REST v2 API' }, { value: 'csv', label: 'CSV 文件' }]} onChange={(value) => setFormat(value as 'api' | 'csv')} />
        {format === 'api' ? <><label className="block space-y-1 text-my-sm"><span>JQL 筛选条件</span><textarea className="my-input w-full" value={jql} onChange={(event) => setJql(event.target.value)} placeholder="留空导入选定项目；不要填写 ORDER BY" /></label><label className="flex items-center gap-2 text-my-sm"><Checkbox checked={includeHistory} onChange={setIncludeHistory} />读取可用的评论和历史证据</label></> : <><label className="block space-y-1 text-my-sm"><span>CSV 文件（UTF-8，最多 {JIRA_LIMITS.csvBytes / 1024} KiB / 500 行）</span><input type="file" accept=".csv,text/csv" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; if (file.size > JIRA_LIMITS.csvBytes) { setError('CSV 超过容量限制'); return }; void file.text().then((text) => { if (action.current()) { setCsv(text); setFilename(file.name) } }) }} /><span className="text-my-xs text-my-tertiary">{filename} · 数字 Issue ID、Issue key 和 Summary 必填；字段名请与 CSV 表头完全一致。</span></label><div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{Object.keys(columns).map((column) => <label key={column} className="block space-y-1 text-my-sm"><span>{column}</span><input className="my-input w-full" value={columns[column as keyof typeof columns]} onChange={(event) => setColumns({ ...columns, [column]: event.target.value })} /></label>)}</div></>}
        <JiraMappingFields value={map} onChange={setMap} metadata={metadata} disabled={action.busy} onValidityChange={setMappingValid} />
      </> : <><p className="text-my-sm">已预览 {preview.count} 条 · 来源总量 {preview.total ?? '未知'} · {preview.scope === 'full-query' ? '导入范围：整个固定项目查询（数字 ID 上界已保留）' : '导入范围：本文件所有记录'}</p><p className="break-words text-my-xs text-my-tertiary">{preview.query}</p>{preview.sample.map((issue) => <div key={issue.issueId} className="border-t border-my-line pt-2 text-my-sm">{issue.key} · {issue.fields.title}</div>)}{preview.warnings.map((warning, index) => <p key={index} className="text-my-xs text-my-warning-text">{warning}</p>)}<label className="flex items-center gap-2 text-my-sm"><Checkbox checked={acknowledged} onChange={setAcknowledged} />已核对实例、项目、字段映射与覆盖说明</label><Button size="sm" disabled={action.busy} onClick={() => setPreview(null)}>修改并重新预览</Button></>}
      {(error || action.error) && <p role="alert" className="text-my-sm text-my-danger-text">{error || action.error}</p>}
    </div><div className="flex shrink-0 justify-end gap-2 border-t border-my-line p-4"><Button disabled={submitting} onClick={onClose}>关闭</Button>{preview ? <Button variant="primary" disabled={action.busy || !acknowledged} onClick={() => { setSubmitting(true); void action.run(() => api.startImport({ ...scope, previewId: preview.id, digest: preview.digest, commandId: command.current, acceptPartial: acknowledged })).then((job) => { if (action.current()) setSubmitting(false); if (job) onStarted() }) }}>提交后台导入</Button> : <Button variant="primary" disabled={action.busy || !mappingValid || format === 'csv' && !csv} onClick={inspect}>验证并预览</Button>}</div>
    </div>
  </Modal>
}

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { IntegrationJob, IntegrationSource } from '@shared/integration-work'
import type { JiraData, JiraIntegrationApi, JiraPlan, JiraItemReceipt } from '@shared/jira-integration'
import { Select } from '../../../../../components/Select'
import { Button, Modal } from '../../../../ui'
import { useApp } from '../../../../../store'
import { IntegrationAccountSection, IntegrationImportSection, IntegrationResourceState, IntegrationSection, IntegrationSyncSection, type IntegrationResource, type IntegrationSectionAction } from '../../IntegrationSections'
import type { ProviderWorkspaceProps } from '../../provider-workspace'
import { useIntegrationAction, useIntegrationRead } from '../../hooks'
import { jiraIntegrationBridge } from './bridge'
import { emptyJiraMapping } from './JiraMappingFields'
import { JiraImportDialog, JiraPlanDialog } from './JiraDialogs'
import { useJiraReads } from './use-jira-reads'

type PageData = { context: JiraData<'context'>; snapshot: JiraData<'snapshot'>; history: JiraData<'history'> }
function unavailable(detail: string): IntegrationResource<never> { return { state: 'unavailable', detail } }
export function JiraProviderContent(props: ProviderWorkspaceProps): JSX.Element {
  const native = jiraIntegrationBridge()
  if (!props.root || !props.nativeAvailable || !native) return <><IntegrationAccountSection resource={unavailable(!props.root ? '打开并授权一个本机项目后，可分别绑定实例与个人 Jira 账号。' : 'Jira 后台工作区原生能力尚未安装。当前连接和手动查询入口仍可使用；需要加载对应主进程、preload 与 daemon 后再配置同步。')} /><IntegrationSyncSection resource={unavailable('没有实际后台能力时不会保存模拟同步配置。')} /><IntegrationImportSection resource={unavailable('尚未读取到真实导入作业。已有手动导入不会生成虚构历史。')} action={{ label: '打开查询与手动导入', disabled: !props.root || !props.nativeAvailable, onClick: () => useApp.getState().setPage('jira') }} /></>
  const key = `${props.root}:${props.connection?.id ?? ''}:${props.connections.map((connection) => `${connection.id}:${connection.revision}`).join(',')}:${props.bindings.map((binding) => `${binding.id}:${binding.revision}:${binding.enabled}`).join(',')}`
  return <JiraWorkspaceContent key={key} {...props} root={props.root} native={native} ownerKey={key} />
}

function JiraWorkspaceContent({ root, native, ownerKey, ...props }: ProviderWorkspaceProps & { root: string; native: JiraIntegrationApi; ownerKey: string }): JSX.Element {
  const [connectionId, setConnectionId] = useState(props.connection?.id ?? props.connections.find((connection) => connection.providerId === 'jira')?.id ?? '')
  const connection = props.connections.find((connection) => connection.id === connectionId && connection.providerId === 'jira')
  const bindings = props.bindings.filter((binding) => binding.connectionId === connectionId && binding.enabled)
  const [bindingId, setBindingId] = useState(bindings[0]?.id ?? '')
  const binding = bindings.find((binding) => binding.id === bindingId)
  const [projects, setProjects] = useState<JiraData<'projects'>>([]); const [projectId, setProjectId] = useState(''); const [sourceKey, setSourceKey] = useState('')
  const [metadata, setMetadata] = useState<JiraData<'discover'> | null>(null); const [memberQuery, setMemberQuery] = useState('')
  const [planDialog, setPlanDialog] = useState<{ initial?: JiraPlan } | null>(null); const [importing, setImporting] = useState(false); const [accountDialog, setAccountDialog] = useState(false); const [personalId, setPersonalId] = useState('')
  const [selectedJob, setSelectedJob] = useState<IntegrationJob | null>(null); const [items, setItems] = useState<JiraItemReceipt[]>([]); const [itemNext, setItemNext] = useState<string | null>(null)
  const [rollbackJob, setRollbackJob] = useState<IntegrationJob | null>(null)
  const [after, setAfter] = useState<string | null>(null); const [historyStack, setHistoryStack] = useState<Array<string | null>>([])
  const action = useIntegrationAction(`${ownerKey}:${connectionId}:${sourceKey}`)
  const commandIds = useRef(new Map<string, string>())
  const command = (key: string): string => { const prior = commandIds.current.get(key); if (prior) return prior; const id = crypto.randomUUID(); commandIds.current.set(key, id); return id }
  const load = useCallback(async (): Promise<IntegrationResource<PageData>> => {
    const context = await native.context({ expectedRoot: root }); if (!context.ok) return { state: context.code === 'E_UNAVAILABLE' ? 'unavailable' : 'error', detail: context.error }
    const scope = { expectedRoot: root, workspaceId: context.data.workspaceId }
    const snapshot = await native.snapshot(scope); if (!snapshot.ok) return { state: 'error', detail: snapshot.error }
    const history = await native.history({ ...scope, after, limit: 20 }); if (!history.ok) return { state: 'error', detail: history.error }
    return { state: 'ready', data: { context: context.data, snapshot: snapshot.data, history: history.data } }
  }, [native, root, after])
  const reading = useIntegrationRead(`${ownerKey}:${after ?? ''}`, load)
  const lastReady = useRef<PageData | null>(null)
  if (reading.resource.state === 'ready') lastReady.current = reading.resource.data
  const data = lastReady.current
  const scope = useMemo(() => data ? { expectedRoot: root, workspaceId: data.context.workspaceId } : null, [root, data?.context.workspaceId])
  const read = useJiraReads(native, scope)
  const sources = data?.context.sources.filter((entry) => entry.source.connectionId === connectionId && props.bindings.some((binding) => binding.id === entry.source.bindingId && binding.revision === entry.source.bindingRevision && binding.enabled) && connection?.revision === entry.source.connectionRevision) ?? []
  const source: IntegrationSource | undefined = sources.find((entry) => `${entry.source.bindingId}:${entry.source.remoteProjectId}` === sourceKey)?.source ?? sources[0]?.source
  const effectiveSourceKey = source ? `${source.bindingId}:${source.bindingRevision}:${source.remoteProjectId}:${source.connectionRevision}` : ''
  useEffect(() => { setMetadata(null) }, [effectiveSourceKey])
  useEffect(() => {
    if (!data?.history.items.some((job) => ['queued', 'dispatched', 'running', 'cancel-requested'].includes(job.state))) return
    const timer = setInterval(reading.refresh, 5000)
    return () => clearInterval(timer)
  }, [data?.history.items, reading.refresh])
  const refresh = (): void => { reading.refresh(); void props.refresh() }
  const ready = Boolean(scope && source && connection?.enabled)
  const jobInput = (job: IntegrationJob) => ({ ...scope, expectedRoot: root, workspaceId: job.workspaceId, jobId: job.id, revision: job.revision, ownerEpoch: job.ownerEpoch })
  const detail = (job: IntegrationJob, cursor: string | null = null): void => {
    if (!scope) return
    void action.run(() => native.jobDetail({ ...scope, jobId: job.id, after: cursor, limit: 50 })).then((page) => { if (page) { setSelectedJob(job); setItems((prior) => cursor ? [...prior, ...page.items] : page.items); setItemNext(page.next) } })
  }
  const jobActions = (job: IntegrationJob): IntegrationSectionAction[] => {
    const actions: IntegrationSectionAction[] = [{ label: '明细', disabled: action.busy, onClick: () => detail(job) }]
    if (['queued', 'running', 'dispatched', 'paused'].includes(job.state)) actions.push({ label: '取消作业', disabled: action.busy, onClick: () => void action.run(() => native.cancel({ ...jobInput(job), commandId: command(`cancel:${job.id}:${job.revision}`) })).then(refresh) })
    if (job.state === 'paused') actions.push({ label: '从检查点恢复', disabled: action.busy, onClick: () => void action.run(() => native.resume({ ...jobInput(job), commandId: command(`resume:${job.id}:${job.revision}`) })).then(refresh) })
    if (job.state === 'unknown') actions.push({ label: '核实原作业', disabled: action.busy, onClick: () => void action.run(() => native.reconcile(jobInput(job))).then(refresh) })
    if (job.input.kind === 'import' && ['completed', 'partially-failed', 'cancelled', 'rollback-blocked'].includes(job.state)) actions.push({ label: '检查并回滚本次创建', disabled: action.busy, onClick: () => setRollbackJob(job) })
    return actions
  }
  return <div className="space-y-5">
    <IntegrationSection title="Jira 实例与项目来源" description="连接凭证在上方管理。这里验证并固定实例、项目数字 ID 与项目绑定；个人账号单独配置。">
      <p className="break-words text-my-xs text-my-tertiary">本机工作区 · {root}</p>
      {reading.resource.state !== 'ready' && <IntegrationResourceState resource={reading.resource} />}
      <Select ariaLabel="Jira 实例连接" value={connectionId} options={[{ value: '', label: '选择已有 Jira 连接' }, ...props.connections.filter((connection) => connection.providerId === 'jira').map((connection) => ({ value: connection.id, label: `${connection.name}${connection.enabled ? '' : '（停用）'}` }))]} onChange={(id) => { setConnectionId(id); setBindingId(''); setProjects([]); setSourceKey(''); setMetadata(null) }} />
      <Select ariaLabel="当前项目 Jira 绑定" value={bindingId} options={[{ value: '', label: '选择已启用的当前项目绑定' }, ...bindings.map((binding) => ({ value: binding.id, label: binding.label }))]} onChange={(id) => { setBindingId(id); setProjects([]) }} />
      {!bindings.length && <p className="text-my-sm text-my-tertiary">请在上方连接面板添加并启用当前项目绑定；不会静默使用全局来源。</p>}
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={!scope || !connection?.enabled || !binding || action.busy} onClick={() => { if (!scope || !connection || !binding) return; void action.run(() => read((requestId) => native.projects({ ...scope, requestId, connectionId: connection.id, connectionRevision: connection.revision, bindingId: binding.id, bindingRevision: binding.revision }))).then((items) => { if (items) setProjects(items) }) }}>读取可访问项目</Button><Button size="sm" disabled={action.busy} onClick={reading.refresh}>刷新状态</Button></div>
      {projects.length > 0 && <div className="flex flex-wrap gap-2"><div className="min-w-0 flex-1"><Select ariaLabel="选择 Jira 项目" value={projectId} options={[{ value: '', label: '选择项目' }, ...projects.map((project) => ({ value: project.id, label: `${project.key} · ${project.name}` }))]} onChange={setProjectId} /></div><Button size="sm" disabled={!scope || !connection || !binding || !projectId || action.busy} onClick={() => { if (!scope || !connection || !binding) return; void action.run(() => native.selectProject({ ...scope, connectionId: connection.id, connectionRevision: connection.revision, bindingId: binding.id, bindingRevision: binding.revision, projectId })).then((source) => { if (source) { setSourceKey(`${source.bindingId}:${source.remoteProjectId}`); reading.refresh() } }) }}>验证并使用此项目</Button></div>}
      {sources.length > 0 && <Select ariaLabel="已固定的 Jira 项目来源" value={source ? `${source.bindingId}:${source.remoteProjectId}` : ''} options={sources.map((entry) => ({ value: `${entry.source.bindingId}:${entry.source.remoteProjectId}`, label: entry.name }))} onChange={setSourceKey} />}
      <div className="flex flex-wrap items-center gap-2"><input className="my-input min-w-0 flex-1" aria-label="查找 Jira 成员用户名" placeholder="成员用户名筛选（可选）" value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} /><Button size="sm" disabled={!ready || action.busy} onClick={() => { if (!scope || !source) return; void action.run(() => read((requestId) => native.discover({ ...scope, source, requestId, memberQuery }))).then((metadata) => { if (metadata) setMetadata(metadata) }) }}>验证实例并读取映射选项</Button></div>
      {metadata && <p className="text-my-sm text-my-secondary">{metadata.deployment} {metadata.version} · 实例访问身份 {metadata.authenticatedUser.displayName} ({metadata.authenticatedUser.name}) · 项目 {source?.remoteProjectId} · 写入权限逐条 Issue 核实</p>}
      <Button size="sm" onClick={() => useApp.getState().setPage('jira')}>打开现有 Jira 查询与手动导入</Button>
    </IntegrationSection>
    <IntegrationAccountSection resource={data ? { state: 'ready', data: data.snapshot.accounts.filter((account) => account.connectionId === connectionId) } : reading.resource.state === 'ready' ? unavailable('账号不可用') : reading.resource} action={{ label: '绑定独立个人凭证', disabled: !ready || action.busy, onClick: () => setAccountDialog(true) }} accountAction={(account) => ({ label: '解除绑定', disabled: !scope || !source || action.busy, onClick: () => { if (!scope || !source) return; void action.run(() => native.bindAccount({ ...scope, source, expectedRevision: account.revision, unlink: true, personalConnection: null })).then(refresh) } })} />
    {data?.snapshot.identities.filter((identity) => identity.sourceConnectionId === connectionId).map((identity) => <p key={identity.sourceConnectionId} className="text-my-xs text-my-tertiary">{identity.mode === 'personal-connection' ? '个人写入身份' : '实例凭证回退身份'}：{identity.username} · {identity.detail}</p>)}
    <IntegrationSyncSection resource={data ? { state: 'ready', data: data.snapshot.plans.filter((plan) => plan.plan.source.connectionId === connectionId).map((plan) => plan.plan) } : reading.resource.state === 'ready' ? unavailable('同步状态不可用') : reading.resource} action={{ label: '创建同步', disabled: !ready || !metadata || action.busy, onClick: () => setPlanDialog({}) }} label={(plan) => data?.snapshot.plans.find((item) => item.plan.id === plan.id)?.name ?? plan.source.remoteProjectId} planAction={(plan) => ({ label: plan.state === 'paused' ? '启用' : '暂停', disabled: !scope || action.busy, onClick: () => { if (!scope) return; void action.run(() => native.planState({ ...scope, planId: plan.id, revision: plan.revision, controlRevision: data?.snapshot.plans.find((entry) => entry.plan.id === plan.id)?.controlRevision ?? 0, state: plan.state === 'paused' ? 'active' : 'paused' })).then(refresh) } })} />
    {data?.snapshot.plans.filter((plan) => plan.plan.source.connectionId === connectionId).map((plan) => <div key={plan.plan.id} className="space-y-2 rounded-my-md border border-my-line p-3"><p className="text-my-xs text-my-tertiary">{plan.detail} · 上次成功 {plan.lastSuccessAt ? new Date(plan.lastSuccessAt).toLocaleString() : '尚无'} · 下次检查 {plan.nextPollAt ? new Date(plan.nextPollAt).toLocaleString() : '暂停'}</p><div className="flex flex-wrap gap-2"><Button size="sm" disabled={!ready || action.busy} onClick={() => setPlanDialog({ initial: plan })}>编辑映射与规则</Button><Button size="sm" disabled={!scope || action.busy || plan.plan.state === 'paused'} onClick={() => { if (!scope) return; void action.run(() => native.catchUp({ ...scope, planId: plan.plan.id, revision: plan.plan.revision, commandId: command(`catch-up:${plan.plan.id}:${plan.plan.revision}:${data?.history.items.find((job) => job.input.kind === 'sync' && job.input.planId === plan.plan.id)?.id ?? 'first'}`) })).then(refresh) }}>立即追赶同步</Button>{plan.receiverId && <Button size="sm" disabled={!scope || action.busy} onClick={() => { if (!scope) return; void action.run(() => native.receiver({ ...scope, planId: plan.plan.id, revision: plan.plan.revision, recover: true, commandId: command(`receiver:${plan.plan.id}:${plan.plan.revision}`) })).then(refresh) }}>诊断并恢复接收器</Button>}</div></div>)}
    <IntegrationImportSection resource={data ? { state: 'ready', data: data.history.items.map((job) => ({ job, sourceLabel: `Jira · 项目 ${job.source.remoteProjectId}`, destinationLabel: root, detail: data.history.rollbacks.some((summary) => summary.jobId === job.id) ? data.history.rollbacks.filter((summary) => summary.jobId === job.id).map((summary) => `已回滚 ${summary.removed} 项 · 回滚阻止 ${summary.blocked} 项`).join('') : job.input.kind === 'sync' ? '持续同步作业' : '独立导入作业' })) } : reading.resource.state === 'ready' ? unavailable('历史不可用') : reading.resource} action={{ label: 'API / CSV 预览与导入', disabled: !ready || !metadata || action.busy, onClick: () => setImporting(true) }} jobActions={jobActions} pagination={data ? { hasMore: Boolean(data.history.next), next: { label: '下一页', onClick: () => { setHistoryStack([...historyStack, after]); setAfter(data.history.next) } }, previous: historyStack.length ? { label: '上一页', onClick: () => { setAfter(historyStack.at(-1) ?? null); setHistoryStack(historyStack.slice(0, -1)) } } : undefined } : undefined} />
    <IntegrationSection title="冲突与诊断" description="并发修改需要明确选择。选择只记录处理意图，后续后台作业执行并重新检查权限。">
      {data?.snapshot.conflicts.map((conflict) => <div key={conflict.id} className="space-y-2 border-t border-my-line pt-3"><p className="text-my-sm">Issue {conflict.issueId} · {conflict.field}</p><div className="grid gap-2 sm:grid-cols-2"><pre className="whitespace-pre-wrap break-words text-my-xs">本地：{JSON.stringify(conflict.local)}</pre><pre className="whitespace-pre-wrap break-words text-my-xs">Jira：{JSON.stringify(conflict.remote)}</pre></div><div className="flex gap-2">{(['local', 'remote'] as const).map((choice) => <Button size="sm" key={choice} disabled={!scope || action.busy} onClick={() => { if (!scope) return; void action.run(() => native.resolveConflict({ ...scope, conflictId: conflict.id, revision: conflict.revision, choice })).then(refresh) }}>{choice === 'local' ? '选择本地值' : '选择 Jira 值'}</Button>)}</div></div>)}
      {data?.snapshot.diagnostics.slice(-20).reverse().map((diagnostic, index) => <p key={index} className="text-my-xs text-my-secondary">{new Date(diagnostic.at).toLocaleString()} · {diagnostic.code} · {diagnostic.detail}</p>)}
      {data && !data.snapshot.conflicts.length && !data.snapshot.diagnostics.length && <p className="text-my-sm text-my-tertiary">当前没有保留的冲突或诊断记录。</p>}
    </IntegrationSection>
    {action.error && <p role="alert" className="text-my-sm text-my-danger-text">{action.error}</p>}
    {accountDialog && scope && source && <Modal open ariaLabel="绑定独立 Jira 个人账号" onClose={() => { if (!action.busy) setAccountDialog(false) }}><div className="space-y-4 p-5"><h2 className="font-semibold">个人 Jira 账号</h2><p className="text-my-sm text-my-secondary">先在实例连接面板新增一条个人 Jira 连接并保存受保护凭证，再在此独立验证身份。不会复制或重命名管理员账号。</p><Select ariaLabel="个人受保护连接" value={personalId} onChange={setPersonalId} options={[{ value: '', label: '选择独立个人连接' }, ...props.connections.filter((item) => item.providerId === 'jira' && item.id !== source.connectionId && item.enabled).map((item) => ({ value: item.id, label: `${item.name} (${item.config.user})` }))]} /><Button variant="primary" disabled={action.busy || !personalId} onClick={() => { const personal = props.connections.find((item) => item.id === personalId); if (!personal) return; void action.run(() => native.bindAccount({ ...scope, source, expectedRevision: data?.snapshot.accounts.find((account) => account.connectionId === source.connectionId)?.revision ?? 0, unlink: false, personalConnection: { connectionId: personal.id, connectionRevision: personal.revision } })).then((account) => { if (account) { setAccountDialog(false); refresh() } }) }}>验证并绑定个人账号</Button>{action.error && <p role="alert" className="text-my-sm text-my-danger-text">{action.error}</p>}</div></Modal>}
    {planDialog && scope && source && data && <JiraPlanDialog api={native} scope={scope} source={source} target={data.context.target} metadata={metadata} initial={planDialog.initial} mapping={planDialog.initial?.mapping ?? emptyJiraMapping()} onClose={() => setPlanDialog(null)} onSaved={() => { setPlanDialog(null); refresh() }} />}
    {importing && scope && source && <JiraImportDialog api={native} scope={scope} source={source} metadata={metadata} mapping={data?.snapshot.plans.find((plan) => plan.plan.source.bindingId === source.bindingId)?.mapping ?? emptyJiraMapping()} onClose={() => setImporting(false)} onStarted={() => { setImporting(false); refresh() }} />}
    {selectedJob && <Modal open ariaLabel="Jira 作业逐项证据" onClose={() => setSelectedJob(null)}><div className="space-y-3 overflow-y-auto p-5 my-scrollbar"><h2 className="font-semibold">作业逐项记录</h2>{items.length === 0 && <p className="text-my-sm text-my-tertiary">没有已提交的逐项证据；不能据此推断远端没有发生操作。</p>}{items.map((item) => <div key={item.id} className="space-y-1 border-t border-my-line pt-3"><p className="text-my-sm">{item.key || item.issueId || item.taskRef} · {item.effect} · {item.state}</p><p className="text-my-xs text-my-tertiary">{item.detail}</p></div>)}{itemNext && <Button size="sm" disabled={action.busy} onClick={() => detail(selectedJob, itemNext)}>加载更多逐项记录</Button>}</div></Modal>}
    {rollbackJob && <Modal open ariaLabel="确认检查并回滚 Jira 导入" onClose={() => { if (!action.busy) setRollbackJob(null) }}><div className="space-y-4 p-5"><h2 className="font-semibold">检查并回滚本次创建</h2><p className="text-my-sm">只移除该作业明确创建且所有文件、来源关联和运行状态均未变化的本地任务。原始证据保留在隔离目录；已编辑、原有和结果未知的任务受保护。远端 Jira Issue 保留。</p><Button variant="danger" disabled={action.busy} onClick={() => void action.run(() => native.rollback({ ...jobInput(rollbackJob), commandId: command(`rollback:${rollbackJob.id}`) })).then((result) => { if (result) { setRollbackJob(null); refresh() } })}>检查守卫并回滚</Button>{action.error && <p role="alert" className="text-my-sm text-my-danger-text">{action.error}</p>}</div></Modal>}
  </div>
}

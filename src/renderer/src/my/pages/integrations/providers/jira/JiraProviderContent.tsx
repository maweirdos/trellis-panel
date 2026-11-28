import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { ChevronRight, MoreHorizontal, Plus } from 'lucide-react'
import type { IntegrationJob, IntegrationSource, SyncPlan } from '@shared/integration-work'
import type { JiraData, JiraIntegrationApi, JiraPlan, JiraItemReceipt } from '@shared/jira-integration'
import { Select } from '../../../../../components/Select'
import { useEscLayer } from '../../../../../utils/use-esc-layer'
import { Button, DisclosureGrid, Dropdown, Modal, Tooltip } from '../../../../ui'

function JiraDiagnosticsDisclosure({ children }: { children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false)
  return <div className="text-my-xs text-my-tertiary">
    <button type="button" className="inline-flex items-center gap-1 transition-colors hover:text-my-primary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
      <ChevronRight size={12} className={`shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`} />
      <span>工作区诊断</span>
    </button>
    <DisclosureGrid open={open}><div className="mt-2 space-y-3">{children}</div></DisclosureGrid>
  </div>
}
import { projectRootKey } from '../../../../navigation'
import { useApp } from '../../../../../store'
import { IntegrationJobHistory, IntegrationResourceState, IntegrationSection, type IntegrationResource, type IntegrationSectionAction } from '../../IntegrationSections'
import type { ProviderWorkspaceProps } from '../../provider-workspace'
import { useIntegrationAction, useIntegrationRead } from '../../hooks'
import { jiraIntegrationBridge } from './bridge'
import { emptyJiraMapping } from './JiraMappingFields'
import { JiraImportDialog } from './JiraDialogs'
import { JiraPlanDialog } from './JiraPlanFlow'
import { JiraSourceDialog, type JiraPreparedSource } from './JiraSourceDialog'
import { JiraFlowHeader } from './JiraFlowHeader'
import { useJiraConfirmation } from './use-jira-confirmation'
import { jiraImportSettled, useJiraImportSubmissions } from './use-jira-import-submissions'

type PageData = { context: JiraData<'context'>; snapshot: JiraData<'snapshot'>; history: JiraData<'history'> }
type Intent = { kind: 'plan'; initial?: JiraPlan; draft?: JiraPlan } | { kind: 'import' } | { kind: 'account' }
type OpenDialog = { intent: Intent; prepared: JiraPreparedSource; guard: string; startStep?: 1 | 2 }
const planStates: Record<SyncPlan['state'], string> = { unverified: '尚未验证', active: '已启用', paused: '已暂停', degraded: '需要处理', blocked: '已阻止' }
const accountStates = { unverified: '待验证', linked: '已绑定', revoked: '授权已撤销', unavailable: '暂不可用' }
function sameSource(left: IntegrationSource, right: IntegrationSource): boolean { return Object.entries(left).every(([key, value]) => right[key as keyof IntegrationSource] === value) }
function newPlan(intent?: Intent | null): boolean { return intent?.kind === 'plan' && !intent.initial }

function JiraSetupButton({ label, reason, busy, onClick, variant = 'neutral', trailing }: { label: string; reason?: string; busy: boolean; onClick: () => void; variant?: 'neutral' | 'ghost'; trailing?: ReactNode }): JSX.Element {
  const button = <Button size="sm" variant={variant} disabled={busy || Boolean(reason)} onClick={onClick}>{label}{trailing}</Button>
  return reason ? <Tooltip label={reason}><span role="group" tabIndex={0} aria-label={`${label}：${reason}`}>{button}</span></Tooltip> : button
}

/** Provider-local header composition keeps prerequisite tooltips out of the shared API. */
function JiraSetupSection({ title, label, reason, busy, onClick, children }: { title: string; label: string; reason?: string; busy: boolean; onClick: () => void; children: ReactNode }): JSX.Element {
  const id = useId()
  return <section aria-labelledby={id} className="integration-section rounded-my-base border border-my-line bg-my-surface-1"><div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"><h3 id={id} className="min-w-0 flex-1 text-my-sm font-medium">{title}</h3><JiraSetupButton label={label} reason={reason} busy={busy} onClick={onClick} /></div><div className="space-y-3 px-5 pb-4">{children}</div></section>
}

export function JiraProviderContent(props: ProviderWorkspaceProps): JSX.Element {
  const native = jiraIntegrationBridge()
  if (!props.root || !props.nativeAvailable || !native) return <div className="space-y-5"><IntegrationSection title="个人账号"><p className="text-my-sm text-my-tertiary">{!props.root ? '打开本机项目后配置 Jira。' : '当前版本无法读取 Jira 后台工作区。'}</p></IntegrationSection><IntegrationSection title="项目同步"><p className="text-my-sm text-my-tertiary">{!props.root ? '请先打开项目。' : '同步能力暂不可用，请完整退出并重新打开应用。'}</p></IntegrationSection><IntegrationSection title="导入 Issue 数据"><Button size="sm" disabled={!props.root || !props.nativeAvailable} onClick={() => useApp.getState().setPage('jira')}>查询与手动导入</Button></IntegrationSection></div>
  // Binding updates preserve the focused association detour. The actual selected
  // instance/root replaces this owner; there is no child instance picker.
  const ownerKey = `${props.root}:${props.connection?.id ?? ''}:${props.connection?.revision ?? 0}:${props.connection?.enabled ?? false}`
  return <JiraWorkspaceContent key={ownerKey} {...props} root={props.root} native={native} ownerKey={ownerKey} />
}

function JiraWorkspaceContent({ root, native, ownerKey, ...props }: ProviderWorkspaceProps & { root: string; native: JiraIntegrationApi; ownerKey: string }): JSX.Element {
  const connection = props.connection
  const connectionId = connection?.id
  const setupReason = !connection ? '请先绑定 Jira 实例' : !connection.enabled ? '请先启用 Jira 实例' : undefined
  const bindings = props.bindings.filter((binding) => projectRootKey(binding.root) === projectRootKey(root) && binding.connectionId === connectionId)
  const bindingGuard = bindings.map((binding) => `${binding.id}:${binding.revision}:${binding.enabled}`).join(',')
  const guard = `${ownerKey}:${bindingGuard}:${props.connections.map((item) => `${item.id}:${item.revision}:${item.enabled}`).join(',')}`
  const [prepared, setPrepared] = useState<JiraPreparedSource | null>(null)
  const [setup, setSetup] = useState<Intent | null>(null)
  const [awaitingBinding, setAwaitingBinding] = useState(false)
  const [dialog, setDialog] = useState<OpenDialog | null>(null)
  const [personalId, setPersonalId] = useState('')
  const [selectedJob, setSelectedJob] = useState<IntegrationJob | null>(null)
  const [items, setItems] = useState<JiraItemReceipt[]>([])
  const [itemNext, setItemNext] = useState<string | null>(null)
  const [rollbackJob, setRollbackJob] = useState<IntegrationJob | null>(null)
  const [after, setAfter] = useState<string | null>(null)
  const [historyStack, setHistoryStack] = useState<Array<string | null>>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [importRecoveryKey, setImportRecoveryKey] = useState<string | null>(null)
  const action = useIntegrationAction(guard)
  const askConfirmation = useJiraConfirmation(guard)
  const setupEscId = useId()
  const commandIds = useRef(new Map<string, string>())
  const command = (key: string): string => { const prior = commandIds.current.get(key); if (prior) return prior; const id = crypto.randomUUID(); commandIds.current.set(key, id); return id }
  const load = useCallback(async (): Promise<IntegrationResource<PageData>> => {
    const context = await native.context({ expectedRoot: root }); if (!context.ok) return { state: context.code === 'E_UNAVAILABLE' ? 'unavailable' : 'error', detail: context.error }
    const scope = { expectedRoot: root, workspaceId: context.data.workspaceId }
    const snapshot = await native.snapshot(scope); if (!snapshot.ok) return { state: 'error', detail: snapshot.error }
    const history = await native.history({ ...scope, after, limit: 20 }); if (!history.ok) return { state: 'error', detail: history.error }
    return { state: 'ready', data: { context: context.data, snapshot: snapshot.data, history: history.data } }
  }, [native, root, after])
  const reading = useIntegrationRead(`${guard}:${after ?? ''}`, load)
  const lastReady = useRef<PageData | null>(null)
  if (reading.resource.state === 'ready') lastReady.current = reading.resource.data
  const data = lastReady.current
  const scope = useMemo(() => data ? { expectedRoot: root, workspaceId: data.context.workspaceId } : null, [root, data?.context.workspaceId])
  const sourceCurrent = (source: IntegrationSource): boolean => source.connectionId === connectionId && source.connectionRevision === connection?.revision && Boolean(connection?.enabled && bindings.some((binding) => binding.id === source.bindingId && binding.revision === source.bindingRevision && binding.enabled))
  const importSubmissions = useJiraImportSubmissions(native, guard, sourceCurrent, scope)
  const retainedImports = importSubmissions.entries.filter((entry) => entry.state !== 'previewed' && !jiraImportSettled(entry))
  const retainedImportKey = retainedImports[0]?.key
  const importRecovery = importSubmissions.entries.find((entry) => entry.key === importRecoveryKey)
  useEffect(() => {
    if (scope && reading.resource.state === 'ready') importSubmissions.observeHistory(scope, reading.resource.data.history.items)
  }, [scope, reading.resource, importSubmissions.observeHistory])
  const sources = data?.context.sources.filter((entry) => sourceCurrent(entry.source)) ?? []
  const currentPrepared = prepared && sourceCurrent(prepared.source) ? prepared : null
  const currentDialog = dialog && dialog.guard === guard && sourceCurrent(dialog.prepared.source) ? dialog : null
  const source = currentPrepared?.source ?? sources[0]?.source
  const plans = data?.snapshot.plans.filter((entry) => entry.plan.source.connectionId === connectionId) ?? []
  const planIds = new Set(plans.map((entry) => entry.plan.id))
  const conflicts = data?.snapshot.conflicts.filter((conflict) => planIds.has(conflict.planId)) ?? []
  const account = data?.snapshot.accounts.find((item) => item.connectionId === connectionId)
  const identity = data?.snapshot.identities.find((item) => item.sourceConnectionId === connectionId)
  const visibleJobs = data?.history.items.filter((job) => job.source.connectionId === connectionId) ?? []
  const flowActive = newPlan(setup) || newPlan(currentDialog?.intent)
  const flowCallback = useRef(props.onFlowChange)
  flowCallback.current = props.onFlowChange
  useLayoutEffect(() => { flowCallback.current?.(flowActive); return () => flowCallback.current?.(false) }, [flowActive])
  useEffect(() => {
    if (!data?.history.items.some((job) => ['queued', 'dispatched', 'running', 'cancel-requested'].includes(job.state))) return
    const timer = setInterval(reading.refresh, 5000)
    return () => clearInterval(timer)
  }, [data?.history.items, reading.refresh])
  useEffect(() => {
    if (dialog && !currentDialog) {
      setDialog(null); setPrepared(null)
      if (dialog.intent.kind === 'import' && retainedImportKey) { setSetup(null); setImportRecoveryKey(retainedImportKey) }
      else setSetup(dialog.intent)
    }
  }, [guard, dialog, currentDialog, retainedImportKey])
  useEffect(() => {
    if (awaitingBinding && bindings.some((binding) => binding.enabled)) { setAwaitingBinding(false); reading.refresh() }
  }, [awaitingBinding, bindingGuard, reading.refresh])
  const refresh = (): void => { if (action.current()) { reading.refresh(); void props.refresh() } }
  const showLatestHistory = (): void => {
    if (!action.current()) return
    setDialog(null); setImportRecoveryKey(null); setAfter(null); setHistoryStack([]); setHistoryOpen(true); reading.refresh()
  }
  const newImport = (): void => {
    if (!action.current()) return
    setDialog(null); setImportRecoveryKey(null); setPrepared(null); setAwaitingBinding(false); setSetup({ kind: 'import' })
  }
  const begin = (intent: Intent): void => {
    if (!action.current()) return
    if (intent.kind === 'import' && retainedImports[0]) {
      setDialog(null); setSetup(null); setImportRecoveryKey(retainedImports[0].key); return
    }
    setImportRecoveryKey(null)
    if (!connection?.enabled) return
    setAwaitingBinding(false)
    const desired = intent.kind === 'plan' ? intent.initial?.plan.source : undefined
    if (currentPrepared && (!desired || sameSource(desired, currentPrepared.source))) { setSetup(null); setDialog({ intent, prepared: currentPrepared, guard }) }
    else { setDialog(null); setSetup(intent) }
  }
  const closeSetup = async (): Promise<void> => {
    if (setup?.kind === 'plan' && setup.draft && !await askConfirmation({ title: '放弃未保存的同步配置？', confirmText: '放弃配置', danger: true })) return
    if (action.current()) { setSetup(null); setAwaitingBinding(false) }
  }
  useEscLayer(newPlan(setup), { kind: 'preview', id: `jira-source-${setupEscId}`, onClose: () => void closeSetup(), deferWhenInputFocused: true })
  const jobInput = (job: IntegrationJob) => ({ expectedRoot: root, workspaceId: job.workspaceId, jobId: job.id, revision: job.revision, ownerEpoch: job.ownerEpoch })
  const changePlanState = async (entry: JiraPlan): Promise<void> => {
    if (!scope || !action.current()) return
    if (entry.plan.state !== 'paused' && !await askConfirmation({ title: '暂停此项目同步？', message: '将暂停后续调度。已派发的作业需在历史记录中单独取消。', confirmText: '暂停同步' })) return
    if (!action.current()) return
    const result = await action.run(() => native.planState({ ...scope, planId: entry.plan.id, revision: entry.plan.revision, controlRevision: entry.controlRevision, state: entry.plan.state === 'paused' ? 'active' : 'paused' }))
    if (result) refresh()
  }
  const detail = (job: IntegrationJob, cursor: string | null = null): void => {
    if (!scope) return
    void action.run(() => native.jobDetail({ ...scope, jobId: job.id, after: cursor, limit: 50 })).then((page) => { if (page) { setSelectedJob(job); setItems((prior) => cursor ? [...prior, ...page.items] : page.items); setItemNext(page.next) } })
  }
  const reconcileJob = (job: IntegrationJob): void => {
    if (job.state !== 'unknown' || !action.current()) return
    void action.run(() => native.reconcile(jobInput(job))).then((result) => { if (result) refresh() })
  }
  const jobActions = (job: IntegrationJob): IntegrationSectionAction[] => {
    const actions: IntegrationSectionAction[] = [{ label: '明细', disabled: action.busy, onClick: () => detail(job) }]
    if (['queued', 'running', 'dispatched', 'paused'].includes(job.state)) actions.push({ label: '取消作业', disabled: action.busy, onClick: () => void action.run(() => native.cancel({ ...jobInput(job), commandId: command(`cancel:${job.id}:${job.revision}`) })).then((result) => { if (result) refresh() }) })
    if (job.state === 'paused') actions.push({ label: '从检查点恢复', disabled: action.busy, onClick: () => void action.run(() => native.resume({ ...jobInput(job), commandId: command(`resume:${job.id}:${job.revision}`) })).then((result) => { if (result) refresh() }) })
    if (job.state === 'unknown') actions.push({ label: '核实原作业', disabled: action.busy, onClick: () => reconcileJob(job) })
    if (job.input.kind === 'import' && ['completed', 'partially-failed', 'cancelled', 'rollback-blocked'].includes(job.state)) actions.push({ label: '检查并回滚本次创建', disabled: action.busy, onClick: () => setRollbackJob(job) })
    return actions
  }
  const sourceLabel = (source: IntegrationSource): string => sources.find((entry) => sameSource(entry.source, source))?.name ?? `Jira 项目 ${source.remoteProjectId}`
  const waiting = reading.resource.state !== 'ready' ? <div className="space-y-3"><IntegrationResourceState resource={reading.resource} />{reading.resource.state !== 'loading' && <Button size="sm" onClick={reading.refresh}>重试读取</Button>}</div> : null
  const setupContent = setup && !awaitingBinding && scope && connection ? <JiraSourceDialog embedded={newPlan(setup)} api={native} scope={scope} connection={connection} bindings={bindings} initial={setup.kind === 'plan' ? setup.initial?.plan.source ?? currentPrepared?.source ?? sources[0]?.source : source} title={setup.kind === 'plan' ? '选择同步项目' : setup.kind === 'import' ? '选择导入来源' : '个人账号 · 选择项目'} onAssociate={(binding) => { setAwaitingBinding(true); props.onBindProject(binding) }} onClose={() => void closeSetup()} onPrepared={(prepared) => { if (!action.current()) return; setPrepared(prepared); setDialog({ intent: setup, prepared, guard, startStep: newPlan(setup) ? 2 : undefined }); setSetup(null); reading.refresh() }} /> : null
  return <div className="space-y-6">
    {!flowActive && <>
      <section aria-label="个人 Jira 账号" className="integration-account-row"><div className="min-w-0 flex-1 break-words text-my-sm"><h3 className="my-item-title inline">个人 Jira 账号</h3><span className="ml-2 text-my-tertiary">{account ? `${account.displayName || account.remoteUserId} · ${accountStates[account.state]}` : data ? '未绑定' : reading.resource.state === 'loading' ? '正在读取…' : '暂不可用'}</span></div><JiraSetupButton label="管理账号" reason={setupReason} busy={action.busy} variant="ghost" onClick={() => begin({ kind: 'account' })} trailing={<ChevronRight size={14} aria-hidden="true" />} /></section>
      {waiting}
      <JiraSetupSection title="项目同步" label="新建同步" reason={setupReason} busy={action.busy} onClick={() => begin({ kind: 'plan' })}>
        {data && !plans.length && <div className="flex items-center gap-3 py-3"><Plus size={18} className="text-my-icon-tertiary" /><p className="my-item-description">尚未配置项目同步</p></div>}
        {plans.map((entry) => <div key={entry.plan.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-my-line py-3 last:border-b-0"><button type="button" className="min-w-0 flex-1 text-left" onClick={() => begin({ kind: 'plan', initial: entry })}><p className="my-item-title break-words">{entry.name}</p><p className="my-item-description mt-1">{sourceLabel(entry.plan.source)} {entry.plan.direction === 'inbound' ? '→' : '↔'} 当前项目 · {entry.plan.direction === 'inbound' ? '单向同步' : '双向同步'}</p><p className="mt-1 text-my-xs text-my-tertiary">{planStates[entry.plan.state]}{entry.lastSuccessAt ? ` · 上次同步 ${new Date(entry.lastSuccessAt).toLocaleString()}` : ''}</p></button><Dropdown align="right" trigger={({ toggle }) => <Button size="sm" variant="ghost" aria-label={`${entry.name} 操作`} onClick={toggle}><MoreHorizontal size={16} /></Button>}>{(close) => <>
          <button type="button" className="my-menu-item" disabled={action.busy} onClick={() => { close(); begin({ kind: 'plan', initial: entry }) }}>设置与映射</button>
          <button type="button" className="my-menu-item" disabled={!scope || action.busy} onClick={() => { close(); void changePlanState(entry) }}>{entry.plan.state === 'paused' ? '启用同步' : '暂停同步'}</button>
          <button type="button" className="my-menu-item" disabled={!scope || action.busy || entry.plan.state === 'paused'} onClick={() => { if (!scope) return; close(); void action.run(() => native.catchUp({ ...scope, planId: entry.plan.id, revision: entry.plan.revision, commandId: command(`catch-up:${entry.plan.id}:${entry.plan.revision}:${data?.history.items.find((job) => job.input.kind === 'sync' && job.input.planId === entry.plan.id)?.id ?? 'first'}`) })).then((result) => { if (result) refresh() }) }}>立即同步</button>
          {entry.receiverId && <button type="button" className="my-menu-item" disabled={!scope || action.busy} onClick={() => { if (!scope) return; close(); void action.run(() => native.receiver({ ...scope, planId: entry.plan.id, revision: entry.plan.revision, recover: true, commandId: command(`receiver:${entry.plan.id}:${entry.plan.revision}`) })).then((result) => { if (result) refresh() }) }}>诊断并恢复接收器</button>}
          {entry.detail && <p className="max-w-full break-words px-3 py-2 text-my-xs text-my-tertiary">{entry.detail}{entry.nextPollAt ? ` · 下次检查 ${new Date(entry.nextPollAt).toLocaleString()}` : ''}</p>}
        </>}</Dropdown></div>)}
      </JiraSetupSection>
      <JiraSetupSection title="导入 Issue 数据" label="导入" reason={setupReason} busy={action.busy} onClick={() => begin({ kind: 'import' })}><p className="my-item-description">从 Jira 或 CSV 一次性导入已有 Issue。</p>{retainedImports.map((entry) => <div key={entry.key} className="space-y-2 rounded-my-base border border-my-line p-3"><p className="text-my-sm">{sourceLabel(entry.source)} · {entry.state === 'pending' ? '正在等待原提交回复' : entry.state === 'unknown' ? '原提交结果待核实' : '原导入作业尚未结束'}</p><p className="break-all text-my-xs text-my-tertiary">提交标识：{entry.commandId}</p><Button size="sm" onClick={() => { if (action.current()) { setDialog(null); setSetup(null); setImportRecoveryKey(entry.key) } }}>查看原提交</Button></div>)}<div className="space-y-4"><button type="button" className="my-item-title inline-flex items-center gap-1 transition-colors hover:text-my-primary" aria-expanded={historyOpen} onClick={() => setHistoryOpen((v) => !v)}><ChevronRight size={12} className={`shrink-0 transition-transform duration-150 ${historyOpen ? 'rotate-90' : ''}`} /><span>导入与同步历史{data ? ` · 本页 ${visibleJobs.length} 条` : ''}</span></button><DisclosureGrid open={historyOpen}><div className="space-y-4">{data ? <><IntegrationJobHistory resource={{ state: 'ready', data: visibleJobs.map((job) => ({ job, sourceLabel: sourceLabel(job.source), destinationLabel: '当前项目', detail: data.history.rollbacks.some((summary) => summary.jobId === job.id) ? data.history.rollbacks.filter((summary) => summary.jobId === job.id).map((summary) => `已回滚 ${summary.removed} 项 · 回滚阻止 ${summary.blocked} 项`).join('') : job.input.kind === 'sync' ? '持续同步作业' : '独立导入作业' })) }} jobActions={jobActions} pagination={{ hasMore: Boolean(data.history.next), next: { label: '下一页', disabled: reading.resource.state !== 'ready', onClick: () => { if (!data.history.next) return; setHistoryStack([...historyStack, after]); setAfter(data.history.next) } }, previous: historyStack.length ? { label: '上一页', disabled: reading.resource.state !== 'ready', onClick: () => { setAfter(historyStack.at(-1) ?? null); setHistoryStack(historyStack.slice(0, -1)) } } : undefined }} /><p className="text-my-xs text-my-tertiary">按工作区历史分页，本页仅显示当前实例；其他页面仍可能有此实例的记录。</p></> : waiting}</div></DisclosureGrid></div></JiraSetupSection>
      {conflicts.length > 0 && <IntegrationSection title={`待处理冲突 · ${conflicts.length}`}><p className="text-my-xs text-my-tertiary">选择记录处理意图，后续同步重新检查权限后执行。</p>{conflicts.map((conflict) => <div key={conflict.id} className="space-y-3 border-t border-my-line pt-3"><p className="text-my-sm">Issue {conflict.issueId} · {conflict.field}</p><div className="grid gap-2 sm:grid-cols-2"><pre className="whitespace-pre-wrap break-words text-my-xs">本地：{JSON.stringify(conflict.local)}</pre><pre className="whitespace-pre-wrap break-words text-my-xs">Jira：{JSON.stringify(conflict.remote)}</pre></div><div className="flex flex-wrap gap-2">{(['local', 'remote'] as const).map((choice) => <Button size="sm" key={choice} disabled={!scope || action.busy} onClick={() => { if (!scope) return; void action.run(() => native.resolveConflict({ ...scope, conflictId: conflict.id, revision: conflict.revision, choice })).then((result) => { if (result) refresh() }) }}>{choice === 'local' ? '使用本地值（写回 Jira）' : '使用 Jira 值'}</Button>)}</div></div>)}</IntegrationSection>}
      <div className="flex justify-end"><Dropdown align="right" trigger={({ toggle }) => <Button size="sm" variant="ghost" onClick={toggle}><MoreHorizontal size={14} />更多</Button>}>{(close) => <><button type="button" className="my-menu-item" onClick={() => { close(); reading.refresh() }}>刷新状态</button><button type="button" className="my-menu-item" onClick={() => { close(); props.onBindProject(bindings.find((binding) => binding.enabled) ?? bindings[0]) }} disabled={!connection?.enabled}>项目关联</button><button type="button" className="my-menu-item" onClick={() => { close(); useApp.getState().setPage('jira') }}>查询与手动导入</button></>}</Dropdown></div>
      <JiraDiagnosticsDisclosure>{identity && <p>{identity.mode === 'personal-connection' ? '个人写入身份' : '实例凭证回退身份'}：{identity.username || '不可用'} · {identity.detail}</p>}{data?.snapshot.diagnostics.slice(-20).reverse().map((diagnostic, index) => <p key={index} className="break-words">{new Date(diagnostic.at).toLocaleString()} · {diagnostic.code} · {diagnostic.detail}</p>)}{data && !data.snapshot.diagnostics.length && <p>暂无诊断记录。</p>}</JiraDiagnosticsDisclosure>
    </>}
    {action.error && <p role="alert" className="break-words text-my-sm text-my-danger-text">{action.error}</p>}
    {newPlan(setup) ? <div className="space-y-6"><JiraFlowHeader step={1} onBack={() => void closeSetup()} />{awaitingBinding ? <div className="space-y-4"><p className="text-my-sm text-my-secondary">关联当前项目后继续选择 Jira 项目。</p><Button onClick={() => setAwaitingBinding(false)}>继续设置</Button></div> : scope ? setupContent : waiting}</div> : setupContent}
    {setup && awaitingBinding && !newPlan(setup) && <div className="space-y-3"><p className="text-my-sm text-my-secondary">关联当前项目后继续。</p><Button size="sm" onClick={() => setAwaitingBinding(false)}>继续设置</Button><Button size="sm" variant="ghost" onClick={() => void closeSetup()}>取消</Button></div>}
    {currentDialog?.intent.kind === 'account' && scope && <Modal open placement="center" ariaLabel="管理 Jira 个人账号" onClose={() => { if (!action.busy) setDialog(null) }}><div className="border-b border-my-line p-5"><h2 className="text-my-lg font-medium">个人 Jira 账号</h2><p className="my-item-description mt-1">使用同一 Jira 地址的独立个人凭证</p></div><div className="space-y-4 p-5"><label className="block space-y-2"><span className="my-item-title">个人凭证</span><Select ariaLabel="个人受保护连接" value={personalId} onChange={setPersonalId} disabled={action.busy} options={[{ value: '', label: '选择已保存的个人连接' }, ...props.connections.filter((item) => item.providerId === 'jira' && item.id !== connectionId && item.enabled && !item.legacy).map((item) => ({ value: item.id, label: `${item.name} (${item.config.user || '未指定用户名'})` }))]} /></label><Button size="sm" variant="ghost" disabled={action.busy} onClick={() => { setDialog(null); props.onConnect() }}>新增个人凭证</Button>{account && <p className="text-my-sm text-my-secondary">当前：{account.displayName} · {accountStates[account.state]}</p>}{!account && identity?.mode === 'instance-credential-fallback' && <p className="text-my-xs text-my-warning-text">未绑定个人账号时，Jira 写入使用实例凭证身份：{identity.username || '不可用'}。</p>}{action.error && <p role="alert" className="text-my-sm text-my-danger-text">{action.error}</p>}</div><div className="flex flex-wrap justify-end gap-2 border-t border-my-line p-4">{account && <Button variant="ghost" disabled={action.busy} onClick={() => void action.run(() => native.bindAccount({ ...scope, source: currentDialog.prepared.source, expectedRevision: account.revision, unlink: true, personalConnection: null })).then((result) => { if (result !== undefined) { setDialog(null); refresh() } })}>解除绑定</Button>}<Button disabled={action.busy} onClick={() => setDialog(null)}>取消</Button><Button variant="primary" disabled={action.busy || !personalId} onClick={() => { const personal = props.connections.find((item) => item.id === personalId && item.enabled && !item.legacy); if (!personal) return; void action.run(() => native.bindAccount({ ...scope, source: currentDialog.prepared.source, expectedRevision: account?.revision ?? 0, unlink: false, personalConnection: { connectionId: personal.id, connectionRevision: personal.revision } })).then((result) => { if (result) { setDialog(null); refresh() } }) }}>{action.busy ? '正在验证…' : '验证并绑定'}</Button></div></Modal>}
    {currentDialog?.intent.kind === 'plan' && scope && data && <JiraPlanDialog key={`${guard}:${currentDialog.prepared.source.bindingId}:${currentDialog.prepared.source.remoteProjectId}`} api={native} scope={scope} source={currentDialog.prepared.source} sourceLabel={sourceLabel(currentDialog.prepared.source)} writeIdentity={account ? `${account.displayName}（${accountStates[account.state]}，不可用时不回退到实例账号）` : `实例账号 ${identity?.username || '尚未验证'}`} target={data.context.target} metadata={currentDialog.prepared.metadata} initial={currentDialog.intent.initial} draft={currentDialog.intent.draft} startStep={currentDialog.startStep} mapping={currentDialog.intent.initial?.mapping ?? emptyJiraMapping()} onChangeSource={(draft) => { setSetup({ kind: 'plan', initial: currentDialog.intent.kind === 'plan' ? currentDialog.intent.initial : undefined, draft }); setPrepared(null); setDialog(null) }} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); refresh() }} />}
    {currentDialog?.intent.kind === 'import' && scope && <JiraImportDialog key={guard} api={native} scope={scope} source={currentDialog.prepared.source} metadata={currentDialog.prepared.metadata} mapping={plans.find((plan) => sameSource(plan.plan.source, currentDialog.prepared.source))?.mapping ?? emptyJiraMapping()} submissions={importSubmissions} reconciliationBusy={action.busy} onReconcile={() => { const original = importSubmissions.get(scope, currentDialog.prepared.source)?.job; if (original) reconcileJob(original) }} onClose={() => setDialog(null)} onCheckHistory={showLatestHistory} onNewImport={newImport} onStarted={showLatestHistory} />}
    {importRecovery && <JiraImportDialog key={importRecovery.key} api={native} scope={importRecovery.scope} source={importRecovery.source} metadata={null} mapping={importRecovery.preview.mapping} submissions={importSubmissions} reconciliationBusy={action.busy} onReconcile={() => { if (importRecovery.job) reconcileJob(importRecovery.job) }} canUseSource={Boolean(scope && scope.workspaceId === importRecovery.scope.workspaceId && sourceCurrent(importRecovery.source))} onClose={() => setImportRecoveryKey(null)} onCheckHistory={showLatestHistory} onNewImport={newImport} onStarted={showLatestHistory} />}
    {selectedJob && <Modal open placement="center" ariaLabel="Jira 作业逐项证据" onClose={() => setSelectedJob(null)}><div className="flex max-h-[var(--my-modal-max-height)] flex-col"><div className="shrink-0 border-b border-my-line p-5"><h2 className="font-medium">作业逐项记录</h2></div><div className="min-h-0 space-y-3 overflow-y-auto p-5 my-scrollbar">{items.length === 0 && <p className="text-my-sm text-my-tertiary">没有已提交的逐项证据；不能据此推断远端没有发生操作。</p>}{items.map((item) => <div key={item.id} className="space-y-1 border-t border-my-line pt-3"><p className="text-my-sm">{item.key || item.issueId || item.taskRef} · {item.effect} · {item.state}</p><p className="break-words text-my-xs text-my-tertiary">{item.detail}</p></div>)}{itemNext && <Button size="sm" disabled={action.busy} onClick={() => detail(selectedJob, itemNext)}>加载更多逐项记录</Button>}</div></div></Modal>}
    {rollbackJob && <Modal open placement="center" ariaLabel="确认检查并回滚 Jira 导入" onClose={() => { if (!action.busy) setRollbackJob(null) }}><div className="space-y-4 p-5"><h2 className="font-medium">检查并回滚本次创建</h2><p className="text-my-sm">只移除本次明确创建且文件、来源关联和运行状态均未变化的本地任务。已编辑、原有和结果未知的任务受保护，远端 Jira Issue 保留。</p><div className="flex flex-wrap justify-end gap-2"><Button disabled={action.busy} onClick={() => setRollbackJob(null)}>取消</Button><Button variant="danger" disabled={action.busy} onClick={() => void action.run(() => native.rollback({ ...jobInput(rollbackJob), commandId: command(`rollback:${rollbackJob.id}`) })).then((result) => { if (result) { setRollbackJob(null); refresh() } })}>检查守卫并回滚</Button></div>{action.error && <p role="alert" className="text-my-sm text-my-danger-text">{action.error}</p>}</div></Modal>}
  </div>
}

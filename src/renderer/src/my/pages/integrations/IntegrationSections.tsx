import { useId, type JSX, type ReactNode } from 'react'
import { AlertCircle, LoaderCircle, MoreHorizontal, Plus, Trash2 } from 'lucide-react'
import type { IntegrationAccount, IntegrationJob, IntegrationJobState, SyncPlan } from '../../../../../shared/integration-work'
import { Select } from '../../../components/Select'
import { Button, Dropdown, DropdownItem } from '../../ui'

export type IntegrationResource<T> =
  | { state: 'loading' }
  | { state: 'unavailable' | 'denied' | 'error'; detail: string; action?: IntegrationSectionAction }
  | { state: 'ready'; data: T }
export interface IntegrationSectionAction { label: string; onClick: () => void; disabled?: boolean; busy?: boolean }

export function SectionAction({ action }: { action: IntegrationSectionAction }): JSX.Element {
  return <Button size="sm" disabled={action.disabled || action.busy} onClick={action.onClick}>{action.busy && <LoaderCircle size={13} className="animate-spin motion-reduce:animate-none" />}{action.label}</Button>
}
export function IntegrationSection({ title, description, action, children }: { title: string; description?: string; action?: IntegrationSectionAction; children?: ReactNode }): JSX.Element {
  const id = useId()
  return <section aria-labelledby={id} className="preference-section integration-section">
    <header className="preference-section-heading"><div className="min-w-0 flex-1"><h2 id={id}>{title}</h2>{description && <p className="mt-1 text-my-sm text-my-tertiary">{description}</p>}</div>{action && <SectionAction action={action} />}</header>
    {children && <div className="preference-section-body"><div className="space-y-3 py-4">{children}</div></div>}
  </section>
}
export function IntegrationResourceState({ resource }: { resource: Exclude<IntegrationResource<unknown>, { state: 'ready' }> }): JSX.Element {
  return <div role={resource.state === 'error' ? 'alert' : 'status'} className="flex flex-wrap items-center gap-2 text-my-sm text-my-secondary">
    {resource.state === 'loading' ? <><LoaderCircle size={15} className="animate-spin motion-reduce:animate-none" />正在读取…</> : <><AlertCircle size={15} className="shrink-0" /><span className="min-w-0 flex-1 break-words">{resource.detail}</span>{resource.action && <SectionAction action={resource.action} />}</>}
  </div>
}
const accountStates: Record<IntegrationAccount['state'], string> = { unverified: '尚未验证', linked: '已绑定', revoked: '授权已撤销', unavailable: '暂不可用' }
export function IntegrationAccountSection({ resource, action, accountAction, title = '个人账号', description, emptyLabel = '尚未绑定' }: { resource: IntegrationResource<readonly IntegrationAccount[]>; action?: IntegrationSectionAction; accountAction?: (account: IntegrationAccount) => IntegrationSectionAction | undefined; title?: string; description?: string; emptyLabel?: string }): JSX.Element {
  const id = useId()
  return <section aria-labelledby={id} className="integration-account-row"><div className="min-w-0"><h3 id={id} className="text-my-sm font-medium">{title}</h3>{description && <p className="mt-1 text-my-xs text-my-tertiary">{description}</p>}</div>
    <div className="min-w-0 flex-1">{resource.state !== 'ready' ? <IntegrationResourceState resource={resource} /> : resource.data.length === 0 ? <p className="text-my-sm text-my-tertiary">{emptyLabel}</p> : resource.data.map((account) => {
      const itemAction = accountAction?.(account)
      return <div key={account.id} className="flex flex-wrap items-center gap-2"><p className="break-words text-my-sm">{account.displayName || account.remoteUserId}</p><span className="text-my-xs text-my-tertiary">{accountStates[account.state]}</span>{itemAction && <Dropdown align="right" trigger={({ open, toggle }) => <Button size="sm" variant="ghost" aria-label={`${account.displayName || '个人账号'}的更多操作`} aria-expanded={open} onClick={toggle}><MoreHorizontal size={15} /></Button>}>{(close) => <DropdownItem disabled={itemAction.disabled || itemAction.busy} onClick={() => { close(); itemAction.onClick() }}>{itemAction.label}</DropdownItem>}</Dropdown>}</div>
    })}</div>{action && <SectionAction action={action} />}
  </section>
}
const planStates: Record<SyncPlan['state'], string> = { unverified: '尚未验证', active: '已启用', paused: '已暂停', degraded: '需要处理', blocked: '已阻止' }
const transports: Record<SyncPlan['transport'], string> = { polling: '定时同步', webhook: 'Webhook', stream: 'Stream', unavailable: '接收方式不可用' }
export function IntegrationSyncSection({ resource, action, label, planAction, title = '项目同步', description }: { resource: IntegrationResource<readonly SyncPlan[]>; action?: IntegrationSectionAction; label?: (plan: SyncPlan) => string; planAction?: (plan: SyncPlan) => IntegrationSectionAction | undefined; title?: string; description?: string }): JSX.Element {
  return <IntegrationSection title={title} description={description} action={action}>
    {resource.state !== 'ready' ? <IntegrationResourceState resource={resource} /> : resource.data.length === 0 ? <p className="text-my-sm text-my-tertiary">尚未创建同步</p> : resource.data.map((plan) => {
      const itemAction = planAction?.(plan)
      return <div key={plan.id} className="integration-list-row"><div className="min-w-0 flex-1"><p className="break-words text-my-sm">{label?.(plan) ?? plan.source.remoteProjectId}</p><p className="mt-1 text-my-xs text-my-tertiary">{planStates[plan.state]} · {plan.direction === 'inbound' ? '单向同步' : '双向同步'} · {transports[plan.transport]}</p></div>{itemAction && <SectionAction action={itemAction} />}</div>
    })}
  </IntegrationSection>
}
const jobStates: Record<IntegrationJobState, string> = { queued: '排队中', dispatched: '已派发', running: '处理中', paused: '已暂停', 'partially-failed': '部分失败', completed: '已完成', 'cancel-requested': '正在取消', cancelled: '已取消', unknown: '结果待核实', 'rollback-blocked': '无法回滚' }
export interface IntegrationJobPresentation { job: IntegrationJob; sourceLabel: string; destinationLabel: string; detail?: string }
export interface IntegrationHistoryPagination { hasMore: boolean; total?: number; next?: IntegrationSectionAction; previous?: IntegrationSectionAction }
/** Actions must retain the exact job/command/epoch/revision supplied by the native owner. */
export function IntegrationJobHistory({ resource, jobActions, pagination }: { resource: IntegrationResource<readonly IntegrationJobPresentation[]>; jobActions?: (job: IntegrationJob) => readonly IntegrationSectionAction[]; pagination?: IntegrationHistoryPagination }): JSX.Element {
  if (resource.state !== 'ready') return <IntegrationResourceState resource={resource} />
  return <div className="space-y-3">{resource.data.length === 0 ? <p className="text-my-sm text-my-tertiary">暂无导入记录</p> : <p className="text-my-xs text-my-tertiary">历史记录 · {resource.data.length} 条{pagination?.total !== undefined ? ` / 共 ${pagination.total} 条` : ''}</p>}{resource.data.map(({ job, sourceLabel, destinationLabel, detail }) => {
    const actions = jobActions?.(job) ?? []
    const destination = /^(?:[a-z]:[\\/]|\/|\\\\)/i.test(destinationLabel) ? destinationLabel.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || destinationLabel : destinationLabel
    return <article key={job.id} className="integration-history-row"><div className="min-w-0 flex-1 space-y-2"><p className="break-words text-my-sm">{sourceLabel} → {destination}</p>
      <p className="text-my-xs text-my-tertiary">{new Date(job.createdAt).toLocaleString()} · 已处理 {job.counts.processed}{job.counts.total === null ? ' 项 · 总量未知' : ` / ${job.counts.total} 项`} · 失败 {job.counts.failed} 项</p>
      {job.state === 'unknown' && <p className="text-my-xs text-my-warning-text">请核实原作业结果后再继续。</p>}
      {job.state === 'partially-failed' && detail && <p className="break-words text-my-xs text-my-danger-text">{detail}</p>}
      <details className="integration-disclosure text-my-xs"><summary>记录详情</summary><div className="mt-2 space-y-2 text-my-secondary">{detail && <p className="break-words">{detail}</p>}<p className="break-all">目标：{destinationLabel}</p><p className="break-all">来源实例：{job.source.instanceId}</p><p className="break-all">作业：{job.id}</p><p className="break-all">原始命令：{job.commandId}</p></div></details>
    </div><span className={`shrink-0 text-my-xs ${job.state === 'unknown' ? 'text-my-warning-text' : 'text-my-secondary'}`}>{jobStates[job.state]}</span>{actions.length > 0 && <Dropdown align="right" trigger={({ open, toggle }) => <Button size="sm" variant="ghost" aria-label={`${sourceLabel}的记录操作`} aria-expanded={open} onClick={toggle}><MoreHorizontal size={15} /></Button>}>{(close) => <>{actions.map((action) => <DropdownItem key={action.label} disabled={action.disabled || action.busy} onClick={() => { close(); action.onClick() }}>{action.label}</DropdownItem>)}</>}</Dropdown>}
    </article>
  })}{pagination && <div className="flex flex-wrap items-center gap-2 text-my-xs text-my-tertiary">{pagination.previous && <SectionAction action={pagination.previous} />}{pagination.hasMore && pagination.next && <SectionAction action={pagination.next} />}</div>}</div>
}
export function IntegrationImportSection({ resource, action, jobActions, pagination, title = '导入 Issue 数据', description }: { resource: IntegrationResource<readonly IntegrationJobPresentation[]>; action?: IntegrationSectionAction; jobActions?: (job: IntegrationJob) => readonly IntegrationSectionAction[]; pagination?: IntegrationHistoryPagination; title?: string; description?: string }): JSX.Element {
  return <IntegrationSection title={title} description={description} action={action}><IntegrationJobHistory resource={resource} jobActions={jobActions} pagination={pagination} /></IntegrationSection>
}

export interface IntegrationMappingRow { id: string; source: string; target: string; error?: string }
export interface IntegrationMappingOption { value: string; label: string }
/** Controlled presentation: the provider owns validation, remote choices and persistence. */
export function IntegrationMappingEditor({ label, rows, targets, sourceOptions, onChange, disabled = false }: { label: string; rows: readonly IntegrationMappingRow[]; targets: IntegrationMappingOption[]; sourceOptions?: IntegrationMappingOption[]; onChange: (rows: IntegrationMappingRow[]) => void; disabled?: boolean }): JSX.Element {
  const id = useId()
  return <fieldset disabled={disabled} className="space-y-3"><legend className="mb-2 text-my-sm font-medium">{label}</legend>
    {rows.map((row, index) => <div key={row.id} className="space-y-1"><div className="flex flex-wrap items-center gap-2">
      <div className="min-w-0 flex-1">{sourceOptions ? <Select ariaLabel={`${label}来源 ${index + 1}`} className="w-full" value={row.source} disabled={disabled} options={sourceOptions} onChange={(source) => onChange(rows.map((item) => item.id === row.id ? { ...item, source } : item))} /> : <input className="my-input w-full" aria-label={`${label}来源 ${index + 1}`} aria-invalid={Boolean(row.error)} aria-describedby={row.error ? `${id}-${index}` : undefined} disabled={disabled} placeholder="来源名称" value={row.source} onChange={(event) => onChange(rows.map((item) => item.id === row.id ? { ...item, source: event.target.value } : item))} />}</div>
      <span aria-hidden className="text-my-tertiary">→</span><div className="min-w-0 flex-1"><Select ariaLabel={`${label}目标 ${index + 1}`} className="w-full" disabled={disabled} value={row.target} options={targets} onChange={(target) => onChange(rows.map((item) => item.id === row.id ? { ...item, target } : item))} /></div>
      <Button size="sm" disabled={disabled} aria-label={`移除${label} ${index + 1}`} onClick={() => onChange(rows.filter((item) => item.id !== row.id))}><Trash2 size={13} /></Button>
    </div>{row.error && <p id={`${id}-${index}`} role="alert" className="text-my-xs text-my-danger-text">{row.error}</p>}</div>)}
    <Button size="sm" disabled={disabled} onClick={() => onChange([...rows, { id: crypto.randomUUID(), source: '', target: '' }])}><Plus size={13} />添加映射</Button>
  </fieldset>
}

import { useId, type JSX, type ReactNode } from 'react'
import { AlertCircle, LoaderCircle, Plus, Trash2 } from 'lucide-react'
import type { IntegrationAccount, IntegrationJob, IntegrationJobState, SyncPlan } from '../../../../../shared/integration-work'
import { Select } from '../../../components/Select'
import { Button } from '../../ui'

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
  return <section aria-labelledby={id} className="overflow-hidden rounded-my-xl border border-my-line bg-my-layer-1">
    <div className="flex flex-wrap items-start justify-between gap-3 p-5"><div className="min-w-0 flex-1"><h3 id={id} className="font-medium">{title}</h3>{description && <p className="mt-2 text-my-sm leading-relaxed text-my-tertiary">{description}</p>}</div>{action && <SectionAction action={action} />}</div>
    {children && <div className="space-y-3 border-t border-my-line p-5">{children}</div>}
  </section>
}
export function IntegrationResourceState({ resource }: { resource: Exclude<IntegrationResource<unknown>, { state: 'ready' }> }): JSX.Element {
  return <div role={resource.state === 'error' ? 'alert' : 'status'} className="flex flex-wrap items-center gap-2 text-my-sm text-my-secondary">
    {resource.state === 'loading' ? <><LoaderCircle size={15} className="animate-spin motion-reduce:animate-none" />正在读取…</> : <><AlertCircle size={15} className="shrink-0" /><span className="min-w-0 flex-1 break-words">{resource.detail}</span>{resource.action && <SectionAction action={resource.action} />}</>}
  </div>
}
const accountStates: Record<IntegrationAccount['state'], string> = { unverified: '尚未验证', linked: '已绑定', revoked: '授权已撤销', unavailable: '暂不可用' }
export function IntegrationAccountSection({ resource, action, accountAction }: { resource: IntegrationResource<readonly IntegrationAccount[]>; action?: IntegrationSectionAction; accountAction?: (account: IntegrationAccount) => IntegrationSectionAction | undefined }): JSX.Element {
  return <IntegrationSection title="个人账号" description="个人身份独立于实例连接，用于成员映射与操作归属。" action={action}>
    {resource.state !== 'ready' ? <IntegrationResourceState resource={resource} /> : resource.data.length === 0 ? <p className="text-my-sm text-my-tertiary">尚未绑定个人账号。</p> : resource.data.map((account) => {
      const itemAction = accountAction?.(account)
      return <div key={account.id} className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-my-sm">{account.displayName || account.remoteUserId}</p><p className="mt-1 text-my-xs text-my-tertiary">{accountStates[account.state]}</p></div>{itemAction && <SectionAction action={itemAction} />}</div>
    })}
  </IntegrationSection>
}
const planStates: Record<SyncPlan['state'], string> = { unverified: '尚未验证', active: '已启用', paused: '已暂停', degraded: '需要处理', blocked: '已阻止' }
const transports: Record<SyncPlan['transport'], string> = { polling: '定时同步', webhook: 'Webhook', stream: 'Stream', unavailable: '接收方式不可用' }
export function IntegrationSyncSection({ resource, action, label, planAction }: { resource: IntegrationResource<readonly SyncPlan[]>; action?: IntegrationSectionAction; label?: (plan: SyncPlan) => string; planAction?: (plan: SyncPlan) => IntegrationSectionAction | undefined }): JSX.Element {
  return <IntegrationSection title="项目同步" description="持续处理启用后的变更。同步方向、字段映射与历史数据导入分别配置。" action={action}>
    {resource.state !== 'ready' ? <IntegrationResourceState resource={resource} /> : resource.data.length === 0 ? <p className="text-my-sm text-my-tertiary">当前项目尚未创建同步。</p> : resource.data.map((plan) => {
      const itemAction = planAction?.(plan)
      return <div key={plan.id} className="flex flex-wrap items-center justify-between gap-3 rounded-my-md border border-my-line p-3"><div className="min-w-0"><p className="break-words text-my-sm">{label?.(plan) ?? plan.source.remoteProjectId}</p><p className="mt-1 text-my-xs text-my-tertiary">{planStates[plan.state]} · {plan.direction === 'inbound' ? '单向导入' : '双向同步'} · {transports[plan.transport]}</p></div>{itemAction && <SectionAction action={itemAction} />}</div>
    })}
  </IntegrationSection>
}
const jobStates: Record<IntegrationJobState, string> = { queued: '排队中', dispatched: '已派发', running: '处理中', paused: '已暂停', 'partially-failed': '部分失败', completed: '已完成', 'cancel-requested': '正在取消', cancelled: '已取消', unknown: '结果待核实', 'rollback-blocked': '无法回滚' }
export interface IntegrationJobPresentation { job: IntegrationJob; sourceLabel: string; destinationLabel: string; detail?: string }
export interface IntegrationHistoryPagination { hasMore: boolean; total?: number; next?: IntegrationSectionAction; previous?: IntegrationSectionAction }
/** Actions must retain the exact job/command/epoch/revision supplied by the native owner. */
export function IntegrationJobHistory({ resource, jobActions, pagination }: { resource: IntegrationResource<readonly IntegrationJobPresentation[]>; jobActions?: (job: IntegrationJob) => readonly IntegrationSectionAction[]; pagination?: IntegrationHistoryPagination }): JSX.Element {
  if (resource.state !== 'ready') return <IntegrationResourceState resource={resource} />
  return <div className="space-y-4"><p className="text-my-sm font-medium">历史记录 · 已显示 {resource.data.length} 条{pagination?.total !== undefined ? ` · 共 ${pagination.total} 条` : ''}</p>{resource.data.length === 0 && <p className="text-my-sm text-my-tertiary">本次未读到作业记录。</p>}{resource.data.map(({ job, sourceLabel, destinationLabel, detail }) => <article key={job.id} className="space-y-2 border-t border-my-line pt-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="min-w-0 break-words text-my-sm">{sourceLabel} → {destinationLabel}</p><span className="my-chip text-my-xs">{jobStates[job.state]}</span></div>
    <p className="text-my-xs text-my-tertiary">{new Date(job.createdAt).toLocaleString()} · 已处理 {job.counts.processed}{job.counts.total === null ? ' 项（总量未知）' : ` / ${job.counts.total} 项`} · 失败 {job.counts.failed} 项</p>
    {detail && <p className="break-words text-my-sm text-my-secondary">{detail}</p>}
    {job.state === 'unknown' && <p className="text-my-xs text-my-warning-text">需核实原作业结果后再决定后续操作。</p>}
    {job.counts.total !== null && job.counts.total > 0 && <progress className="h-1 w-full accent-current" aria-label="已处理项目" max={job.counts.total} value={job.counts.processed} />}
    <div className="flex flex-wrap gap-2">{jobActions?.(job).map((action) => <SectionAction key={action.label} action={action} />)}</div>
  </article>)}{pagination && <div className="flex flex-wrap items-center gap-2 text-my-xs text-my-tertiary">{pagination.previous && <SectionAction action={pagination.previous} />}{pagination.hasMore && <span>还有记录未加载</span>}{pagination.hasMore && pagination.next && <SectionAction action={pagination.next} />}</div>}</div>
}
export function IntegrationImportSection({ resource, action, jobActions, pagination }: { resource: IntegrationResource<readonly IntegrationJobPresentation[]>; action?: IntegrationSectionAction; jobActions?: (job: IntegrationJob) => readonly IntegrationSectionAction[]; pagination?: IntegrationHistoryPagination }): JSX.Element {
  return <IntegrationSection title="导入 Issue 数据" description="一次性导入已有任务，与持续同步分别管理。预览范围和映射后再提交导入。" action={action}><IntegrationJobHistory resource={resource} jobActions={jobActions} pagination={pagination} /></IntegrationSection>
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

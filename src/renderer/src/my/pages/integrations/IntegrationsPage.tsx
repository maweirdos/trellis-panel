import { useState, type JSX } from 'react'
import { ArrowRight, BookOpenText, CheckCircle2, GitBranch, Link2, MessageSquare, Plus, RefreshCw, ShieldCheck } from 'lucide-react'
import { INTEGRATION_CATALOG, type IntegrationBinding, type IntegrationConnection, type ProviderManifest, type RemoteRepository } from '../../../../../shared/integrations'
import { api } from '../../../api'
import { useApp } from '../../../store'
import { Button, Checkbox, Modal } from '../../ui'
import { Select } from '../../../components/Select'
import { ConnectionEditor } from './ConnectionEditor'
import { ConnectionAuthorization } from './ConnectionAuthorization'
import { boundRequest, RepositoryBrowser, PullRequestBrowser } from './RepositoryBrowser'
import { WorkItemIntegrations } from './WorkItemIntegrations'
import { useIntegrationAction, useIntegrationSnapshot } from './hooks'
import { integrationBridgeMessage, integrationBridgeState } from './bridge'
import { KnowledgeBindingFields, KnowledgeLegacyImport } from '../../../knowledge/KnowledgeBindingFields'
import { knowledgeBridge } from '../../../knowledge/bridge'

const labels = { tasks: '任务管理工具', repositories: 'Git 仓库', messaging: '即时通讯', knowledge: '知识服务' }
const checkLabels = { unverified: '尚未验证', authenticated: '身份已验证', configured: '配置已检查', failed: '检查失败' }

function BindingEditor({ root, connection, provider, repo, binding, onClose, onSaved }: { root: string; connection: IntegrationConnection; provider: ProviderManifest; repo?: RemoteRepository; binding?: IntegrationBinding; onClose: () => void; onSaved: () => Promise<void> }): JSX.Element {
  const [label, setLabel] = useState(binding?.label || repo?.fullName || connection.name)
  const [scope, setScope] = useState(binding?.scope || repo?.fullName || (provider.id === 'jira' ? connection.config.jql || '' : ''))
  const [enabled, setEnabled] = useState(binding?.enabled ?? true)
  const [collectionIds, setCollectionIds] = useState(binding?.knowledge?.defaultCollectionIds ?? [])
  const action = useIntegrationAction()
  return <Modal open onClose={() => { if (!action.busy) onClose() }}>
    <div className="border-b border-my-line px-5 py-4"><h2 className="text-my-lg font-semibold">{binding ? '编辑' : '添加'}项目绑定</h2><p className="mt-1 text-my-xs text-my-tertiary">{connection.name} · 当前项目</p></div>
    <div className="space-y-4 px-5 py-4"><label className="block space-y-1 text-my-sm"><span>绑定名称 / 目的地名称</span><input className="my-input w-full" value={label} onChange={(e) => setLabel(e.target.value)} /></label>
      {provider.category === 'knowledge' ? <KnowledgeBindingFields root={root} connection={connection} selected={collectionIds} onChange={setCollectionIds} /> : provider.category !== 'messaging' && <label className="block space-y-1 text-my-sm"><span>{provider.category === 'tasks' ? '当前项目默认 JQL（留空沿用连接配置）' : '仓库完整路径（含命名空间）'}</span><textarea className="my-input min-h-20 w-full" value={scope} onChange={(e) => setScope(e.target.value)} /></label>}
      {provider.id === 'jira' && <p className="text-my-xs text-my-tertiary">启用此绑定后，它将成为当前项目的 Jira 来源；其他 Jira 绑定会停用。</p>}
      <label className="flex items-center gap-2 text-my-sm"><Checkbox checked={enabled} onChange={setEnabled} />在当前项目启用</label>
      {action.error && <p role="alert" className="text-my-sm text-my-danger-text">{action.error}</p>}
    </div>
    <div className="flex justify-end gap-2 border-t border-my-line px-5 py-3"><Button disabled={action.busy} onClick={onClose}>取消</Button><Button variant="primary" disabled={action.busy || (provider.category === 'knowledge' && (!knowledgeBridge() || (enabled && collectionIds.length === 0)))} onClick={() => void action.run(() => api.integrations.saveBinding({ expectedRoot: root, connectionId: connection.id, connectionRevision: connection.revision, id: binding?.id, revision: binding?.revision, label, scope: provider.category === 'knowledge' ? '' : scope, enabled, ...(provider.category === 'knowledge' ? { knowledge: { defaultCollectionIds: collectionIds } } : {}) })).then(async (result) => { if (result) { await onSaved(); onClose() } })}>保存绑定</Button></div>
  </Modal>
}

function ConnectionDetail({ provider, connection, root, bindings, authorizationAvailable, onSaved }: { provider: ProviderManifest; connection: IntegrationConnection; root: string | null; bindings: IntegrationBinding[]; authorizationAvailable: boolean; onSaved: () => Promise<void> }): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [bindingEdit, setBindingEdit] = useState<{ binding?: IntegrationBinding; repo?: RemoteRepository } | null>(null)
  const [inspection, setInspection] = useState('')
  const [removing, setRemoving] = useState(false)
  const [task, setTask] = useState('')
  const snapshot = useApp((s) => s.snapshot)
  const action = useIntegrationAction()
  const selectedBindings = bindings.filter((b) => b.connectionId === connection.id)
  return <div className="space-y-5 rounded-my-lg border border-my-line bg-my-layer-1 p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-my-lg font-semibold">{connection.name}</h3><p className="mt-1 text-my-xs text-my-tertiary">{connection.enabled ? '已启用' : '已停用'} · {checkLabels[connection.check]}{connection.legacy ? ' · 原有配置兼容入口' : ''}</p><p className="mt-1 text-my-xs text-my-tertiary">{connection.config.baseUrl || '凭证地址已隐藏'}</p></div><div className="flex flex-wrap gap-2"><Button size="sm" disabled={action.busy} onClick={() => setEditing(true)}>编辑连接</Button><Button size="sm" disabled={action.busy} onClick={() => void action.run(() => api.integrations.inspect({ connectionId: connection.id, connectionRevision: connection.revision })).then(async (result) => { if (result) { setInspection(result.detail); await onSaved() } })}>{provider.category === 'messaging' ? '检查配置' : '检查连接'}</Button>
      {!connection.legacy && <Button size="sm" variant={removing ? 'danger' : 'ghost'} disabled={action.busy} onClick={() => { if (!removing) { setRemoving(true); return }; void action.run(() => api.integrations.removeConnection({ connectionId: connection.id, connectionRevision: connection.revision })).then(async (result) => { if (result !== undefined) await onSaved() }) }}>{removing ? '确认移除连接' : '移除连接'}</Button>}</div></div>
    {(inspection || connection.detail) && <p role="status" className="text-my-sm text-my-secondary">{inspection || connection.detail}</p>}
    <ConnectionAuthorization provider={provider} connection={connection} available={authorizationAvailable} onSaved={onSaved} />
    <div className="flex flex-wrap gap-2">{provider.capabilities.map((capability) => <span key={capability} className="my-chip text-my-xs text-my-tertiary">{({ 'task.search': '工单查询', 'task.import': '导入工作项', 'task.comment': '显式评论', 'task.transition': '显式流转', 'repository.read': '仓库与 PR / MR 读取', 'notification.send': '手动群通知', 'knowledge.read': '项目知识读取', 'knowledge.publish': '人工预览确认发布' })[capability]}</span>)}</div>
    {root ? <section className="space-y-3"><div className="flex items-center justify-between"><h4 className="font-medium">当前项目绑定</h4><Button size="sm" disabled={!connection.enabled || action.busy} onClick={() => setBindingEdit({})}><Plus size={12} />添加绑定</Button></div>
      {selectedBindings.length === 0 && <p className="text-my-sm text-my-tertiary">连接已保存；尚未绑定当前项目。</p>}
      {selectedBindings.map((binding) => <div key={binding.id} className="space-y-3 rounded-my-md border border-my-line p-3"><div className="flex items-center justify-between gap-2"><div className="min-w-0"><p className="truncate text-my-sm">{binding.label} · {binding.enabled ? '启用' : '停用'}</p><p className="truncate text-my-xs text-my-tertiary" title={binding.scope}>{provider.category === 'knowledge' ? `${binding.knowledge?.defaultCollectionIds.length ?? 0} 个默认知识库 · ${binding.knowledge?.defaultCollectionIds.join('、') || '空范围，不查远端'}` : binding.scope || '沿用连接默认范围'}</p></div><div className="flex shrink-0 gap-1"><Button size="sm" disabled={!connection.enabled} onClick={() => setBindingEdit({ binding })}>编辑</Button><Button size="sm" disabled={action.busy || !binding.enabled || !connection.enabled} onClick={() => void action.run(() => api.integrations.removeBinding(boundRequest(root, binding, connection))).then(async (result) => { if (result !== undefined) await onSaved() })}>停用</Button></div></div>
        {provider.category === 'repositories' && binding.enabled && connection.enabled && <PullRequestBrowser key={`${binding.id}:${binding.revision}:${connection.revision}`} root={root} binding={binding} connection={connection} />}
      </div>)}
      {provider.category === 'tasks' && <Button size="sm" disabled={!connection.enabled} onClick={() => useApp.getState().setPage('jira')}>打开当前项目 Jira 来源 <ArrowRight size={12} /></Button>}
      {provider.category === 'repositories' && <RepositoryBrowser root={root} connection={connection} onSelect={(repo) => setBindingEdit({ repo })} />}
      {provider.category === 'knowledge' && <p className="text-my-xs leading-relaxed text-my-tertiary">在知识页面查阅，或在现有 Agent 对话按需检索。检查连接仅验证读取，不发布内容，不启用旧规范同步或归档上传。</p>}
      {provider.category !== 'tasks' && provider.category !== 'knowledge' && <div className="space-y-3 border-t border-my-line pt-4"><h4 className="font-medium">关联或通知工作项</h4><Select className="w-full" ariaLabel="选择集成工作项" value={task} onChange={setTask} options={[{ value: '', label: '选择当前项目工作项' }, ...[...(snapshot?.tasks ?? []), ...(snapshot?.archived ?? [])].filter((item) => item.record).map((item) => ({ value: item.path, label: `${item.archived ? '已归档 · ' : ''}${item.record?.title || item.dirName}` }))]} />{task && <WorkItemIntegrations key={task} taskDir={task} />}</div>}
    </section> : <p className="rounded-my-md bg-my-layer-2 p-3 text-my-sm text-my-tertiary">打开项目后，可绑定查询范围、仓库或通知目的地。</p>}
    {action.error && <p role="alert" className="text-my-sm text-my-danger-text">{action.error}</p>}
    {editing && <ConnectionEditor provider={provider} connection={connection} authorizationAvailable={authorizationAvailable} onClose={() => setEditing(false)} onSaved={onSaved} />}
    {bindingEdit && root && <BindingEditor root={root} connection={connection} provider={provider} {...bindingEdit} onClose={() => setBindingEdit(null)} onSaved={onSaved} />}
  </div>
}

export function IntegrationsPage(): JSX.Element {
  const { root, data, error, loading, mainOutdated, refresh } = useIntegrationSnapshot()
  const [selected, setSelected] = useState('jira')
  const [adding, setAdding] = useState(false)
  const [connectionId, setConnectionId] = useState('')
  const catalog = data?.catalog ?? INTEGRATION_CATALOG
  const provider = catalog.find((p) => p.id === selected) ?? catalog[0]
  const connections = data?.connections.filter((c) => c.providerId === provider.id) ?? []
  const connection = connections.find((c) => c.id === connectionId) ?? connections[0]
  const bridge = integrationBridgeState()
  const nativeAvailable = bridge === 'ready'
  const authorizationAvailable = data?.authorizationProviders?.includes(provider.id) ?? false
  return <div>
    <div className="space-y-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-my-xl font-semibold">外部应用集成</h2><p className="mt-1 text-my-sm text-my-tertiary">管理本机连接，在当前项目绑定来源、仓库与通知目的地。</p></div><Button disabled={!nativeAvailable || loading} onClick={() => void refresh()}><RefreshCw size={13} />刷新</Button></div>
      {(!nativeAvailable || mainOutdated) && <p role="status" className="rounded-my-lg border border-my-line p-4 text-my-sm text-my-secondary">{mainOutdated ? error : integrationBridgeMessage(bridge)}</p>}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]"><div className="space-y-6">{(['tasks', 'repositories', 'knowledge', 'messaging'] as const).map((category) => <section key={category} className="space-y-2"><h3 className="flex items-center gap-2 text-my-sm font-semibold">{category === 'tasks' ? <Link2 size={15} /> : category === 'repositories' ? <GitBranch size={15} /> : category === 'knowledge' ? <BookOpenText size={15} /> : <MessageSquare size={15} />}{labels[category]}</h3>
        {catalog.filter((p) => p.category === category).map((item) => { const count = data?.connections.filter((c) => c.providerId === item.id).length ?? 0; return <button key={item.id} type="button" aria-pressed={selected === item.id} onClick={() => { setSelected(item.id); setConnectionId(''); setAdding(false) }} className={`flex w-full items-center justify-between gap-3 rounded-my-lg border p-4 text-left transition-colors ${selected === item.id ? 'border-my-secondary bg-my-layer-2' : 'border-my-line bg-my-layer-1 hover:bg-my-layer-transparent-hover'}`}><div className="min-w-0"><p className="font-medium">{item.name}</p><p className="mt-1 text-my-xs leading-relaxed text-my-tertiary">{item.description}</p><span className="mt-2 inline-flex items-center gap-1 text-my-xs text-my-tertiary">{count > 0 ? <><CheckCircle2 size={12} />{count} 个已配置连接</> : '尚未配置'}</span></div><ArrowRight size={15} className="shrink-0 text-my-icon-tertiary" /></button> })}
      </section>)}</div>
      <div className="space-y-4"><div className="flex items-center justify-between gap-2"><h3 className="text-my-lg font-semibold">{provider.name}</h3><Button variant="primary" onClick={() => setAdding(true)}><Plus size={13} />添加连接</Button></div>
        {provider.category === 'knowledge' && root && <KnowledgeLegacyImport root={root} onSaved={refresh} />}
        {connections.length > 1 && <Select ariaLabel="选择连接" className="w-full" value={connection?.id || ''} onChange={setConnectionId} options={connections.map((item) => ({ value: item.id, label: `${item.name}${item.enabled ? '' : ' · 已停用'}` }))} />}
        {connection ? <ConnectionDetail key={`${connection.id}:${connection.revision}:${root ?? 'global'}`} provider={provider} connection={connection} root={root} bindings={data?.bindings ?? []} authorizationAvailable={authorizationAvailable} onSaved={refresh} /> : <div className="space-y-3 rounded-my-lg border border-my-line p-5"><ShieldCheck size={24} className="text-my-icon-tertiary" /><h4 className="font-medium">连接 {provider.name}</h4><p className="text-my-sm leading-relaxed text-my-tertiary">{provider.description}</p><p className="text-my-xs text-my-tertiary">配置连接后，再为项目选择查询、仓库或通知范围。已配置不代表身份与业务能力已验证。</p></div>}
        {data && data.receipts.length > 0 && provider.category === 'messaging' && <section className="space-y-2 rounded-my-lg border border-my-line p-4"><h4 className="text-my-sm font-medium">当前项目发送记录</h4>{data.receipts.slice(0, 10).map((receipt) => <div key={receipt.requestId} className="border-t border-my-line pt-2 text-my-xs"><p>{receipt.destination} · {new Date(receipt.createdAt).toLocaleString()}</p><p className="mt-1 text-my-tertiary">{receipt.detail}</p></div>)}</section>}
      </div></div>
      {error && nativeAvailable && !mainOutdated && <p role="alert" className="text-my-sm text-my-danger-text">{error}</p>}
      {adding && <ConnectionEditor provider={provider} authorizationAvailable={authorizationAvailable} onClose={() => setAdding(false)} onSaved={refresh} />}
    </div>
  </div>
}

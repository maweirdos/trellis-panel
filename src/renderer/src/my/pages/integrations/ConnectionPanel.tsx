import { useLayoutEffect, useState, type JSX } from 'react'
import { ArrowRight, MoreHorizontal, Plus, X } from 'lucide-react'
import type { IntegrationBinding, IntegrationConnection, ProviderManifest, RemoteRepository } from '../../../../../shared/integrations'
import { api } from '../../../api'
import { useApp } from '../../../store'
import { Button, Checkbox, Dropdown, DropdownItem, Modal } from '../../ui'
import { projectRootKey } from '../../navigation'
import { Select } from '../../../components/Select'
import { ConnectionEditor } from './ConnectionEditor'
import { ConnectionAuthorization } from './ConnectionAuthorization'
import { boundRequest, RepositoryBrowser, PullRequestBrowser } from './RepositoryBrowser'
import { WorkItemIntegrations } from './WorkItemIntegrations'
import { IntegrationSection } from './IntegrationSections'
import { useIntegrationAction, useIntegrationOwner } from './hooks'
import { KnowledgeBindingFields, KnowledgeLegacyImport } from '../../../knowledge/KnowledgeBindingFields'
import { knowledgeBridge, knowledgeUnavailableFor, useProjectKnowledge } from '../../../knowledge/bridge'

const checkLabels = { unverified: '尚未验证', authenticated: '身份已验证', configured: '配置已检查', failed: '检查失败' }

function connectionTitle(provider: ProviderManifest): string {
  if (provider.id === 'jira' || provider.id === 'gitlab') return `绑定 ${provider.name} 实例`
  return provider.category === 'messaging' ? `连接${provider.name}群机器人` : `连接 ${provider.name}`
}

function connectionHost(connection: IntegrationConnection, provider: ProviderManifest): string {
  try {
    const url = new URL(connection.config.baseUrl || provider.instanceUrl || '')
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.host : ''
  } catch { return '' }
}

function connectionDisplayName(connection: IntegrationConnection, provider: ProviderManifest): string {
  return connection.legacy ? connectionHost(connection, provider) || provider.name : connection.name
}

/** Migration is a project capability, independent of any new integration connection. */
function KnowledgeLegacyImportAction({ root, nativeAvailable = true, onSaved }: { root: string; nativeAvailable?: boolean; onSaved: () => Promise<void> }): JSX.Element {
  const owner = useIntegrationOwner(`knowledge-legacy:${root}`)
  const [opened, setOpened] = useState<{ current: () => boolean } | null>(null)
  return <><Button size="sm" variant="ghost" disabled={!nativeAvailable} onClick={() => { if (owner.current()) setOpened({ current: owner.current }) }}>导入已有配置</Button>
    {opened?.current === owner.current && owner.current() && <KnowledgeLegacyImportDialog key={root} root={root} onClose={() => setOpened(null)} onSaved={onSaved} />}
  </>
}

function KnowledgeLegacyImportDialog({ root, onClose, onSaved }: { root: string; onClose: () => void; onSaved: () => Promise<void> }): JSX.Element {
  const state = useProjectKnowledge(root)
  const owner = useIntegrationOwner(`knowledge-legacy-dialog:${root}`)
  const available = Boolean(knowledgeBridge(['context', 'importLegacy']))
  const recheck = (): void => { if (owner.current()) void state.refresh() }
  return <Modal open ariaLabel="导入已有 WeKnora 配置" onClose={onClose}>
    <div className="border-b border-my-line px-5 py-4"><h2 className="text-my-lg font-semibold">导入已有 WeKnora 配置</h2></div>
    <div className="my-scrollbar max-h-[60vh] space-y-3 overflow-y-auto p-5">
      {!available ? <p role="status" className="text-my-sm text-my-secondary">{knowledgeUnavailableFor('已有配置导入')}</p> : state.error ? <p role="alert" className="break-words text-my-sm text-my-danger-text">{state.error}</p> : state.loading || !state.context ? <p role="status" className="text-my-sm text-my-tertiary">正在检查已有配置…</p> : !state.context.legacyImportAvailable ? <p role="status" className="text-my-sm text-my-tertiary">当前没有可导入的已有配置。</p> : <><p role="status" className="text-my-sm text-my-secondary">检测到已有配置</p><KnowledgeLegacyImport root={root} onSaved={async () => { if (owner.current() && state.current()) { onClose(); await onSaved() } }} /></>}
    </div><div className="flex justify-end gap-2 border-t border-my-line px-5 py-3">{available && (!state.context?.legacyImportAvailable || state.error) && <Button disabled={state.loading} onClick={recheck}>重新检查</Button>}<Button onClick={onClose}>关闭</Button></div>
  </Modal>
}

/** Shared editor preserves source identity and native compare-and-swap checks. */
export function BindingEditor({ root, connection, provider, repo, binding, onClose, onSaved }: { root: string; connection: IntegrationConnection; provider: ProviderManifest; repo?: RemoteRepository; binding?: IntegrationBinding; onClose: () => void; onSaved: () => Promise<void> }): JSX.Element {
  const [label, setLabel] = useState(binding?.label || repo?.fullName || connection.name)
  const [scope, setScope] = useState(binding?.scope || repo?.fullName || (provider.id === 'jira' ? connection.config.jql || '' : ''))
  const [enabled, setEnabled] = useState(binding?.enabled ?? true)
  const [collectionIds, setCollectionIds] = useState(binding?.knowledge?.defaultCollectionIds ?? [])
  const action = useIntegrationAction(JSON.stringify([root, connection.id, connection.revision, binding?.id, binding?.revision]))
  const validOwner = !binding || (binding.connectionId === connection.id && projectRootKey(binding.root) === projectRootKey(root))
  return <Modal open ariaLabel={`${binding ? '编辑' : '添加'}项目绑定`} onClose={() => { if (!action.busy) onClose() }}>
    <div className="border-b border-my-line px-5 py-4"><h2 className="text-my-lg font-semibold">{binding ? '编辑' : '添加'}项目绑定</h2><p className="my-item-description mt-1">{connection.name}</p></div>
    <div className="my-scrollbar max-h-[60vh] space-y-4 overflow-y-auto px-5 py-4"><fieldset disabled={action.busy} className="space-y-4"><label className="block space-y-1"><span className="my-item-title">名称</span><input className="my-input w-full" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} /></label>
      {provider.category === 'knowledge' ? <KnowledgeBindingFields root={root} connection={connection} selected={collectionIds} onChange={setCollectionIds} /> : provider.category !== 'messaging' && <label className="block space-y-1"><span className="my-item-title">{provider.category === 'tasks' ? 'JQL 查询范围（可选）' : '仓库路径'}</span><textarea className="my-input min-h-20 w-full" value={scope} onChange={(e) => setScope(e.target.value)} placeholder={provider.category === 'tasks' ? '留空沿用实例查询范围' : 'namespace/repository'} /></label>}
      {provider.id === 'jira' && <p className="text-my-xs text-my-secondary">启用后将切换当前项目的 Jira 来源，其他 Jira 绑定会停用。</p>}
      <label className="flex items-center gap-2"><Checkbox checked={enabled} onChange={setEnabled} /><span className="my-item-title">在当前项目启用</span></label></fieldset>
      {!validOwner && <p role="alert" className="text-my-sm text-my-danger-text">绑定来源已变化，请关闭后重新选择。</p>}
      {action.error && <p role="alert" className="text-my-sm text-my-danger-text">{action.error}</p>}
    </div>
    <div className="flex justify-end gap-2 border-t border-my-line px-5 py-3"><Button disabled={action.busy} onClick={onClose}>取消</Button><Button variant="primary" disabled={action.busy || !validOwner || !connection.enabled || !label.trim() || (provider.category === 'knowledge' && (!knowledgeBridge() || (enabled && collectionIds.length === 0)))} onClick={() => void action.run(() => api.integrations.saveBinding({ expectedRoot: root, connectionId: connection.id, connectionRevision: connection.revision, id: binding?.id, revision: binding?.revision, label, scope: provider.category === 'knowledge' ? '' : scope, enabled, ...(provider.category === 'knowledge' ? { knowledge: { defaultCollectionIds: collectionIds } } : {}) })).then(async (result) => { if (result && action.current()) { onClose(); await onSaved() } })}>{action.busy ? '保存中…' : '保存绑定'}</Button></div>
  </Modal>
}

interface ConnectionPanelProps {
  provider: ProviderManifest
  connection?: IntegrationConnection
  root: string | null
  bindings: readonly IntegrationBinding[]
  authorizationAvailable: boolean
  workspaceEnabled?: boolean
  nativeAvailable?: boolean
  loaded?: boolean
  title?: string
  allowCreate?: boolean
  connections?: readonly IntegrationConnection[]
  onSelectConnection?: (id: string) => void
  onConnect?: () => void
  onEditConnection?: () => void
  onBindProject?: (binding?: IntegrationBinding) => void
  onSaved: () => Promise<void>
  onAuthorizationSaved?: () => Promise<void>
}

/** One instance card. Generic capabilities live in focused sections and dialogs. */
export function ConnectionPanel(props: ConnectionPanelProps): JSX.Element | null {
  const [adding, setAdding] = useState(false)
  if (!props.connection && props.allowCreate === false) return null
  return <>
    {props.connection ? <ConnectedPanel key={JSON.stringify([props.root, props.connection.id])} {...props} connection={props.connection} /> : <IntegrationSection title={props.title ?? connectionTitle(props.provider)}>
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="my-item-description">{props.loaded === false ? '连接尚未读取' : props.provider.id === 'jira' || props.provider.id === 'gitlab' ? '尚未绑定实例' : '尚未连接'}</p><Button variant="primary" size="sm" onClick={props.onConnect ?? (() => setAdding(true))}>{props.provider.id === 'jira' || props.provider.id === 'gitlab' ? '绑定 ' + props.provider.name : connectionTitle(props.provider)}</Button></div>
      {props.provider.id === 'weknora' && props.root && <KnowledgeLegacyImportAction key={props.root} root={props.root} nativeAvailable={props.nativeAvailable} onSaved={props.onSaved} />}
    </IntegrationSection>}
    {adding && <ConnectionEditor provider={props.provider} connections={props.connections} authorizationAvailable={props.authorizationAvailable} onClose={() => setAdding(false)} onSaved={props.provider.id === 'jira' ? props.onAuthorizationSaved ?? props.onSaved : props.onSaved} />}
  </>
}

type WorkspaceDialog = { kind: 'repositories' | 'work-items' | 'diagnostics' | 'remove' } | { kind: 'pull-requests'; binding: IntegrationBinding }
function ConnectedPanel({ provider, connection, root, bindings, authorizationAvailable, workspaceEnabled = true, nativeAvailable = true, title, allowCreate = true, connections, onSelectConnection, onConnect, onEditConnection, onBindProject, onSaved, onAuthorizationSaved = onSaved }: ConnectionPanelProps & { connection: IntegrationConnection }): JSX.Element {
  const [editing, setEditing] = useState<{ kind: 'new' | 'edit'; connection?: IntegrationConnection } | null>(null)
  const [bindingEdit, setBindingEdit] = useState<{ binding?: IntegrationBinding; repo?: RemoteRepository } | null>(null)
  const [inspection, setInspection] = useState('')
  const [dialog, setDialog] = useState<WorkspaceDialog | null>(null)
  const [task, setTask] = useState('')
  useLayoutEffect(() => { setBindingEdit(null); setInspection(''); setDialog(null); setTask('') }, [connection.revision])
  const snapshot = useApp((s) => s.snapshot)
  const action = useIntegrationAction(`${connection.id}:${connection.revision}`)
  const selectedBindings = bindings.filter((binding) => binding.connectionId === connection.id && Boolean(root) && projectRootKey(binding.root) === projectRootKey(root))
  const displayName = connectionDisplayName(connection, provider)
  const host = connectionHost(connection, provider)
  const bind = (binding?: IntegrationBinding): void => { if (action.current()) { if (onBindProject) onBindProject(binding); else setBindingEdit({ binding }) } }
  const add = (): void => { if (action.current()) { if (onConnect) onConnect(); else setEditing({ kind: 'new' }) } }
  const edit = (): void => { if (action.current()) { if (onEditConnection) onEditConnection(); else setEditing({ kind: 'edit', connection }) } }
  const open = (next: WorkspaceDialog): void => { if (action.current()) setDialog(next) }
  const dialogTitle = dialog?.kind === 'repositories' ? '浏览仓库' : dialog?.kind === 'pull-requests' ? 'Pull Request / Merge Request' : dialog?.kind === 'work-items' ? (provider.category === 'messaging' ? '工作项通知' : '工作项关联') : '连接详情'
  return <>
    <IntegrationSection title={title ?? connectionTitle(provider)}>
      <div className="flex flex-wrap items-center justify-between gap-4"><div className="min-w-0 flex-1">
        {connections && connections.length > 1 && onSelectConnection ? <Select ariaLabel={provider.id === 'jira' || provider.id === 'gitlab' ? '选择实例连接' : '选择连接'} className="w-full" value={connection.id} onChange={onSelectConnection} options={connections.map((item) => ({ value: item.id, label: `${connectionDisplayName(item, provider)}${item.enabled ? '' : ' · 已停用'}` }))} /> : <p className="my-item-title break-words">{displayName}</p>}
        {!connection.legacy && (host || allowCreate) && <p className="my-item-description mt-1 break-all">{host || (provider.category === 'messaging' ? '群机器人' : provider.name)}</p>}
        <p className={`mt-2 text-my-xs ${connection.check === 'failed' ? 'text-my-danger-text' : 'text-my-secondary'}`}>{connection.enabled ? provider.id === 'jira' && connection.check === 'authenticated' && connection.config.authMethod !== 'oauth2' ? connection.detail || checkLabels[connection.check] : checkLabels[connection.check] : '已停用'}</p>
      </div><div className="flex flex-wrap items-center gap-2"><Button size="sm" disabled={action.busy || (!allowCreate && !nativeAvailable)} onClick={edit}>编辑</Button><Button size="sm" disabled={!nativeAvailable || action.busy || !connection.enabled} onClick={() => void action.run(() => api.integrations.inspect({ connectionId: connection.id, connectionRevision: connection.revision })).then(async (result) => { if (result && action.current()) { setInspection(result.detail); await onSaved() } })}>{action.busy ? '检查中…' : provider.category === 'messaging' ? '检查配置' : '检查连接'}</Button>
        <Dropdown align="right" trigger={({ open: expanded, toggle }) => <Button size="sm" variant="ghost" aria-label="更多连接操作" aria-expanded={expanded} onClick={toggle}><MoreHorizontal size={16} /></Button>}>{(close) => <>{allowCreate && <DropdownItem disabled={action.busy} onClick={() => { close(); add() }}>{provider.id === 'jira' || provider.id === 'gitlab' ? '绑定其他实例' : '添加连接'}</DropdownItem>}<DropdownItem onClick={() => { close(); open({ kind: 'diagnostics' }) }}>连接详情</DropdownItem>{!connection.legacy && <DropdownItem danger disabled={!nativeAvailable || action.busy} onClick={() => { close(); open({ kind: 'remove' }) }}>移除连接</DropdownItem>}</>}</Dropdown>
      </div></div>
      {connection.check === 'failed' && (inspection || connection.detail) && <details className="integration-disclosure text-my-sm"><summary>查看失败详情</summary><p className="mt-2 break-words text-my-danger-text">{inspection || connection.detail}</p></details>}
      {inspection && connection.check !== 'failed' && <p role="status" className="break-words text-my-sm text-my-secondary">{inspection}</p>}
      <ConnectionAuthorization provider={provider} connection={connection} connections={connections} available={authorizationAvailable && nativeAvailable} onSaved={onAuthorizationSaved} />
      {action.error && <p role="alert" className="text-my-sm text-my-danger-text">{action.error}</p>}
    </IntegrationSection>
    {workspaceEnabled && <>
      <IntegrationSection title={provider.category === 'repositories' ? '项目仓库' : provider.category === 'messaging' ? '通知目的地' : provider.category === 'knowledge' ? '项目知识库' : '项目来源'} action={{ label: provider.category === 'repositories' ? '绑定仓库' : provider.category === 'knowledge' ? '选择知识库' : '添加绑定', disabled: !root || !nativeAvailable || !connection.enabled || action.busy, onClick: () => provider.category === 'repositories' ? open({ kind: 'repositories' }) : bind() }}>
        {!root ? <p className="my-item-description">打开项目后设置绑定</p> : selectedBindings.length === 0 ? <p className="my-item-description">尚未绑定当前项目</p> : selectedBindings.map((binding) => <div key={binding.id} className="integration-list-row"><div className="min-w-0 flex-1"><p className="my-item-title">{binding.label}</p><p className="mt-1 text-my-xs text-my-tertiary">{binding.enabled ? '已启用' : '已停用'}{provider.category === 'knowledge' ? ` · ${binding.knowledge?.defaultCollectionIds.length ?? 0} 个知识库` : ''}</p></div><div className="flex flex-wrap items-center gap-1">{provider.category === 'repositories' && binding.enabled && <Button size="sm" disabled={!nativeAvailable || !connection.enabled} onClick={() => open({ kind: 'pull-requests', binding })}>PR / MR</Button>}<Button size="sm" disabled={!nativeAvailable || !connection.enabled || action.busy} onClick={() => bind(binding)}>编辑</Button><Dropdown align="right" trigger={({ open: expanded, toggle }) => <Button size="sm" variant="ghost" aria-label={`${binding.label}的更多操作`} aria-expanded={expanded} onClick={toggle}><MoreHorizontal size={15} /></Button>}>{(close) => <DropdownItem disabled={!nativeAvailable || action.busy || !binding.enabled || !connection.enabled} onClick={() => { close(); if (!root) return; void action.run(() => api.integrations.removeBinding(boundRequest(root, binding, connection))).then(async (result) => { if (result !== undefined && action.current()) await onSaved() }) }}>停用绑定</DropdownItem>}</Dropdown></div></div>)}
        <div className="flex flex-wrap gap-2">
          {provider.category === 'repositories' && <Button size="sm" disabled={!root || !nativeAvailable || !connection.enabled} onClick={() => bind()}><Plus size={13} />按路径绑定</Button>}
          {provider.category === 'tasks' && <Button size="sm" disabled={!root || !connection.enabled} onClick={() => useApp.getState().setPage('jira')}>查询 Jira 工单<ArrowRight size={13} /></Button>}
          {provider.category === 'knowledge' && <><Button size="sm" disabled={!root} onClick={() => useApp.getState().setPage('knowledge')}>打开知识库<ArrowRight size={13} /></Button>{root && <KnowledgeLegacyImportAction key={root} root={root} nativeAvailable={nativeAvailable} onSaved={onSaved} />}</>}
        </div>
      </IntegrationSection>
      {provider.category !== 'tasks' && provider.category !== 'knowledge' && <IntegrationSection title={provider.category === 'messaging' ? '工作项通知' : '工作项关联'} action={{ label: provider.category === 'messaging' ? '预览通知' : '关联 PR / MR', disabled: !root || !nativeAvailable || !connection.enabled, onClick: () => open({ kind: 'work-items' }) }}><p className="my-item-description">{provider.category === 'messaging' ? '选择工作项与目的地，确认内容后发送。' : '将 Pull Request 或 Merge Request 关联到工作项。'}</p></IntegrationSection>}
    </>}
    {editing && <ConnectionEditor provider={provider} connection={editing.connection} connections={connections} authorizationAvailable={authorizationAvailable} onClose={() => setEditing(null)} onSaved={provider.id === 'jira' ? onAuthorizationSaved : onSaved} />}
    {bindingEdit && root && <BindingEditor root={root} connection={connection} provider={provider} {...bindingEdit} onClose={() => setBindingEdit(null)} onSaved={onSaved} />}
    {dialog?.kind === 'remove' ? <Modal open ariaLabel="移除连接" onClose={() => { if (!action.busy) setDialog(null) }}><div className="space-y-3 p-5"><h2 className="text-my-lg font-semibold">移除 {connection.name}？</h2><p className="text-my-sm text-my-secondary">此连接将无法继续使用，工作项已有的来源记录会保留。</p>{action.error && <p role="alert" className="text-my-sm text-my-danger-text">{action.error}</p>}</div><div className="flex justify-end gap-2 border-t border-my-line px-5 py-3"><Button disabled={action.busy} onClick={() => setDialog(null)}>取消</Button><Button variant="danger" disabled={action.busy} onClick={() => void action.run(() => api.integrations.removeConnection({ connectionId: connection.id, connectionRevision: connection.revision })).then(async (result) => { if (result !== undefined && action.current()) { setDialog(null); await onSaved() } })}>{action.busy ? '移除中…' : '确认移除'}</Button></div></Modal> : dialog && <Modal open ariaLabel={dialogTitle} width={720} onClose={() => setDialog(null)}><div className="flex items-center justify-between gap-3 border-b border-my-line px-5 py-4"><h2 className="text-my-lg font-semibold">{dialogTitle}</h2><Button size="sm" variant="ghost" aria-label="关闭" onClick={() => setDialog(null)}><X size={16} /></Button></div><div className="my-scrollbar max-h-[65vh] space-y-4 overflow-y-auto p-5">
      {dialog.kind === 'repositories' && root && <RepositoryBrowser root={root} connection={connection} onSelect={(repo) => { if (action.current()) { setDialog(null); setBindingEdit({ repo }) } }} />}
      {dialog.kind === 'pull-requests' && root && <PullRequestBrowser root={root} binding={dialog.binding} connection={connection} />}
      {dialog.kind === 'work-items' && <>{allowCreate && <p className="text-my-xs text-my-secondary">可选择当前项目已启用的仓库或通知目的地。</p>}<Select className="w-full" ariaLabel="选择集成工作项" value={task} onChange={setTask} options={[{ value: '', label: '选择工作项' }, ...[...(snapshot?.tasks ?? []), ...(snapshot?.archived ?? [])].filter((item) => item.record).map((item) => ({ value: item.path, label: `${item.archived ? '已归档 · ' : ''}${item.record?.title || item.dirName}` }))]} />{task && <WorkItemIntegrations key={task} taskDir={task} connectionId={allowCreate ? undefined : connection.id} />}</>}
      {dialog.kind === 'diagnostics' && <dl className="space-y-4 text-my-sm"><div><dt className="text-my-tertiary">检查结果</dt><dd className="mt-1 break-words">{inspection || connection.detail || checkLabels[connection.check]}</dd></div>{connection.legacy && <div><dt className="text-my-tertiary">配置来源</dt><dd className="mt-1">原有设置兼容连接</dd></div>}<div><dt className="text-my-tertiary">连接标识 / 版本</dt><dd className="mt-1 break-all">{connection.id} / {connection.revision}</dd></div>{root && <div><dt className="text-my-tertiary">当前项目</dt><dd className="mt-1 break-all">{root}</dd></div>}{connection.checkedAt && <div><dt className="text-my-tertiary">上次检查</dt><dd className="mt-1">{new Date(connection.checkedAt).toLocaleString()}</dd></div>}</dl>}
    </div></Modal>}
  </>
}

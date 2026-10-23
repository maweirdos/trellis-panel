import { useCallback, useId, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { ChevronRight, LoaderCircle, Plus, RefreshCw } from 'lucide-react'
import { INTEGRATION_CATALOG } from '../../../../../shared/integrations'
import { INTEGRATION_DIRECTORY, INTEGRATION_DIRECTORY_GROUPS, type IntegrationDirectoryId } from '../../../../../shared/integration-directory'
import { Select } from '../../../components/Select'
import { InteractionScope, useInteractionActive, useInteractionGuard } from '../../../utils/interaction-scope'
import { useEscLayer } from '../../../utils/use-esc-layer'
import { KnowledgeLegacyImport } from '../../../knowledge/KnowledgeBindingFields'
import { Button } from '../../ui'
import { ConnectionEditor } from './ConnectionEditor'
import { ConnectionPanel } from './ConnectionPanel'
import { IntegrationProductIcon } from './IntegrationProductIcon'
import { IntegrationProviderFrame } from './IntegrationProviderFrame'
import { IntegrationSection } from './IntegrationSections'
import { PROVIDER_WORKSPACE_EXTENSIONS } from './provider-extensions'
import type { ProviderWorkspaceExtensions, ProviderWorkspaceProps } from './provider-workspace'
import { integrationBridgeMessage, integrationBridgeState } from './bridge'
import { useIntegrationSnapshot } from './hooks'

/** A local subroute of the shell's integrations route, never a competing router. */
export function IntegrationsPage({ extensions = PROVIDER_WORKSPACE_EXTENSIONS }: { extensions?: ProviderWorkspaceExtensions }): JSX.Element {
  const { root, data, error, loading, mainOutdated, refresh } = useIntegrationSnapshot()
  const [selected, setSelected] = useState<IntegrationDirectoryId | null>(null)
  const [connectionId, setConnectionId] = useState('')
  const [adding, setAdding] = useState(false)
  const directory = useRef<HTMLDivElement>(null)
  const directoryScroll = useRef(0)
  const returnEntry = useRef<IntegrationDirectoryId | null>(null)
  const canInteract = useInteractionGuard()
  const active = useInteractionActive()
  const escId = useId()
  const bridge = integrationBridgeState()
  const nativeAvailable = bridge === 'ready' && !mainOutdated
  const entry = INTEGRATION_DIRECTORY.find((item) => item.id === selected)
  const catalog = data?.catalog ?? INTEGRATION_CATALOG
  const provider = entry ? catalog.find((item) => item.id === entry.providerId) ?? INTEGRATION_CATALOG.find((item) => item.id === entry.providerId) : undefined
  const connections = data?.connections.filter((item) => item.providerId === entry?.providerId) ?? []
  const connection = connections.find((item) => item.id === connectionId) ?? connections[0]
  const authorizationAvailable = data?.authorizationProviders.includes(entry?.providerId ?? 'jira') ?? false
  const navigate = useCallback((id: IntegrationDirectoryId): void => {
    if (directory.current) directoryScroll.current = directory.current.closest('.my-page-body')?.scrollTop ?? 0
    const sameProvider = INTEGRATION_DIRECTORY.find((item) => item.id === id)?.providerId === entry?.providerId
    setAdding(false); setConnectionId(sameProvider ? connection?.id ?? '' : ''); setSelected(id)
  }, [entry?.providerId, connection?.id])
  const back = useCallback((): void => { returnEntry.current = selected; setAdding(false); setConnectionId(''); setSelected(null) }, [selected])
  useEscLayer(Boolean(entry), { kind: 'preview', id: `integration-detail-${escId}`, onClose: back, deferWhenInputFocused: true })
  useLayoutEffect(() => {
    if (!selected && returnEntry.current && canInteract()) {
      directory.current?.querySelector<HTMLButtonElement>(`[data-integration-entry="${returnEntry.current}"]`)?.focus({ preventScroll: true })
      directory.current?.closest('.my-page-body')?.scrollTo({ top: directoryScroll.current })
      returnEntry.current = null
    }
  }, [selected, canInteract])
  // A suspended page cannot reopen a draft or select a destination on return.
  useLayoutEffect(() => { setAdding(false) }, [active, root, selected, connection?.id, connection?.revision])
  const context: ProviderWorkspaceProps | null = entry && provider ? { entry, provider, root, connections, connection, bindings: data?.bindings ?? [], nativeAvailable, authorizationAvailable, refresh, navigate } : null
  const extension = entry ? extensions[entry.id] ?? PROVIDER_WORKSPACE_EXTENSIONS[entry.id] : undefined
  const BeforeConnection = extension?.BeforeConnection
  const Content = extension?.Content
  const receipts = connection ? data?.receipts.filter((receipt) => receipt.connectionId === connection.id) ?? [] : []
  return <div className="space-y-6">
    {(!nativeAvailable || (error && mainOutdated)) && <p role="status" className="rounded-my-lg border border-my-line p-4 text-my-sm text-my-secondary">{mainOutdated ? error : integrationBridgeMessage(bridge)}</p>}
    {loading && !data && <p role="status" className="flex items-center gap-2 text-my-sm text-my-tertiary"><LoaderCircle size={15} className="animate-spin motion-reduce:animate-none" />正在读取连接配置…</p>}
    {context ? <IntegrationProviderFrame entry={context.entry} onBack={back}>
      <InteractionScope key={`${entry?.id}:${root ?? 'global'}:${connection?.id ?? 'none'}:${connection?.revision ?? 0}`} active={active}>
        {BeforeConnection && <BeforeConnection {...context} />}
        <div className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-my-sm font-medium">{context.entry.kind === 'messaging' ? '群机器人通知连接' : '绑定实例'}</h3><Button size="sm" onClick={() => setAdding(true)}><Plus size={13} />添加连接</Button></div>
          {context.entry.providerId === 'gitlab' && <div className="flex flex-wrap items-center justify-between gap-2 rounded-my-md bg-my-layer-2 p-3 text-my-xs text-my-secondary"><span>Issues 与仓库共用 GitLab 连接，实例地址以所选连接为准。</span>{context.entry.kind === 'tasks' ? <Button size="sm" onClick={() => navigate('gitlab-repositories')}>仓库与 MR <ChevronRight size={12} /></Button> : <Button size="sm" onClick={() => navigate('gitlab-issues-self-managed')}>Issue 集成 <ChevronRight size={12} /></Button>}</div>}
          {context.entry.kind === 'knowledge' && root && <KnowledgeLegacyImport root={root} onSaved={refresh} />}
          {connections.length > 1 && <Select ariaLabel="选择实例连接" className="w-full" value={connection?.id ?? ''} onChange={(id) => { setAdding(false); setConnectionId(id) }} options={connections.map((item) => ({ value: item.id, label: `${item.name}${item.enabled ? '' : ' · 已停用'}` }))} />}
          {connection ? <ConnectionPanel key={`${connection.id}:${connection.revision}:${root ?? 'global'}`} provider={context.provider} connection={connection} root={root} bindings={data?.bindings ?? []} authorizationAvailable={authorizationAvailable} workspaceEnabled={context.entry.kind !== 'tasks' || context.entry.providerId === 'jira'} onSaved={refresh} /> : <IntegrationSection title={`绑定 ${context.provider.name} 实例`}><div className="flex flex-wrap items-center justify-between gap-3"><p className="text-my-sm text-my-tertiary">{data ? '尚未保存连接。' : '尚未读取到连接配置。'}</p><Button size="sm" onClick={() => setAdding(true)}>配置连接</Button></div></IntegrationSection>}
        </div>
        {Content && <Content {...context} />}
        {context.entry.kind === 'messaging' && connection && <IntegrationSection title="当前项目发送记录">{receipts.length === 0 ? <p className="text-my-sm text-my-tertiary">暂无此连接的发送记录。</p> : <><p className="text-my-xs text-my-tertiary">最近显示 {Math.min(10, receipts.length)} 条</p>{receipts.slice(0, 10).map((receipt) => <div key={receipt.requestId} className="space-y-1 border-t border-my-line pt-3 text-my-xs"><p>{receipt.destination} · {new Date(receipt.createdAt).toLocaleString()}</p><p className="text-my-tertiary">{({ pending: '等待确认', delivered: '已送达', failed: '发送失败', uncertain: '结果待核实' })[receipt.state]} · {receipt.detail}</p></div>)}</>}</IntegrationSection>}
        {adding && <ConnectionEditor key={`${context.entry.id}:${root ?? 'global'}`} provider={context.provider} authorizationAvailable={authorizationAvailable} onClose={() => setAdding(false)} onSaved={refresh} />}
      </InteractionScope>
    </IntegrationProviderFrame> : <div ref={directory} className="space-y-8" data-integration-directory>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-my-line pb-6"><div><h2 className="text-my-xl font-semibold">外部应用集成</h2><p className="mt-2 text-my-sm text-my-tertiary">浏览并配置本机连接，为项目选择任务来源、仓库与通知目的地。</p></div><Button size="sm" disabled={bridge !== 'ready' || loading} onClick={() => void refresh()}><RefreshCw size={13} />刷新</Button></div>
      {INTEGRATION_DIRECTORY_GROUPS.map((group) => <section key={group.id} aria-labelledby={`integration-group-${group.id}`} className="space-y-4"><div><h3 id={`integration-group-${group.id}`} className="font-medium">{group.name}</h3><p className="mt-1 text-my-sm text-my-tertiary">{group.description}</p></div><div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {INTEGRATION_DIRECTORY.filter((item) => item.category === group.id).map((item) => {
          const count = data?.connections.filter((saved) => saved.providerId === item.providerId).length
          return <button key={item.id} type="button" data-integration-entry={item.id} onClick={() => navigate(item.id)} className="flex min-w-0 items-center gap-4 rounded-my-xl border border-my-line bg-my-layer-1 p-5 text-left transition-colors hover:bg-my-layer-transparent-hover"><IntegrationProductIcon provider={item.providerId} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-x-2"><p className="font-medium">{item.name}</p>{count !== undefined && count > 0 && <span className="text-my-xs text-my-tertiary">{count} 个已保存连接</span>}</div><p className="mt-1 truncate text-my-sm text-my-tertiary" title={item.description}>{item.description}</p></div><ChevronRight size={16} className="shrink-0 text-my-icon-tertiary" /></button>
        })}
      </div></section>)}
    </div>}
    {error && bridge === 'ready' && !mainOutdated && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-my-lg border border-my-line p-4 text-my-sm"><span className="text-my-danger-text">{error}</span><Button size="sm" disabled={loading} onClick={() => void refresh()}>重试读取</Button></div>}
  </div>
}

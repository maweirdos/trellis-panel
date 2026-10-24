import { useCallback, useId, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { ChevronRight, LoaderCircle, RefreshCw } from 'lucide-react'
import { INTEGRATION_CATALOG, type IntegrationBinding } from '../../../../../shared/integrations'
import { INTEGRATION_DIRECTORY, INTEGRATION_DIRECTORY_GROUPS, type IntegrationDirectoryId } from '../../../../../shared/integration-directory'
import { InteractionScope, useInteractionActive, useInteractionGuard } from '../../../utils/interaction-scope'
import { useEscLayer } from '../../../utils/use-esc-layer'
import { Button } from '../../ui'
import { projectRootKey } from '../../navigation'
import { ConnectionEditor } from './ConnectionEditor'
import { BindingEditor, ConnectionPanel } from './ConnectionPanel'
import { IntegrationProductIcon } from './IntegrationProductIcon'
import { IntegrationProviderFrame } from './IntegrationProviderFrame'
import { IntegrationSection } from './IntegrationSections'
import { PROVIDER_WORKSPACE_EXTENSIONS } from './provider-extensions'
import type { ProviderWorkspaceExtensions, ProviderWorkspaceProps } from './provider-workspace'
import { integrationBridgeMessage, integrationBridgeState } from './bridge'
import { useIntegrationOwner, useIntegrationSnapshot } from './hooks'
import './integration.css'

type IntegrationDialog = { owner: string } & ({ kind: 'connect' | 'edit' } | { kind: 'binding'; binding?: IntegrationBinding })

/** A local subroute of the shell's integrations route, never a competing router. */
export function IntegrationsPage({ extensions = PROVIDER_WORKSPACE_EXTENSIONS }: { extensions?: ProviderWorkspaceExtensions }): JSX.Element {
  const { root, data, error, loading, mainOutdated, refresh } = useIntegrationSnapshot()
  const [selected, setSelected] = useState<IntegrationDirectoryId | null>(null)
  const [connectionId, setConnectionId] = useState('')
  const [dialog, setDialog] = useState<IntegrationDialog | null>(null)
  const [flow, setFlow] = useState<{ owner: string; active: boolean } | null>(null)
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
  const owner = JSON.stringify([entry?.id, root, connection?.id, connection?.revision])
  const latestOwner = useRef(owner)
  latestOwner.current = owner
  const scope = useIntegrationOwner(owner)
  const flowActive = flow?.owner === owner && flow.active
  const onFlowChange = useCallback((isActive: boolean): void => {
    if (scope.current() && latestOwner.current === owner) setFlow({ owner, active: isActive })
  }, [owner, scope.current])
  const navigate = useCallback((id: IntegrationDirectoryId): void => {
    if (!scope.current()) return
    if (directory.current) directoryScroll.current = directory.current.closest('.my-page-body')?.scrollTop ?? 0
    const sameProvider = INTEGRATION_DIRECTORY.find((item) => item.id === id)?.providerId === entry?.providerId
    setDialog(null); setConnectionId(sameProvider ? connection?.id ?? '' : ''); setSelected(id)
  }, [entry?.providerId, connection?.id, scope.current])
  const back = useCallback((): void => {
    if (!scope.current()) return
    returnEntry.current = selected; setDialog(null); setConnectionId(''); setSelected(null)
  }, [selected, scope.current])
  useEscLayer(Boolean(entry) && !flowActive, { kind: 'preview', id: `integration-detail-${escId}`, onClose: back, deferWhenInputFocused: true })
  useLayoutEffect(() => {
    if (!selected && returnEntry.current && canInteract()) {
      directory.current?.querySelector<HTMLButtonElement>(`[data-integration-entry="${returnEntry.current}"]`)?.focus({ preventScroll: true })
      directory.current?.closest('.my-page-body')?.scrollTo({ top: directoryScroll.current })
      returnEntry.current = null
    }
  }, [selected, canInteract])
  // A suspended page or changed source cannot reopen a draft on return.
  useLayoutEffect(() => { setDialog(null) }, [active, owner])
  useLayoutEffect(() => { setFlow(null) }, [owner])
  const openDialog = (next: IntegrationDialog): void => {
    if (scope.current() && active && latestOwner.current === next.owner) setDialog(next)
  }
  const context: ProviderWorkspaceProps | null = entry && provider ? {
    entry, provider, root, connections, connection, bindings: data?.bindings ?? [], nativeAvailable, authorizationAvailable, refresh, navigate, onFlowChange,
    onConnect: () => openDialog({ kind: 'connect', owner }),
    onEditConnection: () => { if (connection) openDialog({ kind: 'edit', owner }) },
    onSelectConnection: (id) => {
      if (!scope.current() || latestOwner.current !== owner || !connections.some((item) => item.id === id)) return
      setDialog(null); setConnectionId(id)
    },
    onBindProject: (binding) => {
      if (!nativeAvailable || !root || !connection?.enabled) return
      if (binding) {
        if (binding.connectionId !== connection.id || projectRootKey(binding.root) !== projectRootKey(root)) return
        if (!data?.bindings.some((item) => item.id === binding.id && item.revision === binding.revision && item.connectionId === connection.id && projectRootKey(item.root) === projectRootKey(root))) return
      }
      openDialog({ kind: 'binding', owner, binding })
    }
  } : null
  const extension = entry ? extensions[entry.id] ?? PROVIDER_WORKSPACE_EXTENSIONS[entry.id] : undefined
  const BeforeConnection = extension?.BeforeConnection
  const Content = extension?.Content
  const sharedConnection = extension?.connectionMode !== 'provider'
  const receipts = connection ? data?.receipts.filter((receipt) => receipt.connectionId === connection.id) ?? [] : []
  const currentDialog = dialog?.owner === owner && active ? dialog : null
  return <div className="integration-page space-y-6">
    {(!nativeAvailable || (error && mainOutdated)) && <p role="status" className="rounded-my-lg border border-my-line p-4 text-my-sm text-my-secondary">{mainOutdated ? error : integrationBridgeMessage(bridge)}</p>}
    {loading && !data && <p role="status" className="flex items-center gap-2 text-my-sm text-my-tertiary"><LoaderCircle size={15} className="animate-spin motion-reduce:animate-none" />正在读取连接…</p>}
    {context ? <IntegrationProviderFrame entry={context.entry} onBack={back} flowActive={flowActive}>
      <InteractionScope key={owner} active={active}>
        {BeforeConnection && !flowActive && <BeforeConnection {...context} />}
        {sharedConnection && !flowActive && <ConnectionPanel provider={context.provider} connection={connection} root={root} bindings={data?.bindings ?? []} connections={connections} loaded={Boolean(data)} nativeAvailable={nativeAvailable} authorizationAvailable={authorizationAvailable} workspaceEnabled={!Content} onSaved={refresh} onConnect={context.onConnect} onEditConnection={context.onEditConnection} onBindProject={context.onBindProject} onSelectConnection={context.onSelectConnection} />}
        {Content && <Content {...context} />}
        {sharedConnection && !flowActive && context.entry.providerId === 'gitlab' && <div className="flex justify-end"><Button size="sm" variant="ghost" onClick={() => navigate(context.entry.kind === 'tasks' ? 'gitlab-repositories' : 'gitlab-issues-self-managed')}>{context.entry.kind === 'tasks' ? '仓库与 Merge Request' : 'GitLab Issues'}<ChevronRight size={13} /></Button></div>}
        {sharedConnection && !flowActive && context.entry.kind === 'messaging' && connection && <IntegrationSection title="发送记录">{receipts.length === 0 ? <p className="text-my-sm text-my-tertiary">暂无发送记录</p> : receipts.slice(0, 10).map((receipt) => <div key={receipt.requestId} className="integration-list-row"><div className="min-w-0 flex-1"><p className="break-words text-my-sm">{receipt.destination}</p><p className="mt-1 text-my-xs text-my-tertiary">{new Date(receipt.createdAt).toLocaleString()}</p>{receipt.detail && <details className="mt-2 text-my-xs text-my-secondary"><summary>结果详情</summary><p className="mt-2 break-words">{receipt.detail}</p></details>}</div><span className={`text-my-xs ${receipt.state === 'uncertain' ? 'text-my-warning-text' : 'text-my-secondary'}`}>{({ pending: '等待确认', delivered: '已送达', failed: '发送失败', uncertain: '结果待核实' })[receipt.state]}</span></div>)}</IntegrationSection>}
        {currentDialog && currentDialog.kind !== 'binding' && <ConnectionEditor key={`${owner}:${currentDialog.kind}`} provider={context.provider} connection={currentDialog.kind === 'edit' ? connection : undefined} authorizationAvailable={authorizationAvailable} onClose={() => setDialog(null)} onSaved={refresh} />}
        {currentDialog?.kind === 'binding' && root && connection && <BindingEditor key={`${owner}:${currentDialog.binding?.id ?? 'new'}:${currentDialog.binding?.revision ?? 0}`} root={root} connection={connection} provider={context.provider} binding={currentDialog.binding} onClose={() => setDialog(null)} onSaved={refresh} />}
      </InteractionScope>
    </IntegrationProviderFrame> : <div ref={directory} className="space-y-8" data-integration-directory>
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-my-xl font-semibold">外部应用集成</h2><Button size="sm" variant="ghost" disabled={bridge !== 'ready' || loading} onClick={() => void refresh()}><RefreshCw size={13} />刷新</Button></div>
      {INTEGRATION_DIRECTORY_GROUPS.map((group) => <section key={group.id} aria-labelledby={`integration-group-${group.id}`} className="space-y-3"><h3 id={`integration-group-${group.id}`} className="text-my-sm font-medium">{group.name}</h3><div className="integration-directory-grid">
        {INTEGRATION_DIRECTORY.filter((item) => item.category === group.id).map((item) => {
          const count = data?.connections.filter((saved) => saved.providerId === item.providerId).length
          return <button key={item.id} type="button" data-integration-entry={item.id} onClick={() => navigate(item.id)} className="integration-directory-item"><IntegrationProductIcon provider={item.providerId} /><div className="min-w-0 flex-1"><p className="font-medium">{item.name}</p><p className="mt-1 text-my-sm text-my-tertiary">{item.description}</p>{count !== undefined && count > 0 && <p className="mt-2 text-my-xs text-my-secondary">{count} 个连接</p>}</div><ChevronRight size={15} className="shrink-0 text-my-icon-tertiary" /></button>
        })}
      </div></section>)}
    </div>}
    {error && bridge === 'ready' && !mainOutdated && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-my-lg border border-my-line p-4 text-my-sm"><span className="text-my-danger-text">{error}</span><Button size="sm" disabled={loading} onClick={() => void refresh()}>重试读取</Button></div>}
  </div>
}

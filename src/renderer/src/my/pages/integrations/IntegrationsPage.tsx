import { useCallback, useId, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { ChevronRight, LoaderCircle, RefreshCw } from 'lucide-react'
import { INTEGRATION_CATALOG, type DeliveryReceipt, type IntegrationBinding, type IntegrationConnection } from '../../../../../shared/integrations'
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
import { PreferenceSection } from '../../../pages/settings/PreferenceSection'
import { LegacyKnowledgeSettings } from './LegacyKnowledgeSettings'

type IntegrationDialog = { owner: string } & ({ kind: 'connect' | 'edit'; selection: string; connection?: IntegrationConnection } | { kind: 'binding'; binding?: IntegrationBinding })

/** A local subroute of the shell's integrations route, never a competing router. */
export function IntegrationsPage({ extensions = PROVIDER_WORKSPACE_EXTENSIONS }: { extensions?: ProviderWorkspaceExtensions }): JSX.Element {
  const { root, data, error, loading, mainOutdated, refresh } = useIntegrationSnapshot()
  const [selected, setSelected] = useState<IntegrationDirectoryId | null>(null)
  const [connectionId, setConnectionId] = useState('')
  const [dialog, setDialog] = useState<IntegrationDialog | null>(null)
  const editorSavedId = useRef<string | null>(null)
  const dialogRef = useRef(dialog)
  dialogRef.current = dialog
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
  const isFeishu = entry?.id === 'feishu'
  const catalog = data?.catalog ?? INTEGRATION_CATALOG
  const provider = entry ? catalog.find((item) => item.id === entry.providerId) ?? INTEGRATION_CATALOG.find((item) => item.id === entry.providerId) : undefined
  const connections = data?.connections.filter((item) => item.providerId === entry?.providerId) ?? []
  const connection = connections.find((item) => item.id === connectionId) ?? connections[0]
  const authorizationAvailable = data?.authorizationProviders.includes(entry?.providerId ?? 'jira') ?? false
  const selectionOwner = JSON.stringify([entry?.id, root, connectionId])
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
  useLayoutEffect(() => { setDialog(null); editorSavedId.current = null }, [active, selectionOwner])
  useLayoutEffect(() => { setDialog((value) => value?.kind === 'binding' ? null : value) }, [owner])
  useLayoutEffect(() => { setFlow(null) }, [owner])
  const openDialog = (next: IntegrationDialog): void => {
    if (scope.current() && active && latestOwner.current === next.owner) { editorSavedId.current = null; setDialog(next) }
  }
  const context: ProviderWorkspaceProps | null = entry && provider ? {
    entry, provider, root, connections, connection, bindings: data?.bindings ?? [], nativeAvailable, authorizationAvailable, refresh, navigate, onFlowChange,
    onConnect: () => { if (!isFeishu) openDialog({ kind: 'connect', owner, selection: selectionOwner }) },
    onEditConnection: () => { if (connection) openDialog({ kind: 'edit', owner, selection: selectionOwner, connection }) },
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
  const currentDialog = active && dialog && (dialog.kind === 'binding' ? dialog.owner === owner : dialog.selection === selectionOwner) ? dialog : null
  const connectionPanel = context && <ConnectionPanel provider={context.provider} connection={connection} root={root}
    bindings={context.bindings} connections={connections} loaded={Boolean(data)} nativeAvailable={nativeAvailable}
    authorizationAvailable={authorizationAvailable} workspaceEnabled={isFeishu || !Content}
    title={isFeishu ? '通知连接' : undefined} allowCreate={!isFeishu}
    onSaved={refresh} onAuthorizationSaved={() => refresh(true)} onConnect={context.onConnect}
    onEditConnection={context.onEditConnection} onBindProject={context.onBindProject} onSelectConnection={context.onSelectConnection} />
  return <div className="integration-page space-y-6">
    {!isFeishu && !nativeAvailable && <p role="status" className="rounded-my-lg border border-my-line p-4 text-my-sm text-my-secondary">{mainOutdated ? error : integrationBridgeMessage(bridge)}</p>}
    {!isFeishu && loading && !data && <p role="status" className="flex items-center gap-2 text-my-sm text-my-tertiary"><LoaderCircle size={15} className="animate-spin motion-reduce:animate-none" />正在读取连接…</p>}
    {context ? <IntegrationProviderFrame entry={context.entry} onBack={back} flowActive={flowActive}>
      <InteractionScope key={isFeishu ? `feishu:${projectRootKey(root)}` : selectionOwner} active={active}>
        {BeforeConnection && !flowActive && <BeforeConnection key={owner} {...context} />}
        {sharedConnection && !isFeishu && !flowActive && connectionPanel}
        {Content && <Content key={isFeishu ? undefined : owner} {...context} />}
        {context.entry.providerId === 'weknora' && !flowActive && <LegacyKnowledgeSettings />}
        {sharedConnection && !flowActive && context.entry.providerId === 'gitlab' && <div className="flex justify-end"><Button size="sm" variant="ghost" onClick={() => navigate(context.entry.kind === 'tasks' ? 'gitlab-repositories' : 'gitlab-issues-self-managed')}>{context.entry.kind === 'tasks' ? '仓库与 Merge Request' : 'GitLab Issues'}<ChevronRight size={13} /></Button></div>}
        {isFeishu && !flowActive && connection && <details className="integration-disclosure rounded-my-lg border border-my-line bg-my-layer-1 px-4 py-3">
          <summary>已有群通知（仅发送）</summary>
          <div className="mt-3 space-y-3">
            {error && <div className="flex flex-wrap items-center justify-between gap-2 text-my-sm">
              <span role="alert" className="break-words text-my-danger-text">{error}</span>
              <Button size="sm" disabled={loading} onClick={() => void refresh()}>重试读取通知</Button>
            </div>}
            {connectionPanel}
            <NotificationReceipts receipts={receipts} />
          </div>
        </details>}
        {sharedConnection && !isFeishu && !flowActive && context.entry.kind === 'messaging' && connection && <NotificationReceipts receipts={receipts} />}
        {currentDialog && currentDialog.kind !== 'binding' && <ConnectionEditor key={`${selectionOwner}:${currentDialog.kind}`} provider={context.provider} connection={currentDialog.connection} connections={connections} authorizationAvailable={authorizationAvailable} onClose={() => { if (editorSavedId.current) setConnectionId(editorSavedId.current); setDialog(null); editorSavedId.current = null }} onSaved={async (value) => { await refresh(context.provider.id === 'jira'); if (value && dialogRef.current === currentDialog) editorSavedId.current = value.id }} />}
        {currentDialog?.kind === 'binding' && root && connection && <BindingEditor key={`${owner}:${currentDialog.binding?.id ?? 'new'}:${currentDialog.binding?.revision ?? 0}`} root={root} connection={connection} provider={context.provider} binding={currentDialog.binding} onClose={() => setDialog(null)} onSaved={refresh} />}
      </InteractionScope>
    </IntegrationProviderFrame> : <div ref={directory} className="preferences-page" data-integration-directory>
      {INTEGRATION_DIRECTORY_GROUPS.map((group, index) => <PreferenceSection key={group.id} id={`integration-group-${group.id}`} title={group.name} action={index === 0 ? <Button size="sm" variant="ghost" aria-label="刷新集成" disabled={bridge !== 'ready' || loading} onClick={() => void refresh()}><RefreshCw size={13} />刷新</Button> : undefined}><div className="integration-directory-grid">
        {INTEGRATION_DIRECTORY.filter((item) => item.category === group.id).map((item) => {
          const count = item.id === 'feishu' ? undefined : data?.connections.filter((saved) => saved.providerId === item.providerId).length
          return <button key={item.id} type="button" data-integration-entry={item.id} onClick={() => navigate(item.id)} className="integration-directory-item"><IntegrationProductIcon provider={item.providerId} /><div className="min-w-0 flex-1"><p className="my-item-title">{item.name}</p><p className="my-item-description mt-1">{item.description}</p></div>{count !== undefined && count > 0 && <span className="my-item-description shrink-0">{count} 个连接</span>}<ChevronRight size={15} className="shrink-0 text-my-icon-tertiary" /></button>
        })}
      </div></PreferenceSection>)}
    </div>}
    {!isFeishu && error && bridge === 'ready' && !mainOutdated && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-my-lg border border-my-line p-4 text-my-sm"><span className="text-my-danger-text">{error}</span><Button size="sm" disabled={loading} onClick={() => void refresh()}>重试读取</Button></div>}
  </div>
}

function NotificationReceipts({ receipts }: { receipts: readonly DeliveryReceipt[] }): JSX.Element {
  const states = { pending: '等待确认', delivered: '已送达', failed: '发送失败', uncertain: '结果待核实' }
  return <IntegrationSection title="发送记录">
    {receipts.length === 0 ? <p className="my-item-description">暂无发送记录</p> : receipts.slice(0, 10).map((receipt) =>
      <div key={receipt.requestId} className="integration-list-row">
        <div className="min-w-0 flex-1">
          <p className="my-item-title break-words">{receipt.destination}</p>
          <p className="my-item-description mt-1">{new Date(receipt.createdAt).toLocaleString()}</p>
          {receipt.detail && <details className="integration-disclosure mt-2"><summary>结果详情</summary><p className="mt-2 break-words text-my-sm">{receipt.detail}</p></details>}
        </div>
        <span className={`text-my-xs ${receipt.state === 'uncertain' ? 'text-my-warning-text' : 'text-my-secondary'}`}>{states[receipt.state]}</span>
      </div>)}
  </IntegrationSection>
}

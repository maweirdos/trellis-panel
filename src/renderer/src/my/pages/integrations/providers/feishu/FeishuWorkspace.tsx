import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { Link2, LoaderCircle, MoreHorizontal, Plus } from 'lucide-react'
import { hasFeishuApi, type FeishuApi, type FeishuConnection, type FeishuOutput } from '@shared/feishu-integration'
import type { CruxAgent, CruxSpace } from '@shared/crux'
import { cleanModelDisplayName, defaultConfiguredModelId } from '@shared/model-selection'
import { api as desktop, hasIpc } from '../../../../../api'
import { Select } from '../../../../../components/Select'
import { confirmDialog } from '../../../../../components/Dialogs'
import { ConnectionPanel as TeamConnectionPanel } from '../../../../../crux/ConnectionPanel'
import { availableExecutionTargets, observeCollaborationWorkspace, useCrux } from '../../../../../crux/store'
import { PreferenceRow, PreferenceSection } from '../../../../../pages/settings/PreferenceSection'
import { useApp } from '../../../../../store'
import { useInteractionActive, useInteractionSignal } from '../../../../../utils/interaction-scope'
import { projectRootKey } from '../../../../navigation'
import { FeedbackNotice } from '../../../../FeedbackNotice'
import { useMy } from '../../../../store'
import { Button, Dropdown, DropdownItem } from '../../../../ui'
import type { IntegrationResource } from '../../IntegrationSections'
import { useIntegrationAction, useIntegrationOwner, useIntegrationRead } from '../../hooks'
import type { ProviderWorkspaceProps } from '../../provider-workspace'
import { FeishuAuthorizationDialog, FeishuRegistrationDialog } from './authorization'
import { feishuConnectionStatus, FeishuError } from './presentation'
import { FeishuRegistrationController, type RegistrationTarget } from './registration'
import { ConnectionSetup, modelChoice, OrganizationSetup, type FeishuModel } from './setup'

type Snapshot = FeishuOutput<'snapshot'>
type Runtime = NonNullable<Snapshot['runtimes']>[number]
const STATUS_INTERVAL = 5000
const TEAM_SCOPE_KEY = /^[a-f0-9]{64}$/

export function FeishuWorkspaceContent({ root }: ProviderWorkspaceProps): JSX.Element {
  const bridge = desktop?.feishuWorkspace
  if (hasFeishuApi(bridge)) return <FeishuWorkspace key={projectRootKey(root)} api={bridge} root={root} />
  return <FeishuError title="飞书接入暂不可用" message={hasIpc || navigator.userAgent.includes('Electron/')
    ? '请从系统托盘退出并重新打开 Crux，以加载飞书集成。'
    : '请在 Crux 桌面应用中打开此页面。'} />
}

function useFeishuSnapshot(api: FeishuApi, root: string | null, enabled = true, scopeKey = '') {
  const key = JSON.stringify(['feishu-snapshot', projectRootKey(root), enabled, scopeKey])
  const owner = useIntegrationOwner(key)
  const active = useInteractionActive()
  const load = useCallback(async (): Promise<IntegrationResource<Snapshot>> => {
    if (!enabled) return { state: 'loading' }
    const selectedScopeKey = TEAM_SCOPE_KEY.test(scopeKey) ? scopeKey : undefined
    const result = await api.snapshot(selectedScopeKey ? { expectedRoot: root, selectedScopeKey } : { expectedRoot: root })
    if (result.ok) return { state: 'ready', data: result.data }
    const state = result.code === 'E_DENIED' ? 'denied'
      : result.code === 'E_UNAVAILABLE' || result.code === 'E_VERSION' ? 'unavailable' : 'error'
    return { state, detail: result.error || '飞书后台没有返回连接状态。' }
  }, [api, root, enabled, scopeKey])
  const { resource, refresh } = useIntegrationRead(key, load)
  const retained = useRef<{ current: () => boolean; data: Snapshot; verified: boolean } | null>(null)
  if (resource.state === 'ready' && owner.current()) {
    retained.current = { current: owner.current, data: resource.data, verified: true }
  } else if (resource.state !== 'loading' && retained.current?.current === owner.current) {
    retained.current.verified = false
  }
  const data = retained.current?.current === owner.current && owner.current() ? retained.current.data : null
  const available = Boolean(data && retained.current?.verified)
  useEffect(() => {
    if (!active || resource.state !== 'ready') return
    const timer = window.setTimeout(refresh, STATUS_INTERVAL)
    return () => window.clearTimeout(timer)
  }, [active, resource, refresh])
  return { data, available, resource, refresh }
}

function ReadStatus({ status, title, retryLabel }: {
  status: ReturnType<typeof useFeishuSnapshot>
  title: string
  retryLabel: string
}): JSX.Element | null {
  const { resource, available, refresh } = status
  if (resource.state === 'ready' || (resource.state === 'loading' && available)) return null
  if (resource.state === 'loading') return <p role="status" className="flex items-center gap-2 py-3 text-my-sm text-my-secondary">
    <LoaderCircle size={15} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />正在读取连接状态…
  </p>
  return <div className="py-3">
    <FeishuError title={title} message={resource.detail}
      actions={<Button size="sm" onClick={refresh}>{retryLabel}</Button>} />
  </div>
}

function FeishuWorkspace({ api, root }: { api: FeishuApi; root: string | null }): JSX.Element {
  const context = useCrux((state) => state.workspaceContext)
  const spaceId = useCrux((state) => state.currentSpaceId)
  const [registration] = useState(() => new FeishuRegistrationController())
  const mounted = useRef(false)
  const authorityKey = JSON.stringify([
    context.key, context.actorId, context.authorizationRevision, context.instanceId, context.epoch,
    context.state === 'access-revoked'
  ])
  const registrationScope = JSON.stringify([authorityKey, spaceId])
  const previousScope = useRef(registrationScope)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      // React StrictMode replays cleanup without actually leaving the workspace.
      queueMicrotask(() => { if (!mounted.current) registration.select(null, false) })
    }
  }, [registration])
  useEffect(() => {
    if (previousScope.current !== registrationScope) registration.select(null, false)
    previousScope.current = registrationScope
  }, [registration, registrationScope])
  return <>
    <AccountConnections api={api} />
    <SpaceConnections key={registrationScope} api={api} root={root} authorityKey={authorityKey} registration={registration} />
  </>
}

function AccountConnections({ api }: { api: FeishuApi }): JSX.Element {
  const status = useFeishuSnapshot(api, null)
  const { data, available, refresh } = status
  const signal = useInteractionSignal()
  const action = useIntegrationAction(`feishu-account:${data?.organization?.id}:${data?.organization?.revision}`)
  const [dialog, setDialog] = useState<{ kind: 'organization' | 'account'; current: () => boolean } | null>(null)
  const organization = data?.organization
  const account = data?.account?.state === 'linked' ? data.account : null
  const accountHint = account ? `${account.displayName || '飞书账号'} · 已绑定`
    : !data ? undefined : !organization ? '绑定组织应用后可授权'
    : data.accountAvailable ? '尚未绑定' : '当前组织应用未提供设备授权'
  const activeDialog = dialog?.current === action.current && action.current() ? dialog.kind : null
  const readAccount = useCallback((attemptId: string) => api.accountStatus({ expectedRoot: null, attemptId }), [api])
  const cancelAccount = useCallback((attemptId: string) => api.cancelAccount({ expectedRoot: null, attemptId }), [api])
  const unlink = async (): Promise<void> => {
    if (!available || !action.current()) return
    const confirmed = await confirmDialog({
      title: '解除个人飞书账号绑定？', message: 'Crux 将移除此账号的个人授权。',
      confirmText: '解除绑定', danger: true
    }, signal)
    if (confirmed && action.current() && await action.run(() => api.unlinkAccount({ expectedRoot: null })) !== undefined) refresh()
  }
  return <PreferenceSection id="feishu-account" title="应用与账号">
    {organization ? <ConnectionRow api={api} root={null} entry={organization} label="组织应用" available={available} refresh={refresh} />
      : <PreferenceRow label="组织应用" hint={data ? '尚未绑定' : undefined}>
        <Button size="sm" variant="primary" onClick={() => setDialog({ kind: 'organization', current: action.current })}>绑定飞书应用</Button>
      </PreferenceRow>}
    <PreferenceRow label="我的飞书账号" hint={accountHint}>
      {account ? <Button size="sm" disabled={!available || action.busy} onClick={() => void unlink()}>解除绑定</Button>
        : <Button size="sm" disabled={!available || !data?.accountAvailable || action.busy}
          onClick={() => setDialog({ kind: 'account', current: action.current })}>绑定账号</Button>}
    </PreferenceRow>
    <ReadStatus status={status} title="组织应用与账号状态读取失败" retryLabel="重试读取应用" />
    {action.error && <div className="py-3"><FeishuError title="解除账号绑定失败" message={action.error} /></div>}
    {activeDialog === 'organization' && !organization && <OrganizationSetup api={api} available={available}
      onClose={() => setDialog(null)} onSaved={refresh}>
      <ReadStatus status={status} title="组织应用状态读取失败" retryLabel="重试读取应用" />
    </OrganizationSetup>}
    {activeDialog === 'account' && data?.accountAvailable && <FeishuAuthorizationDialog title="绑定我的飞书账号"
      ownerKey={`feishu-personal-authorization:${organization?.id}:${organization?.revision}`} canStart={available && !account}
      begin={() => api.beginAccount({ expectedRoot: null })} read={readAccount} cancel={cancelAccount}
      onClose={() => setDialog(null)} onConnected={refresh}>
      <p className="my-item-description">使用组织应用在飞书授权你的个人账号。</p>
    </FeishuAuthorizationDialog>}
  </PreferenceSection>
}

type SpaceDialog = { kind: 'assistant' | 'agent' } | { kind: 'configure'; connection: FeishuConnection }

function SpaceConnections({ api, root, authorityKey, registration }: {
  api: FeishuApi
  root: string | null
  authorityKey: string
  registration: FeishuRegistrationController
}): JSX.Element {
  const snapshot = useCrux((state) => state.snapshot)
  const context = useCrux((state) => state.workspaceContext)
  const globalSpaceId = useCrux((state) => state.currentSpaceId)
  const loadError = useCrux((state) => state.loadError)
  const ai = useApp((state) => state.settings?.ai)
  const canRead = context.state === 'connected' && TEAM_SCOPE_KEY.test(context.key)
  const status = useFeishuSnapshot(api, root, canRead, context.key)
  const { data, available, refresh } = status
  const [selected, setSelected] = useState('')
  const [teamOpen, setTeamOpen] = useState(false)
  const [teamReading, setTeamReading] = useState(Boolean(desktop?.crux && !snapshot))
  const [dialog, setDialog] = useState<SpaceDialog | null>(null)
  const [registrationKind, setRegistrationKind] = useState<'assistant' | 'agent' | null>(null)
  const spaces = canRead
    ? snapshot?.spaces.filter((space) => !space.archived && context.actorId && space.memberIds.includes(context.actorId)) ?? []
    : []
  const space = spaces.find((item) => item.id === selected) ?? spaces.find((item) => item.id === globalSpaceId) ?? (spaces.length === 1 ? spaces[0] : undefined)
  const connections = data?.connections.filter((entry) => entry.spaceId === space?.id && (!entry.scopeKey || entry.scopeKey === context.key)) ?? []
  const assistant = connections.find((entry) => entry.kind === 'assistant')
  const boundAgents = connections.filter((entry) => entry.kind === 'agent')
  const agents = snapshot && space ? availableExecutionTargets(snapshot, space.id).agents : []
  const freeAgents = agents.filter((item) => !boundAgents.some((entry) => entry.agentId === item.id))
  const scopeValid = canRead && Boolean(space)
  const manageable = scopeValid && !loadError
  const canWrite = available && manageable
  const spaceIssue = context.state === 'offline' ? '团队工作区离线'
    : context.state === 'access-revoked' ? '团队空间访问权限已失效'
    : teamReading && !snapshot ? '正在读取团队空间…'
    : context.state === 'local' ? '请先连接 Crux 团队工作区'
    : !canRead ? '请重新核对团队工作区的配对'
    : loadError ? '暂时无法读取团队空间'
    : !snapshot ? '等待读取团队空间'
    : spaces.length === 0 ? '请加入一个团队空间' : undefined
  const models = useMemo((): FeishuModel[] => {
    if (!ai?.providers?.length) return ai?.enabled && ai.model
      ? [{ value: modelChoice('default', ai.model), label: cleanModelDisplayName(ai.model, 'pi'), providerId: 'default', modelId: ai.model }] : []
    return ai.providers.filter((provider) => provider.enabled).flatMap((provider) =>
      provider.models.filter((model) => model.enabled).map((model) => ({
        value: modelChoice(provider.id, model.id), label: cleanModelDisplayName(model.name || model.id, 'pi'),
        providerId: provider.id, modelId: model.id
      })))
  }, [ai])
  const defaultModelId = ai && defaultConfiguredModelId(ai)
  const defaultModel = models.find((model) => `${model.providerId}:${model.modelId}` === defaultModelId)
  const openModels = (): void => useApp.getState().setPage('models')
  const initial = dialog?.kind === 'configure' ? dialog.connection : null
  const currentConfig = initial && connections.some((entry) => entry.id === initial.id && entry.revision === initial.revision)
  const action = useIntegrationOwner(`feishu-space:${projectRootKey(root)}:${context.key}:${space?.id}`)
  const active = useInteractionActive()
  useEffect(() => {
    if (!active || !scopeValid) setDialog(null)
    if (!scopeValid) {
      registration.select(null, false)
      setRegistrationKind(null)
    }
  }, [active, scopeValid, registration])
  const reloadTeam = useCallback(async (): Promise<void> => {
    setTeamReading(true)
    try { await useCrux.getState().bootstrap() }
    finally { setTeamReading(false) }
  }, [])
  useEffect(() => {
    if (!active || !desktop?.crux) return
    const release = observeCollaborationWorkspace()
    if (!useCrux.getState().snapshot) void reloadTeam()
    return release
  }, [active, reloadTeam])
  const onConfigure = (connection: FeishuConnection): void => {
    if (canWrite && action.current()) {
      registration.select(null, false)
      setRegistrationKind(null)
      setDialog({ kind: 'configure', connection })
    }
  }
  const openSpaces = (): void => {
    useCrux.getState().setModule('spaces')
    useApp.getState().setPage('crux')
  }
  const agentSettings = (): void => {
    if (!space) return
    useCrux.getState().setCurrentSpace(space.id)
    useCrux.getState().setModule('agents')
    useApp.getState().setPage('crux')
  }
  return <PreferenceSection id="feishu-inbound" title="任务助手与 Agent">
    <PreferenceRow label="团队空间" hint={spaceIssue}>
      {spaces.length > 0 && <Select ariaLabel="团队空间" size="sm" value={space?.id ?? ''} disabled={teamReading || Boolean(loadError)}
        placeholder="选择团队空间" className="max-w-full"
        options={spaces.map((item) => ({ value: item.id, label: item.name }))}
        onChange={(value) => {
          if (!action.current() || !spaces.some((item) => item.id === value)) return
          registration.select(null, false)
          setRegistrationKind(null)
          setDialog(null)
          setSelected(value)
        }} />}
      {context.state === 'offline' && <Button size="sm" disabled={teamReading} onClick={() => void reloadTeam()}>{teamReading ? '读取中…' : '重试连接团队'}</Button>}
      {(!canRead && context.state !== 'offline') &&
        <Button size="sm" disabled={teamReading} onClick={() => setTeamOpen(true)}>{context.state === 'local' ? '连接团队' : '管理账号与工作区'}</Button>}
      {canRead && !loadError && !snapshot &&
        <Button size="sm" disabled={teamReading} onClick={() => void reloadTeam()}>{teamReading ? '读取中…' : '读取空间'}</Button>}
      {canRead && snapshot && !loadError && spaces.length === 0 && <Button size="sm" onClick={openSpaces}>浏览团队空间</Button>}
    </PreferenceRow>
    {assistant ? <ConnectionRow api={api} root={root} entry={assistant} label="空间任务助手" available={canWrite} refresh={refresh} configure={onConfigure} />
      : <PreferenceRow label="空间任务助手" hint={available && scopeValid ? '尚未绑定' : undefined}>
        <Button size="sm" disabled={!manageable}
          onClick={() => { setRegistrationKind('assistant'); setDialog({ kind: 'assistant' }) }}><Plus size={14} aria-hidden="true" />添加任务助手</Button>
      </PreferenceRow>}
    <PreferenceRow label="Agents" hint={manageable && !agents.length ? '当前空间没有可用的 Agent' : undefined}>
      {manageable && !agents.length ? <Button size="sm" onClick={agentSettings}>管理 Agents</Button>
        : <Button size="sm" disabled={!manageable || !freeAgents.length}
          onClick={() => { setRegistrationKind('agent'); setDialog({ kind: 'agent' }) }}><Link2 size={14} aria-hidden="true" />绑定 Agent</Button>}
    </PreferenceRow>
    {boundAgents.map((entry) => <ConnectionRow key={entry.id} api={api} root={root} entry={entry} label={entry.name}
      available={canWrite} refresh={refresh} configure={onConfigure} />)}
    {loadError && <div className="py-3">
      <FeishuError title="团队空间读取失败" message={loadError} actions={<Button size="sm" disabled={teamReading}
        onClick={() => void reloadTeam()}>{teamReading ? '读取中…' : '重试读取团队空间'}</Button>} />
    </div>}
    {canRead && <ReadStatus status={status} title="飞书助手状态读取失败" retryLabel="重试读取助手" />}
    {teamOpen && <TeamConnectionPanel hideTrigger open initialStep={context.state === 'local' ? 'auth' : 'accounts'} onOpenChange={setTeamOpen} />}
    {dialog?.kind === 'configure' && initial && currentConfig && <ConnectionSetup key={`${initial.id}:${initial.revision}`} api={api} root={root}
      connection={initial} available={canWrite} models={models} defaultModel={defaultModel}
      openModels={openModels} onClose={() => setDialog(null)} onSaved={refresh} />}
    {scopeValid && space && registrationKind && <RegisterTarget key={space.id} kind={registrationKind}
      api={api} root={root} scopeKey={context.key} authorityKey={authorityKey} space={space} available={canWrite} runtimes={data?.runtimes}
      defaultModel={defaultModel} agents={agents} boundAgents={boundAgents} registration={registration}
      open={dialog?.kind === registrationKind && active} openModels={openModels} onClose={() => setDialog(null)} refresh={refresh}>
      <ReadStatus status={status} title="飞书助手状态读取失败" retryLabel="重试读取助手" />
    </RegisterTarget>}
  </PreferenceSection>
}

function RegisterTarget({ kind, api, root, scopeKey, authorityKey, space, agents, boundAgents, runtimes, defaultModel, available, registration, open, openModels, onClose, refresh, children }: {
  kind: 'assistant' | 'agent'
  api: FeishuApi
  root: string | null
  scopeKey: string
  authorityKey: string
  space: CruxSpace
  agents: readonly CruxAgent[]
  boundAgents: readonly FeishuConnection[]
  runtimes?: readonly Runtime[]
  defaultModel?: FeishuModel
  available: boolean
  registration: FeishuRegistrationController
  open: boolean
  openModels: () => void
  onClose: () => void
  refresh: () => void
  children: ReactNode
}): JSX.Element {
  const [agentId, setAgent] = useState('')
  const [runtimeId, setRuntime] = useState('')
  const runtime = runtimes?.find((item) => item.id === runtimeId) ?? runtimes?.[0]
  const agent = agents.find((item) => item.id === agentId)
  const assistant = kind === 'assistant'
  useEffect(() => {
    if (agentId && !agents.some((item) => item.id === agentId)) setAgent('')
  }, [agentId, agents])
  const target: RegistrationTarget | null = (assistant ? Boolean(runtime) : Boolean(agent)) ? {
    key: JSON.stringify([projectRootKey(root), authorityKey, scopeKey, space.id, kind, assistant ? runtime?.id : agent?.id]),
    begin: () => api.beginRegistration({
      expectedRoot: root, kind, scopeKey, spaceId: space.id, agentId: assistant ? null : agent?.id ?? null,
      name: (assistant ? `${space.name}任务助手` : agent?.name || 'Agent').slice(0, 120),
      ...(assistant && runtime ? { runtimeId: runtime.id } : {}),
      ...(assistant && defaultModel ? { providerId: defaultModel.providerId, modelId: defaultModel.modelId } : {})
    }),
    isConnected: async () => {
      const result = await api.snapshot({ expectedRoot: root, selectedScopeKey: scopeKey })
      if (!result.ok) return result
      return { ok: true, data: result.data.connections.some((entry) =>
        entry.scopeKey === scopeKey && entry.spaceId === space.id && entry.kind === kind &&
        entry.agentId === (assistant ? null : agent?.id)) }
    },
    read: (attemptId) => api.registrationStatus({ expectedRoot: root, attemptId, selectedScopeKey: scopeKey }),
    cancel: (attemptId) => api.cancelRegistration({ expectedRoot: root, attemptId, selectedScopeKey: scopeKey }),
    discard: (attemptId) => api.cancelRegistration({
      expectedRoot: root, attemptId, selectedScopeKey: scopeKey, discardUnconfirmed: true
    })
  } : null
  const openEngines = (): void => {
    useMy.getState().setSettingsView('engines')
    useApp.getState().setPage('settings')
  }
  return <FeishuRegistrationDialog title={assistant ? '添加任务助手' : '绑定 Agent'} subtitle={space.name}
    controller={registration} target={target} open={open}
    canStart={available && (assistant ? Boolean(runtime) : Boolean(agent && !boundAgents.some((entry) => entry.agentId === agent.id)))}
    canRecover={available && Boolean(target)}
    onClose={onClose} onConnected={refresh}>
    {!assistant && <div className="space-y-1"><p className="my-item-title">Agent</p>
      <Select ariaLabel="Agent" className="w-full" value={agent?.id ?? ''} onChange={setAgent}
        placeholder="选择 Agent" options={agents.map((item) => ({
          value: item.id, label: item.name, disabled: item.id !== agentId && boundAgents.some((entry) => entry.agentId === item.id)
        }))} />
    </div>}
    {assistant && <div className="space-y-1">
      <p className="my-item-title">运行环境</p>
      {runtime && runtimes ? <Select ariaLabel="运行环境" className="w-full" value={runtime.id} onChange={setRuntime}
        options={runtimes.map((item) => ({ value: item.id, label: `${item.name} · ${item.deviceName}（本机）` }))} />
        : available && (runtimes ? <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="my-item-description">暂无可用的本机运行环境</p>
          <Button size="sm" onClick={openEngines}>配置执行引擎</Button>
        </div> : <p className="my-item-description">请完整退出并重新打开 Crux，以加载飞书运行环境。</p>)}
    </div>}
    {assistant && runtime && !defaultModel && <div className="flex flex-wrap items-center gap-2">
      <p className="my-item-description">授权后，配置模型即可处理消息。</p>
      <Button size="sm" variant="ghost" onClick={openModels}>配置模型</Button>
    </div>}
    {children}
  </FeishuRegistrationDialog>
}

function ConnectionRow({ api, root, entry, label, available, refresh, configure }: {
  api: FeishuApi
  root: string | null
  entry: FeishuConnection
  label: string
  available: boolean
  refresh: () => void
  configure?: (entry: FeishuConnection) => void
}): JSX.Element {
  const signal = useInteractionSignal()
  const action = useIntegrationAction(`feishu-app:${root}:${entry.id}:${entry.revision}`)
  const operation = entry.lastOperation
  const remaining = entry.pendingOperations?.filter(item => item.commandId !== operation?.commandId) ?? []
  const memberSetupAvailable = entry.kind !== 'organization' && entry.state === 'connected'
  const connectionIssue = entry.state === 'failed' || entry.state === 'blocked'
  const retryLabel = entry.kind === 'organization' ? '重新验证并连接' : '重新连接'
  const input = { expectedRoot: root, id: entry.id, revision: entry.revision, selectedScopeKey: entry.scopeKey ?? undefined }
  const retry = (): void => {
    if (!available || !action.current()) return
    void action.run(() => api.retry(input)).then((result) => { if (result) refresh() })
  }
  const disconnect = async (): Promise<void> => {
    if (!available || !action.current()) return
    const confirmed = await confirmDialog({
      title: `断开「${label}」？`,
      message: entry.kind === 'organization' ? 'Crux 将停止接收该应用的消息。' : '该机器人将不再响应飞书群中的消息。',
      confirmText: '断开连接', danger: true
    }, signal)
    if (confirmed && action.current() && await action.run(() => api.disconnect(input)) !== undefined) refresh()
  }
  return <PreferenceRow label={label} hint={<span role="status">{entry.kind === 'organization' && `${entry.name} · `}{feishuConnectionStatus(entry)}</span>}
    detail={entry.detail || action.error || operation || remaining.length || memberSetupAvailable ? <div className="space-y-2">
      {memberSetupAvailable && <details className="integration-disclosure">
        <summary>成员如何使用</summary>
        <p className="my-item-description mt-2 break-words">在 Crux 网页版打开对应空间，从「飞书账号」生成绑定码。私聊此机器人，发送 <code>绑定 &lt;绑定码&gt;</code>，然后就能在允许的群里 @ 助手。</p>
      </details>}
      {entry.detail && (connectionIssue ? <FeishuError title="请核对飞书连接" message={entry.detail} /> : <details className="integration-disclosure">
        <summary aria-label={`${label}的连接详情`}>连接详情</summary>
        <p className="my-item-description mt-2 break-words">{entry.detail}</p>
      </details>)}
      {operation && <OperationStatus key={operation.commandId} api={api} root={root} entry={entry} operation={operation}
        available={available} refresh={refresh} />}
      {remaining.length > 0 && <details className="integration-disclosure">
        <summary>更早的待核对记录</summary>
        <div className="mt-2 space-y-2">{remaining.map((item) => <OperationStatus key={item.commandId} api={api} root={root} entry={entry}
          operation={item} available={available} refresh={refresh} showTime />)}</div>
      </details>}
      <FeishuError title="操作未完成" message={action.error} />
    </div> : undefined}>
    {configure && <Button size="sm" disabled={!available || action.busy} onClick={() => configure(entry)}>设置</Button>}
    {connectionIssue && <Button size="sm" disabled={!available || action.busy} onClick={retry}>{action.busy ? '连接中…' : retryLabel}</Button>}
    <Dropdown align="right" trigger={({ open, toggle }) => <Button size="sm" variant="ghost" disabled={!available || action.busy}
      aria-label={`${label}的连接操作`} aria-expanded={open} onClick={toggle}><MoreHorizontal size={16} aria-hidden="true" /></Button>}>
      {(close) => <>
        {!connectionIssue && <DropdownItem disabled={action.busy || !available} onClick={() => { close(); retry() }}>{retryLabel}</DropdownItem>}
        {entry.kind === 'organization' && <DropdownItem onClick={() => {
          close()
          void desktop.openExternal('https://open.feishu.cn/app').catch(() => {
            if (action.current()) action.setError('无法打开系统浏览器。请在浏览器访问 open.feishu.cn/app。')
          })
        }}>打开飞书开放平台</DropdownItem>}
        <DropdownItem danger disabled={action.busy || !available} onClick={() => { close(); void disconnect() }}>断开连接</DropdownItem>
      </>}
    </Dropdown>
  </PreferenceRow>
}

function OperationStatus({ api, root, entry, operation, available, refresh, showTime }: {
  api: FeishuApi
  root: string | null
  entry: FeishuConnection
  operation: NonNullable<FeishuConnection['lastOperation']>
  available: boolean
  refresh: () => void
  showTime?: boolean
}): JSX.Element | null {
  const action = useIntegrationAction(`feishu-receipt:${root}:${entry.id}:${entry.revision}:${operation.commandId}`)
  const [checked, setChecked] = useState<FeishuOutput<'reconcile'> | null>(null)
  const uncertain = operation.phase === 'unknown'
  const warning = uncertain || operation.reply === 'unknown'
  const label = uncertain ? (entry.kind === 'assistant' ? '任务处理结果待核实' : 'Agent 处理结果待核实')
    : operation.phase === 'failed' ? '最近一条消息处理失败'
    : operation.reply === 'unknown' ? '飞书回复结果待核实'
    : operation.reply === 'failed' ? '飞书回复未发出' : null
  if (!label && !checked?.confirmed) return null
  const reconcile = (): void => {
    if (!available || action.busy || !action.current()) return
    void action.run(() => api.reconcile({
      expectedRoot: root, id: entry.id, revision: entry.revision, selectedScopeKey: entry.scopeKey ?? undefined,
      originalCommandId: operation.commandId
    })).then((result) => {
      if (!result || !action.current()) return
      setChecked(result)
      if (result.confirmed) refresh()
    })
  }
  return <>
    {label && <FeedbackNotice variant="inline" tone={warning ? 'warning' : 'error'} title={label}
      description={checked && !checked.confirmed ? checked.detail : showTime ? new Date(operation.at).toLocaleString() : undefined}
      actions={entry.kind === 'assistant' && uncertain ? <Button size="sm" disabled={!available || action.busy} onClick={reconcile}>
        {action.busy ? '核对中…' : '核对原任务结果'}
      </Button> : undefined} />}
    {checked?.confirmed && <p role="status" className="my-item-description">{checked.detail}</p>}
    <FeishuError title="无法核对原任务结果" message={action.error} />
  </>
}

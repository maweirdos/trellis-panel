import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { Bot } from 'lucide-react'
import type { DingApp, DingAssistant, DingOutput, DingTalkApi } from '@shared/dingtalk-integration'
import { Button } from '../../../../ui'
import { Select } from '../../../../../components/Select'
import { confirmDialog } from '../../../../../components/Dialogs'
import { useInteractionSignal } from '../../../../../utils/interaction-scope'
import type { ProviderWorkspaceProps } from '../../provider-workspace'
import { IntegrationResourceState, IntegrationSection, type IntegrationResource } from '../../IntegrationSections'
import { useIntegrationAction, useIntegrationRead, useIntegrationOwner } from '../../hooks'
import { dingTalkBridge } from './bridge'
import { DingTalkAppForm, DingTalkAssistantForm } from './forms'
import { AccountDialog, InboxDialog, PrivateNotifications } from './dialogs'
import { GroupNotifications } from './GroupNotifications'
import { DingTalkDetails, DingTalkDialog, DingTalkRow } from './presentation'

const missing = '当前环境暂不可管理钉钉组织应用与任务助手，请在已接入此功能的桌面应用中打开。'
const appStates: Record<DingApp['state'], string> = { unverified: '待验证', 'credentials-verified': '凭据已验证', degraded: '需要处理', revoked: '已撤销' }
const assistantStates: Record<DingAssistant['state'], string> = { stopped: '已停止', connecting: '连接中', registered: '接收中', retrying: '正在重连', blocked: '已阻止', degraded: '需要处理' }
const policies: Record<DingAssistant['policy']['execution'], string> = { 'tasks-only': '仅创建任务', manual: '本机确认后执行', 'native-approvals': '保留原生审批' }

// Invalidate the two sibling mountpoints after a local operation without a
// second polling loop or a second snapshot/persistence authority.
const snapshotReaders = new Map<string | null, Set<() => void>>()

function useDingSnapshot(api: DingTalkApi, root: string | null, poll = true) {
  const owner = useIntegrationOwner(`ding-snapshot:${root ?? '@profile'}`)
  const load = useCallback(async (): Promise<IntegrationResource<DingOutput<'snapshot'>>> => {
    const result = await api.snapshot({ expectedRoot: root })
    return result.ok ? { state: 'ready', data: result.data } : { state: result.code === 'E_DENIED' ? 'denied' : result.code === 'E_UNAVAILABLE' ? 'unavailable' : 'error', detail: result.error }
  }, [api, root])
  const read = useIntegrationRead(`dingtalk:${root ?? '@profile'}`, load)
  useEffect(() => {
    const readers = snapshotReaders.get(root) ?? new Set<() => void>()
    snapshotReaders.set(root, readers); readers.add(read.refresh)
    return () => { readers.delete(read.refresh); if (readers.size === 0) snapshotReaders.delete(root) }
  }, [root, read.refresh])
  const refresh = useCallback((): void => { snapshotReaders.get(root)?.forEach(reader => reader()) }, [root])
  const retained = useRef<{ current: typeof owner.current; data: DingOutput<'snapshot'> } | null>(null)
  if (read.resource.state === 'ready' && owner.current()) retained.current = { current: owner.current, data: read.resource.data }
  // Retention keeps an existing controller alive, never authorizes an action.
  const controllerData = retained.current?.current === owner.current && owner.current() ? retained.current.data : null
  const resource = read.resource.state === 'loading' && controllerData ? { state: 'ready' as const, data: controllerData } : read.resource
  useEffect(() => { if (!poll) return; const timer = setInterval(read.refresh, 5000); return () => clearInterval(timer) }, [poll, read.refresh])
  return { ...read, resource, refresh, controllerData, snapshotResource: read.resource }
}

export function DingTalkBeforeConnection(props: ProviderWorkspaceProps): JSX.Element {
  const api = dingTalkBridge()
  return api ? <Applications key={props.root ?? '@profile'} api={api} root={props.root} /> : <IntegrationSection title="组织应用"><IntegrationResourceState resource={{ state: 'unavailable', detail: missing }} /></IntegrationSection>
}

function Applications({ api, root }: { api: DingTalkApi; root: string | null }): JSX.Element {
  // Only the workspace polls. This summary refreshes on its explicit operations.
  const read = useDingSnapshot(api, root, false), action = useIntegrationAction(`ding-apps:${root ?? ''}`)
  const signal = useInteractionSignal()
  const [editing, setEditing] = useState<DingApp | 'new' | null>(null)
  useEffect(() => { setEditing(null) }, [action.current])
  return <>
    <IntegrationSection title="组织应用" action={{ label: '绑定应用', disabled: action.busy || read.resource.state !== 'ready', onClick: () => setEditing('new') }}>
      {read.resource.state !== 'ready' ? <IntegrationResourceState resource={read.resource.state === 'loading' ? read.resource : { ...read.resource, action: { label: '重试', onClick: read.refresh } }} /> : read.resource.data.apps.length === 0 ? <p className="text-my-sm text-my-tertiary">尚未绑定企业内部应用。</p> : <div className="divide-y divide-my-line">{read.resource.data.apps.map(app => <article key={app.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
        <div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0 flex-1"><p className="break-words text-my-sm font-medium">{app.name}</p><p className="mt-1 text-my-xs text-my-tertiary">{appStates[app.state]}</p></div><div className="flex flex-wrap gap-2"><Button size="sm" disabled={action.busy} onClick={() => setEditing(app)}>编辑</Button><Button size="sm" disabled={action.busy || !app.hasSecret} onClick={() => void action.run(() => api.verifyApp({ expectedRoot: root, appId: app.id, revision: app.revision })).then(result => { if (result) read.refresh() })}>{action.busy ? '处理中…' : '验证应用'}</Button></div></div>
        <DingTalkDetails label="应用详情"><p>{app.detail}</p><p>企业 CorpId：{app.corpId}</p><p>{app.observedCorpId ? `已验证企业：${app.observedCorpId}` : '企业身份尚未验证'}</p><p>{app.hasSecret ? '密钥已保存' : '尚未保存密钥'}</p>{app.checkedAt && <p>最近验证：{new Date(app.checkedAt).toLocaleString()}</p>}<Button size="sm" disabled={action.busy || app.state === 'revoked'} onClick={() => void (async () => {
          const confirmed = await confirmDialog({ title: `撤销「${app.name}」接入？`, message: '将清除本机应用凭据，停用关联助手和个人通知，并撤销关联个人账号。钉钉平台的应用需由管理员另行停用。', confirmText: '撤销接入', danger: true }, signal)
          if (!confirmed || !action.current()) return
          const result = await action.run(() => api.revokeApp({ expectedRoot: root, appId: app.id, revision: app.revision }))
          if (result) read.refresh()
        })()}>撤销应用接入</Button></DingTalkDetails>
      </article>)}</div>}
      {action.error && <p role="alert" className="text-my-sm text-my-danger-text">{action.error}</p>}
    </IntegrationSection>
    {editing && <DingTalkAppForm api={api} root={root} initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); read.refresh() }} />}
  </>
}

export function DingTalkContent(props: ProviderWorkspaceProps): JSX.Element {
  const api = dingTalkBridge()
  return api ? <Workspace key={props.root ?? '@profile'} api={api} {...props} /> : <UnavailableWorkspace {...props} />
}

function UnavailableWorkspace(props: ProviderWorkspaceProps): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null)
  return <>
    <IntegrationSection title="账号与通知"><DingTalkRow title="个人账号" detail="绑定本人钉钉身份"><Button size="sm" onClick={() => setSelected('绑定个人账号')}>绑定账号</Button></DingTalkRow><DingTalkRow title="任务助手" detail="从钉钉接收当前项目的任务请求"><Button size="sm" onClick={() => setSelected('新建任务助手')}>新建助手</Button></DingTalkRow><GroupNotifications {...props} /></IntegrationSection>
    {selected && <DingTalkDialog title={selected} onClose={() => setSelected(null)} footer={<Button onClick={() => setSelected(null)}>关闭</Button>}><p role="status" className="text-my-sm text-my-secondary">{missing}</p></DingTalkDialog>}
  </>
}

function Workspace({ api, ...props }: ProviderWorkspaceProps & { api: DingTalkApi }): JSX.Element {
  const { root } = props
  const read = useDingSnapshot(api, root), action = useIntegrationAction(`ding-workspace:${root ?? ''}`)
  const [appId, setAppId] = useState('')
  const [editing, setEditing] = useState<DingAssistant | 'new' | null>(null)
  const [editingApp, setEditingApp] = useState<DingApp | 'new' | null>(null)
  const [accountOpen, setAccountOpen] = useState(false), [privateOpen, setPrivateOpen] = useState(false), [linkOpen, setLinkOpen] = useState(false)
  const [inboxId, setInboxId] = useState<string | null>(null)
  useEffect(() => { setEditing(null); setEditingApp(null); setAccountOpen(false); setPrivateOpen(false); setLinkOpen(false); setInboxId(null) }, [action.current])
  const resource = read.resource
  const data = resource.state === 'ready' ? resource.data : null
  const app = data?.apps.find(item => item.id === appId) ?? data?.apps[0]
  const accountApp = read.controllerData?.apps.find(item => item.id === appId) ?? read.controllerData?.apps[0]
  const assistants = data?.assistants.filter(item => item.appId === app?.id) ?? []
  const inboxAssistant = assistants.find(item => item.id === inboxId)
  const account = data?.accounts.find(item => item.appId === app?.id && item.appRevision === app?.revision && item.state === 'linked')
  const configureApp = (): void => { setAccountOpen(false); setLinkOpen(false); setEditingApp(app ?? 'new') }
  const refresh = (): void => read.refresh()
  const readyForAssistant = Boolean(root && data?.workspace && data.streamAvailable && app?.state === 'credentials-verified')
  return <div className="space-y-6">
    {data && data.apps.length > 1 && <div className="flex flex-wrap items-center gap-3"><span className="text-my-xs text-my-tertiary">管理应用</span><Select ariaLabel="个人账号与助手所属应用" value={app?.id ?? ''} options={data.apps.map(item => ({ value: item.id, label: item.name }))} onChange={id => { setAppId(id); setAccountOpen(false); setPrivateOpen(false); setInboxId(null); setEditing(null) }} /></div>}
    <IntegrationSection title="个人账号">
      {data ? <DingTalkRow title={account?.displayName || '钉钉账号'} detail={account ? '已绑定个人身份' : '尚未绑定个人身份'}><Button size="sm" onClick={() => setAccountOpen(true)}>{account ? '管理账号' : '绑定账号'}</Button></DingTalkRow> : <IntegrationResourceState resource={resource.state === 'ready' ? { state: 'unavailable', detail: '钉钉状态暂不可用' } : resource.state === 'loading' ? resource : { ...resource, action: { label: '重试', onClick: refresh } }} />}
    </IntegrationSection>
    <IntegrationSection title="项目任务助手" action={{ label: '新建助手', disabled: action.busy || !data, onClick: () => setEditing('new') }}>
      {!data ? <IntegrationResourceState resource={resource.state === 'ready' ? { state: 'unavailable', detail: '钉钉状态暂不可用' } : resource} /> : assistants.length === 0 ? <div className="flex items-center gap-3 py-3"><Bot size={24} className="shrink-0 text-my-icon-tertiary" /><div><p className="text-my-sm">尚未添加任务助手</p><p className="mt-1 text-my-xs text-my-tertiary">从钉钉接收任务，关联当前项目。</p></div></div> : <div className="divide-y divide-my-line">{assistants.map(item => <article key={item.id} className="space-y-3 py-4 first:pt-0 last:pb-0">
        <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><p className="break-words text-my-sm font-medium">{item.name}</p><p className="mt-1 text-my-xs text-my-secondary">{assistantStates[item.state]} · {policies[item.policy.execution]}</p><p className="mt-1 text-my-xs text-my-tertiary">{item.policy.allowedSenders.length} 位成员 · {item.policy.allowedGroups.length} 个群</p></div><div className="flex flex-wrap gap-2"><Button size="sm" disabled={action.busy} onClick={() => setEditing(item)}>编辑</Button><Button size="sm" disabled={action.busy || (!item.enabled && !readyForAssistant)} onClick={() => void action.run(() => api.setAssistant({ expectedRoot: root, assistantId: item.id, revision: item.revision, enabled: !item.enabled })).then(result => { if (result) refresh() })}>{item.enabled ? '停止接收' : '启用接收'}</Button><Button size="sm" onClick={() => setInboxId(item.id)}>消息回执</Button></div></div>
        <DingTalkDetails label="连接详情与使用帮助"><p>{item.detail}</p><p>最近接收：{item.lastMessageAt ? new Date(item.lastMessageAt).toLocaleString() : '暂无消息'}</p><p>自动回复：{item.policy.replyEnabled ? '已启用，会发送至原会话' : '未启用'}</p><Button size="sm" disabled={action.busy || !item.enabled || !data.streamAvailable} onClick={() => void action.run(() => api.retryAssistant({ expectedRoot: root, assistantId: item.id, revision: item.revision })).then(result => { if (result) refresh() })}>重连 Stream</Button><p>普通文本创建任务。任务命令：/task create 内容；/task query 回执ID；/task update 回执ID P2 标题。</p><p>Agent 命令：/agent run 内容；/agent query 回执ID；/agent cancel 回执ID。执行仍受已保存策略与原生审批约束。</p></DingTalkDetails>
      </article>)}</div>}
      {action.error && <p role="alert" className="text-my-sm text-my-danger-text">{action.error}</p>}
    </IntegrationSection>
    <IntegrationSection title="通知与链接"><div className="divide-y divide-my-line">
      <DingTalkRow title="个人私信通知" detail="向已绑定的个人账号发送通知"><Button size="sm" disabled={!data} onClick={() => setPrivateOpen(true)}>管理通知</Button></DingTalkRow>
      <GroupNotifications {...props} />
      <DingTalkRow title="链接预览" detail="在钉钉中查看共享链接内容"><Button size="sm" disabled={!data} onClick={() => setLinkOpen(true)}>查看设置</Button></DingTalkRow>
    </div></IntegrationSection>
    {read.controllerData && <AccountDialog key={`account:${root}:${accountApp?.id}:${accountApp?.revision}`} open={accountOpen} api={api} root={root} app={accountApp} data={read.controllerData} snapshotIssue={read.snapshotResource.state === 'ready' ? undefined : read.snapshotResource} onClose={() => setAccountOpen(false)} onConfigure={configureApp} refresh={refresh} />}
    {data && app && <PrivateNotifications key={`private:${app.id}:${app.revision}`} open={privateOpen} api={api} root={root} app={app} data={data} refresh={refresh} onClose={() => setPrivateOpen(false)} />}
    {privateOpen && data && !app && <DingTalkDialog title="个人私信通知" onClose={() => setPrivateOpen(false)} footer={<Button onClick={() => { setPrivateOpen(false); configureApp() }}>配置组织应用</Button>}><p className="text-my-sm text-my-secondary">先绑定组织应用和个人账号，再启用私信通知。</p></DingTalkDialog>}
    {inboxAssistant && data && <InboxDialog key={`${inboxAssistant.id}:${inboxAssistant.revision}`} api={api} root={root} assistant={inboxAssistant} executionAvailable={data.executionAvailable} refresh={refresh} onClose={() => setInboxId(null)} />}
    {editing && data && (readyForAssistant || editing !== 'new') && root ? <DingTalkAssistantForm api={api} root={root} apps={data.apps.filter(item => item.state === 'credentials-verified')} initial={editing === 'new' ? null : editing} executionAvailable={data.executionAvailable} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh() }} /> : editing && <DingTalkDialog title="新建任务助手" onClose={() => setEditing(null)} footer={<><Button onClick={() => setEditing(null)}>取消</Button>{(!app || app.state !== 'credentials-verified') && <Button variant="primary" onClick={() => { setEditing(null); configureApp() }}>查看应用配置</Button>}</>}><p role="status" className="text-my-sm text-my-secondary">{!root || !data?.workspace ? '请先打开并授权当前项目。' : !app || app.state !== 'credentials-verified' ? '先绑定并验证组织应用，再添加任务助手。' : '当前环境尚未启用消息接收，请检查桌面应用的钉钉接入与网络设置。'}</p></DingTalkDialog>}
    {editingApp && <DingTalkAppForm api={api} root={root} initial={editingApp === 'new' ? null : editingApp} onClose={() => setEditingApp(null)} onSaved={() => { setEditingApp(null); refresh() }} />}
    {linkOpen && data && <DingTalkDialog title="链接预览" onClose={() => setLinkOpen(false)} footer={<Button onClick={() => setLinkOpen(false)}>完成</Button>}><p role="status" className="text-my-sm text-my-secondary">{data.personal.linkPreview === 'ready' ? '链接预览回调已验证。' : data.personal.linkPreview === 'needs-setup' ? '链接预览回调与共享内容授权尚未验证。' : '当前环境尚未启用链接预览服务。'}</p>{data.personal.linkPreview !== 'ready' && <p className="text-my-xs text-my-secondary">需由管理员配置可信回调服务，并完成个人身份与共享内容授权。</p>}<DingTalkDetails label="服务状态"><p>{data.personal.detail}</p></DingTalkDetails></DingTalkDialog>}
  </div>
}

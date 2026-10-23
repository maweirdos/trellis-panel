import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { DingApp, DingAssistant, DingInput, DingOutput, DingPreview, DingTalkApi } from '@shared/dingtalk-integration'
import { Button } from '../../../../ui'
import { Select } from '../../../../../components/Select'
import type { ProviderWorkspaceProps } from '../../provider-workspace'
import { IntegrationAccountSection, IntegrationResourceState, IntegrationSection, type IntegrationResource } from '../../IntegrationSections'
import { useIntegrationAction, useIntegrationRead, useIntegrationOwner } from '../../hooks'
import { dingTalkBridge } from './bridge'
import { DingTalkAppForm, DingTalkAssistantForm } from './forms'

const missing = '当前原生版本尚未接入钉钉组织应用与任务助手。请完成主进程和 preload 接线并完整重启；现有群 Webhook 可继续使用。'
function useDingSnapshot(api: DingTalkApi, root: string | null) {
  const owner = useIntegrationOwner(`ding-snapshot:${root ?? '@profile'}`)
  const load = useCallback(async (): Promise<IntegrationResource<DingOutput<'snapshot'>>> => { const result = await api.snapshot({ expectedRoot: root }); return result.ok ? { state: 'ready', data: result.data } : { state: result.code === 'E_DENIED' ? 'denied' : result.code === 'E_UNAVAILABLE' ? 'unavailable' : 'error', detail: result.error } }, [api, root])
  const read = useIntegrationRead(`dingtalk:${root ?? '@profile'}`, load)
  const retained = useRef<{ current: typeof owner.current; data: DingOutput<'snapshot'> } | null>(null)
  if (read.resource.state === 'ready' && owner.current()) retained.current = { current: owner.current, data: read.resource.data }
  const resource = read.resource.state === 'loading' && retained.current?.current === owner.current && owner.current() ? { state: 'ready' as const, data: retained.current.data } : read.resource
  useEffect(() => { const timer = setInterval(read.refresh, 5000); return () => clearInterval(timer) }, [read.refresh])
  return { ...read, resource }
}
export function DingTalkBeforeConnection(props: ProviderWorkspaceProps): JSX.Element {
  const api = dingTalkBridge()
  return api ? <Applications key={props.root ?? '@profile'} api={api} root={props.root} /> : <IntegrationSection title="钉钉组织应用"><IntegrationResourceState resource={{ state: 'unavailable', detail: missing }} /></IntegrationSection>
}
function Applications({ api, root }: { api: DingTalkApi; root: string | null }): JSX.Element {
  const read = useDingSnapshot(api, root), action = useIntegrationAction(`ding-apps:${root ?? ''}`)
  const [editing, setEditing] = useState<DingApp | 'new' | null>(null)
  const states: Record<DingApp['state'], string> = { unverified: '尚未验证', 'credentials-verified': '凭据有效', degraded: '需要处理', revoked: '已撤销' }
  return <>
    <IntegrationSection title="组织应用" description="AppKey / AppSecret 用于组织应用。个人账号、私信通知和每个工作区的任务助手分别配置。下方原有连接面板继续管理群 Webhook。" action={{ label: '添加应用', disabled: action.busy || read.resource.state !== 'ready', onClick: () => setEditing('new') }}>
      {read.resource.state !== 'ready' ? <IntegrationResourceState resource={read.resource} /> : read.resource.data.apps.length === 0 ? <p className="text-my-sm text-my-tertiary">尚未配置组织应用。</p> : read.resource.data.apps.map(app => <article key={app.id} className="space-y-2 border-t border-my-line pt-3"><div className="flex flex-wrap justify-between gap-2"><p className="text-my-sm font-medium">{app.name}</p><span className="my-chip text-my-xs">{states[app.state]}</span></div><p className="break-words text-my-xs text-my-tertiary">配置组织 {app.corpId} · {app.observedCorpId ? `已观察组织 ${app.observedCorpId}` : '组织身份尚未观察'} · {app.hasSecret ? '凭据受保护' : '未保存凭据'}</p><p className="text-my-sm text-my-secondary">{app.detail}</p><div className="flex flex-wrap gap-2"><Button size="sm" disabled={action.busy} onClick={() => setEditing(app)}>编辑 / 轮换凭据</Button><Button size="sm" disabled={action.busy || !app.hasSecret} onClick={() => void action.run(() => api.verifyApp({ expectedRoot: root, appId: app.id, revision: app.revision })).then(read.refresh)}>验证应用</Button><Button size="sm" disabled={action.busy || app.state === 'revoked'} onClick={() => void action.run(() => api.revokeApp({ expectedRoot: root, appId: app.id, revision: app.revision })).then(read.refresh)}>撤销本机凭据及接入</Button></div></article>)}
      {action.error && <p role="alert" className="text-my-sm text-my-danger-text">{action.error}</p>}
    </IntegrationSection>
    {editing && <DingTalkAppForm api={api} root={root} initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); read.refresh() }} />}
  </>
}
export function DingTalkContent(props: ProviderWorkspaceProps): JSX.Element {
  const api = dingTalkBridge()
  return api ? <Workspace key={props.root ?? '@profile'} api={api} root={props.root} /> : <IntegrationSection title="个人账号与任务助手"><IntegrationResourceState resource={{ state: 'unavailable', detail: missing }} /></IntegrationSection>
}
function Workspace({ api, root }: { api: DingTalkApi; root: string | null }): JSX.Element {
  const read = useDingSnapshot(api, root), action = useIntegrationAction(`ding-workspace:${root ?? ''}`)
  const [appId, setAppId] = useState(''), [assistantId, setAssistantId] = useState('')
  const [editing, setEditing] = useState<DingAssistant | 'new' | null>(null)
  const [authorization, setAuthorization] = useState<{ authorizationId: string; appId: string; revision: number; expiresAt: number } | null>(null)
  const authRequest = useRef<string | null>(null)
  const [after, setAfter] = useState<string | null>(null), [historyStack, setHistoryStack] = useState<Array<string | null>>([])
  const resource = read.resource
  const data = resource.state === 'ready' ? resource.data : null
  const app = data?.apps.find(item => item.id === appId) ?? data?.apps[0]
  const assistants = data?.assistants.filter(item => item.appId === app?.id) ?? []
  const assistant = assistants.find(item => item.id === assistantId) ?? assistants[0]
  const selectedKey = assistant ? `${assistant.id}:${assistant.revision}` : ''
  useEffect(() => { setAfter(null); setHistoryStack([]) }, [selectedKey])
  const loadHistory = useCallback(async (): Promise<IntegrationResource<DingOutput<'inbox'>>> => {
    if (!assistant) return { state: 'ready', data: { items: [], next: null } }
    const result = await api.inbox({ expectedRoot: root, assistantId: assistant.id, after, limit: 30 })
    return result.ok ? { state: 'ready', data: result.data } : { state: 'error', detail: result.error }
  }, [api, root, assistant?.id, assistant?.revision, after])
  const history = useIntegrationRead(`ding-inbox:${root}:${selectedKey}:${after}`, loadHistory)
  useEffect(() => { const timer = setInterval(history.refresh, 5000); return () => clearInterval(timer) }, [history.refresh])
  const refresh = (): void => { read.refresh(); history.refresh() }
  if (!data) return <IntegrationSection title="个人账号与任务助手"><IntegrationResourceState resource={resource.state === 'ready' ? { state: 'unavailable', detail: '钉钉状态不可用' } : resource} /></IntegrationSection>
  const accounts = data.accounts.filter(item => item.appId === app?.id)
  const accountInput = app ? { expectedRoot: root, appId: app.id, revision: app.revision } : null
  return <div className="space-y-5">
    <IntegrationSection title="应用与账号配置"><Select ariaLabel="配置钉钉应用" value={app?.id ?? ''} onChange={id => { setAppId(id); setAssistantId(''); setAuthorization(null); authRequest.current = null }} options={[{ value: '', label: '选择组织应用' }, ...data.apps.map(item => ({ value: item.id, label: item.name }))]} /><p className="text-my-sm text-my-tertiary">{data.personal.detail}</p></IntegrationSection>
    <IntegrationAccountSection resource={{ state: 'ready', data: accounts.map(account => ({ id: account.id, providerId: 'dingtalk', connectionId: account.appId, revision: account.revision, remoteUserId: account.staffId, displayName: account.displayName, state: account.state })) }} action={{ label: '通过钉钉绑定个人账号', disabled: action.busy || !data.personal.available || app?.state !== 'credentials-verified' || Boolean(authRequest.current), onClick: () => { if (!accountInput) return; const requestId = crypto.randomUUID(); authRequest.current = requestId; void action.run(() => api.authorizeAccount({ ...accountInput, requestId })).then(result => { if (result) setAuthorization({ ...result, appId: accountInput.appId, revision: accountInput.revision }); refresh() }) } }} accountAction={account => ({ label: '解除绑定', disabled: action.busy || account.state !== 'linked', onClick: () => void action.run(() => api.unlinkAccount({ expectedRoot: root, accountId: account.id, revision: account.revision })).then(refresh) })} />
    {authorization && <IntegrationSection title="完成个人授权"><p className="text-my-sm">在钉钉完成授权后，领取经过服务验证的个人身份。有效期至 {new Date(authorization.expiresAt).toLocaleTimeString()}。</p><Button size="sm" disabled={action.busy || Date.now() >= authorization.expiresAt} onClick={() => void action.run(() => api.claimAccount({ expectedRoot: root, appId: authorization.appId, revision: authorization.revision, authorizationId: authorization.authorizationId })).then(result => { if (result) { setAuthorization(null); authRequest.current = null }; refresh() })}>领取已授权身份</Button></IntegrationSection>}
    <IntegrationSection title="工作区任务助手" description="本机 Stream 接收与 Agent 执行不要求团队账号。每个助手固定本机工作区、发送者和会话范围；后台保留设置决定桌面退出后的运行方式。" action={{ label: '添加任务助手', disabled: !root || !data.workspace || !data.streamAvailable || app?.state !== 'credentials-verified' || action.busy, onClick: () => setEditing('new') }}>
      {!root && <p className="text-my-sm text-my-tertiary">请先打开并授权本机工作区。</p>}{!data.streamAvailable && <p className="text-my-sm text-my-warning-text">Stream SDK 尚未就绪，需要主进程安装并接入固定版本 2.1.5。</p>}
      {assistants.map(item => <article key={item.id} className="space-y-2 border-t border-my-line pt-3"><p className="text-my-sm font-medium">{item.name} · {item.state}</p><p className="break-words text-my-sm text-my-secondary">{item.detail}</p><p className="text-my-xs text-my-tertiary">允许 {item.policy.allowedSenders.length} 名成员、{item.policy.allowedGroups.length} 个群 · {item.policy.execution === 'tasks-only' ? '仅任务' : item.policy.execution === 'manual' ? '本机确认后执行' : '保留原生审批'} · 最近消息 {item.lastMessageAt ? new Date(item.lastMessageAt).toLocaleString() : '尚无'}</p><div className="flex flex-wrap gap-2"><Button size="sm" disabled={action.busy} onClick={() => setEditing(item)}>编辑配置</Button><Button size="sm" disabled={action.busy} onClick={() => void action.run(() => api.setAssistant({ expectedRoot: root, assistantId: item.id, revision: item.revision, enabled: !item.enabled })).then(refresh)}>{item.enabled ? '停止接收' : '启用接收'}</Button><Button size="sm" disabled={action.busy || !item.enabled} onClick={() => void action.run(() => api.retryAssistant({ expectedRoot: root, assistantId: item.id, revision: item.revision })).then(refresh)}>重连 Stream</Button><Button size="sm" onClick={() => setAssistantId(item.id)}>查看消息回执</Button></div></article>)}
      <p className="text-my-xs text-my-tertiary">命令：/task create 内容；/task query 回执ID；/task update 回执ID P2 标题；/agent run 内容；/agent query 或 /agent cancel 回执ID。普通文本只创建任务。</p>
    </IntegrationSection>
    <IntegrationSection title="消息与执行回执" action={{ label: '刷新', onClick: refresh, disabled: action.busy }}>
      {assistant && <Select ariaLabel="查看助手回执" value={assistant.id} options={assistants.map(item => ({ value: item.id, label: item.name }))} onChange={setAssistantId} />}
      {history.resource.state !== 'ready' ? <IntegrationResourceState resource={history.resource} /> : <>{history.resource.data.items.length === 0 && <p className="text-my-sm text-my-tertiary">尚无接收到的消息记录。</p>}{history.resource.data.items.map(item => <article key={item.id} className="space-y-2 border-t border-my-line pt-3"><p className="break-all text-my-xs text-my-tertiary">{new Date(item.receivedAt).toLocaleString()} · {item.id}</p><p className="text-my-sm">{item.state} · {item.detail}</p>{item.execution && <p className="break-all text-my-xs text-my-secondary">执行：{item.execution.state} · {item.execution.sessionId ? `会话 ${item.execution.sessionId}` : '尚无会话证据'} · {item.execution.turnId ? `轮次 ${item.execution.turnId}` : '尚无轮次证据'}</p>}<p className="text-my-xs text-my-tertiary">会话回复：{item.reply}</p><div className="flex flex-wrap gap-2">{!item.execution && item.taskRef && item.state === 'pending' && assistant?.policy.execution !== 'tasks-only' && <Button size="sm" disabled={action.busy || !data.executionAvailable || assistant?.revision !== item.assistantRevision} onClick={() => void action.run(() => api.execute({ expectedRoot: root, receiptId: item.id, assistantRevision: item.assistantRevision })).then(refresh)}>按保存配置接入 Agent</Button>}{item.execution && <><Button size="sm" disabled={action.busy} onClick={() => void action.run(() => api.queryExecution({ expectedRoot: root, receiptId: item.id })).then(refresh)}>查询原执行</Button><Button size="sm" disabled={action.busy || ['completed', 'cancelled', 'denied', 'failed'].includes(item.execution.state)} onClick={() => void action.run(() => api.cancelExecution({ expectedRoot: root, receiptId: item.id })).then(refresh)}>取消原执行</Button></>}</div></article>)}<div className="flex gap-2">{historyStack.length > 0 && <Button size="sm" onClick={() => { setAfter(historyStack.at(-1) ?? null); setHistoryStack(historyStack.slice(0, -1)) }}>上一页</Button>}{history.resource.data.next && <Button size="sm" onClick={() => { if (history.resource.state !== 'ready') return; setHistoryStack([...historyStack, after]); setAfter(history.resource.data.next) }}>下一页</Button>}</div></>}
    </IntegrationSection>
    {app && <PrivateNotifications key={`${app.id}:${app.revision}`} api={api} root={root} app={app} data={data} refresh={read.refresh} />}
    <IntegrationSection title="链接预览" description="链接展开需要可达服务端接收钉钉回调，并按已绑定个人身份检查共享资料权限。"><p className="text-my-sm text-my-secondary">{data.personal.linkPreview === 'ready' ? '服务端已验证链接预览回调' : data.personal.linkPreview === 'needs-setup' ? '回调与共享内容授权尚未完成验证' : '尚未部署链接预览回调服务'}</p></IntegrationSection>
    {action.error && <p role="alert" className="text-my-sm text-my-danger-text">{action.error}</p>}
    {editing && root && <DingTalkAssistantForm api={api} root={root} apps={data.apps.filter(item => item.state === 'credentials-verified')} initial={editing === 'new' ? null : editing} executionAvailable={data.executionAvailable} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh() }} />}
  </div>
}
function PrivateNotifications({ api, root, app, data, refresh }: { api: DingTalkApi; root: string | null; app: DingApp; data: DingOutput<'snapshot'>; refresh(): void }): JSX.Element {
  const action = useIntegrationAction(`ding-private:${app.id}:${app.revision}`)
  const notification = data.notifications.find(item => item.appId === app.id), account = data.accounts.find(item => item.appId === app.id && item.appRevision === app.revision && item.state === 'linked')
  const [title, setTitle] = useState(''), [body, setBody] = useState(''), [preview, setPreview] = useState<DingPreview | null>(null)
  const [receipt, setReceipt] = useState<DingOutput<'sendNotification'> | null>(null), [receipts, setReceipts] = useState<DingOutput<'deliveries'> | null>(null)
  const sendCommand = useRef<string | null>(null)
  const appInput: DingInput<'verifyApp'> = { expectedRoot: root, appId: app.id, revision: app.revision }
  return <IntegrationSection title="个人私信通知" description="组织通知机器人独立于工作区任务助手。每次发送都要预览并确认；保存和验证不会发送消息。">
    <p className="text-my-sm text-my-secondary">{notification?.detail ?? '尚未配置。先绑定个人账号，再启用通知。'}</p><Button size="sm" disabled={action.busy || !account || app.state !== 'credentials-verified'} onClick={() => void action.run(() => api.setNotifications({ ...appInput, expectedRevision: notification?.revision ?? 0, enabled: !notification?.enabled })).then(refresh)}>{notification?.enabled ? '停用个人通知' : '启用个人通知'}</Button>
    <label className="block space-y-1 text-my-sm"><span>标题</span><input className="my-input w-full" maxLength={120} value={title} onChange={event => { setTitle(event.target.value); setPreview(null); setReceipt(null) }} /></label><label className="block space-y-1 text-my-sm"><span>通知内容</span><textarea className="my-input w-full" maxLength={4000} value={body} onChange={event => { setBody(event.target.value); setPreview(null); setReceipt(null) }} /></label>
    <Button size="sm" disabled={action.busy || !notification?.enabled || !account || !title || !body} onClick={() => { if (!account) return; void action.run(() => api.previewNotification({ ...appInput, accountId: account.id, title, body })).then(result => { if (result) { setPreview(result); setReceipt(null); sendCommand.current = crypto.randomUUID() } }) }}>预览私信</Button>
    {preview && <div className="space-y-2 rounded-my-md border border-my-line p-3"><p className="text-my-sm">收件人：{account?.displayName}（{account?.staffId}）</p><p className="font-medium">{preview.title}</p><p className="whitespace-pre-wrap break-words text-my-sm">{preview.body}</p><Button size="sm" disabled={action.busy || Boolean(receipt) || Date.now() >= preview.expiresAt} onClick={() => { const commandId = sendCommand.current; if (!commandId) return; void action.run(() => api.sendNotification({ expectedRoot: root, commandId, preview })).then(result => { if (result) setReceipt(result) }) }}>确认发送这条私信</Button></div>}
    {receipt && <p role="status" className="text-my-sm">{receipt.state} · {receipt.detail}</p>}
    <Button size="sm" disabled={action.busy} onClick={() => void action.run(() => api.deliveries({ expectedRoot: root, appId: app.id, after: null, limit: 30 })).then(result => { if (result) setReceipts(result) })}>读取发送历史</Button>
    {receipts?.items.map(item => <p key={item.id} className="break-words text-my-xs text-my-tertiary">{new Date(item.createdAt).toLocaleString()} · {item.state} · {item.detail}</p>)}
    {action.error && <p role="alert" className="text-my-sm text-my-danger-text">{action.error}</p>}
  </IntegrationSection>
}

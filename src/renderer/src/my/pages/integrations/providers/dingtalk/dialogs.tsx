import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { DingApp, DingAssistant, DingDelivery, DingInbox, DingOutput, DingPreview, DingTalkApi } from '@shared/dingtalk-integration'
import { Button } from '../../../../ui'
import { confirmDialog } from '../../../../../components/Dialogs'
import { useInteractionSignal } from '../../../../../utils/interaction-scope'
import { IntegrationResourceState, type IntegrationResource } from '../../IntegrationSections'
import { useIntegrationAction, useIntegrationOwner, useIntegrationRead } from '../../hooks'
import { DingTalkDetails, DingTalkDialog, DingTalkRow } from './presentation'

type Snapshot = DingOutput<'snapshot'>
const deliveryStates: Record<DingDelivery['state'], string> = { prepared: '等待提交', dispatching: '发送中', accepted: '钉钉已接受 · 送达未确认', delivered: '已送达', failed: '发送失败', unknown: '结果待核实' }
const inboxStates: Record<DingInbox['state'], string> = { received: '已接收', denied: '已拒绝', processing: '处理中', 'task-created': '已创建任务', completed: '已完成', pending: '等待确认', unknown: '结果待核实', failed: '处理失败' }
const executionStates = { pending: '等待接入', denied: '已拒绝执行', admitted: '已接入 Agent', unknown: '执行结果待核实', completed: '执行完成', cancelled: '执行已取消', failed: '执行失败' }
const replyStates: Record<DingInbox['reply'], string> = { disabled: '未启用回复', pending: '等待回复', dispatching: '回复中', delivered: '已回复', failed: '回复失败', unknown: '回复结果待核实' }

export function AccountDialog({ open, api, root, app, data, snapshotIssue, onClose, onConfigure, refresh }: { open: boolean; api: DingTalkApi; root: string | null; app: DingApp | undefined; data: Snapshot; snapshotIssue?: Exclude<IntegrationResource<Snapshot>, { state: 'ready' }>; onClose(): void; onConfigure(): void; refresh(): void }): JSX.Element {
  const action = useIntegrationAction(`ding-account:${app?.id}:${app?.revision}`)
  const signal = useInteractionSignal()
  const [authorization, setAuthorization] = useState<{ authorizationId: string; expiresAt: number } | null>(null)
  const requestId = useRef<string | null>(null)
  const snapshotAvailable = useRef(!snapshotIssue)
  snapshotAvailable.current = !snapshotIssue
  useEffect(() => { setAuthorization(null); requestId.current = null }, [action.current])
  const accounts = data.accounts.filter(item => item.appId === app?.id)
  const input = app ? { expectedRoot: root, appId: app.id, revision: app.revision } : null
  return <DingTalkDialog open={open} busy={action.busy} title="绑定个人账号" onClose={() => { if (!action.busy) onClose() }} footer={<Button disabled={action.busy} onClick={onClose}>完成</Button>}>
    {snapshotIssue && <IntegrationResourceState resource={snapshotIssue.state === 'loading' ? snapshotIssue : { ...snapshotIssue, action: { label: '重试读取', onClick: refresh } }} />}
    <fieldset disabled={action.busy || Boolean(snapshotIssue)} className="min-w-0 space-y-4"><legend className="sr-only">个人账号授权</legend>
    {accounts.map(account => <DingTalkRow key={account.id} title={account.displayName || account.staffId} detail={account.state === 'linked' && account.appRevision === app?.revision ? '已绑定' : '需要重新绑定'}><Button size="sm" disabled={action.busy || account.state !== 'linked'} onClick={() => void (async () => {
      if (!snapshotAvailable.current || !action.current()) return
      const confirmed = await confirmDialog({ title: '解除个人账号绑定？', message: '此账号的个人通知将停用。', confirmText: '解除绑定', danger: true }, signal)
      if (!confirmed || !snapshotAvailable.current || !action.current()) return
      const result = await action.run(() => api.unlinkAccount({ expectedRoot: root, accountId: account.id, revision: account.revision }))
      if (result !== undefined) refresh()
    })()}>解除绑定</Button></DingTalkRow>)}
    {!app ? <div className="space-y-3"><p className="text-my-sm text-my-secondary">先绑定并验证组织应用，再绑定个人账号。</p><Button onClick={onConfigure}>配置组织应用</Button></div> : !data.personal.available ? <div className="space-y-3"><p role="status" className="text-my-sm text-my-secondary">当前环境尚未启用个人账号授权服务。</p><p className="text-my-xs text-my-secondary">请由管理员配置可信授权回调服务后再绑定。组织应用凭据无法代替个人授权。</p><Button size="sm" onClick={onConfigure}>查看组织应用配置</Button><DingTalkDetails label="服务状态"><p>{data.personal.detail}</p></DingTalkDetails></div> : app.state !== 'credentials-verified' ? <div className="space-y-3"><p className="text-my-sm text-my-secondary">组织应用尚未通过验证。</p><Button onClick={onConfigure}>查看应用配置</Button></div> : authorization ? <div className="space-y-3">
      <p className="text-my-sm">在钉钉完成授权后，确认绑定个人身份。</p><p className="text-my-xs text-my-secondary">授权有效期至 {new Date(authorization.expiresAt).toLocaleTimeString()}。</p>
      <Button variant="primary" disabled={action.busy || Date.now() >= authorization.expiresAt} onClick={() => { if (!input || !snapshotAvailable.current || !action.current()) return; void action.run(() => api.claimAccount({ ...input, authorizationId: authorization.authorizationId })).then(result => { if (result) { setAuthorization(null); requestId.current = null; refresh() } }) }}>确认已完成授权</Button>
      {Date.now() >= authorization.expiresAt && <Button disabled={action.busy} onClick={() => { setAuthorization(null); requestId.current = null }}>重新授权</Button>}
    </div> : requestId.current ? <div className="space-y-3"><p role="status" className="text-my-sm text-my-secondary">{action.busy ? '正在请求钉钉授权…' : '授权结果待核实，请检查钉钉授权记录或联系管理员。'}</p><Button size="sm" disabled={action.busy} onClick={refresh}>刷新账号状态</Button><DingTalkDetails label="原授权请求"><p className="break-all">{requestId.current}</p></DingTalkDetails></div> : <div className="space-y-3"><p className="text-my-sm text-my-secondary">通过钉钉授权验证本人身份。</p><Button variant="primary" disabled={action.busy} onClick={() => {
      if (!input || !snapshotAvailable.current || !action.current()) return
      requestId.current ??= crypto.randomUUID()
      const originalRequestId = requestId.current
      void action.run(() => api.authorizeAccount({ ...input, requestId: originalRequestId })).then(result => { if (result) { setAuthorization(result); refresh() } })
    }}>{action.busy ? '等待授权…' : '前往钉钉授权'}</Button></div>}
    </fieldset>
    {action.error && <p role="alert" className="text-my-sm text-my-danger-text">{action.error}</p>}
  </DingTalkDialog>
}

export function InboxDialog({ api, root, assistant, executionAvailable, refresh, onClose }: { api: DingTalkApi; root: string | null; assistant: DingAssistant; executionAvailable: boolean; refresh(): void; onClose(): void }): JSX.Element {
  const [after, setAfter] = useState<string | null>(null), [stack, setStack] = useState<Array<string | null>>([])
  const action = useIntegrationAction(`ding-inbox-actions:${assistant.id}:${assistant.revision}`)
  const load = useCallback(async (): Promise<IntegrationResource<DingOutput<'inbox'>>> => {
    const result = await api.inbox({ expectedRoot: root, assistantId: assistant.id, after, limit: 30 })
    return result.ok ? { state: 'ready', data: result.data } : { state: result.code === 'E_DENIED' ? 'denied' : result.code === 'E_UNAVAILABLE' ? 'unavailable' : 'error', detail: result.error }
  }, [api, root, assistant.id, assistant.revision, after])
  const read = useIntegrationRead(`ding-inbox:${root}:${assistant.id}:${assistant.revision}:${after}`, load)
  const owner = useIntegrationOwner(`ding-inbox:${assistant.id}:${assistant.revision}:${after}`)
  const retained = useRef<{ current: () => boolean; data: DingOutput<'inbox'> } | null>(null)
  if (read.resource.state === 'ready' && owner.current()) retained.current = { current: owner.current, data: read.resource.data }
  const resource = read.resource.state === 'loading' && retained.current?.current === owner.current && owner.current() ? { state: 'ready' as const, data: retained.current.data } : read.resource
  useEffect(() => { const timer = setInterval(read.refresh, 5000); return () => clearInterval(timer) }, [read.refresh])
  const update = (): void => { read.refresh(); refresh() }
  return <DingTalkDialog busy={action.busy} title="消息与执行回执" subtitle={assistant.name} onClose={() => { if (!action.busy) onClose() }} footer={<><Button disabled={action.busy} onClick={update}>刷新</Button><Button disabled={action.busy} onClick={onClose}>完成</Button></>}>
    {resource.state !== 'ready' ? <IntegrationResourceState resource={resource.state === 'loading' ? resource : { ...resource, action: { label: '重试', onClick: read.refresh } }} /> : <>
      {resource.data.items.length === 0 && <p className="py-4 text-my-sm text-my-tertiary">暂无接收到的消息。</p>}
      {resource.data.items.map(item => <article key={item.id} className="space-y-3 border-b border-my-line pb-4 last:border-0">
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-my-sm font-medium">{inboxStates[item.state]}</p><time className="text-my-xs text-my-tertiary">{new Date(item.receivedAt).toLocaleString()}</time></div>
        {item.execution && <p className="text-my-sm text-my-secondary">{executionStates[item.execution.state]}</p>}
        <p className="text-my-xs text-my-secondary">{replyStates[item.reply]}</p>
        {(item.state === 'unknown' || item.execution?.state === 'unknown' || item.reply === 'unknown') && <p className="text-my-xs text-my-warning-text">结果尚未确认，请查询原记录；不会重新执行或自动重发。</p>}
        <div className="flex flex-wrap gap-2">
          {!item.execution && item.taskRef && item.state === 'pending' && assistant.policy.execution !== 'tasks-only' && <Button size="sm" disabled={action.busy || !executionAvailable || assistant.revision !== item.assistantRevision} onClick={() => void action.run(() => api.execute({ expectedRoot: root, receiptId: item.id, assistantRevision: item.assistantRevision })).then(result => { if (result) update() })}>确认接入 Agent</Button>}
          {item.execution && <><Button size="sm" disabled={action.busy} onClick={() => void action.run(() => api.queryExecution({ expectedRoot: root, receiptId: item.id })).then(result => { if (result) update() })}>查询原执行</Button><Button size="sm" disabled={action.busy || ['completed', 'cancelled', 'denied', 'failed'].includes(item.execution.state)} onClick={() => void action.run(() => api.cancelExecution({ expectedRoot: root, receiptId: item.id })).then(result => { if (result) update() })}>取消原执行</Button></>}
        </div>
        <DingTalkDetails label="回执详情"><p>{item.detail}</p>{item.execution && <p>{item.execution.detail}</p>}<dl className="space-y-1 break-all"><div><dt>原回执</dt><dd>{item.id}</dd></div><div><dt>发送成员</dt><dd>{item.senderStaffId}</dd></div>{item.taskRef && <div><dt>关联任务</dt><dd>{item.taskRef}</dd></div>}{item.execution && <><div><dt>原命令</dt><dd>{item.execution.commandId}</dd></div><div><dt>会话 / 轮次</dt><dd>{item.execution.sessionId ?? '尚无会话证据'} / {item.execution.turnId ?? '尚无轮次证据'}</dd></div></>}</dl></DingTalkDetails>
      </article>)}
      <div className="flex flex-wrap gap-2">{stack.length > 0 && <Button size="sm" onClick={() => { setAfter(stack.at(-1) ?? null); setStack(stack.slice(0, -1)) }}>上一页</Button>}{resource.data.next && <Button size="sm" onClick={() => { if (resource.state !== 'ready') return; setStack([...stack, after]); setAfter(resource.data.next) }}>下一页</Button>}</div>
    </>}
    {action.error && <p role="alert" className="text-my-sm text-my-danger-text">{action.error}</p>}
  </DingTalkDialog>
}

/** Kept mounted when closed, so closing a dialog cannot invent a new send UUID. */
export function PrivateNotifications({ open, api, root, app, data, onClose, refresh }: { open: boolean; api: DingTalkApi; root: string | null; app: DingApp; data: Snapshot; onClose(): void; refresh(): void }): JSX.Element {
  const action = useIntegrationAction(`ding-private:${app.id}:${app.revision}`)
  const notification = data.notifications.find(item => item.appId === app.id)
  const account = data.accounts.find(item => item.appId === app.id && item.appRevision === app.revision && item.state === 'linked')
  const [title, setTitle] = useState(''), [body, setBody] = useState(''), [preview, setPreview] = useState<DingPreview | null>(null)
  const [previewOwner, setPreviewOwner] = useState<(() => boolean) | null>(null)
  const [receipt, setReceipt] = useState<DingDelivery | null>(null), [receipts, setReceipts] = useState<DingOutput<'deliveries'> | null>(null)
  const [attempted, setAttempted] = useState(false)
  const sendCommand = useRef<string | null>(null)
  const previewAccount = preview ? data.accounts.find(item => item.id === preview.accountId && item.revision === preview.accountRevision) : undefined
  const previewIdentityCurrent = previewOwner === action.current && action.current() && Boolean(previewAccount && account?.id === previewAccount.id && account.revision === previewAccount.revision)
  const unresolved = attempted && (!receipt || ['prepared', 'dispatching', 'unknown'].includes(receipt.state))
  const appInput = { expectedRoot: root, appId: app.id, revision: app.revision }
  const loadHistory = (after: string | null): void => { void action.run(() => api.deliveries({ expectedRoot: root, appId: app.id, after, limit: 30 })).then(result => { if (result) { setReceipts(previous => after && previous ? { items: [...previous.items, ...result.items], next: result.next } : result); const original = result.items.find(item => item.commandId === sendCommand.current); if (original) setReceipt(original) } }) }
  const reconcile = (original: DingDelivery): void => { void action.run(() => api.reconcileDelivery({ expectedRoot: root, deliveryId: original.id })).then(result => { if (result) { if (result.commandId === sendCommand.current) setReceipt(result); setReceipts(previous => previous ? { ...previous, items: previous.items.map(item => item.id === result.id ? result : item) } : previous) } }) }
  return <DingTalkDialog open={open} busy={action.busy} title="个人私信通知" subtitle={app.name} onClose={() => { if (!action.busy) onClose() }} footer={<Button disabled={action.busy} onClick={onClose}>完成</Button>}>
    {!account && <p role="status" className="text-my-sm text-my-secondary">先完成个人账号绑定，才能启用和发送私信通知。</p>}
    <DingTalkRow title="个人通知" detail={notification?.state === 'degraded' ? '配置需要处理' : notification?.state === 'needs-account' ? '需要绑定个人账号' : notification?.enabled ? '已启用' : '未启用'}><Button size="sm" disabled={action.busy || !account || app.state !== 'credentials-verified'} onClick={() => void action.run(() => api.setNotifications({ ...appInput, expectedRevision: notification?.revision ?? 0, enabled: !notification?.enabled })).then(result => { if (result) refresh() })}>{notification?.enabled ? '停用' : '启用'}</Button></DingTalkRow>
    {notification && <DingTalkDetails label="通知配置详情"><p>{notification.detail}</p></DingTalkDetails>}
    <label className="block space-y-1.5"><span className="my-item-title">标题</span><input className="my-input w-full" maxLength={120} disabled={action.busy || unresolved} value={title} onChange={event => { setTitle(event.target.value); setPreview(null) }} /></label>
    <label className="block space-y-1.5"><span className="my-item-title">通知内容</span><textarea className="my-input min-h-20 w-full" rows={4} maxLength={4000} disabled={action.busy || unresolved} value={body} onChange={event => { setBody(event.target.value); setPreview(null) }} /></label>
    <Button size="sm" disabled={action.busy || unresolved || !notification?.enabled || !account || !title.trim() || !body.trim()} onClick={() => { if (!account) return; void action.run(() => api.previewNotification({ ...appInput, accountId: account.id, title, body })).then(result => { if (result) { setPreview(result); setPreviewOwner(() => action.current); setReceipt(null); setAttempted(false); sendCommand.current = crypto.randomUUID() } }) }}>预览私信</Button>
    {preview && <div className="space-y-3 rounded-my-md border border-my-line p-3"><p className="text-my-xs text-my-secondary">收件人：{previewAccount?.displayName || previewAccount?.staffId || '原身份已变更，请重新预览'}</p><p className="text-my-sm font-medium">{preview.title}</p><p className="whitespace-pre-wrap break-words text-my-sm">{preview.body}</p><p className="text-my-xs text-my-tertiary">预览有效期至 {new Date(preview.expiresAt).toLocaleTimeString()}</p><Button variant="primary" size="sm" disabled={action.busy || attempted || !notification?.enabled || !previewIdentityCurrent || Date.now() >= preview.expiresAt} onClick={() => { const commandId = sendCommand.current; if (!commandId) return; setAttempted(true); void action.run(() => api.sendNotification({ expectedRoot: root, commandId, preview })).then(result => { if (result) setReceipt(result) }) }}>确认发送这条私信</Button></div>}
    {(attempted || receipt) && <div role="status" className="space-y-2"><p className="text-my-sm">{receipt ? deliveryStates[receipt.state] : '发送结果待核实'}</p>{unresolved && <p className="text-my-xs text-my-warning-text">需要核实原发送记录；不会自动重发。</p>}{receipt && <><Button size="sm" disabled={action.busy} onClick={() => reconcile(receipt)}>核实原回执</Button><DingTalkDetails label="投递详情"><p>{receipt.detail}</p><p className="break-all">{receipt.commandId}</p></DingTalkDetails></>}</div>}
    <div className="space-y-3 border-t border-my-line pt-4"><div className="flex items-center justify-between gap-2"><h3 className="text-my-sm font-medium">发送历史</h3><Button size="sm" disabled={action.busy} onClick={() => loadHistory(null)}>读取记录</Button></div>{receipts && <>{receipts.items.length === 0 && <p className="text-my-xs text-my-tertiary">暂无私信发送记录。</p>}{receipts.items.map(item => <div key={item.id} className="space-y-2 border-t border-my-line pt-3"><DingTalkRow title={deliveryStates[item.state]} detail={new Date(item.createdAt).toLocaleString()}><Button size="sm" disabled={action.busy} onClick={() => reconcile(item)}>核实原回执</Button></DingTalkRow><DingTalkDetails label="结果详情"><p>{item.detail}</p><p className="break-all">{item.commandId}</p></DingTalkDetails></div>)}{receipts.next && <Button size="sm" disabled={action.busy} onClick={() => loadHistory(receipts.next)}>更多记录</Button>}</>}</div>
    {action.error && <p role="alert" className="text-my-sm text-my-danger-text">{action.error}</p>}
  </DingTalkDialog>
}

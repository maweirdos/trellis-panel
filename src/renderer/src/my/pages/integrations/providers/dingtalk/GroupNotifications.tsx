import { useEffect, useState, type JSX } from 'react'
import type { DeliveryReceipt, NotificationPreview } from '@shared/integrations'
import { api } from '../../../../../api'
import { useApp } from '../../../../../store'
import { Select } from '../../../../../components/Select'
import { Button } from '../../../../ui'
import { projectRootKey } from '../../../../navigation'
import { confirmDialog } from '../../../../../components/Dialogs'
import { useInteractionSignal } from '../../../../../utils/interaction-scope'
import type { ProviderWorkspaceProps } from '../../provider-workspace'
import { useIntegrationAction, useIntegrationOwner, useIntegrationSnapshot } from '../../hooks'
import { boundRequest } from '../../RepositoryBrowser'
import { DingTalkDetails, DingTalkDialog, DingTalkRow } from './presentation'

/** A group webhook is an outgoing destination, never an organization assistant. */
export function GroupNotifications(props: ProviderWorkspaceProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const scope = useIntegrationOwner('ding-group-dialog')
  const connections = props.connections.filter(item => item.providerId === 'dingtalk')
  useEffect(() => { setOpen(false) }, [scope.current])
  return <>
    <DingTalkRow title="群机器人通知" detail={props.connection ? `${props.connection.name} · 手动发送工作项摘要` : '向钉钉群手动发送工作项摘要'}>
      {connections.length > 1 && props.onSelectConnection && <Select ariaLabel="选择钉钉群机器人" size="sm" value={props.connection?.id ?? ''} options={connections.map(item => ({ value: item.id, label: `${item.name}${item.enabled ? '' : ' · 已停用'}` }))} onChange={id => {
        if (!scope.current() || id === props.connection?.id || !connections.some(item => item.id === id)) return
        setOpen(false)
        props.onSelectConnection?.(id)
      }} />}
      <Button size="sm" onClick={() => setOpen(true)}>{props.connection ? '管理通知' : '配置机器人'}</Button>
    </DingTalkRow>
    <GroupNotificationDialog key={`${props.root}:${props.connection?.id}:${props.connection?.revision}`} {...props} open={open} onClose={() => setOpen(false)} />
  </>
}

function GroupNotificationDialog({ open, onClose, ...props }: ProviderWorkspaceProps & { open: boolean; onClose(): void }): JSX.Element {
  const { root, connection, nativeAvailable } = props
  const snapshot = useApp(state => state.snapshot)
  const saved = useIntegrationSnapshot()
  const signal = useInteractionSignal()
  const [task, setTask] = useState(''), [bindingId, setBindingId] = useState('')
  const [preview, setPreview] = useState<NotificationPreview | null>(null)
  const [previewOwner, setPreviewOwner] = useState<(() => boolean) | null>(null)
  const [receipt, setReceipt] = useState<DeliveryReceipt | null>(null)
  const [requestId, setRequestId] = useState(''), [attempted, setAttempted] = useState(false)
  const [inspection, setInspection] = useState('')
  const bindings = props.bindings.filter(item => item.connectionId === connection?.id && projectRootKey(item.root) === projectRootKey(root))
  const binding = bindings.find(item => item.id === bindingId) ?? bindings[0]
  const ownerKey = `ding-group:${root}:${connection?.id}:${connection?.revision}:${binding?.id}:${binding?.revision}:${task}`
  const action = useIntegrationAction(ownerKey)
  const currentPreview = previewOwner === action.current && action.current() ? preview : null
  const context = root && binding && connection ? { ...boundRequest(root, binding, connection), taskDir: task } : null
  const receipts = saved.data?.receipts.filter(item => item.connectionId === connection?.id) ?? []
  const edit = (): void => { onClose(); props.onEditConnection() }
  const bind = (): void => { onClose(); props.onBindProject(binding) }
  const resetPreview = (): void => { setPreview(null); setRequestId('') }
  const readOriginal = async (): Promise<void> => {
    await saved.refresh()
    // The receipt store remains authoritative; no resubmission is performed.
  }
  const original = receipts.find(item => item.requestId === requestId)
  const visibleReceipt = original ?? receipt
  const unresolved = attempted && (!visibleReceipt || visibleReceipt.state === 'pending' || visibleReceipt.state === 'uncertain')
  return <DingTalkDialog open={open} busy={action.busy} title="群机器人通知" subtitle="手动发送 · 不接收任务消息" onClose={() => { if (!action.busy) onClose() }} footer={<Button disabled={action.busy} onClick={onClose}>完成</Button>}>
    {!nativeAvailable ? <p role="status" className="text-my-sm text-my-secondary">当前环境暂不可配置群机器人，请在桌面应用中打开此页面。</p> : !connection ? <div className="space-y-3"><p className="text-my-sm text-my-secondary">添加群机器人的 Webhook，绑定当前项目后即可预览通知。</p><Button variant="primary" onClick={() => { onClose(); props.onConnect() }}>添加群机器人</Button></div> : <>
      <DingTalkRow title={connection.name} detail={`${connection.enabled ? '已启用' : '已停用'} · ${connection.check === 'configured' ? '配置已检查' : connection.check === 'failed' ? '检查失败' : '尚未检查'}`}>
        <Button size="sm" disabled={action.busy} onClick={edit}>编辑机器人</Button>
        <Button size="sm" disabled={action.busy} onClick={() => void action.run(() => api.integrations.inspect({ connectionId: connection.id, connectionRevision: connection.revision })).then(result => { if (result) { setInspection(result.detail); void props.refresh() } })}>检查配置</Button>
      </DingTalkRow>
      {inspection && <p role="status" className="text-my-xs text-my-secondary">{inspection}</p>}
      {!root ? <p className="text-my-sm text-my-secondary">打开项目后，可绑定通知目的地。</p> : <>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-my-line pt-4"><p className="my-item-title">当前项目目的地</p><div className="flex flex-wrap gap-2">{binding && <Button size="sm" disabled={action.busy || !connection.enabled} onClick={() => { onClose(); props.onBindProject() }}>添加绑定</Button>}<Button size="sm" disabled={action.busy || !connection.enabled} onClick={bind}>{binding ? '编辑绑定' : '绑定当前项目'}</Button></div></div>
        {binding && <>
          <Select ariaLabel="钉钉群通知目的地" className="w-full" value={binding.id} disabled={action.busy || unresolved} options={bindings.map(item => ({ value: item.id, label: `${item.label}${item.enabled ? '' : ' · 已停用'}` }))} onChange={value => { setBindingId(value); resetPreview() }} />
          <Select ariaLabel="选择群通知工作项" className="w-full" value={task} disabled={action.busy || unresolved} onChange={value => { setTask(value); resetPreview() }} options={[{ value: '', label: '选择工作项' }, ...[...(snapshot?.tasks ?? []), ...(snapshot?.archived ?? [])].filter(item => item.record).map(item => ({ value: item.path, label: `${item.archived ? '已归档 · ' : ''}${item.record?.title || item.dirName}` }))]} />
          <Button size="sm" disabled={action.busy || unresolved || !task || !binding.enabled || !connection.enabled} onClick={() => { if (!context) return; void action.run(() => api.integrations.previewNotification(context)).then(result => { if (result) { setPreview(result); setPreviewOwner(() => action.current); setReceipt(null); setAttempted(false); setRequestId(crypto.randomUUID()) } }) }}>预览通知</Button>
        </>}
        {currentPreview && <div className="space-y-3 rounded-my-md border border-my-line p-3">
          <p className="text-my-xs text-my-secondary">发送到：{currentPreview.destination}</p><p className="text-my-sm font-medium">{currentPreview.title}</p><p className="whitespace-pre-wrap break-words text-my-sm text-my-secondary">{currentPreview.body}</p>
          <Button variant="primary" size="sm" disabled={action.busy || attempted || !binding?.enabled || !connection.enabled} onClick={() => { if (!context || !requestId) return; setAttempted(true); void action.run(() => api.integrations.sendNotification({ ...context, requestId, preview: currentPreview })).then(result => { if (result) { setReceipt(result); void saved.refresh() } }) }}>确认发送到这个群</Button>
        </div>}
      </>}
      {(visibleReceipt || attempted) && <div role="status" className="space-y-2 text-my-sm"><p>{visibleReceipt ? ({ pending: '等待发送结果', delivered: '已送达', failed: '发送失败', uncertain: '结果待核实' })[visibleReceipt.state] : '发送结果待核实'}</p>{(visibleReceipt?.state === 'uncertain' || !visibleReceipt) && <p className="text-my-xs text-my-warning-text">请核实目标群后再决定后续操作；不会自动重发。</p>}<Button size="sm" disabled={action.busy || saved.loading} onClick={() => void readOriginal()}>读取原发送记录</Button>{visibleReceipt && <DingTalkDetails label="发送详情"><p>{visibleReceipt.detail}</p><p className="break-all">{visibleReceipt.requestId}</p></DingTalkDetails>}</div>}
      <DingTalkDetails label="发送历史">
        <Button size="sm" disabled={saved.loading} onClick={() => void saved.refresh()}>刷新记录</Button>
        {saved.error ? <p role="alert">{saved.error}</p> : !saved.data ? <p role="status">正在读取…</p> : receipts.length === 0 ? <p>暂无群通知记录。</p> : receipts.map(item => <div key={item.requestId} className="space-y-1 border-t border-my-line pt-2"><p>{item.destination} · {({ pending: '等待发送结果', delivered: '已送达', failed: '发送失败', uncertain: '结果待核实' })[item.state]}</p><p>{new Date(item.createdAt).toLocaleString()}</p><p>{item.detail}</p></div>)}
      </DingTalkDetails>
      <DingTalkDetails label="机器人管理">
        <p>{connection.detail}</p>
        <div className="flex flex-wrap gap-2"><Button size="sm" disabled={action.busy} onClick={() => { onClose(); props.onConnect() }}>添加另一个群机器人</Button>{!connection.legacy && <Button size="sm" disabled={action.busy} onClick={() => void (async () => {
          const confirmed = await confirmDialog({ title: `移除「${connection.name}」？`, message: '将移除本机群机器人连接，已保存的任务来源和发送回执会保留。', confirmText: '移除连接', danger: true }, signal)
          if (!confirmed || !action.current()) return
          const result = await action.run(() => api.integrations.removeConnection({ connectionId: connection.id, connectionRevision: connection.revision }))
          if (result !== undefined) { onClose(); await props.refresh() }
        })()}>移除机器人</Button>}</div>
      </DingTalkDetails>
    </>}
    {action.error && <p role="alert" className="text-my-sm text-my-danger-text">{action.error}</p>}
  </DingTalkDialog>
}

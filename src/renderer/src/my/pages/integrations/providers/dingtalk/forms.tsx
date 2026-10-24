import { useRef, useState, type JSX } from 'react'
import type { DingApp, DingAssistant, DingPolicy, DingTalkApi } from '@shared/dingtalk-integration'
import { Button, Checkbox } from '../../../../ui'
import { Select } from '../../../../../components/Select'
import { useIntegrationAction } from '../../hooks'
import { api as desktopApi } from '../../../../../api'
import { DingTalkDetails, DingTalkDialog } from './presentation'

function Field({ label, value, onChange, secret = false, required = true, maxLength = 256 }: { label: string; value: string; onChange(value: string): void; secret?: boolean; required?: boolean; maxLength?: number }): JSX.Element {
  return <label className="block space-y-1.5 text-my-sm"><span>{label}</span><input className="my-input w-full" type={secret ? 'password' : 'text'} value={value} maxLength={maxLength} autoComplete={secret ? 'new-password' : 'off'} onInvalid={event => event.currentTarget.closest('details')?.setAttribute('open', '')} onChange={event => onChange(event.target.value)} required={required} /></label>
}

export function DingTalkAppForm({ api, root, initial, onClose, onSaved }: { api: DingTalkApi; root: string | null; initial: DingApp | null; onClose(): void; onSaved(): void }): JSX.Element {
  const action = useIntegrationAction(`ding-app:${initial?.id ?? 'new'}:${initial?.revision ?? 0}`)
  const form = useRef<HTMLFormElement>(null)
  const [name, setName] = useState(initial?.name ?? '钉钉组织应用')
  const [key, setKey] = useState(initial?.appKey ?? ''), [corp, setCorp] = useState(initial?.corpId ?? '')
  const [robot, setRobot] = useState(initial?.robotCode ?? ''), [secret, setSecret] = useState('')
  const [secretMode, setSecretMode] = useState<'keep' | 'replace' | 'clear'>(initial?.hasSecret ? 'keep' : 'replace')
  const close = (): void => { if (!action.busy) onClose() }
  return <DingTalkDialog busy={action.busy} title={initial ? '编辑组织应用' : '绑定组织应用'} subtitle="企业内部应用" onClose={close} footer={<><Button disabled={action.busy} onClick={close}>取消</Button><Button variant="primary" disabled={action.busy} onClick={() => form.current?.requestSubmit()}>{action.busy ? '保存中…' : '保存应用'}</Button></>}>
    <form ref={form} onSubmit={event => {
      event.preventDefault()
      void action.run(() => api.saveApp({ expectedRoot: root, id: initial?.id ?? null, revision: initial?.revision ?? 0, name, appKey: key, corpId: corp, robotCode: robot, secret: secretMode === 'replace' ? { op: 'replace', value: secret } : { op: secretMode } })).then(result => { if (result) { setSecret(''); onSaved() } })
    }}>
      <fieldset disabled={action.busy} className="space-y-4">
        <Field label="AppKey / Client ID" value={key} onChange={setKey} />
        {initial?.hasSecret && <div className="space-y-1.5"><p className="text-my-sm">AppSecret</p><Select ariaLabel="AppSecret 操作" value={secretMode} options={[{ value: 'keep', label: '保留已保存的密钥' }, { value: 'replace', label: '替换密钥' }, { value: 'clear', label: '清除密钥' }]} onChange={value => { setSecretMode(value as typeof secretMode); setSecret('') }} /></div>}
        {secretMode === 'replace' && <Field label={initial?.hasSecret ? '新 AppSecret' : 'AppSecret'} value={secret} onChange={setSecret} secret maxLength={4096} />}
        {secretMode === 'clear' && <p className="text-my-sm text-my-warning-text">清除后需要重新填写并验证凭据，助手接入也需重新启用。</p>}
        <div className="grid gap-4 sm:grid-cols-2"><Field label="企业 CorpId" value={corp} onChange={setCorp} /><Field label="机器人 RobotCode" value={robot} onChange={setRobot} /></div>
        <DingTalkDetails label="应用名称与配置帮助">
          <Field label="应用名称" value={name} onChange={setName} maxLength={120} />
          <p>在钉钉开发平台创建企业内部应用、添加机器人并发布后，填写以上信息。保存后可验证应用；保存和验证不会发送消息。</p>
          <Button size="sm" onClick={() => void desktopApi.openExternal('https://open-dev.dingtalk.com/')}>打开钉钉开发平台</Button>
        </DingTalkDetails>
        {initial && <p className="text-my-xs text-my-secondary">修改应用配置后，需要重新验证应用并启用助手。</p>}
        {action.error && <p role="alert" className="text-my-sm text-my-danger-text">{action.error}</p>}
      </fieldset>
      <button type="submit" hidden disabled={action.busy} />
    </form>
  </DingTalkDialog>
}

const lines = (value: string): string[] => [...new Set(value.split(/\r?\n/).map(item => item.trim()).filter(Boolean))]
export function DingTalkAssistantForm({ api, root, apps, initial, executionAvailable, onClose, onSaved }: { api: DingTalkApi; root: string; apps: readonly DingApp[]; initial: DingAssistant | null; executionAvailable: boolean; onClose(): void; onSaved(): void }): JSX.Element {
  const action = useIntegrationAction(`ding-assistant:${initial?.id ?? 'new'}:${initial?.revision ?? 0}`)
  const form = useRef<HTMLFormElement>(null)
  const [name, setName] = useState(initial?.name ?? '项目任务助手'), [appId, setAppId] = useState(initial?.appId ?? apps[0]?.id ?? '')
  const [senders, setSenders] = useState(initial?.policy.allowedSenders.join('\n') ?? ''), [groups, setGroups] = useState(initial?.policy.allowedGroups.join('\n') ?? '')
  const [policy, setPolicy] = useState<DingPolicy>(initial?.policy ?? { allowedSenders: [], allowedGroups: [], allowDirect: false, execution: 'tasks-only', runtimeId: 'none', profileId: 'none', maxTurnMinutes: 30, allowTaskUpdates: false, replyEnabled: false })
  const app = apps.find(item => item.id === appId)
  const close = (): void => { if (!action.busy) onClose() }
  const check = (label: string, field: 'allowDirect' | 'allowTaskUpdates' | 'replyEnabled'): JSX.Element => <label className="flex items-start gap-2 text-my-sm"><Checkbox checked={policy[field]} onChange={value => setPolicy({ ...policy, [field]: value })} /><span>{label}</span></label>
  return <DingTalkDialog busy={action.busy} title={initial ? '编辑任务助手' : '新建任务助手'} subtitle="绑定当前项目" onClose={close} footer={<><Button disabled={action.busy} onClick={close}>取消</Button><Button variant="primary" disabled={action.busy || !app || !senders.trim() || (!executionAvailable && policy.execution !== 'tasks-only')} onClick={() => form.current?.requestSubmit()}>{action.busy ? '保存中…' : '保存助手'}</Button></>}>
    <form ref={form} onSubmit={event => {
      event.preventDefault()
      if (!app) return
      void action.run(() => api.saveAssistant({ expectedRoot: root, id: initial?.id ?? null, revision: initial?.revision ?? 0, appId: app.id, appRevision: app.revision, name, policy: { ...policy, allowedSenders: lines(senders), allowedGroups: lines(groups) } })).then(result => { if (result) onSaved() })
    }}>
      <fieldset disabled={action.busy} className="space-y-4">
        <Field label="助手名称" value={name} onChange={setName} maxLength={120} />
        <div className="space-y-1.5"><p className="text-my-sm">组织应用</p><Select ariaLabel="助手应用" value={appId} options={apps.map(item => ({ value: item.id, label: item.name }))} onChange={setAppId} /></div>
        {!app && <p role="status" className="text-my-sm text-my-secondary">先验证此助手的组织应用，再保存配置。</p>}
        <label className="block space-y-1.5 text-my-sm"><span>允许的成员 StaffId · 每行一个</span><textarea className="my-input min-h-20 w-full" required rows={3} value={senders} onChange={event => setSenders(event.target.value)} /></label>
        <label className="block space-y-1.5 text-my-sm"><span>允许的群 ConversationId · 每行一个</span><textarea className="my-input w-full" rows={2} value={groups} onChange={event => setGroups(event.target.value)} /></label>
        {check('允许名单内成员通过单聊使用', 'allowDirect')}
        <div className="space-y-2"><p className="text-my-sm font-medium">执行方式</p><Select ariaLabel="Agent 执行策略" value={policy.execution} options={[{ value: 'tasks-only', label: '仅创建任务' }, { value: 'manual', label: '本机确认后执行', disabled: !executionAvailable }, { value: 'native-approvals', label: '接入 Agent，保留原生审批', disabled: !executionAvailable }]} onChange={execution => setPolicy({ ...policy, execution: execution as DingPolicy['execution'] })} /></div>
        {policy.execution !== 'tasks-only' && <div className="space-y-3 rounded-my-md bg-my-layer-2 p-3">
          <Field label="已配置的 Runtime ID" value={policy.runtimeId} onChange={runtimeId => setPolicy({ ...policy, runtimeId })} />
          <Field label="已配置的 Profile ID" value={policy.profileId} onChange={profileId => setPolicy({ ...policy, profileId })} />
          <p className="text-my-xs text-my-secondary">{policy.execution === 'manual' ? '接收消息后等待本机确认，才会启动 Agent。' : '允许消息接入已配置的 Agent，工具权限仍需按原生选项审批。'}消息不能改变模型、目录或权限；关闭界面不会自动批准。</p>
          {!executionAvailable && <p role="status" className="text-my-xs text-my-warning-text">当前环境暂不可执行 Agent；可改为仅创建任务后保存。</p>}
        </div>}
        <div className="space-y-3 border-t border-my-line pt-4">{check('允许修改已关联任务的标题与优先级', 'allowTaskUpdates')}{check('处理后回复原钉钉会话（会实际发送消息）', 'replyEnabled')}</div>
        <DingTalkDetails label="处理期限与项目详情">
          <label className="block space-y-1.5 text-my-sm"><span>处理期限 · 分钟</span><input className="my-input w-full" type="number" required min={1} max={120} value={policy.maxTurnMinutes} onInvalid={event => event.currentTarget.closest('details')?.setAttribute('open', '')} onChange={event => setPolicy({ ...policy, maxTurnMinutes: Number(event.target.value) })} /></label>
          <p>当前项目：{root}</p>
        </DingTalkDetails>
        <p className="text-my-xs text-my-secondary">保存助手后，在列表中启用接收。</p>
        {action.error && <p role="alert" className="text-my-sm text-my-danger-text">{action.error}</p>}
      </fieldset>
      <button type="submit" hidden disabled={action.busy} />
    </form>
  </DingTalkDialog>
}

import { useState, type JSX } from 'react'
import type { DingApp, DingAssistant, DingPolicy, DingTalkApi } from '@shared/dingtalk-integration'
import { Button, Modal } from '../../../../ui'
import { Select } from '../../../../../components/Select'
import { useIntegrationAction } from '../../hooks'

function Field({ label, value, onChange, secret = false }: { label: string; value: string; onChange(value: string): void; secret?: boolean }): JSX.Element {
  return <label className="block space-y-1 text-my-sm"><span>{label}</span><input className="my-input w-full" type={secret ? 'password' : 'text'} value={value} autoComplete={secret ? 'new-password' : 'off'} onChange={event => onChange(event.target.value)} required /></label>
}
export function DingTalkAppForm({ api, root, initial, onClose, onSaved }: { api: DingTalkApi; root: string | null; initial: DingApp | null; onClose(): void; onSaved(): void }): JSX.Element {
  const action = useIntegrationAction(`ding-app:${initial?.id ?? 'new'}:${initial?.revision ?? 0}`)
  const [name, setName] = useState(initial?.name ?? ''), [key, setKey] = useState(initial?.appKey ?? ''), [corp, setCorp] = useState(initial?.corpId ?? ''), [robot, setRobot] = useState(initial?.robotCode ?? ''), [secret, setSecret] = useState('')
  return <Modal open ariaLabel={initial ? '编辑钉钉组织应用' : '添加钉钉组织应用'} onClose={() => { if (!action.busy) onClose() }}><form className="space-y-4 p-5" onSubmit={event => { event.preventDefault(); void action.run(() => api.saveApp({ expectedRoot: root, id: initial?.id ?? null, revision: initial?.revision ?? 0, name, appKey: key, corpId: corp, robotCode: robot, secret: secret ? { op: 'replace', value: secret } : { op: 'keep' } })).then(result => { if (result) { setSecret(''); onSaved() } }) }}>
    <h2 className="font-semibold">钉钉组织应用</h2><p className="text-my-sm text-my-secondary">在钉钉开发平台创建企业内部应用并发布机器人。AppSecret 由系统凭据保护；保存不会发送消息。更换凭据后需重新验证并启用助手。</p>
    <Field label="应用名称" value={name} onChange={setName} /><Field label="AppKey / Client ID" value={key} onChange={setKey} /><Field label="组织 CorpId" value={corp} onChange={setCorp} /><Field label="机器人 RobotCode" value={robot} onChange={setRobot} />
    <label className="block space-y-1 text-my-sm"><span>{initial?.hasSecret ? '替换 AppSecret（留空保留）' : 'AppSecret'}</span><input className="my-input w-full" type="password" autoComplete="new-password" value={secret} required={!initial?.hasSecret} onChange={event => setSecret(event.target.value)} /></label>
    {action.error && <p role="alert" className="text-my-sm text-my-danger-text">{action.error}</p>}<div className="flex gap-2"><Button variant="primary" disabled={action.busy} onClick={event => event.currentTarget.form?.requestSubmit()}>保存受保护配置</Button><Button disabled={action.busy} onClick={onClose}>取消</Button></div>
  </form></Modal>
}
const lines = (value: string): string[] => [...new Set(value.split(/\r?\n/).map(item => item.trim()).filter(Boolean))]
export function DingTalkAssistantForm({ api, root, apps, initial, executionAvailable, onClose, onSaved }: { api: DingTalkApi; root: string; apps: readonly DingApp[]; initial: DingAssistant | null; executionAvailable: boolean; onClose(): void; onSaved(): void }): JSX.Element {
  const action = useIntegrationAction(`ding-assistant:${initial?.id ?? 'new'}:${initial?.revision ?? 0}`)
  const [name, setName] = useState(initial?.name ?? ''), [appId, setAppId] = useState(initial?.appId ?? apps[0]?.id ?? '')
  const [senders, setSenders] = useState(initial?.policy.allowedSenders.join('\n') ?? ''), [groups, setGroups] = useState(initial?.policy.allowedGroups.join('\n') ?? '')
  const [policy, setPolicy] = useState<DingPolicy>(initial?.policy ?? { allowedSenders: [], allowedGroups: [], allowDirect: false, execution: 'tasks-only', runtimeId: 'none', profileId: 'none', maxTurnMinutes: 30, allowTaskUpdates: false, replyEnabled: false })
  const app = apps.find(item => item.id === appId)
  const check = (label: string, field: 'allowDirect' | 'allowTaskUpdates' | 'replyEnabled'): JSX.Element => <label className="flex items-start gap-2 text-my-sm"><input type="checkbox" checked={policy[field]} onChange={event => setPolicy({ ...policy, [field]: event.target.checked })} />{label}</label>
  return <Modal open ariaLabel="配置工作区任务助手" onClose={() => { if (!action.busy) onClose() }}><form className="space-y-4 p-5" onSubmit={event => { event.preventDefault(); if (!app) return; void action.run(() => api.saveAssistant({ expectedRoot: root, id: initial?.id ?? null, revision: initial?.revision ?? 0, appId: app.id, appRevision: app.revision, name, policy: { ...policy, allowedSenders: lines(senders), allowedGroups: lines(groups) } })).then(result => { if (result) onSaved() }) }}>
    <h2 className="font-semibold">工作区任务助手</h2><p className="break-words text-my-xs text-my-tertiary">当前本机工作区：{root}</p><Field label="助手名称" value={name} onChange={setName} />
    <Select ariaLabel="助手应用" value={appId} options={apps.map(item => ({ value: item.id, label: item.name }))} onChange={setAppId} />
    <label className="block space-y-1 text-my-sm"><span>允许的钉钉成员 StaffId（每行一个）</span><textarea className="my-input w-full" required value={senders} onChange={event => setSenders(event.target.value)} /></label>
    <label className="block space-y-1 text-my-sm"><span>允许的群 ConversationId（每行一个）</span><textarea className="my-input w-full" value={groups} onChange={event => setGroups(event.target.value)} /></label>{check('允许名单中的成员通过单聊使用', 'allowDirect')}{check('允许修改已关联任务的标题与优先级', 'allowTaskUpdates')}{check('处理后回复原钉钉会话（会实际发送消息）', 'replyEnabled')}
    <Select ariaLabel="Agent 执行策略" value={policy.execution} options={[{ value: 'tasks-only', label: '仅创建任务' }, ...(executionAvailable ? [{ value: 'manual', label: '本机确认后接入 Agent' }, { value: 'native-approvals', label: '接入 Agent 并保留原生审批' }] : [])]} onChange={execution => setPolicy({ ...policy, execution: execution as DingPolicy['execution'] })} />
    {policy.execution !== 'tasks-only' && <><Field label="已配置的 Runtime ID" value={policy.runtimeId} onChange={runtimeId => setPolicy({ ...policy, runtimeId })} /><Field label="已配置的 Profile ID" value={policy.profileId} onChange={profileId => setPolicy({ ...policy, profileId })} /><p className="text-my-xs text-my-tertiary">保存时由本机验证这两个配置。消息内容不能更换模型、运行目录、执行权限或审批选项。界面关闭也不会自动批准。</p></>}
    <label className="block space-y-1 text-my-sm"><span>消息处理与 Agent 接入期限（分钟，1–120）</span><input className="my-input w-full" type="number" min={1} max={120} value={policy.maxTurnMinutes} onChange={event => setPolicy({ ...policy, maxTurnMinutes: Number(event.target.value) })} /></label>
    {action.error && <p role="alert" className="text-my-sm text-my-danger-text">{action.error}</p>}<div className="flex gap-2"><Button variant="primary" disabled={action.busy || !app || !senders.trim()} onClick={event => event.currentTarget.form?.requestSubmit()}>保存配置</Button><Button disabled={action.busy} onClick={onClose}>取消</Button></div>
  </form></Modal>
}

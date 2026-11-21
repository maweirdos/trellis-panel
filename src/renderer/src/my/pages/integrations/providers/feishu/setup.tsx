import { useId, useRef, useState, type FormEvent, type JSX, type ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'
import type { FeishuApi, FeishuConnection, FeishuInput, FeishuOutput } from '@shared/feishu-integration'
import { feishuRequests } from '@shared/feishu-integration'
import { api as desktop } from '../../../../../api'
import { Select } from '../../../../../components/Select'
import { Button, Switch } from '../../../../ui'
import { useIntegrationAction } from '../../hooks'
import { FeishuDialog, FeishuError } from './presentation'

export interface FeishuModel {
  value: string
  label: string
  providerId: string
  modelId: string
}

export function modelChoice(providerId: string, modelId: string): string {
  return JSON.stringify([providerId, modelId])
}

function ModelField({ models, value, onChange, disabled, openModels }: {
  models: readonly FeishuModel[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  openModels: () => void
}): JSX.Element {
  const missing = !models.some((model) => model.value === value)
  return <div className="space-y-1">
    <p className="my-item-title">模型</p>
    {models.length ? <Select className="w-full" ariaLabel="模型" value={value} onChange={onChange} disabled={disabled}
      options={missing ? [{ value, label: value ? '原模型不可用' : '选择模型', disabled: true }, ...models] : [...models]} />
      : <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="my-item-description">暂无启用的模型</p>
        <Button size="sm" disabled={disabled} onClick={openModels}>配置模型</Button>
      </div>}
  </div>
}

export function OrganizationSetup({ api, available, onClose, onSaved, children }: {
  api: FeishuApi
  available: boolean
  onClose: () => void
  onSaved: () => void
  children: ReactNode
}): JSX.Element {
  const form = useId()
  const secret = useRef<HTMLInputElement>(null)
  const [appId, setAppId] = useState('')
  const [hasSecret, setHasSecret] = useState(false)
  const [openError, setOpenError] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const action = useIntegrationAction('feishu-organization-setup')
  const appIdValid = feishuRequests.connectOrganization.shape.appId.safeParse(appId.trim()).success
  const appIdError = Boolean(appId.trim()) && !appIdValid
  const close = (): void => { if (!action.busy) onClose() }
  const save = (event: FormEvent): void => {
    event.preventDefault()
    if (action.busy || uncertain || !available || !action.current()) return
    const credentials = feishuRequests.connectOrganization.safeParse({
      expectedRoot: null, appId: appId.trim(), appSecret: secret.current?.value.trim()
    })
    if (!credentials.success) return
    void action.run(async () => {
      const result = await api.connectOrganization(credentials.data)
      if (action.current() && !result.ok && (result.code === 'E_UNKNOWN' || result.code === 'E_TIMEOUT')) {
        setUncertain(true)
      }
      return result
    }).then((result) => {
      if (!result || !action.current()) return
      if (secret.current) secret.current.value = ''
      onSaved()
      onClose()
    })
  }
  return <FeishuDialog title="绑定飞书应用" onClose={close} footer={<>
    <Button onClick={close} disabled={action.busy}>取消</Button>
    <Button type="submit" form={form} variant="primary" disabled={action.busy || uncertain || !available || !appIdValid || !hasSecret}>
      {action.busy ? '正在验证…' : '验证并连接'}
    </Button>
  </>}>
    <form id={form} onSubmit={save} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="my-item-title">企业自建应用</p>
        <Button size="sm" variant="ghost" onClick={() => {
          setOpenError('')
          void desktop.openExternal('https://open.feishu.cn/app').catch(() => {
            if (action.current()) setOpenError('无法打开系统浏览器。请在浏览器访问 open.feishu.cn/app。')
          })
        }}>飞书开放平台<ExternalLink size={14} aria-hidden="true" /></Button>
      </div>
      <ol className="my-item-description list-decimal space-y-1 pl-4">
        <li>创建企业自建应用，添加机器人能力。</li>
        <li>在下方填写凭据，验证并连接。</li>
        <li>返回飞书的「事件与回调」，使用长连接订阅「接收消息」。</li>
        <li>发布应用版本，按飞书提示完成审批。</li>
      </ol>
      <FeishuError title="无法打开飞书开放平台" message={openError} />
      <label className="block space-y-1">
        <span className="my-item-title">App ID</span>
        <input className="my-input w-full" autoComplete="off" spellCheck={false} required maxLength={104}
          aria-invalid={appIdError || undefined} aria-describedby={appIdError ? `${form}-app-id-error` : undefined}
          value={appId} disabled={action.busy} onChange={(event) => setAppId(event.target.value)} />
        {appIdError && <span id={`${form}-app-id-error`} className="block text-my-xs text-my-danger-text">请从飞书开放平台的「凭证与基础信息」复制 App ID。</span>}
      </label>
      <label className="block space-y-1">
        <span className="my-item-title">App Secret</span>
        <input ref={secret} className="my-input w-full" type="password" autoComplete="off" required maxLength={512}
          disabled={action.busy} onChange={(event) => setHasSecret(Boolean(event.target.value.trim()))} />
      </label>
    </form>
    {children}
    <FeishuError title={uncertain ? '应用绑定结果待核对' : '连接组织应用失败'} message={action.error}
      actions={uncertain ? <Button size="sm" onClick={onSaved}>核对绑定状态</Button> : undefined} />
  </FeishuDialog>
}

export function ConnectionSetup({ api, root, connection, available, models, defaultModel, openModels, onClose, onSaved }: {
  api: FeishuApi
  root: string | null
  connection: FeishuConnection
  available: boolean
  models: readonly FeishuModel[]
  defaultModel?: FeishuModel
  openModels: () => void
  onClose: () => void
  onSaved: () => void
}): JSX.Element {
  const form = useId()
  const [groups, setGroups] = useState(() => connection.allowedChatIds.join('\n'))
  const [enabled, setEnabled] = useState(connection.enabled)
  const [model, setModel] = useState(() => connection.providerId && connection.modelId
    ? modelChoice(connection.providerId, connection.modelId) : defaultModel?.value ?? '')
  const action = useIntegrationAction(`feishu-configure:${root}:${connection.id}:${connection.revision}`)
  const modelFields = models.find((item) => item.value === model)
  const groupIds = [...new Set(groups.split(/[\s,，]+/).filter(Boolean))]
  const groupsValid = feishuRequests.configure.shape.allowedChatIds.safeParse(groupIds).success
  const assistant = connection.kind === 'assistant'
  const missingGroup = enabled && assistant && !groupIds.length
  const missingModel = enabled && assistant && !modelFields
  const valid = available && groupsValid && !missingGroup && !missingModel
  const close = (): void => { if (!action.busy) onClose() }
  const save = (event: FormEvent): void => {
    event.preventDefault()
    if (!valid || action.busy || !action.current()) return
    const input: FeishuInput<'configure'> = {
      expectedRoot: root, id: connection.id, revision: connection.revision, allowedChatIds: groupIds,
      selectedScopeKey: connection.scopeKey ?? undefined,
      enabled, ...(assistant && modelFields ? { providerId: modelFields.providerId, modelId: modelFields.modelId } : {})
    }
    void action.run(() => api.configure(input)).then((result) => {
      if (result && action.current()) { onSaved(); onClose() }
    })
  }
  return <FeishuDialog title={assistant ? '设置空间任务助手' : '设置 Agent 智能体'}
    subtitle={connection.name} onClose={close} footer={<>
      <Button onClick={close} disabled={action.busy}>取消</Button>
      <Button type="submit" form={form} variant="primary" disabled={!valid || action.busy}>{action.busy ? '保存中…' : '保存'}</Button>
    </>}>
    <form id={form} onSubmit={save} className="space-y-4">
      {assistant && <ModelField models={models} value={model} onChange={setModel} disabled={action.busy} openModels={openModels} />}
      <label className="block space-y-1">
        <span className="my-item-title">允许接入的群聊 ID{assistant ? '' : '（可选）'}</span>
        <textarea className="my-input min-h-20 w-full" rows={3} value={groups} disabled={action.busy}
          maxLength={6200} spellCheck={false} aria-invalid={!groupsValid || missingGroup}
          aria-describedby={`${form}-groups-help`} onChange={(event) => setGroups(event.target.value)} />
      </label>
      <p id={`${form}-groups-help`} className={groupsValid && !missingGroup ? 'my-item-description' : 'text-my-xs text-my-danger-text'}>
        {!groupsValid ? '请输入最多 50 个以 oc_ 开头的群聊 ID，每行一个。' :
          missingGroup ? '至少添加一个群聊才能启用接收。' : '每行一个群聊 ID。'}
      </p>
      <ChatPicker api={api} root={root} connection={connection} selected={groupIds} disabled={!available || action.busy || groupIds.length >= 50}
        onAdd={(id) => setGroups((current) => `${current.trim()}${current.trim() ? '\n' : ''}${id}`)} />
      <p className="my-item-description">首次使用时，成员在 Crux 网页的「飞书账号」获取绑定码，按提示私聊此机器人。
        {assistant ? '绑定后可在选定的群里 @ 助手处理任务。' : '绑定后可私聊 Agent，也可在选定的群里 @ Agent。'}</p>
      <div className="flex items-center justify-between gap-3">
        <span className="my-item-title">启用消息接收</span>
        <Switch checked={enabled} onChange={setEnabled} label="启用消息接收" disabled={action.busy} />
      </div>
    </form>
    <FeishuError title="保存飞书设置失败" message={action.error} />
  </FeishuDialog>
}

function ChatPicker({ api, root, connection, selected, disabled, onAdd }: {
  api: FeishuApi
  root: string | null
  connection: FeishuConnection
  selected: readonly string[]
  disabled: boolean
  onAdd: (id: string) => void
}): JSX.Element {
  const [chats, setChats] = useState<FeishuOutput<'chats'> | null>(null)
  const [query, setQuery] = useState('')
  const action = useIntegrationAction(`feishu-chats:${root}:${connection.id}:${connection.revision}`)
  const filter = query.trim().normalize('NFKC').toLocaleLowerCase()
  const matches = chats?.filter((chat) => !selected.includes(chat.id) &&
    chat.name.normalize('NFKC').toLocaleLowerCase().includes(filter)) ?? []
  const names = new Map<string, number>()
  for (const chat of chats ?? []) names.set(chat.name, (names.get(chat.name) ?? 0) + 1)
  const list = (): void => {
    if (disabled || !action.current()) return
    void action.run(() => api.chats({
      expectedRoot: root, id: connection.id, revision: connection.revision, selectedScopeKey: connection.scopeKey ?? undefined
    })).then((result) => {
      if (result && action.current()) setChats(result)
    })
  }
  return <div className="space-y-2">
    {chats === null ? <Button size="sm" disabled={disabled || action.busy} onClick={list}>
      {action.busy ? '读取中…' : '从群列表添加'}
    </Button> : <>
      {chats.length > 0 && <>
        <input type="search" className="my-input w-full" aria-label="搜索群聊" placeholder="按群名搜索"
          value={query} onChange={(event) => setQuery(event.target.value)} disabled={disabled || action.busy} />
        <Select className="w-full" ariaLabel="添加群聊" value="" placeholder="选择群聊添加"
          disabled={disabled || !matches.length || action.busy}
          options={matches.map((chat) => ({
            value: chat.id, label: (names.get(chat.name) ?? 0) > 1 ? `${chat.name} · ${chat.id.slice(-8)}` : chat.name
          }))}
          onChange={(id) => { if (!disabled && action.current() && matches.some((chat) => chat.id === id)) onAdd(id) }} />
      </>}
      {!matches.length && <p role="status" className="my-item-description">
        {chats.length ? '没有匹配的可添加群聊' : '机器人暂未加入可选群聊，可填写群聊 ID。'}
      </p>}
      <Button size="sm" variant="ghost" disabled={disabled || action.busy} onClick={list}>刷新群列表</Button>
    </>}
    {action.error && <FeishuError title="无法读取群列表，可填写群聊 ID" message={action.error} />}
  </div>
}

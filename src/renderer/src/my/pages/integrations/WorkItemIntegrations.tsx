import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { DeliveryReceipt, ExternalLink, NotificationPreview } from '../../../../../shared/integrations'
import { api, hasIpc } from '../../../api'
import { Button } from '../../ui'
import { Select } from '../../../components/Select'
import { boundRequest, PullRequestBrowser } from './RepositoryBrowser'
import { useIntegrationAction, useIntegrationOwner, useIntegrationSnapshot } from './hooks'
import { integrationBridgeState } from './bridge'

/** One reusable surface for task preview/workspace and the integration directory. */
export function WorkItemIntegrations({ taskDir }: { taskDir: string }): JSX.Element | null {
  const { root, data, error: snapshotError } = useIntegrationSnapshot()
  const [links, setLinks] = useState<ExternalLink[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [preview, setPreview] = useState<NotificationPreview | null>(null)
  const [receipt, setReceipt] = useState<DeliveryReceipt | null>(null)
  const [requestId, setRequestId] = useState('')
  const [linksError, setLinksError] = useState('')
  const { current } = useIntegrationOwner(taskDir)
  const sequence = useRef(0)
  const loadLinks = useCallback(async (): Promise<void> => {
    const token = ++sequence.current
    if (!root || !current() || integrationBridgeState() !== 'ready') return
    const result = await api.integrations.links({ expectedRoot: root, taskDir }).catch(() => null)
    if (token !== sequence.current || !current()) return
    if (result?.ok) { setLinks(result.data); setLinksError('') }
    else setLinksError(result && !result.ok ? result.error : '无法读取工作项关联')
  }, [root, taskDir, current])
  useEffect(() => { setLinks([]); void loadLinks(); return () => { sequence.current++ } }, [loadLinks])
  useEffect(() => {
    if (integrationBridgeState() !== 'ready') return
    return api.integrations.onChanged(() => { void loadLinks() })
  }, [loadLinks])
  const choices = data?.bindings.filter((binding) => binding.enabled && data.connections.some((c) => c.id === binding.connectionId && c.enabled && data.catalog.some((p) => p.id === c.providerId && (p.category === 'repositories' || p.category === 'messaging')))) ?? []
  const binding = choices.find((b) => b.id === selectedId) ?? choices[0]
  const connection = data?.connections.find((c) => c.id === binding?.connectionId)
  const provider = data?.catalog.find((p) => p.id === connection?.providerId)
  const action = useIntegrationAction(`${taskDir}:${binding?.id ?? ''}:${binding?.revision ?? 0}:${connection?.id ?? ''}:${connection?.revision ?? 0}`)
  useEffect(() => { setPreview(null); setReceipt(null); setRequestId('') }, [binding?.id, binding?.revision, connection?.revision, taskDir, root])
  if (!hasIpc || !root) return null
  const context = binding && connection ? { ...boundRequest(root, binding, connection), taskDir } : null
  return <section className="space-y-3 rounded-my-lg border border-my-line bg-my-layer-1 p-3">
    <h3 className="text-my-sm font-medium">外部关联与通知</h3>
    {links.map((link) => <div key={link.id} className="flex items-center justify-between gap-2 text-my-xs"><div className="min-w-0"><p className="truncate" title={link.object.title}>{link.object.providerId} · #{link.object.number} {link.object.title}</p><p className="truncate text-my-tertiary">{link.object.repository} · {link.object.state}（关联时快照）</p></div><div className="flex shrink-0 gap-1"><Button size="sm" onClick={() => void api.openExternal(link.object.url)}>来源</Button><Button size="sm" disabled={action.busy} onClick={() => void action.run(() => api.integrations.unlink({ expectedRoot: root, taskDir, linkId: link.id })).then((result) => { if (result) setLinks(result) })}>移除关联</Button></div></div>)}
    {links.length === 0 && <p className="text-my-xs text-my-tertiary">尚未关联远端 PR / MR。</p>}
    {choices.length > 0 ? <>
      <Select ariaLabel="工作项集成目的地" className="w-full" value={binding?.id ?? ''} disabled={action.busy} onChange={setSelectedId} options={choices.map((choice) => ({ value: choice.id, label: choice.label }))} />
      {binding && connection && context && provider?.category === 'repositories' && <PullRequestBrowser key={`${binding.id}:${binding.revision}:${connection.revision}`} root={root} connection={connection} binding={binding} onAttach={async (object) => { const result = await api.integrations.attach({ ...context, object }); if (!result.ok) throw new Error(result.error); if (action.current()) setLinks(result.data) }} />}
      {context && provider?.category === 'messaging' && <div className="space-y-2">
        <p className="text-my-xs text-my-tertiary">仅向所选群发送当前工作项摘要；先预览，再明确发送。</p>
        <Button size="sm" disabled={action.busy} onClick={() => void action.run(() => api.integrations.previewNotification(context)).then((result) => { if (result) { setPreview(result); setReceipt(null); setRequestId(crypto.randomUUID()) } })}>{preview ? '重新预览' : '预览通知'}</Button>
        {preview && <div className="space-y-2 rounded-my-md border border-my-line p-3"><p className="text-my-xs text-my-tertiary">发送到：{preview.destination}</p><p className="text-my-sm font-medium">{preview.title}</p><pre className="whitespace-pre-wrap break-words font-sans text-my-xs text-my-secondary">{preview.body}</pre><Button variant="primary" size="sm" disabled={action.busy || receipt !== null} onClick={() => void action.run(() => api.integrations.sendNotification({ ...context, requestId, preview })).then((result) => { if (result) setReceipt(result) })}>{action.busy ? '提交中…' : '发送这条通知'}</Button></div>}
        {receipt && <p role="status" className={receipt.state === 'delivered' ? 'text-my-xs text-my-success-text' : 'text-my-xs text-my-tertiary'}>{receipt.detail}{receipt.state === 'uncertain' ? '。重新发送前请先核实目标群。' : ''}</p>}
      </div>}
    </> : <p className="text-my-xs text-my-tertiary">在外部应用集成中为当前项目绑定仓库或群机器人后，可在这里关联与发送。</p>}
    {(action.error || linksError || snapshotError) && <p role="alert" className="text-my-xs text-my-danger-text">{action.error || linksError || snapshotError}</p>}
  </section>
}

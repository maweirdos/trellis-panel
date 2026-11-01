import { useEffect, useState, type JSX } from 'react'
import type { IntegrationBinding, IntegrationConnection } from '@shared/integrations'
import type { IntegrationSource } from '@shared/integration-work'
import type { JiraData, JiraIntegrationApi } from '@shared/jira-integration'
import { Select } from '../../../../../components/Select'
import { Button, Checkbox, Modal } from '../../../../ui'
import { useIntegrationAction } from '../../hooks'
import { useJiraReads } from './use-jira-reads'

export type JiraPreparedSource = { source: IntegrationSource; metadata: JiraData<'discover'> }
type Scope = { expectedRoot: string; workspaceId: string }

/** Mounted only by an explicit account, sync or import action. */
export function JiraSourceDialog({ api, scope, connection, bindings, initial, title, onAssociate, onClose, onPrepared, embedded = false }: {
  api: JiraIntegrationApi
  scope: Scope
  connection: IntegrationConnection
  bindings: readonly IntegrationBinding[]
  initial?: IntegrationSource
  title: string
  onAssociate: (binding?: IntegrationBinding) => void
  onClose: () => void
  onPrepared: (prepared: JiraPreparedSource) => void
  embedded?: boolean
}): JSX.Element {
  const enabled = bindings.filter((binding) => binding.enabled)
  const [bindingId, setBindingId] = useState(initial?.bindingId ?? enabled[0]?.id ?? '')
  const binding = enabled.find((item) => item.id === bindingId) ?? enabled[0]
  const content = <>
    <div className="border-b border-my-line px-5 py-4"><h2 className="text-my-lg font-semibold">{title}</h2><p className="my-item-description mt-1">{connection.name} · 选择 Jira 项目</p></div>
    {!binding ? <div className="space-y-4 p-5"><p className="text-my-sm text-my-secondary">先关联当前项目，再选择可访问的 Jira 项目。</p><Button variant="primary" onClick={() => onAssociate(bindings.find((item) => !item.enabled))}>关联当前项目</Button><Button variant="ghost" onClick={onClose}>取消</Button></div> : <>
      {enabled.length > 1 && <div className="px-5 pt-4"><label className="block space-y-2"><span className="my-item-title">项目关联</span><Select ariaLabel="项目关联" value={binding.id} options={enabled.map((item) => ({ value: item.id, label: item.label }))} onChange={setBindingId} /></label></div>}
      <JiraProjectSelection key={`${binding.id}:${binding.revision}`} api={api} scope={scope} connection={connection} binding={binding} initial={initial?.bindingId === binding.id ? initial : undefined} onClose={onClose} onPrepared={onPrepared} />
    </>}
  </>
  return embedded ? <div className="overflow-hidden rounded-my-lg border border-my-line">{content}</div> : <Modal open ariaLabel={title} onClose={onClose}>{content}</Modal>
}

function JiraProjectSelection({ api, scope, connection, binding, initial, onClose, onPrepared }: {
  api: JiraIntegrationApi; scope: Scope; connection: IntegrationConnection; binding: IntegrationBinding; initial?: IntegrationSource
  onClose: () => void; onPrepared: (prepared: JiraPreparedSource) => void
}): JSX.Element {
  const [projects, setProjects] = useState<JiraData<'projects'> | null>(null)
  const [projectId, setProjectId] = useState(initial?.remoteProjectId ?? '')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [rebindAccepted, setRebindAccepted] = useState(false)
  const changingProject = Boolean(initial && initial.remoteProjectId !== projectId)
  const action = useIntegrationAction(`${scope.expectedRoot}:${connection.id}:${connection.revision}:${binding.id}:${binding.revision}`)
  const read = useJiraReads(api, scope)
  useEffect(() => {
    let live = true
    setProjects(null); setError('')
    void read((requestId) => api.projects({ ...scope, requestId, connectionId: connection.id, connectionRevision: connection.revision, bindingId: binding.id, bindingRevision: binding.revision })).then((result) => {
      if (!live || !action.current()) return
      if (result.ok) setProjects(result.data)
      else setError(result.error)
    }).catch(() => { if (live && action.current()) setError('无法读取 Jira 项目，请重试。') })
    return () => { live = false }
  }, [api, scope, connection.id, connection.revision, binding.id, binding.revision, action.current, read, attempt])
  const prepare = (): void => {
    void action.run(async () => {
      const selected = await api.selectProject({ ...scope, connectionId: connection.id, connectionRevision: connection.revision, bindingId: binding.id, bindingRevision: binding.revision, projectId })
      if (!selected.ok) return selected
      if (!action.current()) return { ok: false as const, code: 'E_CONFLICT' as const, error: '项目来源已变化，请重新选择。' }
      const discovered = await read((requestId) => api.discover({ ...scope, source: selected.data, requestId, memberQuery: '' }))
      return discovered.ok ? { ok: true as const, data: { source: selected.data, metadata: discovered.data } } : discovered
    }).then((prepared) => { if (prepared && action.current()) onPrepared(prepared) })
  }
  return <>
    <div className="space-y-4 p-5" aria-busy={action.busy}>
      {projects === null && !error ? <p role="status" className="text-my-sm text-my-secondary">正在读取可访问的项目…</p> : projects && projects.length > 0 ? <label className="block space-y-2"><span className="my-item-title">Jira 项目</span><Select ariaLabel="Jira 项目" value={projectId} disabled={action.busy} options={[{ value: '', label: '请选择项目' }, ...projects.map((project) => ({ value: project.id, label: `${project.key} · ${project.name}` }))]} onChange={(id) => { setProjectId(id); setRebindAccepted(false) }} /></label> : projects && <p className="text-my-sm text-my-secondary">此账号没有可访问的 Jira 项目，请检查账号的项目权限。</p>}
      {changingProject && projectId && <label className="flex items-start gap-2 text-my-sm text-my-warning-text"><Checkbox checked={rebindAccepted} onChange={setRebindAccepted} />确认更换此关联的 Jira 项目；已有同步将被阻止，需重新核对映射后启用。</label>}
      {(error || action.error) && <p role="alert" className="break-words text-my-sm text-my-danger-text">{error || action.error}</p>}
      {(error || projects?.length === 0) && <Button size="sm" disabled={action.busy} onClick={() => setAttempt((value) => value + 1)}>重新读取项目</Button>}
    </div>
    <div className="flex justify-end gap-2 border-t border-my-line px-5 py-3"><Button disabled={action.busy} onClick={onClose}>取消</Button><Button variant="primary" disabled={action.busy || !projects?.some((project) => project.id === projectId) || changingProject && !rebindAccepted} onClick={prepare}>{action.busy ? '正在验证…' : '下一步'}</Button></div>
  </>
}

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { CruxTask } from '@shared/crux'
import type { TeamCodeResource, TeamTaskCodeResourceDto } from '@shared/team-code-resources'
import { Button } from '../../my/ui'
import { hasLocalWorkBridge } from '../local-work'
import { ResourceLoadState, ResourceRecovery, ResourceSummary } from './ResourceControls'
import { useResourceCommands, useResourceDraft, useResourceList, useResourceOwner, useResourceSurfaceKey } from './resource-state'

type SelectionDraft = { dto: TeamTaskCodeResourceDto; resource: TeamCodeResource | null }
const reasons: Record<TeamTaskCodeResourceDto['availability'], string> = {
  unconfigured: '此任务尚未选择代码资源。', available: '当前选择可用',
  disabled: '所选代码资源已停用，请联系管理员或明确选择其他允许资源。',
  unlinked: '所选代码资源已不再关联当前空间，请核对空间授权。'
}

export function TaskCodeResources({ task, onSelected }: { task: CruxTask; onSelected(): void }): JSX.Element {
  const key = useResourceSurfaceKey(task.spaceId, task.id)
  return <TaskResources key={key} task={task} onSelected={onSelected} />
}
function TaskResources({ task, onSelected }: { task: CruxTask; onSelected(): void }): JSX.Element {
  const owner = useResourceOwner(task.spaceId, task.id)
  const [dto, setDto] = useState<TeamTaskCodeResourceDto | null>(null)
  const [loading, setLoading] = useState(false), [error, setError] = useState('')
  const [draft, setDraft] = useResourceDraft<SelectionDraft | null>(owner, 'selection', null)
  const reading = useRef(0)
  const resources = useResourceList(owner, task.spaceId)
  const load = useCallback(async (): Promise<void> => {
    if (!owner.owns() || !owner.bridge || owner.context.state === 'local') return
    const ticket = ++reading.current
    setLoading(true); setError('')
    try {
      const reply = await owner.bridge.task({ workspaceKey: owner.context.key, taskId: task.id })
      if (!owner.owns() || ticket !== reading.current) return
      if (!reply.ok) { setDto(null); throw new Error(reply.error) }
      if (reply.value.taskId !== task.id || reply.value.taskCreatedAt !== task.createdAt || reply.value.spaceId !== task.spaceId) { setDto(null); throw new Error('任务来源已改变，请重新打开详情') }
      setDto(reply.value)
    } catch (cause) { if (owner.owns() && ticket === reading.current) setError(cause instanceof Error ? cause.message : '任务资源读取失败') }
    finally { if (owner.alive() && ticket === reading.current) setLoading(false) }
  }, [owner.owns, owner.alive, owner.bridge, owner.context.key, owner.context.state, task.id, task.createdAt, task.spaceId])
  useEffect(() => { void load() }, [load, task.updatedAt, owner.active])
  const commands = useResourceCommands(owner, (reply, original) => {
    if (reply.result.kind === 'selectTaskResource' && reply.result.targetId === task.id && reply.result.taskCreatedAt === task.createdAt) {
      if (original) setDraft(null)
      onSelected()
    }
  }, () => { void load(); void resources.load() })
  const canSelect = Boolean(dto?.canSelect && dto.taskUpdatedAt === task.updatedAt && !loading && !error && !resources.error && owner.context.state === 'connected')
  const locked = commands.busy || Boolean(commands.intent) || !canSelect
  const options = resources.page?.items ?? []
  const candidateCurrent = draft?.resource ? options.find((resource) => resource.resourceId === draft.resource?.resourceId) ?? (dto?.resource?.resourceId === draft.resource.resourceId ? dto.resource : null) : null
  const stale = Boolean(draft && (!dto || draft.dto.epoch !== dto.epoch || draft.dto.revision !== dto.revision || draft.dto.spaceRevision !== dto.spaceRevision || draft.dto.taskUpdatedAt !== dto.taskUpdatedAt || draft.resource && (candidateCurrent?.revision !== draft.resource.revision || candidateCurrent.disabled)))
  const choose = (resource: TeamCodeResource | null): void => { if (!locked && dto) setDraft({ dto, resource }) }
  const save = (): void => {
    if (!draft || locked || stale) return
    commands.submit((commandId) => ({ kind: 'selectTaskResource', commandId, taskId: task.id, resourceId: draft.resource?.resourceId ?? null,
      expectedEpoch: draft.dto.epoch, expectedRevision: draft.dto.revision,
      expectedTaskCreatedAt: draft.dto.taskCreatedAt, expectedSpaceId: draft.dto.spaceId, expectedTaskUpdatedAt: draft.dto.taskUpdatedAt,
      expectedSpaceRevision: draft.dto.spaceRevision, expectedResourceRevision: draft.resource?.revision ?? null }))
  }
  return <section className="min-w-0 space-y-3 rounded-my-md border border-my-line p-3" aria-label="任务代码资源">
    <header className="flex items-center gap-2"><h3 className="text-my-sm font-medium text-my-primary">代码资源</h3></header>
    {owner.context.state === 'local' ? <p className="text-my-xs text-my-secondary">共享代码资源需要团队连接。本机独立任务仍可继续使用。</p> : !owner.bridge ? <p className="text-my-xs text-my-secondary">当前客户端不支持代码资源，请更新客户端。</p> : <>
      <ResourceLoadState loading={loading || resources.loading} error={error || resources.error} refresh={() => { void load(); void resources.load(); void commands.refreshPending() }} />
      {dto && <>
        <p role="status" className={`text-my-xs ${['disabled', 'unlinked'].includes(dto.availability) ? 'text-my-warning-text' : 'text-my-secondary'}`}>{reasons[dto.availability]}</p>
        {dto.resource && <ResourceSummary resource={dto.resource} />}
        {!dto.resource && dto.selection?.resourceId && <p className="break-all text-my-xs text-my-tertiary">原选择：{dto.selection.resourceId}</p>}
        {!dto.canSelect && <p className="text-my-xs text-my-tertiary">当前账号不能修改此任务的代码资源。</p>}
        {dto.defaultResource && !dto.selection?.resourceId && <div className="space-y-2 rounded-my-md bg-my-layer-1 p-3"><p className="text-my-xs text-my-secondary">空间默认候选 · 尚未保存到任务</p><ResourceSummary resource={dto.defaultResource} />{dto.canSelect && <Button size="sm" disabled={locked || dto.defaultResource.disabled} onClick={() => choose(dto.defaultResource)}>选择此候选</Button>}</div>}
        {dto.canSelect && <fieldset disabled={locked} className="block min-w-0 space-y-2"><legend className="mb-2 text-my-xs text-my-secondary">选择当前空间允许的资源</legend>
          {options.length === 0 && !resources.loading && <p className="text-my-xs text-my-tertiary">当前没有允许资源，请联系空间管理员。</p>}
          {options.map((resource) => <div key={resource.resourceId} className="flex min-w-0 items-start gap-2 rounded-my-md border border-my-line p-3 hover:bg-my-layer-1-hover"><input className="mt-1 h-4 w-4 shrink-0 p-0" aria-label={`选择 ${resource.name}`} type="radio" name={`resource-${task.id}`} checked={draft?.resource?.resourceId === resource.resourceId} disabled={locked || resource.disabled} onChange={() => choose(resource)} /><div className="min-w-0 flex-1"><ResourceSummary resource={resource} /></div></div>)}
          <label className="flex items-center gap-2 text-my-xs text-my-secondary"><input className="h-4 w-4 shrink-0 p-0" type="radio" name={`resource-${task.id}`} checked={Boolean(draft && !draft.resource)} onChange={() => choose(null)} />不选择代码资源</label>
        </fieldset>}
        {resources.page?.hasMore && <Button size="sm" disabled={resources.loading} onClick={() => void resources.load(true)}>加载更多资源（列表尚未完整）</Button>}
        {draft && <div className="space-y-2 border-t border-my-line pt-3"><p className="break-words text-my-xs text-my-secondary">待保存：{draft.resource?.name ?? '不选择代码资源'}</p>{stale && <p role="alert" className="text-my-xs text-my-warning-text">任务、资源或空间关联已更新。草稿保留，请核对后重新选择。</p>}<div className="flex flex-wrap gap-2"><Button size="sm" variant="primary" disabled={locked || stale} onClick={save}>{commands.busy ? '正在保存…' : '保存资源选择'}</Button><Button size="sm" variant="ghost" disabled={commands.busy || Boolean(commands.intent)} onClick={() => setDraft(null)}>取消选择</Button></div></div>}
      </>}
      {!hasLocalWorkBridge() && <p className="text-my-xs text-my-tertiary">本机副本选择与开发准备请在桌面端打开此任务。</p>}
      <ResourceRecovery commands={commands} />
    </>}
  </section>
}

import { type JSX } from 'react'
import { Plus } from 'lucide-react'
import type { TeamCodeResource, TeamSpaceResourceLink } from '@shared/team-code-resources'
import { Button } from '../../my/ui'
import { useHifox } from '../store'
import { Field, inputClass, textareaClass } from '../ui'
import { ResourceLoadState, ResourceRecovery, ResourceSummary } from './ResourceControls'
import { useResourceCommands, useResourceDraft, useResourceList, useResourceOwner, useResourceSurfaceKey } from './resource-state'

type Editor = { resource: TeamCodeResource | null; epoch: string; name: string; purpose: string; moduleDescription: string; provider: TeamCodeResource['source']['provider']; repositoryId: string; repositoryUrl: string; disabled: boolean }
type Links = { base: TeamSpaceResourceLink; epoch: string; resourceIds: string[]; defaultResourceId: string | null }

export function SpaceCodeResources({ spaceId }: { spaceId: string }): JSX.Element {
  const key = useResourceSurfaceKey(spaceId)
  return <SpaceResources key={key} spaceId={spaceId} />
}
function SpaceResources({ spaceId }: { spaceId: string }): JSX.Element {
  const owner = useResourceOwner(spaceId)
  const archived = useHifox((state) => Boolean(state.snapshot?.spaces.find((space) => space.id === spaceId)?.archived))
  const resources = useResourceList(owner, spaceId)
  // Managers need the project catalogue to add resources not yet associated with this space.
  const catalogue = useResourceList(owner, undefined, Boolean(resources.page?.canManage))
  const [editor, setEditor] = useResourceDraft<Editor | null>(owner, 'editor', null)
  const [links, setLinks] = useResourceDraft<Links | null>(owner, 'links', null)
  const commands = useResourceCommands(owner, (reply, original) => {
    if (original && reply.result.kind === 'setSpaceResources' && reply.result.spaceId === spaceId) setLinks(null)
    if (original && ['create', 'update'].includes(reply.result.kind)) setEditor(null)
  }, () => { void resources.load(); void catalogue.load() })
  const local = owner.context.state === 'local'
  const canManage = resources.page?.canManage && owner.context.canManage && !archived && owner.context.state === 'connected'
  const locked = commands.busy || Boolean(commands.intent) || !canManage || Boolean(resources.error || catalogue.error) || resources.loading || catalogue.loading
  const all = catalogue.page?.items ?? resources.page?.items ?? []
  const currentLinks = resources.page?.spaceResources
  const displayedLinks = links?.resourceIds ?? currentLinks?.resourceIds ?? []
  const defaultId = links ? links.defaultResourceId : currentLinks?.defaultResourceId
  const linkStale = Boolean(links && (links.epoch !== resources.page?.epoch || links.base.revision !== currentLinks?.revision))
  const editorStale = Boolean(editor?.resource && all.find((item) => item.resourceId === editor.resource?.resourceId)?.revision !== editor.resource.revision || editor && editor.epoch !== resources.page?.epoch)
  const edit = (resource: TeamCodeResource | null): void => {
    if (!canManage || !resources.page) return
    setEditor({ resource, epoch: resources.page.epoch, name: resource?.name ?? '', purpose: resource?.purpose ?? '', moduleDescription: resource?.moduleDescription ?? '', provider: resource?.source.provider ?? 'git', repositoryId: resource?.source.repositoryId ?? '', repositoryUrl: resource?.source.repositoryUrl ?? '', disabled: resource?.disabled ?? false })
  }
  const changeLinks = (resourceIds: string[], defaultResourceId: string | null): void => {
    if (locked || !currentLinks || !resources.page) return
    setLinks({ base: links?.base ?? currentLinks, epoch: links?.epoch ?? resources.page.epoch, resourceIds, defaultResourceId })
  }
  const saveResource = (): void => {
    if (!editor || locked || editorStale) return
    commands.submit((commandId) => editor.resource
      ? { kind: 'update', commandId, expectedEpoch: editor.epoch, expectedRevision: editor.resource.revision, resourceId: editor.resource.resourceId, name: editor.name, purpose: editor.purpose, moduleDescription: editor.moduleDescription, disabled: editor.disabled }
      : { kind: 'create', commandId, expectedEpoch: editor.epoch, expectedRevision: 0, resourceId: crypto.randomUUID(), name: editor.name, purpose: editor.purpose, moduleDescription: editor.moduleDescription, source: { provider: editor.provider, repositoryId: editor.repositoryId, repositoryUrl: editor.repositoryUrl } })
  }
  return <section className="min-w-0 space-y-3 rounded-my-md border border-my-line p-4" aria-label="空间代码资源">
    <header className="flex flex-wrap items-center gap-2"><h3 className="flex-1 text-my-sm font-medium text-my-primary">代码资源</h3>{canManage && <Button size="sm" disabled={locked || Boolean(editor)} onClick={() => edit(null)}><Plus size={14} />新建资源</Button>}</header>
    {local ? <p className="text-my-xs text-my-secondary">共享代码资源需要团队连接。本机独立任务仍可继续使用。</p> : !owner.bridge ? <p className="text-my-xs text-my-secondary">当前客户端不支持代码资源，请更新客户端后重试。</p> : <>
      <ResourceLoadState loading={resources.loading || Boolean(canManage && catalogue.loading)} error={resources.error || (canManage ? catalogue.error : '')} refresh={() => { void resources.load(); if (canManage) void catalogue.load(); void commands.refreshPending() }} />
      {resources.page && !canManage && <p className="text-my-xs text-my-tertiary">{archived ? '空间已归档，资源只读。' : '当前允许的资源 · 只读'}</p>}
      {canManage && <p className="text-my-xs text-my-secondary">关联到当前空间后成员可选择使用；默认资源只作为未选择任务的候选。</p>}
      {resources.page && (canManage ? all : resources.page.items).length === 0 && <p className="text-my-sm text-my-tertiary">{canManage ? '暂无代码资源，可先新建资源。' : '当前空间没有允许的代码资源，请联系空间管理员。'}</p>}
      <ul className="divide-y divide-my-line">{(canManage ? all : resources.page?.items ?? []).map((resource) => <li key={resource.resourceId} className="flex min-w-0 flex-wrap items-start gap-3 py-3">
        {canManage && <input className="mt-1" type="checkbox" aria-label={`关联 ${resource.name}`} disabled={locked || resource.disabled && !displayedLinks.includes(resource.resourceId) || displayedLinks.length >= 64 && !displayedLinks.includes(resource.resourceId)} checked={displayedLinks.includes(resource.resourceId)} onChange={(event) => changeLinks(event.target.checked ? [...displayedLinks, resource.resourceId] : displayedLinks.filter((id) => id !== resource.resourceId), !event.target.checked && defaultId === resource.resourceId ? null : defaultId ?? null)} />}
        <div className="min-w-0 flex-1"><ResourceSummary resource={resource} /></div>
        <div className="flex flex-wrap items-center gap-2">{defaultId === resource.resourceId && <span className="my-chip text-my-secondary">空间默认</span>}{canManage && <><Button size="sm" variant="ghost" disabled={locked || resource.disabled || !displayedLinks.includes(resource.resourceId)} onClick={() => changeLinks(displayedLinks, defaultId === resource.resourceId ? null : resource.resourceId)}>{defaultId === resource.resourceId ? '取消默认' : '设为默认'}</Button><Button size="sm" variant="ghost" disabled={locked || Boolean(editor)} onClick={() => edit(resource)}>编辑</Button></>}</div>
      </li>)}</ul>
      {(canManage ? catalogue.page : resources.page)?.hasMore && <Button size="sm" disabled={canManage ? catalogue.loading : resources.loading} onClick={() => void (canManage ? catalogue.load(true) : resources.load(true))}>加载更多资源（列表尚未完整）</Button>}
      {links && <div className="space-y-2 border-t border-my-line pt-3">
        <p className="text-my-xs text-my-secondary">待保存关联 · {links.resourceIds.length} 个（最多 64 个）</p>
        {linkStale && <p role="alert" className="text-my-xs text-my-warning-text">空间关联已更新，草稿仍保留。请重新核对后再保存。</p>}
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="primary" disabled={locked || linkStale} onClick={() => commands.submit((commandId) => ({ kind: 'setSpaceResources', commandId, expectedEpoch: links.epoch, expectedRevision: links.base.revision, spaceId, resourceIds: links.resourceIds, defaultResourceId: links.defaultResourceId }))}>保存空间关联</Button>{linkStale && currentLinks && resources.page && <Button size="sm" disabled={locked} onClick={() => setLinks({ ...links, base: currentLinks, epoch: resources.page?.epoch ?? links.epoch })}>已核对，保留关联草稿</Button>}<Button size="sm" variant="ghost" disabled={locked} onClick={() => setLinks(null)}>取消关联修改</Button></div>
      </div>}
      {editor && <form aria-label={editor.resource ? '编辑代码资源' : '新建代码资源'} className="block space-y-3 border-t border-my-line pt-3" onSubmit={(event) => { event.preventDefault(); saveResource() }}>
        <fieldset disabled={locked} className="block min-w-0 space-y-3">
          <Field label="资源名称"><input aria-label="资源名称" className={inputClass} required maxLength={120} value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></Field>
          <Field label="用途"><input aria-label="用途" className={inputClass} required maxLength={1000} value={editor.purpose} onChange={(event) => setEditor({ ...editor, purpose: event.target.value })} /></Field>
          <Field label="完整基座与模块说明"><textarea aria-label="完整基座与模块说明" className={textareaClass} required rows={3} maxLength={2000} value={editor.moduleDescription} onChange={(event) => setEditor({ ...editor, moduleDescription: event.target.value.replace(/[\r\n]/g, ' ') })} /></Field>
          {editor.resource ? <><ResourceSummary resource={editor.resource} /><label className="flex items-center gap-2 text-my-sm text-my-secondary"><input type="checkbox" checked={editor.disabled} onChange={(event) => setEditor({ ...editor, disabled: event.target.checked })} />停用此资源</label>{editor.disabled && <p className="text-my-xs text-my-warning-text">停用后已有选择会显示失效，需要重新核对；不会自动替换为其他资源。</p>}</> : <>
            <Field label="仓库服务"><select aria-label="仓库服务" className={inputClass} value={editor.provider} onChange={(event) => setEditor({ ...editor, provider: event.target.value as Editor['provider'] })}>{['git', 'github', 'gitlab', 'azure-devops', 'other'].map((provider) => <option key={provider} value={provider}>{provider}</option>)}</select></Field>
            <Field label="仓库标识"><input aria-label="仓库标识" className={inputClass} required maxLength={256} placeholder="organization/repository" value={editor.repositoryId} onChange={(event) => setEditor({ ...editor, repositoryId: event.target.value })} /></Field>
            <Field label="仓库地址" hint="HTTP(S) 或 SSH 地址，不包含密码、查询参数或本机路径。"><input aria-label="仓库地址" className={inputClass} required maxLength={2048} placeholder="https://git.example.com/team/repository.git" value={editor.repositoryUrl} onChange={(event) => setEditor({ ...editor, repositoryUrl: event.target.value })} /></Field>
          </>}
        </fieldset>
        {editorStale && <p role="alert" className="text-my-xs text-my-warning-text">资源已更新，编辑草稿保留，请重新核对当前版本。</p>}
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="primary" onClick={saveResource} disabled={locked || editorStale}>{commands.busy ? '正在保存…' : editor.resource ? '保存资源' : '创建资源'}</Button>{editorStale && <Button size="sm" disabled={locked} onClick={() => { const current = all.find((item) => item.resourceId === editor.resource?.resourceId); if (current && resources.page) setEditor({ ...editor, resource: current, epoch: resources.page.epoch }) }}>已核对，保留编辑草稿</Button>}<Button size="sm" variant="ghost" disabled={locked} onClick={() => setEditor(null)}>取消编辑</Button></div>
      </form>}
      <ResourceRecovery commands={commands} />
    </>}
  </section>
}

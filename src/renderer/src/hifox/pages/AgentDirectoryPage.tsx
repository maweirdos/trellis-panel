import { useState } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { Button, EmptyState, SearchInput } from '../../my/ui'
import { FlowIcon } from '../icons'
import { useHifox } from '../store'
import { compactInputClass, PageHeader } from '../ui'

type DirectoryTab = 'all' | 'agent' | 'crew'

export function AgentDirectoryPage(): JSX.Element | null {
  const { snapshot, currentSpaceId, setCurrentSpace, setModule } = useHifox()
  const [tab, setTab] = useState<DirectoryTab>('all')
  const [keyword, setKeyword] = useState('')
  const [spaceFilter, setSpaceFilter] = useState('')
  if (!snapshot) return null
  // The authoritative snapshot supplies accessible entities. Keep their owning
  // space even in the global directory; exclusive agents belong to crew settings.
  const visibleSpaceIds = new Set(snapshot.spaces.map((space) => space.id))
  const agents = snapshot.agents.filter((agent) => visibleSpaceIds.has(agent.spaceId) && !agent.archived && !agent.exclusiveCrewId)
  const crews = snapshot.crews.filter((crew) => visibleSpaceIds.has(crew.spaceId) && !crew.archived)
  const search = keyword.trim().toLowerCase()
  const openSpace = (spaceId: string, kind: 'agent' | 'crew'): void => {
    setCurrentSpace(spaceId)
    setModule(kind === 'agent' ? 'agents' : 'crews')
  }
  const groups = snapshot.spaces.filter((space) => !spaceFilter || space.id === spaceFilter).map((space) => ({
    space,
    entries: [
      ...(tab !== 'crew' ? agents.filter((agent) => agent.spaceId === space.id).map((agent) => ({ id: agent.id, kind: 'agent' as const, name: agent.name, description: agent.description, enabled: agent.enabled, detail: `${agent.skillIds.length} 项技能` })) : []),
      ...(tab !== 'agent' ? crews.filter((crew) => crew.spaceId === space.id).map((crew) => ({ id: crew.id, kind: 'crew' as const, name: crew.name, description: crew.description, enabled: true, detail: `队长 ${crew.captain.name} · ${crew.members.length} 位协作者` })) : [])
    ].filter((entry) => `${entry.name} ${entry.description ?? ''} ${space.name} ${space.key}`.toLowerCase().includes(search))
  })).filter((group) => group.entries.length > 0)
  const tabs: Array<{ id: DirectoryTab; label: string; count: number }> = [
    { id: 'all', label: '全部', count: agents.length + crews.length },
    { id: 'agent', label: 'Agent', count: agents.length },
    { id: 'crew', label: '小队', count: crews.length }
  ]
  const configurationSpace = snapshot.spaces.find((space) => space.id === (spaceFilter || currentSpaceId) && !space.archived)
  return <div className="flex min-h-0 flex-1 flex-col gap-3">
    <PageHeader title="Agent 目录" description="按所属空间查找 Agent 与小队。" actions={configurationSpace && <Button size="sm" variant="primary" onClick={() => openSpace(configurationSpace.id, 'agent')}>管理 {configurationSpace.name} 的 Agent<ArrowUpRight size={13} /></Button>} />
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="my-segmented" role="group" aria-label="目录类型">{tabs.map((entry) => <button type="button" key={entry.id} aria-pressed={entry.id === tab} className={`my-control my-control-sm rounded-my-md ${entry.id === tab ? 'bg-my-layer-2 text-my-primary' : 'text-my-tertiary'}`} onClick={() => setTab(entry.id)}>{entry.label}<span className="ml-1 text-my-2xs text-my-tertiary collab-stat">{entry.count}</span></button>)}</div>
      <div className="flex flex-wrap items-center gap-2"><SearchInput value={keyword} onChange={setKeyword} placeholder="搜索 Agent、小队或空间" />
        <select aria-label="目录空间" className={`${compactInputClass} max-w-48`} value={spaceFilter} onChange={(event) => setSpaceFilter(event.target.value)}><option value="">全部空间</option>{snapshot.spaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}</select>
      </div>
    </div>
    <div className="my-scrollbar min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
      {groups.length === 0 ? <EmptyState title="没有匹配的 Agent 或小队" description="调整搜索或空间筛选，也可进入空间创建 Agent。" /> : groups.map(({ space, entries }) => <section key={space.id} data-directory-space={space.id} className="space-y-2">
        <header className="flex min-w-0 items-center gap-2"><FlowIcon name="projects" size={16} /><h2 className="truncate text-my-sm font-medium text-my-primary">{space.name}</h2><span className="text-my-2xs text-my-tertiary">{space.key} · {entries.length}</span></header>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">{entries.map((entry) => <article key={`${entry.kind}:${entry.id}`} data-directory-kind={entry.kind} className="flex min-w-0 flex-col gap-3 rounded-my-md border border-my-line p-3">
          <div className="flex items-start gap-2.5"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-my-md bg-my-layer-1 text-my-secondary"><FlowIcon name={entry.kind === 'agent' ? 'agents' : 'crews'} size={19} /></span>
            <div className="min-w-0 flex-1"><h3 className="truncate text-my-sm font-medium text-my-primary">{entry.name}</h3><p className="mt-0.5 text-my-2xs text-my-tertiary">{entry.kind === 'agent' ? 'Agent' : '小队'}{!entry.enabled && ' · 已停用'}</p></div>
          </div>
          <p className="line-clamp-2 text-my-xs leading-relaxed text-my-secondary">{entry.description || '暂无职责描述'}</p>
          <footer className="mt-auto flex flex-wrap items-center justify-between gap-2"><span className="text-my-2xs text-my-tertiary">{entry.detail}</span><Button size="sm" variant="ghost" aria-label={`打开 ${space.name} 的${entry.kind === 'agent' ? ' Agent' : '小队'} ${entry.name}`} onClick={() => openSpace(space.id, entry.kind)}>进入空间<ArrowUpRight size={13} /></Button></footer>
        </article>)}</div>
      </section>)}
    </div>
  </div>
}

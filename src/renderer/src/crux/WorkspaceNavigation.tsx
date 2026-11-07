import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Plus, Settings2 } from 'lucide-react'
import { FlowIcon } from './icons'
import { COLLABORATION_MODULES, type CollaborationModule } from './navigation'
import { isTriagePending, useCrux } from './store'

export function WorkspaceNavigation({ unread }: { unread: number }): JSX.Element | null {
  const { snapshot, module, currentSpaceId, workspaceContext, setModule, setCurrentSpace, beginCreateTask } = useCrux()
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [branches, setBranches] = useState<Record<string, boolean>>({})
  const active = COLLABORATION_MODULES.find((entry) => entry.id === module)
  useEffect(() => {
    if (active?.scope !== 'space' || !currentSpaceId) return
    setExpanded((previous) => ({ ...previous, [currentSpaceId]: true }))
    if (active.parent) setBranches((previous) => ({ ...previous, [`${currentSpaceId}:${active.parent}`]: true }))
  }, [active, currentSpaceId])
  if (!snapshot) return null
  const actorId = workspaceContext.actorId ?? (workspaceContext.state === 'local' ? snapshot.members.find((member) => member.role === 'owner')?.id : null)
  const spaces = snapshot.spaces.filter((space) => !space.archived && actorId && space.memberIds.includes(actorId))
  const globals = COLLABORATION_MODULES.filter((entry) => entry.scope === 'global' && entry.group === '工作台')
  const roots = COLLABORATION_MODULES.filter((entry) => entry.scope === 'space' && !entry.parent && entry.group !== '配置')
  const configuration = COLLABORATION_MODULES.filter((entry) => entry.group === '配置')
  const navigate = (entry: CollaborationModule, spaceId?: string): void => {
    if (spaceId && spaceId !== currentSpaceId) setCurrentSpace(spaceId)
    setModule(entry.id)
  }
  const item = (entry: CollaborationModule, spaceId?: string): JSX.Element => {
    const selected = module === entry.id && (entry.scope === 'global' || currentSpaceId === spaceId)
    const badge = entry.id === 'inbox' ? unread : entry.id === 'triage' ? snapshot.tasks.filter((task) => task.spaceId === spaceId && isTriagePending(snapshot, task)).length : 0
    return <button type="button" key={entry.id} data-crux-route={entry.id} data-space-id={spaceId} aria-label={entry.label}
      aria-current={selected ? 'page' : undefined} onClick={() => navigate(entry, spaceId)} className={`collab-nav-item ${selected ? 'is-selected' : ''}`}>
      <FlowIcon name={entry.icon} size={18} />
      <span className="min-w-0 flex-1 truncate">{entry.label}</span>{badge > 0 && <span className="collab-stat text-my-2xs text-my-tertiary">{badge}</span>}
    </button>
  }
  const branch = (entry: CollaborationModule, spaceId: string): JSX.Element => {
    const children = COLLABORATION_MODULES.filter((child) => child.parent === entry.id && child.id !== 'board')
    const branchKey = `${spaceId}:${entry.id}`
    const open = branches[branchKey] ?? true
    return <div key={entry.id} className="collab-nav-branch" data-nav-branch={entry.id}>
      <div className="collab-nav-parent">{item(entry, spaceId)}{children.length > 0 && <button type="button" className="collab-nav-disclosure" aria-label={`${open ? '收起' : '展开'}${entry.label}导航`} aria-expanded={open} aria-controls={`nav-${spaceId}-${entry.id}`}
        onClick={() => setBranches((previous) => ({ ...previous, [branchKey]: !open }))}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>}</div>
      {children.length > 0 && open && <div id={`nav-${spaceId}-${entry.id}`} className="collab-nav-children">{children.map((child) => item(child, spaceId))}</div>}
    </div>
  }
  return <nav aria-label="协作模块" className="collab-navigation my-scrollbar">
    <section aria-label="工作台" className="collab-nav-section">{globals.map((entry) => item(entry))}</section>
    <section aria-label="我的空间" className="collab-nav-section">
      <div className="collab-nav-section-heading"><h2>我的空间</h2><button type="button" aria-label="管理空间" title="管理空间" onClick={() => setModule('spaces')}><Settings2 size={14} /></button></div>
      {spaces.map((space) => {
        const open = expanded[space.id] ?? space.id === currentSpaceId
        return <section key={space.id} data-nav-space={space.id} aria-label={`${space.name}空间`} className="collab-nav-space">
          <div className="collab-nav-space-heading">
            <button type="button" className="collab-nav-space-toggle" aria-expanded={open} aria-controls={`nav-space-${space.id}`} onClick={() => setExpanded((previous) => ({ ...previous, [space.id]: !open }))}>
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<FlowIcon name="projects" size={17} /><span className="min-w-0 flex-1 truncate">{space.name}</span><span className="text-my-2xs font-normal text-my-tertiary">{space.key}</span>
            </button>
            <button type="button" className="collab-nav-space-create" aria-label={`在${space.name}中新建任务`} title="在此空间新建任务" onClick={() => { if (space.id !== currentSpaceId) setCurrentSpace(space.id); beginCreateTask({ spaceId: space.id }) }}><Plus size={15} /></button>
          </div>
          {open && <div id={`nav-space-${space.id}`} className="collab-nav-space-content">{roots.map((entry) => branch(entry, space.id))}
            <details key={`${space.id}:${active?.group === '配置'}`} open={active?.group === '配置' || undefined} className="group collab-nav-config"><summary className="collab-nav-section-heading cursor-pointer">配置<ChevronDown size={14} className="transition-transform group-open:rotate-180" /></summary>{configuration.map((entry) => item(entry, space.id))}</details>
          </div>}
        </section>
      })}
      {spaces.length === 0 && <button type="button" className="collab-nav-item" onClick={() => setModule('spaces')}><FlowIcon name="spaces" size={18} /><span>浏览与加入空间</span></button>}
    </section>
    <section aria-label="组织" className="collab-nav-section"><h2 className="collab-nav-section-heading">组织</h2>{COLLABORATION_MODULES.filter((entry) => entry.group === '组织').map((entry) => item(entry))}</section>
  </nav>
}

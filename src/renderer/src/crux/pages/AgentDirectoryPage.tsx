import { useState } from 'react'
import { ArrowUpRight, Cpu, Settings2 } from 'lucide-react'
import type { CruxRuntimeKind, CruxWorkingDirectoryMode } from '@shared/crux'
import { useApp } from '../../store'
import { useMy } from '../../my/store'
import { Button, EmptyState, SearchInput } from '../../my/ui'
import { FlowIcon } from '../icons'
import {
  APPROVAL_OPTIONS_BY_RUNTIME,
  MODEL_PRESET_OPTIONS,
  RUNTIME_KIND_OPTIONS,
  WORKDIR_MODE_OPTIONS,
  runtimeKindLabel,
  useLocalExecutionSlot,
  type LocalApprovalPolicy
} from '../local-execution-slot'
import { useCrux } from '../store'
import { PageHeader, Select } from '../ui'

type DirectoryTab = 'all' | 'agent' | 'crew'

export function AgentDirectoryPage(): JSX.Element | null {
  const { snapshot, currentSpaceId, setCurrentSpace, setModule } = useCrux()
  const { defaultSlot, agentOverrides, conflictNotice, setDefaultSlot, clearConflictNotice, resolveAgentSlot } = useLocalExecutionSlot()
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
  const overrideCount = Object.keys(agentOverrides).length
  return <div className="flex min-h-0 flex-1 flex-col gap-3">
    <PageHeader title="Agent 目录" description="第一层为团队共享岗位与技能；每个人的本机执行槽（Runtime/模型/审批）在下方独立配置。" actions={configurationSpace && <Button size="sm" variant="primary" onClick={() => openSpace(configurationSpace.id, 'agent')}>管理 {configurationSpace.name} 的 Agent<ArrowUpRight size={13} /></Button>} />
    <section aria-label="我的本机默认执行槽" className="rounded-my-base border border-my-line bg-my-panel p-3 space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-1.5 text-my-xs font-semibold text-my-primary">
            <Cpu size={14} className="shrink-0" aria-hidden="true" />我的本机默认执行槽（仅存本机，不同步团队）
          </h2>
          <p className="mt-0.5 text-my-2xs text-my-tertiary">
            所有共享岗位 Agent 默认继承此本机槽位{overrideCount > 0 ? `；当前已为 ${overrideCount} 个岗位单独覆盖` : ''}。
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => { useMy.getState().setSettingsView('engines'); useApp.getState().setPage('settings') }}>
          <Settings2 size={13} aria-hidden="true" />管理本机引擎
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Select size="sm" ariaLabel="本机默认 Runtime" value={defaultSlot.runtimeKind}
          onChange={(val) => setDefaultSlot({ runtimeKind: val as CruxRuntimeKind })}
          options={[...RUNTIME_KIND_OPTIONS]} />
        <Select size="sm" ariaLabel="本机默认模型" value={defaultSlot.model}
          onChange={(val) => setDefaultSlot({ model: val })}
          options={[...MODEL_PRESET_OPTIONS]} />
        <Select size="sm" ariaLabel="本机审批策略" value={defaultSlot.approvalPolicy}
          onChange={(val) => setDefaultSlot({ approvalPolicy: val as LocalApprovalPolicy })}
          options={[...APPROVAL_OPTIONS_BY_RUNTIME[defaultSlot.runtimeKind]]} />
        <Select size="sm" ariaLabel="本机目录策略" value={defaultSlot.workingDirectory}
          onChange={(val) => setDefaultSlot({ workingDirectory: val as CruxWorkingDirectoryMode })}
          options={[...WORKDIR_MODE_OPTIONS]} />
      </div>
      {conflictNotice && <div className="flex items-center justify-between gap-2 text-my-2xs text-my-warning-text" role="status">
        <span>{conflictNotice}</span>
        <button type="button" className="text-my-secondary hover:text-my-primary" onClick={clearConflictNotice}>知道了</button>
      </div>}
    </section>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="my-segmented" role="group" aria-label="目录类型">{tabs.map((entry) => <button type="button" key={entry.id} aria-pressed={entry.id === tab} className={`my-control my-control-sm rounded-my-md ${entry.id === tab ? 'bg-my-layer-2 text-my-primary' : 'text-my-tertiary'}`} onClick={() => setTab(entry.id)}>{entry.label}<span className="ml-1 text-my-2xs text-my-tertiary collab-stat">{entry.count}</span></button>)}</div>
      <div className="flex flex-wrap items-center gap-2"><SearchInput value={keyword} onChange={setKeyword} placeholder="搜索 Agent、小队或空间" />
        <Select
          size="sm"
          ariaLabel="目录空间"
          className="max-w-48"
          value={spaceFilter}
          onChange={setSpaceFilter}
          options={[
            { value: '', label: '全部空间' },
            ...snapshot.spaces.map((space) => ({ value: space.id, label: space.name }))
          ]}
        />
      </div>
    </div>
    <div className="my-scrollbar min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
      {groups.length === 0 ? <EmptyState title="没有匹配的 Agent 或小队" description="调整搜索或空间筛选，也可进入空间创建 Agent。" /> : groups.map(({ space, entries }) => <section key={space.id} data-directory-space={space.id} className="space-y-2">
        <header className="flex min-w-0 items-center gap-2"><FlowIcon name="projects" size={16} /><h2 className="truncate text-my-sm font-medium text-my-primary">{space.name}</h2><span className="text-my-2xs text-my-tertiary">{space.key} · {entries.length}</span></header>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">{entries.map((entry) => {
          const slotInfo = entry.kind === 'agent' ? resolveAgentSlot(entry.id) : null
          return <article key={`${entry.kind}:${entry.id}`} data-directory-kind={entry.kind} className="flex min-w-0 flex-col gap-3 rounded-my-md border border-my-line p-3">
          <div className="flex items-start gap-2.5"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-my-md bg-my-layer-1 text-my-secondary"><FlowIcon name={entry.kind === 'agent' ? 'agents' : 'crews'} size={19} /></span>
            <div className="min-w-0 flex-1"><h3 className="my-item-title truncate">{entry.name}</h3><p className="mt-0.5 text-my-2xs text-my-tertiary">{entry.kind === 'agent' ? '共享岗位 Agent' : '小队'}{!entry.enabled && ' · 已停用'}</p></div>
          </div>
          <p className="my-item-description line-clamp-2 leading-relaxed">{entry.description || '暂无职责描述'}</p>
          <footer className="mt-auto flex flex-wrap items-center justify-between gap-2">
            <span className="text-my-2xs text-my-tertiary">{entry.detail}{slotInfo ? ` · 本机${slotInfo.overridden ? '单独覆盖' : '跟随默认'}(${runtimeKindLabel(slotInfo.slot.runtimeKind)})` : ''}</span>
            <Button size="sm" variant="ghost" aria-label={`打开 ${space.name} 的${entry.kind === 'agent' ? ' Agent' : '小队'} ${entry.name}`} onClick={() => openSpace(space.id, entry.kind)}>进入空间<ArrowUpRight size={13} /></Button>
          </footer>
        </article>
        })}</div>
      </section>)}
    </div>
  </div>
}

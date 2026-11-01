import { useState } from 'react'
import { Archive, Bot, Loader2, Pencil, Plus, RotateCcw, Users } from 'lucide-react'
import type { HifoxAgent, HifoxCrew, HifoxCrewInput, HifoxRole, HifoxSnapshot } from '@shared/hifox'
import { api } from '../../api'
import { Button, EmptyState, Modal, SearchInput, Tooltip } from '../../my/ui'
import { useHifox } from '../store'
import { PageHeader, Field, inputClass, textareaClass, MemberChip } from '../ui'
import { AgentEditor } from './AgentsPage'

const ROLE_LABEL: Record<HifoxRole, string> = { owner: 'Owner', admin: '管理员', member: '成员' }
type CrewRef = HifoxCrewInput['memberRefs'][number]

export function CrewsPage(): JSX.Element | null {
  const snapshot = useHifox((state) => state.snapshot)
  const currentSpaceId = useHifox((state) => state.currentSpaceId)
  const run = useHifox((state) => state.run)
  const busy = useHifox((state) => state.busy)
  const [editing, setEditing] = useState<HifoxCrew | 'new' | null>(null)
  const [editingAgent, setEditingAgent] = useState<HifoxAgent | null>(null)
  const [archived, setArchived] = useState(false)
  const [keyword, setKeyword] = useState('')
  if (!snapshot) return null
  const crews = snapshot.crews.filter((crew) => crew.spaceId === currentSpaceId && Boolean(crew.archived) === archived && `${crew.name} ${crew.description ?? ''}`.toLowerCase().includes(keyword.toLowerCase()))
  const space = snapshot.spaces.find((item) => item.id === currentSpaceId)
  const writable = Boolean(space && !space.archived)
  const canCreate = writable && (snapshot.members.some((member) => space?.memberIds.includes(member.id)) || snapshot.agents.some((agent) => agent.spaceId === currentSpaceId && agent.enabled && !agent.archived && !agent.exclusiveCrewId))
  const restore = (crew: HifoxCrew): void => {
    void run('恢复小队', () => api.hifox.saveCrew({ id: crew.id, spaceId: crew.spaceId, name: crew.name, description: crew.description, instructions: crew.instructions, ownerId: crew.captain.kind === 'member' ? crew.captain.id : crew.ownerId, ...(crew.captain.kind === 'member' ? { captainMemberId: crew.captain.id } : { captainAgentId: crew.captain.id }), memberRefs: crew.members.map(({ kind, id }) => ({ kind, id })), archived: false }))
  }
  return <div className="my-fade flex min-h-0 flex-1 flex-col gap-3">
    <PageHeader title="小队" actions={<Tooltip label="组建小队" side="bottom"><Button variant="primary" size="sm" className="my-icon-control" disabled={busy || !canCreate} aria-label="组建小队" onClick={() => setEditing('new')}><Plus size={16} /></Button></Tooltip>} />
    <div className="flex flex-wrap items-center gap-3">
      <SearchInput value={keyword} onChange={setKeyword} placeholder="搜索小队" />
      <label className="flex items-center gap-2 text-my-xs text-my-secondary"><input type="checkbox" checked={archived} onChange={(event) => setArchived(event.target.checked)} />已归档</label>
      <span className="text-my-xs text-my-tertiary">{crews.length} 支小队</span>
    </div>
    {crews.length === 0 ? <EmptyState title={archived ? '暂无已归档小队' : '暂无匹配的小队'} /> :
      <div className="my-scrollbar grid min-h-0 flex-1 auto-rows-min grid-cols-1 gap-3 overflow-y-auto lg:grid-cols-2" style={{ scrollbarGutter: 'stable' }}>
        {crews.map((crew) => {
          const captain = crew.captain.kind === 'agent' ? snapshot.agents.find((agent) => agent.id === crew.captain.id && agent.spaceId === crew.spaceId) : undefined
          const captainReady = crew.captain.kind === 'member' ? snapshot.members.some((member) => member.id === crew.captain.id && space?.memberIds.includes(member.id)) : Boolean(captain?.enabled && !captain.archived)
          const roster = [crew.captain, ...crew.members.filter((ref) => !(ref.kind === crew.captain.kind && ref.id === crew.captain.id))]
          const tasks = snapshot.tasks.filter((task) => task.executor?.kind === 'crew' && task.executor.id === crew.id)
          return <section key={crew.id} className="flex flex-col gap-3 rounded-my-md border border-my-line p-3">
            <header className="flex items-start gap-2"><Users size={18} className="mt-0.5 shrink-0 text-my-icon-secondary" />
              <div className="min-w-0 flex-1"><h2 className="my-item-title truncate">{crew.name}</h2>{crew.description && <p className="my-item-description mt-0.5">{crew.description}</p>}</div>
              {crew.archived && <span className="text-my-2xs text-my-tertiary">已归档</span>}
            </header>
            {!captainReady && <p role="status" className="text-my-xs text-my-danger-text">队长不可用，请编辑小队更换队长。</p>}
            <div className="flex flex-wrap gap-2">{roster.map((ref) => {
              const agent = ref.kind === 'agent' ? snapshot.agents.find((item) => item.id === ref.id) : undefined
              const isCaptain = ref.kind === crew.captain.kind && ref.id === crew.captain.id
              return ref.kind === 'agent' ? <button key={`agent:${ref.id}`} type="button" disabled={!agent} onClick={() => { if (agent) setEditingAgent(agent) }} className="inline-flex items-center gap-1.5 rounded-my-md border border-my-line px-2 py-1 text-my-xs text-my-secondary hover:bg-my-layer-1-hover">
                <Bot size={14} />{agent?.name ?? ref.name}{isCaptain && <span className="text-my-2xs text-my-tertiary">队长</span>}{agent?.exclusiveCrewId && <span className="text-my-2xs text-my-tertiary">专属</span>}{agent && (!agent.enabled || agent.archived) && <span className="text-my-2xs text-my-tertiary">不可用</span>}
              </button> : <span key={`member:${ref.id}`} className="inline-flex items-center gap-1.5 rounded-my-md border border-my-line px-2 py-1 text-my-xs text-my-secondary"><MemberChip member={snapshot.members.find((member) => member.id === ref.id)} size="sm" />{snapshot.members.find((member) => member.id === ref.id)?.name ?? ref.name}{isCaptain && <span className="text-my-2xs text-my-tertiary">队长</span>}</span>
            })}</div>
            {crew.instructions && <p className="line-clamp-3 whitespace-pre-wrap text-my-xs leading-relaxed text-my-secondary">{crew.instructions}</p>}
            <footer className="mt-auto flex flex-wrap items-center gap-2"><span className="text-my-xs text-my-tertiary">{roster.filter((ref) => ref.kind === 'member').length} 人 · {roster.filter((ref) => ref.kind === 'agent').length} Agent · 任务 {tasks.length}</span><div className="ml-auto flex gap-1">
              <Tooltip label={`编辑 ${crew.name}`}><Button variant="ghost" size="sm" className="my-icon-control" disabled={busy || !writable} aria-label={`编辑 ${crew.name}`} onClick={() => setEditing(crew)}><Pencil size={14} /></Button></Tooltip>
              {crew.archived ? <Tooltip label={captainReady ? `恢复 ${crew.name}` : '请先更换可用队长'}><Button variant="ghost" size="sm" className="my-icon-control" disabled={busy || !writable || !captainReady} aria-label={`恢复 ${crew.name}`} onClick={() => restore(crew)}><RotateCcw size={14} /></Button></Tooltip>
                : <Tooltip label={`归档 ${crew.name}`}><Button variant="ghost" size="sm" className="my-icon-control" disabled={busy || !writable} aria-label={`归档 ${crew.name}`} onClick={() => void run('归档小队', () => api.hifox.removeCrew({ id: crew.id }))}><Archive size={14} /></Button></Tooltip>}
            </div></footer>
          </section>
        })}
      </div>}
    {editing && currentSpaceId && <CrewEditor key={`${currentSpaceId}:${editing === 'new' ? 'new' : editing.id}`} crew={editing === 'new' ? null : editing} snapshot={snapshot} spaceId={currentSpaceId} onClose={() => setEditing(null)} />}
    {editingAgent && <AgentEditor key={editingAgent.id} agent={editingAgent} spaceId={editingAgent.spaceId} onClose={() => setEditingAgent(null)} />}
  </div>
}

function CrewEditor({ crew, snapshot, spaceId, onClose }: { crew: HifoxCrew | null; snapshot: HifoxSnapshot; spaceId: string; onClose: () => void }): JSX.Element {
  const run = useHifox((state) => state.run)
  const busy = useHifox((state) => state.busy)
  const [name, setName] = useState(crew?.name ?? '')
  const [description, setDescription] = useState(crew?.description ?? '')
  const [instructions, setInstructions] = useState(crew?.instructions ?? '')
  const [ownerId, setOwnerId] = useState(crew?.ownerId ?? '')
  const [captain, setCaptain] = useState<CrewRef | null>(crew ? { kind: crew.captain.kind, id: crew.captain.id } : null)
  const [memberRefs, setMemberRefs] = useState<HifoxCrewInput['memberRefs']>(crew?.members ?? [])
  const [exclusiveIds, setExclusiveIds] = useState(snapshot.agents.filter((agent) => crew && agent.exclusiveCrewId === crew.id).map((agent) => agent.id))
  const [keyword, setKeyword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const space = snapshot.spaces.find((item) => item.id === (crew?.spaceId ?? spaceId))
  const people = snapshot.members.filter((member) => space?.memberIds.includes(member.id))
  const agents = snapshot.agents.filter((agent) => agent.spaceId === space?.id && (!agent.exclusiveCrewId || agent.exclusiveCrewId === crew?.id))
  const captainCandidates = agents.filter((agent) => agent.enabled && !agent.archived)
  const captainReady = captain?.kind === 'member' ? people.some((member) => member.id === captain.id) : captainCandidates.some((agent) => agent.id === captain?.id)
  const isCaptain = (kind: CrewRef['kind'], id: string): boolean => captain?.kind === kind && captain.id === id
  const selected = (kind: CrewRef['kind'], id: string): boolean => isCaptain(kind, id) || memberRefs.some((ref) => ref.kind === kind && ref.id === id)
  const toggle = (kind: 'agent' | 'member', id: string): void => {
    if (isCaptain(kind, id)) return
    const isSelected = selected(kind, id)
    setMemberRefs((previous) => isSelected ? previous.filter((ref) => !(ref.kind === kind && ref.id === id)) : [...previous, { kind, id }])
    if (isSelected && kind === 'agent') setExclusiveIds((previous) => previous.filter((value) => value !== id))
  }
  const selectCaptain = (value: string): void => {
    const person = people.find((member) => `member:${member.id}` === value)
    const agent = captainCandidates.find((item) => `agent:${item.id}` === value)
    const next: CrewRef | null = person ? { kind: 'member', id: person.id } : agent ? { kind: 'agent', id: agent.id } : null
    setCaptain(next)
    if (!next) return
    setMemberRefs((previous) => previous.some((ref) => ref.kind === next.kind && ref.id === next.id) ? previous : [...previous, next])
    if (next.kind === 'agent') setExclusiveIds((previous) => previous.filter((id) => id !== next.id))
  }
  const matching = (value: string): boolean => value.toLowerCase().includes(keyword.toLowerCase())
  const submit = async (): Promise<void> => {
    if (busy || !space || space.archived || !name.trim() || !captain || !captainReady) return
    setError(null)
    const result = await run(crew ? '更新小队' : '组建小队', () => api.hifox.saveCrew({
      id: crew?.id, spaceId: crew?.spaceId ?? spaceId, name: name.trim(), description: description.trim() || undefined,
      instructions: instructions.trim(), ownerId: captain.kind === 'member' ? captain.id : ownerId || null,
      ...(captain.kind === 'member' ? { captainMemberId: captain.id } : { captainAgentId: captain.id }),
      memberRefs: memberRefs.map(({ kind, id }) => ({ kind, id })), exclusiveAgentIds: exclusiveIds,
      archived: crew?.archived ?? false
    }))
    if (result?.ok) onClose()
    else if (result && !result.ok) setError(result.error)
    else setError('保存失败，请重试。')
  }
  return <Modal open onClose={() => { if (!busy) onClose() }} width={600} ariaLabel={crew ? '编辑小队' : '组建小队'}>
    <fieldset disabled={busy || Boolean(space?.archived)} className="flex max-h-[var(--my-modal-max-height)] min-w-0 flex-col gap-3 p-4">
      <h2 className="shrink-0 text-my-md font-semibold text-my-primary">{crew ? '编辑小队' : '组建小队'}</h2>
      <div className="my-scrollbar min-h-0 overflow-y-auto" style={{ scrollbarGutter: 'stable' }}><div className="flex flex-col gap-3">
        <Field label="名称"><input className={inputClass} autoFocus value={name} onChange={(event) => setName(event.target.value)} /></Field>
        <Field label="职责（选填）"><input className={inputClass} value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
        <Field label="队长">
          <select className={inputClass} value={captain ? `${captain.kind}:${captain.id}` : ''} onChange={(event) => selectCaptain(event.target.value)}>
            <option value="">选择队长</option>
            {captain && !captainReady && <option value={`${captain.kind}:${captain.id}`} disabled>{crew?.captain.name ?? captain.id}（不可用）</option>}
            <optgroup label="空间成员">{people.map((member) => <option key={member.id} value={`member:${member.id}`}>{member.name}{member.title ? ` · ${member.title}` : ''}</option>)}</optgroup>
            {captainCandidates.length > 0 && <optgroup label="Agent">{captainCandidates.map((agent) => <option key={agent.id} value={`agent:${agent.id}`}>{agent.name}</option>)}</optgroup>}
          </select>
        </Field>
        {captain?.kind === 'agent' && <Field label="负责人（选填）"><select className={inputClass} value={ownerId} onChange={(event) => setOwnerId(event.target.value)}><option value="">未设置</option>{people.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></Field>}
        <fieldset><legend className="mb-2 text-my-xs font-medium text-my-tertiary">成员</legend>
          <SearchInput value={keyword} onChange={setKeyword} placeholder="搜索成员或 Agent" />
          <div className="my-scrollbar flex max-h-56 flex-col gap-1 overflow-y-auto">
            {agents.filter((agent) => matching(agent.name) && ((agent.enabled && !agent.archived) || selected('agent', agent.id))).map((agent) => {
              const isSelected = selected('agent', agent.id)
              const captain = isCaptain('agent', agent.id)
              const otherCrew = snapshot.crews.some((item) => item.id !== crew?.id && ((item.captain.kind === 'agent' && item.captain.id === agent.id) || item.members.some((ref) => ref.kind === 'agent' && ref.id === agent.id)))
              return <div key={agent.id} className="flex flex-wrap items-center gap-2 rounded-my-md border border-my-line p-2 text-my-xs text-my-secondary">
                <label className="flex flex-1 items-center gap-2"><input type="checkbox" disabled={captain} checked={isSelected} onChange={() => toggle('agent', agent.id)} /><Bot size={14} />{agent.name}{captain && <span className="text-my-2xs text-my-tertiary">队长</span>}{(!agent.enabled || agent.archived) && <span className="text-my-2xs text-my-tertiary">不可用</span>}</label>
                {isSelected && !captain && <label title={otherCrew ? '先从其他小队移出后才能设为专属' : '只能在本小队中使用，保留既有任务历史'} className="flex items-center gap-1.5 text-my-2xs text-my-tertiary"><input type="checkbox" disabled={otherCrew} checked={exclusiveIds.includes(agent.id)} onChange={(event) => setExclusiveIds((previous) => event.target.checked ? [...previous, agent.id] : previous.filter((id) => id !== agent.id))} />小队专属</label>}
              </div>
            })}
            {people.filter((member) => matching(`${member.name} ${member.title ?? ''}`)).map((member) => <label key={member.id} className="flex items-center gap-2 rounded-my-md border border-my-line p-2 text-my-xs text-my-secondary"><input type="checkbox" disabled={isCaptain('member', member.id)} checked={selected('member', member.id)} onChange={() => toggle('member', member.id)} /><MemberChip member={member} size="sm" />{member.name}<span className="ml-auto text-my-2xs text-my-tertiary">{isCaptain('member', member.id) ? '队长' : member.title || ROLE_LABEL[member.role]}</span></label>)}
          </div>
        </fieldset>
        <Field label="协作约定（选填）"><textarea className={textareaClass} rows={3} value={instructions} onChange={(event) => setInstructions(event.target.value)} /></Field>
        {error && <p role="alert" className="text-my-xs text-my-danger-text">{error}</p>}
      </div></div>
      <div className="flex shrink-0 justify-end gap-2"><Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" size="sm" aria-busy={busy} disabled={busy || !name.trim() || !captainReady} onClick={() => void submit()}>{busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}{crew ? '保存' : '组建'}</Button></div>
    </fieldset>
  </Modal>
}

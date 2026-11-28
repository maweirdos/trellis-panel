import { useRef, useState, type JSX } from 'react'
import { Archive, Loader2, MessageSquare, Pencil, Plus, RotateCcw, Trash2, Users } from 'lucide-react'
import type { CruxAgent, CruxCrew, CruxCrewInput, CruxRole, CruxSnapshot } from '@shared/crux'
import { api } from '../../api'
import { confirmDialog } from '../../components/Dialogs'
import { Button, Checkbox, EmptyState, Modal, SearchInput, Tooltip } from '../../my/ui'
import { AgentAvatar } from '../AgentAvatar'
import { useAgentChatBridge } from '../agent-chat-bridge'
import { useCollaborationPlatform, type AgentQuickReply } from '../collaboration-platform-store'
import { useCrux } from '../store'
import { AGENT_PRESENCE_META, computeAgentPresence, useTaskRuns } from '../task-run-store'
import { Field, inputClass, MemberChip, PageHeader, Select, textareaClass } from '../ui'
import { AgentEditor } from './AgentsPage'

const ROLE_LABEL: Record<CruxRole, string> = { owner: 'Owner', admin: '管理员', member: '成员' }
type CrewRef = CruxCrewInput['memberRefs'][number]

export function CrewsPage(): JSX.Element | null {
  const snapshot = useCrux((state) => state.snapshot)
  const currentSpaceId = useCrux((state) => state.currentSpaceId)
  const run = useCrux((state) => state.run)
  const busy = useCrux((state) => state.busy)
  const runs = useTaskRuns((state) => state.runs)
  const crewQuickReplies = useCollaborationPlatform((state) => state.crewQuickReplies)
  const [editing, setEditing] = useState<CruxCrew | 'new' | null>(null)
  const [editingAgent, setEditingAgent] = useState<CruxAgent | null>(null)
  const [archived, setArchived] = useState(false)
  const [keyword, setKeyword] = useState('')

  if (!snapshot) return null

  const crews = snapshot.crews.filter((crew) =>
    crew.spaceId === currentSpaceId
    && Boolean(crew.archived) === archived
    && `${crew.name} ${crew.description ?? ''}`.toLowerCase().includes(keyword.toLowerCase())
  )
  const space = snapshot.spaces.find((item) => item.id === currentSpaceId)
  const writable = Boolean(space && !space.archived)
  const canCreate = writable && (
    snapshot.members.some((member) => space?.memberIds.includes(member.id))
    || snapshot.agents.some((agent) => agent.spaceId === currentSpaceId && agent.enabled && !agent.archived && !agent.exclusiveCrewId)
  )

  const restore = (crew: CruxCrew): void => {
    void run('恢复小队', () => api.crux.saveCrew({
      id: crew.id,
      spaceId: crew.spaceId,
      name: crew.name,
      description: crew.description,
      instructions: crew.instructions,
      ownerId: crew.captain.kind === 'member' ? crew.captain.id : crew.ownerId,
      ...(crew.captain.kind === 'member' ? { captainMemberId: crew.captain.id } : { captainAgentId: crew.captain.id }),
      memberRefs: crew.members.map(({ kind, id }) => ({ kind, id })),
      archived: false
    }))
  }

  const archiveCrew = async (crew: CruxCrew): Promise<void> => {
    const ok = await confirmDialog({
      title: `归档小队「${crew.name}」？`,
      message: '归档后保留名册和既有任务历史，需要时可在已归档筛选中恢复。',
      confirmText: '归档小队'
    })
    if (!ok) return
    await run('归档小队', () => api.crux.removeCrew({ id: crew.id }))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-[var(--my-page-inset)]">
      <PageHeader
        title="小队"
        description="将空间成员与多个 Agent 编组为长期协作小队，统一队长、约定与快捷指令。"
        actions={
          <Button variant="primary" size="sm" disabled={busy || !canCreate} onClick={() => setEditing('new')}>
            <Plus size={14} />
            <span>组建小队</span>
          </Button>
        }
      />

      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <SearchInput size="sm" value={keyword} onChange={setKeyword} placeholder="搜索小队" ariaLabel="搜索小队" className="w-56" />
        <label className="flex cursor-pointer items-center gap-2 text-my-xs text-my-secondary">
          <Checkbox checked={archived} onChange={setArchived} ariaLabel="查看已归档小队" />
          <span>已归档</span>
        </label>
        <span className="text-my-xs tabular-nums text-my-tertiary">{crews.length} 支小队</span>
      </div>

      {crews.length === 0 ? (
        <EmptyState
          icon={<Users size={28} />}
          title={archived ? '暂无已归档小队' : '暂无匹配的小队'}
          description={archived ? '当前空间还没有已归档的小队。' : '组建多角色协同小队，由人类成员或 Agent 担任队长分工推进。'}
        />
      ) : (
        <div className="my-scrollbar grid min-h-0 flex-1 auto-rows-min grid-cols-1 gap-3 overflow-y-auto pr-1 lg:grid-cols-2">
          {crews.map((crew) => {
            const captain = crew.captain.kind === 'agent'
              ? snapshot.agents.find((agent) => agent.id === crew.captain.id && agent.spaceId === crew.spaceId)
              : undefined
            const captainReady = crew.captain.kind === 'member'
              ? snapshot.members.some((member) => member.id === crew.captain.id && space?.memberIds.includes(member.id))
              : Boolean(captain?.enabled && !captain.archived)
            const roster = [crew.captain, ...crew.members.filter((ref) => !(ref.kind === crew.captain.kind && ref.id === crew.captain.id))]
            const tasks = snapshot.tasks.filter((task) => task.executor?.kind === 'crew' && task.executor.id === crew.id)
            const chatAgent = (crew.captain.kind === 'agent' ? captain : undefined)
              ?? roster
                .filter((ref) => ref.kind === 'agent')
                .map((ref) => snapshot.agents.find((item) => item.id === ref.id && item.enabled && !item.archived))
                .find((item): item is CruxAgent => Boolean(item))
            const quickReplies = crewQuickReplies[crew.id] ?? []

            return (
              <section key={crew.id} className="my-card flex flex-col gap-3 p-4">
                <header className="flex items-start gap-2.5">
                  <Users size={18} className="mt-0.5 shrink-0 text-my-icon-secondary" />
                  <div className="min-w-0 flex-1">
                    <h2 className="my-item-title truncate text-my-sm font-medium text-my-primary">{crew.name}</h2>
                    {crew.description && <p className="my-item-description mt-0.5">{crew.description}</p>}
                  </div>
                  {crew.archived && <span className="rounded-my-sm bg-my-layer-1 px-1.5 py-0.5 text-my-2xs text-my-tertiary">已归档</span>}
                </header>

                {!captainReady && (
                  <p role="status" className="text-my-xs text-my-danger-text">队长不可用，请编辑小队更换队长。</p>
                )}

                <div className="flex flex-wrap gap-2">
                  {roster.map((ref) => {
                    const agent = ref.kind === 'agent' ? snapshot.agents.find((item) => item.id === ref.id) : undefined
                    const member = ref.kind === 'member' ? snapshot.members.find((item) => item.id === ref.id) : undefined
                    const isCaptain = ref.kind === crew.captain.kind && ref.id === crew.captain.id
                    const presence = agent ? computeAgentPresence(agent.id, runs, agent.enabled && !agent.archived) : null
                    return ref.kind === 'agent' ? (
                      <button
                        key={`agent:${ref.id}`}
                        type="button"
                        disabled={!agent}
                        onClick={() => { if (agent) setEditingAgent(agent) }}
                        className="inline-flex items-center gap-1.5 rounded-my-base border border-my-line bg-my-canvas px-2 py-1 text-my-xs text-my-secondary transition-colors hover:bg-my-layer-1"
                      >
                        {presence && <span className="collab-presence-dot" data-state={presence.state} title={AGENT_PRESENCE_META[presence.state].label} />}
                        <AgentAvatar avatarId={agent?.avatarId} size={18} />
                        <span>{agent?.name ?? ref.name}</span>
                        {isCaptain && <span className="text-my-2xs text-my-tertiary">队长</span>}
                        {agent?.exclusiveCrewId && <span className="text-my-2xs text-my-tertiary">专属</span>}
                        {presence && <span className="text-my-2xs text-my-tertiary">· {AGENT_PRESENCE_META[presence.state].label}</span>}
                      </button>
                    ) : (
                      <span key={`member:${ref.id}`} className="inline-flex items-center gap-1.5 rounded-my-base border border-my-line bg-my-canvas px-2 py-1 text-my-xs text-my-secondary">
                        <MemberChip member={member} size="sm" />
                        <span>{member?.name ?? ref.name}</span>
                        {isCaptain && <span className="text-my-2xs text-my-tertiary">队长</span>}
                      </span>
                    )
                  })}
                </div>

                {crew.instructions && (
                  <p className="line-clamp-3 whitespace-pre-wrap text-my-xs leading-relaxed text-my-secondary">{crew.instructions}</p>
                )}

                {quickReplies.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {quickReplies.slice(0, 3).map((reply) => (
                      <span key={reply.id} className="rounded-my-sm bg-my-layer-1 px-2 py-0.5 text-my-2xs text-my-secondary">{reply.label}</span>
                    ))}
                  </div>
                )}

                <footer className="mt-auto flex flex-wrap items-center gap-2 border-t border-my-line pt-2.5">
                  <span className="text-my-xs tabular-nums text-my-tertiary">
                    {roster.filter((ref) => ref.kind === 'member').length} 人 · {roster.filter((ref) => ref.kind === 'agent').length} Agent · 任务 {tasks.length}
                  </span>
                  <div className="ml-auto flex gap-1">
                    {!crew.archived && chatAgent && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => useAgentChatBridge.getState().startAgentChat(chatAgent.id, { runtimeKind: chatAgent.runtimeKind, workingDirectory: chatAgent.workingDirectory })}
                      >
                        <MessageSquare size={13} />
                        <span>小队对话</span>
                      </Button>
                    )}
                    <Tooltip label={`编辑 ${crew.name}`}>
                      <Button variant="ghost" size="sm" className="my-icon-control" disabled={busy || !writable} aria-label={`编辑 ${crew.name}`} onClick={() => setEditing(crew)}>
                        <Pencil size={14} />
                      </Button>
                    </Tooltip>
                    {crew.archived ? (
                      <Tooltip label={captainReady ? `恢复 ${crew.name}` : '请先更换可用队长'}>
                        <Button variant="ghost" size="sm" className="my-icon-control" disabled={busy || !writable || !captainReady} aria-label={`恢复 ${crew.name}`} onClick={() => restore(crew)}>
                          <RotateCcw size={14} />
                        </Button>
                      </Tooltip>
                    ) : (
                      <Tooltip label={`归档 ${crew.name}`}>
                        <Button variant="ghost" size="sm" className="my-icon-control" disabled={busy || !writable} aria-label={`归档 ${crew.name}`} onClick={() => void archiveCrew(crew)}>
                          <Archive size={14} />
                        </Button>
                      </Tooltip>
                    )}
                  </div>
                </footer>
              </section>
            )
          })}
        </div>
      )}

      <CrewEditor
        open={Boolean(editing && currentSpaceId)}
        crew={editing && editing !== 'new' ? editing : null}
        snapshot={snapshot}
        spaceId={currentSpaceId ?? ''}
        onClose={() => setEditing(null)}
      />
      {editingAgent && <AgentEditor key={editingAgent.id} agent={editingAgent} spaceId={editingAgent.spaceId} onClose={() => setEditingAgent(null)} />}
    </div>
  )
}

function CrewEditor({
  open,
  crew,
  snapshot,
  spaceId,
  onClose
}: {
  open: boolean
  crew: CruxCrew | null
  snapshot: CruxSnapshot
  spaceId: string
  onClose: () => void
}): JSX.Element {
  const busy = useCrux((state) => state.busy)
  const lastRef = useRef<{ crew: CruxCrew | null; spaceId: string }>({ crew, spaceId })
  const sessionRef = useRef(0)
  const wasOpenRef = useRef(false)
  if (open) {
    lastRef.current = { crew, spaceId }
    if (!wasOpenRef.current) sessionRef.current++
  }
  wasOpenRef.current = open
  const current = lastRef.current

  return (
    <Modal open={open} onClose={() => { if (!busy) onClose() }} width={600} placement="center" ariaLabel={current.crew ? '编辑小队' : '组建小队'}>
      <CrewEditorForm
        key={`${sessionRef.current}:${current.spaceId}:${current.crew?.id ?? 'new'}`}
        crew={current.crew}
        snapshot={snapshot}
        spaceId={current.spaceId}
        onClose={onClose}
      />
    </Modal>
  )
}

function CrewEditorForm({ crew, snapshot, spaceId, onClose }: { crew: CruxCrew | null; snapshot: CruxSnapshot; spaceId: string; onClose: () => void }): JSX.Element {
  const run = useCrux((state) => state.run)
  const busy = useCrux((state) => state.busy)
  const getCrewQuickReplies = useCollaborationPlatform((state) => state.getCrewQuickReplies)
  const setCrewQuickReplies = useCollaborationPlatform((state) => state.setCrewQuickReplies)
  const [name, setName] = useState(crew?.name ?? '')
  const [description, setDescription] = useState(crew?.description ?? '')
  const [instructions, setInstructions] = useState(crew?.instructions ?? '')
  const [ownerId, setOwnerId] = useState(crew?.ownerId ?? '')
  const [captain, setCaptain] = useState<CrewRef | null>(crew ? { kind: crew.captain.kind, id: crew.captain.id } : null)
  const [memberRefs, setMemberRefs] = useState<CruxCrewInput['memberRefs']>(crew?.members ?? [])
  const [exclusiveIds, setExclusiveIds] = useState(snapshot.agents.filter((agent) => crew && agent.exclusiveCrewId === crew.id).map((agent) => agent.id))
  const [quickReplies, setQuickReplies] = useState<AgentQuickReply[]>(() => (crew ? getCrewQuickReplies(crew.id) : []))
  const [replyLabel, setReplyLabel] = useState('')
  const [replyPrompt, setReplyPrompt] = useState('')
  const [keyword, setKeyword] = useState('')
  const [error, setError] = useState<string | null>(null)

  const space = snapshot.spaces.find((item) => item.id === (crew?.spaceId ?? spaceId))
  const people = snapshot.members.filter((member) => space?.memberIds.includes(member.id))
  const agents = snapshot.agents.filter((agent) => agent.spaceId === space?.id && (!agent.exclusiveCrewId || agent.exclusiveCrewId === crew?.id))
  const captainCandidates = agents.filter((agent) => agent.enabled && !agent.archived)
  const captainReady = captain?.kind === 'member'
    ? people.some((member) => member.id === captain.id)
    : captainCandidates.some((agent) => agent.id === captain?.id)

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
    const result = await run(crew ? '更新小队' : '组建小队', () => api.crux.saveCrew({
      id: crew?.id,
      spaceId: crew?.spaceId ?? spaceId,
      name: name.trim(),
      description: description.trim() || undefined,
      instructions: instructions.trim(),
      ownerId: captain.kind === 'member' ? captain.id : ownerId || null,
      ...(captain.kind === 'member' ? { captainMemberId: captain.id } : { captainAgentId: captain.id }),
      memberRefs: memberRefs.map(({ kind, id }) => ({ kind, id })),
      exclusiveAgentIds: exclusiveIds,
      archived: crew?.archived ?? false
    }))
    if (result?.ok) {
      const targetId = crew?.id ?? result.data.crews.find((item) => !snapshot.crews.some((prev) => prev.id === item.id))?.id
      if (targetId) setCrewQuickReplies(targetId, quickReplies)
      onClose()
    } else if (result && !result.ok) setError(result.error)
    else setError('保存失败，请重试。')
  }

  return (
    <fieldset disabled={busy || Boolean(space?.archived)} className="flex max-h-[var(--my-modal-max-height)] min-w-0 flex-col">
      <header className="shrink-0 border-b border-my-line px-6 py-4">
        <h2 className="text-my-base font-medium text-my-primary">{crew ? '编辑小队' : '组建小队'}</h2>
      </header>
      <div className="my-scrollbar my-fade-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-5">
        <Field label="名称"><input className={inputClass} autoFocus value={name} onChange={(event) => setName(event.target.value)} /></Field>
        <Field label="职责（选填）"><input className={inputClass} value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
        <Field label="队长">
          <Select
            className="w-full"
            value={captain ? `${captain.kind}:${captain.id}` : ''}
            onChange={selectCaptain}
            options={[
              { value: '', label: '选择队长' },
              ...(captain && !captainReady ? [{ value: `${captain.kind}:${captain.id}`, label: `${crew?.captain.name ?? captain.id}（不可用）`, disabled: true }] : []),
              ...people.map((member) => ({ value: `member:${member.id}`, label: `空间成员 · ${member.name}${member.title ? ` · ${member.title}` : ''}` })),
              ...captainCandidates.map((agent) => ({ value: `agent:${agent.id}`, label: `Agent · ${agent.name}` }))
            ]}
          />
        </Field>
        {captain?.kind === 'agent' && (
          <Field label="负责人（选填）">
            <Select
              className="w-full"
              value={ownerId}
              onChange={setOwnerId}
              options={[
                { value: '', label: '未设置' },
                ...people.map((member) => ({ value: member.id, label: member.name }))
              ]}
            />
          </Field>
        )}
        <fieldset className="space-y-2">
          <legend className="mb-1 pl-0.5 text-my-xs text-my-secondary">成员</legend>
          <SearchInput size="sm" value={keyword} onChange={setKeyword} placeholder="搜索成员或 Agent" ariaLabel="搜索成员或 Agent" />
          <div className="my-scrollbar flex max-h-56 flex-col gap-1.5 overflow-y-auto pt-1">
            {agents.filter((agent) => matching(agent.name) && ((agent.enabled && !agent.archived) || selected('agent', agent.id))).map((agent) => {
              const isSelected = selected('agent', agent.id)
              const agentCaptain = isCaptain('agent', agent.id)
              const otherCrew = snapshot.crews.some((item) => item.id !== crew?.id && ((item.captain.kind === 'agent' && item.captain.id === agent.id) || item.members.some((ref) => ref.kind === 'agent' && ref.id === agent.id)))
              return (
                <div key={agent.id} className="flex flex-wrap items-center gap-2 rounded-my-base border border-my-line bg-my-canvas p-2 text-my-xs text-my-secondary">
                  <label className="flex flex-1 cursor-pointer items-center gap-2">
                    <Checkbox
                      checked={isSelected}
                      disabled={agentCaptain}
                      ariaLabel={`选择 Agent ${agent.name}`}
                      onChange={() => toggle('agent', agent.id)}
                    />
                    <AgentAvatar avatarId={agent.avatarId} size={18} />
                    <span className="text-my-primary">{agent.name}</span>
                    {agentCaptain && <span className="text-my-2xs text-my-tertiary">队长</span>}
                    {(!agent.enabled || agent.archived) && <span className="text-my-2xs text-my-tertiary">不可用</span>}
                  </label>
                  {isSelected && !agentCaptain && (
                    <label
                      title={otherCrew ? '先从其他小队移出后才能设为专属' : '只能在本小队中使用，保留既有任务历史'}
                      className="flex cursor-pointer items-center gap-1.5 text-my-2xs text-my-tertiary"
                    >
                      <Checkbox
                        checked={exclusiveIds.includes(agent.id)}
                        disabled={otherCrew}
                        ariaLabel={`将 ${agent.name} 设为小队专属`}
                        onChange={(checked) => setExclusiveIds((previous) => checked ? [...previous, agent.id] : previous.filter((id) => id !== agent.id))}
                      />
                      <span>小队专属</span>
                    </label>
                  )}
                </div>
              )
            })}
            {people.filter((member) => matching(`${member.name} ${member.title ?? ''}`)).map((member) => (
              <label key={member.id} className="flex cursor-pointer items-center gap-2 rounded-my-base border border-my-line bg-my-canvas p-2 text-my-xs text-my-secondary">
                <Checkbox
                  checked={selected('member', member.id)}
                  disabled={isCaptain('member', member.id)}
                  ariaLabel={`选择成员 ${member.name}`}
                  onChange={() => toggle('member', member.id)}
                />
                <MemberChip member={member} size="sm" />
                <span className="text-my-primary">{member.name}</span>
                <span className="ml-auto text-my-2xs text-my-tertiary">
                  {isCaptain('member', member.id) ? '队长' : member.title || ROLE_LABEL[member.role]}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="协作约定（选填）">
          <textarea className={textareaClass} rows={3} value={instructions} onChange={(event) => setInstructions(event.target.value)} />
        </Field>
        <div className="my-card flex flex-col gap-2 p-3">
          <div className="text-my-xs text-my-secondary">小队快捷指令</div>
          {quickReplies.length > 0 && (
            <ul className="space-y-1">
              {quickReplies.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-2 rounded-my-sm bg-my-layer-1 px-2.5 py-1 text-my-xs">
                  <span className="truncate font-medium text-my-primary">{item.label}</span>
                  <button type="button" aria-label={`删除 ${item.label}`} onClick={() => setQuickReplies((prev) => prev.filter((r) => r.id !== item.id))} className="text-my-tertiary hover:text-my-danger-text">
                    <Trash2 size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            <input className={inputClass} value={replyLabel} onChange={(event) => setReplyLabel(event.target.value)} placeholder="快捷名称，如：输出联调方案" />
            <input className={inputClass} value={replyPrompt} onChange={(event) => setReplyPrompt(event.target.value)} placeholder="对应发送给小队的指令" />
          </div>
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            disabled={!replyLabel.trim() || !replyPrompt.trim()}
            onClick={() => {
              setQuickReplies((prev) => [...prev, { id: `cqr-${Date.now().toString(36)}`, label: replyLabel.trim(), prompt: replyPrompt.trim() }])
              setReplyLabel('')
              setReplyPrompt('')
            }}
          >
            <Plus size={12} />
            <span>添加快捷指令</span>
          </Button>
        </div>
        {error && <p role="alert" className="text-my-xs text-my-danger-text">{error}</p>}
      </div>
      <footer className="flex shrink-0 justify-end gap-2 border-t border-my-line px-6 py-3.5">
        <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>取消</Button>
        <Button variant="primary" size="sm" aria-busy={busy} disabled={busy || !name.trim() || !captainReady} onClick={() => void submit()}>
          {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
          <span>{crew ? '保存' : '组建'}</span>
        </Button>
      </footer>
    </fieldset>
  )
}

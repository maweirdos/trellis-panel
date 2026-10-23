/**
 * 小队：队长 Agent 协调，成员可为 Agent 或同事（PRD 2.10）。
 * 执行由 Runtime 接入后打通；当前小队可作为任务执行槽被指派。
 */
import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { api } from '../../api'
import { useHifox } from '../store'
import { PageHeader, Field, inputClass, MemberChip } from '../ui'
import { Button, EmptyState, Modal } from '../../my/ui'
import type { HifoxCrew } from '@shared/hifox'

export function CrewsPage(): JSX.Element {
  const snapshot = useHifox((s) => s.snapshot)!
  const currentSpaceId = useHifox((s) => s.currentSpaceId)
  const run = useHifox((s) => s.run)
  const [editing, setEditing] = useState<HifoxCrew | 'new' | null>(null)

  const crews = snapshot.crews.filter((c) => c.spaceId === currentSpaceId)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PageHeader
        title="小队"
        description="复杂任务交给小队：队长 Agent 负责拆解与协调，成员可以是其他 Agent 或同事，结果仍汇总回任务"
        actions={<Button variant="primary" size="sm" onClick={() => setEditing('new')}><Plus size={14} />组建小队</Button>}
      />
      {crews.length === 0
        ? <EmptyState title="暂无小队" description="把需要多人多 Agent 协作的任务类型组建为小队" />
        : (
          <div className="my-scrollbar grid min-h-0 flex-1 auto-rows-min grid-cols-1 gap-3 overflow-y-auto pr-1 lg:grid-cols-2">
            {crews.map((crew) => {
              const dispatched = snapshot.tasks.filter((t) => t.executor?.kind === 'crew' && t.executor.id === crew.id)
              return (
                <section key={crew.id} className="flex flex-col gap-2 rounded-my-md border border-my-line bg-my-layer/40 p-3">
                  <header className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate text-sm font-medium text-my-primary">Ⓒ {crew.name}</h2>
                      <p className="truncate text-my-xs text-my-tertiary">{crew.description ?? '暂无描述'}</p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setEditing(crew)}>编辑</Button>
                      <button type="button" aria-label={`解散 ${crew.name}`} className="grid h-7 w-7 place-items-center rounded-my-md text-my-tertiary hover:bg-my-layer hover:text-red-400"
                        onClick={() => void run('解散小队', () => api.hifox.removeCrew({ id: crew.id }))}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </header>
                  <div className="rounded-my-md bg-my-layer px-2.5 py-2">
                    <p className="mb-1 text-[11px] font-medium text-indigo-400">队长 Agent</p>
                    <p className="text-my-xs text-my-secondary">Ⓐ {crew.captain.name}</p>
                    <p className="mb-1 mt-2 text-[11px] font-medium text-my-tertiary">成员（{crew.members.length}）</p>
                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                      {crew.members.map((member) => member.kind === 'agent'
                        ? <span key={`agent:${member.id}`} className="text-my-xs text-my-secondary">Ⓐ {member.name}</span>
                        : <span key={`member:${member.id}`} className="text-my-xs text-my-secondary"><MemberChip member={snapshot.members.find((m) => m.id === member.id)} size="sm" /> {member.name}</span>
                      )}
                      {crew.members.length === 0 && <span className="text-my-xs text-my-tertiary">暂无成员</span>}
                    </div>
                  </div>
                  <p className="mt-auto text-[11px] text-my-tertiary">
                    {dispatched.length > 0 ? `当前执行槽任务 ${dispatched.length} 条` : '可在任务详情的执行槽中选择本小队'}
                  </p>
                </section>
              )
            })}
          </div>
        )}
      <CrewEditor crew={editing} onClose={() => setEditing(null)} />
    </div>
  )
}

function CrewEditor({ crew, onClose }: { crew: HifoxCrew | 'new' | null; onClose: () => void }): JSX.Element | null {
  const snapshot = useHifox((s) => s.snapshot)!
  const currentSpaceId = useHifox((s) => s.currentSpaceId)
  const run = useHifox((s) => s.run)
  const existing = crew && crew !== 'new' ? crew : null
  const [name, setName] = useState(existing?.name ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [captainAgentId, setCaptainAgentId] = useState(existing?.captain.id ?? '')
  const [memberRefs, setMemberRefs] = useState<string[]>((existing?.members ?? []).map((m) => `${m.kind}:${m.id}`))

  if (!crew || !currentSpaceId) return null
  const agents = snapshot.agents.filter((a) => a.spaceId === currentSpaceId && a.enabled)
  const members = snapshot.spaces.find((s) => s.id === currentSpaceId)?.memberIds
    .map((id) => snapshot.members.find((m) => m.id === id)).filter((m): m is NonNullable<typeof m> => Boolean(m)) ?? []

  const submit = async (): Promise<void> => {
    const result = await run(existing ? '更新小队' : '组建小队', () => api.hifox.saveCrew({
      id: existing?.id,
      spaceId: existing?.spaceId ?? currentSpaceId,
      name: name.trim(),
      description: description.trim() || undefined,
      captainAgentId,
      memberRefs: memberRefs.map((ref) => {
        const [kind, id] = ref.split(':') as ['agent' | 'member', string]
        return { kind, id }
      })
    }))
    if (result?.ok) onClose()
  }

  return (
    <Modal open onClose={onClose} width={500} ariaLabel={existing ? '编辑小队' : '组建小队'}>
      <div className="flex flex-col gap-3 p-1">
        <h2 className="text-sm font-semibold text-my-primary">{existing ? `编辑 ${existing.name}` : '组建小队'}</h2>
        <div className="grid grid-cols-2 gap-2">
          <Field label="名称"><input className={inputClass} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="如：交付小队" /></Field>
          <Field label="一句话描述"><input className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        </div>
        <Field label="队长（必须是本空间的 Agent）" hint="队长负责拆解任务、分派成员并汇总结果">
          <select className={inputClass} value={captainAgentId} onChange={(e) => setCaptainAgentId(e.target.value)}>
            <option value="">选择队长 Agent…</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        <div>
          <p className="mb-1.5 text-my-xs font-medium text-my-tertiary">成员（Agent 与同事混编）</p>
          <div className="flex flex-wrap gap-1.5">
            {agents.filter((a) => a.id !== captainAgentId).map((a) => {
              const key = `agent:${a.id}`
              const on = memberRefs.includes(key)
              return (
                <button key={key} type="button"
                  onClick={() => setMemberRefs((prev) => on ? prev.filter((x) => x !== key) : [...prev, key])}
                  className={`rounded-my-md border px-2 py-1 text-my-xs ${on ? 'border-indigo-400/60 bg-indigo-500/10 text-indigo-300' : 'border-my-line text-my-secondary hover:bg-my-layer'}`}>
                  Ⓐ {a.name}
                </button>
              )
            })}
            {members.map((m) => {
              const key = `member:${m.id}`
              const on = memberRefs.includes(key)
              return (
                <button key={key} type="button"
                  onClick={() => setMemberRefs((prev) => on ? prev.filter((x) => x !== key) : [...prev, key])}
                  className={`rounded-my-md border px-2 py-1 text-my-xs ${on ? 'border-indigo-400/60 bg-indigo-500/10 text-indigo-300' : 'border-my-line text-my-secondary hover:bg-my-layer'}`}>
                  {m.name}
                </button>
              )
            })}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
          <Button variant="primary" size="sm" disabled={!name.trim() || !captainAgentId} onClick={() => void submit()}>{existing ? '保存' : '组建'}</Button>
        </div>
      </div>
    </Modal>
  )
}

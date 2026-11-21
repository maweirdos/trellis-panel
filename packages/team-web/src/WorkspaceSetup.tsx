import { useEffect, useState } from 'react'
import { z } from 'zod'
import { Plus, Users, Link as LinkIcon } from 'lucide-react'
import { teamIdSchema, teamTeamSchema, teamProjectSchema, teamTeamMembershipSchema, teamPageSchema, type TeamSession } from './contracts'
import { ApiError, request } from './client'
import { usePage, useQuery, useWrite } from './hooks'
import { ErrorLine, Modal, Pager } from './ui'
import { InvitationLinkForm, type InvitationIntent } from './Invitations'

const projectResult = teamProjectSchema.omit({ roles: true, createdAt: true })
const organizationResult = z.object({ teamId: teamIdSchema, projectId: teamIdSchema, spaceId: z.string().min(1).max(256), name: z.string().min(1).max(200) }).strict()
export type CreatedProject = z.infer<typeof projectResult>
export type CreatedOrganization = z.infer<typeof organizationResult>

export function useTeamManagement(session: TeamSession, teamId: string, epoch: number) {
  return useQuery(`team-management:${session.person.userId}:${teamId}:${epoch}`, async (signal) => {
    try {
      // This roster endpoint is restricted to team owners and administrators.
      await request(`/api/teams/${teamId}/members?limit=1`, teamPageSchema(teamTeamMembershipSchema), { signal, notifyDenied: false })
      return true
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 403) return false
      throw reason
    }
  }, Boolean(teamId) && !session.person.isPlatformAdmin)
}

export function WorkspaceOnboarding({ onCreate, onInvitation }: { onCreate: () => void; onInvitation: (invitation: InvitationIntent) => void }) {
  return <section className="team-onboarding" aria-labelledby="workspace-onboarding-title">
    <header><span className="eyebrow">团队协作</span><h1 id="workspace-onboarding-title">开始团队协作</h1><p>创建你的组织，或通过邀请加入已有组织。</p></header>
    <div className="team-onboarding-options">
      <section className="team-onboarding-option"><Users size={24} aria-hidden="true" /><h2>创建组织</h2><p>将同时创建你的工作区和默认协作空间。</p><button type="button" className="primary" onClick={onCreate}><Plus size={16} />创建组织</button></section>
      <section className="team-onboarding-option"><LinkIcon size={24} aria-hidden="true" /><h2>加入已有组织</h2><p>粘贴管理员发来的完整邀请链接。</p><InvitationLinkForm onOpen={onInvitation} /></section>
    </div>
  </section>
}

export function WorkspaceSetup({ session, epoch, initialTeamId = '', initialMode = 'project', onClose, onCreated }: { session: TeamSession; epoch: number; initialTeamId?: string; initialMode?: 'organization' | 'project'; onClose: () => void; onCreated: (project: CreatedProject, spaceId?: string) => void }) {
  const teams = usePage(`workspace-setup:${session.person.userId}:${epoch}`, '/api/teams', teamTeamSchema)
  const [teamId, setTeamId] = useState(initialTeamId), [creatingTeam, setCreatingTeam] = useState(initialMode === 'organization')
  const [locked, setLocked] = useState(false)
  const selectedTeamId = teamId || teams.items[0]?.teamId || ''
  useEffect(() => {
    if (teamId && !teams.items.some((item) => item.teamId === teamId) && !teams.loading && !teams.error && teams.more) teams.next()
  }, [teamId, teams.items, teams.loading, teams.error, teams.more, teams.next])
  const management = useTeamManagement(session, selectedTeamId, epoch)
  const canManage = session.person.isPlatformAdmin || management.value === true
  const team = teams.items.find((item) => item.teamId === selectedTeamId) ?? null
  const needsTeam = !teams.loading && !teams.error && !teams.items.length
  const showTeamForm = creatingTeam || needsTeam
  return <Modal title={showTeamForm ? '创建组织' : '创建工作区'} onClose={onClose}><div className="team-workspace-setup">
    {showTeamForm ? <><NameForm key="organization" label="组织名称" actionLabel="创建并进入" path="/api/organizations" schema={organizationResult} onLocked={setLocked} onDone={(result) => {
      setLocked(false); setTeamId(result.teamId); setCreatingTeam(false); teams.refresh(); onCreated({ projectId: result.projectId, teamId: result.teamId, name: result.name }, result.spaceId)
    }} />{teams.items.length > 0 && <button type="button" disabled={locked} onClick={() => setCreatingTeam(false)}>使用已有组织</button>}</> : <>
      <label>所属组织<select aria-label="创建工作区的组织" value={selectedTeamId} disabled={locked || teams.loading && !teams.items.length} onChange={(event) => setTeamId(event.target.value)}><option value="" disabled>选择组织</option>{selectedTeamId && !teams.items.some((item) => item.teamId === selectedTeamId) && <option value={selectedTeamId}>{team?.name ?? '当前组织'}</option>}{teams.items.map((item) => <option key={item.teamId} value={item.teamId}>{item.name}</option>)}</select></label>
      <Pager page={teams} />
      {teams.loading && !teams.items.length ? <p role="status">正在读取组织…</p> : selectedTeamId && <>
        {management.loading && !canManage && <p role="status">正在核对组织管理权限…</p>}
        <ErrorLine>{management.error}</ErrorLine>{management.error && <button type="button" onClick={management.refresh}>重新核对权限</button>}
        {canManage && <NameForm key={selectedTeamId} label="工作区名称" path="/api/projects" schema={projectResult} extra={{ teamId: selectedTeamId }} onLocked={setLocked} onDone={onCreated} />}
        {management.value === false && !canManage && <p className="subtle">只有组织所有者或管理员可在「{team?.name ?? '此组织'}」创建工作区。请接受工作区邀请，或创建自己的组织。</p>}
      </>}
      <button type="button" disabled={locked} onClick={() => setCreatingTeam(true)}><Plus size={15} />创建新组织</button>
    </>}
  </div></Modal>
}

function NameForm<T>({ label, actionLabel, path, schema, extra = {}, onLocked, onDone }: { label: string; actionLabel?: string; path: string; schema: z.ZodType<T>; extra?: Record<string, unknown>; onLocked: (locked: boolean) => void; onDone: (result: T) => void }) {
  const [name, setName] = useState(''), write = useWrite(path, schema, null, onDone)
  useEffect(() => { onLocked(write.busy || write.uncertain) }, [write.busy, write.uncertain, onLocked])
  return <form onSubmit={(event) => { event.preventDefault(); void write.submit({ ...extra, name }) }}><label>{label}<input aria-label={label} value={name} required maxLength={200} disabled={write.busy || write.uncertain} onChange={(event) => setName(event.target.value)} /></label><ErrorLine>{write.error}</ErrorLine><button className="primary" type="submit" disabled={write.busy || !name.trim()}>{write.busy ? '正在创建…' : write.uncertain ? '以原操作标识重试' : actionLabel ?? '创建并进入'}</button></form>
}

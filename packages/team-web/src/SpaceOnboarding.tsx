import { ArrowRight, LogIn } from 'lucide-react'
import { useCrux } from '../../../src/renderer/src/crux/store'
import { api } from './crux-browser-api'

export function SpaceOnboarding({ projectId, accountId }: { projectId: string; accountId: string }) {
  const snapshot = useCrux((state) => state.snapshot)
  const context = useCrux((state) => state.workspaceContext)
  const module = useCrux((state) => state.module)
  const busy = useCrux((state) => state.busy)
  const loadError = useCrux((state) => state.loadError)
  if (!snapshot || loadError || module !== 'overview' || context.state !== 'connected' || context.projectId !== projectId || context.actorId !== accountId) return null
  const joined = snapshot.spaces.some((space) => !space.archived && space.memberIds.includes(accountId))
  if (joined && !context.canManage) return null
  const publicSpaces = snapshot.spaces.filter((space) => space.visibility !== 'private' && !space.archived)
  const join = async (spaceId: string): Promise<void> => {
    const origin = context.key
    const reply = await useCrux.getState().run('加入空间', () => api.crux.joinSpace({ spaceId }))
    const state = useCrux.getState()
    if (!reply?.ok || state.workspaceContext.key !== origin || state.workspaceContext.actorId !== accountId || state.workspaceContext.projectId !== projectId || state.workspaceContext.state !== 'connected' || state.workspaceContext.instanceId !== context.instanceId || state.workspaceContext.epoch !== context.epoch || !state.snapshot?.spaces.some((space) => space.id === spaceId && !space.archived && space.memberIds.includes(accountId))) return
    state.setCurrentSpace(spaceId)
    state.setModule('overview')
  }
  return <section className="team-space-onboarding" aria-label="加入协作空间">
    <div><h2>{joined ? '空间与成员' : '已加入工作区，下一步加入空间'}</h2><p>{joined ? '在空间设置中管理你有权管理的空间成员。' : publicSpaces.length ? '选择公开空间加入，开始协作。私有空间请联系已加入该空间的管理员授权。' : '还没有可加入的公开空间，请联系已加入私有空间的管理员分配权限。'}</p></div>
    <div className="team-workspace-actions">{!joined && publicSpaces.slice(0, 3).map((space) => <button type="button" className="primary" disabled={busy} key={space.id} onClick={() => void join(space.id)}><LogIn size={15} />加入 {space.name}</button>)}<button type="button" disabled={busy} onClick={() => useCrux.getState().setModule('spaces')}>{context.canManage ? '打开空间设置' : '浏览空间'}<ArrowRight size={15} /></button></div>
  </section>
}

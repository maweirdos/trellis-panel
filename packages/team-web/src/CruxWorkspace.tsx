import { useCallback, useEffect, useLayoutEffect, useState, type JSX } from 'react'
import { CruxApp } from '../../../src/renderer/src/crux/CruxApp'
import { useCrux } from '../../../src/renderer/src/crux/store'
import { DialogHost } from '../../../src/renderer/src/components/Dialogs'
import { Toasts } from '../../../src/renderer/src/components/Toasts'
import { useApp } from '../../../src/renderer/src/store'
import { useMy } from '../../../src/renderer/src/my/store'
import type { CruxPendingCommand } from '../../../src/shared/crux'
import type { CruxWorkspaceContext } from '../../../src/shared/crux-remote'
import type { TeamProject, TeamSession } from './contracts'
import { isClientSession } from './client'
import { bindBrowserCrux, BrowserCruxWorkspace } from './crux-browser-api'
import { CreateInvitation } from './Invitations'
import { FeishuMemberEntry } from './FeishuMemberEntry'
import { useTeamManagement } from './WorkspaceSetup'
import { WorkspaceTaskLocation } from './WorkspaceTaskLocation'
import './crux-workspace.css'

export type CruxWorkspaceProps = { project: TeamProject; session: TeamSession; theme: 'light' | 'dark'; authEpoch?: number; invitedSpaceId?: string; onInvitedSpaceOpened?: () => void }
const runSharedCommand = useCrux.getState().run

export function CruxWorkspace({ project, session, theme, authEpoch = 0, invitedSpaceId, onInvitedSpaceOpened }: CruxWorkspaceProps): JSX.Element {
  const fontSize = useMy((state) => state.fontSize)
  const snapshot = useCrux((state) => state.snapshot)
  const currentSpaceId = useCrux((state) => state.currentSpaceId)
  const workspaceContext = useCrux((state) => state.workspaceContext)
  const teamManagement = useTeamManagement(session, project.teamId, authEpoch)
  const canManageTeam = session.person.isPlatformAdmin || teamManagement.value === true
  const selectedSpace = snapshot?.spaces.find((space) => space.id === currentSpaceId) ?? null
  const canInviteSelectedSpace = Boolean(selectedSpace && !selectedSpace.archived && workspaceContext.projectId === project.projectId && workspaceContext.actorId === session.person.userId && (selectedSpace.visibility !== 'private' || selectedSpace.memberIds.includes(session.person.userId)) && (workspaceContext.canManage || selectedSpace.ownerId === session.person.userId && selectedSpace.memberIds.includes(session.person.userId)))
  const [invitationOpen, setInvitationOpen] = useState(false)
  const openInvitation = useCallback(() => { setInvitationOpen(true) }, [])
  useEffect(() => { setInvitationOpen(false) }, [project.projectId, project.teamId, session.person.userId, authEpoch])
  useEffect(() => { if (!canManageTeam) setInvitationOpen(false) }, [canManageTeam])
  const [lease, setLease] = useState<{ workspace: BrowserCruxWorkspace; epoch: number; session: TeamSession } | null>(null)
  useLayoutEffect(() => {
    const workspace = new BrowserCruxWorkspace({ project, session })
    const release = bindBrowserCrux(workspace)
    // The shared store queues calls. Pin each queued closure to its browser lease,
    // so a project/account switch cannot send it through the next active bridge.
    const run: typeof runSharedCommand = (label, call) => {
      if (!workspace.isCurrent()) return Promise.resolve(null)
      return runSharedCommand(label, () => {
        if (!workspace.isCurrent()) throw new Error('原工作区已关闭，未发送该操作')
        return call()
      })
    }
    useApp.setState({ toasts: [] })
    useCrux.setState({ snapshot: null, loadError: null, workspaceContext: workspace.context(), currentSpaceId: null, openTaskId: null, createTaskOpen: false, taskFilter: {}, activeViewId: null, busy: false, module: 'overview', run })
    setLease({ workspace, epoch: authEpoch, session })
    return () => {
      release()
      if (useCrux.getState().run === run) useCrux.setState({ run: runSharedCommand })
      useCrux.setState({ snapshot: null, loadError: null, openTaskId: null, createTaskOpen: false })
      useApp.setState({ toasts: [] })
    }
  }, [project.projectId, session.person.userId, session.csrfToken, authEpoch])
  const current = lease && lease.epoch === authEpoch && lease.session.person.userId === session.person.userId && lease.session.csrfToken === session.csrfToken && lease.workspace.context().projectId === project.projectId && isClientSession(session)
  const spaceMember = current && selectedSpace && !selectedSpace.archived &&
    workspaceContext.state === 'connected' && workspaceContext.projectId === project.projectId &&
    workspaceContext.actorId === session.person.userId && selectedSpace.memberIds.includes(session.person.userId)
  const feishuEntry = spaceMember && <FeishuMemberEntry
    key={JSON.stringify([workspaceContext.key, workspaceContext.instanceId, workspaceContext.epoch, workspaceContext.authorizationRevision, authEpoch, selectedSpace.id, selectedSpace.createdAt])}
    projectId={project.projectId} spaceId={selectedSpace.id} spaceName={selectedSpace.name}
    isCurrent={() => {
      const state = useCrux.getState()
      const context = state.workspaceContext
      return lease.workspace.isCurrent() && context.state === 'connected' && context.key === workspaceContext.key &&
        context.projectId === project.projectId && context.actorId === session.person.userId &&
        context.instanceId === workspaceContext.instanceId && context.epoch === workspaceContext.epoch &&
        context.authorizationRevision === workspaceContext.authorizationRevision && state.currentSpaceId === selectedSpace.id &&
        Boolean(state.snapshot?.spaces.some((space) => space.id === selectedSpace.id && space.createdAt === selectedSpace.createdAt &&
          !space.archived && space.memberIds.includes(session.person.userId)))
    }} />
  return <section className="my-root crux-host" data-my-theme={theme} data-my-font-size={fontSize} aria-label="工作区协作">
    {current ? <><WorkspaceTaskLocation workspace={lease.workspace} accountId={session.person.userId} />{invitedSpaceId && <InvitationSpaceLocation projectId={project.projectId} accountId={session.person.userId} spaceId={invitedSpaceId} onOpened={onInvitedSpaceOpened} />}<WorkspaceCommands workspace={lease.workspace} /><div className="crux-host-body"><CruxApp host="web" webInvitation={{ canManage: canManageTeam, open: openInvitation }} webSpaceAction={feishuEntry} /></div>{invitationOpen && canManageTeam && <CreateInvitation key={`${project.teamId}:${project.projectId}:${session.person.userId}:${authEpoch}`} teamId={project.teamId} project={project} space={canInviteSelectedSpace ? selectedSpace : null} session={session} onClose={() => setInvitationOpen(false)} onCreated={() => undefined} />}<DialogHost /><Toasts /></> : <p role="status">正在连接工作区协作…</p>}
  </section>
}

function InvitationSpaceLocation({ projectId, accountId, spaceId, onOpened }: { projectId: string; accountId: string; spaceId: string; onOpened?: () => void }): JSX.Element | null {
  const snapshot = useCrux((state) => state.snapshot)
  const context = useCrux((state) => state.workspaceContext)
  const validScope = context.state === 'connected' && context.projectId === projectId && context.actorId === accountId
  const joined = Boolean(validScope && snapshot?.spaces.some((space) => space.id === spaceId && !space.archived && space.memberIds.includes(accountId)))
  useEffect(() => {
    if (!joined) return
    const state = useCrux.getState()
    if (state.workspaceContext.state !== 'connected' || state.workspaceContext.projectId !== projectId || state.workspaceContext.actorId !== accountId || !state.snapshot?.spaces.some((space) => space.id === spaceId && !space.archived && space.memberIds.includes(accountId))) return
    state.setCurrentSpace(spaceId); state.setModule('overview'); onOpened?.()
  }, [joined, projectId, accountId, spaceId, onOpened])
  return validScope && snapshot && !joined ? <p role="status" className="crux-host-status">已接受邀请，暂时无法核实目标空间权限，请刷新或联系组织管理员。</p> : null
}

function WorkspaceCommands({ workspace }: { workspace: BrowserCruxWorkspace }): JSX.Element | null {
  const [context, setContext] = useState<CruxWorkspaceContext>(() => workspace.context())
  const [pending, setPending] = useState<CruxPendingCommand[]>([])
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  useLayoutEffect(() => {
    let live = true
    const sync = (value: CruxWorkspaceContext): void => {
      if (!live) return
      setContext(value)
      void workspace.crux.workspacePending().then((reply) => { if (live) setPending(reply.ok ? reply.data : []) })
    }
    const off = workspace.crux.onWorkspaceChanged(sync); sync(workspace.context())
    return () => { live = false; off() }
  }, [workspace])
  const act = async (command: CruxPendingCommand, discard: boolean): Promise<void> => {
    setBusy(true)
    const reply = discard ? await workspace.crux.discardWorkspaceCommand({ commandId: command.commandId }) : await workspace.crux.retryWorkspaceCommand({ commandId: command.commandId })
    setMessage(reply.ok ? discard ? command.state === 'retired' ? '原操作引用已归档，旧代次的执行结果没有被改写。请核对当前工作区后明确提交新操作。' : '原操作已放弃，表单内容保留；重新加载后可提交新的操作。' : '原操作已取得回执，正在核对当前工作区。' : reply.error)
    if (reply.ok) await useCrux.getState().bootstrap()
    setBusy(false)
  }
  if (context.state === 'connected' && !pending.length && !message) return null
  return <div className="crux-host-status" aria-label="工作区同步状态" aria-live="polite">
    {context.state !== 'connected' && <p>{context.error ?? '正在连接团队服务…'}</p>}
    {pending.map((command) => <div key={command.commandId}>
      <p>{command.state === 'retired' ? `服务实例或工作区代次已改变，原操作不会重放。${command.outcomeUnknown ? '原代次的执行结果仍未确认。' : ''}归档只移除原操作引用，草稿不会被改写。` : command.errorCode === 'REVISION_CONFLICT' ? '工作区已有更新，原操作未覆盖新内容。编辑草稿仍保留。' : command.outcomeUnknown ? '写入结果尚未确认，请使用原内容核对。' : '操作正在提交…'}</p>
      <details><summary>原操作标识与摘要</summary><code>{command.commandId}</code>{'digest' in command && typeof command.digest === 'string' && <p><code>{command.digest}</code></p>}</details>
      {command.state !== 'retired' && <button type="button" disabled={busy || command.state === 'sending'} onClick={() => void act(command, false)}>{command.state === 'reference-only' ? '核对原操作回执' : '以原内容核对重试'}</button>}
      {(!command.outcomeUnknown || command.state === 'retired') && command.state !== 'sending' && <button type="button" disabled={busy} onClick={() => void act(command, true)}>{command.state === 'retired' ? '归档原操作引用，保留草稿' : '放弃原操作，保留编辑草稿'}</button>}
    </div>)}
    {message && <p>{message}<button type="button" onClick={() => setMessage('')}>收起提示</button></p>}
  </div>
}

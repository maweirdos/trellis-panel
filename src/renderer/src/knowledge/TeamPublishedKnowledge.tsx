import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { RefreshCw } from 'lucide-react'
import type { DesktopTeamConnection, DesktopTeamConnectionContext } from '../../../shared/team-desktop'
import { api, hasIpc } from '../api'
import { useCrux } from '../crux/store'
import { Button } from '../my/ui'
import { useApp } from '../store'
import { errorText, valueOf } from '../team/model'
import { Documents } from '../team/Documents'
import { useTeamOwner } from '../team/use-team-owner'
import '../team/team.css'

function TeamPublishedKnowledgeBase(): JSX.Element {
  const setPage = useApp((state) => state.setPage)
  const workspace = useCrux((state) => state.workspaceContext)
  const [connections, setConnections] = useState<DesktopTeamConnection[]>([])
  const [context, setContext] = useState<DesktopTeamConnectionContext | null>(null)
  const [verified, setVerified] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const ticket = useRef(0)
  const identity = JSON.stringify([workspace.key, workspace.epoch, workspace.instanceId, workspace.authorizationRevision, workspace.projectId, workspace.connectionId, workspace.actorId])
  const owner = useTeamOwner(identity)
  const capture = owner.capture, valid = owner.valid

  const refresh = useCallback(async (): Promise<void> => {
    if (!hasIpc || typeof api.teamDesktop?.connections !== 'function') return
    const captured = capture(), request = ++ticket.current
    setLoading(true)
    try {
      const values = valueOf(await api.teamDesktop.connections())
      const connection = ['connected', 'offline'].includes(workspace.state)
        ? values.find((item) => item.connectionId === workspace.connectionId &&
            item.projectId === workspace.projectId && item.ownerId === workspace.actorId &&
            item.state === 'active' && !item.accessLocked)
        : undefined
      if (!valid(captured) || request !== ticket.current) return
      setConnections(values)
      if (!connection) {
        setVerified('')
        setContext(null)
        setError('')
        return
      }
      if (workspace.state === 'connected') {
        const value = valueOf(await api.teamDesktop.connectionContext(connection.connectionId))
        if (!valid(captured) || request !== ticket.current) return
        if (value.person.userId !== connection.ownerId || value.project.projectId !== connection.projectId) throw Error('团队阅读连接的身份或项目已变化。')
        setContext(value)
        setVerified(identity)
      }
      setError('')
    } catch (cause) {
      if (valid(captured) && request === ticket.current) setError(errorText(cause))
    } finally {
      if (valid(captured) && request === ticket.current) setLoading(false)
    }
  }, [workspace.state, workspace.connectionId, workspace.projectId, workspace.actorId, identity, capture, valid])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (!hasIpc || typeof api.teamDesktop?.onChanged !== 'function') return
    return api.teamDesktop.onChanged((event) => {
      if (event.connectionId === null || event.connectionId === workspace.connectionId) void refresh()
    })
  }, [refresh, workspace.connectionId])
  const offline = workspace.state === 'offline'
  const connection = ['connected', 'offline'].includes(workspace.state)
    ? connections.find((item) => item.connectionId === workspace.connectionId &&
        item.projectId === workspace.projectId && item.ownerId === workspace.actorId &&
        item.state === 'active' && !item.accessLocked)
    : undefined
  const serviceAvailable = hasIpc && typeof api.teamDesktop?.connections === 'function'
  const contextVerified = verified === identity
  const readerReady = connection !== undefined && !error && (offline || contextVerified)

  return <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="团队发布资料">
    <div className="my-page-toolbar-row flex-wrap">
      <div className="min-w-0">
        <h2 className="text-my-md font-semibold text-my-primary">团队发布资料</h2>
        <p className="my-item-description truncate" title={workspace.projectName ?? undefined}>{workspace.projectName ?? '当前团队工作区'} · 固定版本阅读</p>
      </div>
      <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" disabled={!serviceAvailable || loading} onClick={() => { void refresh() }}><RefreshCw size={13} />刷新连接</Button>
      </div>
    </div>
    {!serviceAvailable ? <div className="flex flex-1 items-center justify-center p-8"><p className="text-my-sm text-my-tertiary">桌面团队服务未加载，请完整退出并重新打开应用。</p></div>
      : loading && !connections.length ? <div role="status" className="flex flex-1 items-center justify-center p-8"><p className="text-my-sm text-my-tertiary">正在读取团队连接…</p></div>
      : error ? <div role="alert" className="flex flex-1 items-center justify-center p-8"><p className="text-my-sm text-my-danger-text">{error}</p></div>
      : !connection ? <div className="flex flex-1 items-center justify-center p-8"><div className="max-w-md text-center"><p className="my-item-title">当前团队工作区没有可用的本机阅读连接</p><p className="my-item-description mt-2">核对账号、工作区和设备授权后再读取发布资料。</p><Button className="mt-4" variant="outline" onClick={() => setPage('crux')}>打开团队工作区</Button></div></div>
      : !readerReady ? <div role="status" className="flex flex-1 items-center justify-center p-8"><p className="text-my-sm text-my-tertiary">正在核对当前工作区身份…</p></div>
      : <div className="min-h-0 flex-1"><Documents key={identity} root={null} connection={connection} context={context} active canUseLocalQueue={false} onAccessLost={setError} /></div>}
  </section>
}

export function TeamPublishedKnowledge(): JSX.Element {
  const workspace = useCrux((state) => state.workspaceContext)
  const bootstrap = useCrux((state) => state.bootstrap)
  useEffect(() => { void bootstrap() }, [bootstrap])
  return <TeamPublishedKnowledgeBase key={`${workspace.key}:${workspace.epoch}:${workspace.instanceId}:${workspace.authorizationRevision}:${workspace.state}`} />
}

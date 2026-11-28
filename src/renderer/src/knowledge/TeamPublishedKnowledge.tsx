import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { RefreshCw } from 'lucide-react'
import type { DesktopTeamConnection, DesktopTeamConnectionContext } from '../../../shared/team-desktop'
import { api, hasIpc } from '../api'
import { ConnectionPanel } from '../crux/ConnectionPanel'
import { useCrux } from '../crux/store'
import { Button } from '../my/ui'
import { errorText, valueOf } from '../team/model'
import { Documents } from '../team/Documents'
import { useTeamOwner } from '../team/use-team-owner'
import '../team/team.css'

function TeamPublishedKnowledgeBase({ embedded = false }: { embedded?: boolean }): JSX.Element {
  const workspace = useCrux((state) => state.workspaceContext)
  const [connections, setConnections] = useState<DesktopTeamConnection[]>([])
  const [context, setContext] = useState<DesktopTeamConnectionContext | null>(null)
  const [verified, setVerified] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const ticket = useRef(0)
  const identity = JSON.stringify([
    workspace.key,
    workspace.epoch,
    workspace.instanceId,
    workspace.authorizationRevision,
    workspace.projectId,
    workspace.connectionId,
    workspace.actorId
  ])
  const owner = useTeamOwner(identity)
  const capture = owner.capture,
    valid = owner.valid

  const refresh = useCallback(async (): Promise<void> => {
    if (!hasIpc || typeof api.teamDesktop?.connections !== 'function') return
    const captured = capture(),
      request = ++ticket.current
    setLoading(true)
    try {
      const values = valueOf(await api.teamDesktop.connections())
      const connection = ['connected', 'offline'].includes(workspace.state)
        ? values.find(
            (item) =>
              item.connectionId === workspace.connectionId &&
              item.projectId === workspace.projectId &&
              item.ownerId === workspace.actorId &&
              item.state === 'active' &&
              !item.accessLocked
          )
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
        if (value.person.userId !== connection.ownerId || value.project.projectId !== connection.projectId) {
          throw Error('当前组织的阅读连接身份或归属已变化，请重新同步。')
        }
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

  useEffect(() => {
    void refresh()
  }, [refresh])
  useEffect(() => {
    if (!hasIpc || typeof api.teamDesktop?.onChanged !== 'function') return
    return api.teamDesktop.onChanged((event) => {
      if (event.connectionId === null || event.connectionId === workspace.connectionId) void refresh()
    })
  }, [refresh, workspace.connectionId])
  const offline = workspace.state === 'offline'
  const connection = ['connected', 'offline'].includes(workspace.state)
    ? connections.find(
        (item) =>
          item.connectionId === workspace.connectionId &&
          item.projectId === workspace.projectId &&
          item.ownerId === workspace.actorId &&
          item.state === 'active' &&
          !item.accessLocked
      )
    : undefined
  const serviceAvailable = hasIpc && typeof api.teamDesktop?.connections === 'function'
  const contextVerified = verified === identity
  const readerReady = connection !== undefined && !error && (offline || contextVerified)
  const isLocalMode = workspace.state === 'local'

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="组织固定版发布资料">
      <div className="my-page-toolbar-row flex-wrap">
        <div className="min-w-0">
          {!embedded && <h2 className="text-my-md font-medium text-my-primary">组织固定版发布</h2>}
          <p className="my-item-description truncate" title={workspace.projectName ?? undefined}>
            {isLocalMode
              ? '本机模式下无需连接远端；登录团队组织后自动同步固定版本资料与版本反馈'
              : `${workspace.projectName ?? '当前团队组织'} · 固定版本只读核验`}
          </p>
        </div>
        <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" disabled={!serviceAvailable || loading} onClick={() => void refresh()}>
            <RefreshCw size={13} />
            刷新连接
          </Button>
        </div>
      </div>
      {!serviceAvailable ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <p className="text-my-sm text-my-tertiary">桌面团队服务未加载，请完整退出并重新打开应用。</p>
        </div>
      ) : loading && !connections.length ? (
        <div role="status" className="flex flex-1 items-center justify-center p-8">
          <p className="text-my-sm text-my-tertiary">正在读取团队组织连接…</p>
        </div>
      ) : error ? (
        <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="text-my-sm text-my-danger-text">{error}</p>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => void refresh()}>
              重试
            </Button>
            <ConnectionPanel />
          </div>
        </div>
      ) : !connection ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="flex max-w-md flex-col items-center gap-3 text-center">
            <p className="my-item-title">
              {isLocalMode ? '登录团队组织后可读取固定版发布资料' : '当前组织的本机同步连接尚未就绪'}
            </p>
            <p className="my-item-description">
              {isLocalMode
                ? '本机模式下可直接在「空间文档与产物」新建与评审文档；登录团队组织后，这里会同步展示不可篡改的固定版发布资料。'
                : '登录状态可能已过期或本机设备授权需要重新核对，可在下方重新登录并同步当前组织。'}
            </p>
            <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
              <ConnectionPanel />
              {!isLocalMode && (
                <Button size="sm" variant="ghost" onClick={() => void refresh()}>
                  重新检测连接
                </Button>
              )}
            </div>
          </div>
        </div>
      ) : !readerReady ? (
        <div role="status" className="flex flex-1 items-center justify-center p-8">
          <p className="text-my-sm text-my-tertiary">正在核对当前组织成员身份…</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <Documents
            key={identity}
            root={null}
            connection={connection}
            context={context}
            active
            canUseLocalQueue={false}
            onAccessLost={setError}
          />
        </div>
      )}
    </section>
  )
}

export function TeamPublishedKnowledge({ embedded = false }: { embedded?: boolean }): JSX.Element {
  const workspace = useCrux((state) => state.workspaceContext)
  const bootstrap = useCrux((state) => state.bootstrap)
  useEffect(() => {
    void bootstrap()
  }, [bootstrap])
  return (
    <TeamPublishedKnowledgeBase
      key={`${workspace.key}:${workspace.epoch}:${workspace.instanceId}:${workspace.authorizationRevision}:${workspace.state}`}
      embedded={embedded}
    />
  )
}
